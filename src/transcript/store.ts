/**
 * @fileoverview Crack A — per-chat ChatState store. The single source of
 * truth that the projection consumes.
 *
 * Wiring:
 *   - `/v1/conversations/{id}/items` responses call `setDurable` +
 *     `setInflight` for the active chat.
 *   - SSE handlers call `appendInflight` as each envelope arrives.
 *   - Optimistic send path calls `addPendingSend` before posting;
 *     `markPendingSendFailed` on POST error; `clearPendingSend` on
 *     reply_final acknowledgement.
 *
 * Subscribers are notified per-chat. The reconciler subscribes and
 * re-projects + re-renders only when the *active* chat changes — events
 * for background chats mutate state silently so a future switch-back
 * sees the up-to-date model.
 */

import type {
  ChatState,
  ConversationItem,
  Decoration,
  PendingSend,
  ParleyEnvelope,
} from './types.ts';

const states = new Map<string, ChatState>();
const subscribers = new Set<(chatId: string) => void>();

function emptyChatState(): ChatState {
  return {
    durable: [],
    inflight: [],
    pendingSends: [],
    pagination: { firstId: null, hasMore: false, lastId: null, hasMoreNewer: false },
    decorations: [],
    turnStatus: null,
  };
}

/** Pagination as the items endpoint surfaces it. Callers may pass only
 *  the older-cursor half (`firstId`/`hasMore`) — the newer-cursor half
 *  defaults to "tail-anchored" (lastId null, hasMoreNewer false), which
 *  is correct for a normal resume / load-earlier where the loaded run
 *  already reaches the live tail. Only a deep `around` window passes the
 *  newer half explicitly. */
type PaginationInput = {
  firstId: number | null;
  hasMore: boolean;
  lastId?: number | null;
  hasMoreNewer?: boolean;
};

/** Non-creating read. Returns null when no state exists for `chatId` —
 *  callers that must distinguish "hydrated (possibly empty)" from
 *  "never loaded this page-load" use this instead of getState, whose
 *  lazy-create makes absence unobservable. Example: the new-chat no-op
 *  guard on a cold offline resume (boot fetch failed, only the DOM
 *  snapshot is on screen) must not read a never-hydrated chat as
 *  "empty" and swallow the click. */
export function peekState(chatId: string): ChatState | null {
  return states.get(chatId) ?? null;
}

/** Get (and lazily create) the ChatState for `chatId`. Returns a live
 *  reference — callers should NOT mutate it directly; go through the
 *  exported mutators so subscribers fire. */
export function getState(chatId: string): ChatState {
  let s = states.get(chatId);
  if (!s) {
    s = emptyChatState();
    states.set(chatId, s);
  }
  return s;
}

/** Replace durable rows wholesale (typical /messages response). Also
 *  drops inflight envelopes that belong to turns we've already seen
 *  reply_final for — durable is now authoritative for that turn, and
 *  the local envelopes were only useful for the streaming window.
 *
 *  Why: when the plugin's `_write_msg_links_after_turn` fails to link a
 *  state.db row to its SSE-shape parley_id, the projection sees two
 *  keys for the same message — durable's integer-id key and inflight's
 *  umsg_ / msg_ key — and can't dedup them. Result: an "orphan tail"
 *  of duplicate ghost turns at the bottom of the transcript with
 *  synthetic timestamps (entire turns re-appearing at the bottom of
 *  the transcript).
 *
 *  Dropping completed-turn envelopes here breaks the accumulation: the
 *  in-progress turn (no reply_final yet) is preserved for live render. */
export function setDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: PaginationInput,
): void {
  const s = getState(chatId);
  s.durable = items.slice();
  s.pagination = {
    firstId: pagination.firstId,
    hasMore: pagination.hasMore,
    lastId: pagination.lastId ?? null,
    hasMoreNewer: pagination.hasMoreNewer ?? false,
  };
  s.inflight = dropCompletedTurnEnvelopes(s.inflight, s.durable);
  notify(chatId);
}

