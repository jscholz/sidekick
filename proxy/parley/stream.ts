// Persistent SSE channel: every outbound envelope from the hermes
// parley adapter is mirrored to subscribed PWA tabs, tagged with
// chat_id. The PWA opens this once on connect and keeps it open;
// turn lifecycle is decoupled from the connection lifecycle.
//
// GET /api/parley/stream
//
// Why a single persistent channel (replacing the per-message SSE):
//
//   - Hermes platform adapters can emit multiple `send()` calls per
//     turn (system bootstrap nudges, the actual agent reply, possibly
//     tool-result-as-text). The old per-POST SSE closed on the FIRST
//     reply_final, dropping every subsequent bubble. `reply_final`
//     means "this BUBBLE is done", NOT "the turn is done" — there
//     are no turn boundaries on the wire. This matches how
//     telegram/slack/signal adapters work.
//   - Notifications (cron output, /background results, scheduled
//     reminders) fire OUTSIDE any user-initiated turn and need a
//     persistent channel anyway.
//   - Cross-chat envelopes (notification for chat B while user is in
//     chat A, session_changed during compression) ride the same
//     channel; the PWA shell decides what to render where.
//
// Wire shape (one event per envelope):
//   event: <envelope.type>
//   data: <json envelope verbatim>
//
// Event types fanned out: reply_delta, reply_final, image, typing,
// notification, session_changed, error, tool_call, tool_result,
// user_message. All carry chat_id so the PWA can route to the right
// view. tool_call / tool_result are observational (Phase 3) — the PWA
// decides whether to render them based on the agentActivity setting.
// user_message is the cross-device broadcast for the user's own
// dispatched message (the originating device's optimistic bubble
// dedups against it).
//
// Replay ring: when no PWA tabs are subscribed, recent envelopes are
// held in a small ring so a tab opened seconds-after-fire still
// catches the message. Bounded at RECENT_CAP — the channel is
// user-visible state, not a durable bus, and a fresh install opening
// hours later shouldn't replay a backlog.
//
// Each entry carries a monotonic `id` so reconnecting subscribers
// (mobile-Safari background-kill, network handoff, etc.) can resume
// replay from a cursor via the SSE `Last-Event-ID` header — replay
// only entries with id > that cursor. Without the cursor a fresh
// subscriber gets the full ring (legacy behavior). When the missed
// window exceeds RECENT_CAP entries the client falls back to a
// transcript reconcile path; the ring is best-effort, not durable.

import { getUpstream } from './index.ts';
import {
  dispatchPush,
  envelopeToPayload,
  isPushEligible,
  isProgressHeartbeat,
} from './notifications/dispatch.ts';
import { isConfigured as isNotificationsConfigured } from './notifications/index.ts';
import { isPushOwnedByPlugin } from './notifications/delegate.ts';
import { isMuted } from './notifications/mutes.ts';
import { isUserEngaged } from './notifications/visibility.ts';
import { inQuietHours, isKindEnabled, type PushKinds } from './notifications/prefs.ts';
import {
  recordPushAndGetCount,
  decorateTitleForCount,
} from './notifications/digest.ts';
import {
  recordDecision,
  recordDispatchOutcome,
} from './notifications/diagnostics.ts';
import * as replyBuffer from './notifications/replyBuffer.ts';
import type { ParleyEnvelope, UpstreamAgent } from './upstream.ts';

type Envelope = Record<string, unknown> & { type: string; chat_id?: string };

