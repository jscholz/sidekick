/**
 * @fileoverview Cursor-aware live dictation — streams STT into the
 * composer textarea while respecting the user's caret and edits.
 *
 * Used when the unified composer mic is in (call=true, autoSend=false):
 * a live WebRTC stream that lands transcripts inline so the user can
 * review, edit, and manually send. Distinct from the auto-send path
 * (dictation.ts — silence/commit-phrase auto-dispatch as chat bubbles).
 *
 * ── State machine ─────────────────────────────────────────────────────
 *
 * The textarea is shared between human (typing/paste/cursor moves) and
 * voice (interim → final transcripts arriving asynchronously). Two
 * principles drive the state machine:
 *
 *   1. Human edits are sacrosanct. The user owns the caret: if they move
 *      it (or type elsewhere) mid-utterance, voice NEVER yanks it back —
 *      but the utterance keeps its anchor, so transcripts for speech that
 *      started at P0 land at P0 even while the user edits at P1 (Jonathan
 *      field bug 2026-07-21: finals used to chase the moved caret).
 *      Manual edits outside the utterance span slide the anchor by the
 *      edit delta; an edit INSIDE the span (the user touched the dictated
 *      text itself) drops the pending utterance — the fallback when
 *      anchor bookkeeping is no longer reliable.
 *   2. Cursor advances with the dictated text, just like typing. Each
 *      interim REPLACES the previous interim's text in place, and after
 *      every splice the caret is moved to the END of what's been written
 *      so far. The user's mental model: "the cursor follows what I'm
 *      saying" — exactly as if they were typing the words themselves.
 *      If they STOP dictating, the cursor is at the end of what they
 *      just said. If they then click elsewhere, the next utterance
 *      starts at that new caret position.
 *
 * ── Deepgram quirks the state machine has to absorb ───────────────────
 *
 * Deepgram emits MULTIPLE `is_final: true` Results per utterance — one
 * per endpoint (sentence/pause boundary inside a single breath). It
 * also emits an empty-text final for `UtteranceEnd` (true end-of-turn).
 * If we treated every is_final as "utterance done, capture cursor
 * fresh next time", we'd:
 *   - re-capture anchor between sentence-final and the next-sentence
 *     interim, leaking previously-committed text into new splice
 *     ranges and producing duplicates / fragments;
 *   - lose the per-utterance invariant that the cursor stays pinned
 *     while the user dictates a multi-sentence block.
 *
 * So this module distinguishes two levels of finality:
 *   - CONTENT FINAL  (text non-empty, is_final=true): a sentence segment
 *     is locked in; we BAKE it into committed[anchor, anchor+committedLen]
 *     and keep the same anchor for the next interim/final.
 *   - UTTERANCE END  (text empty, is_final=true — bridge yields one of
 *     these on Deepgram's UtteranceEnd event): the user stopped
 *     speaking; we close out the utterance, advance the cursor, and
 *     null the anchor so the NEXT speech captures fresh.
 *
 * Defensive measures (should rarely trigger but kill regressions):
 *   - duplicate / stale finals are dropped if their text matches the
 *     most recent committed segment;
 *   - interims that start with text we've already committed in this
 *     utterance have that prefix stripped before splicing.
 *
 * ── Per-utterance state ──────────────────────────────────────────────
 *
 *   anchor: number | null
 *     null = idle (no in-flight utterance). When a number, it's the
 *     textarea index of the start of the current utterance.
 *
 *   committedLen: number
 *     Length of the text already locked-in by content-finals for this
 *     utterance. Lives at [anchor, anchor + committedLen].
 *
 *   interimLen: number
 *     Length of the in-flight interim past committed end. Lives at
 *     [anchor + committedLen, anchor + committedLen + interimLen]. New
 *     interims REPLACE this range.
 *
 *   lastFinalText: string
 *     The text of the most-recent content-final in this utterance —
 *     used to drop duplicate / stale finals.
 *
 *   updating: boolean
 *     Re-entrancy guard. Set while WE'RE writing to the textarea so the
 *     `input` and `selectionchange` listeners don't treat our own
 *     writes as user actions and bail out.
 *
 * Events:
 *   • Interim transcript arrives:
 *     - if anchor is null (new utterance): use the cursor position
 *       captured at start() time (initialCursor) — set BEFORE the user's
 *       gesture moved focus off the textarea. If absent, fall back to
 *       reading composerInput.selectionStart. If there's a selection
 *       range (start ≠ end), delete the selected text first (replaces
 *       user's selection with voice).
 *     - strip any prefix that overlaps with already-committed text in
 *       this utterance (defensive — Deepgram normally doesn't do this).
 *     - splice the new text into [anchor+committedLen,
 *       anchor+committedLen+interimLen]; update interimLen. Cursor
 *       moves to anchor + committedLen + interimLen (the end of the
 *       in-flight text).
 *
 *   • Content final arrives (text non-empty):
 *     - drop if it matches lastFinalText (duplicate / stale).
 *     - same splice as interim, then advance committedLen by the baked
 *       length, reset interimLen=0, remember lastFinalText. anchor
 *       STAYS — we're still in the same utterance. Cursor is moved to
 *       the new end of committed text.
 *
 *   • Utterance end arrives (text empty, is_final=true):
 *     - if there's still an in-flight interim, leave it where it sits
 *       (it'll be overwritten by the next utterance's first splice if
 *       the user keeps talking, or stays as live caption if not).
 *     - add a trailing space if the committed text doesn't already end
 *       in whitespace, so the next utterance / typed char isn't glued
 *       to the previous word.
 *     - advance cursor to anchor + committedLen (post-trailing-space).
 *     - reset: anchor=null, committedLen=0, interimLen=0, lastFinalText=''.
 *
 *   • User input event (typing/paste, NOT our own writes):
 *     - diff the previous vs current value into one contiguous edit
 *       (util/textAnchor.diffEdit) and slide the anchor across it
 *       (shiftSpan). Edit before the span → anchor shifts; after →
 *       no-op; INTERSECTING the span → drop the pending utterance
 *       (resetUtterance + abandon suppression) — the user rewrote the
 *       dictated text, so splicing at stale offsets would corrupt it.
 *       Either way the caret is detached: voice stops moving it.
 *
 *   • User selectionchange (caret move that wasn't ours):
 *     - detach the caret (caretDetached=true). The utterance KEEPS its
 *       anchor — subsequent interims/finals still land there — but
 *       setCursor becomes a no-op so the user's new caret position is
 *       respected. writeRange's setRangeText(…, 'preserve') shifts the
 *       user's caret automatically when a splice lands before it.
 *
 * On call close: stop() clears state and restores the prior data-channel
 * listener (call-mode wiring registers one at boot; we replaced it).
 *
 * ── Diagnostic logging ───────────────────────────────────────────────
 *
 * Heavy per-event logging is gated behind `?dictate-debug=1` (URL) or
 * `localStorage.dictate_debug='1'`. When enabled, every interim, final,
 * splice, and reset prints with timestamps, anchor, committedLen,
 * interimLen, and a short snapshot of the current span. Tail in the
 * console (or the on-page debug panel via ?debug=1) to verify
 * post-fix behavior.
 */