/** Walk an envelope array and drop completed-turn envelopes whose
 *  reply_final's message_id is present in durable as a `parley_id`.
 *  "Completed" = reply_final has fired; "present in durable" = the
 *  server-side mirror caught up and the projection can dedup off
 *  durable. When the mirror hasn't caught up (e.g. background-chat
 *  reply arrived via SSE but state.db/parley.db write-through
 *  hasn't landed yet), the inflight envelope is the ONLY copy of
 *  the content and we must NOT drop it (e.g.
 *  background-reply-first-switch-shows-content.mjs).
 *
 *  Original motivation (commit 4d2f7dd): plugin's link-table write
 *  silently failed → durable had assistant rows with parley_id
 *  NULL → projection couldn't dedup integer-id durable keys against
 *  SSE-shape inflight keys → ghost-tail of the just-finished turn.
 *  With phase-3 self-heal landed in supplemental store, the NULL
 *  parley_id case is rare; when it still occurs the inflight
 *  envelope stays and the projection's own dedup (text match by
 *  key) handles it.
 */
function dropCompletedTurnEnvelopes(
  envs: ParleyEnvelope[],
  durable: ConversationItem[],
): ParleyEnvelope[] {
  if (envs.length === 0) return envs;
  const durableParleyIds = new Set<string>();
  for (const d of durable) {
    if (d.parley_id) durableParleyIds.add(d.parley_id);
  }
  // Walk from end; find the most recent reply_final whose message_id
  // IS present in durable. Only completed turns whose mirror has
  // landed are safe to drop. Everything earlier (and everything since)
  // stays — the inflight is still the source of truth for those.
  let lastSafeIdx = -1;
  for (let i = envs.length - 1; i >= 0; i--) {
    const e = envs[i];
    if (e.type !== 'reply_final') continue;
    const mid = (e as { message_id?: string }).message_id;
    if (mid && durableParleyIds.has(mid)) {
      lastSafeIdx = i;
      break;
    }
  }
  if (lastSafeIdx < 0) return envs;
  return envs.slice(lastSafeIdx + 1);
}

/** Reconcile a freshly-fetched TAIL page into the buffer WITHOUT discarding
 *  loaded-earlier history. The post-reply durable refresh
 *  (schedulePostFinalDurableRefresh) and the disconnect reconcile both
 *  refetch only the newest page; a wholesale setDurable(tailPage) would
 *  throw away the pages the user scrolled up to load (field bug 2026-06-15:
 *  "scrolled up to find something, the reply landed, the loaded history was
 *  gone"). When the buffer holds rows OLDER than this tail page, keep that
 *  head and splice the authoritative tail onto it; otherwise behave exactly
 *  like setDurable. A gap-bearing buffer (a non-tail-anchored drill window)
 *  replaces — a plain tail refresh can't reason across the gap. */
export function mergeTailRefresh(
  chatId: string,
  tailItems: ConversationItem[],
  tailPagination: PaginationInput,
): void {
  const s = getState(chatId);
  const hasGap = s.durable.some((it) => it.role === 'gap');
  if (s.durable.length === 0 || hasGap || tailItems.length === 0) {
    setDurable(chatId, tailItems, tailPagination);
    return;
  }
  // The tail page is authoritative for everything from its oldest row
  // onward; keep only the strictly-older head and dedup the overlap away.
  const tailMinTs = minNormTs(tailItems);
  const tailIds = itemIdSet(tailItems);
  const head = s.durable.filter(
    (it) => it.role !== 'gap' && normTs(it) < tailMinTs && !isDup(it, tailIds),
  );
  if (head.length === 0) {
    // No loaded-earlier history to protect — identical to a plain replace.
    setDurable(chatId, tailItems, tailPagination);
    return;
  }
  s.durable = head.concat(tailItems);
  // Older cursor stays the buffer's (the head is preserved); newer cursor
  // comes from the tail page (it reaches the live tail).
  s.pagination = {
    firstId: s.pagination.firstId,
    hasMore: s.pagination.hasMore,
    lastId: tailPagination.lastId ?? null,
    hasMoreNewer: tailPagination.hasMoreNewer ?? false,
  };
  s.inflight = dropCompletedTurnEnvelopes(s.inflight, s.durable);
  notify(chatId);
}

