import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';
import { isProgressHeartbeatText } from '../util/progressHeartbeat.ts';
import { ServerBackedStore } from '../util/serverBackedStore.ts';
import { isDurableMessageKey } from '../transcript/keys.ts';

export type ActivityKind = 'approval' | 'cron' | 'agent_reply' | 'notification';
export type ActivityResolution = 'approved' | 'approved_session' | 'denied' | 'dismissed' | 'stale';

export interface ActivityItem {
  id: string;
  chatId: string | null;
  kind: ActivityKind;
  title: string;
  body: string;
  createdAt: number;
  urgent: boolean;
  read: boolean;
  messageId?: string | null;
  resolved?: ActivityResolution;
}

const STORAGE_KEY = 'parley.activity.items.v1'; // server-owned mirror — renamed w/o migration, rebuilds

function normalizeItem(x: any): ActivityItem | null {
  if (!x || typeof x.id !== 'string' || !x.id) return null;
  const rawCreated = typeof x.createdAt === 'number' ? x.createdAt : Date.now();
  return {
    id: x.id,
    chatId: typeof x.chatId === 'string' ? x.chatId : null,
    kind: normalizeKind(x.kind),
    title: typeof x.title === 'string' ? x.title : 'Notification',
    body: typeof x.body === 'string' ? x.body : '',
    // Backend stores created_at in Unix seconds; PWA-local + persisted
    // values are already JS milliseconds. Values < 10^10 are seconds —
    // promote to ms. ms-valued data is > 10^10 so it passes through
    // untouched, which is why this same normalizer is safe for BOTH the
    // server snapshot AND the localStorage cache.
    createdAt: rawCreated < 10_000_000_000 ? rawCreated * 1000 : rawCreated,
    urgent: x.urgent === true,
    read: x.read === true,
    messageId: typeof x.messageId === 'string' ? x.messageId : null,
    resolved: normalizeResolution(x.resolved),
  };
}

function payloadForServer(item: ActivityItem): Record<string, unknown> {
  return {
    id: item.id,
    chat_id: item.chatId,
    kind: item.kind,
    title: item.title,
    body: item.body,
    created_at: item.createdAt / 1000,
    urgent: item.urgent,
    read: item.read,
    message_id: item.messageId || null,
    resolved: item.resolved || null,
  };
}

const store = new ServerBackedStore<ActivityItem>({
  storageKey: STORAGE_KEY,
  endpoint: '/api/parley/activity?limit=200',
  fetchInit: { cache: 'no-store' },
  extract: (data) => (Array.isArray(data?.items) ? data.items : []),
  parse: normalizeItem,
  idOf: (item) => item.id,
  changeEvent: 'parley:activity-changed',
  serverChangeEvent: 'parley:server-activity-changed',
  debounceMs: 150,
  persistCap: 200,
  persistSort: (a, b) => b.createdAt - a.createdAt,
  log: (m) => log(`[activity] ${m}`),
  reconcile: (next, current, ctx) =>
    reconcileActivity(next, current, ctx, (path, body) => void store.postJson(path, body)),
  onFirstHydrate: () => {
    // Periodic stale-approval check (every 60s). Production threshold is
    // 30 min; the tick interval is much smaller so a freshly-staled
    // approval ages out within a minute, not whenever the user next opens
    // the tray. Safe to start once at hydrate.
    if (typeof window !== 'undefined' && typeof setInterval === 'function') {
      setInterval(runApprovalStaleCheck, 60_000);
      // Test seams: exposed on window so the smoke can drive the check
      // deterministically (set a small threshold + fire the check now).
      (window as any).__parleySetApprovalStaleMsForTest = setApprovalStaleMsForTest;
      (window as any).__parleyRunApprovalStaleCheckForTest = runApprovalStaleCheck;
    }
  },
});

export function hydrate(): void {
  store.hydrate();
}

export function refreshFromServer(): Promise<void> {
  return store.refreshFromServer();
}

/** Server-write callback for the pure reconcile helpers — injected so unit
 *  tests can capture the POSTs instead of hitting the module singleton. */
export type ActivityPost = (path: string, body: Record<string, unknown>) => void;

/** Domain reconcile for the activity snapshot (pure over `post`; exported
 *  for deterministic unit tests of its preconditions). */
