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
import * as sessionCache from './sessionCache.ts';
import { log, diag } from './util/log.ts';
import { parseQuery, applyFilter } from './sessionFilter.ts';
import { getFilter as getStoredFilter, putFilter as putStoredFilter, clearFilter as clearStoredFilter } from './util/filterStore.ts';

let onResumeCb: ((id: string, messages: any[], pagination?: { firstId: number | null; hasMore: boolean }) => void) | null = null;

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
  // "1 selected, going nowhere." Active row ≠ viewedSessionId in
  // some race windows (just-clicked, replay still pending), so
  // mirror the rangeSelect / extendSelectionByKey anchor priority.
  const active = optimisticActiveId || viewedSessionId;
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
  const anchor = multiSelectAnchor || optimisticActiveId || viewedSessionId;
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
  const anchor = multiSelectAnchor || optimisticActiveId || viewedSessionId;
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
 *  Without this the drawer ends up in the awkward "I have a session
 *  selected AND a text range selected" state Jonathan flagged in
 *  the screenshot. */
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
    // the composer / filter input).
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toUpperCase() || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      const direction: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
      if (extendSelectionByKey(direction)) {
        e.preventDefault();
      }
    }
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
 *  server's listSessions catches up (id appears in cachedSessions). */
const pendingSessions = new Map<string, any>();

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

/** Optimistic active-id override for refresh(). The adapter's
 *  `getCurrentSessionId()` doesn't update until `resumeSession()` returns
 *  from the server — on the cache-hit path that meant refresh() was
 *  immediately painting the STALE previous id over the click's optimistic
 *  highlight, producing a flicker (or sticking if the server fetch hung).
 *  Set at click-time, cleared after resume settles. refresh() reads this
 *  first, falls back to backend state when null. */
let optimisticActiveId: string | null = null;

/** The session id whose transcript is CURRENTLY RENDERED in the chat pane.
 *  Set by main.ts via setViewed() at every transition: replaySessionMessages,
 *  new-chat (pinned to the freshly-rotated conversationName), and boot
 *  (pinned to the restored snapshot id). Takes priority over
 *  optimisticActiveId and conversationName — the drawer should always
 *  highlight the row the user is actually reading, regardless of what
 *  the adapter thinks its current send-target is (they can diverge e.g.
 *  after a resume where conversationName updated but then the user tapped
 *  another session and the adapter's token got superseded).
 *
 *  Also load-bearing for the renderable-event gates in main.ts
 *  (handleReplyDelta/Final): incoming `conversation` is compared against
 *  getViewed() to decide whether to render. Must stay populated whenever
 *  there's a chat on screen, even one that's not yet persisted. */
let viewedSessionId: string | null = null;
export function setViewed(id: string | null) {
  viewedSessionId = id;
}
export function getViewed(): string | null { return viewedSessionId; }

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

export function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (refreshInFlight) {
      // A refresh is already running; queue another tick. Without this
      // re-arm, a server fetch slower than the coalesce window means
      // updates that land mid-refresh would otherwise be dropped on the
      // floor.
      scheduleRefresh();
      return;
    }
    refreshInFlight = true;
    refresh().finally(() => { refreshInFlight = false; });
  }, 50);
}

