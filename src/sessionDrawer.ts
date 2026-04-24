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

let onResumeCb: ((id: string, messages: any[]) => void) | null = null;

/** Optimistic active-id override for refresh(). The adapter's
 *  `getCurrentSessionId()` doesn't update until `resumeSession()` returns
 *  from the server — on the cache-hit path that meant refresh() was
 *  immediately painting the STALE previous id over the click's optimistic
 *  highlight, producing a flicker (or sticking if the server fetch hung).
 *  Set at click-time, cleared after resume settles. refresh() reads this
 *  first, falls back to backend state when null. */
let optimisticActiveId: string | null = null;

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
  // Prefer the optimistic id over backend state while a resume is mid-flight.
  const active = optimisticActiveId || backend.getCurrentSessionId?.() || '';

  // 1. Render from cache if available.
  const cached = await sessionCache.getListCache();
  if (cached?.sessions?.length) {
    renderList(listEl, cached.sessions, active);
  } else {
    listEl.innerHTML = '<li class="sess-empty">Loading…</li>';
  }

  // 2. Background-fetch from server + reconcile.
  try {
    const sessions = await backend.listSessions(50);
    await sessionCache.putListCache(sessions);
    renderList(listEl, sessions, active);
  } catch (e: any) {
    diag(`sessionDrawer: list failed: ${e.message}`);
    if (!cached?.sessions?.length) {
      listEl.innerHTML = `<li class="sess-empty">Failed to load: ${e.message}</li>`;
    }
    // Else: keep the cached view — user can still tap + resume from cache.
  }
}

function renderList(listEl: HTMLElement, sessions: any[], activeId: string) {
  // Optimistic placeholder: if the adapter's current session isn't in the
  // server-returned list yet (brand-new conversation, no turn persisted),
  // show a "New conversation" row at the top so the user has immediate
  // visual feedback that the new-chat click landed. Gets replaced by the
  // real row on the next refresh after a reply lands.
  const activeInList = activeId && sessions.some(s => s.id === activeId);
  const showPlaceholder = activeId && !activeInList;

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
  const sourceBadge = s.source && s.source !== 'api_server'
    ? `<span style="text-transform:uppercase;font-size:10px;letter-spacing:0.05em;opacity:0.7">${s.source}</span>`
    : '';
  meta.innerHTML =
    `<span>${fmtRelativeTime(s.lastMessageAt)}</span>` +
    `<span>${s.messageCount || 0} msgs</span>` +
    sourceBadge +
    (s.id === activeId ? '<span style="color:var(--primary)">· current</span>' : '');

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

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); promptRename(s); };

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.className = 'danger';
  deleteBtn.onclick = (e) => { e.stopPropagation(); menu.remove(); promptDelete(s); };

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

async function promptRename(s: any) {
  const current = s.title || '';
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
      const { messages } = await backend.resumeSession(id);
      log(`sessionDrawer: resumed ${id} (${messages.length} messages)`);
      await sessionCache.putMessagesCache(id, messages);
      // Only re-replay if server actually differs from cached count.
      // Full diff isn't worth it — count mismatch is the common stale signal.
      if (!cached || cached.messages.length !== messages.length) {
        onResumeCb?.(id, messages);
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

export function init(opts: { onResume: (id: string, messages: any[]) => void }) {
  onResumeCb = opts.onResume;
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