// Envelope types we mirror to PWA tabs. Anything else (heartbeats,
// internal acks) is intentionally dropped here.
const FANOUT_TYPES = new Set<string>([
  'reply_delta',
  'reply_final',
  // Ephemeral per-chat working indicator (plugin turns the gateway's
  // "⏳ Working — …" heartbeat into this instead of a bubble). Fans out
  // like typing; never push-eligible (plugin stamps should_push=false).
  'status',
  'image',
  'typing',
  'notification',
  'session_changed',
  'error',
  'tool_call',
  'tool_result',
  // Cross-device user-message broadcast. Originating device dedups
  // against its optimistic bubble via message_id; other devices render
  // the user bubble for the first time. See proxyClient `handleEnvelope`
  // case 'user_message' for the PWA-side handler.
  'user_message',
  // Cross-device SSOT sync — when one device hits /seen, /mark, or a
  // pin/unpin, the plugin emits these envelopes so other devices
  // re-fetch the canonical state without waiting for foreground.
  // badge.ts + pin drawer use the diff-aware refresh path (1500ms
  // debounced), so this stays cheap even with multi-PWA setups.
  // conversation_deleted is fanned so other devices drop the row from
  // their sidebar IDB cache without waiting for the next list poll.
  'unread_changed',
  'pins_changed',
  'conversation_deleted',
  // Unified elicitation protocol (2026-07-13): the agent is blocked on
  // a user answer (hermes clarify tool today; any backend's ask-user
  // mechanism tomorrow). PWA renders a pop-up with choice buttons +
  // countdown from expires_at; the answer POSTs to /questions/{id}.
  'agent_question',
  // display_doc tool → Docs panel push. Carries the full document body
  // (plugin caps it at 1MB) — rides the ring like any other envelope so
  // a tab opened seconds after the push still receives it via replay.
  'doc_show',
  // Meeting capture (proxy-owned — capture.ts): lifecycle state for
  // cross-device pills/lists, and the external-trigger control plane
  // ("start recording" from a Shortcut → foregrounded device's mic).
  'capture_changed',
  'capture_control',
]);

// Bumped from 32 → 128: traffic is heavier now (every reply_delta
// rides this channel). 128 entries is roughly one fully-streamed
// agent reply at typical token cadence — enough that a tab opened
// mid-burst sees the recent context, not so large the ring becomes
// a backlog.
const RECENT_CAP = 128;
// Each ring entry is tagged with a monotonic id so subscribers can
// resume replay from a known cursor via the SSE `Last-Event-ID`
// header. Ids are process-local — they don't survive proxy restart,
// which is fine: clients fall back to "no Last-Event-ID" semantics
// (replay the whole ring).
const recent: { id: number; env: Envelope }[] = [];
let lastId = 0;
// Highest ring id that has been CAP-evicted. Advances only on the
// RECENT_CAP shift below — never on resolveQuestion() removals, which
// drop entries deliberately. Used for the replay_gap probe so pulling
// an answered question out of the ring doesn't masquerade as "the
// client missed envelopes" and trigger a spurious transcript refetch.
let evictedThroughId = 0;

// ── Answered-question suppression (field bug 2026-08-24) ──────────────
//
// `agent_question` rides the replay ring like any other envelope, and
// the PWA's only suppression was expiry. A question answered two
// minutes into a sixty-minute TTL therefore popped again on EVERY
// refresh until the TTL ran out. Once a question is ANSWERED it is
// dead — no device should ever be asked it again.
//
// Two halves, both needed:
//   1. Yank the envelope out of `recent` so replay can't resurface it.
//   2. Remember the id, because the answer can land BEFORE the
//      envelope does (plugin emits agent_question on its /v1/events
//      loop; the phone answers over a separate HTTP route) — a
//      late arrival must be dropped at broadcast time too.
//
// Bounded and insertion-ordered: this is user-visible ephemeral state,
// not a durable ledger. A few hundred ids covers any plausible burst;
// past that the oldest fall out and the worst case is the pre-fix
// behavior for a question answered hundreds of questions ago.
//
// DISMISSED questions are deliberately NOT recorded here — the ×
// button says "Hide (the agent keeps waiting)", so a dismissed
// question SHOULD come back on reload. Only answers land here.
const RESOLVED_CAP = 256;
const resolvedQuestions = new Set<string>();

/** Mark an agent question ANSWERED: drop it from the replay ring and
 *  remember the id so a late-arriving envelope for it is suppressed at
 *  broadcast time. Cross-device by construction — answering on the
 *  phone stops the pop-up on the Mac, because the ring the Mac replays
 *  on reconnect is this one. Called by the proxy's answer route
 *  (notifications/delegate.ts delegateQuestionAnswer) once the upstream
 *  has accepted the answer. */
export function resolveQuestion(questionId: string): void {
  if (typeof questionId !== 'string' || !questionId) return;
  for (let i = recent.length - 1; i >= 0; i--) {
    const env = recent[i].env;
    if (env.type === 'agent_question' && env.question_id === questionId) {
      recent.splice(i, 1);
    }
  }
  // Re-insert so a repeat answer refreshes recency rather than aging out.
  resolvedQuestions.delete(questionId);
  resolvedQuestions.add(questionId);
  while (resolvedQuestions.size > RESOLVED_CAP) {
    const oldest = resolvedQuestions.values().next().value;
    if (oldest === undefined) break;
    resolvedQuestions.delete(oldest);
  }
}