export async function refresh() {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  if (!backend.capabilities().sessionBrowsing) { listEl.innerHTML = ''; return; }
  // Make sure the filter input exists above the list. Idempotent — once
  // mounted it stays put. Also re-syncs `currentFilter` from the live
  // input value in case the user typed before refresh ever ran.
  ensureFilterInput();
  // Priority: viewed (what's on screen) → optimistic (click in flight) →
  // adapter's conversationName (fallback for fresh state / new chats).
  const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';

  // 1. Render from cache if available.
  const cached = await sessionCache.getListCache();
  if (cached?.sessions?.length) {
    cachedSessions = cached.sessions;
    renderListFiltered(listEl, active);
  } else {
    listEl.innerHTML = '<li class="sess-empty">Loading…</li>';
  }

  // 2. Background-fetch from server + reconcile.
  try {
    const sessions = await backend.listSessions(50);
    await sessionCache.putListCache(sessions);
    cachedSessions = sessions;
    // Drain pending sessions whose ids the server now knows about.
    // Persisted server row supersedes the synthesized one.
    if (pendingSessions.size) {
      for (const id of Array.from(pendingSessions.keys())) {
        if (sessions.some(s => s.id === id)) pendingSessions.delete(id);
      }
    }
    renderListFiltered(listEl, active);

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
    if (viewedSessionId && !sessions.some(s => s.id === viewedSessionId)) {
      if (lastSeenIds.has(viewedSessionId)) {
        // Was here, isn't here anymore → genuinely deleted.
        diag(`sessionDrawer: viewed session ${viewedSessionId} no longer on server, clearing chat`);
        viewedSessionId = null;
        onSessionGoneCb?.();
      }
    }
    for (const s of sessions) lastSeenIds.add(s.id);
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
 *  list. Returns 'sidekick' if not found (sane default — sidekick is
 *  the primary platform; non-sidekick rows must come from server data
 *  that's already been fetched). Used by the composer-read-only path
 *  in main.ts: when source !== 'sidekick', composer is disabled
 *  because cross-platform send isn't supported. */
export function getSourceForChat(id: string | null | undefined): string {
  if (!id) return 'sidekick';
  const row = cachedSessions.find(s => s.id === id);
  return row?.source || 'sidekick';
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
    cachedSessions = sessions;
    await sessionCache.putListCache(sessions);
    const listEl = document.getElementById('sessions-list');
    if (!listEl) return;
    const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
    renderListFiltered(listEl, active);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`sessionDrawer: server filter reconcile failed: ${e?.message || e}`);
  } finally {
    if (filterServerAbort === ctl) filterServerAbort = null;
  }
}

/** Re-render the visible session list with the current filter applied. */
function renderListFiltered(listEl: HTMLElement, activeId: string) {
  // Merge pending (SSE-announced, not-yet-persisted) sessions into the
  // base list before filtering. They survive refresh() cycles so the row
  // stays visible across session-switch even when cachedSessions gets
  // overwritten by the server fetch.
  const merged = mergePending(cachedSessions);
  const filtered = currentFilter
    ? applyFilter(merged, parseQuery(currentFilter))
    : merged;
  // Empty list under a non-empty filter shows "No matches." instead of
  // the generic "No past sessions yet." so the user knows it's the filter
  // (not an empty server) hiding everything.
  if (filtered.length === 0 && currentFilter && merged.length > 0) {
    listEl.innerHTML = '<li class="sess-empty">No matches.</li>';
    return;
  }
  // Only show the "new conversation" placeholder when the active session
  // is genuinely missing from the merged list (= brand-new chat that
  // hasn't even hit /v1/responses yet, so no SSE row either). Once the
  // user sends a message, the pending row covers them.
  const isFresh = !!activeId && !merged.some(s => s.id === activeId);
  renderList(listEl, filtered, activeId, isFresh);
}

/** Fingerprint of the last successful renderList. Compared on every
 *  call; if the (sessions × activeId × placeholder) tuple is unchanged,
 *  we skip the innerHTML='' + N appendChild rebuild — the visible DOM
 *  is already correct. This kills the cache-then-server double-render
 *  in refresh(): if the server returned the same list we just painted
 *  from cache, the second renderList is a no-op. Same for repeated
 *  refresh() calls where nothing meaningfully changed. */
let lastRenderFingerprint: string | null = null;

/** Cheap fingerprint of the visible state. Includes the fields renderRow
 *  reads (id, title, snippet, messageCount, lastMessageAt, source) plus
 *  activeId and the placeholder flag. Anything not in here can change
 *  without us noticing — keep it broad enough that legitimate updates
 *  still trigger a rebuild. */
function renderListFingerprint(sessions: any[], activeId: string, showPlaceholder: boolean): string {
  const rows = sessions.map(s =>
    `${s.id}|${s.title || ''}|${s.snippet || ''}|${s.messageCount || 0}|${s.lastMessageAt || ''}|${s.source || ''}`,
  ).join('\n');
  return `${activeId}::${showPlaceholder ? 'p' : ''}::${rows}`;
}

function renderList(listEl: HTMLElement, sessions: any[], activeId: string, isFresh = false) {
  // Optimistic placeholder: if the adapter's current session isn't in the
  // cached list yet (brand-new conversation, no turn persisted), show a
  // "New conversation" row at the top so the user has immediate visual
  // feedback that the new-chat click landed. Gets replaced by the real
  // row on the next refresh after a reply lands.
  const showPlaceholder = isFresh;

  // Diff-bypass: if nothing the user can see has changed, skip the DOM
  // rebuild entirely. refresh() naturally renders twice (cache + server);
  // most pairs reconcile to the same list and the second rebuild is pure
  // flicker. This one check eliminates ~half the drawer mutations under
  // normal use.
  const fingerprint = renderListFingerprint(sessions, activeId, showPlaceholder);
  if (fingerprint === lastRenderFingerprint) return;

  if (sessions.length === 0 && !showPlaceholder) {
    listEl.innerHTML = '<li class="sess-empty">No past sessions yet.</li>';
    lastRenderFingerprint = fingerprint;
    return;
  }
  listEl.innerHTML = '';
  if (showPlaceholder) listEl.appendChild(renderPlaceholderRow(activeId));
  for (const s of sessions) {
    listEl.appendChild(renderRow(s, activeId));
  }
  // Refresh the visible-row order cache so range/keyboard handlers
  // walk the same list the user sees.
  visibleRowIds = sessions.map((s: any) => String(s.id));
  // Re-paint multi-select highlights after the rebuild — renderRow
  // doesn't carry over the .multiselected class because each LI is
  // freshly created.
  syncMultiSelectClasses();
  lastRenderFingerprint = fingerprint;
}

function renderPlaceholderRow(id: string): HTMLLIElement {
  const li = document.createElement('li');
  li.classList.add('active');
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

function renderRow(s: any, activeId: string): HTMLLIElement {
  const li = document.createElement('li');
  if (s.id === activeId) li.classList.add('active');
  // Expose the chat/session id on the li so tests + future code can
  // target rows without depending on title/snippet text (which may be
  // a placeholder until hermes generates the title).
  li.dataset.chatId = s.id;

  const row = document.createElement('div');
  row.className = 'sess-row';

  const body = document.createElement('div');
  body.className = 'sess-body';

  const snippet = document.createElement('div');
  snippet.className = 'sess-snippet';
  // Prefer user-set title; fall back to snippet; then the id.
  snippet.textContent = s.title || s.snippet || s.id;

  const meta = document.createElement('div');
  meta.className = 'sess-meta';
  // Source badge — shown only for non-sidekick sessions so telegram/
  // slack/whatsapp/etc rows are visually distinguished from the user's
  // primary sidekick transcripts. Sidekick is the default; we don't
  // clutter every row with a redundant "SIDEKICK" label. (api_server
  // is the legacy hermes-backend default name; preserved here for
  // back-compat with any older entries that still report that source.)
  // No "· current" text — the border highlight from li.active communicates
  // the same thing without adding a 4th meta item that would overflow +
  // wrap the row (changing bubble height when selected).
  const sourceBadge = s.source && s.source !== 'sidekick' && s.source !== 'api_server'
    ? `<span style="text-transform:uppercase;font-size:10px;letter-spacing:0.05em;opacity:0.7">${s.source}</span>`
    : '';
  meta.innerHTML =
    `<span>${fmtRelativeTime(s.lastMessageAt)}</span>` +
    `<span>${s.messageCount || 0} msgs</span>` +
    sourceBadge;

  body.appendChild(snippet);
  body.appendChild(meta);
  body.onclick = (ev: MouseEvent) => {
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
    // (Mac: ctrl+click fires contextmenu BEFORE click and suppresses
    // the click entirely. The contextmenu listener below routes that
    // case back into toggleSelection so ctrl+click works the same as
    // on Linux/Windows.)
    // Optimistic highlight: flip the active class synchronously at click
    // time. resume() is async (cache read + server fetch) and on a cache
    // miss can take 5-10s, which was leaving the highlight stale long
    // after the transcript rendered. refresh() still runs later and
    // re-derives from backend state; if everything's consistent the
    // re-render paints the same active row and there's no flicker.
    const listEl = document.getElementById('sessions-list');
    if (listEl) {
      listEl.querySelectorAll('li.active').forEach(el => el.classList.remove('active'));
      li.classList.add('active');
    }
    resume(s.id);
  };
  // macOS Chrome / Safari fire `contextmenu` on ctrl+click instead
  // of `click`, so the onclick handler above never sees that
  // gesture. Intercept the contextmenu event when ctrlKey is set,
  // suppress the OS context menu, and route to the same toggle path
  // so Mac users get the same behavior Linux/Windows users get.
  // Plain right-click (no ctrlKey) is left alone — the browser
  // context menu still appears as expected.
  body.addEventListener('contextmenu', (ev: MouseEvent) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    toggleSelection(s.id);
  });

  // ⋮ menu — rename + delete. Tap opens a small popover; tap outside closes.
  const menuBtn = document.createElement('button');
  menuBtn.className = 'sess-menu-btn';
  menuBtn.title = 'More';
  menuBtn.textContent = '⋮';
  menuBtn.onclick = (e) => { e.stopPropagation(); openMenu(li, s); };

  row.appendChild(body);
  row.appendChild(menuBtn);
  li.appendChild(row);
  return li;
}

function openMenu(li: HTMLLIElement, s: any) {
  // Close any existing open menu first.
  document.querySelectorAll('.sess-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'sess-menu';

  const infoBtn = document.createElement('button');
  infoBtn.textContent = 'Info';
  infoBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); showInfo(s); };

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); promptRename(s); };

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.className = 'danger';
  deleteBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); promptDelete(s); };

  menu.appendChild(infoBtn);
  menu.appendChild(renameBtn);
  menu.appendChild(deleteBtn);
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
  try {
    await backend.renameSession(s.id, title);
    refresh();
  } catch (e: any) {
    diag(`sessionDrawer: rename failed: ${e.message}`);
    alert(`Rename failed: ${e.message}`);
  }
}