import * as conn from './realtime.ts';
import * as dictationBinding from '../../dictationBinding.ts';
import { log, diag } from '../../util/log.ts';
import { diffEdit, shiftSpan } from '../../util/textAnchor.ts';
import type { STTProvider, TranscriptEvent, Unsubscribe } from '../shared/stt-provider.ts';

// ── Diagnostic flag ────────────────────────────────────────────────────

const dictateDebugOn = (() => {
  // isDevMode() subsumes all three diag flags. Dynamic import to avoid
  // a hot-import cycle through main.ts (boot order).
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('dictate-debug') === '1') return true;
    if (qs.get('debug') === '1') return true;
    if (qs.get('debug-relay') === '1') return true;
    if (localStorage.getItem('dictate_debug') === '1') return true;
    if (localStorage.getItem('parley_debug') === '1') return true;
    if (localStorage.getItem('dev_mode') === '1') return true;
  } catch { /* ignore */ }
  return false;
})();

/** Per-event diagnostic log. Tag every line with [dictate] + a phase
 *  label so it's greppable. No-op unless the dictate-debug flag is on. */
function dlog(phase: string, info: Record<string, unknown> = {}): void {
  if (!dictateDebugOn) return;
  const snapshot = composerInput
    ? composerInput.value.slice(
        Math.max(0, (anchor ?? 0)),
        Math.max(0, (anchor ?? 0)) + committedLen + interimLen,
      )
    : '';
  log(
    `[dictate] ${phase}`,
    JSON.stringify({
      anchor,
      committedLen,
      interimLen,
      lastFinalText: lastFinalText.slice(0, 40),
      span: snapshot.slice(0, 80),
      ...info,
    }),
  );
}

// ── State ──────────────────────────────────────────────────────────────

let active = false;
let composerInput: HTMLTextAreaElement | null = null;

/** Index of the start of the current utterance. null = idle. */
let anchor: number | null = null;
/** Length of finalized text from this utterance baked at [anchor, anchor+committedLen]. */
let committedLen = 0;
/** Length of in-flight interim past anchor+committedLen. */
let interimLen = 0;
/** Most recent content-final text — used to drop duplicates. */
let lastFinalText = '';
/** Re-entrancy guard for our own writes. */
let updating = false;

/** Active STTProvider for the in-flight session. Held so stop() can
 *  unwind even if the caller didn't pass it back. */
let activeProvider: STTProvider | null = null;
/** Unsubscribe handle returned by provider.onTranscript. */
let activeUnsubscribe: Unsubscribe | null = null;
let onStateChangeCb: ((opening: boolean, error?: string) => void) | null = null;

/** Cursor position captured at the GESTURE site (e.g. mic-button
 *  pointerdown, hotkey handler) BEFORE focus shifts off the textarea.
 *  Consumed by the first ensureAnchor() of a session and then nulled.
 *  Without this, by the time the first interim arrives the textarea is
 *  blurred and reading selectionStart can return 0 / value.length /
 *  stale values, dropping voice text at the wrong location. */
let initialCursor: number | null = null;

/** The chat this dictation session is BOUND to (captured at record
 *  start). Every transcript event is routed against it: same chat →
 *  splice into the visible textarea exactly as before; different chat →
 *  the origin's persisted draft, and the visible textarea is not
 *  touched. See dictationBinding.ts. Survives stop() on purpose so a
 *  flushed straggler final is still routed. */
