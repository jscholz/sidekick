/**
 * @fileoverview Session browser — renders the past-conversations list
 * inline inside the sidebar's scroll area. Visibility of the section is
 * gated on the active backend's `capabilities.sessionBrowsing` flag; the
 * sidebar itself is always present (so the new-chat button works even
 * without a browseable history).
 *
 * Contract with main.ts:
 *   init({ onResume })     — wire list item clicks; `onResume` receives
 *                            (id, messages) after the adapter returns a
 *                            transcript so main can clear + replay chat.
 *   refresh()              — re-query the adapter + re-render. Called on
 *                            sidebar expand, after sendMessage/newSession,
 *                            and on resume so the active row stays in sync.
 *   applyCapabilities()    — show/hide the sessions section based on the
 *                            active backend. Called once after connect.
 */

import * as backend from './backend.ts';
import { saveCurrentScrollPosition, cancelAtBottomRepin } from "./chat.ts";
import { flushScrollPosition } from "./chatScrollPositions.ts";
import * as conversations from './conversations.ts';
import * as sessionCache from './sessionCache.ts';
import { log, diag } from './util/log.ts';
import * as status from './status.ts';
import { parseQuery, applyFilter, applyRecordingFilter, defaultRecordingFilter } from './sessionFilter.ts';
import { meetingCountFor, hasMeetings } from './capture/meetingsIndex.ts';
import { getFilter as getStoredFilter, putFilter as putStoredFilter, clearFilter as clearStoredFilter } from './util/filterStore.ts';
import { deleteSelected as bulkDeleteSelected } from './multiSelect.ts';
import { markRecentlyDeleted, unmarkRecentlyDeleted, isRecentlyDeleted, recentlyDeletedSize, markPendingRename, unmarkPendingRename, overlayPendingRenames } from './sessionOps.ts';
import * as badge from './notifications/badge.ts';
import * as composerDrafts from './composerDrafts.ts';
import { escapeHtml } from './util/dom.ts';
import { toast } from './toast.ts';
import { isMuted as isChatMuted, setMuted as setChatMuted } from './notifications/mutes.ts';
import { reportChatSwitch } from './notifications/visibility.ts';
import { unreadFor } from './notifications/badge.ts';
import * as activityStore from './notifications/activityStore.ts';
import { showTranscriptLoading } from './transcript/index.ts';
import { clearEdgeLoader } from './chat.ts';
import * as transcriptStore from './transcript/store.ts';
import * as switchCtl from './switchController.ts';
import type { NavOrigin, SwitchToken } from './switchController.ts';
import * as sessionPins from './sessionPins.ts';
import * as sessionIdentity from './sessionIdentity.ts';
import * as sessionAnnounce from './sessionAnnounce.ts';
import * as settings from './settings.ts';
import { AURA_VOICES, voiceLabel } from './voices.ts';

let onResumeCb: ((tok: switchCtl.SwitchToken, messages: any[], pagination?: { firstId: number | null; hasMore: boolean }, inflight?: any[], targetMessageId?: string) => void) | null = null;

/** Sidebar multi-selection — chat_ids the user has selected via
 *  shift-click (range) or ctrl/cmd-click (toggle). When `size >= 2`
 *  the shell hides the chat surface and shows a stats + bulk-delete
 *  panel (`src/multiSelect.ts`). Plain row clicks clear this set and
 *  resume normally. Esc on document also clears.
 *
 *  Selection cursor (`anchor`) tracks the most recent click so
 *  shift+arrow can extend up/down from there and chained shift+clicks
 *  walk a range. Cleared along with the selection itself. */
const multiSelect = new Set<string>();
let multiSelectAnchor: string | null = null;
let onMultiSelectChangeCb: ((selectedIds: string[]) => void) | null = null;

/** Visible-row order, refreshed on every `renderList` so the keyboard
 *  + range handlers walk the same list the user sees. Set to the
 *  filtered + sorted ids in display order. */
let visibleRowIds: string[] = [];

function emitMultiSelectChange(): void {
  syncMultiSelectClasses();
  syncMultiSelectBodyClass();
  onMultiSelectChangeCb?.(Array.from(multiSelect));
}

/** Ctrl/Cmd-click — toggle a single id in the selection. The active
 *  row is added to the set on the FIRST toggle so the user sees
 *  ">=2 selected" after one modifier-click rather than "1 selected,
 *  going nowhere." Subsequent toggles add/remove individual rows. */
function toggleSelection(id: string): void {
  // First toggle in an empty selection seeds with the currently-
  // active row so the user lands at ">=2 selected" rather than
  // "1 selected, going nowhere." Active row ≠ committed view in
  // some race windows (just-clicked, replay still pending), so
  // mirror the rangeSelect / extendSelectionByKey anchor priority.
  const active = switchCtl.focusedId();
  if (multiSelect.size === 0 && active && id !== active) {
    multiSelect.add(active);
  }
  if (multiSelect.has(id)) multiSelect.delete(id);
  else multiSelect.add(id);
  multiSelectAnchor = id;
  emitMultiSelectChange();
}

/** Shift-click — select the inclusive range from the anchor (or the
 *  active row, if no anchor yet) to `id` in display order. Replaces
 *  the existing selection rather than merging — matches the standard
 *  range-select behavior across file managers / mail clients.
 *  Shift+click again from the new endpoint to grow/shrink the range. */
function rangeSelect(id: string): void {
  // Same anchor priority as the keyboard handler — optimistic
  // (just-clicked) wins over viewed (still-rendered) so a shift-click
  // fired immediately after a plain click anchors against the row
  // the user actually picked.
  const anchor = multiSelectAnchor || switchCtl.focusedId();
  if (!anchor || anchor === id) {
    // Degenerate case (no prior anchor and shift-clicking the active
    // row); fall through to a single-toggle so the click still does
    // SOMETHING. Anchor lands at id for the next shift-click.
    toggleSelection(id);
    return;
  }
  const idx = (x: string) => visibleRowIds.indexOf(x);
  const a = idx(anchor); const b = idx(id);
  if (a < 0 || b < 0) {
    toggleSelection(id);
    return;
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  multiSelect.clear();
  for (let i = lo; i <= hi; i++) multiSelect.add(visibleRowIds[i]);
  multiSelectAnchor = id;
  emitMultiSelectChange();
}

/** Shift+ArrowUp / Shift+ArrowDown — extend the selection one row in
 *  the given direction, advancing the anchor so chained presses keep
 *  growing. `direction` is -1 for up (earlier in display order) or +1
 *  for down. Returns true if the selection changed (so the caller
 *  can preventDefault on the keyboard event). */
function extendSelectionByKey(direction: -1 | 1): boolean {
  if (visibleRowIds.length === 0) return false;
  // Anchor priority: explicit selection cursor > the row the user
  // just clicked (optimistic, set synchronously) > the row currently
  // rendered. optimistic comes BEFORE viewed so a Shift+Arrow fired
  // immediately after a click works against the JUST-clicked row,
  // not the still-rendered prior one.
  const anchor = multiSelectAnchor || switchCtl.focusedId();
  // First key press with no selection — seed with the active row +
  // its neighbor in `direction`.
  if (multiSelect.size === 0) {
    if (!anchor) return false;
    const i = visibleRowIds.indexOf(anchor);
    if (i < 0) return false;
    const j = i + direction;
    if (j < 0 || j >= visibleRowIds.length) return false;
    multiSelect.add(visibleRowIds[i]);
    multiSelect.add(visibleRowIds[j]);
    multiSelectAnchor = visibleRowIds[j];
    emitMultiSelectChange();
    return true;
  }
  // Selection exists — extend from the current anchor.
  const i = anchor ? visibleRowIds.indexOf(anchor) : -1;
  if (i < 0) return false;
  const j = i + direction;
  if (j < 0 || j >= visibleRowIds.length) return false;
  const next = visibleRowIds[j];
  // If `next` is already selected, shrink the range (un-select the
  // old anchor); otherwise grow.
  if (multiSelect.has(next)) {
    multiSelect.delete(anchor!);
  } else {
    multiSelect.add(next);
  }
  multiSelectAnchor = next;
  emitMultiSelectChange();
  return true;
}

export function clearMultiSelect(): void {
  if (multiSelect.size === 0 && multiSelectAnchor === null) return;
  multiSelect.clear();
  multiSelectAnchor = null;
  emitMultiSelectChange();
}

export function getMultiSelect(): string[] {
  return Array.from(multiSelect);
}

function syncMultiSelectClasses(): void {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  listEl.querySelectorAll('li[data-chat-id]').forEach((li) => {
    const id = (li as HTMLElement).dataset.chatId;
    if (id && multiSelect.has(id)) li.classList.add('multiselected');
    else li.classList.remove('multiselected');
  });
}

/** Toggle a body-level class so the rest of the page can disable
 *  native text selection while the user is in multi-select mode.
 *  Without this the drawer ends up in an awkward dual-selection state
 *  (session selected AND text range selected simultaneously). */
function syncMultiSelectBodyClass(): void {
  const cls = 'session-multiselect-active';
  if (multiSelect.size > 0) document.body.classList.add(cls);
  else document.body.classList.remove(cls);
}

/** Document-level keyboard handler — Esc clears the selection, and
 *  Shift+ArrowUp/Down extends. Bound once at init() so it doesn't
 *  stack across re-renders. We listen at the document level rather
 *  than per-row because the user may have focus on the composer or
 *  any other element when they hit a hotkey, and the selection is a
 *  page-wide affordance.
 *
 *  Shift+arrow only fires when there's an active session OR a
 *  selection — otherwise the keypress falls through to whatever the
 *  composer or another control wants to do with it. Esc fires
 *  ONLY when there's a selection, for the same reason (otherwise we
 *  might steal Esc from a future modal). */
let keyboardInstalled = false;
function installSelectionKeyboardListener(): void {
  if (keyboardInstalled) return;
  keyboardInstalled = true;
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Esc — clear selection if one exists; otherwise let the event
    // bubble (composer-blur, modal-close, etc. all have their own
    // Esc handlers).
    if (e.key === 'Escape') {
      if (multiSelect.size > 0) {
        clearMultiSelect();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // Shift+ArrowUp / Shift+ArrowDown — extend selection. Skip when
    // the user is typing in an input (don't steal arrow keys from
    // the composer / filter input). Also bail when ANY other modifier
    // is held — macOS window-tiling is bound to Cmd+Ctrl+Shift+arrow
    // and other OS-level shortcuts overlap similarly; only bare
    // shift+arrow is ours. Without the modifier guards, macOS
    // Cmd+Ctrl+Shift+Up is intercepted instead of tiling the window.
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toUpperCase() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      const direction: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
      if (extendSelectionByKey(direction)) {
        e.preventDefault();
      }
      return;
    }
    // Plain ArrowUp / ArrowDown — navigate sessions. Same input-
    // focus exclusions as the shift+arrow path. Also skip when the
    // user has any modifier we don't handle (alt, ctrl, meta) to
    // leave room for browser shortcuts. Multi-select active = no
    // navigation; the user's mid-selection and arrow keys with
    // shift extend the range.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toUpperCase() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      if (multiSelect.size > 0) return;
      const direction: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
      if (navigateByKey(direction)) {
        e.preventDefault();
      }
      return;
    }
    // Cmd/Ctrl + Backspace (Mac convention) or Cmd/Ctrl + Delete —
    // delete the active session, OR bulk-delete the multi-selection
    // when one is active. Mirrors the row menu's Delete action and
    // the panel's bulk-delete button — same confirm dialog, same
    // backend.deleteSession path. Skip in inputs (composer Backspace
    // with cmd held is "delete word" on some browsers).
    if ((e.key === 'Backspace' || e.key === 'Delete')
        && (e.metaKey || e.ctrlKey)
        && !e.shiftKey && !e.altKey) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toUpperCase() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      if (multiSelect.size > 0) {
        // Bulk path — runs the same confirm + serial-delete the
        // panel button uses. clearMultiSelect happens inside via
        // the onClearCb wiring in main.ts.
        e.preventDefault();
        void bulkDeleteSelected(Array.from(multiSelect));
        return;
      }
      // Single-active path — delete whichever chat the user is
      // viewing right now. Same prompt + DELETE call the row's
      // overflow menu fires.
      const activeId = switchCtl.focusedId();
      if (!activeId) return;
      const row = cachedSessions.find((s) => s.id === activeId)
        || mergePending([]).find((s) => s.id === activeId);
      if (!row) return;
      e.preventDefault();
      void promptDelete(row);
    }
  });
}

/** ArrowUp / ArrowDown — navigate to the prev/next session in the
 *  drawer. Mirrors what a row click does (synchronous .active flip
 *  for instant feedback + async resume), but driven from the
 *  keyboard. Anchored on the currently-active session; clamps at
 *  list boundaries (no wrap — wrapping makes "I'm at the top, hit
 *  up" feel like a drawer-cleared accident).
 *
 *  Returns true if the navigation happened (so the caller can
 *  preventDefault on the keypress event). */
export function navigateSibling(direction: -1 | 1): boolean {
  return navigateByKey(direction);
}

/** Synchronously paint a sidebar row as `.active` (clearing any prior
 *  active row) — instant highlight feedback that doesn't wait for the
 *  async scheduleRefresh repaint. Used by keyboard-nav AND the drill
 *  path so "Open in chat" highlights the target the moment it's clicked,
 *  not after the server transcript fetch returns. No-op if the row isn't
 *  in the (possibly filtered/paginated) list yet — scheduleRefresh will
 *  paint it from the optimistic highlight (switchController) once it
 *  appears. */
