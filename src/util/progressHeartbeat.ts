/** "⏳ Still working… (N min elapsed — iteration X/60, …)" — the canonical
 *  per-iteration progress heartbeat an autonomous agent emits during a long
 *  turn. A heartbeat is a "still on it" pulse, NOT the agent moving past a
 *  pending approval — every consumer that infers "agent moved on" from a
 *  newer message must exclude these:
 *    - backendEventHandlers.handleReplyFinal — a heartbeat reply_final must
 *      not auto-dismiss pending approvals (or spam agent_reply tray rows).
 *    - activityStore.pruneSupersededApprovals — the hermes plugin persists
 *      push-delivered heartbeats as agent_reply Activity rows server-side
 *      (_persist_activity_for_push), so the snapshot-time prune sees them
 *      too (field bug 2026-07-07: opening the tray dismissed a pending
 *      approval because a newer heartbeat row was in the snapshot).
 *  Two matchers: the ⏳-prefixed form, plus a structural fallback in case
 *  the emoji is stripped upstream. KEEP IN SYNC with the server-side push
 *  gate in proxy/parley/notifications/dispatch.ts (isProgressHeartbeat)
 *  — same predicate, different runtime. */
export function isProgressHeartbeatText(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s) return false;
  // hermes 0.21 shortened the beat to "⏳ Working — N min — iteration i/n,
  // tool"; the older "⏳ Still working… (N min elapsed — …)" still matches.
  // The hermes plugin now converts these into `status` envelopes before
  // they reach us, so this is a compatibility gate for older plugins.
  return /^⏳\s*(Working|Still working)\b/i.test(s)
    || /\bStill working\.{0,3}\s*\(\s*\d+\s*min elapsed\b.*\biteration\s*\d+\s*\/\s*\d+/i.test(s);
}

/** Human label for the working indicator from a raw heartbeat:
 *  "⏳ Working — 3 min — iteration 4/60, terminal" → "Working · 3 min ·
 *  iteration 4/60 · terminal". Empty input → "Thinking". */
export function formatTurnStatus(raw: string): string {
  let s = (raw || '').replace(/^\s*⏳\s*/, '').trim();
  if (!s) return 'Thinking';
  s = s.replace(/…|\.\.\./g, '').replace(/[()]/g, '');
  s = s.replace(/\s+[—–-]\s+/g, ' · ').replace(/,\s+/g, ' · ');
  s = s.replace(/\s+elapsed\b/i, '').replace(/\s{2,}/g, ' ').trim();
  return s.replace(/\s*·\s*$/, '') || 'Thinking';
}
