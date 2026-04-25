/**
 * @fileoverview cmd+K command palette — search across the cached session
 * list (instant) and against hermes' messages_fts index (debounced 300ms,
 * over /api/hermes/search).
 *
 * Layout: <dialog> modal mirroring the session-info-dialog pattern in
 * sessionDrawer.ts (centered, ::backdrop, click-outside-to-close, Esc
 * built into <dialog>). Two sections — Sessions (top, instant) and
 * Messages (bottom, network) — keyboard navigable as one flat list.
 *
 * Enter on either kind resumes the underlying session; we do NOT
 * scroll-to-specific-message for message hits — that's deferred. See the
 * cmdk follow-ups block in ~/code/openclaw-agent-private/backlog.md.
 */

import * as backend from './backend.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import { parseQuery, applyFilter } from './sessionFilter.ts';
import { diag } from './util/log.ts';

type SessionHit = {
  kind: 'session';
  id: string;
  title: string;
  meta: string;
};
type MessageHit = {
  kind: 'message';
  session_id: string;
  message_id: number;
  role: string;
  snippet: string;
  timestamp: number;
  session_title?: string;
  session_source?: string;
};
type Hit = SessionHit | MessageHit;

let dialogEl: HTMLDialogElement | null = null;
let inputEl: HTMLInputElement | null = null;
let sessionsListEl: HTMLElement | null = null;
let messagesListEl: HTMLElement | null = null;
let messagesStatusEl: HTMLElement | null = null;

/** Flat array of Hits used for keyboard navigation. Re-derived every time
 *  results re-render, so arrow up/down can always land on the right row. */
let visibleHits: Hit[] = [];
let activeIdx = 0;
let messagesDebounceTimer: number | null = null;
let messagesAbortCtl: AbortController | null = null;

/** Resume callback supplied by main.ts. Both session + message hits
 *  funnel through it so we don't have to re-implement replaySessionMessages
 *  here. (Backend.resumeSession returns the messages payload.) */
let onResumeCb: ((id: string, messages: any[], pagination?: any) => void) | null = null;

export function init(opts: {
  onResume: (id: string, messages: any[], pagination?: any) => void;
}) {
  onResumeCb = opts.onResume;
  // Modal-open shortcut. Listen at document level so it works no matter
  // what's focused (including inside the composer textarea — cmd+K is
  // explicit enough that it should always win).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      open();
    }
  });
}

/** Open the modal. Builds the DOM lazily on first call so boot doesn't
 *  pay the cost up-front. Subsequent opens reuse the same <dialog>. */
export function open() {
  ensureDialog();
  if (!dialogEl || !inputEl) return;
  // Already open — re-focus the input so a second cmd+K acts like
  // "search again" rather than throwing on showModal().
  if (dialogEl.open) {
    inputEl.focus();
    inputEl.select();
    return;
  }
  // Reset state for each open. Keeping the previous query around would be
  // a "recent searches" feature — explicitly out of scope for v1.
  inputEl.value = '';
  visibleHits = [];
  activeIdx = 0;
  if (sessionsListEl) sessionsListEl.innerHTML = '';
  if (messagesListEl) messagesListEl.innerHTML = '';
  if (messagesStatusEl) messagesStatusEl.textContent = '';
  // Render an initial sessions snapshot (no filter = full list, top 10)
  // so the modal isn't empty before the user types.
  rerenderSessions('');
  dialogEl.showModal();
  // showModal() autofocuses the first focusable element, which is the
  // input due to DOM order — but explicitly focus + select to be safe
  // across browsers and iOS PWA quirks.
  inputEl.focus();
  inputEl.select();
}

function close() {
  if (dialogEl?.open) dialogEl.close();
}

