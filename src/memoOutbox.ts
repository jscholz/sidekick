/**
 * Memo transcription outbox — the offline-tolerant pipeline that turns a
 * recorded audio blob into a chat message.
 *
 * One processing path: every memo blob is rendered as a placeholder card +
 * persisted to IndexedDB + enqueued (renderMemoCard), then drained by a
 * single serialized flush (flushOutbox) that POSTs to /transcribe and routes
 * the transcript to the composer. handleMemoResult is the entry point used
 * by the recorder modes; the two background pollers cover the cases where a
 * blob gets stuck queued without a user action or reconnect to trigger a
 * flush.
 *
 * Leaf module: depends only on other modules (no boot-local DOM refs), which
 * is why it extracts cleanly out of main.ts's boot(). uploadInFlightBytes is
 * private state owned here; the status narrative for it lives in the network
 * poller below.
 */

import { log, diag } from './util/log.ts';
import { TimeoutError } from './util/fetchWithTimeout.ts';
import * as status from './status.ts';
import * as backend from './backend.ts';
import * as chat from './chat.ts';
import * as composer from './composer.ts';
import * as queue from './queue.ts';
import * as voiceMemos from './voiceMemos.ts';
import * as memoCard from './memoCard.ts';
import * as webrtcControls from './audio/realtime/controls.ts';
import * as switchCtl from './switchController.ts';
import * as dictationBinding from './dictationBinding.ts';
import * as transcriptStore from './transcript/store.ts';
import * as turnbased from './audio/turn-based/turnbased.ts';
import * as handsfree from './audio/shared/handsfree.ts';
import * as listenReply from './listenReplyState.ts';
import { playFeedback } from './audio/shared/feedback.ts';
import {
  needsChunking, decodeToMono16k, slicePcm, encodeWav, stitchTranscripts,
} from './audio/shared/chunkedTranscribe.ts';
import { postTranscribe, PermanentTranscribeError } from './audio/shared/postTranscribe.ts';
import { transcribeBudget } from './audio/shared/transcribeBudget.ts';
import { StallTimeoutError } from './util/stallTimeoutPost.ts';
import { apiUrl } from './apiBase.ts';

// Tracks the in-flight /transcribe upload size (bytes) so the periodic
// status refresher can surface "Uploading audio (NKB)…" while the
// request is on the wire. Field bug 2026-05-02: 14-22s queue→flush
// window was completely silent, leaving the user wondering if anything
// was happening between "queued" and the eventual transcript landing
// in the composer. null = no upload in flight; the refresher falls
// back to its normal connected/stalled narrative.
let uploadInFlightBytes: number | null = null;

// Per-chunk progress line for the chunked path ("Transcribing audio
// (2/4)…"). The 2s status refresher prefers this over the generic
// "Uploading audio (NKB)…" while an upload is in flight, so the chunk
// counter survives the refresher's ticks. Cleared alongside
// uploadInFlightBytes.
let uploadStatusLabel: string | null = null;

// Bytes actually on the wire so far for the in-flight upload, fed by the
// transport's upload-progress events. Field bug 2026-09-01: the pill read
// "Uploading audio (400 KB)…" and then "Stalled — 1 queued (2:28)" with
// no way to tell a slow link from a dead one. A MOVING byte counter is
// the cheapest possible answer to "is this actually doing anything."
let uploadSentBytes = 0;

// Why the last /transcribe attempt failed, in words, or null if the last
// one succeeded. Surfaced on the queued/stalled header pill so a retry
// loop announces itself instead of looking like a frozen spinner —
// the same lesson as the "transient failures were previously SILENT"
// note further down this file, applied to the user-visible surface.
let lastFailureReason: string | null = null;

/** Read the current upload-failure narration (null when the last attempt
 *  succeeded). Exported for the failure-path smokes, which assert the
 *  reason is legible rather than scraping the header string. */
export function getLastFailureReason(): string | null {
  return lastFailureReason;
}

// Per-chunk /transcribe RESPONSE budget. 60s in production; the
// failure-path smoke shrinks it so the chunk-timeout path runs in
// milliseconds instead of requiring a 60s stall. Note this bounds only
// the post-upload wait — the upload itself is bounded by stall (see
// transcribeBudget), so a slow link no longer blows the chunk budget.
let chunkTimeoutMs = 60_000;
export function setChunkTimeoutMsForTest(ms: number): void {
  if (typeof ms === 'number' && ms > 0) chunkTimeoutMs = ms;
}

/** "Uploading audio (312/400 KB)…" once bytes start moving, falling back
 *  to the indeterminate total-only form before the first progress tick. */
function uploadLabel(): string {
  const total = Math.round((uploadInFlightBytes ?? 0) / 1024);
  if (uploadSentBytes > 0 && uploadSentBytes < (uploadInFlightBytes ?? 0)) {
    return `Uploading audio (${Math.round(uploadSentBytes / 1024)}/${total} KB)…`;
  }
  return `Uploading audio (${total} KB)…`;
}