/** Prepend older rows from a load-earlier fetch. Only the older-cursor
 *  half (`firstId`/`hasMore`) moves; the newer cursor (lastId/
 *  hasMoreNewer) is untouched — prepending head rows can't change where
 *  the tail of the loaded run sits. */
export function prependDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: { firstId: number | null; hasMore: boolean },
): void {
  const s = getState(chatId);
  // Dedup against the existing buffer — a load-earlier page that overlaps
  // the head (re-fetch, retry, racing merge) must not stack duplicate rows.
  const existingIds = itemIdSet(s.durable);
  const fresh = items.filter(it => !isDup(it, existingIds));
  if (fresh.length) s.durable = fresh.concat(s.durable);
  s.pagination = { ...s.pagination, firstId: pagination.firstId, hasMore: pagination.hasMore };
  notify(chatId);
}

/** Append newer rows from a load-later fetch — the symmetric counterpart
 *  to prependDurable. Only the newer-cursor half (`lastId`/
 *  `hasMoreNewer`) moves; the older cursor is untouched. When
 *  `hasMoreNewer` becomes false the loaded run has reached the live tail,
 *  which is the signal the caller uses to (re)enable IDB persistence for
 *  the now-contiguous-to-tail transcript. */
export function appendDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: { lastId: number | null; hasMoreNewer: boolean },
): void {
  const s = getState(chatId);
  // Dedup against the existing buffer — symmetric to prependDurable.
  const existingIds = itemIdSet(s.durable);
  const fresh = items.filter(it => !isDup(it, existingIds));
  if (fresh.length) s.durable = s.durable.concat(fresh);
  s.pagination = { ...s.pagination, lastId: pagination.lastId, hasMoreNewer: pagination.hasMoreNewer };
  notify(chatId);
}

// ── Gap-aware window splice (issue #227 / #1 missing-bubble) ─────────────
//
// A deep-pin / search drill used to REPLACE the buffer with a floating
// ~40-row `around` window (setDurable, hasMoreNewer=true). That made the
// pin and the live tail MUTUALLY EXCLUSIVE: jumping back to the bottom
// re-fetched, and a non-overlapping merge could splice a SILENT hole
// (the #223 / missing-user-bubble class). spliceWindow instead inserts
// the window ALONGSIDE the existing tail with an explicit `role:'gap'`
// marker at the discontinuity, so:
//   - the tail stays in the buffer (scroll-to-bottom is instant), and
//   - the missing range is VISIBLE as a tappable "…" the user can load.

export type SpliceResult = 'replaced' | 'merged' | 'spliced' | 'noop';

/** Splice a drill `around` window into the buffer next to the existing
 *  run, marking any discontinuity with a gap row. See block comment above.
 *
 *  - Empty buffer → straight replace (floating window).
 *  - Window already fully present → no-op (idempotent: the cache-paint and
 *    server-reconcile passes of one drill both call this with the same
 *    window; the second must not double-splice or revert the splice).
 *  - Buffer already carries a gap (a PRIOR spliced window) → replace; v1
 *    supports ONE window spliced alongside the tail.
 *  - Window overlaps the existing run → contiguous merge (no gap).
 *  - Window disjoint → splice with a gap marker between the two runs. The
 *    older cursor moves to the window's; the tail cursor (lastId/
 *    hasMoreNewer) is KEPT, so the buffer still reaches wherever it did. */