/** True if `env` is an agent_question we've already seen answered. */
function isResolvedQuestion(env: Envelope): boolean {
  return env.type === 'agent_question'
    && typeof env.question_id === 'string'
    && resolvedQuestions.has(env.question_id);
}
interface Subscriber {
  res: any;
  ka: NodeJS.Timeout;
  /** When set, this subscriber only receives envelopes whose chat_id
   *  matches. PWA tabs should always pass ?chat_id= so cross-chat events
   *  never reach the wrong view; null is left as a back-compat fallback
   *  for diagnostic clients (curl) that want the raw firehose. */
  chatId: string | null;
}
const subscribers = new Set<Subscriber>();

// Per-chat timestamp of the most recent broadcast for that chat. Used
// by the push-dispatch idle gate to distinguish "user has SSE attached
// AND is actively engaged" from "user has SSE attached but the channel
// has been quiet long enough that they've probably backgrounded the tab."
// Cleared opportunistically when entries become very stale via the
// QUIET_WINDOW_MS scan in maybeDispatchPush (no separate sweep thread).
const lastBroadcastAt = new Map<string, number>();
// Threshold beyond which a chat with an attached SSE subscriber is
// nonetheless treated as "offline" for push purposes. 30s comfortably
// exceeds intra-turn delta cadence (sub-second) and tool-call gaps
// (most tools <10s), so an actively-watched chat stays "active." A
// chat the user pulled up but then walked away from will fall past
// the threshold within half a minute.
const QUIET_WINDOW_MS = 30_000;

function broadcast(env: Envelope): void {
  // Defense in depth: every envelope on this channel MUST carry chat_id
  // so the PWA can route. Any plugin envelope missing it is a contract
  // violation; drop with a warn rather than fan it out untargeted.
  if (typeof env.chat_id !== 'string' || !env.chat_id) {
    console.warn(`[parley] dropping envelope without chat_id (type=${env.type})`);
    return;
  }
  lastId++;
  const id = lastId;
  const evtName = typeof env.type === 'string' ? env.type : 'message';
  const frame = `id: ${id}\nevent: ${evtName}\ndata: ${JSON.stringify(env)}\n\n`;
  for (const sub of subscribers) {
    if (sub.chatId && sub.chatId !== env.chat_id) continue;
    try { sub.res.write(frame); }
    catch { detach(sub); }
  }
  // Push into the recent ring AFTER attempting broadcast so a freshly-
  // attached tab doesn't replay something it already saw via the live
  // path. Bound the ring at RECENT_CAP entries.
  recent.push({ id, env });
  if (recent.length > RECENT_CAP) {
    const dropped = recent.shift();
    if (dropped) evictedThroughId = dropped.id;
  }
  // Track per-chat broadcast cadence for the push-dispatch idle gate
  // (see maybeDispatchPush). Updated AFTER fanout so the timestamp
  // reflects "this envelope's broadcast time" — pushEnvelope reads
  // the PRIOR value before calling broadcast() so the gate compares
  // "was the channel active before this arrival?" not "after."
  lastBroadcastAt.set(env.chat_id, Date.now());
}

function detach(sub: Subscriber): void {
  clearInterval(sub.ka);
  subscribers.delete(sub);
}

/** True if any SSE subscriber is currently attached to `chatId`. Used
 *  by the push-dispatch gate to decide whether the user is "offline
 *  for this chat" and should receive an OS notification. */
function hasActiveSubFor(chatId: string): boolean {
  if (!chatId) return false;
  for (const sub of subscribers) {
    // Diagnostic firehose subscribers (no chatId filter) DO count as
    // viewing every chat — push would be redundant for them.
    if (sub.chatId === null || sub.chatId === chatId) return true;
  }
  return false;
}

/** Fire-and-forget push delivery for push-eligible envelopes when the
 *  user has no live SSE subscriber for the chat, OR has one but the
 *  channel has been quiet long enough to suspect the tab is backgrounded.
 *  Logs but doesn't throw on failure — push is best-effort and shouldn't
 *  impact broadcast.
 *
 *  `prevBroadcastAt` is the per-chat lastBroadcastAt value captured BEFORE
 *  the current envelope's broadcast() updated it — see pushEnvelope. The
 *  caller passes 0 when no prior broadcast for the chat exists, which we
 *  treat as "infinitely idle" (push). */