function ensureDialog() {
  if (dialogEl) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'cmdk-dialog';
  dlg.innerHTML = `
    <div class="cmdk-input-row">
      <input type="text" class="cmdk-input" placeholder="Search sessions and messages…" spellcheck="false" autocomplete="off" />
    </div>
    <div class="cmdk-results">
      <div class="cmdk-section-title">Sessions</div>
      <ul class="cmdk-list" data-section="sessions"></ul>
      <div class="cmdk-section-title cmdk-messages-title">Messages <span class="cmdk-status"></span></div>
      <ul class="cmdk-list" data-section="messages"></ul>
    </div>
    <form method="dialog" class="cmdk-close-row"><button>Close</button></form>
  `;
  document.body.appendChild(dlg);
  dialogEl = dlg as HTMLDialogElement;
  inputEl = dlg.querySelector('.cmdk-input') as HTMLInputElement;
  sessionsListEl = dlg.querySelector('ul[data-section="sessions"]') as HTMLElement;
  messagesListEl = dlg.querySelector('ul[data-section="messages"]') as HTMLElement;
  messagesStatusEl = dlg.querySelector('.cmdk-status') as HTMLElement;

  // Click outside (on the ::backdrop / dialog itself, not children) closes.
  // Same pattern as session-info-dialog.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('close', () => {
    // Cancel any in-flight search request — its result is no longer
    // relevant (the input it referred to is gone) and would be a wasted
    // server hit if it landed.
    if (messagesAbortCtl) {
      messagesAbortCtl.abort();
      messagesAbortCtl = null;
    }
    if (messagesDebounceTimer != null) {
      clearTimeout(messagesDebounceTimer);
      messagesDebounceTimer = null;
    }
  });

  inputEl.addEventListener('input', () => {
    const q = inputEl!.value;
    rerenderSessions(q);
    // Debounce backend search — don't pummel server with one query per
    // keystroke. 300ms hits the sweet spot for a chunky type-and-pause.
    if (messagesDebounceTimer != null) clearTimeout(messagesDebounceTimer);
    if (!q.trim()) {
      // Clear messages section + cancel anything in flight.
      if (messagesAbortCtl) { messagesAbortCtl.abort(); messagesAbortCtl = null; }
      if (messagesListEl) messagesListEl.innerHTML = '';
      if (messagesStatusEl) messagesStatusEl.textContent = '';
      rebuildVisibleHits();
      return;
    }
    if (messagesStatusEl) messagesStatusEl.textContent = '…';
    messagesDebounceTimer = setTimeout(() => {
      messagesDebounceTimer = null;
      runMessageSearch(q);
    }, 300) as unknown as number;
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = visibleHits[activeIdx];
      if (hit) activate(hit);
    }
    // Esc is built-in on <dialog> — fires the close event.
  });
}

/** Render the sessions section against the cached session list. Instant —
 *  no network. Top 10 results to keep the modal compact. */
function rerenderSessions(q: string) {
  if (!sessionsListEl) return;
  const sessions = sessionDrawer.getCachedSessions();
  const filtered = q.trim() ? applyFilter(sessions, parseQuery(q)) : sessions;
  const top = filtered.slice(0, 10);
  sessionsListEl.innerHTML = '';
  if (top.length === 0) {
    if (q.trim()) {
      const empty = document.createElement('li');
      empty.className = 'cmdk-empty';
      empty.textContent = 'No matching sessions.';
      sessionsListEl.appendChild(empty);
    }
  } else {
    for (const s of top) {
      sessionsListEl.appendChild(renderSessionRow(s));
    }
  }
  rebuildVisibleHits();
}

function renderSessionRow(s: any): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'cmdk-row';
  li.dataset.kind = 'session';
  li.dataset.id = s.id;
  const title = document.createElement('div');
  title.className = 'cmdk-row-title';
  title.textContent = s.title || s.snippet || s.id;
  const meta = document.createElement('div');
  meta.className = 'cmdk-row-meta';
  const parts: string[] = [];
  if (s.source) parts.push(s.source);
  if (typeof s.messageCount === 'number') parts.push(`${s.messageCount} msgs`);
  meta.textContent = parts.join(' · ');
  li.appendChild(title);
  li.appendChild(meta);
  li.addEventListener('mouseenter', () => setActiveByElement(li));
  li.addEventListener('click', () => {
    activate({
      kind: 'session',
      id: s.id,
      title: s.title || s.snippet || s.id,
      meta: meta.textContent || '',
    });
  });
  return li;
}

async function runMessageSearch(q: string) {
  if (messagesAbortCtl) messagesAbortCtl.abort();
  messagesAbortCtl = new AbortController();
  try {
    const url = `/api/hermes/search?q=${encodeURIComponent(q)}&limit=20`;
    const res = await fetch(url, { signal: messagesAbortCtl.signal });
    if (!res.ok) {
      if (messagesStatusEl) messagesStatusEl.textContent = 'error';
      return;
    }
    const body = await res.json();
    const hits = (body.hits || []) as MessageHit[];
    if (!messagesListEl || !messagesStatusEl) return;
    messagesListEl.innerHTML = '';
    if (body.error) {
      messagesStatusEl.textContent = body.error;
      rebuildVisibleHits();
      return;
    }
    messagesStatusEl.textContent = hits.length ? '' : 'no matches';
    for (const h of hits) {
      messagesListEl.appendChild(renderMessageRow(h));
    }
    rebuildVisibleHits();
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`cmdk: messages search failed: ${e?.message || e}`);
    if (messagesStatusEl) messagesStatusEl.textContent = 'error';
  }
}

