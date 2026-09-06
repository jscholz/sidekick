/**
 * @fileoverview cmd+K command palette — search across the cached session
 * list (instant) and against the active backend's message-search index
 * (debounced 300ms, via `backend.search('both', q, …)`). Backends without
 * a search implementation (openclaw, openai-compat, hermes-gateway today)
 * return an empty result and the palette degrades to the cached-sessions
 * filter only.
 *
 * Layout: <dialog> modal mirroring the session-info-dialog pattern in
 * sessionDrawer.ts (centered, ::backdrop, click-outside-to-close, Esc
 * built into <dialog>). Two sections — Sessions (top, instant) and
 * Messages (bottom, network) — keyboard navigable as one flat list.
 *
 * Enter on either kind resumes the underlying session; we do NOT
 * scroll-to-specific-message for message hits — that's a deferred follow-up.
 */

import * as backend from './backend.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as switchCtl from './switchController.ts';
import { parseQuery, applyFilter } from './sessionFilter.ts';
import type { SearchMessageHit as ServerMessageHit } from './proxyClientTypes.ts';
import { diag } from './util/log.ts';
import * as headerTitle from './headerTitle.ts';

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

/** Resume callback supplied by main.ts. Session-hit activations (no
 *  specific message target) funnel through this so we don't have to
 *  re-implement replaySessionMessages here. Message-hit activations
 *  go through ``onDrillToMessage`` instead (see below). */
let onResumeCb: ((tok: switchCtl.SwitchToken, messages: any[], pagination?: any, targetMessageId?: string) => void) | null = null;
let onBeforeSwitchCb: ((leavingId: string | null) => void) | null = null;
/** Drill-to-message callback for message hits. Routes through the
 *  same path pin clicks + activity opens use (main.ts drillToChatMessage),
 *  which guarantees the ``around=<parley_id>`` window fetch lands so
 *  the target row exists in the DOM before scrollIntoView runs.
 *
 *  History: 2026-06-23 — cmd+K used to call onResumeCb for message hits
 *  too, which performs only the TAIL load. If the matched message was
 *  older than the initial replay window (typical for FTS hits like
 *  "pareto" from months ago in a long chat), the target row never
 *  rendered, scroll silently no-op'd, and the user saw "click did
 *  nothing" with intermittent success when the random-luck of the
 *  cached IDB happened to have the row. drillToChatMessage covers
 *  both: in-DOM scroll + flash if present, around-window fetch
 *  otherwise. */
let onDrillToMessageCb: ((chatId: string, msgId: string) => Promise<boolean>) | null = null;