// Queue items whose transcript already reached its destination once.
// queue.flush deletes the IDB row only AFTER the handler returns — a
// failed delete (mobile IDB flakiness, tab suspension) leaves the row
// 'pending' and the 30s poller re-delivers it. Without this guard the
// retry re-ran /transcribe and RE-INSERTED text the user may have
// already deleted by hand ("I'll delete it, and then it'll come back" —
// Jonathan field bug 2026-07-21). A re-delivered id skips the insert
// but still returns cleanly so the stale row drains. In-memory is the
// right scope: the resurrection loop is within-session (poller-driven);
// a reload clears both the set and the half-flushed handler state.
const deliveredIds = new Set<string>();
const DELIVERED_IDS_MAX = 500;
function markDelivered(id: string): void {
  deliveredIds.add(id);
  if (deliveredIds.size > DELIVERED_IDS_MAX) {
    const oldest = deliveredIds.values().next().value;
    if (oldest !== undefined) deliveredIds.delete(oldest);
  }
}

/** Chunked path for long clips: decode the stored blob to 16k mono PCM,
 *  slice with overlap, transcribe each slice as a WAV, stitch with seam
 *  dedup. Returns null when the blob can't be decoded (caller falls back
 *  to single-shot). Chunk-level transient failures throw — the whole
 *  item stays queued and is redone from chunk 0 next flush (chunks are
 *  fast, partial-progress persistence isn't worth the state). */
async function chunkedTranscribe(blob: Blob, url: string, toComposer: boolean, attempts: number): Promise<string | null> {
  let pcm: Float32Array;
  try {
    pcm = await decodeToMono16k(blob);
  } catch (e) {
    log('chunked transcribe: decode failed, falling back to single-shot:', (e as Error)?.message);
    return null;
  }
  const slices = slicePcm(pcm);
  const parts: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    const label = `Transcribing audio (${i + 1}/${slices.length})…`;
    uploadStatusLabel = label;
    status.setStatus(label, 'live');
    if (toComposer) composer.setInterim(`Transcribing… (${i + 1}/${slices.length})`);
    const wav = encodeWav(slices[i]);
    const t0 = Date.now();
    // Each ~80s slice is ~2.5MB of WAV — the BIGGEST uploads in the whole
    // pipeline. A flat per-chunk wall clock had the same defect as the
    // single-shot ceiling (at 25 KB/s a 2.5MB chunk needs ~100s, well past
    // the 60s budget), so chunks get the stall instrument too.
    const budget = transcribeBudget({
      sizeBytes: wav.size, attempts, baseResponseMsOverride: chunkTimeoutMs,
    });
    uploadInFlightBytes = wav.size;
    uploadSentBytes = 0;
    log(`chunked transcribe: chunk ${i + 1}/${slices.length} (${Math.round(wav.size / 1024)}KB) `
      + `timeout=${budget.responseMs}ms stall=${budget.stallMs}ms attempt=${attempts + 1}`);
    parts.push(await postTranscribe(url, wav, 'audio/wav', budget, (sent) => { uploadSentBytes = sent; }));
    log(`chunked transcribe: chunk ${i + 1}/${slices.length} ok in ${Date.now() - t0}ms`);
  }
  return stitchTranscripts(parts);
}

/** Final routing for a Listen-turn's text, shared by the audio lane
 *  (transcript arrives at flush time) and the text lane (local engine
 *  committed text directly). Auto-sends only while the user is still in
 *  the chat the turn was committed to; a late recovery after switching
 *  chats lands in the composer for review instead. Reply TTS only fires
 *  while the call is still live. */
function routeListenTurnText(body: string, item: any): void {
  if (!body) {
    status.setStatus('No speech detected', null);
    return;
  }
  // "Still in the chat the turn was committed to" is a question about
  // the VIEW, so ask switchController first — same precedence as every
  // other addressed path. The adapter memo is the pre-view fallback and
  // now lags a switch by a couple of awaits (it is written next to the
  // IDB row, not ahead of the fetch), which would have made this compare
  // against the chat the user just left.
  const current = switchCtl.focusedId() ?? backend.getCurrentSessionId?.() ?? null;
  if (item.chatId && current && current !== item.chatId) {
    composer.appendText(body);
    status.setStatus('Recovered voice turn — review & send', null);
    return;
  }
  if (turnbased.getState() !== 'idle') {
    listenReply.markAwaitingReply(item.chatId ?? current);
  }
  composer.appendText(body);
  composer.submit();
  status.setStatus('', null);
}