export function reconcileActivity(
  next: Map<string, ActivityItem>,
  current: Map<string, ActivityItem>,
  ctx: { firstServerHydrate: boolean },
  post: ActivityPost,
): 'skip' | void {
  // Preserve freshly-arrived, still-unresolved approvals the server
  // snapshot doesn't know about yet. A pending approval is added to the
  // local store SYNCHRONOUSLY by upsertNotification, but its POST to
  // /api/parley/activity is fire-and-forget. The server ALSO emits an
  // `activity_changed` cross-device sync the moment it records the
  // approval, which fires a refresh here. If this GET races ahead of our
  // own POST (or of the server's own write), the snapshot lacks the
  // approval — and the wholesale replace below would wipe the
  // pending/actionable row out from under the user before they can tap
  // Approve/Deny. Carrying the local-only pending approval into `next`
  // keeps the row visible + actionable; the following refresh (after the
  // POST round-trips) reconciles it from the server with consistent
  // state. We only ever carry UNRESOLVED approvals: a resolved/dismissed
  // row lives on the server and reflects normally, so this never
  // resurrects a decided approval.
  for (const [id, item] of current) {
    if (item.kind === 'approval' && !item.resolved && !next.has(id)) {
      next.set(id, item);
    }
  }
  pruneSupersededApprovals(next, post);
  // First server hydrate against an empty server but non-empty local
  // cache = a never-synced profile; push local rows UP and skip the
  // apply so we don't wipe them. The next refresh reconciles.
  if (ctx.firstServerHydrate && next.size === 0 && current.size > 0) {
    for (const item of current.values()) {
      post('/api/parley/activity', payloadForServer(item));
    }
    return 'skip';
  }
}

function pruneSupersededApprovals(items: Map<string, ActivityItem>, post: ActivityPost): void {
  // "Agent moved on" — any unresolved approval that has a newer
  // non-approval item for the same chat gets resolved as 'dismissed'.
  // Marks resolved (not delete) so the user can still see "we asked for
  // approval here, the agent moved past it" in the tray history with a
  // Dismissed pill (2026-05-28 keep-with-pill model).
  const newestByChat = new Map<string, number>();
  for (const item of items.values()) {
    if (!item.chatId || item.kind === 'approval') continue;
    // "⏳ Still working…" progress heartbeats are NOT the agent moving on
    // — they're the pulse of the very turn that's blocked on the approval.
    // The per-event path already knows this (handleReplyFinal's
    // isProgressHeartbeatText gate never upserts them locally), but the
    // hermes plugin persists push-DELIVERED heartbeats as agent_reply
    // Activity rows server-side (_persist_activity_for_push), so they
    // arrive here via the snapshot anyway. Field bug 2026-07-07: opening
    // the tray to ACTION a pending approval fired render →
    // refreshFromServer → this prune, which saw a newer heartbeat row for
    // the chat and dismissed the approval out from under the user while
    // the agent was still blocked. Same predicate as the per-event gate
    // (shared util) so the two paths can never disagree again.
    if (isProgressHeartbeatText(item.body)) continue;
    newestByChat.set(item.chatId, Math.max(newestByChat.get(item.chatId) ?? 0, item.createdAt));
  }
  for (const [id, item] of Array.from(items.entries())) {
    if (item.kind !== 'approval' || item.resolved || !item.chatId) continue;
    const newer = newestByChat.get(item.chatId) ?? 0;
    if (newer > item.createdAt) {
      items.set(id, { ...item, read: true, resolved: 'dismissed' });
      post('/api/parley/activity/resolve', { id, resolution: 'dismissed' });
    }
  }
}

function normalizeKind(kind: unknown): ActivityKind {
  if (kind === 'approval' || kind === 'cron' || kind === 'agent_reply') return kind;
  return 'notification';
}

function normalizeResolution(x: unknown): ActivityResolution | undefined {
  if (x === 'approved' || x === 'approved_session' || x === 'denied' || x === 'dismissed' || x === 'stale') return x;
  return undefined;
}

function titleFor(kind: ActivityKind, chatLabel?: string): string {
  if (kind === 'approval') return chatLabel ? `Approval required · ${chatLabel}` : 'Approval required';
  if (kind === 'cron') return chatLabel ? `Cron · ${chatLabel}` : 'Cron';
  if (kind === 'agent_reply') return chatLabel ? `Reply · ${chatLabel}` : 'Agent reply';
  return chatLabel || 'Notification';
}