function renderMessageRow(h: MessageHit): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'cmdk-row';
  li.dataset.kind = 'message';
  li.dataset.id = String(h.message_id);
  // Stash session_id + role so rebuildVisibleHits() can recover them
  // from the DOM without a side-channel hits[] mirror.
  li.dataset.sessionId = h.session_id;
  if (h.role) li.dataset.role = h.role;
  const title = document.createElement('div');
  title.className = 'cmdk-row-title';
  title.textContent = h.snippet || '(empty)';
  const meta = document.createElement('div');
  meta.className = 'cmdk-row-meta';
  const parts: string[] = [];
  if (h.session_title) parts.push(h.session_title);
  if (h.session_source) parts.push(h.session_source);
  if (h.role) parts.push(h.role);
  meta.textContent = parts.join(' · ');
  li.appendChild(title);
  li.appendChild(meta);
  li.addEventListener('mouseenter', () => setActiveByElement(li));
  li.addEventListener('click', () => {
    activate({ ...h, kind: 'message' });
  });
  return li;
}

function rebuildVisibleHits() {
  visibleHits = [];
  if (sessionsListEl) {
    sessionsListEl.querySelectorAll('li.cmdk-row').forEach((el) => {
      const li = el as HTMLLIElement;
      visibleHits.push({
        kind: 'session',
        id: li.dataset.id || '',
        title: li.querySelector('.cmdk-row-title')?.textContent || '',
        meta: li.querySelector('.cmdk-row-meta')?.textContent || '',
      });
    });
  }
  if (messagesListEl) {
    messagesListEl.querySelectorAll('li.cmdk-row').forEach((el) => {
      const li = el as HTMLLIElement;
      // We can't fully reconstruct a MessageHit from the DOM, but we
      // only need session_id + message_id for activation. Cache them as
      // dataset extras when the row was rendered.
      visibleHits.push({
        kind: 'message',
        session_id: li.dataset.sessionId || '',
        message_id: parseInt(li.dataset.id || '0', 10),
        role: li.dataset.role || '',
        snippet: li.querySelector('.cmdk-row-title')?.textContent || '',
        timestamp: 0,
      });
    });
  }
  activeIdx = Math.min(activeIdx, Math.max(0, visibleHits.length - 1));
  paintActive();
}

function moveActive(delta: number) {
  if (!visibleHits.length) return;
  activeIdx = (activeIdx + delta + visibleHits.length) % visibleHits.length;
  paintActive();
}

function paintActive() {
  if (!dialogEl) return;
  const all = dialogEl.querySelectorAll('li.cmdk-row');
  all.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  // Scroll active row into view inside the modal results pane.
  const activeEl = all[activeIdx] as HTMLElement | undefined;
  activeEl?.scrollIntoView({ block: 'nearest' });
}

function setActiveByElement(el: HTMLLIElement) {
  if (!dialogEl) return;
  const all = Array.from(dialogEl.querySelectorAll('li.cmdk-row'));
  const idx = all.indexOf(el);
  if (idx >= 0) {
    activeIdx = idx;
    paintActive();
  }
}

async function activate(hit: Hit) {
  // Both kinds resume the session via backend.resumeSession + the
  // standard onResume callback (which is replaySessionMessages in
  // main.ts). For message hits we deliberately do NOT scroll to the
  // specific message id — that's queued in the deferred-feature block
  // in ~/code/openclaw-agent-private/backlog.md (see "cmdk follow-ups").
  const id = hit.kind === 'session' ? hit.id : hit.session_id;
  if (!id) return;
  close();
  try {
    const result: any = await backend.resumeSession(id);
    const messages = result.messages || [];
    const pagination = { firstId: result.firstId ?? null, hasMore: !!result.hasMore };
    onResumeCb?.(id, messages, pagination);
  } catch (e: any) {
    diag(`cmdk: resume ${id} failed: ${e?.message || e}`);
  }
}