/** Flush queued audio items — update the corresponding memo cards with transcripts. */
export async function flushOutbox() {
  const result = await queue.flush(
    async (text, _source, item) => {
      if (item && item.listenTurn) {
        // The send IS the risky step for text-lane turns (no upload
        // first to prove the link is alive, and composer.submit
        // silently no-ops when the gateway is down) — throw so the
        // queue retains the item and the retry poller re-delivers.
        if (!backend.isConnected()) throw new Error('offline');
        routeListenTurnText(text, item);
        return;
      }
      // Address the send to the chat the memo was RECORDED in (queued
      // items carry it) — a drain after the user moved chats must not
      // deliver into wherever they are now. Legacy IDB rows predate
      // rec.chatId; resolve one HERE rather than leaving opts.chatId
      // absent, which proxyClient now treats as a programming error
      // (dev-mode throw). Same precedence as every other send: the chat
      // on screen first, the adapter's pre-view memo only if nothing has
      // committed. A legacy memo has no better answer available.
      const memoChatId = item?.chatId
        ?? switchCtl.focusedId()
        ?? backend.getCurrentSessionId?.()
        ?? null;
      if (!item?.chatId) diag(`outbox: legacy memo without chatId — delivering to ${memoChatId ?? 'no chat'}`);
      backend.sendMessage(text, memoChatId ? { chatId: memoChatId } : undefined);
    },
    async (blob, mimeType, id, autoSend, toComposer, durationMs, item) => {
      const listenTurn = !!(item && item.listenTurn);
      // Re-delivered item (a prior flush inserted its transcript but the
      // IDB row survived — see deliveredIds). The user's buffer already
      // received this text once; if they deleted it, that's their edit
      // and it stays deleted. Return cleanly so queue.flush drains the
      // stale row instead of retrying it forever. Guard covers the
      // composer-bound routes (dictation + memo) — listen turns mark
      // delivered only at their non-throwing terminal (see below).
      if (id && deliveredIds.has(id)) {
        log('outbox: skipping already-delivered item', id);
        if (toComposer) {
          composer.clearInterim();
          status.setStatus('', null);
        }
        return;
      }
      // Per-user keyterm biasing for batch transcribe. Same IDB list the
      // WebRTC offer ships; bridge accepts repeated `?keyterms=…&keyterms=…`
      // and merges into the Deepgram spec like the streaming path does.
      // Without this, memo-mode transcription runs un-biased even if the
      // user has chips configured (was the case for "clawdian" miss).
      // readListFast: mirror-first — a flaky link must not stall each
      // flush attempt 5s on a keyterms GET before the audio POST.
      let kt: string[] = [];
      try {
        const { readListFast } = await import('./keyterms.ts');
        kt = (await readListFast()) || [];
      } catch {}
      // apiUrl: in the CAP local-asset shell the page origin is
      // capacitor://localhost, where a relative fetch never reaches the
      // server — WebKit rejects it pre-network with "SyntaxError: The
      // string did not match the expected pattern" (the 2026-06-09
      // "stalled forever" device wedge; browser PWAs were unaffected
      // because location.origin == server there).
      const url = apiUrl(kt.length
        ? `/transcribe?${kt.map(t => 'keyterms=' + encodeURIComponent(t)).join('&')}`
        : '/transcribe');
      let text = '';
      // Prior FAILED attempts for THIS blob, read off the durable queue
      // row (queue.bumpAttempts writes it). Persisted, not in-memory:
      // an escalation that resets on reload is the same permanent-retry
      // loop, and reloading is exactly what a wedged user does.
      const attempts = Number(item?.attempts) || 0;
      // Surface "Uploading audio (312/400 KB)…" immediately + via the
      // periodic refresher (which prefers uploadInFlightBytes when set).
      // Cleared in finally so success/timeout/error all reset the
      // indicator. The transport feeds real upload-progress events, so
      // this counter MOVES — that is what distinguishes "slow link" from
      // "dead link" for the user.
      uploadInFlightBytes = blob.size;
      uploadSentBytes = 0;
      status.setStatus(uploadLabel(), 'live');
      try {
        try {
          // Long clips (> ~2.5 min) go through the chunked path: each
          // ~80s slice is its own bounded round-trip, so a 5-minute
          // dictation can't blow a single timeout budget and wedge in
          // permanent-retry (the 2026-06-09 "Transcribing… forever"
          // incident). Chunking happens HERE at flush time, so blobs
          // already sitting in the outbox get the new path on their
          // next flush. Decode failure → single-shot fallback below.
          let chunked: string | null = null;
          if (needsChunking(durationMs, blob.size)) {
            chunked = await chunkedTranscribe(blob, url, toComposer, attempts);
          }
          if (chunked != null) {
            text = chunked;
          } else {
            // Two instruments, because there are two ways to hang.
            //
            // The UPLOAD is bounded by STALL ("no bytes moved for
            // stallMs"), not by a wall clock. The old ceiling picked a
            // wall clock from blob SIZE — a proxy for upload time that
            // holds only while bandwidth is good. Field 2026-09-01: a
            // ~400KB dictation from SF to a London host at ~20-25 KB/s
            // needs 17-20s and got a flat 15s, so EVERY attempt was
            // killed mid-upload and the queue never drained (three
            // consecutive server logs: "request stream error after
            // 17137ms at 400KB: aborted"). Size ÷ bandwidth is the real
            // quantity and bandwidth is not knowable up front — but an
            // upload that is moving bytes is healthy at any speed, so
            // stall is bandwidth-independent by construction.
            //
            // The RESPONSE keeps a wall clock, and keeps the exact
            // pre-fix ladder (15s / 60s / 120s by size) — nothing is
            // observable as progress while Deepgram is thinking, and
            // that ladder is what un-wedged 3-minute memos.
            //
            // Both escalate with the persisted attempt count, so even a
            // failure mode neither instrument can see still gets a
            // materially larger budget each round and the queue drains.
            const budget = transcribeBudget({
              sizeBytes: blob.size,
              chunkedCandidate: needsChunking(durationMs, blob.size),
              attempts,
            });
            log(`transcribe: single-shot ${Math.round(blob.size / 1024)}KB ${mimeType} `
              + `timeout=${budget.responseMs}ms stall=${budget.stallMs}ms `
              + `attempt=${attempts + 1} escalation=${budget.factor}x`);
            text = await postTranscribe(url, blob, mimeType, budget, (sent) => {
              uploadSentBytes = sent;
              if (!uploadStatusLabel) status.setStatus(uploadLabel(), 'live');
            });
          }
        } catch (e) {
          // Non-timeout transient failures were previously SILENT here
          // (re-thrown into queue.flush's bare catch), which made a
          // fast-failing device upload look like a frozen "Stalled" pill
          // with an empty log — undebuggable from the field.
          if (!(e instanceof TimeoutError) && !(e instanceof PermanentTranscribeError)) {
            log(`transcribe failed (transient, will retry): ${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? e}`);
          }
          if (!(e instanceof PermanentTranscribeError)) {
            // Record the failed attempt on the DURABLE row before
            // rethrowing, so the next flush (this session or after a
            // reload) reads a bigger budget. This is the guarantee that
            // the queue drains instead of looping: the retry that
            // follows is materially more generous than the one that
            // just failed. Capped inside bumpAttempts.
            const n = id ? await queue.bumpAttempts(id) : 0;
            // Name the failure for the header pill. "Stalled — 1 queued"
            // alone can't distinguish a slow upload from being offline,
            // which is precisely the ambiguity the field report hit.
            lastFailureReason = e instanceof StallTimeoutError
              ? `slow link — retry ${n + 1} with a longer budget`
              : e instanceof TimeoutError
                ? `no response — retry ${n + 1} with a longer budget`
                : `upload failed — retry ${n + 1}`;
          }
          if (e instanceof TimeoutError) {
            // Surface + chime; blob stays in queue for retry on next
            // reconnect. The card moves to queued(⏳) so the user sees
            // something is pending. Dictation (toComposer) has no card —
            // the durable queue is what saves the bad-connection upload
            // from evaporating, so we just narrate "will retry" and keep
            // the blob; a poller drains it when signal returns.
            log(`transcribe timeout — blob stays queued for retry: ${(e as Error).message}`);
            // A stall is a DIFFERENT story from "you're offline": the
            // connection is up, the upload was just too slow for the
            // budget we gave it. Saying "will retry when connected" to a
            // connected user is the misleading half of the field bug.
            const slow = e instanceof StallTimeoutError;
            if (listenTurn) {
              // No card, no composer ghost line — the durable queue holds
              // the turn and the header pill narrates the queued count.
              status.setStatus(slow
                ? 'Voice turn queued — link is slow, retrying'
                : 'Voice turn queued — will send when connected');
            } else if (toComposer) {
              composer.setInterim(slow
                ? 'Dictation queued — link is slow, retrying with more time'
                : 'Dictation queued — will retry when connected');
            } else {
              const transcriptEl = document.getElementById('transcript');
              const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
              if (card) memoCard.update(card, { status: 'queued' });
            }
            playFeedback('error');
          }
          throw e;  // re-throw so queue.flush keeps the item
        }
      } catch (e) {
        if (e instanceof PermanentTranscribeError) {
          const err = e.message;
          log('transcribe: permanent failure, dropping blob:', err);
          if (listenTurn) {
            status.setStatus('Voice turn unprocessable — dropped', 'err');
            playFeedback('error');
            return;  // don't throw — queue.flush will drop the item
          }
          if (toComposer) {
            // Dictation has no card — just clear the progress line and
            // narrate softly. The blob drops from the queue (return, no
            // throw) since retrying a corrupt clip is futile.
            composer.clearInterim();
            composer.releaseAnchor(item?.anchorId);
            status.setStatus('Dictation unprocessable — tap mic to retry', 'err');
          } else {
            const transcriptEl = document.getElementById('transcript');
            const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
            const note = '(audio unprocessable)';
            if (card) memoCard.update(card, { transcript: note, status: 'failed' });
            try { await voiceMemos.update(id, { transcript: note, status: 'failed' }); } catch {}
          }
          playFeedback('error');
          return;  // don't throw — queue.flush will drop the item
        }
        throw e;  // transient → keep in queue
      } finally {
        uploadInFlightBytes = null;
        uploadStatusLabel = null;
        uploadSentBytes = 0;
      }
      // Reached only when /transcribe returned — the retry narrative is
      // over, so stop advertising it on the header pill.
      lastFailureReason = null;
      const transcriptEl = document.getElementById('transcript');
      const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;

      // Empty transcript — /transcribe succeeded but heard nothing
      // (silent clip / inaudible). Surface that on the card so the user
      // isn't left staring at an orphan row. Persist the status so a
      // reload doesn't restore it as pending again.
      if (!text) {
        if (listenTurn) {
          // Mirrors the old inline listen path's "empty transcript,
          // skipping send" — nothing to send, drop quietly.
          status.setStatus('No speech detected', null);
          return;
        }
        if (toComposer) {
          // Dictation: no card to annotate — clear the ghost line and
          // tell the user softly. Item drops from queue (return, no throw).
          composer.clearInterim();
          composer.releaseAnchor(item?.anchorId);
          status.setStatus('No speech detected', null);
          return;
        }
        const note = '(no speech detected)';
        if (card) memoCard.update(card, { transcript: note, status: 'failed' });
        await voiceMemos.update(id, { transcript: note, status: 'failed' });
        return;
      }

      if (listenTurn) {
        // Committed Listen turn riding the durable queue (was a bare
        // fetch that evaporated on a dead connection, 2026-06-10).
        // Strip the trailing sendword only when sendword triggered the
        // commit — pulls the LIVE config so a renamed sendword still
        // strips correctly on a late retry.
        let body = text;
        if (item.commitReason === 'sendword') {
          const { sendwordPhrase } = handsfree.getHandsfreeConfig();
          const m = handsfree.matchSendword(body, sendwordPhrase);
          if (m.matched) body = m.cleaned;
        }
        if (id) markDelivered(id);
        routeListenTurnText(body, item);
        return;
      }

      // Routing depends on the per-memo autoSend flag captured at
      // record time (settings.micAutoSend at the moment startMemo()
      // was called). autoSend=true → append to composer (so any
      // already-typed text is preserved) and immediately submit;
      // autoSend=false → just append, leaving the user to review +
      // send manually. Both paths converge through composer.appendText
      // → composer.submit, which is the same codepath as clicking Send.
      if (toComposer) {
        // Batch dictation: transcript is INPUT, not a message. appendText
        // lands it at the item's recording-start anchor (falling back to
        // the cursor when the anchor didn't survive) and clears the ghost
        // interim line. No card, no voice-memo record, no submit, no chat
        // bubble — exactly the ephemeral-input UX, but the blob rode the
        // durable queue so a bad-connection upload retried here instead
        // of evaporating.
        if (id) markDelivered(id);
        // ADDRESSED, not pointed: the transcript goes to the chat the
        // dictation was spoken into (item.chatId, captured at recording
        // start), not to whatever composer is on screen when the upload
        // finally lands. Same chat → the anchored at-caret insert,
        // byte-for-byte as before; a different chat → the origin's
        // persisted draft. This branch is the one the durable retry
        // drains through, so it covers the late deliveries too.
        dictationBinding.deliver(text, {
          originChatId: item?.chatId ?? null,
          anchorId: typeof item?.anchorId === 'number' ? item.anchorId : null,
        });
        status.setStatus('', null);
        return;
      }
      // Model removal (writer migration): drop the decoration — the
      // reconciler removes the card. Registry + IDB follow. The direct
      // card.remove() covers the no-decoration edge (legacy record
      // rendered before this deploy).
      const registered = memoCard.getRegistered(id);
      if (registered?.chatId) {
        transcriptStore.removeDecoration(registered.chatId, `memo:${id}`);
      } else if (card) {
        card.remove();
      }
      memoCard.dropRec(id);
      await voiceMemos.remove(id);
      if (id) markDelivered(id);
      if (autoSend) {
        // Auto-send memos are a SEND, and send addressing is not this
        // change's business (it reads the chat on screen, deliberately).
        // Left exactly as it was.
        composer.appendText(text);
        composer.submit();
      } else {
        // Review-first memo: the transcript is composer INPUT, so it
        // obeys the dictation rule. registered.chatId is the chat the
        // memo card was rendered into; note it is captured at record
        // STOP (renderMemoCard), not record start — good enough to stop
        // a delayed/retried transcript landing in a chat the user walked
        // to since, which is the failure this closes.
        dictationBinding.deliver(text, { originChatId: registered?.chatId ?? null });
      }
    }
  );
  if (result.skipped) diag('outbox: flush skipped (already flushing)');
  else if (result.sent > 0) log('outbox: flushed', result.sent, 'queued messages');
  return result;
}

