/**
 * @fileoverview Session lifecycle ops shared between sessionDrawer + proxyClient.
 *
 * Consolidates the cross-module state that needs to agree when a session
 * is deleted, and gives both modules ONE source of truth for "is this id
 * a phantom we just deleted in this tab?"
 *
 * Why this lives here, not in sessionDrawer:
 *   - sessionDrawer owns drawer-render state (cachedSessions, the
 *     switchController focus epoch, etc.). It only needs to know "is this id
 *     deleted?" to filter the visible list.
 *   - proxyClient owns server-side lifecycle (the lastActiveChatId memo,
 *     the conversations IDB row, the sessions endpoint). It needs the
 *     same answer to bail out of `resumeSession` before its own
 *     `setActive(id)` re-pins a chat that was just deleted.
 *   - Putting `recentlyDeleted` on either module forces an awkward import.
 *     A neutral module both can consult is the natural shape.
 *
 * The set is in-memory + scoped to the current tab. A page reload clears
 * it (which is fine — the underlying server-side delete already happened,
 * and the drawer rebuilds from the server's listSessions which won't
 * include the deleted id). Cross-tab signaling isn't needed; each tab
 * tracks its own in-flight click-then-delete races.
 */

const RECENTLY_DELETED_TTL_MS = 5_000;

/** Map id → ts when delete fired. TTL'd to a small window — long enough
 *  to outlast an in-flight click's resumeSession (~100-500ms typical),
 *  short enough that a legitimate cross-device replay of the same id
 *  isn't suppressed indefinitely. */
const recentlyDeleted = new Map<string, number>();

/** Mark `id` as just-deleted. Both `proxyClient.deleteSession` and
 *  `sessionDrawer`'s atomic delete path call this so the OTHER module
 *  can see the flag. */
export function markRecentlyDeleted(id: string): void {
  recentlyDeleted.set(id, Date.now());
}

/** True if `id` was deleted within the TTL window. Self-evicting — a
 *  stale entry returns false and is dropped on read. */
export function isRecentlyDeleted(id: string): boolean {
  const t = recentlyDeleted.get(id);
  if (t === undefined) return false;
  if (Date.now() - t > RECENTLY_DELETED_TTL_MS) {
    recentlyDeleted.delete(id);
    return false;
  }
  return true;
}

/** Lift the tombstone for `id` — the optimistic-delete ROLLBACK path
 *  (server DELETE failed; the row is being restored and must stop
 *  being filtered out of renders). */
export function unmarkRecentlyDeleted(id: string): void {
  recentlyDeleted.delete(id);
}

/** Test seam — clear the set between scenarios so cross-test state
 *  doesn't leak. Production never calls this. */
export function _resetRecentlyDeletedForTests(): void {
  recentlyDeleted.clear();
}

/** Read-only count, primarily for diagnostics + the early-exit fast
 *  path in render filters: `if (size === 0) skip filter`. */
export function recentlyDeletedSize(): number {
  return recentlyDeleted.size;
}

// ── Pending renames ─────────────────────────────────────────────────────
// The optimistic-rename twin of recentlyDeleted (field 2026-07-22: rename
// patched the in-memory row instantly — latency audit A3 — but a list
// response already IN FLIGHT at rename time landed seconds later carrying
// the OLD title and repainted it over the optimistic one until the
// post-rename refresh settled; on a slow link the title visibly reverted
// for seconds, reading as "rename is laggy"). While an entry is fresh,
// every server-derived sessions payload is overlaid with the local title
// before it reaches cachedSessions, so a stale snapshot cannot regress
// the rename. TTL'd so a settle that never happens (tab killed mid-POST)
// self-heals to server truth instead of pinning a phantom title forever.

const PENDING_RENAME_TTL_MS = 60_000;

const pendingRenames = new Map<string, { title: string; ts: number }>();

/** Record an optimistic rename. Cleared on rollback (server refused —
 *  the old title is correct again) or evicted by TTL; a SUCCESSFUL
 *  rename deliberately keeps the entry until TTL so stragglers that
 *  were in flight across the settle still get overlaid. */
export function markPendingRename(id: string, title: string): void {
  pendingRenames.set(id, { title, ts: Date.now() });
}

/** Lift the overlay — the optimistic-rename ROLLBACK path. */
export function unmarkPendingRename(id: string): void {
  pendingRenames.delete(id);
}

/** Overlay fresh pending renames onto a server-derived sessions list.
 *  Returns the same array when nothing is pending (zero-cost fast path
 *  for every ordinary refresh). */
export function overlayPendingRenames<T extends { id: string; title?: string }>(sessions: T[]): T[] {
  if (pendingRenames.size === 0) return sessions;
  const now = Date.now();
  for (const [id, e] of pendingRenames) {
    if (now - e.ts > PENDING_RENAME_TTL_MS) pendingRenames.delete(id);
  }
  if (pendingRenames.size === 0) return sessions;
  return sessions.map((s) => {
    const e = pendingRenames.get(s.id);
    return e ? { ...s, title: e.title } : s;
  });
}

/** Test seam — clear between scenarios. Production never calls this. */
export function _resetPendingRenamesForTests(): void {
  pendingRenames.clear();
}
