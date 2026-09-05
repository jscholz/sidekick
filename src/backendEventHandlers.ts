/**
 * Backend event handlers — normalized per-event shell logic.
 *
 * These are the callbacks the backend adapter invokes for the streaming
 * reply lifecycle (delta → final), tool events, and activity signals. The
 * adapter handles wire-format parsing; these handlers own only the
 * shell-side side effects: transcript store writes, audio routing, badge +
 * activity-tray bookkeeping, and the post-final durable refresh.
 *
 * Extracted from main.ts as pure code-motion — main.ts registers them on
 * the backend (onDelta/onFinal/onToolEvent/onActivity) and otherwise just
 * wires modules together.
 */

import { log, diag } from './util/log.ts';
import { isProgressHeartbeatText } from './util/progressHeartbeat.ts';
import { replaySessionMessages, persistGrownTranscript, NO_REPLY_RE } from './sessionResume.ts';
import * as backend from './backend.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as switchCtl from './switchController.ts';
import * as settings from './settings.ts';
import * as sessionIdentity from './sessionIdentity.ts';
import * as activityStore from './notifications/activityStore.ts';
import * as badge from './notifications/badge.ts';
import * as turnbased from './audio/turn-based/turnbased.ts';
import * as webrtcControls from './audio/realtime/controls.ts';
import * as webrtcSuppress from './audio/realtime/suppress.ts';
import * as ttsModule from './audio/turn-based/tts.ts';
import { playReplyTts, cancelReplyTts } from './audio/turn-based/tts.ts';
import { playFeedback } from './audio/shared/feedback.ts';
import { attachCard } from './cards/attach.ts';
import { setDoc } from './rightDrawer/docStore.ts';
import { parseCardsFromText, extractImageBlocks } from './cards/fallback.ts';
import * as transcriptStore from './transcript/store.ts';
import * as listenReply from './listenReplyState.ts';
import * as chat from './chat.ts';

// ─── Activity handler ───────────────────────────────────────────────────────

/** Activity signal — only kept around for the diag log + the future
 *  drawer-side "agent typing" indicator. Rendering itself is now
 *  driven by the projection's BubbleSpec.streaming flag, so this
 *  handler no longer touches the DOM. */
export function handleActivity({ working, detail, conversation }: any) {
  void working; void detail; void conversation;
}

/** Find the most-recent non-streaming agent bubble and attach a card.
 *  Falls back to the active streaming bubble if there's no finalized
 *  agent reply yet. */
function attachCardToLatestAgentBubble(card) {
  const el = document.getElementById('transcript');
  if (!el) return;
  const bubbles = Array.from(
    el.querySelectorAll('.line.agent[data-reply-id]:not(.streaming)')
  ) as HTMLElement[];
  const streaming = el.querySelector('.line.agent.streaming') as HTMLElement | null;
  const target = bubbles[bubbles.length - 1] || streaming;
  if (!target) {
    log('attachCard: no agent bubble to attach to — dropping card', card.kind);
    return;
  }
  attachCard(target, card);
}

// ─── Backend event handlers ─────────────────────────────────────────────────
// Normalized per-event handlers. Shell logic only — the backend adapter
// handles wire-format parsing. Events not surfaced by the adapter (agent
// lifecycle, heartbeat, etc.) don't reach us by design.

/** Streaming partial reply. `cumulativeText` is the full text so far.
 *  Adapter already drops user-echo prefix variants so we don't need to
 *  defensively filter them here. With per-turn replay machinery gutted,
 *  the bubble is purely a text surface: TTS is owned by the WebRTC
 *  talk-mode track on the server side and arrives as audio independently. */