function paintActiveRowSync(id: string, opts: { scrollIntoView?: boolean } = {}): void {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  listEl.querySelectorAll('li.active').forEach(el => el.classList.remove('active'));
  const li = listEl.querySelector(`li[data-chat-id="${CSS.escape(id)}"]`);
  if (li) {
    li.classList.add('active');
    if (opts.scrollIntoView) (li as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function navigateByKey(direction: -1 | 1): boolean {
  if (visibleRowIds.length === 0) return false;
  const anchor = switchCtl.focusedId();
  const cur = anchor ? visibleRowIds.indexOf(anchor) : -1;
  // No active session yet — seed at the first/last row instead of
  // doing nothing. Up = last (most-recent-but-not-active is awkward;
  // first row is where the user expects "go to top of list" to land
  // — actually the first visible IS the most-recent so it's fine).
  // Simpler: ArrowDown from no-anchor → first row; ArrowUp from
  // no-anchor → last row.
  let next: number;
  if (cur < 0) {
    next = direction === 1 ? 0 : visibleRowIds.length - 1;
  } else {
    next = cur + direction;
    if (next < 0 || next >= visibleRowIds.length) return false;
  }
  const targetId = visibleRowIds[next];
  // Synchronous .active flip + optimistic-claim — instant feedback that
  // any scheduleRefresh racing the async resume() can't undo.
  paintActiveRowSync(targetId, { scrollIntoView: true });
  switchCtl.setOptimistic(targetId);
  // Arrow-nav is a user gesture — the seen signal fires now, not after
  // the transcript fetch commits.
  noteViewIntent(targetId);
  // Async resume — fetch transcript + render. Same path the click
  // handler uses, so behavior (scroll-save + switch-then-load clear +
  // replay + drawer refresh) is identical to a click; resume() handles
  // the synchronous transcript blank-and-spinner internally.
  resume(targetId, 'keyboard').catch((e: any) => {
    diag(`sessionDrawer: arrow-nav resume failed: ${e?.message || e}`);
  });
  return true;
}

/** Drill into a chat from an OUT-of-chat surface (pin drawer "Open in
 *  chat", activity tray, in-app notification banner) and scroll/flash a
 *  specific message bubble. Routes through the SAME cache-first resume()
 *  the sidebar rows use, so the drill is atomic + instant:
 *
 *   - Synchronously paints the target row `.active` AND claims the
 *     optimistic highlight (switchController) — the highlight flips on
 *     click, not after the
 *     server transcript fetch returns (previously the highlight was
 *     server-gated, flickering back for 3-13s over high-latency links).
 *   - resume() renders from the IDB transcript cache first (instant for a
 *     cached chat — the user's "should be instant if cached" ask), then
 *     reconciles against the server.
 *   - The targetMessageId threads into replaySessionMessages so the
 *     scroll-and-flash fires on the cache render (and again on the server
 *     reconcile if the cache was stale).
 *   - resume()'s generation guard makes this the live navigation: any
 *     background reconcile/post-final-refresh for the chat we're LEAVING
 *     bails at its `getViewed() !== chatId` guard the moment viewed flips,
 *     so it no longer re-fetches the origin transcript or flickers the
 *     highlight back.
 *
 *  Returns the resume promise (resolves once the render settles). */
export function drillTo(id: string, targetMessageId?: string): Promise<void> {
  // Instant highlight — don't wait for the async scheduleRefresh repaint
  // or the server fetch. begin() also claims optimistic focus inside
  // resume(), but painting the row here closes the visible gap.
  paintActiveRowSync(id);
  switchCtl.setOptimistic(id);
  // Tap-time seen-signal, same as the row-click and arrow-nav paths — a
  // drill IS the user choosing to read this chat. Re-enabled 2026-07-22:
  // the tap-time clear was excluded on 2026-07-21 because its timing
  // shift exposed the (pre-existing) depin-vs-reconcile-repin scroll
  // race — the drill's programmatic scroll could land clamped at the
  // bottom while the target bubble was transiently mis-sorted to the
  // tail (live-envelope timestamp, pre-durable-heal), the scroll
  // listener re-latched pinnedToBottom=true from geometry, and the
  // heal's rerender autoScroll then held the viewport at the live edge
  // while the bubble re-sorted up and out of view. That race is now
  // closed at the source: drillScrollTo holds the de-pin through the
  // settle window (chat.holdUnpinnedFor) and re-anchors the target if a
  // late re-sort moves it (sessionResume.ts drillScrollTo settle loop).
  noteViewIntent(id);
  return resume(id, 'drill', targetMessageId).catch((e: any) => {
    diag(`sessionDrawer: drillTo resume failed: ${e?.message || e}`);
  });
}

/** Fired with the leaving chat id at the moment a row click triggers a
 *  chat switch, BEFORE the optimistic active flip. main.ts uses it to
 *  drop empty/abandoned chats from IDB so they don't show up as
 *  orphan "New chat / 0 msgs" rows mid-list. */
let onBeforeSwitchCb: ((leavingId: string | null) => void) | null = null;

/** Fired when the foregrounded session disappears from the server list
 *  (deleted by menu, by a bulk wipe, or by a concurrent process). main.ts
 *  uses it to clear the chat pane and start a fresh conversation so the
 *  user isn't left staring at soft-deleted bubbles. */
let onSessionGoneCb: (() => void) | null = null;

/** Set of session ids ever observed in a server response during this
 *  page's lifetime. Used to distinguish a JUST-CREATED session (never
 *  in the list yet) from a DELETED session (was here, gone now) — only
 *  the latter triggers the stale-foreground clear. Survives across
 *  refresh() calls, reset on full reload (which is fine: the boot
 *  refresh repopulates from the server before any delete can race). */
const lastSeenIds = new Set<string>();

/** Last-known full session list from the server (or cache fallback). The
 *  inline filter operates on THIS — re-rendering re-applies the current
 *  filter without re-fetching from the server. Updated whenever refresh()
 *  successfully resolves the server list. */
let cachedSessions: any[] = [];

/** Sessions announced via the SSE `session-started` event but not yet
 *  reflected in the server's listSessions response. These survive across
 *  refresh() cycles (which would otherwise wipe them when cachedSessions
 *  is replaced by the server fetch) so the row stays visible even when
 *  the user switches to a different session mid-flight. Drained when the
 *  server's listSessions catches up (id appears in cachedSessions) OR
 *  when the entry has been absent from the server response for longer
 *  than PENDING_TTL_MS (catches "chat deleted from another device"
 *  cross-device-stale-pending bug).
 *
 *  Each entry also carries `_addedAt` (client wall-clock at insertion)
 *  so we can age out stale entries without depending on the server-
 *  side started_at timestamp, which can be hours in the past. */
const PENDING_TTL_MS = 60_000;  // 1 min — listSessions polls every 5s
const pendingSessions = new Map<string, any>();

// recentlyDeleted lives in src/sessionOps.ts now — both sessionDrawer
// (here) and proxyClient consult it. See sessionOps.ts for rationale.

/** Merge pending sessions into a base list, prepended, deduped by id.
 *  Used by every render path so the synthesized rows are always present
 *  alongside the server-canonical ones. */
function mergePending(base: any[]): any[] {
  if (pendingSessions.size === 0) return base;
  const baseIds = new Set(base.map(s => s.id));
  const extras: any[] = [];
  for (const [id, row] of pendingSessions) {
    if (!baseIds.has(id)) extras.push(row);
  }
  return extras.length ? [...extras, ...base] : base;
}

/** Current filter input value. Empty = no filter. Persisted to IDB so a
 *  page reload restores the same filter. */
let currentFilter: string = '';

/** Canonical option-filter state (meeting-polish #25; grew out of the
 *  2026-07-09 ◉ meetings lens). The funnel button beside the filter
 *  input ENGAGES it; the "Has recording" option defaults to on, so
 *  engaging narrows the list to sessions with recordings attached.
 *  Deliberately session-local + per-device (module state, never
 *  persisted/synced) — it's a lens, not a mode, and the drawer must
 *  never BOOT filtered. */
const recordingFilter = defaultRecordingFilter();

/** Debounce handles for the filter input. Render: 100ms (instant client-side
 *  re-render over the cached list). Persist: 500ms (IDB). Server: 250ms
 *  (round-trip to backend.search('sessions', ...) for authoritative results
 *  when the cached list might not contain a match — adapters without an
 *  index implementation simply return [] and the cached filter is the
 *  only result). */
let filterRenderTimer: number | null = null;
let filterPersistTimer: number | null = null;
let filterServerTimer: number | null = null;
/** AbortController for the in-flight server filter query. A new keystroke
 *  cancels the previous request so we don't paint stale results over fresh
 *  ones if the older response lands second. */
let filterServerAbort: AbortController | null = null;

// Switch focus state (optimistic highlight, committed view, generation)
// is owned by switchController — see that module's header. Reads come
// straight from switchController (focusedId/viewedId); the only accessor
// kept here is setViewed() below, which layers the view-change side
// effects (badge clear, read-marking, engagement report) over the raw
// switchController write so there is a single source of truth for "which
// switch is current."

/** The session id whose transcript is CURRENTLY RENDERED in the chat pane.
 *  Set by main.ts via setViewed() at every transition: replaySessionMessages,
 *  new-chat (pinned to the freshly-rotated conversationName), and boot
 *  (pinned to the restored snapshot id). Takes priority over the
 *  optimistic highlight and conversationName — the drawer should always
 *  highlight the row the user is actually reading, regardless of what
 *  the adapter thinks its current send-target is (they can diverge e.g.
 *  after a resume where conversationName updated but then the user tapped
 *  another session and the adapter's token got superseded).
 *
 *  Also load-bearing for the renderable-event gates in main.ts
 *  (handleReplyDelta/Final): incoming `conversation` is compared against
 *  switchCtl.viewedId() to decide whether to render. Must stay populated whenever
 *  there's a chat on screen, even one that's not yet persisted. */
export function setViewed(id: string | null) {
  const prev = switchCtl.viewedId();
  switchCtl.setViewed(id);
  applyViewChangedEffects(prev, id);
}

/** Promote a switch token to the committed view WITH the view-changed
 *  side effects — the side-effecting twin of switchCtl.commit (adopted
 *  by hardening Phase 1). Captures `prev` BEFORE the promotion so
 *  prev-sensitive effects (highlight-chip cleanup) still see the chat
 *  being left; a bare commit()-then-setViewed sequence loses it
 *  (setViewed would read the already-promoted pointer — the
 *  highlight-chip regression the Phase-1 suite run caught). Returns
 *  false without side effects when the token is superseded. */
export function commitView(tok: switchCtl.SwitchToken): boolean {
  const prev = switchCtl.viewedId();
  if (!switchCtl.commit(tok)) return false;
  applyViewChangedEffects(prev, tok.id);
  return true;
}

/** The chat viewed immediately BEFORE the current one — the natural
 *  landing spot when the current chat is deleted out from under the
 *  user. Updated at every view commit; only ever read as a candidate
 *  (validated against the live list at use time). */
let previouslyViewedId: string | null = null;

/** The user COMMITTED to viewing this chat — row tap, arrow-nav,
 *  cmdk session pick. Fire the "seen" effects NOW, at the gesture,
 *  not at view-commit-after-fetch: on an uncached chat over a slow link
 *  the commit trails the /messages round trip by seconds, and the
 *  unread chip hanging on after the tap reads as a broken tap (measured
 *  2026-07-21). The tap is the seen signal; the render isn't.
 *
 *  USER-INTENT PATHS ONLY. Programmatic view changes (delete-navigation
 *  fallback landing on the previously-viewed chat, boot landing,
 *  new-chat/meeting-session mints) must NOT call this — landing there
 *  isn't the user choosing to read that chat, so nothing about it
 *  should clear before the chat has actually rendered. Those paths keep
 *  the commit-time-only behavior via the backstop in
 *  applyViewChangedEffects below (pre-existing, unchanged).
 *
 *  Both calls are synchronous local-first flips (badge applyLocal +
 *  activity store commit); the server POSTs settle behind. */
export function noteViewIntent(id: string): void {
  if (!id) return;
  void badge.clearUnread(id);
  activityStore.markChatRead(id);
}

function applyViewChangedEffects(prev: string | null, id: string | null): void {
  if (prev && prev !== id) previouslyViewedId = prev;
  // Switching INTO a chat is the "user has now seen this" signal.
  // User-gesture paths already cleared at tap time via noteViewIntent;
  // this commit-time repeat is the idempotent backstop that also covers
  // programmatic landings (boot, delete-navigation) once they actually
  // render — the pre-2026-07-21 behavior, unchanged.
  if (id) {
    badge.clearUnread(id);
    activityStore.markChatRead(id);
  }
  // Also tell the proxy: the user is now actively viewing this chat.
  // Drives the dispatch gate's 2s engagement window so push doesn't
  // fire for envelopes arriving on the chat the user is right here
  // looking at.
  reportChatSwitch(id);
  // Drop any message-select highlight + its hint chip when the user
  // navigates away from the chat that had a highlighted bubble. The
  // bubble itself is about to be detached from the DOM; without this,
  // the chip stays visible against an irrelevant transcript.
  if (prev !== id) {
    void import('./transcriptHighlight.ts').then((m) => m.clearHighlight?.());
  }
  // Per-chat composer drafts ride the same view-commit seam: save the
  // outgoing chat's text, restore the incoming chat's draft. Internally
  // bound-chat-guarded, so same-chat repaints (view-token resumes) are
  // free.
  composerDrafts.switchTo(id);
  // Broadcast the commit for decoupled per-chat state owners (memo
  // outbox reseeds its pending-card decorations for the incoming chat —
  // a clearAll'd ChatState loses decorations, and unlike durable rows
  // they can't be refetched from the server).
  if (prev !== id && id) {
    try { window.dispatchEvent(new CustomEvent('parley:view-committed', { detail: { chatId: id } })); } catch { /* noop */ }
  }
  // DERIVED-VIEW NOTIFY (structural contract, 2026-07-13): the sidebar
  // is a pure function of local state, re-derived synchronously at
  // every view commit — never gated on a refresh/IDB/network sync.
  // This ONE unconditional call replaced the per-case repaint
  // choreography (placeholder-present gates and friends) that kept
  // producing whack-a-mole lag reports: renderListFiltered's two-tier
  // diff makes it budget-free (rows unchanged + active moved = two
  // class toggles; placeholder appear/disappear flips the rows print
  // and rebuilds). The async refresh still reconciles server truth
  // behind it.
  {
    const listEl = document.getElementById('sessions-list');
    if (listEl) renderListFiltered(listEl, activeRowId());
  }
}

/** The id refresh()/renderList should paint as `.active`: optimistic
 *  (a switch in flight) → committed view → the adapter's send-target. */
function activeRowId(): string {
  return switchCtl.focusedId() || backend.getCurrentSessionId?.() || '';
}

/** Time-bucket label a session's row is grouped under in the drawer.
 *
 *  Boundaries are CALENDAR-relative, not rolling: at 00:30 a message from
 *  23:50 belongs under "Yesterday" even though it is forty minutes old,
 *  which is how a human reads a list of days. A rolling 24h window would
 *  file it under "Today" and put it above things that genuinely happened
 *  today.
 *
 *  "This week" / "Last week" are rolling 7-day spans off the start of
 *  today rather than true ISO weeks: a calendar week collapses to nothing
 *  on a Monday morning, so the divider would flicker in and out depending
 *  on which day you opened the app. */
function bucketFor(epochSec: number): string {
  if (!epochSec) return 'Older';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const t = epochSec * 1000;
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - DAY) return 'Yesterday';
  if (t >= startOfToday - 7 * DAY) return 'This week';
  if (t >= startOfToday - 14 * DAY) return 'Last week';
  return 'Older';
}

function renderBucketHeader(label: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'sess-bucket';
  li.textContent = label;
  // No data-chat-id: every row walk in this module keys off
  // `li[data-chat-id]` or an explicit class, so a header is inert to
  // keyboard nav, multi-select and the active-row patch by construction.
  return li;
}

function fmtRelativeTime(epochSec: number): string {
  if (!epochSec) return '';
  const delta = Date.now() / 1000 - epochSec;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Cache-first render: paint from IDB immediately, then background-refresh
 *  from server. The list query on the server is a SQL join across two
 *  databases and was taking 5-10s on the first tap — unacceptable for a
 *  drawer that's meant to feel instant. With the cache, the first tap
 *  paints in <100ms and the server fetch reconciles afterwards. */

/** Trailing-edge coalesce window for refresh(). Multiple call sites
 *  (resume cache-cb, resume server-cb, replaySessionMessages, sendMessage,
 *  newSession) can fire refresh() within a few ms; without coalescing
 *  the drawer rebuilds its <ul> N times per click and visibly flickers.
 *  50ms balances "user perceives instant" vs "swallows the triple-fire
 *  per click."
 *
 *  Use scheduleRefresh() from internal call sites that just want
 *  eventually-consistent state. Use refresh() directly for
 *  user-initiated paths (delete, rename, filter clear, boot) where
 *  the user expects an immediate repaint. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;

/** Lightweight repaint of the per-row unread indicator. Walks existing
 *  drawer rows and adds/removes `.unread` + the count chip based on
 *  the badge module's current state. Doesn't trigger a backend fetch —
 *  unread state is pure client-side, no server roundtrip needed.
 *  Wired to the `parley:unread-changed` event by setupUnreadListener
 *  below. */
function repaintUnreadIndicators(): void {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  for (const li of Array.from(listEl.querySelectorAll('li[data-chat-id]'))) {
    const chatId = (li as HTMLElement).dataset.chatId;
    if (!chatId) continue;
    const unread = unreadFor(chatId);
    const existingChip = li.querySelector('.sess-unread-chip');
    if (unread > 0) {
      li.classList.add('unread');
      if (existingChip) {
        existingChip.textContent = unread > 99 ? '99+' : String(unread);
      } else {
        const snippet = li.querySelector('.sess-snippet');
        if (snippet) {
          const chip = document.createElement('span');
          chip.className = 'sess-unread-chip';
          chip.textContent = unread > 99 ? '99+' : String(unread);
          snippet.appendChild(chip);
        }
      }
    } else {
      li.classList.remove('unread');
      if (existingChip) existingChip.remove();
    }
  }
}

let unreadListenerWired = false;
/** Full (fingerprint-gated) list re-render on unread changes — the
 *  in-place chip repaint above CANNOT reorder rows, and unread-first
 *  ordering depends on unread state that hydrates ASYNC after the
 *  first paint (field bug 2026-07-10: the boot render froze recency
 *  order before /unread arrived, so an unread chat deep in the list
 *  got its chip painted at position ~70 — counted by the OS badge,
 *  invisible in the sidebar, AGAIN). renderListFiltered re-sorts; its
 *  fingerprint check makes the no-order-change case a cheap no-op. */
function resortOnUnreadChange(): void {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  renderListFiltered(listEl, activeRowId());
}

function setupUnreadListener(): void {
  if (unreadListenerWired) return;
  unreadListenerWired = true;
  if (typeof window === 'undefined') return;
  window.addEventListener('parley:unread-changed', () => {
    repaintUnreadIndicators();   // instant chip paint (no fetch)
    resortOnUnreadChange();      // ordering catches up (fingerprint-gated)
  });
  // Cross-device delete sync — proxyClient already wiped the IDB row
  // and broadcast this event. Schedule a sidebar refresh so the DOM
  // row drops. Without this, a cross-device delete leaves a straggler
  // row in the sidebar until the next poll.
  window.addEventListener('parley:server-conversation-deleted', () => scheduleRefresh());
  // Draft snippet tracking: composerDrafts debounces this broadcast;
  // the row fingerprint carries draft state, so the refresh no-ops
  // when nothing visible changed.
  window.addEventListener('parley:draft-changed', () => scheduleRefresh());
  // Pin/unpin/reorder repaints the drawer so the pinned region at the
  // top reflects the new set + order. sessionPins emits this after it
  // updates its in-memory order (the PUT to the synced setting is
  // fire-and-forget). Repaint SYNCHRONOUSLY from cachedSessions — going
  // through scheduleRefresh()/refresh() would block the visible reorder
  // behind an in-flight server listSessions (3-4s on a slow link). The
  // pinned set is read from the store, not the server, so the local
  // repaint is fully authoritative.
  window.addEventListener('parley:session-pins-changed', () => repaintSessionsLocal());
  // A nickname/voice edit repaints rows so the nickname chip appears
  // immediately. Local repaint from cachedSessions — no server round-trip.
  window.addEventListener('parley:session-identity-changed', () => repaintSessionsLocal());
}
// Wire at module load — idempotent + no DOM lookup needed (event
// listener attaches on window which exists in the PWA from the start).
setupUnreadListener();

export function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // refresh() self-guards single-flight (and re-arms a trailing tick if
    // one is already running), so the debounced path and the direct
    // poll/visibilitychange callers all funnel through one in-flight gate.
    void refresh();
  }, 50);
}