async function promptDelete(s: any) {
  const label = s.title || s.snippet?.slice(0, 40) || s.id;
  if (!confirm(`Delete session "${label}"? This cannot be undone.`)) return;
  try {
    await backend.deleteSession(s.id);
    // Server confirmed deletion. Surgically patch the cached list so the
    // drawer paints the row gone immediately — without this, refresh()
    // would read from IDB cache (still has the row) and repaint it for
    // the 5-10s the server fetch takes. No divergence risk: deleteSession
    // threw above if the server call failed, so reaching here means the
    // row IS gone server-side.
    await sessionCache.removeMessagesCache(s.id);
    const cached = await sessionCache.getListCache();
    if (cached?.sessions?.length) {
      const filtered = cached.sessions.filter((c: any) => c.id !== s.id);
      await sessionCache.putListCache(filtered);
    }
    refresh();
  } catch (e: any) {
    diag(`sessionDrawer: delete failed: ${e.message}`);
    alert(`Delete failed: ${e.message}`);
  }
}

/** Monotonically increasing per-click generation counter. Each call
 *  to resume() captures the new value; the cache and server callbacks
 *  bail when they fire under a stale generation (i.e. a newer click
 *  has happened). The previous `optimisticActiveId === id` check was
 *  correct ONLY when no two pending resumes shared an id — the click
 *  sequence A → B → A is precisely the scenario where it fails (A's
 *  first promise sees opt=A again because A2 reset it, mistakes itself
 *  for the live call, and renders stale data over the fresh state).
 *
 *  Generations are id-independent so this hazard is closed. */
