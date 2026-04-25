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

/** Last-known full session list from the server (or cache fallback). The
 *  inline filter operates on THIS — re-rendering re-applies the current
 *  filter without re-fetching from the server. Updated whenever refresh()
 *  successfully resolves the server list. */
let cachedSessions: any[] = [];

/** Current filter input value. Empty = no filter. Persisted to IDB so a
 *  page reload restores the same filter. */
let currentFilter: string = '';

/** Debounce handles for the filter input (re-render: 100ms; persist: 500ms). */
let filterRenderTimer: number | null = null;
let filterPersistTimer: number | null = null;

/** Optimistic active-id override for refresh(). The adapter's
 *  `getCurrentSessionId()` doesn't update until `resumeSession()` returns
 *  from the server — on the cache-hit path that meant refresh() was
 *  immediately painting the STALE previous id over the click's optimistic
 *  highlight, producing a flicker (or sticking if the server fetch hung).
 *  Set at click-time, cleared after resume settles. refresh() reads this
 *  first, falls back to backend state when null. */
let optimisticActiveId: string | null = null;

/** The session id whose transcript is CURRENTLY RENDERED in the chat pane.
 *  Set by main.ts via setViewed() when replaySessionMessages runs; cleared
 *  when the user starts a new chat (rotation) so the drawer falls back to
 *  the adapter's conversationName. Takes priority over optimisticActiveId
 *  and conversationName — the drawer should always highlight the row the
 *  user is actually reading, regardless of what the adapter thinks its
 *  current send-target is (they can diverge e.g. after a resume where
 *  conversationName updated but then the user tapped another session and
 *  the adapter's token got superseded). */
let viewedSessionId: string | null = null;
export function setViewed(id: string | null) { viewedSessionId = id; }
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
    renderListFiltered(listEl, active);
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

/** Re-render the visible session list with the current filter applied. */
function renderListFiltered(listEl: HTMLElement, activeId: string) {
  const filtered = currentFilter
    ? applyFilter(cachedSessions, parseQuery(currentFilter))
    : cachedSessions;
  // Empty list under a non-empty filter shows "No matches." instead of
  // the generic "No past sessions yet." so the user knows it's the filter
  // (not an empty server) hiding everything.
  if (filtered.length === 0 && currentFilter && cachedSessions.length > 0) {
    listEl.innerHTML = '<li class="sess-empty">No matches.</li>';
    return;
  }
  // Only show the "new conversation" placeholder when the active session
  // is genuinely missing from the full cached list (= brand-new chat,
  // not yet persisted server-side). When the active session IS in the
  // cached list but got filtered out by the filter input, that's just
  // narrowing — don't surface a misleading "not yet started" row.
  const isFresh = !!activeId && !cachedSessions.some(s => s.id === activeId);
  renderList(listEl, filtered, activeId, isFresh);
}

