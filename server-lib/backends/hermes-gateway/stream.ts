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

import { client } from './client.ts';

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
const subscribers = new Set<{ res: any; ka: NodeJS.Timeout }>();

function broadcast(env: Envelope): void {
  lastId++;
  const id = lastId;
  const evtName = typeof env.type === 'string' ? env.type : 'message';
  const frame = `id: ${id}\nevent: ${evtName}\ndata: ${JSON.stringify(env)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(frame); }
    catch { detach(sub); }
  }
  // Push into the recent ring AFTER attempting broadcast so a freshly-
  // attached tab doesn't replay something it already saw via the live
  // path. Bound the ring at RECENT_CAP entries.
  recent.push({ id, env });
  if (recent.length > RECENT_CAP) recent.shift();
}

function detach(sub: { res: any; ka: NodeJS.Timeout }): void {
  clearInterval(sub.ka);
  subscribers.delete(sub);
}

/** Wired ONCE at proxy startup so the gateway client's wildcard fan-out
 *  is in place before any envelopes arrive. Idempotent — calling twice
 *  no-ops. */
let wired = false;
export function init(): void {
  if (wired) return;
  wired = true;
  client.subscribeAll((env) => {
    if (!env || typeof env.type !== 'string') return;
    if (!FANOUT_TYPES.has(env.type)) return;
    broadcast(env as Envelope);
  });
}

/** Test-only: reset module state between proxy test cases. Production
 *  must never call this. */
export function __resetForTest(): void {
  wired = false;
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
  // SSE `Last-Event-ID`: when the client reconnects (auto-retry, manual
  // forceReconnect on visibility/online, etc.), the EventSource sends
  // back the most recent id it saw. Replay only entries strictly newer
  // than that cursor so the client doesn't re-render duplicates. Node
  // lower-cases header names, so headers['last-event-id'] is the right
  // key. Anything missing or unparseable falls back to "fresh
  // subscriber" — replay the whole ring like before.
  const lastEventIdRaw = req.headers['last-event-id'];
  const lastEventId = typeof lastEventIdRaw === 'string'
    ? Number.parseInt(lastEventIdRaw, 10)
    : NaN;
  const replayFrom = Number.isFinite(lastEventId) ? lastEventId : -1;
  for (const entry of recent) {
    if (entry.id <= replayFrom) continue;
    const evtName = typeof entry.env.type === 'string' ? entry.env.type : 'message';
    res.write(`id: ${entry.id}\nevent: ${evtName}\ndata: ${JSON.stringify(entry.env)}\n\n`);
  }
  const ka = setInterval(() => {
    try { res.write(': ka\n\n'); }
    catch { /* will be evicted on next broadcast */ }
  }, 15_000);
  const sub = { res, ka };
  subscribers.add(sub);
  req.on('close', () => detach(sub));
  req.on('error', () => detach(sub));
}