let originChatId: string | null = null;
/** Reason-stamped once per off-origin session so the log says WHY the
 *  box stopped filling, without a line per transcript event. */
let offOriginLogged = false;

/** Timestamp (ms) of the last user-driven reset (typing or cursor moved
 *  outside the in-flight utterance). STT events arriving within
 *  ABANDON_SUPPRESS_MS after this and matching the abandoned interim
 *  text by content-prefix are suppressed: the in-flight interim is
 *  already in the textarea at the abandoned location, so a late final
 *  from the same utterance would land at the user's NEW caret and
 *  produce a duplicate.
 *
 *  Why content-aware: a fixed time window large
 *  enough to catch slow bridge tails (~2s) ALSO swallows the first
 *  interim of a genuinely-new utterance. Comparing first-N-chars
 *  distinguishes "Deepgram refining the abandoned utterance" from "a
 *  brand new utterance with different words." */
let abandonedAt = 0;
let abandonedText = '';
const ABANDON_SUPPRESS_MS = 2500;
const ABANDON_PREFIX_MIN = 8;

/** Most-recent interim text — captured at handleInterim time so that
 *  resetUtterance() can stash it as `abandonedText` for the post-abandon
 *  content-prefix suppression check. Cleared on reset. */
let lastInterimText = '';

/** The EXACT string we last wrote into the in-flight interim range
 *  [anchor+committedLen, anchor+committedLen+interimLen] — i.e. the
 *  leadingSpace-prefixed insert from spliceInterim, NOT the raw transcript.
 *  Used by resyncIfAnchorStale() to detect that the textarea no longer
 *  holds what we think it does (the buffer shifted under us via an edit
 *  we never observed — see that function). '' whenever interimLen is 0. */
let lastInterimWritten = '';

/** Cursor position WE last placed via setCursor(). Used by
 *  onUserSelectionChange to detect user-driven caret moves with a
 *  strict equality check — the previous "is pos inside the utterance
 *  range" heuristic was too lenient when the utterance covered the
 *  whole textarea (ANY click inside existing content was tolerated,
 *  never resetting, and voice kept appending at the end). */
let lastSetCursor = -1;

/** True once the user has taken the caret mid-utterance (moved it,
 *  focused the composer, or typed). While detached, splices keep landing
 *  at the anchor but setCursor is a no-op — voice must not yank the
 *  caret away from where the user is editing. setRangeText's 'preserve'
 *  mode keeps their caret consistent when a splice lands before it.
 *  Reset at each utterance boundary: the NEXT utterance anchors at the
 *  user's chosen caret and cursor-follow resumes. */
let caretDetached = false;

/** Snapshot of the textarea value after our last write / last processed
 *  user edit. onUserInput diffs this against the live value to derive
 *  the single-region edit that shifts (or drops) the anchor. */
let observedValue = '';

// ── Public API ─────────────────────────────────────────────────────────

export function setStateListener(cb: (opening: boolean, error?: string) => void): void {
  onStateChangeCb = cb;
}

export function isActive(): boolean {
  return active;
}

/** The chat this dictation is bound to (record-start capture), or null
 *  when nothing has been started. Read by main.ts's view-commit listener
 *  to decide whether a switch just walked away from the live session. */
export function originId(): string | null {
  return originChatId;
}

function notify(opening: boolean, error?: string): void {
  if (!onStateChangeCb) return;
  try { onStateChangeCb(opening, error); } catch { /* ignore */ }
}

/** Bind the composer textarea once on boot so start() doesn't have to
 *  re-query each time. Also wires the user-action listeners that the
 *  state machine uses to detect cursor moves and edits. */
export function init(input: HTMLTextAreaElement | null): void {
  composerInput = input;
  if (!input) return;
  input.addEventListener('input', onUserInput);
  // selectionchange fires on document, not the element. We filter to the
  // composer's selection by checking activeElement at handler time.
  document.addEventListener('selectionchange', onUserSelectionChange);
  // User-tap-to-focus during active dictation: commit the in-flight
  // utterance and stop fighting iOS for the cursor. Tapping the
  // composer during dictation deferred the iOS keyboard appearance by
  // ~7 seconds because dictate's setCursor()
  // polling kept calling setSelectionRange() right as iOS was trying
  // to present the keyboard — WKWebView treats programmatic selection
  // as a reason to delay keyboard from a user-gesture focus. After
  // resetUtterance, dictate stops calling setCursor on the focused
  // textarea (no in-flight anchor) and iOS can present immediately.
  // The user can keep dictating; the next utterance captures fresh
  // wherever they leave the cursor.
  input.addEventListener('focus', onComposerFocus);
  if (dictateDebugOn) log('[dictate] debug logging enabled');
}

/** Open a stream-mode STT session and start routing user transcripts
 *  to the composer with cursor-aware injection.
 *
 *  `initialCursor` should be the textarea selectionStart captured at the
 *  user's gesture site (mic-button pointerdown, hotkey handler) BEFORE
 *  focus shifted off the textarea. The first interim/final of the
 *  session uses this as the anchor. Pass null if the gesture site
 *  couldn't reasonably know the cursor position; we'll fall back to
 *  reading selectionStart at first-interim time (correct on browsers
 *  that preserve selection across blur, wrong on ones that don't).
 *
 *  `provider` is the STT backend. Defaults to the WebRTC implementation
 *  (`conn.defaultWebRTCSTTProvider`) so existing callers don't change.
 *  Tests inject a `MockSTTProvider` to fire synthetic transcript events
 *  without touching WebRTC. */