export function upsertNotification(args: {
  chatId: string | null;
  kind: string;
  content: string;
  parleyId?: string | null;
  urgent?: boolean;
  chatLabel?: string | null;
}): ActivityItem | null {
  store.hydrate();
  const kind = normalizeKind(args.kind);
  if (kind !== 'approval' && kind !== 'cron' && kind !== 'agent_reply') return null;
  const id = args.parleyId || `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const prev = store.items.get(id);
  const item: ActivityItem = {
    id,
    chatId: args.chatId,
    kind,
    title: prev?.title || titleFor(kind, args.chatLabel || undefined),
    body: args.content || prev?.body || '',
    createdAt: prev?.createdAt || Date.now(),
    urgent: args.urgent === true || kind === 'approval',
    read: prev?.read ?? false,
    messageId: args.parleyId || prev?.messageId || null,
    resolved: prev?.resolved,
  };
  store.items.set(id, item);
  store.commit();
  void store.postJson('/api/parley/activity', payloadForServer(item));
  return item;
}

export function listActivity(): ActivityItem[] {
  store.hydrate();
  return Array.from(store.items.values()).sort((a, b) => {
    const au = a.kind === 'approval' && !a.resolved ? 1 : 0;
    const bu = b.kind === 'approval' && !b.resolved ? 1 : 0;
    if (au !== bu) return bu - au;
    return b.createdAt - a.createdAt;
  });
}

export function unresolvedApprovalCount(): number {
  store.hydrate();
  let n = 0;
  for (const item of store.items.values()) {
    if (item.kind === 'approval' && !item.resolved) n++;
  }
  return n;
}

export function unreadActivityCount(): number {
  store.hydrate();
  let n = 0;
  for (const item of store.items.values()) {
    if (!item.read && !item.resolved) n++;
  }
  return n;
}

export function markRead(id: string): void {
  store.hydrate();
  const item = store.items.get(id);
  if (!item || item.read) return;
  const next = { ...item, read: true };
  store.items.set(id, next);
  store.commit();
  void store.postJson('/api/parley/activity', payloadForServer(next));
}

/** Flip a specific message back to unread in the activity tray. Used by the
 *  per-message "Mark unread" caret action: the user glanced at a reply but
 *  can't action it yet and wants it to resurface as a "New" tray row.
 *
 *  If an activity item already exists for this message (its `id` is the
 *  message's parley id for agent_reply rows) we just clear `read`.
 *  Otherwise we synthesize an `agent_reply` row so the message HAS a tray
 *  presence to come back to — e.g. a reply that arrived while the chat was
 *  focused never became a notification, so no row exists yet. */
export function markUnreadForMessage(args: {
  chatId: string | null;
  messageId: string;
  text?: string;
  createdAt?: number;
  chatLabel?: string | null;
}): void {
  store.hydrate();
  const id = args.messageId;
  if (!id) return;
  // This morning's field bug (projection.ts's own comment: "mark-unread
  // wrote an activity row keyed pending:turn:*") happened at exactly
  // this write — a synthetic bubble key (the thinking-dots placeholder,
  // the bottom turn-status line, …) persisted as an activity target
  // that `around=<messageId>` (prewarmActivityWindows,
  // src/sessionResume.ts) can never resolve server-side. chat.ts's
  // "Mark unread" menu item is gated the same way; this is the
  // structural backstop for every caller.
  if (!isDurableMessageKey(id)) {
    log(`[activity] refusing to mark-unread synthetic key chat=${args.chatId} messageId=${id}`);
    return;
  }
  const prev = store.items.get(id);
  const item: ActivityItem = prev
    ? { ...prev, read: false, resolved: undefined }
    : {
        id,
        chatId: args.chatId,
        kind: 'agent_reply',
        title: titleFor('agent_reply', args.chatLabel || undefined),
        body: args.text || '',
        createdAt: args.createdAt || Date.now(),
        urgent: false,
        read: false,
        messageId: id,
        resolved: undefined,
      };
  store.items.set(id, item);
  store.commit();
  void store.postJson('/api/parley/activity', payloadForServer(item));
}

export function dismissApprovalsForChat(chatId: string): void {
  store.hydrate();
  if (!chatId) return;
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.chatId !== chatId || item.kind !== 'approval' || item.resolved) continue;
    store.items.delete(id);
    changed = true;
    void store.trackWrite(() =>
      fetch(apiUrl(`/api/parley/activity/${encodeURIComponent(id)}`), { method: 'DELETE' }),
    ).catch(() => {});
  }
  if (changed) store.commit();
}

/** Mark every unresolved approval for `chatId` as resolved with the given
 *  outcome. Replaces the destructive `dismissApprovalsForChat` on every
 *  caller that knows the outcome: user-action paths pass 'approved' /
 *  'approved_session' / 'denied'; the "agent moved on" path passes
 *  'dismissed'; the stale-check path passes 'stale'. Resolved approvals
 *  STAY in the tray with their outcome pill — the row is the user-visible
 *  audit trail of "what I (or the agent) decided, and when." */
export function resolveApprovalsForChat(chatId: string, resolution: ActivityResolution): void {
  store.hydrate();
  if (!chatId) return;
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.chatId !== chatId || item.kind !== 'approval' || item.resolved) continue;
    store.items.set(id, { ...item, read: true, resolved: resolution });
    changed = true;
    void store.postJson('/api/parley/activity/resolve', { id, resolution });
  }
  if (changed) store.commit();
}

/** Stale-approval auto-resolution. Production threshold = 30 minutes;
 *  smokes override via `setApprovalStaleMsForTest`. Resolves any unresolved
 *  approval whose `createdAt` is older than the threshold to 'stale' so
 *  the tray doesn't accumulate forgotten pending approvals. Sticky once
 *  resolved (won't re-pend on later chat activity — `item.resolved` gate
 *  in `resolveApprovalsForChat` and elsewhere). */
const APPROVAL_STALE_MS_DEFAULT = 30 * 60 * 1000;
let approvalStaleMs = APPROVAL_STALE_MS_DEFAULT;

export function runApprovalStaleCheck(): void {
  store.hydrate();
  const now = Date.now();
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.kind !== 'approval' || item.resolved) continue;
    if (now - item.createdAt < approvalStaleMs) continue;
    store.items.set(id, { ...item, read: true, resolved: 'stale' });
    changed = true;
    void store.postJson('/api/parley/activity/resolve', { id, resolution: 'stale' });
  }
  if (changed) store.commit();
}

/** Test seam: shrink the stale window so smokes finish in seconds, not
 *  30 minutes. Only callable from debug mode. Pairs with the smoke's
 *  `window.__parleySetApprovalStaleMsForTest`. */
export function setApprovalStaleMsForTest(ms: number): void {
  if (typeof ms !== 'number' || !(ms > 0)) return;
  approvalStaleMs = ms;
}

export function markChatRead(chatId: string): void {
  store.hydrate();
  if (!chatId) return;
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.chatId !== chatId || item.read) continue;
    store.items.set(id, { ...item, read: true });
    changed = true;
  }
  if (changed) store.commit();
  void store.postJson('/api/parley/activity/seen', { chat_id: chatId });
}

export function markAllRead(): void {
  store.hydrate();
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.read) continue;
    store.items.set(id, { ...item, read: true });
    changed = true;
  }
  if (changed) store.commit();
  void store.postJson('/api/parley/activity/seen', { all: true });
}

export function resolveActivity(id: string, resolution: ActivityResolution): void {
  store.hydrate();
  const item = store.items.get(id);
  if (!item) return;
  store.items.set(id, { ...item, read: true, resolved: resolution });
  store.commit();
  void store.postJson('/api/parley/activity/resolve', { id, resolution });
}

export function dismissActivity(id: string): void {
  store.hydrate();
  if (!store.items.delete(id)) return;
  store.commit();
  void store.trackWrite(() =>
    fetch(apiUrl(`/api/parley/activity/${encodeURIComponent(id)}`), { method: 'DELETE' }),
  ).catch(() => {});
}

export function clearResolved(): void {
  store.hydrate();
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.resolved || item.read) {
      store.items.delete(id);
      changed = true;
    }
  }
  if (!changed) return;
  store.commit();
}

export function clearDismissible(): void {
  store.hydrate();
  let changed = false;
  for (const [id, item] of Array.from(store.items.entries())) {
    if (item.kind === 'approval' && !item.resolved) continue;
    store.items.delete(id);
    changed = true;
  }
  if (!changed) return;
  store.commit();
  void store.postJson('/api/parley/activity/clear', {});
}