export function spliceWindow(
  chatId: string,
  windowItems: ConversationItem[],
  windowPagination: PaginationInput,
): SpliceResult {
  const s = getState(chatId);
  const realWindow = windowItems.filter(it => it.role !== 'gap');
  if (!realWindow.length) return 'noop';

  if (s.durable.length === 0) {
    s.durable = realWindow.slice();
    s.pagination = fullPagination(windowPagination);
    s.inflight = dropCompletedTurnEnvelopes(s.inflight, s.durable);
    notify(chatId);
    return 'replaced';
  }

  const existingIds = itemIdSet(s.durable);
  if (realWindow.every(it => isDup(it, existingIds))) return 'noop';

  if (s.durable.some(it => it.role === 'gap')) {
    s.durable = realWindow.slice();
    s.pagination = fullPagination(windowPagination);
    s.inflight = dropCompletedTurnEnvelopes(s.inflight, s.durable);
    notify(chatId);
    return 'replaced';
  }

  const fresh = realWindow.filter(it => !isDup(it, existingIds));
  const overlaps = fresh.length < realWindow.length;
  const windowIsOlder = minNormTs(realWindow) <= minNormTs(s.durable);

  if (overlaps) {
    if (windowIsOlder) {
      s.durable = fresh.concat(s.durable);
      s.pagination = { ...s.pagination, firstId: windowPagination.firstId, hasMore: !!windowPagination.hasMore };
    } else {
      s.durable = s.durable.concat(fresh);
      s.pagination = {
        ...s.pagination,
        lastId: windowPagination.lastId ?? s.pagination.lastId,
        hasMoreNewer: !!windowPagination.hasMoreNewer,
      };
    }
    notify(chatId);
    return 'merged';
  }

  // Disjoint: insert a gap marker between the two runs.
  if (windowIsOlder) {
    const olderBoundary = pickByNormTs(fresh, 'max');         // window's newest row
    const newerBoundary = pickByNormTs(s.durable, 'min');     // existing's oldest row
    s.durable = fresh.concat([makeGap(olderBoundary, newerBoundary)], s.durable);
    s.pagination = { ...s.pagination, firstId: windowPagination.firstId, hasMore: !!windowPagination.hasMore };
  } else {
    const olderBoundary = pickByNormTs(s.durable, 'max');     // existing's newest row
    const newerBoundary = pickByNormTs(fresh, 'min');         // window's oldest row
    s.durable = s.durable.concat([makeGap(olderBoundary, newerBoundary)], fresh);
    s.pagination = {
      ...s.pagination,
      lastId: windowPagination.lastId ?? s.pagination.lastId,
      hasMoreNewer: !!windowPagination.hasMoreNewer,
    };
  }
  notify(chatId);
  return 'spliced';
}

/** Shrink — and eventually close — a gap by inserting freshly-fetched rows
 *  at its OLDER edge. `gapAfterId` identifies the gap (its fill cursor).
 *  `rows` is the loadLater(gapAfterId) result; `reachedTail` is true when
 *  the server can no longer page newer. The gap closes once the new rows
 *  connect to the newer-side run (overlap), the fetch is exhausted, or the
 *  server reports no more newer rows; otherwise the gap's cursor advances. */
export function fillGap(
  chatId: string,
  gapAfterId: number,
  rows: ConversationItem[],
  reachedTail: boolean,
): void {
  const s = getState(chatId);
  const gi = s.durable.findIndex(
    it => it.role === 'gap' && Number(it.gap_after_id) === Number(gapAfterId),
  );
  if (gi < 0) return;
  const gap = s.durable[gi];
  const before = s.durable.slice(0, gi);
  const after = s.durable.slice(gi + 1);
  const existingIds = itemIdSet(before.concat(after));
  const incoming = (rows || []).filter(it => it.role !== 'gap');
  const fresh = incoming.filter(it => !isDup(it, existingIds));
  const afterIds = itemIdSet(after);
  const connected = incoming.some(it => isDup(it, afterIds)) || reachedTail || incoming.length === 0;
  if (connected) {
    s.durable = before.concat(fresh, after);
  } else {
    const lastFetched = fresh[fresh.length - 1];
    if (lastFetched) {
      gap.gap_older_id = String(lastFetched.parley_id || lastFetched.id);
      gap.gap_after_id = Number(lastFetched.id);
      gap.id = `gapmark_${gap.gap_older_id}_${gap.gap_newer_id ?? ''}`;
    }
    s.durable = before.concat(fresh, [gap], after);
  }
  notify(chatId);
}

function fullPagination(p: PaginationInput): ChatState['pagination'] {
  return {
    firstId: p.firstId,
    hasMore: p.hasMore,
    lastId: p.lastId ?? null,
    hasMoreNewer: p.hasMoreNewer ?? false,
  };
}