export async function start(opts: {
  sessionId?: string | null;
  chatId?: string | null;
  /** The chat this dictation is BOUND to, captured at record start.
   *  Distinct from `chatId`, which addresses the bridge session: this
   *  one decides where the WORDS go if focus moves. Defaults to chatId
   *  so a caller that only knows one id still gets the binding. */
  originChatId?: string | null;
  initialCursor?: number | null;
  provider?: STTProvider;
} = {}): Promise<void> {
  if (active) {
    log('[dictate] start() while already active — no-op');
    return;
  }
  if (!composerInput) {
    diag('[dictate] start() called before init() bound the composer');
    throw new Error('dictate not initialized');
  }
  // Reset per-session state. anchor=null means the next interim/final
  // captures the cursor fresh; that's what we want at the top of every
  // dictation session.
  resetUtterance('start');
  abandonedAt = 0;
  abandonedText = '';
  lastInterimText = '';
  lastSetCursor = -1;
  observedValue = composerInput.value;
  initialCursor = (typeof opts.initialCursor === 'number') ? opts.initialCursor : null;
  originChatId = opts.originChatId ?? opts.chatId ?? null;
  offOriginLogged = false;
  if (dictateDebugOn) log('[dictate] start initialCursor=', initialCursor);

  const provider: STTProvider = opts.provider ?? conn.defaultWebRTCSTTProvider;
  // Subscribe BEFORE start() so we don't miss any opening events.
  activeUnsubscribe = provider.onTranscript(transcriptHandler);
  activeProvider = provider;

  try {
    await provider.start({
      sessionId: opts.sessionId ?? null,
      chatId: opts.chatId ?? null,
    });
  } catch (e: any) {
    if (activeUnsubscribe) {
      try { activeUnsubscribe(); } catch { /* ignore */ }
    }
    activeUnsubscribe = null;
    activeProvider = null;
    notify(false, e?.message || String(e));
    throw e;
  }
  active = true;
  notify(true);
}

/** Stop the STT session and unwind listener state. Idempotent and
 *  safe to call when not active. */
export async function stop(): Promise<void> {
  if (!active) {
    if (activeUnsubscribe) {
      try { activeUnsubscribe(); } catch { /* ignore */ }
      activeUnsubscribe = null;
    }
    activeProvider = null;
    return;
  }
  active = false;
  // Mark the in-flight interim as abandoned BEFORE tearing down.
  // STT providers commonly flush a buffered final between the stop request
  // and its response; without this, that late final would splice into a
  // composer the caller has already cleared (sendTypedMessage clears the
  // textarea after dispatching), leaving a dictation residue. The existing
  // isLateEventFromAbandoned() check already drops events that match the
  // abandoned interim's prefix within ABANDON_SUPPRESS_MS.
  if (lastInterimText) {
    abandonedAt = Date.now();
    abandonedText = lastInterimText;
  }
  const provider = activeProvider;
  activeProvider = null;

  // Release the user-facing state SYNCHRONOUSLY — before awaiting the
  // provider's WebRTC teardown (ICE close is ~1-2s). Awaiting it first
  // kept the "dictating" indicator lit and routed any late finals into
  // the composer for that whole window, which read as a 1-2s talk→type
  // gap. Unsubscribing here also stops transcript routing immediately, so
  // a flush-final from the in-flight teardown can't splice (strictly
  // better than the old order, which kept the subscription live across
  // the await). The provider.stop() is still awaited below so callers
  // that switch modes (startMemo/startListen/startCallStream) serialize
  // the mic/WebRTC handoff and don't race a half-torn-down peer.
  if (activeUnsubscribe) {
    try { activeUnsubscribe(); } catch { /* ignore */ }
    activeUnsubscribe = null;
  }
  // Clear per-session state so a re-start() captures fresh. NOTE: we
  // intentionally leave abandonedAt/abandonedText alone here — they self-
  // expire via ABANDON_SUPPRESS_MS so any straggler events arriving after
  // the unsubscribe race (rare but possible if the runtime queues another
  // tick before tearing down) still get filtered.
  resetUtterance('stop');
  lastInterimText = '';
  lastSetCursor = -1;
  initialCursor = null;
  // Deliberately NOT cleared here: a provider commonly flushes a final
  // between the stop request and its response, and that straggler must
  // still be routed by the binding rather than spliced into whatever
  // composer is on screen. It is overwritten by the next start().
  // originChatId stays.
  notify(false);

  try {
    if (provider) await provider.stop();
  } catch (e: any) {
    diag('[dictate] stop err', e?.message);
  }
}

// ── STT transcript routing ─────────────────────────────────────────────