export function handleReplyDelta({ replyId, cumulativeText, conversation, messageId, isReplay = false, interim = false }: any) {
  if (!cumulativeText) return;
  // Always store the envelope — even for background chats, so a
  // future switch-back finds the streamed text already there.
  if (conversation && messageId) {
    transcriptStore.appendInflight(conversation, {
      type: 'reply_delta',
      chat_id: conversation,
      message_id: messageId,
      text: cumulativeText,
      edit: true,
      ...(interim ? { interim: true } : {}),
    });
    // Unread badge: one live reply = one unread, deduped by message_id
    // inside noteLiveMessage (also gated there on viewed chat + pinned).
    if (!isReplay) chat.noteLiveMessage(conversation, String(messageId));
  }
  // Audio + feedback side effects are scoped to the on-screen chat.
  const viewed = switchCtl.viewedId();
  if (viewed && conversation && conversation !== viewed) return;
  // First-delta-of-turn signal: chime + suppress envelope. With the
  // store the "first delta" predicate is "no prior reply_delta with
  // this message_id" — checked via the store before appendInflight
  // would have added it. Since we already appended above, query the
  // pre-append state by looking for a duplicate message_id in the
  // already-stored envelopes; cheap enough.
  if (!isReplay && messageId && conversation) {
    const envs = transcriptStore.getState(conversation).inflight;
    const isFirstDelta = envs.filter(e =>
      e.type === 'reply_delta' && (e as any).message_id === messageId,
    ).length === 1;  // exactly 1 = the one we just pushed
    if (isFirstDelta) {
      try { playFeedback('send'); } catch { /* best-effort */ }
    }
  }
  // SSE-sourced arming — a NO-OP while a talk-mode call is connected
  // (suppress.setDataChannelOwnsArming): during a call the data channel
  // drives suppression, because SSE deltas can arrive AFTER the bridge's
  // `listening` envelope (stall-flush/ring-replay) and would re-arm
  // ttsPlaying with no TTS behind it, wedging the user-transcript path
  // for the rest of the call (field bug 2026-08-26).
  //
  // `!isReplay` because a replayed envelope is, by definition, text the
  // agent already spoke — there is no TTS round behind it, so arming
  // shuts the mic gate with nothing that can reopen it. The `_replay`
  // flag exists precisely to keep side effects off the replay path
  // (cbd8c9f speak-replies, 92e0273 drawer bumps, 9484aff approval
  // banners); suppression arming was simply never added to the list.
  // cc57300's dcOwnsArming covers this DURING a talk call by ignoring
  // SSE arming outright — this covers the contexts it deliberately
  // leaves on SSE arming (stream mode, Listen, no call).
  if (!isReplay) webrtcSuppress.onAssistantDelta();
  if (ttsModule.isPaused()) {
    cancelReplyTts('new-turn');
  }
  void replyId;  // retained in signature for adapter contract; unused now
}

const postFinalRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const postFinalRefreshSeq = new Map<string, number>();

function durableIdentity(row: any): string {
  return `${row?.parley_id || ''}:${String(row?.id ?? '')}`;
}

function durableHasReply(
  rows: any[],
  beforeIds: Set<string>,
  messageId?: string | null,
  finalText?: string | null,
): boolean {
  for (const row of rows) {
    if (row?.role !== 'assistant') continue;
    if (messageId && row.parley_id === messageId) return true;
    if (
      finalText &&
      row.content === finalText &&
      !beforeIds.has(durableIdentity(row))
    ) {
      return true;
    }
  }
  return false;
}