/** Start the two background pollers (periodic retry + network-status
 *  refresh). Called once from boot. */
export function startBackgroundPollers(): void {
  // View-commit reseed (writer migration 2026-07-13): decorations live
  // in ChatState, and a new-chat rotation clearAll()s the leaving
  // chat's state — unlike durable rows, memo decorations can't be
  // refetched from the server, so revisiting that chat would lose its
  // pending cards until reload. The memo registry is the in-memory
  // truth; re-upsert its decorations for whichever chat just committed
  // (addDecoration is upsert-by-key, so this is idempotent and free
  // when nothing was lost).
  window.addEventListener('parley:view-committed', (ev) => {
    const chatId = (ev as CustomEvent).detail?.chatId;
    if (!chatId) return;
    for (const rec of memoCard.registeredForChat(chatId)) {
      transcriptStore.addDecoration(chatId, {
        key: `memo:${rec.id}`, kind: 'memo', memoId: rec.id, timestamp: rec.timestamp || Date.now(),
      });
    }
  });

  // Periodic background retry. Covers the scenario where /transcribe
  // fails mid-memo (blob queued) but the gateway WS stays connected —
  // no reconnect event fires, no user send happens. Without this, a
  // queued blob sits until the next reload or user action. Poll is
  // cheap (IDB read + early-out if empty); only flushes when there's
  // pending work AND the gateway is reachable.
  setInterval(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    try {
      const pending = await queue.pending();
      if (pending > 0 && backend.isConnected()) {
        diag(`outbox: periodic retry (${pending} pending)`);
        flushOutbox().catch(() => {});
      }
    } catch {}
  }, 30_000);

  // Periodic network-status refresh. Surfaces queued count + weak-signal
  // detection in the header. Only writes when there's no active WebRTC
  // call (controls.ts owns the call-status narrative).
  const WEAK_SIGNAL_MS = 8_000;
  setInterval(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (webrtcControls.isOpen()) return;
    try {
      const gwConnected = backend.isConnected();
      const summary = await queue.summary();
      // Idle cursor — wall-clock ms since /api/parley/stream last
      // delivered ANY envelope. EventSource can stay "connected" while
      // the underlying TCP connection is dead (cellular handoff,
      // suspended radio). Combined with queued outbound, a long idle
      // window is the signal that we're stalled. msSinceLastEnvelope()
      // returns 0 on fresh connect → treated as "no signal yet."
      //
      // The pre-refactor openclaw path also surfaced a `weakSignal`
      // state (idle stream, no queue, ambiguously-iffy network). We
      // intentionally don't recreate that here: the SSE channel is
      // sparse by design — an idle drawer browse can go minutes
      // without an envelope and that's normal — so a `weakSignal`
      // fire on idle would be a constant false positive. Stalled
      // (idle + queued outbound) IS unambiguous and stays.
      const msIdle = backend.msSinceLastEnvelope();
      // Upload-in-flight wins over the connectivity narrative — the
      // user wants to see "uploading" until the request lands, even
      // if the gateway briefly looks idle. Without this the 2s
      // refresher would clobber the "Uploading…" pill back to
      // "Connected" within a tick.
      if (uploadInFlightBytes != null) {
        if (uploadStatusLabel) {
          // Chunked path — keep the "Transcribing audio (2/4)…" counter
          // instead of clobbering it back to the generic upload line.
          status.setStatus(uploadStatusLabel, 'live');
        } else {
          status.setStatus(uploadLabel(), 'live');
        }
      } else if (!gwConnected) {
        status.setState('reconnecting', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else if (msIdle > WEAK_SIGNAL_MS && summary.count > 0) {
        // reason: without it this pill reads "Stalled — 1 queued (2:28)"
        // for BOTH "you are offline" and "the upload keeps timing out",
        // which is the ambiguity the 2026-09-01 field report ran into.
        status.setState('stalled', {
          queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs,
          reason: lastFailureReason ?? undefined,
        });
      } else {
        status.setState('connected', {
          queuedCount: summary.count,
          queuedAudioMs: summary.totalAudioMs,
          reason: lastFailureReason ?? undefined,
        });
      }
    } catch {}
  }, 2_000);
}