function transcriptHandler(ev: TranscriptEvent): void {
  if (ev.role !== 'user') return;
  const trimmed = ev.text.trim();
  // OFF-ORIGIN GUARD, before any state-machine work. The splice model
  // below addresses a POSITION in the composer; a position has no
  // meaning once the composer holds a different conversation's text, and
  // splicing anyway is precisely how a dictation ends up in the wrong
  // chat. main.ts normally ends the session at the switch (see the
  // parley:view-committed listener there), so what reaches here is the
  // straggler final a provider flushes during teardown — small, and
  // exactly the text that is easiest to lose.
  if (dictationBinding.routeDictation({
    focusedId: dictationBinding.captureOrigin(),
    originChatId,
  }) === 'draft') {
    if (!offOriginLogged) {
      offOriginLogged = true;
      log(`[dictate] focus left ${originChatId?.slice(-12)} — transcripts now go to its draft`);
    }
    // Interims are a live caption for a textarea we are no longer
    // writing; only finalized words are worth persisting. Utterance-end
    // (empty final) carries no text and needs no handling: everything
    // committed has already been appended below.
    if (ev.is_final && trimmed) {
      // Sentence-fragment separator: successive finals belong to one
      // spoken utterance, so they join with a space rather than becoming
      // a paragraph each. Written through on every final (not buffered
      // to the end) so a tab that dies mid-dictation still leaves the
      // words in IDB.
      dictationBinding.deliver(trimmed, { originChatId, separator: ' ', quiet: true });
    }
    // Whatever the state machine was tracking described the OLD textarea
    // contents; keep it from being re-used if focus comes back.
    if (anchor !== null) resetUtterance('off-origin');
    return;
  }
  offOriginLogged = false;
  if (ev.is_final) {
    if (trimmed) handleContentFinal(trimmed);
    else handleUtteranceEnd();
  } else {
    if (trimmed) handleInterim(trimmed);
  }
}

// ── State machine — voice events ───────────────────────────────────────

/** Defense-in-depth against a user edit / caret move we never observed.
 *  The splice model assumes the textarea still holds the exact text we
 *  last wrote at [anchor+committedLen, anchor+committedLen+interimLen].
 *  onUserInput / onUserSelectionChange normally null the anchor when the
 *  user edits mid-utterance — but on iOS WKWebView those events can be
 *  coalesced or arrive as composition/autocorrect mutations that never
 *  surface as a plain `input`. When that happens the buffer shifts under
 *  a still-live anchor, and the NEXT splice overwrites the wrong span —
 *  leaving the old interim in place AND writing the new one, duplicating
 *  the chunk between the old and new caret (the reported bug).
 *
 *  So before every splice, verify the interim range still holds what we
 *  wrote. If not, the anchor is stale: reset (offsets only — reason
 *  'anchor-stale' is intentionally NOT one of the suppression-arming
 *  reasons, so voice keeps flowing) and let ensureAnchor() re-capture at
 *  the user's live caret. */
function resyncIfAnchorStale(): void {
  if (anchor === null || !composerInput) return;
  const at = anchor + committedLen;
  if (composerInput.value.slice(at, at + interimLen) === lastInterimWritten) return;
  dlog('anchor stale — buffer desynced, re-anchoring', {
    expected: lastInterimWritten.slice(0, 40),
    found: composerInput.value.slice(at, at + interimLen).slice(0, 40),
  });
  resetUtterance('anchor-stale');
}

function handleInterim(text: string): void {
  if (!composerInput) return;
  dlog('interim<-', { text: text.slice(0, 80) });
  if (isLateEventFromAbandoned(text)) {
    dlog('interim drop (post-abandon)', { text });
    return;
  }
  resyncIfAnchorStale();
  ensureAnchor();
  const stripped = stripCommittedPrefix(text);
  if (!stripped) {
    dlog('interim drop (fully overlaps committed)', { text });
    return;
  }
  spliceInterim(stripped);
  lastInterimText = text;
  dlog('interim->', { text: stripped.slice(0, 80) });
}

function handleContentFinal(text: string): void {
  if (!composerInput) return;
  dlog('final<-', { text: text.slice(0, 80) });
  if (isLateEventFromAbandoned(text)) {
    dlog('final drop (post-abandon)', { text });
    return;
  }
  // Stale / duplicate final — same text as the last segment we baked.
  // STT providers occasionally re-emit a finalized segment; don't double-write.
  if (text === lastFinalText) {
    dlog('final drop (duplicate)', { text });
    return;
  }
  resyncIfAnchorStale();
  ensureAnchor();
  const stripped = stripCommittedPrefix(text);
  if (!stripped) {
    dlog('final drop (fully overlaps committed)', { text });
    return;
  }
  spliceFinal(stripped);
  dlog('final->', { text: stripped.slice(0, 80) });
}

function handleUtteranceEnd(): void {
  if (!composerInput) return;
  dlog('utterance-end<-');
  if (anchor === null) {
    dlog('utterance-end drop (no anchor)');
    return;
  }
  // Add a trailing space so the next utterance / typed char isn't
  // glued to the last word — only if we actually committed something
  // and there's no whitespace there yet.
  if (committedLen > 0) {
    const endIdx = anchor + committedLen + interimLen;
    const tail = composerInput.value.charAt(endIdx - 1);
    const nextCh = composerInput.value.charAt(endIdx);
    if (nextCh && /\s/.test(nextCh)) {
      // Already bordered by whitespace on the right (dictated into the
      // middle of existing text) — adding another space doubles it.
    } else if (!/\s/.test(tail)) {
      // Append a single space at the end of the utterance span. We
      // splice it in AFTER the interim (if any), so an in-flight
      // interim isn't disturbed.
      writeRange(endIdx, endIdx, ' ');
      committedLen += 1;
    }
    // Advance cursor to the end of committed text (NOT past interim —
    // the user's next keystroke should land between committed and
    // interim if interim is still showing; in practice handleUtterance
    // End fires after interimLen has been zeroed by the last final).
    // Skipped while the user owns the caret — closing out an anchored
    // utterance must not yank them away from where they're editing.
    if (!caretDetached) setCursor(anchor + committedLen);
  }
  resetUtterance('utterance-end');
}