function schedulePostFinalDurableRefresh(
  chatId: string,
  messageId?: string | null,
  finalText?: string | null,
): void {
  if (!chatId || !backend.capabilities().sessionBrowsing) return;
  if (switchCtl.viewedId() !== chatId) return;
  const prev = postFinalRefreshTimers.get(chatId);
  if (prev) clearTimeout(prev);
  const seq = (postFinalRefreshSeq.get(chatId) ?? 0) + 1;
  postFinalRefreshSeq.set(chatId, seq);
  const beforeDurableIds = new Set(
    transcriptStore.getState(chatId).durable.map((row) => durableIdentity(row)),
  );
  const timer = setTimeout(() => {
    postFinalRefreshTimers.delete(chatId);
    void (async () => {
      if (postFinalRefreshSeq.get(chatId) !== seq) return;
      if (switchCtl.viewedId() !== chatId) return;
      try {
        const result: any = await backend.fetchSessionMessages(chatId);
        if (postFinalRefreshSeq.get(chatId) !== seq) return;
        // No post-fetch focus re-check (phase-5 guard cleanup): the
        // view token below IS the gate — replaySessionMessages refuses
        // when focus has moved, and unlike the old viewedId() check it
        // also refuses during an in-flight switch AWAY (viewed lags
        // until the incoming chat commits; focus doesn't). The
        // follow-up store/cache effects chain on the paint having
        // actually happened.
        const painted = replaySessionMessages(
          switchCtl.viewTokenFor(chatId),
          result.messages || [],
          { firstId: result.firstId ?? null, hasMore: !!result.hasMore },
          undefined,
          result.inflight,
          { preserveScrollIfLive: true },
        );
        if (!painted) return;
        if (
          messageId &&
          durableHasReply(result.messages || [], beforeDurableIds, messageId, finalText || null)
        ) {
          transcriptStore.clearInflightThroughReplyFinal(chatId, messageId);
        }
        // Write the just-promoted durable through to the messages cache.
        // replaySessionMessages grew the in-memory durable past what the
        // cache holds; the cache is otherwise only written by resume/
        // loadEarlier/drill. Without this, a switch-away-and-back cache-
        // paints the pre-reply rows (setDurable clobbers the in-memory
        // reply, the inflight backup is already cleared above) and the
        // reply vanishes until the slow server reconcile heals it (#235).
        persistGrownTranscript(chatId);
        log(
          `post-final durable refresh chat=${chatId} msg=${messageId ?? '∅'} ` +
          `messages=${(result.messages || []).length} ` +
          `inflight=${Array.isArray(result.inflight) ? result.inflight.length : 0}`,
        );
      } catch (e: any) {
        diag(`post-final durable refresh failed chat=${chatId}: ${e?.message || String(e)}`);
      }
    })();
  }, 900);
  postFinalRefreshTimers.set(chatId, timer);
}

/** Complete reply. `content` (if present) is the raw block array used to
 *  pull out image attachments. */