export function init(opts: {
  onResume: (tok: switchCtl.SwitchToken, messages: any[], pagination?: any, targetMessageId?: string) => void;
  /** Same hook as sessionDrawer.init's onBeforeSwitch — fires with the
   *  chat being navigated AWAY from at the moment a palette hit
   *  activates. Lets the shell drop empty/abandoned chats. */
  onBeforeSwitch?: (leavingId: string | null) => void;
  /** Required for message hits — see ``onDrillToMessageCb`` above. */
  onDrillToMessage?: (chatId: string, msgId: string) => Promise<boolean>;
}) {
  onResumeCb = opts.onResume;
  onBeforeSwitchCb = opts.onBeforeSwitch || null;
  onDrillToMessageCb = opts.onDrillToMessage || null;
  // Modal-open shortcut. Listen at document level so it works no matter
  // what's focused (including inside the composer textarea — cmd+K is
  // explicit enough that it should always win).
  //
  // Platform-aware: on Mac, only Cmd+K opens search. Ctrl+K is reserved
  // for the Emacs-style cut-to-EOL binding in the composer (see
  // composer.ts). On Windows/Linux, Ctrl+K is the standard convention
  // for command palettes.
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  document.addEventListener('keydown', (e) => {
    const palette = isMac
      ? (e.metaKey && !e.ctrlKey)
      : (e.ctrlKey && !e.metaKey);
    if (palette && (e.key === 'k' || e.key === 'K')) {
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
    // Instant client-side paint of the sessions section over the
    // cached list — keeps the modal feeling immediate while the
    // server round-trip is in flight.
    rerenderSessions(q);
    if (messagesDebounceTimer != null) clearTimeout(messagesDebounceTimer);
    if (!q.trim()) {
      // Clear messages section + cancel anything in flight. Sessions
      // already rerendered above (full cached list, top 10).
      if (messagesAbortCtl) { messagesAbortCtl.abort(); messagesAbortCtl = null; }
      if (messagesListEl) messagesListEl.innerHTML = '';
      if (messagesStatusEl) messagesStatusEl.textContent = '';
      rebuildVisibleHits();
      return;
    }
    if (messagesStatusEl) messagesStatusEl.textContent = '…';
    // Debounce backend search — don't pummel server with one query per
    // keystroke. 300ms hits the sweet spot for a chunky type-and-pause.
    // backend.search(q, 'both') returns sessions + messages in one round
    // trip, so the server-authoritative sessions list reconciles into the
    // panel as well (covers matches outside the cached top-50). Backends
    // without a search implementation return {sessions:[], hits:[]} and
    // the messages section just stays empty.
    messagesDebounceTimer = setTimeout(() => {
      messagesDebounceTimer = null;
      runUnifiedSearch(q);
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

/** Run a single round-trip via backend.search('both') — pulls sessions
 *  (server-authoritative, may include rows outside the cached top-50)
 *  and message FTS hits in one request. The sessions section is repainted
 *  with the server-truth result so deep-history matches surface.
 *  AbortController is shared with the legacy `messagesAbortCtl` slot
 *  so an in-flight earlier query gets cancelled correctly. Backends
 *  without an index return `{sessions:[], hits:[]}`; the cached-sessions
 *  paint from rerenderSessions() above is what the user actually sees. */
async function runUnifiedSearch(q: string) {
  if (messagesAbortCtl) messagesAbortCtl.abort();
  messagesAbortCtl = new AbortController();
  try {
    const result = await backend.search(q, 'both', { limit: 20, signal: messagesAbortCtl.signal });
    if (!messagesListEl || !messagesStatusEl || !sessionsListEl) return;
    // Sessions section: only repaint from the SERVER result if the
    // active backend actually has a search index. Otherwise the
    // cached client-side fuzzy filter (painted by rerenderSessions
    // on every keystroke) is the answer — we do not want to clobber
    // it with an empty server response. Pre-fix bug: a hermes-gateway
    // user typing "lon" would briefly see fuzzy hits, then watch them
    // disappear 300ms later when the empty server search overwrote
    // the section with "No matching sessions."
    if (backend.hasSearch()) {
      const topSessions = result.sessions.slice(0, 10);
      // The user's RENAMED session title lives in parley.db
      // conversation_titles (client-cached), NOT in the hermes FTS index —
      // so server search results carry the stale/auto title (often empty,
      // → renderSessionRow falls back to the raw `parley:<uuid>` id).
      // Merge the cached override title by id so the server repaint doesn't
      // clobber the name the user gave it (field 2026-05-27: search match
      // flashed the real name, then ~300ms later showed the raw id).
      const titleById = new Map(
        sessionDrawer.getCachedSessions().map((c: any) => [c.id, c.title]),
      );
      sessionsListEl.innerHTML = '';
      if (topSessions.length === 0 && q.trim()) {
        const empty = document.createElement('li');
        empty.className = 'cmdk-empty';
        empty.textContent = 'No matching sessions.';
        sessionsListEl.appendChild(empty);
      } else {
        for (const s of topSessions) {
          const title = titleById.get(s.id) || s.title || '';
          sessionsListEl.appendChild(renderSessionRow(title ? { ...s, title } : s));
        }
      }
    }
    // Messages section: always repaint. Backends without a search
    // index return result.hits = [] and the status flips to "no
    // matches" — that's accurate for messages (we can't fuzzy-match
    // message bodies client-side; cached IDB only stores transcripts
    // for chats the user has resumed).
    messagesListEl.innerHTML = '';
    if (result.error) {
      messagesStatusEl.textContent = result.error;
      rebuildVisibleHits();
      return;
    }
    if (!backend.hasSearch()) {
      messagesStatusEl.textContent = '';
    } else {
      messagesStatusEl.textContent = result.hits.length ? '' : 'no matches';
      for (const h of result.hits) {
        messagesListEl.appendChild(renderMessageRow(h));
      }
    }
    rebuildVisibleHits();
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`cmdk: unified search failed: ${e?.message || e}`);
    if (messagesStatusEl) messagesStatusEl.textContent = 'error';
  }
}

/** Compact date+time for a message hit's meta line. Unix-seconds in,
 *  "Jun 11, 10:34 PM" out (year added when not the current year).
 *  Empty string for missing/zero timestamps — old backends or
 *  DOM-rebuilt hits don't carry one. */
function formatHitTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

function renderMessageRow(h: ServerMessageHit): HTMLLIElement {
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
  const when = formatHitTime(h.timestamp);
  if (when) parts.push(when);
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
  // Session-hit activations resume via backend.resumeSession + the
  // standard onResume callback (replaySessionMessages in main.ts).
  // Message-hit activations route through onDrillToMessageCb so they
  // get the around-window fetch when the target is below the initial
  // tail — see the onDrillToMessageCb docstring for the 2026-06-23
  // history of why this distinction matters.
  const id = hit.kind === 'session' ? hit.id : hit.session_id;
  if (!id) return;
  close();
  // Fire onBeforeSwitch with the chat we're navigating AWAY from
  // BEFORE the activation flips the active pointer. Lets the shell
  // clean up empty/abandoned chats so they don't pollute the drawer.
  const leaving = backend.getCurrentSessionId?.() ?? null;
  if (leaving !== id) {
    try { onBeforeSwitchCb?.(leaving); }
    catch (e: any) { diag(`cmdk: onBeforeSwitch threw: ${e?.message || e}`); }
  }
  if (hit.kind === 'message' && hit.message_id && onDrillToMessageCb) {
    // drillToChatMessage handles the cross-session switch + around-
    // window fetch + scroll-to-bubble atomically (see main.ts). It
    // returns true on success, false on stale / not-found; either way
    // the modal is already closed and any further UI is the drill's
    // concern (status banner, etc.).
    try {
      await onDrillToMessageCb(id, String(hit.message_id));
    } catch (e: any) {
      diag(`cmdk: drill ${id} msg=${hit.message_id} failed: ${e?.message || e}`);
    }
    return;
  }
  // Session-hit path (or message-hit when no drill callback wired —
  // legacy/test rigs). Mint the switch token BEFORE the fetch: the
  // optimistic highlight flips now, and a drawer click landing during
  // the await supersedes this — the paint below then refuses.
  const targetMessageId = hit.kind === 'message' ? String(hit.message_id) : undefined;
  // 'cmdk' is user-class, so this begin() is never refused; the null
  // branch exists because begin()'s contract allows it, not because this
  // path can hit it.
  const tok = switchCtl.begin(id, 'cmdk', targetMessageId);
  if (!tok) {
    diag(`cmdk: switch to ${id} refused`);
    return;
  }
  // Header title (UX_DETERMINISM_PLAN Phase 0 #1): a palette pick is a
  // switch-begin site same as a drawer row click — reflect the "Opening
  // <title>…" state immediately. After the guard: a refused begin() claims
  // nothing, so there is nothing for the header to reflect.
  headerTitle.sync();
  // Palette pick = user intent to view — the seen effects (unread chip
  // + badge clear, activity read-mark) fire at the pick, not after the
  // resumeSession fetch commits the view. (The message-hit DRILL branch
  // above deliberately stays commit-time-cleared — see the note in
  // sessionDrawer.drillTo about the drill scroll race.)
  sessionDrawer.noteViewIntent(id);
  try {
    const result: any = await backend.resumeSession(id);
    const messages = result.messages || [];
    const pagination = { firstId: result.firstId ?? null, hasMore: !!result.hasMore };
    onResumeCb?.(tok, messages, pagination, targetMessageId);
  } catch (e: any) {
    diag(`cmdk: resume ${id} failed: ${e?.message || e}`);
  } finally {
    switchCtl.clearOptimisticIfCurrent(tok);
    // Same rationale as sessionDrawer.resume()'s finally: an error/no-op
    // path can clear optimistic without ever committing a view, which
    // would otherwise leave the header stuck on "Opening…".
    headerTitle.sync();
  }
}