/** Capture cursor at start of a new utterance. If the user has selected
 *  text, the selection is the insertion target — voice REPLACES the
 *  selection (matching native dictation behavior on macOS / iOS).
 *
 *  Anchor source priority:
 *    1. initialCursor (captured at gesture site BEFORE focus shifted) —
 *       used once, then nulled.
 *    2. composerInput.selectionStart — fallback for mid-session
 *       re-captures (after a user-input or user-cursor-outside reset)
 *       where the textarea is presumably focused at the user's chosen
 *       caret position.
 *    3. composerInput.value.length — last-ditch fallback if both above
 *       are null (selectionStart can return null on never-focused
 *       textareas in some browsers). */
function ensureAnchor(): void {
  if (anchor !== null) return;
  if (!composerInput) return;
  // Diagnostic snapshot — verifies the gesture-site capture is doing
  // its job vs. falling back to selectionStart on a blurred element.
  if (dictateDebugOn) {
    const ss = composerInput.selectionStart;
    const se = composerInput.selectionEnd;
    const len = composerInput.value.length;
    const focused = document.activeElement === composerInput;
    log(
      '[dictate] ensureAnchor enter',
      JSON.stringify({ initialCursor, selectionStart: ss, selectionEnd: se, valueLen: len, focused }),
    );
  }
  let start: number;
  let end: number;
  if (typeof initialCursor === 'number') {
    // Clamp into [0, value.length] in case the textarea contents changed
    // between gesture and first interim (e.g. user typed during connect).
    const clamped = Math.max(0, Math.min(initialCursor, composerInput.value.length));
    start = clamped;
    end = clamped;
    initialCursor = null;
  } else {
    start = composerInput.selectionStart ?? composerInput.value.length;
    end = composerInput.selectionEnd ?? start;
  }
  if (start !== end) {
    // Delete the selection so voice writes into the gap. We use
    // setRangeText so we get the native behavior + the input event
    // (which our own listener will see, but the `updating` flag
    // suppresses the user-input bailout).
    updating = true;
    try {
      composerInput.setRangeText('', start, end, 'start');
    } finally {
      updating = false;
    }
  }
  anchor = start;
  committedLen = 0;
  interimLen = 0;
  lastFinalText = '';
  lastInterimWritten = '';
  caretDetached = false;
  observedValue = composerInput.value;
  // Refocus the textarea so the caret is VISIBLE as text streams in.
  // Without this, the user's gesture (e.g. clicking the mic button)
  // moved focus to the button; setSelectionRange on a non-focused
  // textarea silently updates the selection but the caret doesn't
  // render. Re-focusing here brings the cursor back where we want it.
  //
  // Skip on Cap (iOS native shell): focus on a textarea pops the iOS
  // soft keyboard, which obscures composer controls and isn't needed
  // for voice dictation. Cap users who want to co-edit during
  // dictation tap the composer themselves — that's a real user
  // gesture and pops the keyboard naturally. Tradeoff: caret isn't
  // visible during the streaming on Cap, but the streaming text
  // itself is plenty visible. Detection via the .capacitor-app class
  // on documentElement (set by the Cap WKUserScript at boot); shared
  // code stays Cap-agnostic — it's just reading a CSS class hint.
  // Skip on Cap: keyboard pop on dictate entry hides composer
  // controls and doesn't push the app up.
  const isCap = typeof document !== 'undefined' &&
                document.documentElement.classList.contains('capacitor-app');
  if (!isCap) {
    try {
      if (document.activeElement !== composerInput) {
        // preventScroll keeps the page from jumping when refocusing
        // mid-stream (e.g. inside a long composer).
        (composerInput as any).focus({ preventScroll: true });
      }
    } catch { /* not all browsers support focus options; ignore */ }
  }
  dlog('anchor-capture', { at: start, capSkippedFocus: isCap });
}

/** If `text` starts with a suffix of the already-committed text, strip
 *  that overlap. Defensive against Deepgram occasionally re-sending
 *  finalized words in a subsequent interim — without this, that
 *  re-send would duplicate text in the textarea.
 *
 *  Note: we look at the LAST committed final's text (lastFinalText),
 *  not the entire committed buffer, because Deepgram's interims for a
 *  new sentence segment never re-include text from segments before
 *  the previous one. Only adjacent overlap is plausible. */
function stripCommittedPrefix(text: string): string {
  if (!lastFinalText) return text;
  // Try progressively longer prefixes of lastFinalText that match the
  // start of `text`. If we find one, strip it.
  const lower = text.toLowerCase();
  const lastLower = lastFinalText.toLowerCase();
  // Quick check: does text start with the entire last final? Then strip.
  if (lower.startsWith(lastLower)) {
    return text.slice(lastFinalText.length).replace(/^[\s.,!?]+/, '');
  }
  return text;
}