export function handleReplyFinal({ replyId, text, content = [], conversation, messageId, isReplay = false, interim = false }: any) {
  sessionDrawer.scheduleRefresh();
  // Auto-resolve any pending approval for this chat — but ONLY when this
  // is a REAL reply, not a "⏳ Still working…" heartbeat. Heartbeats fire
  // every iteration of a long autonomous turn (one per ~3 min); without
  // the gate, the first heartbeat after an approval landed would delete
  // the approval row from the tray. A real reply means
  // the agent moved past the approval point, so mark 'dismissed'. An
  // `interim` final (gateway inactivity warning) is likewise not the
  // agent moving on.
  if (!isReplay && !interim && conversation) {
    // Heartbeat detection: real hermes typically streams the body via
    // reply_delta and emits reply_final with EMPTY text (final = done
    // signal, not body carrier). So `text` from this envelope is often
    // '' — we must look up the accumulated bubble text by messageId to
    // know whether this turn was a "⏳ Still working…" beat or a real
    // turn-ending reply. The proxy push gate does the same against its
    // reply buffer (dispatch.ts:271).
    let finalTextRaw = typeof text === 'string' ? text : '';
    if (!finalTextRaw && messageId) {
      // First try the DOM — fast path for the viewed chat.
      try {
        const el = document.querySelector(
          `#transcript [data-key="${CSS.escape(messageId)}"]`,
        ) as HTMLElement | null;
        finalTextRaw = el?.textContent || '';
      } catch { /* CSS.escape failure or missing DOM — fall through */ }
      // Fall back to the inflight buffer. Replies on an OFF-screen chat
      // aren't in the DOM (only the viewed chat renders), so DOM lookup
      // misses — but the reply_delta envelope IS in the store's inflight
      // buffer, with the accumulated heartbeat text. Reverse-scan for the
      // latest delta carrying this messageId.
      if (!finalTextRaw) {
        const inflight = transcriptStore.getState(conversation).inflight;
        for (let i = inflight.length - 1; i >= 0; i--) {
          const env: any = inflight[i];
          if (env?.type === 'reply_delta' && env.message_id === messageId && typeof env.text === 'string') {
            finalTextRaw = env.text;
            break;
          }
        }
      }
    }
    if (!isProgressHeartbeatText(finalTextRaw)) {
      activityStore.resolveApprovalsForChat(conversation, 'dismissed');
    }
  }

  // Push the envelope into the store unconditionally — even for
  // background chats. The store is per-chat; the active chat re-renders
  // and finalizes the bubble; background chats stay correct for the
  // next switch-back.
  if (conversation && messageId) {
    transcriptStore.appendInflight(conversation, {
      type: 'reply_final',
      chat_id: conversation,
      message_id: messageId,
      text: text || undefined,
      ...(interim ? { interim: true } : {}),
    });
    // Final-only replies (no preceding delta) still count as one unread;
    // delta-then-final dedups via noteLiveMessage's per-id set.
    if (!isReplay) chat.noteLiveMessage(conversation, String(messageId));
    // Reply_final = whole turn ack'd; drop any remaining optimistic
    // pending sends for this chat (defensive — user_message echo
    // normally clears them earlier).
    const state = transcriptStore.getState(conversation);
    for (const p of state.pendingSends.slice()) {
      transcriptStore.clearPendingSend(conversation, p.messageId);
    }
  }

  // Fall back to the accumulated reply_delta text when the adapter
  // sends an empty reply_final. Hermes does this on some real runs:
  // the transcript can still render from delta state, and Activity
  // should show the same useful text instead of an empty notification.
  let finalText = text || '';
  if (!finalText && conversation && messageId) {
    const envs = transcriptStore.getState(conversation).inflight;
    for (const env of envs) {
      if (env.type === 'reply_delta' && env.message_id === messageId) {
        finalText = env.text;
      }
    }
  }

  const viewed = switchCtl.focusedId();
  if (viewed && conversation && conversation !== viewed) {
    // #2/#3 diag: a reply diverting to a notification means its
    // `conversation` id didn't match the on-screen chat. If this fires for
    // a chat the user is actively looking at (e.g. right after a cold call),
    // the bridge tagged the reply with an id ≠ focusedId — correlate with
    // [rtc-diag] (was conv_name null at offer time?).
    diag('[reply-diag] reply diverted to notification — conversation=', conversation,
      'focusedId=', viewed, 'messageId=', messageId ?? '∅', 'isReplay=', isReplay);
    // Skip activity + badge for "⏳ Still working…" heartbeats so a long
    // autonomous turn doesn't spam the Activity tray with N agent_reply
    // rows per turn — AND, critically, doesn't trigger pruneSuperseded-
    // Approvals to delete a pending approval for the same chat (each
    // upserted heartbeat agent_reply has a newer createdAt than the
    // approval, so the prune would dismiss the approval). Mirrors the
    // proxy push gate (isProgressHeartbeat, dispatch.ts:271).
    if (!isReplay && !isProgressHeartbeatText(finalText)) {
      activityStore.upsertNotification({
        chatId: conversation,
        kind: 'agent_reply',
        content: finalText || '',
        parleyId: typeof messageId === 'string' ? messageId : null,
        chatLabel: sessionDrawer.getTitleForChat?.(conversation) || null,
      });
      badge.incrementUnread(conversation);
    }
    return;
  }

  if (!isReplay && viewed && conversation) {
    void badge.clearUnread(conversation);
  }

  // SSE-sourced — no-op during a connected talk call (DC owns arming;
  // see onAssistantDelta comment in handleReplyDelta). Replay-guarded
  // for the same reason: a replayed final has no TTS round behind it.
  if (!isReplay) webrtcSuppress.onAssistantFinal();

  const imageBlocks = extractImageBlocks(content);


  if (!isReplay && viewed && conversation === viewed) {
    schedulePostFinalDurableRefresh(conversation, messageId, finalText || null);
  }

  if (NO_REPLY_RE.test(finalText)) {
    log('suppressed NO_REPLY from agent');
    return;
  }

  // Resolve the freshly-finalized bubble via data-key — the
  // reply_final envelope above already triggered a reconcile pass, so
  // the bubble is in the DOM with .text/markdown applied.
  const bubble = messageId
    ? document.querySelector(`#transcript [data-key="${CSS.escape(messageId)}"]`) as HTMLElement | null
    : null;

  if (finalText) {
    if (!isReplay) playFeedback('receive');

    // Speak-replies (CALL-ONLY): turnbased-tts when in Listen and not
    // in a WebRTC call (where the peer track owns audio). Outside a
    // call, the user reads replies; per-bubble play handles on-demand
    // replay.
    const inListen = turnbased.getState() !== 'idle';
    const webrtcOpen = webrtcControls.isOpen();
    const route = isReplay ? 'no-audio (replay)'
      : !inListen ? 'no-audio (call idle)'
      : webrtcOpen ? 'webrtc-peer'
      : 'turnbased-tts';
    diag(`[reply-route] ${route} replyId=${replyId} len=${finalText.length} turnbased=${turnbased.getState()} webrtcOpen=${webrtcOpen} isReplay=${isReplay}`);
    if (!isReplay && inListen && !webrtcOpen && listenReply.shouldAutoPlay(conversation)) {
      // Use the rendered bubble's id (bare message_id, = spec.key) as the
      // TTS reply id, NOT the sk-${message_id} `replyId` from the adapter.
      // The bubble's data-reply-id is the bare message_id, so playing under
      // sk-${id} put autoplay in a different namespace: the play bar never
      // painted (findBubble missed), and a later tap on the play button saw
      // activeId(sk-…) ≠ bubble(bare) → "different reply" → cancelled the
      // in-flight /tts and re-synthesized (the double `[reply-tts] enter`
      // + ~11s latency). Aligning to the bubble id keeps one namespace.
      const ttsReplyId = messageId || replyId;
      listenReply.consumeReply(conversation as string);
      listenReply.claimOwnership(ttsReplyId);
      // Per-session voice: this reply belongs to `conversation`, so prefer
      // its assigned voice (sessionIdentity) over the global default.
      const replyVoice = sessionIdentity.voiceFor(conversation as string) ?? settings.get().voice;
      void playReplyTts(finalText, replyVoice, ttsReplyId).catch(() => {
        listenReply.releaseOwnership();
        try { turnbased.notifyReplyPlayback(false); } catch {}
      });
    }

    if (bubble) {
      try {
        const cards = parseCardsFromText(finalText);
        for (const c of cards) attachCard(bubble, c);
      } catch (e) { log('card parse err:', e.message); }
      for (const b of imageBlocks) attachCard(bubble, b);
    }
  } else if (imageBlocks.length) {
    for (const b of imageBlocks) attachCardToLatestAgentBubble(b);
  }
}