function maybeDispatchPush(env: Envelope, prevBroadcastAt: number, bodyOverride?: string): void {
  // When push is owned by the backend plugin (openclaw path), the
  // plugin observes agent events directly via its in-process bus and
  // does its own dispatch. The proxy must NOT also dispatch — would
  // double-send each push to every subscriber.
  if (isPushOwnedByPlugin()) return;
  // Observability: every gate decision logs a single line so the
  // journal can answer "why didn't push fire for envelope X?" without
  // re-reading the code. The skipReason variable is the source of
  // truth — set at the gate that decided to suppress, logged once
  // before return. Eligibility = "dispatch" string.
  void prevBroadcastAt;  // legacy fallback gate removed below; param kept for ABI
  const decide = (): { decision: string; chatId: string } => {
    if (!isNotificationsConfigured()) return { decision: 'vapid_unconfigured', chatId: '' };
    if (!isPushEligible(env as Record<string, any>)) {
      return { decision: 'not_eligible', chatId: '' };
    }
    const cid = typeof env.chat_id === 'string' ? env.chat_id : '';
    if (!cid) return { decision: 'missing_chat_id', chatId: '' };
    // Suppress the per-iteration "⏳ Still working… (N min elapsed —
    // iteration X/60)" heartbeats the agent emits during a long autonomous
    // turn. reply_final carries its text via bodyOverride (drained from the
    // reply buffer); notifications carry content/text. Pushing each is
    // noise and they coalesce-clobber each other (field 2026-05-26). The
    // turn's actual final answer isn't a heartbeat, so it still pushes.
    const hbText = (typeof bodyOverride === 'string' && bodyOverride)
      ? bodyOverride
      : (typeof (env as any).content === 'string' ? (env as any).content
        : typeof (env as any).text === 'string' ? (env as any).text : '');
    if (isProgressHeartbeat(hbText)) return { decision: 'heartbeat_progress', chatId: cid };
    // Per-kind filter — user toggled this category off in Settings →
    // Notifications. Map envelope.type → PushKinds key:
    //   reply_final  → 'agent_reply'
    //   notification → concrete env.kind when Parley has a toggle.
    // Anything else falls through to enabled-by-default (kind=unknown).
    const notificationKind = typeof (env as any).kind === 'string' ? (env as any).kind : '';
    const kind: keyof PushKinds | null =
      env.type === 'reply_final' ? 'agent_reply'
      : env.type === 'notification' && notificationKind === 'cron' ? 'cron'
      : env.type === 'notification' && notificationKind === 'approval' ? 'approval'
      : null;
    if (kind && !isKindEnabled(kind)) {
      return { decision: `kind_disabled:${kind}`, chatId: cid };
    }
    // Per-chat mute — user explicitly silenced this chat's pushes via
    // the sidebar 3-dots menu. Checked AFTER type/should_push so the
    // decision is independent of envelope-class (mute everything from
    // this chat, not just replies).
    if (isMuted(cid)) return { decision: 'muted', chatId: cid };
    // Quiet hours — global override, respects the urgent flag.
    if (inQuietHours() && (env as any).urgent !== true) {
      return { decision: 'quiet_hours', chatId: cid };
    }
    // Visibility-state gate — the canonical engagement signal. PWA
    // reports visibility=visible + viewed-chat=X on every
    // document.visibilitychange + chat switch; isUserEngaged returns
    // true within the 2s engagement window.
    if (isUserEngaged(cid)) return { decision: 'user_engaged', chatId: cid };
    // 2026-05-12 update: dropped the prior `hasActiveSubFor + 30s idle`
    // fallback that lived here. It bit during long turns where typing/
    // tool_result envelopes streamed continuously — channel was never
    // "idle for 30s," gate suppressed even when the user had clearly
    // backgrounded. Trust visibility reports as the single source of
    // truth. When visibility hasn't been reported (older PWA bundle
    // pre-`1b2733a`), the gate falls through to dispatch, which is the
    // correct failure mode: over-notify > under-notify.
    return { decision: 'dispatch', chatId: cid };
  };
  const { decision, chatId } = decide();
  const decisionTs = Date.now();
  const urgent = (env as any).urgent === true;
  // The diagnostics ring should reflect "decisions the user might
  // want to debug" — primarily push-eligible envelopes that did or
  // didn't dispatch. `not_eligible` (typing / tool_call / typing
  // envelopes that never push by design) and `vapid_unconfigured`
  // (system-level state, not per-envelope) are noise; skip recording.
  // The journal still logs ALL skips for shell-side debugging.
  const noisyDecisions = decision === 'not_eligible' || decision === 'vapid_unconfigured';
  if (decision !== 'dispatch') {
    console.log(`[notifications] skip type=${env.type} chat=${chatId} reason=${decision}`);
    if (!noisyDecisions) {
      recordDecision({
        ts: decisionTs,
        envelope_type: typeof env.type === 'string' ? env.type : 'unknown',
        chat_id: chatId,
        decision,
        urgent,
      });
    }
    return;
  }
  recordDecision({
    ts: decisionTs,
    envelope_type: typeof env.type === 'string' ? env.type : 'unknown',
    chat_id: chatId,
    decision: 'dispatch',
    urgent,
  });
  const payload = envelopeToPayload(env as Record<string, any>, bodyOverride);
  // Bundle digest: count this push against the chat's burst window
  // and decorate the title with `(N) ` when we're inside a multi-push
  // burst. Apple's tag-replace coalescing handles the visual stacking;
  // the title prefix surfaces the count so the user knows how many
  // arrived without having to scroll the notification stack.
  const burstCount = recordPushAndGetCount(chatId);
  payload.title = decorateTitleForCount(payload.title, burstCount);
  // Don't await — dispatch can take seconds (push services round-trip)
  // and we don't want to block the next envelope.
  dispatchPush(payload).then((result) => {
    console.log(
      `[notifications] dispatched type=${env.type} chat=${chatId} ` +
      `→ delivered=${result.dispatched} pruned=${result.pruned} failed=${result.failed}`,
    );
    recordDispatchOutcome(decisionTs, chatId,
      typeof env.type === 'string' ? env.type : 'unknown',
      { delivered: result.dispatched, failed: result.failed, pruned: result.pruned });
  }).catch((e) => {
    console.warn('[notifications] dispatchPush threw:', e?.message ?? e);
  });
}