/** Replace [anchor + committedLen, anchor + committedLen + interimLen]
 *  with `text`, including a leading space if needed for word
 *  separation. Does NOT advance committedLen — the next interim should
 *  overwrite this one. Cursor moves to the END of the in-flight text
 *  so the user sees their words advancing the caret, just like typing. */
function spliceInterim(text: string): void {
  if (!composerInput || anchor === null) return;
  const at = anchor + committedLen;
  const insert = leadingSpace(at) + text;
  writeRange(at, at + interimLen, insert);
  interimLen = insert.length;
  lastInterimWritten = insert;
  // Move cursor to the end of the in-flight text — matches user's
  // mental model of "the cursor follows what I'm saying." If they
  // pause, the cursor is sitting right after the last word; their
  // next keystroke / mouse-click resumes from there. setSelectionRange
  // fires selectionchange; our own listener short-circuits via
  // `updating`. Skipped once the user has taken the caret (they're
  // editing elsewhere — the splice still lands at the anchor, but the
  // caret is theirs).
  if (!caretDetached) setCursor(anchor + committedLen + interimLen);
}

/** Bake a content final into committed text: replace the in-flight
 *  interim, advance committedLen by the baked length. anchor STAYS —
 *  Deepgram will keep emitting more finals (and interims for those
 *  finals) within the same utterance until UtteranceEnd. */
function spliceFinal(text: string): void {
  if (!composerInput || anchor === null) return;
  const at = anchor + committedLen;
  const insert = leadingSpace(at) + text;
  writeRange(at, at + interimLen, insert);
  committedLen += insert.length;
  interimLen = 0;
  lastInterimWritten = '';
  lastFinalText = text;
  // Cursor sits at the end of committed text — same advancing-with-
  // speech invariant as the interim path. Text should land
  // immediately behind the cursor as if the user had typed it.
  // Skipped while the user owns the caret (see spliceInterim).
  if (!caretDetached) setCursor(anchor + committedLen);
}

// ── Reset helper ──────────────────────────────────────────────────────

function resetUtterance(reason: string): void {
  // A user-edit drop means the user rewrote the in-flight utterance's
  // text where it sits and owns the result. Stash the abandoned
  // interim's text + timestamp so handleInterim / handleContentFinal
  // can drop late events refining the same utterance (which would
  // otherwise re-paste at their caret and duplicate). New utterances
  // with different content pass the prefix check and process normally.
  // (Caret moves and out-of-span edits no longer reset at all — the
  // utterance stays anchored; see onUserSelectionChange / onUserInput.)
  if (reason === 'user-input' && lastInterimText) {
    abandonedAt = Date.now();
    abandonedText = lastInterimText;
  }
  anchor = null;
  committedLen = 0;
  interimLen = 0;
  lastFinalText = '';
  lastInterimText = '';
  lastInterimWritten = '';
  caretDetached = false;
  if (dictateDebugOn) dlog('reset', { reason });
}

/** True if `text` is a late event from the just-abandoned utterance:
 *  the timestamp is inside the suppression window AND the first N
 *  characters match the abandoned interim's prefix (case-insensitive).
 *  Auto-clears the marker once the time window expires. */
function isLateEventFromAbandoned(text: string): boolean {
  if (!abandonedAt) return false;
  if (Date.now() - abandonedAt > ABANDON_SUPPRESS_MS) {
    abandonedAt = 0;
    abandonedText = '';
    return false;
  }
  if (!abandonedText) return false;
  const t = (text || '').trim();
  if (!t) return false;
  const min = Math.min(ABANDON_PREFIX_MIN, abandonedText.length, t.length);
  if (min < 3) return false;
  return abandonedText.slice(0, min).toLowerCase() === t.slice(0, min).toLowerCase();
}

// ── Textarea writes (with re-entrancy guard) ──────────────────────────

function leadingSpace(at: number): string {
  if (!composerInput) return '';
  if (at <= 0) return '';
  const ch = composerInput.value.charAt(at - 1);
  return /\s/.test(ch) ? '' : ' ';
}

function writeRange(start: number, end: number, text: string): void {
  if (!composerInput) return;
  updating = true;
  try {
    // setRangeText splices in place but DOES NOT dispatch an input
    // event (per HTML spec — was wrong in the prior comment). We
    // dispatch one explicitly so the OTHER listeners on the textarea
    // (autoResize + updateSendButtonState in main.ts) react. Without
    // this dispatch, streaming dictation grew the value but the box
    // didn't auto-grow.
    // Our own onUserInput sees this event but `updating=true` makes
    // it a no-op for the state machine.
    composerInput.setRangeText(text, start, end, 'preserve');
    composerInput.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    updating = false;
  }
  // Keep the user-edit diff baseline in sync with our own writes so the
  // next onUserInput diff only sees the USER's edit.
  observedValue = composerInput.value;
}

function setCursor(pos: number): void {
  if (!composerInput) return;
  if (dictateDebugOn) log('[dictate] setCursor', pos);
  updating = true;
  try {
    composerInput.setSelectionRange(pos, pos);
  } finally {
    updating = false;
  }
  lastSetCursor = pos;
}

// ── User events — typing, paste, cursor moves ─────────────────────────