/** Top-N most-recent sessions get a fire-and-forget message prefetch
 *  the first time refresh() lands a successful server list. Soaks IDB
 *  for "switch from hard refresh into recently-used chat" — without
 *  the warm-up, the first click pays full server latency even though
 *  the cache is empty only by accident of timing. */
const PREFETCH_TOP_N = 8;
let prefetchDone = false;

/** Fetch a session's newest window in the background and merge it into
 *  its cached transcript. `existing` is the (possibly fuller) cache
 *  entry to MERGE into rather than overwrite — a stale cache can hold
 *  deep scroll-back history the newest page doesn't cover, and
 *  clobbering it would re-truncate that loaded history. The background
 *  fetch yields to any in-flight user drill (and does not itself count
 *  as foreground) so it never saturates a high-latency link out from
 *  under an active pin/activity jump. */
async function fetchAndMergeNewestPage(
  id: string,
  existing: sessionCache.CachedMessages | null,
): Promise<void> {
  const r: any = await backend.fetchSessionMessagesBackground(id);
  const page = Array.isArray(r?.messages) ? r.messages : [];
  if (page.length === 0) return;
  // The merge is only safe when the fetched window OVERLAPS the cache:
  // mergeNewestPage is an id-keyed upsert+append with no contiguity
  // check, so splicing a non-overlapping window onto the cached tail
  // leaves a permanent mid-transcript hole that delta resume (#191)
  // can never heal — its after-cursor is already at the new tail.
  // Field bug 2026-06-12: a chat gained 34 rows on another device; the
  // 12-row prefetch window skipped 22 of them (including a user
  // bubble) and the merged cache rendered with the middle missing.
  // String(id) — one chat can mix numeric and ms-timestamp id spaces.
  const cachedIds = new Set((existing?.messages ?? []).map((m: any) => String(m?.id)));
  const overlaps = page.some((row: any) => row?.id != null && cachedIds.has(String(row.id)));
  const cacheFuller = !!existing && existing.messages.length > page.length && overlaps;
  const merged = cacheFuller ? sessionCache.mergeNewestPage(existing!.messages, page) : page;
  // This is a tiny prefetch window, not a full newest page. Mark it
  // partial ONLY when older rows exist beyond the window (hasMore) —
  // otherwise the window reached the transcript start and IS the
  // complete history, safe for delta resume (#191) to use as a tail
  // cursor. Marking a complete small chat partial needlessly forces a
  // full-page refetch on switch-back.
  const pagination = cacheFuller
    ? existing!.pagination
    : { firstId: r.firstId ?? null, hasMore: !!r.hasMore, partial: !!r.hasMore };
  const capped = sessionCache.capTranscript(merged, pagination);
  await sessionCache.putMessagesCache(id, capped.messages, capped.pagination);
}

async function warmPrefetch(top: any[]): Promise<void> {
  for (const s of top) {
    if (!s?.id) continue;
    // Skip if a fresh cache entry already exists (resume() may have
    // populated it just now). Cheap probe: 60s freshness window.
    let existing: sessionCache.CachedMessages | null = null;
    try {
      existing = await sessionCache.getMessagesCache(s.id);
      if (existing && Date.now() - existing.updatedAt < 60_000) continue;
    } catch { /* keep going on errors */ }
    try {
      await fetchAndMergeNewestPage(s.id, existing);
    } catch { /* silent — cache miss path still works on click */ }
  }
}

/** #214 TFC-B: background tail refresh for sessions whose drawer row
 *  shows newer activity than their cached transcript's tail. Without
 *  this, a chat that advanced on another device (or while this tab's
 *  SSE was down) keeps serving its stale cached tail on switch — the
 *  field symptom "session transcripts stale until refresh". The resume
 *  reconcile does eventually fix it, but only AFTER painting the stale
 *  tail and paying the server round trip; this sweep refreshes the
 *  cache while the user is still elsewhere, so the next switch paints
 *  current. */
const STALE_TAIL_TOP_N = 10;
const STALE_TAIL_RETRY_MS = 30_000;
// lastMessageAt is floor()'d server seconds; message timestamps are
// float seconds. Slack absorbs the truncation + activity-vs-message
// timestamp jitter so a freshly-reconciled tail doesn't re-trigger.
const STALE_TAIL_SLACK_SEC = 2;
// Per-chat: the drawer lastMessageAt we last reconciled against. Each
// distinct activity timestamp triggers at most ONE background fetch —
// without this, a lastMessageAt bumped by non-message activity (no new
// rows to advance the tail) would refetch on every list poll.
const staleTailHandled = new Map<string, number>();
const staleTailAttemptAt = new Map<string, number>();
let staleTailSweepRunning = false;

// Chats whose IN-MEMORY transcriptStore is known to be behind the server.
// The TFC-B sweep refreshes a stale chat's IDB cache (fetchAndMergeNewestPage
// → putMessagesCache) but NOT its in-memory durable buffer — so a chat that
// advanced off-screen (other device, or SSE down) has a fresh IDB tail and a
// STALE in-memory tail. The switch-back fast paint reads the in-memory store;
// if it fired here it would paint the stale tail. Marking the chat here makes
// the fast paint skip it and fall back to the (fresh) IDB-cache paint. Cleared
// once a resume re-renders the chat from fresh data (cache/server), which
// brings the in-memory store current again.
const memStaleChats = new Set<string>();

function newestMessageSec(messages: any[]): number | null {
  let max: number | null = null;
  for (const m of messages) {
    const raw = m?.timestamp ?? m?.created_at;
    if (typeof raw !== 'number') continue;
    // < 1e12 → unix seconds (hermes); ≥ 1e12 → ms (openclaw).
    const sec = raw < 1e12 ? raw : raw / 1000;
    if (max == null || sec > max) max = sec;
  }
  return max;
}

async function refreshStaleTails(sessions: any[]): Promise<void> {
  if (staleTailSweepRunning) return;
  staleTailSweepRunning = true;
  try {
    for (const s of sessions.slice(0, STALE_TAIL_TOP_N)) {
      if (!s?.id || typeof s.lastMessageAt !== 'number' || !s.lastMessageAt) continue;
      // The viewed chat's tail is owned by the live SSE pipeline +
      // resume reconcile — refreshing its cache here could fight an
      // in-flight turn.
      if (s.id === switchCtl.viewedId()) continue;
      if ((staleTailHandled.get(s.id) || 0) >= s.lastMessageAt) continue;
      const lastTry = staleTailAttemptAt.get(s.id) || 0;
      if (Date.now() - lastTry < STALE_TAIL_RETRY_MS) continue;
      let cached: sessionCache.CachedMessages | null = null;
      try { cached = await sessionCache.getMessagesCache(s.id); } catch { /* miss */ }
      // Cold cache = warmPrefetch's territory; nothing stale to fix.
      if (!cached || cached.messages.length === 0) continue;
      const tailSec = newestMessageSec(cached.messages);
      if (tailSec == null || s.lastMessageAt <= tailSec + STALE_TAIL_SLACK_SEC) {
        staleTailHandled.set(s.id, s.lastMessageAt);
        continue;
      }
      staleTailAttemptAt.set(s.id, Date.now());
      try {
        await fetchAndMergeNewestPage(s.id, cached);
        staleTailHandled.set(s.id, s.lastMessageAt);
        // The IDB tail is now fresh but the in-memory buffer (if this chat
        // is resident from an earlier visit) is still behind — flag it so
        // switch-back paints from the fresh cache, not the stale memory.
        if (transcriptStore.getState(s.id).durable.length > 0) memStaleChats.add(s.id);
        diag(`sessionDrawer: TFC-B refreshed stale tail for ${s.id} `
          + `(drawer ${s.lastMessageAt}s > cached ${Math.floor(tailSec)}s)`);
      } catch { /* retry next sweep after STALE_TAIL_RETRY_MS */ }
    }
  } finally {
    staleTailSweepRunning = false;
  }
}

/** Single-flight gate over doRefresh(). EVERY caller — the debounced
 *  scheduleRefresh tick, the list poller, the visibilitychange kick, and
 *  external onOpen calls — routes through here so two list reconciles
 *  never run concurrently. A concurrent call re-arms a trailing tick
 *  (so state that changed mid-flight still repaints) and returns. */
export async function refresh() {
  if (refreshInFlight) {
    scheduleRefresh();
    return;
  }
  refreshInFlight = true;
  try {
    await doRefresh();
  } finally {
    refreshInFlight = false;
  }
}

async function doRefresh() {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  if (!backend.capabilities().sessionBrowsing) { listEl.innerHTML = ''; return; }
  // Make sure the filter input exists above the list. Idempotent — once
  // mounted it stays put. Also re-syncs `currentFilter` from the live
  // input value in case the user typed before refresh ever ran.
  ensureFilterInput();
  // Priority: optimistic (click in flight) → viewed (what's on screen) →
  // adapter's conversationName (fallback for fresh state / new chats).
  //
  // 2026-05-04 fix: previously this had viewed → optimistic precedence,
  // which disagreed with every other read site (line 62, 82, 115, 262,
  // 288). Result: a refresh() running during a cache-miss click (any
  // refresh between click-fire and the server fetch resolving) would
  // paint the OLD viewed chat as active, momentarily flickering the
  // sidebar selection back to the previous chat before snapping to
  // the click target when setViewed finally fired. On a cache miss,
  // "click chat A" briefly flickers back to the current chat before
  // settling on A (the highlight lags the click until the server
  // list arrives).
  const active = activeRowId();

  // 1. Render from cache if available.
  const cached = await sessionCache.getListCache();
  if (cached?.sessions?.length) {
    cachedSessions = overlayPendingRenames(cached.sessions);
    renderListFiltered(listEl, active);
  } else {
    listEl.innerHTML = '<li class="sess-empty">Loading…</li>';
    // Raw innerHTML bypasses renderList's fingerprint bookkeeping —
    // WITHOUT invalidating it, a later render whose fingerprint matches
    // the last real paint SKIPS via the diff-bypass and leaves
    // "Loading…" on screen forever (found via the optimistic-delete
    // rollback, but reachable by any cache-empty refresh racing an
    // unchanged list — the historical "drawer stuck on Loading" class).
    lastRowsPrint = null;
  }

  // 2. Background-fetch from server + reconcile.
  try {
    const sessions = await backend.listSessions(50);
    await sessionCache.putListCache(sessions);
    // Pending-rename overlay: a list response that was in flight when
    // the user renamed carries the OLD title — without the overlay it
    // repaints over the optimistic rename (title visibly reverts until
    // the post-rename refresh; field 2026-07-22).
    cachedSessions = overlayPendingRenames(sessions);
    // Drain pending sessions:
    //   1. Server now knows about the id — confirmed; drop the
    //      synthesized row, the persisted row supersedes it.
    //   2. Server doesn't know about the id AND the pending entry has
    //      been here longer than PENDING_TTL_MS — drop it. This
    //      catches "chat deleted from another device" + "agent never
    //      persisted the announced session" cases. Without this drain,
    //      pendingSessions grew unboundedly across cross-device
    //      delete cycles and the local drawer kept showing rows the
    //      server explicitly did not return.
    if (pendingSessions.size) {
      const now = Date.now();
      // Test override — Playwright smokes set window.__TEST_PENDING_TTL_MS__
      // to a small value to verify the aging path without waiting 60s
      // of wall-clock. Production never sees it (no setter in app code).
      const ttl = (typeof window !== 'undefined' && typeof (window as any).__TEST_PENDING_TTL_MS__ === 'number')
        ? (window as any).__TEST_PENDING_TTL_MS__
        : PENDING_TTL_MS;
      for (const [id, row] of Array.from(pendingSessions.entries())) {
        if (sessions.some(s => s.id === id)) {
          pendingSessions.delete(id);
        } else if (typeof row?._addedAt === 'number' && now - row._addedAt > ttl) {
          diag(`sessionDrawer: pending ${id} aged out (${now - row._addedAt}ms, server still doesn't know)`);
          pendingSessions.delete(id);
        }
      }
    }
    // Re-read focus HERE rather than reusing the pre-await `active`
    // snapshot. `backend.listSessions` is an await point: a row switch
    // (begin() → setOptimistic) can land between the cache render above
    // and this post-server repaint. Painting the stale snapshot is what
    // produced the A→B→A highlight bounce on slow links — the list would
    // momentarily re-highlight the chat that was focused when refresh()
    // STARTED, then snap to the live target on the next tick. focusedId()
    // is the live source of truth; read it at paint time.
    renderListFiltered(listEl, activeRowId());

    // Stale-foreground guard: if the chat pane is showing a session
    // that the server no longer knows about (it was deleted by the
    // menu, by a bulk wipe, or by a concurrent process), the chat
    // pane is rendering a ghost. Clear it via onSessionGone so the
    // user lands on a fresh-chat surface instead of staring at
    // soft-deleted bubbles. Skip when the viewed session is just
    // newly-created and not-yet-persisted (covered by isFresh in
    // renderList — if the active id never appears in the cached list
    // either, it's a transient new chat, not a deleted one). The
    // distinguishing signal: was it EVER in cachedSessions during
    // this session of the app? Tracked below via lastSeenIds.
    const viewed = switchCtl.viewedId();
    if (viewed && !sessions.some(s => s.id === viewed)) {
      if (lastSeenIds.has(viewed)) {
        // Was here, isn't here anymore → genuinely deleted.
        diag(`sessionDrawer: viewed session ${viewed} no longer on server, clearing chat`);
        switchCtl.setViewed(null);
        onSessionGoneCb?.();
      }
    }
    for (const s of sessions) lastSeenIds.add(s.id);
    // Boot-time warm-up: prefetch the top N chats' messages into
    // sessionCache so a switch from a hard refresh feels instant on
    // first try. Without this, the very first click on any non-viewed
    // chat after reload pays the full server round-trip (the cache
    // populates only as a side effect of resume()). Fire-and-forget;
    // failures are silent — the cache miss path still works.
    if (!prefetchDone) {
      prefetchDone = true;
      void warmPrefetch(sessions.slice(0, PREFETCH_TOP_N));
    }
    // #214 TFC-B: every successful list reconcile also sweeps for
    // sessions whose server-side activity has moved past their cached
    // tail and refreshes those caches in the background.
    void refreshStaleTails(sessions);
  } catch (e: any) {
    diag(`sessionDrawer: list failed: ${e.message}`);
    if (!cached?.sessions?.length) {
      listEl.innerHTML = `<li class="sess-empty">Failed to load: ${e.message}</li>`;
    }
    // Else: keep the cached view — user can still tap + resume from cache.
  }
}

/** Snapshot of the most recently rendered session list. Exposed for the
 *  cmd+K palette so it can applyFilter() over the same data without
 *  re-fetching. Returns the canonical post-server list when available,
 *  falling back to whatever's in IDB cache. */
export function getCachedSessions(): any[] {
  return cachedSessions.slice();
}

/** Look up the platform source for a chat_id from the cached session
 *  list. Returns 'parley' if not found (sane default — parley is
 *  the primary platform; non-parley rows must come from server data
 *  that's already been fetched). Used by the composer-read-only path
 *  in main.ts: when source !== 'parley', composer is disabled
 *  because cross-platform send isn't supported. */
export function getSourceForChat(id: string | null | undefined): string {
  if (!id) return 'parley';
  const row = cachedSessions.find(s => s.id === id);
  return row?.source || 'parley';
}