function renderList(listEl: HTMLElement, sessions: any[], activeId: string, isFresh = false) {
  // Optimistic placeholder: if the adapter's current session isn't in the
  // cached list yet (brand-new conversation, no turn persisted), show a
  // "New conversation" row at the top so the user has immediate visual
  // feedback that the new-chat click landed. Gets replaced by the real
  // row on the next refresh after a reply lands.
  const showPlaceholder = isFresh;

  if (sessions.length === 0 && !showPlaceholder) {
    listEl.innerHTML = '<li class="sess-empty">No past sessions yet.</li>';
    return;
  }
  listEl.innerHTML = '';
  if (showPlaceholder) listEl.appendChild(renderPlaceholderRow(activeId));
  for (const s of sessions) {
    listEl.appendChild(renderRow(s, activeId));
  }
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
  // Source badge — shown only for non-webchat sessions so telegram/cli rows
  // are visually distinguished from the user's primary sidekick transcripts.
  // api_server rows are the default; we don't clutter them with a label.
  // No "· current" text — the border highlight from li.active communicates
  // the same thing without adding a 4th meta item that would overflow +
  // wrap the row (changing bubble height when selected).
  const sourceBadge = s.source && s.source !== 'api_server'
    ? `<span style="text-transform:uppercase;font-size:10px;letter-spacing:0.05em;opacity:0.7">${s.source}</span>`
    : '';
  meta.innerHTML =
    `<span>${fmtRelativeTime(s.lastMessageAt)}</span>` +
    `<span>${s.messageCount || 0} msgs</span>` +
    sourceBadge;

  body.appendChild(snippet);
  body.appendChild(meta);
  body.onclick = () => {
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
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
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

/** In-flight resume promise + id. A rapid double-tap on the same row
 *  used to fire the resume pipeline N times and append duplicate chat
 *  bubbles (one per fire). Coalesce: if the same id is already resuming,
 *  await that promise instead of starting another. */
let resumeInFlight: { id: string; promise: Promise<void> } | null = null;

async function resume(id: string) {
  if (resumeInFlight?.id === id) {
    diag(`sessionDrawer: resume ${id} already in flight, skipping`);
    return resumeInFlight.promise;
  }
  // Claim the optimistic active id immediately so refresh() paints the
  // clicked row as active even before the server fetch completes (and
  // even if the server fetch is slow or fails).
  optimisticActiveId = id;
  const promise = (async () => {
    // 1. Paint from cached transcript if we have one — instant feel.
    const cached = await sessionCache.getMessagesCache(id);
    if (cached?.messages?.length) {
      log(`sessionDrawer: resumed ${id} from cache (${cached.messages.length} messages)`);
      onResumeCb?.(id, cached.messages);
      refresh();
    }
    // 2. Always hit the server to reconcile. If cache was stale (server
    //    has new turns), the second replay catches up. resumeSession also
    //    abort-in-flights any stray stream from a prior session.
    try {
      const result: any = await backend.resumeSession(id);
      const messages = result.messages || [];
      const pagination = { firstId: result.firstId ?? null, hasMore: !!result.hasMore };
      log(`sessionDrawer: resumed ${id} (${messages.length} messages, hasMore=${pagination.hasMore})`);
      await sessionCache.putMessagesCache(id, messages);
      if (!cached || cached.messages.length !== messages.length) {
        onResumeCb?.(id, messages, pagination);
      } else {
        // Cache matched — still need to hand fresh pagination state to the
        // chat pane (cached replay couldn't know firstId/hasMore).
        onResumeCb?.(id, messages, pagination);
      }
      refresh();
    } catch (e: any) {
      diag(`sessionDrawer: resume ${id} failed: ${e.message}`);
      // On server failure, drop the optimistic override so the highlight
      // snaps back to real backend state — don't leave the user in a
      // phantom-selected limbo.
      optimisticActiveId = null;
      refresh();
      if (!cached?.messages?.length) {
        // No cache + server failed → nothing to show. Silent; the drawer
        // row was just tapped, user sees they're not in the session yet.
      }
    }
  })();
  resumeInFlight = { id, promise };
  try { await promise; } finally {
    if (resumeInFlight?.id === id) resumeInFlight = null;
    // Clear optimistic only if it's still OUR id (not another click that
    // supersedes us). Backend.getCurrentSessionId() should now match id
    // on success, so the fallback reads the same value.
    if (optimisticActiveId === id) optimisticActiveId = null;
  }
}

/** Lazy-build the inline filter input above the sessions list, idempotent.
 *  Lives inside #sb-sessions-section so it inherits the existing sidebar
 *  collapse/expand behavior on mobile. Wires the debounced re-render +
 *  IDB-persist on input, and Esc to clear (drops the filter + IDB entry). */
function ensureFilterInput(): HTMLInputElement | null {
  let input = document.getElementById('sess-filter-input') as HTMLInputElement | null;
  if (input) return input;
  const section = document.getElementById('sb-sessions-section');
  const list = document.getElementById('sessions-list');
  if (!section || !list) return null;
  input = document.createElement('input');
  input.id = 'sess-filter-input';
  input.type = 'text';
  input.className = 'sess-filter';
  input.placeholder = 'Filter sessions… (use * for wildcards)';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Filter sessions');
  input.value = currentFilter;
  // Insert just above the <ul>. Section markup is:
  //   <div id="sb-sessions-section">
  //     <div class="sb-section-title">Sessions</div>
  //     <ul id="sessions-list">…</ul>
  //   </div>
  section.insertBefore(input, list);

  input.addEventListener('input', () => {
    currentFilter = input!.value;
    if (filterRenderTimer != null) clearTimeout(filterRenderTimer);
    if (filterPersistTimer != null) clearTimeout(filterPersistTimer);
    filterRenderTimer = setTimeout(() => {
      filterRenderTimer = null;
      const listEl = document.getElementById('sessions-list');
      if (!listEl) return;
      const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
      renderListFiltered(listEl, active);
    }, 100) as unknown as number;
    filterPersistTimer = setTimeout(() => {
      filterPersistTimer = null;
      // Empty filter → drop the persisted record so the next reload
      // doesn't paint a stale "No matches." until refresh resolves.
      if (currentFilter) putStoredFilter(currentFilter);
      else clearStoredFilter();
    }, 500) as unknown as number;
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

export function init(opts: { onResume: (id: string, messages: any[]) => void }) {
  onResumeCb = opts.onResume;
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
  if (enabled) refresh();
}