/** Push an envelope into the SSE multiplexer. Used by step-5 callers
 *  (upstream sendMessage iterators + subscribeEvents loop) to feed
 *  envelopes that arrived via the agent contract instead of WS.
 *  Filters non-fanout types the same way the WS wildcard does.
 *
 *  Also funnels into the inflight cache so a mid-turn switch-away
 *  client can replay what happened on switch-back. This is the SINGLE
 *  recording site — both /v1/responses dispatch (messages.ts) AND
 *  /v1/events out-of-turn broadcast (runUpstreamEventsLoop below)
 *  feed through here, so cross-device-broadcast envelopes
 *  (user_message, tool_call) and the in-turn stream are both cached.
 *  An earlier version recorded only in dispatch — out-of-turn
 *  tool_call envelopes broadcast by hermes-core for cross-device
 *  visibility then silently bypassed the cache and a switch-back
 *  found nothing. Centralizing here keeps the two channels
 *  consistent. */
export function pushEnvelope(env: ParleyEnvelope | Envelope): void {
  if (!env || typeof env.type !== 'string') return;
  if (!FANOUT_TYPES.has(env.type)) return;
  // Already answered — drop entirely (no fan-out, no ring entry, no
  // push). Covers the race where the answer beats the envelope.
  if (isResolvedQuestion(env as Envelope)) {
    console.log(`[parley] dropping agent_question ${(env as any).question_id} — already answered`);
    return;
  }
  const chatId = typeof (env as any).chat_id === 'string' ? (env as any).chat_id : '';
  // (Previously: the proxy maintained an in-memory `inflight` cache of
  // envelopes for mid-turn switch-away replay. Retired 2026-05-17 once
  // both plugins (hermes + openclaw) became authoritative for in-flight
  // state via their TurnBuffer → /v1/conversations/{id}/items merge.
  // Crack C of the turn-taking audit. Production has been running with
  // `PARLEY_INFLIGHT_OWNED_BY_PLUGIN=true` on both parley.service
  // and parley-openclaw.service — the cache was dead code by the time
  // it shipped.)
  // Reply-text buffering for push body previews. reply_delta carries
  // the cumulative reply text; reply_final carries none. Stash on
  // delta, drain on final — independent of the eventual dispatch
  // decision so suppressed (user_engaged etc.) finals still clear the
  // buffer instead of leaking. The drained text is threaded through
  // maybeDispatchPush → envelopeToPayload as a body override.
  let replyBody: string | undefined;
  if (chatId) {
    if (env.type === 'reply_delta') {
      const txt = (env as any).text;
      if (typeof txt === 'string') replyBuffer.setLatest(chatId, txt);
    } else if (env.type === 'reply_final') {
      replyBody = replyBuffer.takeAndClear(chatId);
    }
  }
  // Capture the per-chat last-broadcast timestamp BEFORE broadcast()
  // updates it — the idle-gate in maybeDispatchPush wants to know "was
  // the channel active before this envelope?" not "after." Guard against
  // missing chat_id (broadcast() also guards but defense in depth here).
  const broadcastChatId = typeof (env as any).chat_id === 'string' ? (env as any).chat_id : '';
  const prevBroadcastAt = broadcastChatId ? (lastBroadcastAt.get(broadcastChatId) || 0) : 0;

  broadcast(env as Envelope);
  // Push dispatch runs AFTER broadcast so live tabs see the message
  // first (no double-render race), and so the hasActiveSubFor check
  // sees the up-to-date subscriber set just before deciding.
  maybeDispatchPush(env as Envelope, prevBroadcastAt, replyBody);
}