/** Save blob to IDB + enqueue for retry + render a placeholder memo card
 *  in chat. Always runs on record stop, regardless of online/offline —
 *  gives the user immediate visual feedback during the quiet
 *  transcription window. Returns {id, card, rec}. autoSend is stored
 *  on the queue item so flushOutbox can route correctly even when the
 *  flush happens minutes later (periodic retry / reconnect). */
async function renderMemoCard(audioBlob, durationMs, autoSend = false) {
  // Hard ceiling: the bridge accepts up to 25MB at /v1/transcribe and
  // the proxy mirrors that. webm voice is ~30KB/s so 25MB ≈ 14 min.
  // Anything larger gets DROPPED here with a status warning rather
  // than queued — a too-big blob in the outbox just retries forever
  // and blocks the channel for smaller subsequent memos. User can
  // re-record in shorter chunks. Threshold is intentionally a few
  // hundred KB below the 25MB limit so an upload-time encoding bump
  // doesn't push a borderline blob over.
  const MEMO_MAX_BYTES = 24 * 1024 * 1024;
  if (audioBlob.size > MEMO_MAX_BYTES) {
    const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
    const mins = Math.round((durationMs ?? 0) / 60000);
    log(`memo: too big (${mb}MB ≈ ${mins}min) — dropped, would block the queue`);
    status.setStatus(
      `Memo too long (${mins}m) — dropped. Try shorter chunks.`,
      'err',
    );
    try { playFeedback('error'); } catch {}
    return { id: null, card: null, rec: null };
  }

  const id = crypto.randomUUID();
  const transcriptEl = document.getElementById('transcript');

  // Addressed, not pointed (invariant #3 applied to memos): the card
  // belongs to the chat the memo was RECORDED in — view state first,
  // adapter pointer as the no-view fallback (same precedence as sends).
  const memoChatId = switchCtl.focusedId() ?? backend.getCurrentSessionId?.() ?? null;
  const rec = {
    id, blob: audioBlob, mimeType: audioBlob.type, durationMs,
    waveform: new Float32Array(40),
    transcript: null, status: 'pending', timestamp: Date.now(),
    chatId: memoChatId,
  };

  // Writer migration 2026-07-13: the card renders through the
  // transcript MODEL (memo decoration → reconciler), not a direct DOM
  // append. addDecoration notifies synchronously, so the card exists
  // in the DOM by the next line and the waveform hook can find it.
  memoCard.registerRec(rec, memoChatId);
  if (memoChatId) {
    transcriptStore.addDecoration(memoChatId, {
      key: `memo:${id}`, kind: 'memo', memoId: id, timestamp: rec.timestamp,
    });
  }
  let card = transcriptEl ? memoCard.find(transcriptEl, id) : null;
  if (card) chat.autoScroll();

  await voiceMemos.save(rec);
  await queue.enqueue({ id, type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs, autoSend });
  log('memo: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB) autoSend=' + autoSend);

  // Background waveform extraction
  voiceMemos.extractWaveform(audioBlob).then(bars => {
    if (card) {
      const anyCard = card as any;
      if (anyCard._setWaveform) anyCard._setWaveform(bars);
    }
    voiceMemos.update(id, { waveform: Array.from(bars) }).catch(() => {});
  }).catch(e => log('memo: waveform extract failed:', e.message));

  return { id, card };
}