/** Tool-events — cards and similar side-channel data the agent emits.
 *  canvas.show (inline bubble cards) + doc.show (Docs drawer panel). */
export function handleToolEvent({ kind, payload, conversation, isReplay }: any) {
  if (kind === 'capture.control' && payload) {
    // External capture trigger (capture plan §3.3) — hand to the pill
    // module, which gates on visibility so only the foregrounded
    // device grabs the mic. Replays are dropped in proxyClient.
    try {
      window.dispatchEvent(new CustomEvent('parley:capture-control', {
        detail: { action: payload.action },
      }));
    } catch { /* non-browser */ }
    return;
  }
  if (kind === 'capture.changed') {
    // Cross-device lifecycle: refresh the session↔meetings index so
    // sidebar badges/filtering track creates/stops/deletes live.
    try {
      window.dispatchEvent(new CustomEvent('parley:capture-changed-remote', {
        detail: { kind: payload?.captureKind, capture: payload?.capture },
      }));
    } catch { /* non-browser */ }
    return;
  }
  if (kind === 'agent.question' && payload) {
    // Elicitation pop-up is app-global chrome (like the Docs drawer):
    // the agent is blocked regardless of which chat is on screen, so no
    // viewed-session gate. questionPopup itself refuses already-expired
    // questions (ring replays of answered/dead ones).
    void import('./questionPopup.ts').then((m) => m.show(payload));
    return;
  }
  if (kind === 'doc.show' && payload) {
    // Docs drawer is chat-independent chrome — no viewed-session gate:
    // the user may have switched chats while the turn ran, and they
    // still asked to SEE this. Replays (SSE ring on boot/reconnect)
    // set the content without yanking the drawer open.
    log('doc.show event from agent');
    setDoc(
      { ...payload, chatId: conversation || undefined },
      { autoOpen: !isReplay },
    );
    return;
  }
  // Drop only for an explicitly DIFFERENT viewed session.
  const viewed = switchCtl.viewedId();
  if (viewed && conversation && conversation !== viewed) return;
  if (kind === 'canvas.show' && payload) {
    log('canvas.show event from agent');
    attachCardToLatestAgentBubble(payload);
  }
}