/** Look up the display title for a chat_id from the cached session
 *  list. Returns null when the chat isn't in the cache (e.g. a
 *  brand-new chat that arrived via SSE before the drawer refresh
 *  caught up). Used by the in-app notification banner to render a
 *  scannable chat label instead of a UUID prefix. */
export function getTitleForChat(id: string | null | undefined): string | null {
  if (!id) return null;
  const row = cachedSessions.find(s => s.id === id);
  return row?.title || null;
}

/** Server-authoritative reconcile of the cached list against the current
 *  filter. The instant client-side re-render (applyFilter on cachedSessions)
 *  is the snappy first paint; this is the catch-up that surfaces matches
 *  the cache didn't contain. Pulls up to 200 rows under a filter (vs 50
 *  for the unfiltered top-of-list) so deep-history queries return more
 *  than the most recent slice. Empty filter → no-op (the regular refresh()
 *  path already covers the unfiltered case). */
async function runServerFilterReconcile(q: string) {
  // Only abort the in-flight request when there's a CURRENT filter in
  // play — abort-then-skip on an empty query would still leak the old
  // controller. Set up a fresh controller per dispatch.
  if (filterServerAbort) filterServerAbort.abort();
  if (!q.trim()) {
    filterServerAbort = null;
    return;
  }
  // Fast path: backend doesn't implement search → the cached client-side
  // filter is the only result; skip the round trip + leave the in-flight
  // controller cleared. Cheap synchronous capability check, no module load.
  if (!backend.hasSearch()) {
    filterServerAbort = null;
    return;
  }
  const ctl = new AbortController();
  filterServerAbort = ctl;
  try {
    const result = await backend.search(q, 'sessions', { limit: 200, signal: ctl.signal });
    const sessions = result?.sessions || [];
    if (ctl.signal.aborted) return;
    // Race guard: by the time we land, the user may have cleared the
    // filter or typed something different. Drop stale results — the
    // current input handler will dispatch its own reconcile.
    if (q !== currentFilter) return;
    cachedSessions = overlayPendingRenames(sessions);
    await sessionCache.putListCache(sessions);
    const listEl = document.getElementById('sessions-list');
    if (!listEl) return;
    const active = activeRowId();
    renderListFiltered(listEl, active);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`sessionDrawer: server filter reconcile failed: ${e?.message || e}`);
  } finally {
    if (filterServerAbort === ctl) filterServerAbort = null;
  }
}

/** Synchronous drawer repaint from the current cache — no server round
 *  trip. Used by pin/unpin/reorder so the pinned region updates the
 *  instant the store changes, instead of waiting on refresh()'s in-flight
 *  listSessions. No-op if the list element isn't mounted yet. */
function repaintSessionsLocal(): void {
  if (typeof document === 'undefined') return;
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  renderListFiltered(listEl, activeRowId());
}

/** Re-render the visible session list with the current filter applied. */
// ── Tap-gesture rebuild hold (field bug 2026-07: "first click misses")
//
// renderList's full rebuild does innerHTML='' — every <li> replaced.
// If that lands INSIDE a tap gesture (between pointerdown and
// pointerup), the browser cancels the click outright: Chromium drops a
// click whose mousedown target was detached (probed: it fires on
// NOTHING — not the replacement node, not the <ul>, so even event
// delegation can't catch it), and iOS Safari drops the synthesized
// click when the touchstart target is detached. The user's tap simply
// vanishes; the second tap (DOM now stable) works — hence the
// habitual double-tap. Rebuilds cluster exactly around first-tap
// moments: the slow server list landing after the drawer opens, the
// badge refresh landing ~1.5s after foregrounding, unread-first
// re-sorts on any unread change.
//
// The hold: while a pointer is down on a row, destructive rebuilds
// DEFER (in-place patches — .active toggles, unread chips — stay
// live; they don't detach nodes). Released after the gesture's click
// has dispatched (the click-capture listener schedules a 0ms timer,
// which runs on the task AFTER the click's synchronous handlers —so
// the tap's own unread-clear resort also lands after resume() is
// dispatched), with a pointerup/-cancel grace for gestures that never
// produce a click (scroll pans, drags) and a max-hold backstop for
// lost pointerups. Same gesture-yield shape as pinDragActive above /
// chat.ts holdUnpinnedFor.
let tapGestureWired = false;
let tapGestureHeld = false;
let tapGestureRebuildDeferred = false;
let tapGestureReleaseTimer: ReturnType<typeof setTimeout> | null = null;
const TAP_GESTURE_MAX_HOLD_MS = 1_500;      // lost pointerup backstop
const TAP_GESTURE_RELEASE_GRACE_MS = 350;   // pointerup → trailing click window

/** True (and remembers a flush is owed) when a destructive rebuild must
 *  wait for the in-progress row gesture to end. Call at every site that
 *  is about to replace the list's <li> nodes. */
function deferRebuildDuringTapGesture(): boolean {
  if (!tapGestureHeld) return false;
  tapGestureRebuildDeferred = true;
  return true;
}

function releaseTapGestureHold(): void {
  if (tapGestureReleaseTimer != null) {
    clearTimeout(tapGestureReleaseTimer);
    tapGestureReleaseTimer = null;
  }
  if (!tapGestureHeld) return;
  tapGestureHeld = false;
  if (tapGestureRebuildDeferred) {
    tapGestureRebuildDeferred = false;
    // Re-derive from current state rather than replaying stale args —
    // the deferred rebuild may itself be superseded by what the tap
    // changed (unread cleared, optimistic active moved).
    const listEl = document.getElementById('sessions-list');
    if (listEl) renderListFiltered(listEl, activeRowId());
  }
}

function scheduleTapGestureRelease(ms: number): void {
  if (tapGestureReleaseTimer != null) clearTimeout(tapGestureReleaseTimer);
  tapGestureReleaseTimer = setTimeout(() => {
    tapGestureReleaseTimer = null;
    releaseTapGestureHold();
  }, ms);
}

function installTapGestureGuard(listEl: HTMLElement): void {
  if (tapGestureWired) return;
  tapGestureWired = true;
  if (typeof window === 'undefined') return;
  listEl.addEventListener('pointerdown', (ev: Event) => {
    const t = ev.target as HTMLElement | null;
    if (!t?.closest?.('li[data-chat-id]')) return;
    tapGestureHeld = true;
    scheduleTapGestureRelease(TAP_GESTURE_MAX_HOLD_MS);
  }, true);
  // pointerup can land outside the list (drag out and release) and a
  // pan converts to pointercancel — window-level, capture, so the hold
  // always drains. The grace keeps the hold across the up→click gap.
  const endSoon = () => { if (tapGestureHeld) scheduleTapGestureRelease(TAP_GESTURE_RELEASE_GRACE_MS); };
  window.addEventListener('pointerup', endSoon, true);
  window.addEventListener('pointercancel', endSoon, true);
  // The gesture's own click ends the hold — on a FRESH task (0ms timer),
  // so the row's click handler (and the resort its unread-clear
  // triggers) runs to completion first, then the deferred rebuild
  // flushes.
  listEl.addEventListener('click', () => {
    if (tapGestureHeld) scheduleTapGestureRelease(0);
  }, true);
}

function renderListFiltered(listEl: HTMLElement, activeId: string) {
  installTapGestureGuard(listEl);
  // Strip recently-deleted ids before merge. cachedSessions can briefly
  // include a deleted id when an in-flight pre-delete listSessions fetch
  // resolves AFTER our delete + cache patch — its response overwrites
  // the patched cache. Filtering here keeps the deleted id out of the
  // visible drawer until the recentlyDeleted TTL elapses (or until a
  // post-delete listSessions response replaces cachedSessions naturally).
  const base = recentlyDeletedSize() > 0
    ? cachedSessions.filter(s => !isRecentlyDeleted(s.id))
    : cachedSessions;
  // Merge pending (SSE-announced, not-yet-persisted) sessions into the
  // base list before filtering. They survive refresh() cycles so the row
  // stays visible across session-switch even when cachedSessions gets
  // overwritten by the server fetch.
  const merged = mergePending(base);
  const textFiltered = currentFilter
    ? applyFilter(merged, parseQuery(currentFilter))
    : merged;
  // Option filter (has-recording) stacks on top of the text filter.
  const filtered = applyRecordingFilter(textFiltered, recordingFilter, hasMeetings);
  // Empty list under a non-empty filter shows "No matches." instead of
  // the generic "No past sessions yet." so the user knows it's the filter
  // (not an empty server) hiding everything.
  if (filtered.length === 0 && recordingFilter.engaged && recordingFilter.hasRecording && merged.length > 0) {
    if (deferRebuildDuringTapGesture()) return;
    listEl.innerHTML = '<li class="sess-empty">No sessions with recordings yet.</li>';
    return;
  }
  if (filtered.length === 0 && currentFilter && merged.length > 0) {
    if (deferRebuildDuringTapGesture()) return;
    listEl.innerHTML = '<li class="sess-empty">No matches.</li>';
    return;
  }
  // Only show the "new conversation" placeholder when the active session
  // is genuinely missing from the merged list (= brand-new chat that
  // hasn't even hit /v1/responses yet, so no SSE row either). Once the
  // user sends a message, the pending row covers them.
  // Suppress the isFresh placeholder for chats we just deleted in this
  // tab — see recentlyDeleted comment for the click-then-delete race.
  const isFresh = !!activeId
    && !merged.some(s => s.id === activeId)
    && !isRecentlyDeleted(activeId);
  // UNREAD-FIRST ordering (field bug 2026-07-09, by-construction leg 2):
  // the server force-includes unread chats in the window, but a chat at
  // recency position ~70 rendered below the fold — the OS badge counted
  // it while nothing visible showed it. Unread rows now bubble to the
  // top of the unpinned region (stable within each group), so every
  // badge unit has a visible chip. Same accessor as the badge
  // (unreadFor), so the invariant holds for marked-unread too.
  const ordered = [...filtered].sort((a: any, b: any) =>
    (unreadFor(b.id) > 0 ? 1 : 0) - (unreadFor(a.id) > 0 ? 1 : 0));
  renderList(listEl, ordered, activeId, isFresh);
}

/** Fingerprint of the last successful renderList. Compared on every
 *  call; if the (sessions × activeId × placeholder) tuple is unchanged,
 *  we skip the innerHTML='' + N appendChild rebuild — the visible DOM
 *  is already correct. This kills the cache-then-server double-render
 *  in refresh(): if the server returned the same list we just painted
 *  from cache, the second renderList is a no-op. Same for repeated
 *  refresh() calls where nothing meaningfully changed.
 *
 *  TWO-TIER since the derived-view refactor (2026-07-13, Jonathan's
 *  structural call: "all session operations should have a local
 *  instant update, followed by a sync"): the ROWS print (content +
 *  pins + placeholder flag) decides full rebuilds; the active id is
 *  tracked separately and patched IN PLACE when it's the only change —
 *  so notifying on every view commit is budget-free (a plain switch
 *  costs two class toggles, not a 50-row rebuild). */
let lastRowsPrint: string | null = null;
let lastActiveId: string | null = null;

/** Cheap fingerprint of the visible ROW state. Includes the fields
 *  renderRow reads (id, title, snippet, messageCount, lastMessageAt,
 *  source, nickname, draft snippet) plus the placeholder flag + pin
 *  order. Anything not in here can change without us noticing — keep
 *  it broad enough that legitimate updates still trigger a rebuild.
 *  Deliberately EXCLUDES activeId (patched in place). */
function renderListFingerprint(sessions: any[], showPlaceholder: boolean, pinnedOrder: string[]): string {
  const rows = sessions.map(s =>
    `${s.id}|${s.title || ''}|${s.snippet || ''}|${s.messageCount || 0}|${s.lastMessageAt || ''}|${s.source || ''}|${sessionIdentity.nicknameFor(s.id) || ''}`
    // Draft snippet state: appearance/disappearance/edit of a row's
    // "Draft:" line must defeat the diff-bypass (bound chat contributes
    // '' — its row hides the snippet).
    + `|${composerDrafts.boundTo() !== s.id ? composerDrafts.getDraft(s.id).slice(0, 60) : ''}`,
  ).join('\n');
  // Fold the pinned set + order in: a pin/unpin/reorder doesn't change
  // any row's fields or the incoming recency order, so without this the
  // diff-bypass would skip the rebuild and the pinned region wouldn't
  // move.
  return `${showPlaceholder ? 'p' : ''}::pins=${pinnedOrder.join(',')}::${rows}`;
}

/** Tier-2 reconcile: rows unchanged, active id moved — patch the
 *  .active class in place instead of rebuilding. */
function patchActiveRow(listEl: HTMLElement, activeId: string): void {
  listEl.querySelectorAll('li.active').forEach((el) => el.classList.remove('active'));
  if (activeId) {
    try {
      listEl.querySelector(`li[data-chat-id="${CSS.escape(activeId)}"]`)?.classList.add('active');
    } catch { /* malformed id — highlight simply absent until rebuild */ }
  }
}

function renderList(listEl: HTMLElement, sessions: any[], activeId: string, isFresh = false) {
  // Hold off any rebuild while a pinned row is being dragged — see
  // pinDragActive. The drag mutates the DOM order directly; a rebuild
  // here would detach the dragged node mid-gesture. The post-drop
  // setOrder() repaint reconciles to the canonical order once released.
  if (pinDragActive) return;
  // Optimistic placeholder: if the adapter's current session isn't in the
  // cached list yet (brand-new conversation, no turn persisted), show a
  // "New conversation" row at the top so the user has immediate visual
  // feedback that the new-chat click landed. Gets replaced by the real
  // row on the next refresh after a reply lands.
  const showPlaceholder = isFresh;

  // Wire pinned drag-reorder once, lazily, against the stable list
  // element (idempotent — guarded internally).
  installPinnedDragReorder(listEl);

  // Partition into a pinned region (rendered in pin-order at the top,
  // exempt from recency) + the rest (incoming recency order). A pinned id
  // absent from `sessions` — aged out of the recency slice, or filtered
  // out by a search — simply doesn't render here; the store keeps the pin
  // and it reappears when the session re-enters the list.
  const pinnedOrder = sessionPins.listPinned();
  const pinnedSet = new Set(pinnedOrder);
  const byId = new Map(sessions.map((s: any) => [String(s.id), s]));
  const pinnedRows = pinnedOrder.map(id => byId.get(id)).filter(Boolean);
  const restRows = sessions.filter((s: any) => !pinnedSet.has(String(s.id)));

  // Two-tier diff-bypass (derived-view refactor): rows unchanged +
  // active unchanged → nothing to do; rows unchanged + active moved →
  // in-place class patch (this is what makes notifying on EVERY view
  // commit budget-free); rows changed → full rebuild below. refresh()
  // naturally renders twice (cache + server); most pairs reconcile to
  // the same list and the second rebuild is pure flicker.
  const rowsPrint = renderListFingerprint(sessions, showPlaceholder, pinnedOrder);
  if (rowsPrint === lastRowsPrint) {
    if (activeId !== lastActiveId) {
      patchActiveRow(listEl, activeId);
      lastActiveId = activeId;
    }
    return;
  }

  // Rows changed → this call would rebuild (innerHTML='' below). While
  // a pointer is down on a row that would cancel the user's click —
  // defer; the tap-gesture guard flushes a fresh render at gesture end.
  // (The tier-2 active patch above stays live during the hold: class
  // toggles don't detach the node under the finger.)
  if (deferRebuildDuringTapGesture()) return;

  if (sessions.length === 0 && !showPlaceholder) {
    listEl.innerHTML = '<li class="sess-empty">No past sessions yet.</li>';
    lastRowsPrint = rowsPrint;
    lastActiveId = activeId;
    return;
  }
  listEl.innerHTML = '';
  if (showPlaceholder) listEl.appendChild(renderPlaceholderRow(activeId));
  // "Pinned" heads the pinned region, matching the time buckets below so
  // the whole drawer reads as one labelled list rather than an unlabelled
  // block followed by labelled ones. Omitted entirely when nothing is
  // pinned — a header over no rows is just a claim about an empty space.
  if (pinnedRows.length) listEl.appendChild(renderBucketHeader('Pinned'));
  for (const s of pinnedRows) {
    listEl.appendChild(renderRow(s, activeId, true));
  }
  // The hairline that used to sit here is gone: the recency list now
  // opens with its own time-bucket header, so a rule immediately above
  // "Today" separated the two regions twice over.
  // Recency rows carry time-bucket headers. Pinned rows deliberately
  // don't: that region is ordered by the user's pin order and is exempt
  // from recency, so dating it would imply an ordering it doesn't have.
  let lastBucket = '';
  for (const s of restRows) {
    const bucket = bucketFor(s.lastMessageAt);
    if (bucket !== lastBucket) {
      listEl.appendChild(renderBucketHeader(bucket));
      lastBucket = bucket;
    }
    listEl.appendChild(renderRow(s, activeId, false));
  }
  // Refresh the visible-row order cache so range/keyboard handlers
  // walk the same list the user sees — pinned region first, then rest.
  visibleRowIds = [...pinnedRows, ...restRows].map((s: any) => String(s.id));
  // Re-paint multi-select highlights after the rebuild — renderRow
  // doesn't carry over the .multiselected class because each LI is
  // freshly created.
  syncMultiSelectClasses();
  lastRowsPrint = rowsPrint;
  lastActiveId = activeId;
}