/** Wired ONCE at proxy startup so envelope fan-out is in place before
 *  any envelopes arrive. Idempotent — calling twice no-ops. Starts a
 *  long-lived `/v1/events` subscription on the upstream; out-of-turn
 *  envelopes (notifications, session_changed for chats not in an
 *  active /v1/responses turn, late tool events) flow into the
 *  multiplexer through this loop. In-turn envelopes ride
 *  `upstream.sendMessage` from messages.ts. */
let wired = false;
let eventsAbort: AbortController | null = null;
export function init(): void {
  if (wired) return;
  wired = true;
  const upstream = getUpstream();
  if (!upstream) return; // unconfigured — handlers will 503/empty
  eventsAbort = new AbortController();
  void runUpstreamEventsLoop(upstream, eventsAbort.signal);
}

/** Persistent subscription to the upstream's `/v1/events` SSE channel.
 *  Reconnects with exponential backoff on drop, the same way the WS
 *  client did. `lastEventId` advances so reconnects resume from the
 *  cursor and pick up the plugin's bounded replay ring without
 *  re-rendering the recent firehose. */
async function runUpstreamEventsLoop(
  upstream: UpstreamAgent,
  signal: AbortSignal,
): Promise<void> {
  const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
  let attempt = 0;
  let lastEventId: number | undefined;
  while (!signal.aborted) {
    try {
      for await (const { id, envelope } of upstream.subscribeEvents({
        signal,
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      })) {
        attempt = 0;
        lastEventId = id;
        pushEnvelope(envelope);
      }
    } catch (e: any) {
      if (signal.aborted) return;
      console.warn('[parley] /v1/events subscription dropped:', e?.message);
    }
    if (signal.aborted) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    attempt += 1;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}

/** Test-only: reset module state between proxy test cases. Production
 *  must never call this. */
export function __resetForTest(): void {
  wired = false;
  if (eventsAbort) {
    try { eventsAbort.abort(); } catch { /* noop */ }
    eventsAbort = null;
  }
  recent.length = 0;
  lastId = 0;
  evictedThroughId = 0;
  resolvedQuestions.clear();
  for (const sub of subscribers) {
    try { clearInterval(sub.ka); } catch { /* noop */ }
    try { sub.res.end(); } catch { /* noop */ }
  }
  subscribers.clear();
  // Clear the per-chat last-broadcast clock too — otherwise the
  // legacy 30s-idle gate sees stale timestamps from a prior test's
  // broadcasts and incorrectly suppresses push in the next rig.
  lastBroadcastAt.clear();
  // Drop any accumulated reply-text buffers so the next rig's
  // reply_final body previews start clean.
  replyBuffer.__resetForTest();
}

export function handleParleyStream(req, res): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  // ?chat_id=<id> scopes both live broadcast and replay to a single chat.
  // PWA tabs always pass this so cross-chat envelopes never reach the
  // wrong view. Validate against the same shape used by the rest of the
  // /api/parley/* surface; reject malformed values rather than silently
  // ignoring them.
  const url = new URL(req.url || '/', 'http://x');
  const chatIdParam = url.searchParams.get('chat_id');
  let chatId: string | null = null;
  if (chatIdParam !== null) {
    // Same validator as history.ts / sessions.ts — accepts
    // cross-platform IDs (whatsapp @lid, telegram numeric, etc.).
    if (!/^[A-Za-z0-9._@:-]{1,128}$/.test(chatIdParam)) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'invalid chat_id' })}\n\n`);
      res.end();
      return;
    }
    chatId = chatIdParam;
  }

  // SSE cursor: replay only entries strictly newer than this so a
  // reconnecting client doesn't re-render duplicates.
  //
  // Browser EventSource native-retry sends `Last-Event-ID` as a header.
  // Manual close+reopen (the OS-lifecycle path on visibility/online/
  // pageshow) creates a fresh EventSource without that state, so the
  // PWA passes its cursor as `?last_event_id=N` instead. Honor either;
  // header wins when both are present. Anything missing or unparseable
  // falls back to "fresh subscriber" — replay the whole ring.
  //
  // `?live_only=1` opts OUT of replay entirely — used by the audio
  // bridge, which opens a fresh subscriber per agent turn and wants
  // ONLY envelopes broadcast after its connection. Without this the
  // bridge sees historical envelopes from the same chat (same DB row
  // every replay), re-feeds them through Aura TTS, and prematurely
  // breaks on the replayed reply_final before the actual new turn
  // arrives.
  const liveOnly = url.searchParams.get('live_only') === '1';
  const headerRaw = req.headers['last-event-id'];
  const queryRaw = url.searchParams.get('last_event_id');
  const cursorRaw = (typeof headerRaw === 'string' && headerRaw)
    || (queryRaw ?? '');
  const lastEventId = cursorRaw ? Number.parseInt(cursorRaw, 10) : NaN;
  const replayFrom = Number.isFinite(lastEventId) ? lastEventId : -1;
  if (!liveOnly) {
    // #204: if the client's cursor predates the ring's oldest retained
    // entry (cap-evicted) — or comes from a previous server life
    // (cursor beyond our monotonic counter after a restart) — the
    // replay below CANNOT cover what the client missed. Say so
    // explicitly: the PWA reacts by refetching the active transcript.
    // No `id:` field, so the control frame never disturbs the cursor.
    // Derived from CAP eviction only (see evictedThroughId) — entries
    // resolveQuestion() pulled out are intentionally-missing, not a gap.
    const oldestRetained = evictedThroughId + 1;
    if (replayFrom >= 0 && (replayFrom < oldestRetained - 1 || replayFrom > lastId)) {
      res.write(`event: replay_gap\ndata: ${JSON.stringify({ cursor: replayFrom, oldest: oldestRetained, last: lastId })}\n\n`);
    }
    for (const entry of recent) {
      if (entry.id <= replayFrom) continue;
      if (chatId && entry.env.chat_id !== chatId) continue;
      // Belt-and-braces: resolveQuestion() already spliced answered
      // questions out of the ring, but an entry can only be missed
      // here if that ever regresses. Cheap; keeps the guarantee local
      // to the replay loop that a reader will actually read.
      if (isResolvedQuestion(entry.env)) continue;
      const evtName = typeof entry.env.type === 'string' ? entry.env.type : 'message';
      // Tag replayed envelopes so PWA-side handlers can suppress side
      // effects that should only fire on a fresh turn (TTS playback,
      // receive chime). Bubble rendering still rides the replay.
      const replayEnv = { ...entry.env, _replay: true };
      res.write(`id: ${entry.id}\nevent: ${evtName}\ndata: ${JSON.stringify(replayEnv)}\n\n`);
    }
  }
  const ka = setInterval(() => {
    try { res.write(': ka\n\n'); }
    catch { /* will be evicted on next broadcast */ }
  }, 15_000);
  const sub: Subscriber = { res, ka, chatId };
  subscribers.add(sub);
  req.on('close', () => detach(sub));
  req.on('error', () => detach(sub));
}