/** Close out the current utterance IN PLACE because the user took the
 *  caret (moved it, typed, or focused the composer) while nothing was
 *  in flight (interimLen===0 — all speech baked). Distinct from the
 *  mid-utterance detach (field bug 2026-07-21: while words are still
 *  streaming, a caret move must NOT re-anchor them): at rest, a
 *  deliberate caret move means "the next thing I say goes HERE", so
 *  the old anchor must die now — not whenever Deepgram's UtteranceEnd
 *  straggles in (utterance_end_ms is 1.5s and the marker was dropped
 *  by the bridge entirely until 2026-08-09; field bug: second
 *  utterance kept landing at the first utterance's position).
 *  Bakes the trailing space (same bookkeeping as handleUtteranceEnd),
 *  never touches the cursor — the user owns it — and arms the
 *  late-event suppressor against re-emits of the closed utterance. */
function closeUtteranceAtRest(reason: string): void {
  if (anchor === null || !composerInput) return;
  if (committedLen > 0) {
    const endIdx = anchor + committedLen;
    const tail = composerInput.value.charAt(endIdx - 1);
    const next = composerInput.value.charAt(endIdx);
    // Skip when either side is already whitespace — the span may sit
    // mid-text (dictated into "alpha | omega"), where adding a space
    // against the existing one doubles it.
    if (!/\s/.test(tail) && !(next && /\s/.test(next))) {
      writeRange(endIdx, endIdx, ' ');
      committedLen += 1;
    }
  }
  if (lastFinalText) {
    abandonedAt = Date.now();
    abandonedText = lastFinalText;
  }
  diag(`[dictate] utterance closed at rest (${reason}) — next speech re-anchors at the user's caret`);
  resetUtterance(reason);
}

function onUserInput(_ev: Event): void {
  if (updating) return;          // our own write — ignore
  if (!active) return;           // not dictating — irrelevant
  if (!composerInput) return;
  if (anchor === null) return;   // no in-flight utterance — nothing to track
  // The user typed (or pasted, or undo'd) DURING an in-flight utterance.
  // Diff our last-observed value against the live one and slide the
  // anchor across the edit so the utterance keeps landing where the
  // speech started (field bug 2026-07-21). The user owns the caret from
  // here on — voice stops moving it.
  const edit = diffEdit(observedValue, composerInput.value);
  observedValue = composerInput.value;
  if (!edit) return;
  const spanLen = committedLen + interimLen;
  const shifted = shiftSpan(anchor, spanLen, edit);
  if (shifted === null) {
    // The edit touched the dictated span itself — anchor bookkeeping
    // through that isn't reliable. Fallback semantics: drop the pending
    // utterance in place (their edit is the truth) and suppress its
    // late refinements.
    diag('[dictate] user edited inside the utterance span — dropping pending utterance');
    resetUtterance('user-input');
    return;
  }
  if (shifted !== anchor) {
    dlog('anchor shift (user edit)', { from: anchor, to: shifted, edit: JSON.stringify(edit) });
    anchor = shifted;
  }
  // Typing with nothing in flight = the user has moved on. Close the
  // utterance here (post-slide, so the trailing space lands right)
  // instead of leaving a live anchor that a straggling UtteranceEnd may
  // never kill.
  if (interimLen === 0) {
    closeUtteranceAtRest('user-input-at-rest');
    return;
  }
  caretDetached = true;
}

function onComposerFocus(_ev: Event): void {
  if (updating) return;          // our own write — ignore (defensive; setSelectionRange shouldn't fire focus)
  if (!active) return;           // not dictating — let iOS handle focus normally
  if (anchor === null) return;   // no in-flight utterance — programmatic focus at dictation start fires before the first interim
  if (interimLen === 0) {
    // Tap with nothing in flight — user repositioning between
    // utterances. Close out so the next speech anchors at their tap.
    closeUtteranceAtRest('focus-at-rest');
    return;
  }
  // User tapped the composer while we had a voice utterance in flight.
  // Detach the caret: the utterance keeps its anchor (transcripts still
  // land there), but we stop calling setCursor on the now-focused
  // textarea so iOS WKWebView can present the keyboard without
  // programmatic-selection interference.
  diag('[dictate] composer focused mid-utterance — caret detached, utterance stays anchored');
  caretDetached = true;
}

function onUserSelectionChange(_ev: Event): void {
  if (updating) return;
  if (!active) return;
  if (anchor === null) return;
  if (!composerInput) return;
  // Only react to selection changes IN the composer. Cursor moves in
  // chat bubbles, settings, etc. shouldn't affect the dictation state.
  if (document.activeElement !== composerInput) return;
  const pos = composerInput.selectionStart ?? 0;
  // Strict equality with the cursor we last placed — anything else is a
  // user-driven move (or the 'preserve'-mode shift of a caret the user
  // already owns, in which case caretDetached is already true).
  if (pos === lastSetCursor) return;
  if (interimLen === 0) {
    // Caret move with nothing in flight — deliberate repositioning
    // between utterances. Close out so the next speech anchors here.
    closeUtteranceAtRest('caret-moved-at-rest');
    return;
  }
  // The user took the caret. Keep the utterance anchored where speech
  // started — pending finals land there — but stop moving the caret.
  if (!caretDetached) {
    diag('[dictate] user moved cursor — caret detached, utterance stays anchored');
    caretDetached = true;
  }
}