let resumeGen = 0;

/** In-flight resume promise + id + generation. A rapid double-tap on
 *  the same row used to fire the resume pipeline N times and append
 *  duplicate chat bubbles. Same-id dedup still applies, but the gen
 *  field guards against returning a superseded promise (which would
 *  silently drop the user's click). */
let resumeInFlight: { id: string; gen: number; promise: Promise<void> } | null = null;

async function resume(id: string) {
  if (resumeInFlight?.id === id && resumeInFlight.gen === resumeGen) {
    return resumeInFlight.promise;
  }
  const myGen = ++resumeGen;
  // Capture the prior viewed id BEFORE we update optimisticActiveId so
  // the shell's onBeforeSwitch hook can clean up empty/abandoned chats
  // (the "New chat / 0 msgs" pollution case Jonathan reported). Skip
  // when we're "navigating" to the same chat — that's a refresh, not
  // a switch.
  //
  // Use `viewedSessionId` (which persists across resume() lifecycles)
  // rather than `optimisticActiveId` (which gets reset to null in our
  // finally block when our gen is still live). Without that
  // distinction, navigate-away cleanup misses the leaving id when the
  // user waits between clicks long enough for the prior resume to
  // fully settle.
  const leaving = viewedSessionId || optimisticActiveId;
  if (leaving && leaving !== id) {
    try { onBeforeSwitchCb?.(leaving); }
    catch (e: any) { diag(`onBeforeSwitch threw: ${e?.message || e}`); }
  }
  // Claim the optimistic active id immediately so refresh() paints the
  // clicked row as active even before the server fetch completes (and
  // even if the server fetch is slow or fails).
  optimisticActiveId = id;
  const promise = (async () => {
    // 1. Paint from cached transcript if we have one — instant feel.
    const cached = await sessionCache.getMessagesCache(id);
    let cacheRendered = false;
    if (cached?.messages?.length) {
      // Stale-generation guard: a newer click has incremented resumeGen.
      // Render the SUPERSEDED chat would clobber the user's just-
      // clicked one. The previous id-equality check was insufficient
      // when two clicks shared an id (A → B → A); generation is.
      if (myGen === resumeGen) {
        log(`sessionDrawer: resumed ${id} from cache (${cached.messages.length} messages)`);
        onResumeCb?.(id, cached.messages);
        scheduleRefresh();
        cacheRendered = true;
      }
    }
    // 2. Always hit the server to reconcile. If cache was stale (server
    //    has new turns), the second replay catches up. resumeSession also
    //    abort-in-flights any stray stream from a prior session.
    try {
      const result: any = await backend.resumeSession(id);
      const messages = result.messages || [];
      const pagination = { firstId: result.firstId ?? null, hasMore: !!result.hasMore };
      await sessionCache.putMessagesCache(id, messages);
      // Stale-generation guard — see above. Bail BEFORE logging so the
      // log line accurately reflects which fetches actually rendered.
      if (myGen !== resumeGen) return;
      // Cache-matched optimization: if the cache cb ALREADY rendered
      // the same N messages and the server returned the same N, skip
      // the re-render to avoid a 500ms-later blank-flicker. Critical:
      // gate on cacheRendered, not just `cached`. For a chat with 0
      // cached messages, the cache cb's render path was skipped (it
      // requires length > 0), so the server cb is the FIRST render
      // — must run, otherwise chat.clear() never fires when the user
      // clicks an empty chat for the SECOND time and the previous
      // chat's transcript leaks through (2026-04-29 Jonathan repro).
      if (cacheRendered && cached && cached.messages.length === messages.length) return;
      log(`sessionDrawer: resumed ${id} (${messages.length} messages, hasMore=${pagination.hasMore})`);
      onResumeCb?.(id, messages, pagination);
      scheduleRefresh();
    } catch (e: any) {
      diag(`sessionDrawer: resume ${id} failed: ${e.message}`);
      // On server failure, drop the optimistic override only if our
      // generation is still live — otherwise we'd clobber a newer
      // click's optimistic state, leaving the user in a phantom-
      // selected limbo.
      if (myGen === resumeGen) {
        optimisticActiveId = null;
        scheduleRefresh();
      }
    }
  })();
  resumeInFlight = { id, gen: myGen, promise };
  try { await promise; } finally {
    // Only clear the in-flight slot if it still belongs to OUR
    // generation. A newer click already replaced it; touching it
    // would corrupt that newer call's state.
    if (resumeInFlight?.gen === myGen) resumeInFlight = null;
    // Clear optimistic only if our generation is still live (no newer
    // click superseded us).
    if (myGen === resumeGen && optimisticActiveId === id) optimisticActiveId = null;
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

  input.addEventListener('input', () => {
    currentFilter = input!.value;
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
      const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
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
        const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
        renderListFiltered(listEl, active);
      }
      // Drop focus so a follow-up Esc can hit other Esc handlers (close
      // settings, close info panel) rather than getting eaten here.
      input!.blur();
    }
  });
  return input;
}