/** Batch dictation (dictateRealtime=OFF, #112): persist the recorded
 *  utterance to the durable outbox, then transcribe ONCE and drop the clean
 *  transcript into the composer.
 *
 *  Distinct from handleMemoResult: dictation is ephemeral INPUT, not a
 *  message. So there is NO voice-memo card and NO send — a silent / failed
 *  transcribe leaves nothing in the chat (the bug that prompted this path:
 *  the memo pipeline rendered a "(no speech detected)" bubble). But it DOES
 *  ride the same IndexedDB queue as memos (toComposer:true), because the
 *  fire-and-forget version evaporated long dictations on a bad connection:
 *  a 4-minute clip timed out on upload and the whole transcript was lost.
 *  Now the blob is persisted BEFORE any network attempt, so a timeout /
 *  offline just leaves it queued; the background pollers (or the next
 *  flushOutbox) retry it and the transcript lands in the composer whenever
 *  signal returns. The toComposer flag keeps every flush branch
 *  composer-bound (no card, no bubble, no submit). Progress shows as a ghost
 *  line under the composer plus the header pill. */
export async function transcribeToComposer(
  audioBlob: Blob | null,
  durationMs?: number,
  anchorId?: number | null,
  originChatId?: string | null,
): Promise<void> {
  if (!audioBlob) return;
  // Same hard ceiling as memos: a too-big blob just retries forever and
  // blocks the queue for everything behind it. Drop it up front rather
  // than persisting it.
  const MEMO_MAX_BYTES = 24 * 1024 * 1024;
  if (audioBlob.size > MEMO_MAX_BYTES) {
    const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
    status.setStatus(`Recording too long (${mb}MB) — try shorter chunks.`, 'err');
    try { playFeedback('error'); } catch {}
    composer.releaseAnchor(anchorId);
    return;
  }

  // Durable-first: persist the blob to the outbox BEFORE touching the
  // network. This is the whole point of the fix — if the upload times out
  // or we're offline, the blob survives in IndexedDB and a poller retries
  // it. toComposer:true routes every flush branch back to the composer.
  // anchorId: the composer anchor captured at RECORDING START (see
  // composer.createAnchor). Rides the queue item so a delayed/retried
  // flush still lands the transcript where the utterance was aimed.
  // In-memory only — after a reload the registry is gone and appendText
  // falls back to the at-caret insert.
  await queue.enqueue({
    type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs, toComposer: true,
    anchorId: typeof anchorId === 'number' ? anchorId : undefined,
    // The chat this dictation was SPOKEN INTO, captured at recording
    // start by the mic gesture site. Rides the DURABLE row, so the
    // binding outlives a reload — the anchor above cannot (in-memory),
    // and the deliveries most likely to arrive off-origin are exactly
    // the slow ones. See dictationBinding.ts.
    chatId: originChatId ?? null,
  });
  log('dictate: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB) toComposer');

  composer.setInterim('Transcribing…');

  const offline = navigator.onLine === false || !backend.isConnected();
  if (offline) {
    // Leave it queued; the periodic poller drains it on reconnect. Keep
    // the ghost line so the user knows the dictation wasn't lost.
    composer.setInterim('Dictation queued — will transcribe when connected');
    status.setStatus('Dictation queued — will transcribe when connected');
    return;
  }

  // Online: drain now. flushOutbox handles success (appendText), timeout
  // (keeps queued + "will retry" ghost line), permanent failure (drops +
  // narrates), and empty transcript — all via the toComposer branches.
  flushOutbox().catch(() => {});
}