function renderPlaceholderRow(id: string): HTMLLIElement {
  const li = document.createElement('li');
  li.classList.add('active', 'sess-placeholder');
  const body = document.createElement('div');
  body.className = 'sess-body';
  const snippet = document.createElement('div');
  snippet.className = 'sess-snippet';
  snippet.textContent = 'New conversation';
  snippet.style.fontStyle = 'italic';
  snippet.style.opacity = '0.7';
  const meta = document.createElement('div');
  meta.className = 'sess-meta';
  meta.innerHTML =
    `<span>just now</span>` +
    `<span>not yet started</span>` +
    `<span style="color:var(--primary)">· current</span>`;
  body.appendChild(snippet);
  body.appendChild(meta);
  li.appendChild(body);
  // Intentionally no click (already active) or menu (nothing to rename/delete
  // until the session is registered server-side).
  return li;
}

function renderRow(s: any, activeId: string, pinned = false): HTMLLIElement {
  const li = document.createElement('li');
  if (s.id === activeId) li.classList.add('active');
  // `.sess-pinned` styles the row as part of the top region and marks it
  // as a drag-reorder target (see drag wiring). The dataset flag lets the
  // pointer handler cheaply tell pinned rows apart without a store lookup.
  if (pinned) {
    li.classList.add('sess-pinned');
    li.dataset.pinned = '1';
  }
  // Per-chat unread indicator — `.unread` adds bold + a count chip
  // (see app.css). Source-of-truth is the in-memory badge map; we
  // re-render on `parley:unread-changed` events so toggling state
  // (push arrival, switch-into-chat) updates instantly without polling.
  const unread = unreadFor(s.id);
  if (unread > 0) li.classList.add('unread');
  // Expose the chat/session id on the li so tests + future code can
  // target rows without depending on title/snippet text (which may be
  // a placeholder until hermes generates the title).
  li.dataset.chatId = s.id;
  // Meeting badge (field 2026-07-09 #7): sessions with recordings get
  // the record glyph; a count when several meetings share the session
  // (the entity model allows it — captures link BY REFERENCE).
  const meetings = meetingCountFor(s.id);
  if (meetings > 0) li.dataset.meetings = String(meetings);

  const row = document.createElement('div');
  row.className = 'sess-row';

  const body = document.createElement('div');
  body.className = 'sess-body';

  const snippet = document.createElement('div');
  snippet.className = 'sess-snippet';
  // A user-assigned nickname (per-session identity) takes visual
  // precedence as a leading chip; the auto title/snippet still follows
  // so the row keeps its conversational context.
  const nick = sessionIdentity.nicknameFor(s.id);
  if (nick) {
    const nickEl = document.createElement('span');
    nickEl.className = 'sess-nickname';
    nickEl.textContent = nick;
    snippet.appendChild(nickEl);
    snippet.appendChild(document.createTextNode(s.title || s.snippet || s.id));
  } else {
    // Prefer user-set title; fall back to snippet; then the id.
    snippet.textContent = s.title || s.snippet || s.id;
  }
  if (unread > 0) {
    const chip = document.createElement('span');
    chip.className = 'sess-unread-chip';
    chip.textContent = unread > 99 ? '99+' : String(unread);
    snippet.appendChild(chip);
  }

  const meta = document.createElement('div');
  meta.className = 'sess-meta';
  // Source badge — shown only for non-parley sessions so telegram/
  // slack/whatsapp/etc rows are visually distinguished from the user's
  // primary parley transcripts. Parley is the default; we don't
  // clutter every row with a redundant "PARLEY" label. (api_server
  // is the legacy hermes-backend default name; preserved here for
  // back-compat with any older entries that still report that source.)
  // No "· current" text — the border highlight from li.active communicates
  // the same thing without adding a 4th meta item that would overflow +
  // wrap the row (changing bubble height when selected).
  const sourceBadge = s.source && s.source !== 'parley' && s.source !== 'api_server'
    ? `<span style="text-transform:uppercase;font-size:10px;letter-spacing:0.05em;opacity:0.7">${s.source}</span>`
    : '';
  // Prefer the turns/tools split when both fields are present (newer
  // backends): user-perceived "turns" matches mental model far better
  // than raw message_count, which inflates by tool-call rows. Fall
  // back to "N msgs" for older backends that only emit message_count.
  const tCount = (s as any).turnCount;
  const toolCount = (s as any).toolCount;
  const countLabel = (typeof tCount === 'number' && typeof toolCount === 'number')
    ? (toolCount > 0 ? `${tCount} turns · ${toolCount} tools` : `${tCount} turns`)
    : `${s.messageCount || 0} msgs`;
  // Meeting glyph leads the meta row — the record mark identifies the
  // feature everywhere (icon-language rule 2026-07-09); count when a
  // session hosts several meetings.
  const meetingBadge = meetings > 0
    ? `<span class="sess-meeting-badge" title="${meetings} recording${meetings > 1 ? 's' : ''} attached">`
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>'
      + (meetings > 1 ? `${meetings}` : '') + '</span>'
    : '';
  // WhatsApp-style draft snippet (per-chat drafts, 2026-07-12): a chat
  // holding an unsent draft shows "Draft: <text>" in place of the count
  // label so it's findable from the list. Hidden for the BOUND chat —
  // its draft is sitting in the composer, the row would just echo it.
  const draftText = composerDrafts.boundTo() !== s.id ? composerDrafts.getDraft(s.id) : '';
  meta.innerHTML = draftText
    ? meetingBadge
      + `<span>${fmtRelativeTime(s.lastMessageAt)}</span>`
      + `<span class="sess-draft-badge" title="${escapeHtml(draftText.slice(0, 300))}">`
      + `Draft: ${escapeHtml(draftText.slice(0, 60))}</span>`
    : meetingBadge
      + `<span>${fmtRelativeTime(s.lastMessageAt)}</span>`
      + `<span>${countLabel}</span>`
      + sourceBadge;

  body.appendChild(snippet);
  body.appendChild(meta);
  // Click handler lives on the whole `li` so the entire highlighted
  // area (li.active border + background) is responsive — clicks on the
  // 10px×12px padding around .sess-row used to fall through, leaving
  // a visible-but-unclickable rim around each row; click on the li
  // itself catches those misses.
  // menuBtn already stopPropagation's its own click, and openMenu()
  // does the same for the menu container, so this doesn't fire on
  // menu interactions.
  li.onclick = (ev: MouseEvent) => {
    // Modifier matrix:
    //   shift           → range select from anchor to this id
    //                     (replaces current selection)
    //   ctrl OR meta    → toggle this id in the selection
    //                     (additive; preserves the rest)
    //   plain           → clear any selection and resume normally
    //
    // Shift-click and ctrl/cmd-click both preventDefault so the
    // browser's native shift+click text-selection doesn't fire on
    // top of the session selection. Esc clears (see init()'s
    // document keydown listener).
    if (ev.shiftKey) {
      ev.preventDefault();
      rangeSelect(s.id);
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      toggleSelection(s.id);
      return;
    }
    if (multiSelect.size > 0) clearMultiSelect();
    // Arm the announce-on-switch cue. consume() (end of the resume
    // render) only fires it for a genuine different-session switch, so
    // arming on a same-session re-tap is harmless.
    sessionAnnounce.arm(s.id);
    // ── Click-trace instrumentation ──────────────────────────────────
    // Capture timing at every phase from this
    // click event through to the rendered transcript so the sidebar
    // flicker / slow-load symptoms can be located in actual data, not
    // hypothesized. Trace id correlates concurrent clicks.
    const traceId = `click_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const traceT0 = performance.now();
    const trace = (event: string, extra: string = '') => {
      const t = Math.round(performance.now() - traceT0);
      log(`[click-trace ${traceId}] +${t}ms ${event}${extra ? ' ' + extra : ''}`);
    };
    trace('click', `chat=${s.id}`);
    // Stash on the resumeInFlight slot so resume() can pick it up.
    pendingTrace = { traceId, traceT0, trace };
    const listEl = document.getElementById('sessions-list');
    if (listEl) {
      listEl.querySelectorAll('li.active').forEach(el => el.classList.remove('active'));
      li.classList.add('active');
    }
    // Claim optimistic-active SYNCHRONOUSLY here so any scheduleRefresh
    // that fires before resume()'s own optimistic-set (5-15ms later,
    // after onBeforeSwitchCb returns) doesn't repaint the OLD viewed
    // chat as active — that produced the "active → leaving → new"
    // flicker where the old active chat momentarily re-highlights.
    switchCtl.setOptimistic(s.id);
    trace('sync-active-flip');
    // Row tap = the seen signal. Clear the unread chip/badge NOW —
    // waiting for the view commit gated it on the /messages fetch (an
    // uncached chat on a slow link kept its chip for seconds after the
    // tap, measured 2026-07-21).
    noteViewIntent(s.id);
    // Switch-then-load: resume() blanks the transcript + shows the
    // spinner synchronously (after it saves the leaving chat's scroll
    // position) so the old chat's content doesn't linger until the new
    // one loads.
    resume(s.id, 'tap');
  };
  // macOS Chrome / Safari fire `contextmenu` on ctrl+click instead
  // of `click`, so the onclick handler above never sees that
  // gesture. Intercept the contextmenu event when ctrlKey is set,
  // suppress the OS context menu, and route to the same toggle path
  // so Mac users get the same behavior Linux/Windows users get.
  // Plain right-click (no ctrlKey) is left alone — the browser
  // context menu still appears as expected.
  li.addEventListener('contextmenu', (ev: MouseEvent) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    toggleSelection(s.id);
  });

  // Pin toggle — a subtle clickable icon on the right of the row (mirrors
  // the per-message .pin-btn). The icon IS the pinned-state indicator:
  // faint outline when unpinned, filled + accent when pinned. Clicking
  // toggles instantly (sessionPins emits a change → synchronous local
  // repaint, no server round-trip). Two SVGs in DOM; CSS swaps which
  // shows based on the `.pinned` class.
  const pinBtn = document.createElement('button');
  pinBtn.className = 'sess-pin-btn';
  pinBtn.innerHTML = `
    <svg class="pin-icon pin-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>
    <svg class="pin-icon pin-filled" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5" stroke-linecap="round"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>
  `;
  if (pinned) {
    pinBtn.classList.add('pinned');
    pinBtn.title = 'Unpin';
  } else {
    pinBtn.title = 'Pin to top';
  }
  pinBtn.onclick = (e) => { e.stopPropagation(); sessionPins.toggle(s.id); };

  // ⋮ menu — rename + delete. Tap opens a small popover; tap outside closes.
  const menuBtn = document.createElement('button');
  menuBtn.className = 'sess-menu-btn';
  menuBtn.title = 'More';
  menuBtn.textContent = '⋮';
  menuBtn.onclick = (e) => { e.stopPropagation(); openMenu(li, s); };

  row.appendChild(body);
  row.appendChild(pinBtn);
  row.appendChild(menuBtn);
  li.appendChild(row);
  return li;
}

function openMenu(li: HTMLLIElement, s: any) {
  // Close any existing open menu first.
  document.querySelectorAll('.sess-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'sess-menu';

  // Pin/Unpin lives on the row's .sess-pin-btn icon (right side), not in
  // this menu — mirrors the per-message pin affordance.

  const infoBtn = document.createElement('button');
  infoBtn.textContent = 'Info';
  infoBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); showInfo(s); };

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); promptRename(s); };

  // Per-session identity — a friendly nickname + its own TTS voice.
  const identityBtn = document.createElement('button');
  identityBtn.textContent = 'Name & voice';
  identityBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); showIdentitySheet(s); };

  // Per-chat push-notification mute. Label reflects current state via
  // the in-memory mutes cache (loaded at boot). Toggle does optimistic
  // local update + POST to the proxy; on failure the mutes module
  // rolls back and we surface a log line for diagnostics.
  const muteBtn = document.createElement('button');
  const muted = isChatMuted(s.id);
  muteBtn.textContent = muted ? 'Unmute notifications' : 'Mute notifications';
  muteBtn.onclick = (e) => {
    e.stopPropagation();
    menu.remove();
    setChatMuted(s.id, !muted).catch((err) => {
      log(`[sess-menu] mute toggle failed for ${s.id}: ${err?.message ?? err}`);
    });
  };

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.className = 'danger';
  deleteBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); promptDelete(s); };

  menu.appendChild(infoBtn);
  menu.appendChild(renameBtn);
  menu.appendChild(identityBtn);
  menu.appendChild(muteBtn);
  menu.appendChild(deleteBtn);
  // Swallow clicks on the menu container itself (e.g. padding between
  // buttons). The button onclick handlers all stopPropagation, but a
  // click on empty menu space would otherwise bubble to li.onclick and
  // trigger a session resume — surprising mid-action.
  menu.addEventListener('click', (e) => e.stopPropagation());
  li.appendChild(menu);

  // Close on outside click (once).
  setTimeout(() => {
    const closer = (e: MouseEvent) => {
      if (menu.contains(e.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
}

/** Surface the raw filterable fields (title / source / id) so the user
 *  can see exactly what any sessions-filter glob would match against.
 *  Uses a <dialog> rather than alert() so the text is selectable
 *  (alert text isn't on most platforms) and so the displayed label
 *  matches what the list actually shows. */
function showInfo(s: any) {
  // The drawer list renders `s.title || s.snippet || s.id` — show that
  // here too, separate from the stored title, so the user can tell
  // whether the row label is the user-set title or an auto-derived
  // snippet. Fixes the "Title: (none)" surprise on auto-titled rows.
  const displayed = s.title || s.snippet || s.id;
  const storedTitle = s.title ? s.title : '(none — auto-derived from snippet)';
  const snippet = s.snippet || '';

  const dialog = document.createElement('dialog');
  dialog.className = 'session-info-dialog';
  dialog.innerHTML = `
    <div class="session-info-body">
      <div class="session-info-row"><span>Displayed:</span><pre>${escHtml(displayed)}</pre></div>
      <div class="session-info-row"><span>Title:</span><pre>${escHtml(storedTitle)}</pre></div>
      ${snippet && snippet !== s.title ? `<div class="session-info-row"><span>Snippet:</span><pre>${escHtml(snippet)}</pre></div>` : ''}
      <div class="session-info-row"><span>Source:</span><pre>${escHtml(s.source || '(unknown)')}</pre></div>
      <div class="session-info-row"><span>ID:</span><pre>${escHtml(s.id)}</pre></div>
      <div class="session-info-row"><span>Msgs:</span><pre>${s.messageCount ?? 0}</pre></div>
    </div>
    <p class="session-info-hint">Sessions-filter globs match against any of these.</p>
    <form method="dialog"><button>Close</button></form>
  `;
  // Tap-outside to dismiss. Esc is built-in on <dialog>.
  // Use the actual bounding rect — `e.target === dialog` fires for clicks
  // on the dialog's own padding/whitespace (any spot not on a child),
  // which closed the modal mid-text-selection if the user dragged the
  // cursor out then released in empty space inside the dialog.
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

/** Per-session identity editor — nickname + dedicated TTS voice. The
 *  persona row is rendered only when the active backend advertises the
 *  capability (inert in P1, so it stays hidden today). Saving writes
 *  through sessionIdentity.set(); empty fields clear that field. */
function showIdentitySheet(s: any) {
  const ident = sessionIdentity.get(s.id) ?? {};
  const curNick = ident.nickname ?? '';
  const curVoice = ident.voice ?? '';
  const personaEnabled = !!backend.capabilities().persona;
  const curPersona = ident.persona ?? '';

  const voiceOptions =
    `<option value="">Default (${escHtml(voiceLabel(settingsDefaultVoice()))})</option>` +
    AURA_VOICES.map(v =>
      `<option value="${escHtml(v.value)}"${v.value === curVoice ? ' selected' : ''}>${escHtml(v.label)}</option>`
    ).join('');

  const dialog = document.createElement('dialog');
  dialog.className = 'session-info-dialog session-identity-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="session-identity-form">
      <label class="session-identity-field">
        <span>Nickname</span>
        <input type="text" class="ident-nickname" maxlength="60"
               placeholder="e.g. Acme client" value="${escHtml(curNick)}">
      </label>
      <label class="session-identity-field">
        <span>Voice</span>
        <select class="ident-voice">${voiceOptions}</select>
      </label>
      ${personaEnabled ? `
      <label class="session-identity-field">
        <span>Persona</span>
        <textarea class="ident-persona" rows="3"
                  placeholder="Optional per-session prompt">${escHtml(curPersona)}</textarea>
      </label>` : ''}
      <div class="session-identity-actions">
        <button type="button" class="ident-cancel">Cancel</button>
        <button type="submit" class="ident-save">Save</button>
      </div>
    </form>
  `;

  const close = () => dialog.close();
  dialog.querySelector<HTMLButtonElement>('.ident-cancel')!.onclick = close;
  // The voice <select> isn't selected on first render; reflect the current
  // value (the AURA option's `selected` attr handles non-default voices,
  // but an empty curVoice must land on the Default option explicitly).
  const voiceSel = dialog.querySelector<HTMLSelectElement>('.ident-voice')!;
  voiceSel.value = curVoice;

  dialog.querySelector<HTMLFormElement>('.session-identity-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = dialog.querySelector<HTMLInputElement>('.ident-nickname')!.value.trim();
    const voice = voiceSel.value;
    const patch: sessionIdentity.SessionIdentity = { nickname, voice };
    if (personaEnabled) {
      patch.persona = dialog.querySelector<HTMLTextAreaElement>('.ident-persona')!.value.trim();
    }
    sessionIdentity.set(s.id, patch);
    dialog.close();
  });

  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

/** The global default TTS voice (synced setting), shown as the label of
 *  the "Default" option so the user knows what picking it yields. */
function settingsDefaultVoice(): string {
  try { return (settings.get() as any).voice || ''; } catch { return ''; }
}

function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

async function promptRename(s: any) {
  // Prefill with what the user SEES in the drawer: title (if set)
  // falling back to the snippet pseudo-title, so they're editing the
  // label they know rather than an empty box.
  const current = s.title || s.snippet?.slice(0, 80) || '';
  const title = prompt('New title for this session:', current);
  if (!title || title === current) return;
  // OPTIMISTIC (latency audit A3): the row shows the new title NOW —
  // derived-view repaint from the patched in-memory list; the server
  // rename settles behind, and a failure rolls the title back with a
  // visible toast.
  const prevTitle = s.title;
  const row = cachedSessions.find((c: any) => c.id === s.id);
  if (row) row.title = title;
  // Overlay guard: any server list response in flight across this
  // rename (or landing within the settle window) gets the local title
  // stamped over its stale one — see overlayPendingRenames.
  markPendingRename(s.id, title);
  {
    const listEl = document.getElementById('sessions-list');
    if (listEl) renderListFiltered(listEl, activeRowId());
  }
  try {
    await backend.renameSession(s.id, title);
    refresh();
  } catch (e: any) {
    diag(`sessionDrawer: rename failed: ${e.message}`);
    unmarkPendingRename(s.id);
    const rowBack = cachedSessions.find((c: any) => c.id === s.id);
    if (rowBack) rowBack.title = prevTitle;
    {
      const listEl = document.getElementById('sessions-list');
      if (listEl) renderListFiltered(listEl, activeRowId());
    }
    toast(`Rename failed — title restored (${e?.message || e})`, 'err', 6000);
  }
}

/** Single entry point for "delete this session and reconcile every
 *  drawer-side state surface that depends on it." Both the row-menu
 *  delete (`promptDelete`) and the multi-select bulk delete go through
 *  here so race-handling is in ONE place rather than duplicated.
 *
 *  State surfaces this touches (do not split — they all need to agree):
 *    1. recentlyDeleted set — gates renderListFiltered against pre-delete
 *       listSessions responses that resolve AFTER our delete and would
 *       otherwise put `id` back into cachedSessions.
 *    2. switchController epoch — switchCtl.invalidate() bumps the
 *       generation so any in-flight resume() for `id` bails at its
 *       isCurrent(tok) guard before its onResumeCb fires (otherwise
 *       main.ts's replaySessionMessages re-runs setViewed(id) on the
 *       deleted chat).
 *    3. switchController optimistic / viewed — cleared if they pointed
 *       at `id` (otherwise refresh()'s activeRowId() = focusedId()
 *       fallback paints an isFresh placeholder for the deleted id).
 *    4. backend (proxyClient) — server-side DELETE + IDB conversation
 *       remove + activeChatId clear.
 *    5. sessionCache — IDB list cache patched so the next refresh's
 *       cache-render doesn't briefly resurrect the row before the
 *       server-fetch reconciles.
 *    6. refresh() — final repaint.
 *
 *  Throws if backend.deleteSession throws; callers handle (promptDelete
 *  alerts, multiSelect logs and continues to the next id). */
async function deleteSessionAtomic(id: string): Promise<void> {
  // Mark + bump generation BEFORE anything async so any list response
  // or resume continuation that lands during the awaits is already gated.
  markRecentlyDeleted(id);
  switchCtl.invalidate();
  const wasViewed = switchCtl.viewedId() === id;
  if (switchCtl.optimisticId() === id) switchCtl.setOptimistic(null);
  if (wasViewed) switchCtl.setViewed(null);
  // Drop the pin if this session was pinned — a dangling id in
  // pinnedSessions would render nothing (it's filtered against the live
  // list) but would still count as the landing default on cold-open.
  // unpin() is a no-op when the id isn't pinned.
  sessionPins.unpin(id);
  // Drop any per-session identity (nickname/voice) so a recycled id
  // doesn't inherit a stale name/voice. No-op if none was set.
  sessionIdentity.remove(id);
  // OPTIMISTIC (latency audit A1, 2026-07-13): the row disappears NOW —
  // drop it from the in-memory list + repaint synchronously, then let
  // the server DELETE settle in the background. Everything above
  // already ran pre-await (the safety net was built for this); the only
  // thing that ever waited on the round-trip was the repaint. On
  // failure the tombstone lifts, the caches revert on the next refresh,
  // and the row returns with a status toast — visible failure, not a
  // silent zombie.
  const removedRow = cachedSessions.find((s: any) => s.id === id) ?? null;
  cachedSessions = cachedSessions.filter((s: any) => s.id !== id);
  {
    const listEl = document.getElementById('sessions-list');
    if (listEl) renderListFiltered(listEl, activeRowId());
  }
  // Deleting the chat you're LOOKING AT must take the transcript with
  // it (field 2026-07-13: the row vanished but the dead chat's DOM
  // stayed on screen). Land somewhere sensible, in preference order:
  // the PREVIOUSLY-viewed chat (where the user just came from) → top
  // pinned → most recent. No candidate (drawer now empty) → drop the
  // dead content and leave the blank pane; the store row is already
  // cleared so nothing can repaint it.
  if (wasViewed) {
    transcriptStore.clearAll(id);
    const alive = (cid: string | null | undefined): string | null =>
      (cid && cid !== id && cachedSessions.some((s: any) => s.id === cid)) ? cid : null;
    const candidate = alive(previouslyViewedId)
      ?? alive(sessionPins.topPinned())
      ?? (cachedSessions[0]?.id ?? null);
    if (candidate) {
      // 'delete-landing', not 'fallback': this is the direct continuation
      // of the user's delete gesture, not a background race against it.
      // Classified programmatic it would be REFUSED (the user has always
      // navigated by the time they can delete) and they'd be left staring
      // at the deleted chat's transcript.
      void resume(candidate, 'delete-landing');
    } else {
      document.getElementById('transcript')?.replaceChildren();
    }
  }
  // IDB caches follow (async, non-blocking, pre-server so a reload
  // mid-flight doesn't resurrect the row).
  void sessionCache.removeMessagesCache(id);
  void sessionCache.getListCache().then((cached) => {
    if (cached?.sessions?.length) {
      return sessionCache.putListCache(cached.sessions.filter((c: any) => c.id !== id));
    }
  }).catch(() => { /* refresh() reconciles */ });
  try {
    await backend.deleteSession(id);
  } catch (e: any) {
    // Rollback: lift the tombstone, restore the row, tell the user.
    unmarkRecentlyDeleted(id);
    diag(`sessionDrawer: delete ROLLBACK ${id} removedRow=${!!removedRow} cached=${cachedSessions.length}`);
    if (removedRow && !cachedSessions.some((s: any) => s.id === id)) {
      cachedSessions = [...cachedSessions, removedRow];
    }
    {
      const listEl = document.getElementById('sessions-list');
      if (listEl) renderListFiltered(listEl, activeRowId());
    }
    // Toast, not the status line: the connection heartbeat repaints the
    // status line ("Connected") almost immediately, which would eat the
    // failure message.
    toast(`Delete failed — session restored (${e?.message || e})`, 'err', 6000);
    // Restore the IDB list cache BEFORE kicking the reconcile refresh —
    // and awaited, deliberately: the optimistic step's filtered write
    // races this rollback, and an unawaited restore lets refresh()'s
    // step-1 cache paint read the stale filtered list, clobber the
    // in-memory restore above, and leave the drawer wrong until the
    // next poll (~15s). Ordering the write beats racing it.
    if (removedRow) {
      try {
        const cachedList = await sessionCache.getListCache();
        if (cachedList?.sessions && !cachedList.sessions.some((c: any) => c.id === id)) {
          await sessionCache.putListCache([...cachedList.sessions, removedRow]);
        }
      } catch { /* server reconcile heals */ }
    }
    refresh();
    throw e;
  }
  refresh();
}

/** Public wrapper for the multi-select bulk path — main.ts wires
 *  `multiSelect.deleteOne` to this so bulk delete inherits all the
 *  race-handling above instead of just calling backend.deleteSession
 *  directly. */
export function deleteSessionFromUI(id: string): Promise<void> {
  return deleteSessionAtomic(id);
}

async function promptDelete(s: any) {
  const label = s.title || s.snippet?.slice(0, 40) || s.id;
  if (!confirm(`Delete session "${label}"? This cannot be undone.`)) return;
  try {
    await deleteSessionAtomic(s.id);
  } catch (e: any) {
    diag(`sessionDrawer: delete failed: ${e.message}`);
    alert(`Delete failed: ${e.message}`);
  }
}

/** Pending click-trace from the body.onclick handler — picked up by
 *  resume() so the trace continues into the async work. */
let pendingTrace: { traceId: string; traceT0: number; trace: (event: string, extra?: string) => void } | null = null;

/** In-flight resume promise + the switch token that owns it. A rapid
 *  double-tap on the same row used to fire the resume pipeline N times
 *  and append duplicate chat bubbles. Same-id dedup still applies, but
 *  the token guards against returning a superseded promise (which would
 *  silently drop the user's click). The generation lives in
 *  switchController — see its header for the A→B→A hazard this closes. */
let resumeInFlight: { id: string; tok: SwitchToken; promise: Promise<void> } | null = null;

/** Resolves on the task AFTER the next painted frame: rAF fires just
 *  before the paint, and the 0ms timer scheduled inside it runs on a
 *  fresh task after the compositor commits. Used by resume() to let the
 *  click handler's synchronous feedback (row highlight flip) reach the
 *  screen before the heavy synchronous transcript replay blocks the
 *  main thread. Backstop timer because rAF never fires on a hidden
 *  document — a background resume() (notification drill racing
 *  visibility, arrow-nav from tests) must not stall the pipeline. */
function afterNextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const backstop = setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { clearTimeout(backstop); setTimeout(finish, 0); });
    }
  });
}