/** Public hook for the global `/` shortcut — focuses the inline filter. */
export function focusFilter() {
  const input = ensureFilterInput();
  if (input) {
    input.focus();
    input.select();
  }
}

export function init(opts: {
  onResume: (id: string, messages: any[]) => void;
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
      const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
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
  // Race guards: skip if the persisted row already exists OR we've already
  // got a pending entry. Both ways the same row is already in the merged
  // render output; firing again would just re-render needlessly.
  if (cachedSessions.some(s => s.id === ev.id)) return;
  if (pendingSessions.has(ev.id)) return;
  // Synthesize a row matching listSessions shape. messageCount defaults
  // to 1 (the user's first turn — the agent reply hasn't persisted yet).
  // lastMessageAt is in seconds (the same epoch unit fmtRelativeTime uses).
  const startedSec = ev.started_at ? Math.floor(Date.parse(ev.started_at) / 1000) : Math.floor(Date.now() / 1000);
  pendingSessions.set(ev.id, {
    id: ev.id,
    title: null,
    snippet: typeof ev.snippet === 'string' ? ev.snippet : '',
    source: ev.source || 'api_server',
    messageCount: 1,
    lastMessageAt: startedSec,
  });
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
  renderListFiltered(listEl, active);
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
// Cross-platform sessions (telegram, slack, etc.) don't fire a sidekick-
// targeted `session_changed` envelope when they get activity — only
// chats backends/hermes/plugin owns (Platform.SIDEKICK) do. To get sub-1s lag
// for "telegram chat just got a new message" → drawer reflects it,
// we'd need a backends/hermes/plugin extension that emits cross-platform
// session_activity envelopes. Pragmatic v1: poll listSessions every
// few seconds while the tab is foregrounded. ~3-5s lag for non-
// sidekick chats; sidekick chats already update live via the existing
// session_changed handler so nothing changes for the primary path.
//
// Pauses when document.visibilityState !== 'visible' so a backgrounded
// PWA isn't doing useless work. Resumes on visibility-change.

const POLL_INTERVAL_MS = 5000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollVisibilityBound = false;

function pollTick(): void {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (!backend.capabilities().sessionBrowsing) return;
  refresh().catch((e: any) => diag(`sessionDrawer poll: refresh failed: ${e?.message}`));
}

function startListPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
  if (!pollVisibilityBound && typeof document !== 'undefined') {
    pollVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      // On returning to visible, kick a refresh immediately so the
      // user doesn't wait up to POLL_INTERVAL_MS for the next tick.
      if (document.visibilityState === 'visible' && backend.capabilities().sessionBrowsing) {
        refresh().catch(() => {});
      }
    });
  }
}

function stopListPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