function makeGap(olderRow: ConversationItem, newerRow: ConversationItem): ConversationItem {
  const olderId = String(olderRow.parley_id || olderRow.id);
  const newerId = String(newerRow.parley_id || newerRow.id);
  const mid = (normTs(olderRow) + normTs(newerRow)) / 2;
  return {
    id: `gapmark_${olderId}_${newerId}`,
    role: 'gap',
    content: '',
    timestamp: denormTs(mid),
    gap_older_id: olderId,
    gap_newer_id: newerId,
    gap_after_id: Number(olderRow.id),
  };
}

function itemIdSet(items: ConversationItem[]): Set<string> {
  const set = new Set<string>();
  for (const it of items) {
    set.add(String(it.id));
    if (it.parley_id) set.add(it.parley_id);
  }
  return set;
}

function isDup(it: ConversationItem, ids: Set<string>): boolean {
  if (ids.has(String(it.id))) return true;
  if (it.parley_id && ids.has(it.parley_id)) return true;
  return false;
}

/** Mirror of projection.ts normalizeTimestamp — seconds (<1e12) → ms. */
function normTs(it: ConversationItem): number {
  const raw = it.timestamp ?? it.created_at;
  if (raw == null) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

/** Inverse of normTs: pick a raw value that normalizes back to `ms`, so a
 *  synthetic gap timestamp sorts between its two neighbours regardless of
 *  whether they're stored in seconds or ms. */
function denormTs(ms: number): number {
  return ms >= 1e12 ? ms : ms / 1000;
}

function minNormTs(items: ConversationItem[]): number {
  let min = Infinity;
  for (const it of items) { const t = normTs(it); if (t < min) min = t; }
  return min === Infinity ? 0 : min;
}

function pickByNormTs(items: ConversationItem[], which: 'min' | 'max'): ConversationItem {
  let best = items[0];
  let bestTs = normTs(best);
  for (const it of items) {
    const t = normTs(it);
    if (which === 'max' ? t > bestTs : t < bestTs) { best = it; bestTs = t; }
  }
  return best;
}

/** Merge inflight envelopes from a /messages response. The local store
 *  may already hold envelopes that arrived via live SSE while the chat
 *  was off-screen; those are AUTHORITATIVE (server is just snapshotting
 *  what it knows). Behavior:
 *
 *  - Input non-empty: replace store.inflight with the input. The server
 *    response is the cold-reconnect snapshot — it tells us what to show
 *    fresh.
 *  - Input empty: KEEP existing store.inflight. The proxy omits the
 *    field when it has nothing to send, but our local stream may have
 *    captured envelopes the server already drained from TurnBuffer.
 *    Trying to overwrite with `[]` here was the Bug A regression
 *    (switch-back wiped the in-flight turn we'd accumulated locally).
 *
 *  Callers that want unconditional drain use clearInflight(). */
export function setInflight(chatId: string, envelopes: ParleyEnvelope[]): void {
  const s = getState(chatId);
  if (!envelopes.length) {
    // Nothing to merge in; preserve what live SSE captured.
    return;
  }
  s.inflight = envelopes.slice();
  notify(chatId);
}

/** Append a single envelope (live SSE). The projection orders by
 *  array index; envelopes for unfrozen turns should arrive in
 *  user_message → tool_call/result → reply_delta → reply_final order. */
export function appendInflight(chatId: string, env: ParleyEnvelope): void {
  const s = getState(chatId);
  s.inflight.push(env);
  // A turn-ending final retires the working indicator; an interim
  // advisory (inactivity warning) does not.
  if (env.type === 'reply_final' && !env.interim) s.turnStatus = null;
  notify(chatId);
}

/** Record (or clear, with null) the chat's live heartbeat text — the
 *  `status` envelope the hermes plugin derives from the gateway's
 *  "⏳ Working — …" pulse. The projection turns it into the turn-status
 *  line at the bottom of the transcript. */
export function setTurnStatus(chatId: string, text: string | null): void {
  const s = getState(chatId);
  const next = text ? { text, at: Date.now() } : null;
  if (!next && !s.turnStatus) return;
  s.turnStatus = next;
  notify(chatId);
}

/** Drain inflight envelopes — typically called after reply_final once
 *  the next /messages fetch lands and absorbs the turn into durable. */
export function clearInflight(chatId: string): void {
  const s = getState(chatId);
  if (!s.inflight.length) return;
  s.inflight = [];
  notify(chatId);
}

/** Drain inflight envelopes through one completed reply_final. This is
 *  stricter than clearInflight(): if the user starts another turn
 *  before the post-final durable refresh lands, envelopes after this
 *  reply_final survive. */
export function clearInflightThroughReplyFinal(chatId: string, messageId: string): void {
  if (!messageId) return;
  const s = getState(chatId);
  if (!s.inflight.length) return;
  const idx = s.inflight.findIndex((e) =>
    e.type === 'reply_final' && (e as { message_id?: string }).message_id === messageId,
  );
  if (idx < 0) return;
  s.inflight = s.inflight.slice(idx + 1);
  notify(chatId);
}

/** Add an optimistic user send. Dedup'd by messageId. */
export function addPendingSend(chatId: string, send: PendingSend): void {
  const s = getState(chatId);
  if (s.pendingSends.find(p => p.messageId === send.messageId)) return;
  s.pendingSends.push(send);
  notify(chatId);
}

/** Update the text of an in-flight pending send. Used by the live
 *  dictation streaming bubble — as the WebRTC bridge emits new
 *  interim transcripts, the bubble's text grows. */
export function updatePendingSend(chatId: string, messageId: string, text: string): void {
  const s = getState(chatId);
  const p = s.pendingSends.find(p => p.messageId === messageId);
  if (!p) return;
  if (p.text === text) return;
  p.text = text;
  notify(chatId);
}

/** Read a pending send (e.g. to restore attachments on Retry). */
export function getPendingSend(chatId: string, messageId: string): PendingSend | null {
  const s = getState(chatId);
  return s.pendingSends.find(p => p.messageId === messageId) ?? null;
}

export function markPendingSendFailed(chatId: string, messageId: string): void {
  const s = getState(chatId);
  const p = s.pendingSends.find(p => p.messageId === messageId);
  if (!p) return;
  p.failed = true;
  notify(chatId);
}

export function clearPendingSend(chatId: string, messageId: string): void {
  const s = getState(chatId);
  const i = s.pendingSends.findIndex(p => p.messageId === messageId);
  if (i < 0) return;
  s.pendingSends.splice(i, 1);
  notify(chatId);
}

/** Drop all state for a chat. Used on session deletion. */
/** UPSERT an owner-scoped decoration (system line, memo card). Keyed —
 *  a replay can't duplicate it, a repaint can't orphan it (hardening
 *  phase 4; previously these were keyless DOM appends the reconciler
 *  had to preserve by exception). Upsert-by-key makes re-seeding
 *  (boot restore, view-commit reseed) idempotent. */
export function addDecoration(chatId: string, deco: Decoration): void {
  const s = getState(chatId);
  const idx = s.decorations.findIndex(d => d.key === deco.key);
  s.decorations = idx >= 0
    ? [...s.decorations.slice(0, idx), deco, ...s.decorations.slice(idx + 1)]
    : [...s.decorations, deco];
  notify(chatId);
}

/** Remove a decoration by key (memo sent/discarded). No-op when the
 *  key isn't present. */
export function removeDecoration(chatId: string, key: string): void {
  const s = getState(chatId);
  const next = s.decorations.filter(d => d.key !== key);
  if (next.length === s.decorations.length) return;
  s.decorations = next;
  notify(chatId);
}

export function clearAll(chatId: string): void {
  states.delete(chatId);
  notify(chatId);
}

/** Subscribe to per-chat state changes. The callback fires AFTER every
 *  mutator; the reconciler decides whether the change is for the
 *  currently-viewed chat and re-renders. Returns an unsubscribe fn. */
export function subscribe(fn: (chatId: string) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function notify(chatId: string): void {
  for (const fn of subscribers) {
    try { fn(chatId); } catch (e) { console.error('[transcript-store] subscriber threw:', e); }
  }
}