async function resume(id: string, origin: NavOrigin, targetMessageId?: string) {
  // Adopt the trace from the click handler if present.
  const t = pendingTrace;
  pendingTrace = null;
  t?.trace('resume-entered');
  // Dedup BEFORE begin() bumps the generation: a double-tap on the same
  // row while its resume is still the live switch returns the in-flight
  // promise instead of starting a second pipeline.
  if (resumeInFlight?.id === id && switchCtl.isCurrent(resumeInFlight.tok)) {
    t?.trace('resume-dedup-hit');
    return resumeInFlight.promise;
  }
  // Open the switch: bumps the generation and claims the optimistic
  // highlight synchronously (so a racing refresh() paints THIS row, not
  // the old one). The token authorizes every render below; superseded
  // continuations bail at switchCtl.isCurrent(tok).
  const tok = switchCtl.begin(id, origin, targetMessageId);
  // Refused by the authority rule (a programmatic origin after the user
  // has navigated). Nothing was claimed, so there is nothing to undo —
  // just abandon before the transcript blank/spinner below. Every origin
  // that reaches resume() today is user-class, so this is a guard against
  // a future caller, not a live path.
  if (!tok) {
    t?.trace('resume-refused', `origin=${origin}`);
    diag(`sessionDrawer: resume ${id} refused — ${origin} cannot supersede a user navigation`);
    return;
  }
  // Switch-back fast paint: the in-memory transcriptStore retains this
  // session's durable rows from an earlier visit this app-session (SSE
  // keeps background chats current in place). When present AND tail-
  // anchored, we paint from it ONE FRAME LATER (see the yield in the
  // promise below) instead of blanking + arming the 200ms spinner and
  // awaiting an async IDB read — the gap that made every CAP/WKWebView
  // switch flash a spinner even though the bytes were already in memory.
  // The one-frame yield (feedback-before-payload, field 2026-08-02
  // "pitch deck") exists because the replay runs synchronously in
  // whatever task invokes it — when it ran inside the click task the
  // row highlight flipped in the click handler never reached the screen
  // until the replay finished: highlight + transcript painted in the
  // same late frame, i.e. zero tap feedback (and the habitual CAP
  // double-tap). Phase 2 (transcript/index.ts windowed replay) has
  // since time-sliced the heavy part — the replay's first render is a
  // viewport window and the rest backfills in batches — but the yield
  // still matters: even the window render + old-row teardown is ~100ms
  // on a huge chat, and the highlight must paint before it. No blank,
  // no spinner: the leaving chat's content simply stays up for the one
  // yielded frame, preserving the #242 no-blank/no-spinner switch-back
  // contract.
  // Gate on !hasMoreNewer: a floating drill
  // window must NOT go through replaySessionMessages (it flattens the
  // newer-cursor pagination → risks persisting a windowed snapshot, the
  // TFC-A invariant / #223-class hole); those fall back to the blank+
  // spinner + IDB-tail path. memRendered suppresses the now-redundant IDB
  // cache re-render in the reconcile IIFE (server pass still runs).
  let memRendered = false;
  // Set in the leaving-branch below when the mem fast path is eligible;
  // the actual paint runs inside the promise, after one yielded frame.
  let memPaintPending = false;
  // True when the mem paint below rendered a TFC-B-flagged
  // (stale) buffer — the IDB rung then re-renders the fresher cached
  // tail behind it instead of skipping (phase-3 stale-paint).
  let memWasStale = false;
  // Capture the prior viewed id for the shell's onBeforeSwitch hook so it
  // can clean up empty/abandoned chats (the "New chat / 0 msgs" pollution
  // case). Skip when "navigating" to the same chat — that's a refresh,
  // not a switch. viewedId() persists across resume() lifecycles;
  // optimisticId() is the fallback for a first switch before any commit.
  const leaving = switchCtl.viewedId() || switchCtl.optimisticId();
  if (leaving && leaving !== id) {
    saveCurrentScrollPosition();
    // Bypass the IDB debounce: a fast switch can outrun the 200ms timer,
    // and a reload before the timer fires would lose the position
    // entirely. The cache already has the latest scrollTop from the
    // saveCurrentScrollPosition call above.
    flushScrollPosition(leaving);
    t?.trace('onBeforeSwitch-start', `leaving=${leaving}`);
    try { onBeforeSwitchCb?.(leaving); }
    catch (e: any) { diag(`onBeforeSwitch threw: ${e?.message || e}`); }
    t?.trace('onBeforeSwitch-end');
    // Switch-then-load: blank the transcript + show the spinner NOW —
    // after the leaving chat's scroll position is saved/flushed above,
    // but before the (async) cache/server fetch repopulates. The old
    // chat's content disappears instantly instead of lingering until the
    // new transcript lands. This is a
    // pure in-DOM operation (empty the rendered content + add the
    // `.transcript-loading` class) — it issues NO IDB write and awaits
    // nothing, so it can't reintroduce the IDB-pagehide persistence race
    // that got the prior synchronous-clear attempt reverted. The spinner
    // class is cleared once the incoming chat's render lands (see
    // rerenderInto + replaySessionMessages). Ordering matters: doing this
    // AFTER saveCurrentScrollPosition keeps the leaving chat's saved
    // scrollTop accurate (clearing first would save against an emptied,
    // collapsed transcript and lose the position).
    //
    // Cancel the LEAVING chat's at-bottom repin FIRST: showTranscriptLoading
    // collapses scrollHeight (0→tall on the incoming render), and a still-
    // live repin ResizeObserver would treat that as "content grew, snap to
    // bottom" and yank the incoming chat to the live edge mid-restore (the
    // pitch-deck bounce, field 2026-05-26). The restore branches also cancel
    // it, but only AFTER the clear+render — too late to stop the wake.
    cancelAtBottomRepin();
    const memState = transcriptStore.getState(id);
    // Gate the synchronous mem paint on two STRUCTURAL conditions:
    //   1. durable non-empty AND tail-anchored (!hasMoreNewer) — a floating
    //      drill window must not go through replaySessionMessages (flattens
    //      the newer cursor → TFC-A / #223-class hole).
    //   2. no `role:'gap'` row — a deep-drill SPLICES a window alongside the
    //      tail with a gap marker (#227). Painting that on switch-back would
    //      keep the drilled window resident, but the canonical IDB snapshot
    //      is tail-anchored; let those fall back to the IDB-tail paint so a
    //      revisit lands at the tail (drill-window-cache contract).
    // Mem-STALENESS deliberately does NOT gate the paint (hardening
    // phase 3, decision #2: WhatsApp stale-paint-then-reconcile). A
    // TFC-B-flagged buffer is old but CORRECT content — paint it now
    // with zero blank frames; memWasStale below forces the IDB rung to
    // re-render the fresh tail in place behind it (same-session upsert,
    // no clear, no flicker).
    const memHasGap = memState.durable.some(it => it.role === 'gap');
    memWasStale = memStaleChats.has(id);
    if (memState.durable.length > 0 && !memState.pagination.hasMoreNewer
        && !memHasGap
        && switchCtl.isCurrent(tok)) {
      // Eligible for the mem fast paint — but do NOT run it here in the
      // click task. The paint happens inside the promise below, after
      // one yielded frame, so the row highlight the click handler just
      // flipped actually reaches the screen first (feedback-before-
      // payload). No blank/spinner: the leaving chat's pixels stay up
      // for the yielded frame.
      //
      // Same one-loading-signal rule as the spinner branch below: a
      // stale edge-pagination spinner from the LEAVING chat must not
      // ride into the switched view (field 2026-08-04: it visually
      // attached itself to the incoming chat's top edge).
      clearEdgeLoader();
      memPaintPending = true;
    } else {
      // One loading signal at a time (2026-07-10 walking-test report:
      // duplicate spinners on switch): a stale edge-pagination loader
      // from the LEAVING chat must not stack under the incoming
      // full-area spinner.
      clearEdgeLoader();
      showTranscriptLoading();
      t?.trace('transcript-cleared');
    }
  }
  t?.trace('optimistic-set');
  const promise = (async () => {
    if (memPaintPending) {
      // Feedback-before-payload: yield ONE painted frame so the click
      // handler's synchronous .active flip (and any other tap ack) is
      // on screen before the potentially multi-second synchronous
      // replay of a huge transcript blocks the main thread. Measured
      // pre-fix (200 fat-markdown rows, headless chromium): the click
      // task blocked ~1.6s and the highlight painted in the SAME frame
      // as the transcript swap.
      await afterNextPaint();
      // Superseded during the yielded frame → skip the paint; the
      // cache/server rungs below carry their own isCurrent guards (we
      // still fall through so the IDB cache-warm behavior matches a
      // superseded pre-fix resume).
      if (switchCtl.isCurrent(tok)) {
        // Re-read the store: an SSE mutation during the yielded frame
        // could have spliced a gap or grown a newer-cursor, so the
        // eligibility check must be re-run against current state.
        const mem = transcriptStore.getState(id);
        const memGapNow = mem.durable.some(it => it.role === 'gap');
        if (mem.durable.length > 0 && !mem.pagination.hasMoreNewer && !memGapNow) {
          // Repaint from the in-memory model — no blank frame, no
          // spinner. Pass inflight=undefined to PRESERVE live inflight
          // (same contract as the cache-render path). setViewed/render
          // run inside replaySessionMessages, which also clears any
          // stale .transcript-loading.
          onResumeCb?.(tok, mem.durable, mem.pagination, undefined, targetMessageId);
          memRendered = true;
          t?.trace('mem-render', `n=${mem.durable.length}${memWasStale ? ' stale' : ''}`);
        } else {
          // Eligibility evaporated during the yielded frame — fall back
          // to the blank+spinner path. This is still resume()'s mem-gate
          // fall-through (the sole legal showTranscriptLoading caller).
          clearEdgeLoader();
          showTranscriptLoading();
          t?.trace('transcript-cleared');
        }
      }
    }
    // 1. Paint from cached transcript if we have one — instant feel.
    t?.trace('cache-fetch-start');
    const cached = await sessionCache.getMessagesCache(id);
    t?.trace('cache-fetch-end', `hit=${!!cached?.messages?.length} n=${cached?.messages?.length ?? 0}`);
    // memRendered: the in-memory model already painted this view
    // synchronously above. Treat it as a cache render so the merge /
    // error-fallback logic behaves identically — but skip the redundant
    // IDB re-render below (the bytes are already on screen). We STILL read
    // the IDB `cached` above so the cache-fuller merge can recover deep
    // scrollback the in-memory tail may not hold.
    //
    // EXCEPT when the mem paint was STALE (phase-3 stale-paint): the
    // IDB tail is the fresher one (TFC-B refreshed it behind the
    // resident buffer) — let this rung re-render it. Same-session at
    // this point (the mem paint committed the view), so the replay
    // upserts in place: no clear, no flicker, just the new tail rows
    // landing.
    let cacheRendered = memRendered && !memWasStale;
    if (!cacheRendered && cached?.messages?.length) {
      if (switchCtl.isCurrent(tok)) {
        t?.trace('cache-render-start');
        log(`sessionDrawer: resumed ${id} from cache (${cached.messages.length} messages)`);
        // Pass cached pagination so the cache-painted view has the
        // right hasMore/firstId — otherwise load-earlier silently
        // no-ops because replaySessionMessages defaults pagination to
        // null/false when missing. inflight=undefined (not []) so
        // replaySessionMessages PRESERVES the live inflight envelopes
        // that accumulated in transcriptStore while another chat was
        // viewed — passing [] would wipe in-flight bubbles for the
        // chat we're returning to.
        onResumeCb?.(tok, cached.messages, cached.pagination, undefined, targetMessageId);
        // The fresh IDB cache just repopulated the in-memory buffer via
        // replaySessionMessages → setDurable; it's current again.
        memStaleChats.delete(id);
        t?.trace('cache-render-end');
        scheduleRefresh();
        cacheRendered = true;
      }
    }
    // 2. Always hit the server to reconcile. If cache was stale (server
    //    has new turns), the second replay catches up. resumeSession also
    //    abort-in-flights any stray stream from a prior session.
    try {
      t?.trace('server-fetch-start');
      const result: any = await backend.resumeSession(id);
      t?.trace('server-fetch-end', `n=${(result.messages || []).length} error=${result.error || ''}`);
      const messages = result.messages || [];
      const pagination = { firstId: result.firstId ?? null, hasMore: !!result.hasMore };
      if (result.error) {
        if (!switchCtl.isCurrent(tok)) return;
        const msg = cacheRendered
          ? 'Showing cached session — reconnecting…'
          : 'Could not load session — reconnecting…';
        status.setStatus(msg, 'err');
        if (!cacheRendered) {
          onResumeCb?.(tok, [], { firstId: null, hasMore: false }, []);
        }
        scheduleRefresh();
        return;
      }
      // Merge the server's newest page into the (possibly fuller) cached
      // transcript so the reconcile doesn't truncate already-loaded history
      // down to the newest ~200 rows. When the cache holds MORE than the
      // page (the user scrolled/drilled older pages, now persisted), keep
      // the full set + the deeper load-earlier cursor; otherwise this is
      // just the page (cold load / equal-length). The full merged set is
      // what we persist, so the cache GROWS to the whole transcript instead
      // of churning the newest page — the cache grows to the whole
      // transcript so deep pins are instant on revisit.
      // Same no-hole rule as fetchAndMergeNewestPage: only merge when
      // the server page OVERLAPS the cache. Delta resume keeps the page
      // contiguous with the cached tail, but its fallback (cache >600
      // rows behind, or a fetch error mid-walk) returns the bare newest
      // ~200-row page — against a deep-scrollback cache that page may
      // share no ids, and merging would splice a permanent hole.
      // Dropping the deep history is the lesser evil: load-earlier can
      // re-fetch it; nothing can heal a hole.
      const reconCachedIds = new Set(
        cached ? cached.messages.map((m: any) => String(m?.id)) : []);
      const reconOverlaps = messages.some((row: any) => row?.id != null && reconCachedIds.has(String(row.id)));
      const cacheFuller = cacheRendered && !!cached && cached.messages.length > messages.length && reconOverlaps;
      const merged = cacheFuller ? sessionCache.mergeNewestPage(cached!.messages, messages) : messages;
      const mergedPagination = cacheFuller ? cached!.pagination : pagination;
      const capped = sessionCache.capTranscript(merged, mergedPagination);
      await sessionCache.putMessagesCache(id, capped.messages, capped.pagination);
      // Stale-generation guard — see above. Bail BEFORE logging so the
      // log line accurately reflects which fetches actually rendered.
      if (!switchCtl.isCurrent(tok)) return;
      // Cache-matched optimization: if the cache cb ALREADY rendered the
      // same rows the merge produced (no new tail turns / edits), skip the
      // re-render to avoid a 500ms-later blank-flicker. Critical: gate on
      // cacheRendered, not just `cached`. For a chat with 0 cached messages,
      // the cache cb's render path was skipped (it requires length > 0), so
      // the server cb is the FIRST render — must run, otherwise chat.clear()
      // never fires when the user clicks an empty chat for the SECOND time
      // and the previous chat's transcript leaks through (2026-04-29).
      if (cacheRendered && cached && sessionCache.sameTranscript(cached.messages, capped.messages)) {
        // Inflight envelopes are independent of state.db rows — they
        // represent in-flight turn state the proxy holds in memory.
        // Even if rows match, mid-turn bubbles (user_message echo +
        // reply_deltas) live ONLY in `inflight` until reply_final
        // promotes them. Skipping replay drops them on the floor.
        // Field bug 2026-05-12 (chat 99298465): switch-back hits the
        // cache-match path; without this replay the turn-3 user bubble
        // vanishes because chat.clear() during cache-render wiped it
        // and only the inflight echo can put it back.
        const inflight = Array.isArray(result.inflight) ? result.inflight : [];
        if (inflight.length > 0) {
          log(`sessionDrawer: cache-match — replaying ${inflight.length} inflight envelope(s) for ${id}`);
          backend.replayInflight?.(id, inflight);
        }
        t?.trace('server-render-skip-cache-match');
        return;
      }
      t?.trace('server-render-start');
      const inflight = Array.isArray(result.inflight) ? result.inflight : [];
      log(`sessionDrawer: resumed ${id} (${capped.messages.length} messages, ${inflight.length} inflight, hasMore=${capped.pagination.hasMore})`);
      onResumeCb?.(tok, capped.messages, capped.pagination, inflight, targetMessageId);
      // In-memory buffer is now reconciled to the server tail.
      memStaleChats.delete(id);
      t?.trace('server-render-end');
      scheduleRefresh();
    } catch (e: any) {
      diag(`sessionDrawer: resume ${id} failed: ${e.message}`);
      if (switchCtl.isCurrent(tok)) {
        status.setStatus(
          cacheRendered ? 'Showing cached session — reconnecting…' : 'Could not load session — reconnecting…',
          'err',
        );
        if (!cacheRendered) {
          switchCtl.setOptimistic(null);
        }
        scheduleRefresh();
      }
    }
  })();
  resumeInFlight = { id, tok, promise };
  try { await promise; } finally {
    // Only clear the in-flight slot if it still belongs to OUR switch.
    // A newer switch already replaced it; touching it would corrupt
    // that newer call's state.
    if (resumeInFlight?.tok.gen === tok.gen) resumeInFlight = null;
    // Clear optimistic only if our switch is still live AND optimistic
    // still points at us (no newer switch superseded us).
    switchCtl.clearOptimisticIfCurrent(tok);
    t?.trace('resume-finally');
  }
}

