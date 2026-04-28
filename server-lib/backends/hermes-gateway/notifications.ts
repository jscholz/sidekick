// Notification fan-out: persistent SSE channel that pushes adapter-
// emitted `{type:'notification', chat_id, kind, content}` envelopes to
// connected PWA tabs.
//
// GET /api/sidekick/notifications
//
// Why a separate channel rather than folding into /api/sidekick/messages
// (the per-turn SSE):
//
//   - /messages closes on reply_final. Notifications fire OUTSIDE a
//     dispatched turn (cron output, /background results, scheduled
//     reminders), so they have no in-flight SSE to ride.
//   - /messages is per-chat_id; notifications can target ANY chat_id
//     (including ones the current PWA tab isn't currently looking at,
//     so the user sees a system row in the right thread on switch).
//
// Wire shape (one event per envelope):
//   event: notification
//   data: {type:'notification', chat_id, kind, content, ...}
//
// Queue behavior: when no PWA tabs are subscribed, recent envelopes are
// held in a small ring so a tab opened seconds-after-cron-fire still
// catches the message. The ring is intentionally tiny (32 entries) —
// notifications are user-visible state, not a durable bus, and a fresh
// install opening hours later shouldn't replay a backlog.

import { client } from './client.ts';

interface NotificationEnvelope extends Record<string, unknown> {
  type: 'notification';
  chat_id?: string;
  kind?: string;
  content?: string;
}

const RECENT_CAP = 32;
const recent: NotificationEnvelope[] = [];
const subscribers = new Set<{ res: any; ka: NodeJS.Timeout }>();

function broadcast(env: NotificationEnvelope): void {
  const frame = `event: notification\ndata: ${JSON.stringify(env)}\n\n`;
  for (const sub of subscribers) {
    try { sub.res.write(frame); }
    catch { detach(sub); }
  }
  // Push into the recent ring AFTER attempting broadcast so a freshly-
  // attached tab doesn't replay something it already saw via the live
  // path. Bound the ring at RECENT_CAP entries.
  recent.push(env);
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
    if (env && env.type === 'notification' && typeof env.chat_id === 'string') {
      broadcast(env as NotificationEnvelope);
    }
  });
}

export function handleSidekickNotifications(req, res): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  // Replay anything still in the ring so a tab opened a few seconds
  // after a cron fire still sees the message. Tabs that were attached
  // when the original broadcast went out de-dupe via the envelope's
  // synthetic id below if we add one — for v1 the user-facing impact
  // of a duplicate "(notification — cron) X" is tolerable; we'll add
  // dedup keys when notifications start carrying ids.
  for (const env of recent) {
    res.write(`event: notification\ndata: ${JSON.stringify(env)}\n\n`);
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