/** Committed Listen (turn-based call) utterance: persist to the durable
 *  outbox BEFORE any network, then transcribe + auto-send via flushOutbox.
 *
 *  Replaces the bare fetch('/transcribe') that lived in main.ts's
 *  onCommit — that fetch had no timeout and no persistence, so a dead
 *  connection mid-call hung the turn and ending the call evaporated it
 *  (2026-06-10 field report). Riding the queue also picks up keyterm
 *  biasing, chunking, and the retry pollers that memos already have.
 *
 *  chatId is captured at COMMIT time; the flush branch auto-sends only
 *  while the user is still in that chat (composer review otherwise). */
export async function transcribeListenTurn(
  audioBlob: Blob | null,
  reason: 'silence' | 'sendword' | 'barge' | undefined,
  chatId: string | null,
): Promise<void> {
  if (!audioBlob || audioBlob.size === 0) return;
  const MEMO_MAX_BYTES = 24 * 1024 * 1024;
  if (audioBlob.size > MEMO_MAX_BYTES) {
    const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
    status.setStatus(`Recording too long (${mb}MB) — dropped.`, 'err');
    try { playFeedback('error'); } catch {}
    return;
  }

  await queue.enqueue({
    type: 'audio', blob: audioBlob, mimeType: audioBlob.type,
    listenTurn: true, commitReason: reason || 'silence', chatId,
  });
  log('listen: queued turn blob (' + Math.round(audioBlob.size / 1024) + 'KB) reason=' + (reason || 'silence'));

  const offline = navigator.onLine === false || !backend.isConnected();
  if (offline) {
    status.setStatus('Voice turn queued — will send when connected');
    return;
  }
  flushOutbox().catch(() => {});
}