/** Lazy-build the inline filter input above the sessions list, idempotent.
 *  Lives inside #sb-sessions-section so it inherits the existing sidebar
 *  collapse/expand behavior on mobile. Wires the debounced re-render +
 *  IDB-persist on input, and Esc to clear (drops the filter + IDB entry). */
function ensureFilterInput(): HTMLInputElement | null {
  let input = document.getElementById('sess-filter-input') as HTMLInputElement | null;
  if (input) return input;
  const header = document.querySelector('.sb-sessions-header');
  if (!header) return null;
  input = document.createElement('input');
  input.id = 'sess-filter-input';
  input.type = 'text';
  input.className = 'sess-filter';
  input.placeholder = 'Filter Sessions';
  // Wildcard hint moved out of placeholder into the tooltip so the
  // placeholder reads cleanly. The cmd+K palette button (in the sidebar
  // top header) covers richer cross-message search.
  input.title = 'Wildcards: * matches any text. Filter matches against session title, snippet, and id.';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Filter sessions');
  input.value = currentFilter;
  // Insert as the only child of the (now full-width) sessions header.
  header.appendChild(input);

  // Inline clear-X button: tap to clear filter without needing
  // keyboard/Esc. Mirrors the keydown Escape handler
  // below — same teardown of value, currentFilter, IDB persistence,
  // pending timers, then re-render unfiltered. Visible only while the
  // input has content.
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.id = 'sess-filter-clear';
  clearBtn.className = 'sess-filter-clear';
  clearBtn.setAttribute('aria-label', 'Clear filter');
  clearBtn.title = 'Clear filter';
  clearBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
  clearBtn.hidden = !input.value;
  header.appendChild(clearBtn);

  // Canonical filter button (meeting-polish #25 — supersedes the
  // 2026-07-09 ◉ meetings lens, one affordance instead of two): the
  // funnel toggles the option filter ENGAGED/off, and an options strip
  // under the header lists the available option(s) while engaged.
  // Today's single option is "Has recording", DEFAULT ON — per the
  // approved spec's "default true", read as: the option is pre-ticked
  // when the filter UI is engaged, NOT that the drawer boots filtered
  // (boot-filtering would hide most sessions). State is per-device and
  // session-ephemeral by design (module vars — never IDB/synced).
  const rerenderRows = () => {
    const listEl = document.getElementById('sessions-list');
    if (listEl) renderListFiltered(listEl, activeRowId());
  };
  const filterBtn = document.createElement('button');
  filterBtn.type = 'button';
  filterBtn.id = 'sess-filter-btn';
  filterBtn.className = 'sess-filter-btn';
  filterBtn.setAttribute('aria-label', 'Filter sessions');
  filterBtn.setAttribute('aria-pressed', 'false');
  filterBtn.title = 'Filter sessions — "has recording" is on by default';
  filterBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v5.5l-4 2.5v-8L3 5z"/></svg>';
  header.appendChild(filterBtn);

  const optionsRow = document.createElement('div');
  optionsRow.id = 'sess-filter-options';
  optionsRow.className = 'sess-filter-options';
  optionsRow.hidden = true;
  optionsRow.innerHTML =
    '<label class="sess-filter-option" for="sess-filter-has-recording">'
    + '<input type="checkbox" id="sess-filter-has-recording">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>'
    + '<span>Has recording</span></label>';
  header.insertAdjacentElement('afterend', optionsRow);
  const hasRecCb = optionsRow.querySelector<HTMLInputElement>('#sess-filter-has-recording')!;
  hasRecCb.checked = recordingFilter.hasRecording;

  const syncFilterUi = () => {
    filterBtn.classList.toggle('active', recordingFilter.engaged);
    filterBtn.setAttribute('aria-pressed', String(recordingFilter.engaged));
    optionsRow.hidden = !recordingFilter.engaged;
  };
  filterBtn.onclick = () => {
    recordingFilter.engaged = !recordingFilter.engaged;
    syncFilterUi();
    rerenderRows();
  };
  hasRecCb.addEventListener('change', () => {
    recordingFilter.hasRecording = hasRecCb.checked;
    rerenderRows();
  });
  syncFilterUi();

  // Re-render rows when the meetings index refreshes (boot fetch or a
  // capture_changed envelope) so badges + the lens stay live.
  window.addEventListener('parley:meetings-changed', rerenderRows);
  const updateClearVisibility = () => { clearBtn.hidden = !input!.value; };
  const clearFilter = () => {
    input!.value = '';
    currentFilter = '';
    if (filterRenderTimer != null) { clearTimeout(filterRenderTimer); filterRenderTimer = null; }
    if (filterPersistTimer != null) { clearTimeout(filterPersistTimer); filterPersistTimer = null; }
    if (filterServerTimer != null) { clearTimeout(filterServerTimer); filterServerTimer = null; }
    clearStoredFilter();
    const listEl = document.getElementById('sessions-list');
    if (listEl) {
      const active = activeRowId();
      renderListFiltered(listEl, active);
    }
    updateClearVisibility();
  };
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearFilter();
    input!.focus();
  });

  input.addEventListener('input', () => {
    currentFilter = input!.value;
    updateClearVisibility();
    if (filterRenderTimer != null) clearTimeout(filterRenderTimer);
    if (filterPersistTimer != null) clearTimeout(filterPersistTimer);
    if (filterServerTimer != null) clearTimeout(filterServerTimer);
    // 1. Instant client-side re-render over the cached list — keeps
    //    typing snappy regardless of network latency. parseQuery +
    //    applyFilter is in-memory string ops; <1ms for 50 rows.
    filterRenderTimer = setTimeout(() => {
      filterRenderTimer = null;
      const listEl = document.getElementById('sessions-list');
      if (!listEl) return;
      const active = activeRowId();
      renderListFiltered(listEl, active);
    }, 100) as unknown as number;
    // 2. Debounced server-authoritative reconcile — covers the case
    //    where the user filters for a term that matches a session NOT
    //    in the cached top-50 (e.g. an old whatsapp thread). Replaces
    //    cachedSessions on success so the next render paints from the
    //    server-truth list. Abort any in-flight earlier query.
    filterPersistTimer = setTimeout(() => {
      filterPersistTimer = null;
      if (currentFilter) putStoredFilter(currentFilter);
      else clearStoredFilter();
    }, 500) as unknown as number;
    filterServerTimer = setTimeout(() => {
      filterServerTimer = null;
      runServerFilterReconcile(currentFilter);
    }, 250) as unknown as number;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Clear value + filter + persistence; re-render unfiltered.
      input!.value = '';
      currentFilter = '';
      if (filterRenderTimer != null) { clearTimeout(filterRenderTimer); filterRenderTimer = null; }
      if (filterPersistTimer != null) { clearTimeout(filterPersistTimer); filterPersistTimer = null; }
      clearStoredFilter();
      const listEl = document.getElementById('sessions-list');
      if (listEl) {
        const active = activeRowId();
        renderListFiltered(listEl, active);
      }
      // Drop focus so a follow-up Esc can hit other Esc handlers (close
      // settings, close info panel) rather than getting eaten here.
      input!.blur();
    }
  });
  return input;
}

