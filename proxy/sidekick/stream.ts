// Persistent SSE channel: every outbound envelope from the hermes
// sidekick adapter is mirrored to subscribed PWA tabs, tagged with
// chat_id. The PWA opens this once on connect and keeps it open;
// turn lifecycle is decoupled from the connection lifecycle.
//
// GET /api/sidekick/stream
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
// notification, session_changed, error, tool_call, tool_result. All
// carry chat_id so the PWA can route to the right view. tool_call /
// tool_result are observational (Phase 3) — the PWA decides whether
// to render them based on the agentActivity setting.
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
import type { SidekickEnvelope, UpstreamAgent } from './upstream.ts';

type Envelope = Record<string, unknown> & { type: string; chat_id?: string };

// Envelope types we mirror to PWA tabs. Anything else (heartbeats,
// internal acks) is intentionally dropped here.
const FANOUT_TYPES = new Set<string>([
  'reply_delta',
  'reply_final',
  'image',
  'typing',
  'notification',
  'session_changed',
  'error',
  'tool_call',
  'tool_result',
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

function broadcast(env: Envelope): void {
  // Defense in depth: every envelope on this channel MUST carry chat_id
  // so the PWA can route. Any plugin envelope missing it is a contract
  // violation; drop with a warn rather than fan it out untargeted.
  if (typeof env.chat_id !== 'string' || !env.chat_id) {
    console.warn(`[sidekick] dropping envelope without chat_id (type=${env.type})`);
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
  if (recent.length > RECENT_CAP) recent.shift();
}

function detach(sub: Subscriber): void {
  clearInterval(sub.ka);
  subscribers.delete(sub);
}

/** Push an envelope into the SSE multiplexer. Used by step-5 callers
 *  (upstream sendMessage iterators + subscribeEvents loop) to feed
 *  envelopes that arrived via the agent contract instead of WS.
 *  Filters non-fanout types the same way the WS wildcard does. */
export function pushEnvelope(env: SidekickEnvelope | Envelope): void {
  if (!env || typeof env.type !== 'string') return;
  if (!FANOUT_TYPES.has(env.type)) return;
  broadcast(env as Envelope);
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
      console.warn('[sidekick] /v1/events subscription dropped:', e?.message);
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
  for (const sub of subscribers) {
    try { clearInterval(sub.ka); } catch { /* noop */ }
    try { sub.res.end(); } catch { /* noop */ }
  }
  subscribers.clear();
}

export function handleSidekickStream(req, res): void {
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
  // /api/sidekick/* surface; reject malformed values rather than silently
  // ignoring them.
  const url = new URL(req.url || '/', 'http://x');
  const chatIdParam = url.searchParams.get('chat_id');
  let chatId: string | null = null;
  if (chatIdParam !== null) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatIdParam)) {
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
  const headerRaw = req.headers['last-event-id'];
  const queryRaw = url.searchParams.get('last_event_id');
  const cursorRaw = (typeof headerRaw === 'string' && headerRaw)
    || (queryRaw ?? '');
  const lastEventId = cursorRaw ? Number.parseInt(cursorRaw, 10) : NaN;
  const replayFrom = Number.isFinite(lastEventId) ? lastEventId : -1;
  for (const entry of recent) {
    if (entry.id <= replayFrom) continue;
    if (chatId && entry.env.chat_id !== chatId) continue;
    const evtName = typeof entry.env.type === 'string' ? entry.env.type : 'message';
    res.write(`id: ${entry.id}\nevent: ${evtName}\ndata: ${JSON.stringify(entry.env)}\n\n`);
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