/** Text-lane twin of transcribeListenTurn for the LOCAL streaming engine
 *  (Web Speech): the transcript is already final at commit time, so there
 *  is no /transcribe upload to protect — but the SEND itself can still be
 *  lost on a dead connection. Riding the durable queue gives the text the
 *  same retained-and-retried guarantee. Sendword stripping happens in
 *  main.ts onCommitText before this is called (text is final there), so
 *  the flush path routes it without re-stripping. */
export async function sendListenText(text: string, chatId: string | null): Promise<void> {
  const body = (text || '').trim();
  if (!body) return;
  await queue.enqueue({
    type: 'text', text: body, source: 'listen', listenTurn: true, chatId,
  });
  const offline = navigator.onLine === false || !backend.isConnected();
  if (offline) {
    status.setStatus('Voice turn queued — will send when connected');
    return;
  }
  flushOutbox().catch(() => {});
}

export async function handleMemoResult(audioBlob: Blob, durationMs?: number, autoSend = false, path = 'unknown') {
  // Diagnostic for the iOS PTT auto-send bug — echoes the captured
  // autoSend flag + which release path triggered this finish, so
  // future regressions are debuggable from the JS console without
  // having to instrument startMemo from scratch.
  log(`memo finish: path=${path} autoSend=${autoSend} blob=${audioBlob ? Math.round(audioBlob.size/1024)+'KB' : 'null'}`);
  if (!audioBlob) return;
  // Always render the placeholder card + enqueue the blob, regardless
  // of connectivity. Matches the "user gets immediate visual feedback"
  // UX spec and keeps ONE processing path (flushOutbox) whether we're
  // online or offline.
  const { card } = await renderMemoCard(audioBlob, durationMs, autoSend);

  const offline = navigator.onLine === false || !backend.isConnected();
  if (offline) {
    if (card) memoCard.update(card, { status: 'queued' });
    status.setStatus('Audio queued — will transcribe when connected');
    return;
  }

  // Single transcribe path: flushOutbox iterates the queue serially
  // (for/await loop + isFlushing mutex), calls /transcribe per item,
  // routes to composer / chat based on autoSend setting, updates the
  // card. Rapid-fire memos all land here — mutex serializes them so
  // composer-append order matches record order, no duplicates.
  //
  // Earlier architecture had a second "live" transcribeChain that
  // raced with this: both paths fetched /transcribe for the same
  // blob, both appended, producing duplicates ("1 1 2 3 2 3" pattern
  // the user reported). Now there's only one path.
  flushOutbox().catch(() => {});
}