/** Drag-reorder within the pinned region, powered by SortableJS. Wired
 *  ONCE on the stable #sessions-list element (renderList replaces its
 *  children, not the element itself, so one Sortable instance survives
 *  every rebuild — it queries draggable rows at drag start).
 *
 *  iOS-style motif via Sortable's fallback mode (forceFallback): the
 *  pressed row lifts into a floating clone (.sess-drag-floating) that
 *  follows the pointer, the spot it left holds a placeholder gap
 *  (.sess-drag-ghost) so the list doesn't collapse, and the siblings
 *  animate out of the way (FLIP, `animation` ms). The drag is fenced to
 *  the pinned region (onMove rejects any move whose neighbour isn't
 *  pinned), so a pinned row can never cross the divider into recency.
 *  Drop commits the new DOM order to sessionPins. */
let pinnedDragWired = false;
// True only while a pinned-row drag is mid-gesture. Drawer rebuilds
// (renderList) bail out while it's set: a rebuild does innerHTML='',
// which would yank the row out from under Sortable mid-drag. Released in
// onEnd before the commit repaint.
let pinDragActive = false;
// Lazily-loaded Sortable ctor; bundled separately at build time.
let sortableLib: typeof import('sortablejs') | null = null;
const SORTABLE_BUNDLE_URL = '/build/vendor/sortable.mjs';

function installPinnedDragReorder(listEl: HTMLElement): void {
  if (pinnedDragWired) return;
  pinnedDragWired = true;

  // Swallow the click the browser fires right after a drag so a reorder
  // never resumes a chat. Window-gated: only set on a real drag end, so a
  // plain tap (no drag → no onEnd) still resumes normally.
  let suppressClickUntil = 0;
  listEl.addEventListener('click', (e: MouseEvent) => {
    if (Date.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  const pinnedOrderFromDom = (): string[] =>
    (Array.from(listEl.querySelectorAll('li.sess-pinned')) as HTMLElement[])
      .map((li) => li.dataset.chatId || '')
      .filter(Boolean);

  void import(/* webpackIgnore: true */ SORTABLE_BUNDLE_URL)
    .then((mod: any) => {
      const Sortable = (mod?.default ?? mod) as typeof import('sortablejs');
      sortableLib = Sortable;
      Sortable.create(listEl, {
        // Only pinned rows can be picked up; recency rows + the divider
        // are static.
        draggable: 'li.sess-pinned',
        // Presses on the action buttons fall through to their handlers
        // instead of starting a drag.
        filter: '.sess-pin-btn, .sess-menu-btn, .sess-menu',
        preventOnFilter: false,
        // Fallback (a cloned floating element) instead of native HTML5
        // DnD: native has no touch support and an unstyleable drag image.
        // The clone is the element we style as the lifted card.
        forceFallback: true,
        fallbackOnBody: true,
        fallbackClass: 'sess-drag-floating',
        fallbackTolerance: 4,
        animation: 180,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        ghostClass: 'sess-drag-ghost',
        chosenClass: 'sess-drag-chosen',
        dragClass: 'sess-drag-source',
        // Touch: long-press to pick up (so a tap still resumes and a
        // vertical swipe still scrolls the list). Mouse: immediate.
        delay: 160,
        delayOnTouchOnly: true,
        touchStartThreshold: 4,
        // Fence the drag to the pinned region — reject any move that would
        // place the row next to a non-pinned neighbour (recency / divider).
        onMove: (evt: any) => {
          const related = evt?.related as HTMLElement | null;
          return !related || related.classList.contains('sess-pinned');
        },
        onStart: () => { pinDragActive = true; },
        onEnd: () => {
          // Release the rebuild lock BEFORE setOrder so its synchronous
          // repaint isn't swallowed by the renderList guard.
          pinDragActive = false;
          suppressClickUntil = Date.now() + 350;
          // Commit the live DOM order. setOrder filters to the current
          // pinned set + emits a change → synchronous local repaint.
          sessionPins.setOrder(pinnedOrderFromDom());
        },
      });
    })
    .catch((err: any) => {
      diag(`sessionDrawer: Sortable load failed; pinned drag-reorder disabled: ${err?.message || err}`);
      // Allow a later render to retry the wiring.
      pinnedDragWired = false;
    });
}

/** Public hook for the global `/` shortcut — focuses the inline filter. */
export function focusFilter() {
  const input = ensureFilterInput();
  if (input) {
    input.focus();
    input.select();
  }
}

/** Public hook for the "focus session list" hotkey / Esc-from-composer.
 *
 *  ArrowUp/Down navigation is a DOCUMENT-level listener that only bails
 *  when focus sits in a text field (see the keydown handler above), so
 *  the operative move here is simply to LEAVE the composer — everything
 *  else is feedback. We still open the sidebar and put real DOM focus on
 *  the active row so the jump is visible and screen readers land
 *  somewhere sensible; `tabindex=-1` makes the row programmatically
 *  focusable without inserting every session into the tab order.
 *
 *  Returns false when there is no row to land on (empty list), so the
 *  caller can decline to claim the keystroke. */
export function focusList(): boolean {
  const sidebar = document.getElementById('sidebar');
  if (sidebar && !sidebar.classList.contains('expanded')) {
    sidebar.classList.add('expanded');
  }
  const active = document.querySelector<HTMLElement>('#sessions-list li.active')
    || document.querySelector<HTMLElement>('#sessions-list li');
  const focused = document.activeElement as HTMLElement | null;
  if (focused && focused !== document.body) focused.blur();
  if (!active) return false;
  active.tabIndex = -1;
  active.focus({ preventScroll: true });
  active.scrollIntoView({ block: 'nearest' });
  return true;
}

export function init(opts: {
  /** Render callback for every resume rung (mem/cache/server). Receives
   *  the switch's PaintToken — the chat id rides on it (tok.id) and the
   *  token authorizes the paint downstream (replaySessionMessages
   *  refuses a dead one). */
  onResume: (tok: switchCtl.SwitchToken, messages: any[], pagination?: { firstId: number | null; hasMore: boolean }, inflight?: any[], targetMessageId?: string) => void;
  /** Called once at the moment a row click triggers a chat switch,
   *  with the ID of the chat being navigated AWAY from (null on
   *  first activation). Lets the shell drop empty/abandoned chats
   *  before the new one paints. */
  onBeforeSwitch?: (leavingId: string | null) => void;
  /** Called whenever the multi-select set changes (shift-click toggle
   *  or programmatic clear). Receives the current set of selected
   *  chat ids. main.ts uses it to mount/unmount the bulk-delete
   *  stats panel. */
  onMultiSelectChange?: (selectedIds: string[]) => void;
  onSessionGone?: () => void;
}) {
  onResumeCb = opts.onResume;
  onBeforeSwitchCb = opts.onBeforeSwitch || null;
  onMultiSelectChangeCb = opts.onMultiSelectChange || null;
  onSessionGoneCb = opts.onSessionGone || null;
  installSelectionKeyboardListener();
  // Restore persisted filter (don't await — boot order shouldn't block
  // on IDB; refresh() will pick it up on the next render once resolved).
  getStoredFilter().then((saved) => {
    if (!saved) return;
    currentFilter = saved;
    const input = ensureFilterInput();
    if (input) input.value = saved;
    const listEl = document.getElementById('sessions-list');
    if (listEl && cachedSessions.length) {
      const active = activeRowId();
      renderListFiltered(listEl, active);
    }
  });
}

/** Adapter-driven new-session announcement entry point. Wired in main.ts
 *  via the BackendAdapter `onSessionStarted` callback — the active
 *  adapter normalizes its wire-protocol-specific signal (e.g. hermes'
 *  /api/hermes/drawer-events SSE) into a uniform shape and we paint a
 *  pending row so the just-created chat appears in the drawer before
 *  the next listSessions poll. Adapters without this signal leave the
 *  callback unset; their drawers simply don't get the pre-emptive row
 *  (the next refresh tick covers the gap). */
export function handleSessionAnnounced(ev: { id?: string; snippet?: string; source?: string; started_at?: string }) {
  if (!ev?.id) return;
  const snippet = typeof ev.snippet === 'string' ? ev.snippet : '';
  const listEl = document.getElementById('sessions-list');
  const active = () => activeRowId();

  // Case 1 — the chat is already in cachedSessions (lazy-create flow:
  // conversations.create() writes IDB with title='New chat', drawer
  // refresh() merges that into cachedSessions before the user even
  // types). If the cached row's title/snippet are still the placeholder
  // ('New chat' / empty), patch them with the supplied snippet so the
  // drawer shows the user's actual message text rather than a
  // misleading "New chat 0 msgs" line. The server-side session_changed
  // envelope still wins later (hermes-derived title overrides snippet).
  const cached = cachedSessions.find(s => s.id === ev.id);
  if (cached) {
    if (snippet) {
      const titlePlaceholder = !cached.title || cached.title === 'New chat';
      const snippetEmpty = !cached.snippet;
      if (titlePlaceholder && snippetEmpty) {
        cached.snippet = snippet;
        // Persist to IDB too — reload otherwise hydrates the stale
        // 'New chat' title back from conversations.ts and the snippet
        // is lost. updateTitle treats whatever string we pass as the
        // display name; session_changed later overwrites it again
        // with the canonical hermes-generated title.
        void conversations.updateTitle(ev.id, snippet).catch(() => {});
        if (listEl) renderListFiltered(listEl, active());
      }
    }
    return;
  }

  // Case 2 — already pending. Refresh the snippet if it's getting more
  // informative (first announce might have been title-less; second one
  // can carry the actual user text).
  if (pendingSessions.has(ev.id)) {
    if (snippet) {
      const p = pendingSessions.get(ev.id)!;
      if (!p.snippet) {
        p.snippet = snippet;
        if (listEl) renderListFiltered(listEl, active());
      }
    }
    return;
  }

  // Case 3 — net-new row. Synthesize matching the listSessions shape.
  // messageCount defaults to 1 (the user's first turn — agent reply
  // hasn't persisted yet). lastMessageAt is in seconds (same epoch
  // unit fmtRelativeTime uses).
  const startedSec = ev.started_at ? Math.floor(Date.parse(ev.started_at) / 1000) : Math.floor(Date.now() / 1000);
  pendingSessions.set(ev.id, {
    id: ev.id,
    title: null,
    snippet,
    source: ev.source || 'api_server',
    messageCount: 1,
    lastMessageAt: startedSec,
    // Client wall-clock at insertion — drives TTL aging in refresh().
    // started_at can be hours in the past for SSE replays from the
    // ring; this is when *this client* first heard about the row.
    _addedAt: Date.now(),
  });
  if (listEl) renderListFiltered(listEl, active());
}

/** Called after the user changes the sessions-filter setting. Drops the
 *  cached list (stale for the new filter), paints an immediate "Loading…"
 *  so there's instant feedback even if the server fetch takes a beat,
 *  then fires refresh() which repopulates from the server. */
export async function refreshAfterFilterChange() {
  const listEl = document.getElementById('sessions-list');
  if (listEl) listEl.innerHTML = '<li class="sess-empty">Loading…</li>';
  await sessionCache.clearListCache();
  refresh();
}

/** Show/hide the sessions section inside the sidebar based on the active
 *  backend's capabilities. Sidebar itself is always present — the new-chat
 *  button must work even when no session browser is available.
 *  Also triggers a refresh when sessionBrowsing becomes enabled — covers the
 *  boot path where the sidebar is auto-restored (desktop persistence) BEFORE
 *  the backend connects: the first refresh() bails early because
 *  capabilities aren't yet applied, so without this the drawer stays empty. */
export function applyCapabilities() {
  const section = document.getElementById('sb-sessions-section');
  const enabled = backend.capabilities().sessionBrowsing;
  if (section) section.style.display = enabled ? '' : 'none';
  if (enabled) {
    refresh();
    startListPolling();
  } else {
    stopListPolling();
  }
}

// ── Background refresh polling ──────────────────────────────────────
//
// Cross-platform sessions (telegram, slack, etc.) don't fire a parley-
// targeted `session_changed` envelope when they get activity — only
// chats backends/hermes/plugin owns (Platform.PARLEY) do. To get sub-1s lag
// for "telegram chat just got a new message" → drawer reflects it,
// we'd need a backends/hermes/plugin extension that emits cross-platform
// session_activity envelopes. Pragmatic v1: poll listSessions every
// few seconds while the tab is foregrounded. ~3-5s lag for non-
// parley chats; parley chats already update live via the existing
// session_changed handler so nothing changes for the primary path.
//
// Pauses when document.visibilityState !== 'visible' so a backgrounded
// PWA isn't doing useless work. Resumes on visibility-change.

const POLL_INTERVAL_MS = 5000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollVisibilityBound = false;
let pollRequested = false;

function shouldPollList(): boolean {
  return backend.capabilities().sessionBrowsing
    && (typeof document === 'undefined' || document.visibilityState === 'visible');
}

function syncPollTimer(): void {
  if (!pollRequested || !shouldPollList()) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    return;
  }
  if (!pollTimer) pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

function pollTick(): void {
  if (!pollRequested || !shouldPollList()) {
    syncPollTimer();
    return;
  }
  refresh().catch((e: any) => diag(`sessionDrawer poll: refresh failed: ${e?.message}`));
}

function startListPolling(): void {
  pollRequested = true;
  syncPollTimer();
  if (!pollVisibilityBound && typeof document !== 'undefined') {
    pollVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      syncPollTimer();
      // On returning to visible, kick a refresh immediately so the
      // user doesn't wait up to POLL_INTERVAL_MS for the next tick.
      if (document.visibilityState === 'visible' && backend.capabilities().sessionBrowsing) {
        refresh().catch(() => {});
      }
    });
  }
}

function stopListPolling(): void {
  pollRequested = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
