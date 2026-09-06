/**
 * @fileoverview Proxy-client BackendAdapter — wraps the local parley
 * proxy's /api/parley/* HTTP+SSE surface (served by
 * proxy/parley/) into the BackendAdapter contract. Fully
 * agent-agnostic: the proxy translates /api/parley/* to the agent
 * contract (/v1/*) on its own. Filename was historically
 * `hermes-gateway.ts`; renamed during the post-refactor cleanup
 * after the proxy module rename to proxy/parley/.
 *
 * Wire path:
 *   PWA → POST /api/parley/messages {chat_id, text}    (fire-and-forget)
 *           ↓ (proxy WS client)
 *   hermes platform adapter (in-process, ws://127.0.0.1:8645)
 *           ↓
 *   gateway agent run, owns sessions per chat_id
 *           ↓
 *   adapter → reply_delta / reply_final / image / typing /
 *             session_changed / notification envelopes back over WS
 *           ↓
 *   proxy fans every envelope onto /api/parley/stream (one
 *   persistent SSE channel for the lifetime of the PWA tab).
 *           ↓
 *   we parse here; emit normalized BackendAdapter events. Each
 *   envelope carries chat_id; events for the active view stream
 *   into the live UI, events for background views accumulate as
 *   system rows in those threads.
 *
 * Why a single persistent stream instead of per-POST SSE: hermes
 * platform adapters emit multiple `send()` calls per turn (bootstrap
 * nudges, the actual reply, possibly tool-result-as-text). The old
 * per-POST SSE closed on the first reply_final and dropped every
 * subsequent bubble. There are no turn boundaries on the wire —
 * telegram/slack/signal adapters are designed the same way.
 *
 * chat_id allocation: PWA-local UUID per conversation, stored in IDB
 * via src/conversations.ts. The proxy / adapter never mint chat_ids
 * — they're a PWA concern. Lazy: we don't allocate until the user
 * sends their first message OR explicitly clicks "New chat".
 *
 * @typedef {import('./proxyClientTypes.ts').BackendAdapter} BackendAdapter
 * @typedef {import('./proxyClientTypes.ts').ConnectOpts} ConnectOpts
 * @typedef {import('./proxyClientTypes.ts').SendOpts} SendOpts
 */

import { log, diag } from './util/log.ts';
import { apiOrigin } from './apiBase.ts';
import * as conversations from './conversations.ts';
import * as sessionCache from './sessionCache.ts';
import * as transcriptStore from './transcript/store.ts';
import { markRecentlyDeleted, isRecentlyDeleted } from './sessionOps.ts';
import * as switchCtl from './switchController.ts';
import { isDevMode } from './util/devMode.ts';

let subs: any = null;
let connected = false;
/** In-process memo of the IDB "active conversation" row
 *  (conversations.getActive/setActive) — a CACHE, never an authority.
 *
 *  It used to be the second source of truth for "which chat am I in",
 *  and resumeSession() flipped it FIRST with a comment claiming the
 *  active chat_id was "the single source of truth". That was false in
 *  both directions: the shell had already moved addressing onto view
 *  state (main.ts currentChatId), and on 2026-09-06 a boot restore's
 *  resumeSession re-aimed this pointer under a user who had tapped a
 *  different chat three seconds earlier (UX_DETERMINISM_PLAN §1, §3).
 *
 *  What it is now (UX_DETERMINISM_PLAN §6 rule 2 — exactly one source of
 *  truth for the current conversation, and it lives in switchController):
 *    - hydrated on connect() so getCurrentSessionId() can answer
 *      synchronously BEFORE any view has committed (fresh boot),
 *    - written wherever we write conversations.setActive(), so the memo
 *      and the IDB row never disagree,
 *    - read only by getCurrentSessionId(), whose remaining jobs are the
 *      pre-view boot landing and the lazy-mint of a first chat.
 *  Nothing addresses a send from it. See sendMessage below. */
let lastActiveChatId: string | null = null;
/** Health-poll handle. We use GET /api/parley/sessions as a cheap
 *  liveness probe — its handler is the same one the drawer calls, so
 *  there's no separate health route to mount. */
let healthTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_INTERVAL_MS = 30_000;
/** Page size for scroll-driven pagination (loadEarlier/loadLater). The
 *  server defaults to 200 msgs/page when no limit is sent; in deep
 *  tool-heavy histories that's ~1.3MB per page, which made scroll
 *  pagination feel slow and the edge spinner blink in and out before a
 *  page landed. A smaller, explicit page keeps each round trip light so
 *  the spinner is a brief, reliable "loading from server" signal. */
const PAGE_LIMIT = 60;
/** Persistent stream EventSource — every adapter envelope arrives here.
 *  EventSource auto-reconnects on transient failures (5s retry hint set
 *  by the server), so we open once on connect() and let it handle redial.
 *  Mobile-Safari background-kill / cellular handoff / suspended radio do
 *  NOT trigger native retry reliably, so OS lifecycle listeners
 *  (visibility/online/pageshow) call forceReconnect() to recreate it. */
let streamES: EventSource | null = null;
/** Wired-once flag for the OS-lifecycle listeners (visibility/online/
 *  pageshow). Bound on the first connect() so we don't stack duplicate
 *  handlers across reconnect cycles. */
let lifecycleHandlersBound = false;
/** Highest server-issued event id seen on the stream. Captured from
 *  every received frame so that when forceReconnect() opens a fresh
 *  EventSource — which can't carry over the browser's own
 *  Last-Event-ID state — we can pass the cursor explicitly via
 *  `?last_event_id=N`. Without this, manual reconnect makes the
 *  server treat us as a fresh subscriber and replay the entire ring,
 *  which paints duplicate bubbles for every visibility flip. */
let lastEventId: number | null = null;
/** Debounce token for reconcileActiveChat — coalesces the burst of
 *  forceReconnect calls a typical foreground transition produces
 *  (visibility, then online, then pageshow within the same tick). */
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
/** Wall-clock of the last forceReconnect (or initial connect) — drives
 *  the "down for >10s" reconcile decision. Updated whenever
 *  forceReconnect runs so a long PWA-backgrounded interval shows up as
 *  a large gap when the next forceReconnect fires (Date.now() minus the
 *  previous reconnect time). */
let lastReconnectAt = 0;
/** Reconcile debt (#204, field 2026-06-12): a gap-triggered transcript
 *  reconcile that FAILS must stay owed until one succeeds. Without
 *  this, the failure path was terminal: visibility-visible fired a
 *  reconcile while the radio was still down, the fetch failed, and the
 *  'online' event 3s later was skipped by the <10s gap check — leaving
 *  a stale transcript with nothing left to retry. `reconcileOwed`
 *  bypasses the gap check on subsequent lifecycle events, and a
 *  bounded backoff retry covers the case where no further lifecycle
 *  event arrives at all. */
let reconcileOwed = false;
let reconcileRetries = 0;
let reconcileRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconcileDebt(): void {
  reconcileOwed = false;
  reconcileRetries = 0;
  if (reconcileRetryTimer) { clearTimeout(reconcileRetryTimer); reconcileRetryTimer = null; }
}
/** Wall-clock of the most recent envelope (any type) the SSE stream
 *  delivered. Powers the shell's "weakSignal / stalled" status states
 *  — formerly tracked off the openclaw WS's lastInboundAt cursor.
 *  Reset to 0 on stop so the first event after a fresh stream channel
 *  starts the clock. */
let lastEnvelopeAt = 0;

/** Derive a stable replyId for a streaming bubble. With the
 *  renderedMessages map keyed on message_id, replyId is no longer
 *  load-bearing for bubble cohesion — it's a label stamped on the
 *  bubble for TTS / play-bar wiring. Prefer the adapter's message_id
 *  (stable across delta+final); fall back to a chat-scoped synthetic
 *  when it's missing. */
function replyIdFor(env: any, chatId: string): string {
  const msgId = typeof env?.message_id === 'string' && env.message_id
    ? env.message_id
    : '';
  return msgId ? `sk-${msgId}` : `sk-chat-${chatId}`;
}

/** Extract the agent's error.message from a non-2xx response. */
async function errorMessage(r: Response): Promise<string> {
  let msg = `HTTP ${r.status}`;
  try {
    const j: any = await r.json();
    if (j?.error?.message) msg = j.error.message;
    else if (typeof j?.error === 'string') msg = j.error;
  } catch {}
  return msg;
}

function apiBase(): string {
  return `${apiOrigin()}/api/parley`;
}

async function fetchSessionMessages(id: string, logPrefix = 'proxy-client.fetchSessionMessages', limit?: number) {
  try {
    const q = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : '';
    const r = await fetch(
      `${apiBase()}/sessions/${encodeURIComponent(id)}/messages${q}`,
    );
    if (!r.ok) {
      diag(`${logPrefix}: HTTP ${r.status} for ${id}`);
      log(`${logPrefix}: chat_id=${id}, history fetch failed`);
      return { messages: [], firstId: null, hasMore: false, inflight: [], error: `HTTP ${r.status}` };
    }
    const d = await r.json();
    const inflightEnvelopes = Array.isArray(d.inflight) ? d.inflight : [];
    const result = {
      messages: d.messages || [],
      firstId: d.firstId ?? null,
      hasMore: !!d.hasMore,
      inflight: inflightEnvelopes,
    };
    log(`${logPrefix}: chat_id=${id}, ${result.messages.length} messages, ${inflightEnvelopes.length} inflight, hasMore=${result.hasMore}`);
    return result;
  } catch (e: any) {
    diag(`${logPrefix}: ${e.message}`);
    return { messages: [], firstId: null, hasMore: false, inflight: [], error: e?.message || 'network error' };
  }
}

/** Newest row id usable as a `?after=` cursor. state.db ids are
 *  integers (B2 read path, cache schema v4); scan from the tail past
 *  any row whose id isn't digit-shaped. */
function newestNumericId(messages: any[] | null | undefined): number | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.id;
    if (typeof id === 'number' && Number.isFinite(id)) return id;
    if (typeof id === 'string' && /^\d+$/.test(id)) return parseInt(id, 10);
  }
  return null;
}

/** Bound on forward delta paging. Each page is a server-default window
 *  (~200 rows); a cache more than ~3 pages behind the tail is cheaper
 *  to refresh with one full newest-page fetch than to walk forward. */
const MAX_DELTA_PAGES = 3;

/** Delta-aware transcript fetch: when the IDB cache holds a tail for
 *  this chat, fetch only the rows AFTER the cached tail (`?after=`)
 *  and merge — a few KB when the cache is fresh, vs ~750KB-1MB for the
 *  full newest page (the 28.5s "resume/replay done" on cellular,
 *  2026-06-09 device boot log). The tail page also carries `inflight`
 *  (proxy attaches it when hasMoreNewer=false) so mid-turn catch-up
 *  works exactly like the full-page resume.
 *
 *  Falls back to the full-page fetch when: no usable cache; the cache
 *  is a `partial` boot-prefetch window (a ~12-row slice — using its
 *  tail as the cursor would pass off the slice as the whole
 *  transcript); the server doesn't acknowledge the cursor
 *  (`hasMoreNewer` absent — deleted/unknown chat, unconfigured proxy,
 *  or a backend without forward paging), so deleted-chat probes still
 *  see an empty transcript; the delta spans more than MAX_DELTA_PAGES;
 *  or anything errors.
 *
 *  Tradeoff: rows already cached are NOT re-fetched, so server-side
 *  edits to old rows aren't picked up on this path — live SSE /
 *  session_changed / CACHE_SCHEMA_VERSION bumps carry those. */
async function fetchSessionMessagesDelta(id: string, logPrefix: string) {
  let cached: Awaited<ReturnType<typeof sessionCache.getMessagesCache>> = null;
  try { cached = await sessionCache.getMessagesCache(id); } catch { /* IDB unavailable */ }
  const tailId = newestNumericId(cached?.messages);
  if (!cached || cached.pagination.partial || tailId == null) return fetchSessionMessages(id, logPrefix);
  try {
    let merged = cached.messages;
    let cursor = tailId;
    let fetchedRows = 0;
    for (let page = 0; page < MAX_DELTA_PAGES; page++) {
      const r = await fetch(
        `${apiBase()}/sessions/${encodeURIComponent(id)}/messages?after=${encodeURIComponent(String(cursor))}`,
      );
      if (!r.ok) break;
      const d = await r.json();
      if (typeof d.hasMoreNewer !== 'boolean') break;
      const rows = Array.isArray(d.messages) ? d.messages : [];
      fetchedRows += rows.length;
      merged = sessionCache.mergeNewestPage(merged, rows);
      if (!d.hasMoreNewer) {
        const inflight = Array.isArray(d.inflight) ? d.inflight : [];
        log(`${logPrefix}: delta resume — ${fetchedRows} new rows after id=${tailId} onto ${cached.messages.length} cached, ${inflight.length} inflight`);
        return {
          messages: merged,
          firstId: cached.pagination.firstId ?? null,
          hasMore: !!cached.pagination.hasMore,
          inflight,
        };
      }
      if (d.lastId == null) break;
      cursor = d.lastId;
    }
  } catch (e: any) {
    diag(`${logPrefix}: delta resume failed (${e?.message || e}), falling back to full fetch`);
  }
  return fetchSessionMessages(id, logPrefix);
}

function firstUserSnippet(messages: any[]): string {
  const row = messages.find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim());
  return row ? String(row.content).slice(0, 80) : '';
}

interface SessionsResponse {
  sessions: Array<{
    chat_id: string;
    session_id?: string | null;
    source?: string;            // 'parley' | 'telegram' | 'slack' | … (added 2026-04-29 for cross-platform drawer)
    title?: string | null;
    message_count?: number;
    /** User-role message count ("turns"). Drawer renders as "N turns".
     *  Optional — older backends only emit message_count and the drawer
     *  falls back to that. */
    turn_count?: number;
    /** Tool-role message count. Pairs with turn_count for "N turns · M
     *  tools" rendering. Optional for backwards compat. */
    tool_count?: number;
    last_active_at?: string | number | null;
    created_at?: string | number | null;
    /** Snippet of the first user message in the session, truncated to
     *  ~80 chars by the proxy. Drawer falls back to this when title
     *  is empty (hermes hasn't generated one yet — model error or
     *  race). Replaced once a `session_changed` envelope arrives. */
    first_user_message?: string | null;
    /** Space-joined raw hermes session ids (root + rotated children)
     *  rolled up into this conversation. Fed into the session-filter
     *  haystack so pasting a raw session id finds its chat. */
    session_ids?: string;
  }>;
  unconfigured?: boolean;
}

/** Probe the proxy. `unconfigured: true` from the server means the
 *  proxy is running but `PARLEY_PLATFORM_TOKEN` is unset — surface
 *  that as "connected, but degraded" so the UI can show a hint
 *  rather than a generic disconnected state. The /messages endpoint
 *  will 503 on send in that case; we don't pretend otherwise. */
async function probeSessions(): Promise<{ ok: boolean; unconfigured?: boolean }> {
  try {
    const r = await fetch(`${apiBase()}/sessions?limit=1`);
    if (!r.ok) return { ok: false };
    const d = (await r.json()) as SessionsResponse;
    return { ok: true, unconfigured: !!d.unconfigured };
  } catch {
    return { ok: false };
  }
}

function shouldRunBackgroundNetwork(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function isLikelyMobileRuntime(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('capacitor-app')) return true;
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

function startHealthPoll(): void {
  if (healthTimer) return;
  const tick = async () => {
    if (shouldRunBackgroundNetwork()) {
      const { ok } = await probeSessions();
      if (ok !== connected) {
        connected = ok;
        subs?.onStatus?.(ok);
      }
    }
    healthTimer = setTimeout(tick, HEALTH_INTERVAL_MS);
  };
  healthTimer = setTimeout(tick, HEALTH_INTERVAL_MS);
}

function stopHealthPoll(): void {
  if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
}

/** Open the persistent stream channel — the single source of inbound
 *  envelopes for ALL chats. Safe to call repeatedly: an existing
 *  EventSource is closed first so we never stack two listeners writing
 *  the same envelope twice. EventSource handles transient retry via
 *  the server's `retry: 5000` hint; OS-lifecycle events
 *  (visibility/online/pageshow) call this directly through
 *  forceReconnect because mobile-Safari background-kill silently
 *  breaks the source without firing onerror. */
function startStreamChannel(): void {
  if (streamES) {
    log('proxy-client: stream channel already open, replacing');
    try { streamES.close(); } catch {}
    streamES = null;
  }
  try {
    // Pass the cursor on every (re)open so the server can skip
    // already-seen entries in its replay ring. Without this, manual
    // close+reopen — which the OS-lifecycle path uses — restarts the
    // EventSource without the browser's Last-Event-ID memory and
    // every visibility flip replays the full ring.
    const url = lastEventId !== null
      ? `${apiBase()}/stream?last_event_id=${lastEventId}`
      : `${apiBase()}/stream`;
    streamES = new EventSource(url);
    log('proxy-client: stream channel (re)opened');
  } catch (e: any) {
    diag(`proxy-client: stream EventSource open failed: ${e.message}`);
    return;
  }
  // The server emits one event per envelope, with event-name = envelope.type.
  // Listen explicitly for each type we care about; unknown event names are
  // ignored by EventSource if no listener is bound, which is the desired
  // behavior (forward-compat).
  const onEvent = (ev: MessageEvent) => {
    let env: any;
    try { env = JSON.parse(ev.data); }
    catch {
      diag('proxy-client: stream non-JSON frame ignored');
      return;
    }
    // Capture the server's monotonic id so the next forceReconnect can
    // resume from this cursor. EventSource sets `ev.lastEventId` from
    // the most recent `id:` field on any event in the stream.
    // Re-delivery is harmless: renderedMessages.upsert is idempotent on
    // message_id, so a replayed envelope updates the same bubble in
    // place rather than creating a duplicate.
    const eid = Number.parseInt(ev.lastEventId || '', 10);
    if (Number.isFinite(eid) && (lastEventId === null || eid > lastEventId)) {
      lastEventId = eid;
    }
    // Track wall-clock for the shell's status-state weakSignal/stalled
    // detection. Any envelope type counts as "stream is alive."
    lastEnvelopeAt = Date.now();
    const type = (env && typeof env.type === 'string') ? env.type : ev.type;
    const chatId = typeof env?.chat_id === 'string' ? env.chat_id : '';
    if (!chatId) return;
    handleEnvelope(type, env, chatId);
  };
  for (const t of ['reply_delta', 'reply_final', 'image', 'typing',
                   // Ephemeral working indicator (plugin-converted
                   // gateway heartbeat) — see handleEnvelope 'status'.
                   'status',
                   'notification', 'session_changed', 'error',
                   'tool_call', 'tool_result', 'user_message',
                   // Cross-device SSOT sync envelopes. The proxy
                   // forwards these (see FANOUT_TYPES in
                   // proxy/parley/stream.ts) but EventSource only
                   // delivers events whose name we explicitly subscribe
                   // to. Without these listeners, the handlers in
                   // handleEnvelope() are unreachable — caught only
                   // by cross-device-pin-sync.mjs smoke 2026-05-16.
                   'unread_changed', 'pins_changed', 'activity_changed',
                   'conversation_deleted',
                   // display_doc tool → Docs panel push.
                   'doc_show',
                   // Unified elicitation: agent blocked on a user answer.
                   'agent_question',
                   // Meeting capture: external start/stop triggers +
                   // cross-device lifecycle state.
                   'capture_control', 'capture_changed']) {
    streamES.addEventListener(t, onEvent as any);
  }
  // #204: the server emits replay_gap when our cursor predates its
  // 128-entry ring (entries evicted, or the server restarted and reset
  // its id counter) — ring replay CANNOT cover what we missed, so a
  // transcript refetch is owed regardless of how short the reconnect
  // gap looked. The ring is global (not per-chat), so this can
  // false-positive onto a chat that missed nothing; the refetch is
  // idempotent, so that's just a wasted fetch.
  streamES.addEventListener('replay_gap', (ev: MessageEvent) => {
    diag(`proxy-client: server signalled replay gap (${ev.data}) → reconcile owed`);
    reconcileOwed = true;
    scheduleReconcile(RECONCILE_GAP_MS);
  });
  // Stream-open is the source of truth for "connected" (see connect()):
  // the EventSource successfully opening means the gateway is reachable
  // AND its ring replay is now flowing, so this is the moment to report
  // connected and let the shell resume/replay. Transition-guarded so a
  // forceReconnect re-open doesn't re-fire onStatus (and re-trigger a
  // full resume) when we were already connected.
  streamES.onopen = () => {
    log('proxy-client: stream channel open');
    if (!connected) {
      connected = true;
      subs?.onStatus?.(true);
    }
  };
  streamES.onerror = (e) => {
    // EventSource auto-reconnects on transient errors (DNS hiccup,
    // brief WiFi gap) using the server's `retry: 5000` hint, so we
    // intentionally do NOT call forceReconnect here — calling close()
    // would defeat native retry. The OS-lifecycle listeners
    // (visibility/online/pageshow) are the belt-and-suspenders path
    // for the mobile-Safari background-kill case where native retry
    // doesn't fire at all. Only a HARD close (readyState CLOSED, not the
    // CONNECTING retry state) flips status to disconnected, so a WiFi
    // hiccup doesn't flap the pill while native retry is in flight.
    if (streamES?.readyState === EventSource.CLOSED && connected) {
      connected = false;
      subs?.onStatus?.(false);
    }
    diag(`proxy-client: stream errored (readyState=${streamES?.readyState}): ${(e as any)?.message || ''}`);
  };
}

function stopStreamChannel(): void {
  if (streamES) {
    try { streamES.close(); } catch {}
    streamES = null;
  }
  // Reset the idle cursor so the first envelope after a reopen starts
  // the clock. Keeping a stale value would let the shell think the
  // stream had been silent for a long time after a clean reconnect.
  lastEnvelopeAt = 0;
}

/** Force a fresh stream channel. Used by OS-lifecycle listeners
 *  (visibility/online/pageshow) — these fire on mobile-Safari foreground
 *  transitions where the underlying EventSource has been silently killed
 *  but no `onerror` fires. Also fires the reconcile pass once the new
 *  channel has had time to flush its ring replay. */
export function forceReconnect(): void {
  // Time since the LAST forceReconnect — proxies "how long was the
  // channel possibly down?" iOS Safari batches visibility events on
  // foreground, so the first call after a long background interval
  // is the one whose gap matters.
  const gapMs = lastReconnectAt > 0 ? Date.now() - lastReconnectAt : 0;
  lastReconnectAt = Date.now();
  startStreamChannel();
  scheduleReconcile(gapMs);
}

/** Debounced active-chat reconcile. Several lifecycle events
 *  (visibility, then online, then pageshow) typically fire in the same
 *  tick on a foreground transition; coalesce so resumeSession only runs
 *  once. The 500ms delay also lets the server's ring replay finish so
 *  we don't fight it. `gapMs` is the time since the previous reconnect
 *  — only large gaps (>10s) trigger a transcript refetch; short flips
 *  ride the ring replay. */
const RECONCILE_GAP_MS = 10_000;
let pendingReconcileGapMs = 0;
function scheduleReconcile(gapMs: number): void {
  // Take the LARGEST gap of any coalesced burst — visibility might
  // fire with gap=8s, then online a tick later with gap=0s; the 8s is
  // the one that matters.
  pendingReconcileGapMs = Math.max(pendingReconcileGapMs, gapMs);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    const gap = pendingReconcileGapMs;
    pendingReconcileGapMs = 0;
    reconcileActiveChat(gap).catch((e: any) => {
      diag(`proxy-client: reconcile failed: ${e.message}`);
    });
  }, 500);
}

/** Refetch + replay the ON-SCREEN chat's transcript when the stream
 *  channel has been down long enough that the server's 128-entry replay
 *  ring may not cover what we missed. Skips when:
 *    - nothing is committed on screen (nothing to reconcile against)
 *    - no shell subscription (adapter not wired up)
 *    - the gap since the previous reconnect is short (<10s) — ring
 *      replay via Last-Event-ID should have caught us up.
 *  When fired, delegates to the SAME path the drawer-click resume uses
 *  (`onResume` callback → shell clears + re-renders). The shell already
 *  knows how to reconcile a fresh transcript dump, so we don't need an
 *  incremental diff; the brief "loading…" flash is acceptable for the
 *  rare iOS-backgrounding case.
 *
 *  Reads switchCtl.viewedId(), not the lastActiveChatId memo: this
 *  repaints the pane, so the only defensible target is the chat whose
 *  transcript is COMMITTED on screen. viewedId() is also the id the
 *  shell's own onResume guard compares against, so source and gate now
 *  read the same variable instead of two that merely tended to agree.
 *  optimisticId() is deliberately NOT consulted — an in-flight switch
 *  owns its own fetch and will paint the incoming chat itself. */
async function reconcileActiveChat(gapMs: number, isRetry = false): Promise<void> {
  // Snapshot the chat we are reconciling AT CALL TIME. The fetch below
  // can take seconds on a phone link, and the user can navigate away
  // (New chat, drawer click) while it is in flight — the live view will
  // already name the NEW chat by the time we resume here. Labelling the
  // payload with the post-await value made the shell's epoch guard
  // (main.ts onResume: focusedId() !== e.conversation) compare the new
  // chat against itself, so it always passed and the OLD chat's
  // transcript painted over the fresh one. Field bug 2026-07-12 (CAP
  // walking test): "new chat… some lag… then left me in current
  // session".
  const reconcilingChatId = switchCtl.viewedId();
  if (!reconcilingChatId || !subs?.onResume) return;
  if (gapMs < RECONCILE_GAP_MS && !reconcileOwed) {
    diag(`proxy-client: reconcile skipped (gap ${gapMs}ms < ${RECONCILE_GAP_MS}ms)`);
    return;
  }
  // A fresh big-gap lifecycle event resets the retry budget — each
  // foreground transition gets its own bounded retry run.
  if (!isRetry && gapMs >= RECONCILE_GAP_MS) reconcileRetries = 0;
  const owedRun = gapMs < RECONCILE_GAP_MS;
  reconcileOwed = true;
  log(`proxy-client: reconciling viewed chat ${reconcilingChatId} after ${gapMs}ms gap${owedRun ? ' (owed)' : ''}`);
  try {
    const r = await fetch(
      `${apiBase()}/sessions/${encodeURIComponent(reconcilingChatId)}/messages`,
    );
    if (!r.ok) {
      diag(`proxy-client: reconcile HTTP ${r.status}`);
      scheduleReconcileRetry(`HTTP ${r.status}`);
      return;
    }
    const d = await r.json();
    const messages = Array.isArray(d.messages) ? d.messages : [];
    // The shell will repaint from history; renderedMessages.upsert is
    // idempotent so any in-flight bubble for a message in the replayed
    // set will be reconciled in place rather than producing a duplicate.
    subs.onResume({
      messages,
      conversation: reconcilingChatId,
      firstId: d.firstId ?? null,
      hasMore: !!d.hasMore,
    });
    clearReconcileDebt();
  } catch (e: any) {
    diag(`proxy-client: reconcile fetch failed: ${e.message}`);
    scheduleReconcileRetry(e?.message || 'network error');
  }
}

/** Bounded backoff retry for a failed owed reconcile (2s/4s/8s). After
 *  the budget is spent the debt stays set, so the NEXT lifecycle event
 *  (online, visibility, pageshow) re-runs the reconcile regardless of
 *  its gap. */
function scheduleReconcileRetry(reason: string): void {
  if (reconcileRetryTimer) return;
  if (reconcileRetries >= 3) {
    diag(`proxy-client: reconcile failed (${reason}) — retries exhausted, debt held for next lifecycle event`);
    return;
  }
  reconcileRetries++;
  const delay = 2000 * 2 ** (reconcileRetries - 1);
  diag(`proxy-client: reconcile failed (${reason}) — retry ${reconcileRetries}/3 in ${delay}ms`);
  reconcileRetryTimer = setTimeout(() => {
    reconcileRetryTimer = null;
    reconcileActiveChat(0, true).catch((e: any) => {
      diag(`proxy-client: reconcile retry failed: ${e.message}`);
    });
  }, delay);
}

/** External "should-stay-alive" hint. Consumers register a getter that
 *  returns true when the tab MUST stay live in background — currently
 *  set by WebRTC controls when a call is open. When the hint is true,
 *  we keep the SSE stream channel alive on visibilitychange-hidden so
 *  iOS doesn't suspend the tab's JS context and starve the WebRTC
 *  peer's ICE consent freshness pings. Field bug 2026-05-24
 *  (post-8025949): locked-screen calls were dying ~5-6 min into
 *  background because the SSE close on hidden removed the iOS
 *  "active connection" signal that kept the tab live. */
let externalStayAliveHint: (() => boolean) | null = null;
export function setStayAliveHint(getter: () => boolean): void {
  externalStayAliveHint = getter;
}
function shouldStayAlive(): boolean {
  try { return !!externalStayAliveHint?.(); }
  catch { return false; }
}

/** Bind OS-lifecycle listeners ONCE per page. Mobile-Safari kills
 *  EventSource silently when the PWA is backgrounded, the radio
 *  suspends, or the device hands off cell→wifi; native EventSource
 *  retry doesn't fire reliably in those cases. Visibility/online/
 *  pageshow are the canonical "we just came back to life" signals. */
function bindLifecycleHandlers(): void {
  if (lifecycleHandlersBound) return;
  lifecycleHandlersBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isLikelyMobileRuntime()) {
        if (shouldStayAlive()) {
          log('proxy-client: visibilitychange hidden on mobile but stay-alive hint set (active call) → keep stream channel alive');
        } else {
          log('proxy-client: visibilitychange hidden on mobile → close stream channel');
          stopStreamChannel();
        }
      } else {
        log('proxy-client: visibilitychange hidden on desktop → keep stream channel alive');
      }
      return;
    }
    log('proxy-client: visibilitychange visible → forceReconnect');
    forceReconnect();
  });
  window.addEventListener('online', () => {
    if (!shouldRunBackgroundNetwork()) return;
    log('proxy-client: online → forceReconnect');
    forceReconnect();
  });
  window.addEventListener('pagehide', () => {
    log('proxy-client: pagehide → close stream channel');
    stopStreamChannel();
  });
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) {
      log('proxy-client: pageshow(persisted) → forceReconnect');
      forceReconnect();
    }
  });
}

/** Cross-device SSOT sync — the plugin emits these envelopes when
 *  another device (or a local seen/mark/pin/delete op) mutated state
 *  the PWA tracks via /api/parley/{notifications,pins,...}. The
 *  PWA's local listeners (badge.ts, pins/store.ts, sessionDrawer.ts)
 *  re-fetch the affected surface; some types also have a local side
 *  effect (e.g. delete the IDB row).
 *
 *  Table-driven so adding a fourth sync type means one row, not a
 *  copy-paste of the case body. Each entry maps:
 *    envelope.type → { eventName, sideEffect? }
 *
 *  `eventName` is dispatched on `window` with `{detail: env}`; local
 *  listeners pick it up.
 *  `sideEffect`, if present, runs BEFORE the dispatch — useful when
 *  the listener depends on local state already being updated (e.g.
 *  sessionDrawer's scheduleRefresh needs the IDB row gone before its
 *  re-render). */
type CrossDeviceSyncType = 'unread_changed' | 'pins_changed' | 'activity_changed' | 'conversation_deleted';
const CROSS_DEVICE_SYNC: Record<CrossDeviceSyncType, {
  eventName: string;
  sideEffect?: (chatId: string) => void;
}> = {
  unread_changed:        { eventName: 'parley:server-unread-changed' },
  pins_changed:          { eventName: 'parley:server-pins-changed' },
  activity_changed:      { eventName: 'parley:server-activity-changed' },
  conversation_deleted:  {
    eventName: 'parley:server-conversation-deleted',
    sideEffect: (chatId) => {
      conversations.remove(chatId).catch(() => {});
      // Close shelf docs owned by the deleted chat (meeting transcripts
      // etc. — "delete means gone", 2026-07-13). Rides the envelope so
      // one hook covers local deletes (the plugin echoes the envelope
      // back) AND cross-device ones; a FAILED delete emits no envelope,
      // so the rollback keeps its docs. View-layer only — files on
      // disk follow the capture's own lifecycle.
      void import('./rightDrawer/docStore.ts')
        .then((m) => m.removeDocsFor({ chatId }))
        .catch(() => {});
    },
  },
};
function dispatchCrossDeviceSync(type: CrossDeviceSyncType, env: any, chatId: string): void {
  const entry = CROSS_DEVICE_SYNC[type];
  if (!entry) return;
  try {
    entry.sideEffect?.(chatId);
    window.dispatchEvent(new CustomEvent(entry.eventName, { detail: env }));
  } catch { /* swallow — sync is best-effort */ }
}

function handleEnvelope(type: string, env: any, chatId: string): void {
  switch (type) {
    case 'typing':
      subs?.onActivity?.({ working: true, detail: 'pending', conversation: chatId });
      return;

    case 'status': {
      // Ephemeral working indicator (plugin-converted gateway heartbeat).
      // Never render on ring replay — a stale beat would show a dead
      // turn as working.
      if (env?._replay === true) return;
      const text = typeof env.text === 'string' ? env.text : '';
      const working = env.state !== 'done';
      transcriptStore.setTurnStatus(chatId, working ? (text || 'Working') : null);
      subs?.onActivity?.({ working, detail: text || 'working', conversation: chatId });
      return;
    }

    case 'reply_delta': {
      const text = typeof env.text === 'string' ? env.text : '';
      if (!text) return;
      const replyId = replyIdFor(env, chatId);
      const msgId = typeof env?.message_id === 'string' && env.message_id ? env.message_id : null;
      const isReplay = env?._replay === true;
      // Diagnostic — every reply_delta logs message_id + envelope id +
      // a text preview. If the user reports a duplicate bubble, this
      // tells us whether the proxy delivered ONE envelope (render path
      // bug) or TWO with different ids (agent / wire bug).
      log(`[bubble-diag] reply_delta chat=${chatId} msgId=${msgId ?? '∅'} replyId=${replyId} text-len=${text.length} text="${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"${isReplay ? ' (replay)' : ''}`);
      subs?.onActivity?.({ working: true, detail: 'streaming', conversation: chatId });
      // Adapter contract guarantees `text` is the full cumulative text
      // for this bubble — pass straight through as cumulativeText.
      // isReplay flows so the shell's first-delta-of-turn chime stays
      // quiet on SSE ring-replay catch-up after switching to a chat
      // with recent activity (without isReplay, the 'send' chime fires
      // on every switch into a chat with in-flight activity because
      // handleReplyDelta sees replay envelopes as "first delta").
      subs?.onDelta?.({ replyId, cumulativeText: text, conversation: chatId, messageId: msgId, isReplay, interim: env?.interim === true });
      return;
    }

    case 'reply_final': {
      const replyId = replyIdFor(env, chatId);
      const finalText = typeof env.text === 'string' ? env.text : '';
      const msgId = typeof env?.message_id === 'string' && env.message_id ? env.message_id : null;
      const isReplay = env?._replay === true;
      log(`[bubble-diag] reply_final chat=${chatId} msgId=${msgId ?? '∅'} replyId=${replyId} text-len=${finalText.length}${isReplay ? ' (replay)' : ''}`);
      // Note: working=false here means "this bubble is done." If the
      // adapter sends a follow-up bubble (bootstrap nudge → reply, or
      // tool-result-as-text), the next reply_delta will flip activity
      // back on. The shell's two-state thinking indicator can flicker
      // briefly between bubbles — acceptable.
      subs?.onActivity?.({ working: false, conversation: chatId });
      subs?.onFinal?.({ replyId, text: finalText, conversation: chatId, messageId: msgId, isReplay, interim: env?.interim === true });
      // Bump last_message_at so the drawer sort surfaces this row even
      // before /api/parley/sessions enrichment refreshes.
      // NOT on replay: server replays past envelopes on stream
      // reconnect; bumping then triggers a drawer-reorder cascade
      // (multiple resumes per page-load). The IDB row's lastMessageAt
      // is already correct from the
      // original live event, so skipping replay is safe.
      if (!isReplay) {
        conversations.updateLastMessageAt(chatId, Date.now()).catch(() => {});
      }
      return;
    }

    case 'image': {
      // Surface as a tool-like event the canvas/image renderer can
      // hook later. v1 just logs; not part of the BackendAdapter event
      // vocabulary directly.
      subs?.onToolEvent?.({
        kind: 'image',
        payload: { url: env.url, caption: env.caption || '' },
        conversation: chatId,
      });
      return;
    }

    case 'agent_question': {
      // Unified elicitation: the agent thread is BLOCKED on a user
      // answer (hermes clarify; approvals carry the same shape via
      // notification kind for now). Not replay-gated here — the popup
      // itself skips questions whose expires_at already passed, so a
      // ring replay resurfaces a STILL-LIVE question (good: the tab
      // that missed it while closed gets a working popup) without
      // reviving dead ones.
      subs?.onToolEvent?.({
        kind: 'agent.question',
        payload: {
          question_id: typeof env.question_id === 'string' ? env.question_id : '',
          chat_id: typeof env.chat_id === 'string' ? env.chat_id : '',
          kind: typeof env.kind === 'string' ? env.kind : 'clarify',
          question: typeof env.question === 'string' ? env.question : '',
          choices: Array.isArray(env.choices) ? env.choices : [],
          allow_free_text: env.allow_free_text !== false,
          expires_at: typeof env.expires_at === 'number' ? env.expires_at : null,
        },
      });
      return;
    }

    case 'doc_show': {
      // display_doc tool: the agent pushed a document for the Docs
      // drawer tab. Same onToolEvent shape as 'image' — the handler
      // (backendEventHandlers.handleToolEvent) routes it to the doc
      // store. isReplay gates the drawer auto-open: a ring-replayed
      // push (boot / reconnect without a cursor) must still SET the
      // doc but never yank the drawer open again.
      subs?.onToolEvent?.({
        kind: 'doc.show',
        payload: {
          title: typeof env.title === 'string' ? env.title : 'Document',
          content: typeof env.content === 'string' ? env.content : '',
          format: typeof env.format === 'string' ? env.format : 'text',
          path: typeof env.path === 'string' ? env.path : undefined,
          // Server clock: when the agent displayed the doc (plugin
          // stamps epoch ms). The doc store uses this — not client
          // receipt time — so the "26s ago" meta is device-independent
          // and survives ring replay (the ring stores the original
          // envelope, original stamp included).
          displayedAt: typeof env.displayed_at === 'number' ? env.displayed_at : undefined,
          // Producer tag ('capture' = meeting transcript) — the shelf
          // renders capture docs with the record glyph instead of a
          // title emoji; captureId powers the reader's player strip.
          source: typeof env.source === 'string' ? env.source : undefined,
          captureId: typeof env.capture_id === 'string' ? env.capture_id : undefined,
        },
        conversation: chatId,
        isReplay: env?._replay === true,
      });
      return;
    }

    case 'capture_control':
    case 'capture_changed': {
      // Meeting capture control plane + lifecycle (proxy capture.ts).
      // Ring replays must never re-trigger a start/stop — a stale
      // 'start' replayed on boot would grab the mic unprompted.
      if (env?._replay === true) return;
      // A deleted capture takes its shelf docs with it (2026-07-13
      // nit — same "delete means gone" contract as chats). The proxy's
      // notifyChanged carries the lifecycle stage in `kind`
      // (created/patched/stopped/completed/deleted).
      if (env?.kind === 'deleted') {
        const capId = typeof env?.capture?.id === 'string' ? env.capture.id
          : (typeof env?.capture_id === 'string' ? env.capture_id : null);
        if (capId) {
          void import('./rightDrawer/docStore.ts')
            .then((m) => m.removeDocsFor({ captureId: capId }))
            .catch(() => {});
        }
      }
      subs?.onToolEvent?.({
        kind: env.type === 'capture_control' ? 'capture.control' : 'capture.changed',
        payload: {
          action: typeof env.action === 'string' ? env.action : undefined,
          capture: env.capture,
          captureKind: typeof env.kind === 'string' ? env.kind : undefined,
        },
        conversation: chatId,
        isReplay: false,
      });
      return;
    }

    case 'unread_changed':
    case 'pins_changed':
    case 'activity_changed':
    case 'conversation_deleted':
      dispatchCrossDeviceSync(env.type, env, chatId);
      return;

    case 'session_changed': {
      // Compression rotated the gateway session, or hermes finished
      // titling the chat after the first message. Update the local
      // IDB title and notify the shell so the drawer re-renders in
      // place. Without the callback, the new title only surfaces on
      // the next list poll / page reload.
      const newTitle = typeof env.title === 'string' ? env.title : '';
      if (newTitle) {
        conversations.updateTitle(chatId, newTitle).catch(() => {});
      }
      const sessionId = typeof env.session_id === 'string' ? env.session_id : '';
      subs?.onSessionChanged?.({
        conversation: chatId,
        sessionId,
        title: newTitle,
      });
      return;
    }

    case 'notification': {
      // Push notification (cron, /background result, scheduled
      // reminder). May target ANY chat_id, not just the active one;
      // shell decides what to render where (system row in the matching
      // thread, badge on the drawer entry, etc.).
      const kind = typeof env.kind === 'string' ? env.kind : 'unknown';
      const content = typeof env.content === 'string' ? env.content : '';
      // Plugin-minted parley_id (notif_*) — used as the
      // data-message-id on the rendered transcript row so:
      //   (a) reload dedups against the same row fetched from
      //       /v1/conversations/{id}/items (server adds it from
      //       parley_notifications)
      //   (b) `?msg=Y` URL param on push-click scrolls to the same
      //       row via existing pin-drawer-jump machinery.
      const parleyId = typeof env.parley_id === 'string' ? env.parley_id : '';
      const isReplay = env?._replay === true;
      log(`proxy-client: notification kind=${kind} chat_id=${chatId} sk=${parleyId}${isReplay ? ' (replay)' : ''}`);
      subs?.onNotification?.({ chatId, kind, content, parleyId, isReplay });
      // Bump the drawer ordering so the chat with the freshest
      // notification floats up. Skip on replay (see reply_final's
      // matching guard for cascade rationale).
      if (!isReplay) {
        conversations.updateLastMessageAt(chatId, Date.now()).catch(() => {});
      }
      return;
    }

    case 'user_message': {
      // Cross-device user-message broadcast. Originating device's
      // optimistic bubble was registered under the same messageId
      // (PWA pre-mints in sendMessage), so the shell's onUserMessage
      // handler upserts idempotently — no double-render. Other devices
      // see this for the first time and create the bubble fresh.
      const text = typeof env.text === 'string' ? env.text : '';
      const messageId = typeof env?.message_id === 'string' ? env.message_id : '';
      if (!messageId) return;
      const isReplay = env?._replay === true;
      subs?.onUserMessage?.({ conversation: chatId, text, messageId, isReplay });
      // Drawer ordering — skip on replay (see reply_final's matching
      // guard). Server replays N user_message envelopes per chat on
      // every reconnect; without this gate that triggers N drawer
      // reorders → N resume cascades.
      if (!isReplay) {
        conversations.updateLastMessageAt(chatId, Date.now()).catch(() => {});
      }
      return;
    }

    case 'error':
      log(`proxy-client: error for ${chatId}: ${env.detail || 'unknown'}`);
      subs?.onActivity?.({ working: false, conversation: chatId });
      return;

    case 'tool_call': {
      // Faithful relay — PWA decides visibility via the agentActivity
      // setting. callId ties this to the matching tool_result envelope
      // so concurrent tool calls don't get cross-wired.
      const callId = typeof env.call_id === 'string' ? env.call_id : '';
      const toolName = typeof env.tool_name === 'string' ? env.tool_name : '';
      if (!callId || !toolName) return;
      const args = (env.args && typeof env.args === 'object') ? env.args : {};
      const argsRepr = typeof env._args_repr === 'string' ? env._args_repr : undefined;
      const startedAt = typeof env.started_at === 'string'
        ? env.started_at
        : new Date().toISOString();
      subs?.onToolCall?.({
        callId,
        toolName,
        args,
        argsRepr,
        startedAt,
        conversation: chatId,
      });
      // A tool call IS confirmation the agent is doing something — flip
      // the activity indicator to "working" if a stream-delta hasn't
      // already done it. Cheap; the shell's two-state indicator is
      // idempotent.
      subs?.onActivity?.({ working: true, detail: 'tool', conversation: chatId });
      return;
    }

    case 'tool_result': {
      const callId = typeof env.call_id === 'string' ? env.call_id : '';
      if (!callId) return;
      const result = typeof env.result === 'string' ? env.result : null;
      const error = typeof env.error === 'string' ? env.error : null;
      const truncated = !!env._truncated;
      const durationMs = typeof env.duration_ms === 'number' ? env.duration_ms : 0;
      const toolName = typeof env.tool_name === 'string' ? env.tool_name : '';
      subs?.onToolResult?.({
        callId,
        toolName,
        result,
        error,
        truncated,
        durationMs,
        conversation: chatId,
      });
      return;
    }

    default:
      diag(`proxy-client: ignored envelope type=${type}`);
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export const proxyClientAdapter = {
  name: 'proxy-client',

  capabilities: {
    streaming: true,
    sessions: true,           // chat_id provides multi-session semantics
    models: false,            // legacy hardcoded picker — superseded by `agentSettings`
    agentSettings: true,      // /api/parley/settings/* schema-driven panel (model picker etc.)
    cronJobs: true,           // /api/parley/jobs — Settings › Cron (scheduled-jobs extension)
    healthChecks: true,       // /api/parley/health — Settings › Health (health extension)
    toolEvents: true,         // tool_call / tool_result envelopes (Phase 3); image is also tool-like

    history: true,            // /api/parley/sessions/<chat_id>/messages
    attachments: false,       // wire shape allows it, no PWA composer support yet
    sessionBrowsing: true,    // /api/parley/sessions
    slashCommands: true,      // gateway parses /new, /compress, /resume, /undo, /background
    persona: false,           // RESERVED (inert): per-session persona prompt not wired yet
  },

  async connect(opts: any) {
    subs = opts;
    // Hydrate the active chat_id from IDB so getCurrentSessionId can
    // answer synchronously after connect resolves. We don't AUTO-mint
    // here — first-send / explicit-new-chat allocates lazily.
    try {
      lastActiveChatId = await conversations.getActive();
    } catch (e: any) {
      diag(`proxy-client: getActive failed: ${e.message}`);
      lastActiveChatId = null;
    }
    // Open the stream channel FIRST and let its onopen drive "connected".
    // We deliberately do NOT `await probeSessions()` here: on a cold
    // device relaunch that fetch blocked connect ~14s (measured
    // 2026-06-09 via boot-timing marks), and since onStatus(connected)
    // is what triggers the transcript resume/replay, the whole live UI
    // waited behind it. The EventSource open is both the truthful
    // connectivity signal and the ring-replay source, so it's the right
    // thing to gate "connected" on — and it starts at ~boot instead of
    // after a multi-second probe round-trip.
    startStreamChannel();
    startHealthPoll();
    // OS-lifecycle hardening: visibility/online/pageshow trigger a
    // forceReconnect because mobile-Safari silently kills the
    // EventSource on background / radio suspend / network handoff
    // without firing onerror. Bound once per page lifetime.
    bindLifecycleHandlers();
    // Non-blocking probe — purely a health/degraded check now, never the
    // boot-gating path. Surfaces the PARLEY_PLATFORM_TOKEN-unset
    // "connected-but-degraded" hint, and gives an EARLY disconnected
    // signal if the gateway is outright unreachable (the stream would
    // otherwise sit silently in CONNECTING retry). Never sets
    // connected=true — the stream owns that, so this can't trigger a
    // premature resume.
    void probeSessions().then(({ ok, unconfigured }) => {
      if (!ok && !connected) {
        opts.onStatus?.(false);
        log('proxy-client: initial probe failed — is the proxy running?');
      } else if (ok && unconfigured) {
        log('proxy-client: connected (proxy reports PARLEY_PLATFORM_TOKEN unset — sends will 503)');
      }
    });
  },

  disconnect() {
    stopHealthPoll();
    stopStreamChannel();
    connected = false;
  },

  reconnect() {
    probeSessions().then(({ ok }) => {
      connected = ok;
      subs?.onStatus?.(ok);
      if (ok) log('proxy-client: reconnected');
    });
  },

  isConnected() {
    return connected;
  },

  /** Wall-clock ms since the last envelope arrived on the SSE channel.
   *  Powers main.ts's "weakSignal / stalled" status states — when the
   *  shell hasn't seen ANY envelope in a long while, the network may
   *  be flaky even if the EventSource thinks it's connected. Returns 0
   *  when no envelope has arrived yet (fresh connect or post-reset);
   *  callers treat 0 as "no signal yet" rather than "infinitely idle". */
  msSinceLastEnvelope(): number {
    if (!lastEnvelopeAt) return 0;
    return Date.now() - lastEnvelopeAt;
  },

  async sendMessage(text: string, opts: any = {}) {
    // Offline-first (field 2026-07-21): do NOT gate the POST on
    // `connected` — that boolean mirrors the SSE EventSource, which
    // flaps constantly on spotty mobile links even while a plain HTTP
    // POST would succeed. Attempt the send regardless; if the link is
    // genuinely down the fetch below rejects with a network error and
    // the shell's queued-send machinery (main.ts sendOrQueueMessage)
    // holds it for the next reconnect. An answered HTTP rejection
    // still throws `Parley HTTP <status>` — the shell treats that
    // as a real refusal, not connectivity.
    if (!connected) {
      diag('proxy-client.sendMessage: POSTing while stream channel is down (offline-first)');
    }
    // ADDRESSED, NOT POINTED (UX_DETERMINISM_PLAN §6 rule 3): opts.chatId
    // is REQUIRED. Every send names the chat it was composed in, captured
    // at intent time — the composer, the approval buttons, the question
    // popup, slash commands, the voice draft flush, the memo outbox drain
    // and the offline retry queue all resolve one and carry it. Reading a
    // module-level pointer at completion time is precisely how /approve
    // ×5 landed in the wrong session (field 2026-06-12) and how the
    // 2026-09-06 dream log went to Notion.
    //
    // Missing chatId is a PROGRAMMING error, not a user-facing one, so it
    // is loud where a developer will see it and survivable where the user
    // is:
    //   dev mode → throw. A new send path that forgets to address itself
    //              fails on the first try, in the smokes, not in the
    //              field nine minutes later.
    //   prod     → diag + best-effort resolve, because dropping a typed
    //              message on the floor is worse than sending it to the
    //              most likely chat. Order matters: the chat the user is
    //              LOOKING AT (switchCtl — the one source of truth) first,
    //              the IDB active row / lazy mint only when there is no
    //              view at all (fresh install, first send before any
    //              landing). The old code had this backwards.
    let chatId: string;
    if (typeof opts.chatId === 'string' && opts.chatId) {
      chatId = opts.chatId;
    } else {
      // Shape, not content: enough to tell WHICH send path forgot to
      // address itself, without putting the user's message into a diag
      // line that the dev-mode relay writes to disk. The dev throw
      // carries a stack, which is the precise answer anyway.
      const shape = `len=${text.length} voice=${!!opts.voice} att=${Array.isArray(opts.attachments) ? opts.attachments.length : 0}`;
      if (isDevMode()) {
        throw new Error(
          'proxy-client.sendMessage: opts.chatId is required — sends must be addressed '
          + `at intent time, not resolved from a pointer at send time (${shape}). `
          + 'Capture the chat id where the user committed the message and pass it through.',
        );
      }
      const focused = switchCtl.focusedId();
      diag(`proxy-client.sendMessage: UNADDRESSED SEND (${shape}) — falling back to `
        + `${focused ? `focusedId=${focused}` : 'the lazy-mint path'}; fix the caller`);
      if (focused) {
        chatId = focused;
      } else {
        // No view has ever committed: this is the genuine first send on
        // a fresh install. Lazy-allocate — drawer entries created by the
        // user clicking "New chat" go via newSession() below.
        if (!lastActiveChatId) {
          const conv = await conversations.getOrCreateActive();
          lastActiveChatId = conv.chat_id;
        }
        chatId = lastActiveChatId!;
      }
    }
    // Nav evidence, one line, no wire change (UX_DETERMINISM_PLAN §5
    // Phase 0.3). The 2026-09-06 mis-send had to be reconstructed from
    // SERVER logs because nothing client-side recorded WHICH navigation
    // put that chat on screen. The last three ledger entries next to the
    // resolved target answer that at the moment it matters — the send.
    try {
      const nav = switchCtl.getNavLedger().slice(-3)
        .map((e) => `${e.origin}/${e.id}/g${e.gen}/${e.outcome}`).join(' ');
      diag(`proxy-client.sendMessage: → ${chatId} nav=[${nav}]`);
    } catch { /* a diag must never block a send */ }
    // Lazy-allocate from newSession() leaves no IDB row; first send
    // is the moment we know the chat is "real". Hydrate creates the
    // conversations row if missing so the drawer's listSessions
    // merge can surface it immediately (its server-side state.db
    // row also lands during this turn). Idempotent no-op for
    // existing rows.
    //
    // Pass the truncated text as the seed title so a brand-new chat's
    // first IDB row carries the user's message text — without this,
    // listSessions' local-only-row path returns title='New chat' and
    // mergePending drops the snippet-bearing pending row, leaving the
    // drawer showing 'New chat' for the full duration of long
    // tool-using turns (a long tool call would show 'New chat' until
    // the reply landed). stampPlaceholderTitle
    // catches the second-message-in-an-untitled-chat case (hydrate
    // no-ops on existing rows by design).
    const seedTitle = text.slice(0, 80);
    try {
      await conversations.hydrate(chatId, seedTitle);
      if (seedTitle) await conversations.stampPlaceholderTitle(chatId, seedTitle);
    }
    catch (e: any) { diag(`proxy-client.sendMessage: IDB hydrate failed: ${e.message}`); }

    const body: Record<string, any> = { chat_id: chatId, text };
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      body.attachments = opts.attachments;
    }
    if (opts.voice) body.voice = true;
    // Cross-device user-message dedup: when the shell pre-minted an
    // id for its optimistic bubble, ship it so the upstream's
    // user_message broadcast carries the same id. Originating device
    // dedups via renderedMessages (idempotent on key); other devices
    // see the id for the first time and render fresh.
    if (typeof opts.userMessageId === 'string' && opts.userMessageId) {
      body.user_message_id = opts.userMessageId;
    }

    // Fire-and-forget — the proxy returns 202 once the WS frame is
    // queued. Reply envelopes arrive on the persistent stream
    // channel via onDelta / onFinal callbacks. We don't await an
    // SSE here.
    try {
      const res = await fetch(`${apiBase()}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let detail = errText.slice(0, 200);
        try {
          const parsed = JSON.parse(errText);
          if (parsed?.detail) detail = parsed.detail;
        } catch {}
        throw new Error(`Parley HTTP ${res.status}: ${detail}`);
      }
      // Optimistic activity flip — flips back to working=true on the
      // first reply_delta / typing envelope. Pre-confirm "we sent it"
      // so the UI shows a live indicator even if the agent takes a
      // moment before its first stream tick.
      subs?.onActivity?.({ working: true, detail: 'pending', conversation: chatId });
    } catch (e: any) {
      diag(`proxy-client.sendMessage failed: ${e.message}`);
      subs?.onActivity?.({ working: false, conversation: chatId });
      throw e;
    }
  },

  async newSession() {
    // Mint a fresh chat_id LOCALLY without writing the IDB conversation
    // row (Option B — lazy-create). The drawer's listSessions merge
    // appends local IDB rows for chats not on the server; if we wrote
    // a row here, every "New chat" click would surface as an empty
    // "New chat / 0 msgs" stub before the user even sent anything.
    // Instead: hold the chat_id in memory + active pointer, and let
    // the row materialize when the first message lands (state.db on
    // server side via plugin's get_or_create_session, IDB on this
    // side via conversations.hydrate from resumeSession or via
    // updateLastMessageAt's create-if-missing semantics).
    lastActiveChatId = conversations.mintChatId();
    await conversations.setActive(lastActiveChatId);
    log(`proxy-client: new session (chat_id=${lastActiveChatId})`);
  },

  /** The IDB "active conversation" memo — NOT "the chat the user is
   *  looking at". That question has one answer and it is
   *  switchCtl.viewedId()/focusedId(); every caller in the shell asks
   *  switchController first and only falls through to here.
   *
   *  Two legitimate jobs remain, both of them PRE-VIEW:
   *    1. boot landing — the last-active row survived the reload but no
   *       switch has committed yet, so there is no view to read.
   *    2. lazy mint — main.ts resolveOrMintSendChatId reads this
   *       immediately after newSession() to learn the id that was just
   *       minted (mintChatId is synchronous, before newSession's first
   *       await).
   *  Anything else asking this for a send target is a bug. */
  getCurrentSessionId() {
    return lastActiveChatId;
  },

  /** Imperative active-chat setter. Currently UNUSED by the shell:
   *  every active-chat flip funnels through resumeSession (drawer
   *  click) or newSession (toolbar / first-message), both of which
   *  already write lastActiveChatId + persist to IDB. Kept on the adapter
   *  so callers that want a no-history-fetch session switch (e.g. a
   *  future cmdk palette quick-jump that does its own snapshot replay)
   *  have a stable hook. NOT exported through src/backend.ts —
   *  promote it through the dispatcher when a real call site lands. */
  async setCurrentSessionId(chat_id: string | null) {
    lastActiveChatId = chat_id;
    await conversations.setActive(chat_id);
  },

  async listSessions(_limit = 50) {
    // Server is the source of truth for the cross-device session list.
    // Local IDB is fallback for offline + locally-minted-but-not-yet-
    // sent rows. The previous left-join on local IDB silently dropped
    // every server chat the user created on a different device — a
    // chat created on Mac never entered iOS-Safari's IDB, so it
    // wouldn't appear when viewed there. After a clear-site-data the
    // drawer would render empty even with plenty of server sessions.
    const local = await conversations.list();
    const localById = new Map(local.map(c => [c.chat_id, c]));
    let enrich: SessionsResponse['sessions'] = [];
    let unconfigured = false;
    let serverReachable = false;
    try {
      const r = await fetch(`${apiBase()}/sessions?limit=200`);
      if (r.ok) {
        const d = (await r.json()) as SessionsResponse;
        enrich = d.sessions || [];
        unconfigured = !!d.unconfigured;
        serverReachable = true;
      }
    } catch (e: any) {
      diag(`proxy-client.listSessions: server unreachable, falling back to local-only: ${e.message}`);
    }

    if (!serverReachable) {
      // Offline / proxy down — render whatever we have locally so the
      // drawer doesn't go blank. Prefer the last server-backed list row
      // when present, then enrich from cached transcripts. The
      // conversations store is intentionally thin and often only knows
      // "New chat" / 0 msgs after a hard refresh.
      const cachedList = await sessionCache.getListCache();
      const cachedById = new Map((cachedList?.sessions || []).map((row: any) => [row.id, row]));
      return Promise.all(local.map(async (conv) => {
        const prev: any = cachedById.get(conv.chat_id) || {};
        const cached = await sessionCache.getMessagesCache(conv.chat_id);
        const messages = cached?.messages || [];
        const snippet = firstUserSnippet(messages) || prev.snippet || '';
        const localTitle = conv.title === 'New chat' ? '' : (conv.title || '');
        const messageCount = messages.length || prev.messageCount || 0;
        return {
          id: conv.chat_id,
          source: prev.source || (conv.chat_id.includes(':') ? conv.chat_id.split(':')[0] : 'parley'),
          title: localTitle || prev.title || snippet || 'New chat',
          snippet,
          lastMessageAt: Math.floor(conv.last_message_at / 1000) || prev.lastMessageAt || 0,
          messageCount,
          turnCount: messages.filter((m: any) => m?.role === 'user').length || prev.turnCount || undefined,
          toolCount: messages.filter((m: any) => m?.role === 'tool').length || prev.toolCount || undefined,
        };
      }));
    }

    // Spine = server rows. Iterate each server chat and merge in any
    // local metadata we have for it. This is what makes cross-device
    // chats visible.
    const merged = enrich.map(e => {
      const localConv = localById.get(e.chat_id);
      const lastActive = e.last_active_at != null
        ? (typeof e.last_active_at === 'number' ? e.last_active_at
           : Math.floor(new Date(e.last_active_at).getTime() / 1000))
        : (localConv ? Math.floor(localConv.last_message_at / 1000) : 0);
      // Title fallback chain: server-side title wins (the eventual
      // hermes-generated one), else local IDB title (cross-device
      // shadow), else fall through to the snippet (first user message
      // truncated to 80 chars). Only when both are empty AND there's
      // no snippet do we substitute "New chat" as a last-resort
      // placeholder. The local IDB defaults to "New chat" on hydrate
      // (conversations.ts:141) — treat that exact string as a
      // placeholder, not a real user-set title, so it doesn't shadow
      // the snippet for chats hermes hasn't titled yet.
      const localTitle = localConv?.title === 'New chat' ? '' : (localConv?.title || '');
      // Server title wins (since v0.420 — server-side rename PATCH now
      // exists, so the server is the source of truth for cross-device
      // consistency). userTitle is kept as a fallback ONLY when the
      // server has no title yet (offline buffer / pre-PATCH-existed
      // orphans on this device). Pre-v0.420 behavior preferred
      // userTitle universally — that's what caused mobile-rename to
      // not propagate to desktops where userTitle was set during the
      // local-only era. Server propagation now overrides those
      // orphan locals naturally.
      const userTitle = (localConv as any)?.userTitle || '';
      const title = e.title || userTitle || localTitle || '';
      const snippet = e.first_user_message || '';
      const messageCount = e.message_count || 0;
      // Title fallback chain (post-2026-05-03 race fix):
      //   - real title or snippet → use as-is
      //   - empty title + empty snippet + messageCount > 0
      //         → "(processing…)" — chat has real content but neither
      //           hermes-generated title NOR first_user_message has
      //           landed yet. Surfaced 2026-05-03 ~07:58 when an SW
      //           reload mid agent tool-loop left a row with msgCount
      //           but no title/snippet for several minutes; "New chat"
      //           was indistinguishable from a fresh orphan and we
      //           almost cleaned it.
      //   - empty title + empty snippet + messageCount === 0
      //         → "New chat" — truly empty, preserves the orphan
      //           affordance the cleanup paths rely on.
      let resolvedTitle: string;
      if (title) {
        resolvedTitle = title;
      } else if (snippet) {
        resolvedTitle = '';                    // drawer falls through to snippet
      } else if (messageCount > 0) {
        resolvedTitle = '(processing…)';
      } else {
        resolvedTitle = 'New chat';
      }
      return {
        id: e.chat_id,
        // source = platform that owns this chat (parley / telegram /
        // slack / …). Empty/missing means parley by convention (the
        // legacy single-platform default). Drawer uses this to render
        // a source badge on non-parley rows + go composer-read-only.
        source: e.source || 'parley',
        title: resolvedTitle,
        snippet,
        lastMessageAt: lastActive,
        messageCount,
        // Optional split — drawer renders "N turns · M tools" when both
        // are present, falls back to "{messageCount} msgs" otherwise.
        turnCount: e.turn_count,
        toolCount: e.tool_count,
        sessionIds: e.session_ids,
      };
    });

    // Append local-only rows the server doesn't know about yet — chats
    // the user just minted but hasn't sent in. Without this, the
    // newly-created drawer entry would vanish on the first refresh
    // (server doesn't have it yet → not in `enrich` → dropped).
    //
    // v0.383 unification (2026-05-03): post-IDB-schema-v2 the local
    // store and server use the SAME prefixed id format
    // (`parley:<uuid>` from mintChatId). The merge collapses to a
    // straight key-equality check — no more `parley:${chat_id}`
    // prefix arithmetic. The earlier prefix-aware dedup hack was
    // covering for the bare/prefixed mismatch that's now eliminated
    // at the source.
    const serverIds = new Set(enrich.map(e => e.chat_id));
    for (const conv of local) {
      if (serverIds.has(conv.chat_id)) continue;
      merged.push({
        id: conv.chat_id,
        // Source is encoded in the chat_id prefix; default to parley
        // for any unprefixed legacy row (v1 IDB blasted on upgrade, so
        // this should never happen — defensive only).
        source: conv.chat_id.includes(':') ? conv.chat_id.split(':')[0] : 'parley',
        title: conv.title || 'New chat',
        // Local-only chats have no server-side snippet — they exist
        // because the user just minted a chat and hasn't sent yet.
        snippet: '',
        lastMessageAt: Math.floor(conv.last_message_at / 1000),
        messageCount: 0,
        turnCount: undefined,
        toolCount: undefined,
        sessionIds: undefined,
      });
    }
    // Resort: server may already be sorted but the appended local-only
    // rows could be older OR newer than the server's tail.
    merged.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));

    // Duplicate-id detector — investigating the 2026-05-02 sidebar
    // dual-select bug (two LIs with same data-chat-id ended up sharing
    // .active state). Logs a one-shot dump when collisions appear so we
    // can tell whether the dupe came from the server response, the
    // local-only append, or both. Always-on log() so it surfaces in
    // the in-app debug panel without needing the diag flag.
    const idCounts = new Map<string, number>();
    for (const m of merged) idCounts.set(m.id, (idCounts.get(m.id) || 0) + 1);
    const dupes = [...idCounts.entries()].filter(([, n]) => n > 1);
    if (dupes.length > 0) {
      const enrichSummary = enrich.map(e => ({ id: e.chat_id, source: e.source || 'parley', msgs: e.message_count || 0 }));
      const localOnlyAppended = local.filter(c => !new Set(enrich.map(e => e.chat_id)).has(c.chat_id)).map(c => ({ id: c.chat_id, source: 'parley (local-only)' }));
      const dupeSummary = dupes.map(([id, n]) => `${id}×${n}`).join(', ');
      log(`[listSessions] DUPLICATE IDs: ${dupeSummary}`);
      log(`[listSessions] enrich=${JSON.stringify(enrichSummary)}`);
      log(`[listSessions] local-only appended=${JSON.stringify(localOnlyAppended)}`);
    }

    // Surface the unconfigured state via a synthetic top row so the
    // drawer renders a clear hint without needing a new chrome path.
    if (unconfigured && merged.length === 0) {
      merged.unshift({
        id: '__parley:hint:unconfigured',
        source: 'parley',
        title: 'Parley proxy missing PARLEY_PLATFORM_TOKEN — sends will 503',
        snippet: '',
        lastMessageAt: Math.floor(Date.now() / 1000),
        messageCount: 0,
        turnCount: undefined,
        toolCount: undefined,
        sessionIds: undefined,
      });
    }
    return merged;
  },

  async resumeSession(id: string) {
    // Synthetic-hint row: silently ignore.
    if (id.startsWith('__parley:hint:')) {
      return { messages: [], firstId: null, hasMore: false };
    }
    // Phantom-resume guard: if `id` was deleted from this tab in the
    // last few seconds, return empty WITHOUT calling setActive(id) —
    // an in-flight click that fired before the delete would otherwise
    // re-pin lastActiveChatId on a chat that no longer exists, leaving the
    // PWA pointing at a phantom. The drawer's recentlyDeleted filter
    // hides the row but proxyClient state would still be wrong.
    if (isRecentlyDeleted(id)) {
      diag(`proxy-client.resumeSession: ${id} was just deleted, skipping setActive + fetch`);
      return { messages: [], firstId: null, hasMore: false };
    }
    // Lazily hydrate the local IDB row if this is a server-side chat
    // we've never touched on this device (cross-device, or after a
    // clear-site-data on a device that previously had it). Without
    // this, conversations.setActive/updateLastMessageAt downstream
    // would silently no-op on missing rows.
    try {
      await conversations.hydrate(id);
    } catch (e: any) {
      diag(`proxy-client.resumeSession: IDB hydrate failed: ${e.message}`);
    }
    // Persist "this is where I was" for the NEXT boot, and keep the
    // in-process memo in step with the row we just wrote.
    //
    // This used to run FIRST, ahead of the hydrate, under a comment
    // claiming the active chat_id was "the single source of truth" and
    // that the next sendMessage would follow it. Neither half was true
    // any more, and the ordering was load-bearing for exactly the bug we
    // are removing: it made resumeSession — which boot restore, cmd-K,
    // drill and the foreground reconcile all call — able to re-aim
    // "where the user is" as a side effect of fetching a transcript. On
    // 2026-09-06 boot's restore did that three seconds after the user
    // had tapped a different chat (UX_DETERMINISM_PLAN §1).
    //
    // It is now a plain derived cache written next to the IDB row it
    // mirrors. Addressing lives in switchController; sends carry their
    // own chat id (see sendMessage). Nothing reads this to decide where
    // a message goes, so its position no longer matters — which is the
    // whole point.
    await conversations.setActive(id);
    lastActiveChatId = id;
    // Fetch transcript via the proxy. The endpoint resolves chat_id →
    // session_id by looking up state.db.sessions.session_key, then walks
    // the parent_session_id chain so compression rotations show their
    // full transcript. On any failure (proxy down, unconfigured token,
    // unknown chat_id) we return an empty transcript and let the user
    // continue the chat — better than a hard error toast for what is
    // strictly enrichment. Delta-aware: with a cached tail in IDB only
    // the rows past it are fetched (#191).
    const result = await fetchSessionMessagesDelta(id, 'proxy-client.resumeSession');
    // A successful full resume IS a reconcile for the (new) active
    // chat — clear any outstanding reconcile debt so a stale owed flag
    // from a previous chat doesn't trigger a redundant refetch on the
    // next lifecycle event.
    if (!(result as any)?.error) clearReconcileDebt();
    return result;
  },

  /** Fetch a session transcript without changing lastActiveChatId or IDB
   *  active state. Used by active-chat post-final refresh: after
   *  reply_final, the shell wants a fresh durable snapshot so the
   *  transcript store can drain completed inflight envelopes, but it
   *  must not steal focus if the user switches chats while the request
   *  is in flight. Delta-aware (#191): the post-final refresh fires
   *  after EVERY reply, so with a warm cache it pulls just the new
   *  turn's rows instead of the full ~1MB newest page. */
  async fetchSessionMessages(id: string) {
    return fetchSessionMessagesDelta(id, 'proxy-client.fetchSessionMessages');
  },

  /** Tiny newest-page fetch used ONLY to warm the IDB cache at boot
   *  (sessionDrawer.warmPrefetch). A full page is ~750KB-1MB; over a
   *  high-latency link 8 of those serially saturate the pipe and starve
   *  the user's actual drill. A handful of rows warms the cache (resume()
   *  renders it instantly, then grows it from the server) for ~12KB, so
   *  the speculative prefetch barely touches the link. */
  async prefetchSessionMessages(id: string) {
    return fetchSessionMessages(id, 'proxy-client.prefetch', 12);
  },

  /** Replay inflight envelopes through the live-SSE router. Called
   *  by the shell AFTER replaySessionMessages has finished rendering
   *  state.db messages (otherwise the clear path inside it would
   *  wipe the replayed bubbles). Idempotent via envelope stable ids
   *  — if the same envelope ALSO arrives via live SSE during this
   *  window, renderedMessages.upsert + activityRow.upsert collapse
   *  it to a single bubble.
   *
   *  Each envelope is stamped `_replay: true` before dispatch so the
   *  handlers route to their replay-aware branches (suppress chime,
   *  badge increment, TTS playback, lastMessageAt bump, etc.) — same
   *  contract the SSE ring replay already uses for fresh-subscriber
   *  catch-up. Without this flag, a chat whose inflight cache grew
   *  large (cron-firing chats where each new envelope cancels the 30s
   *  pendingDrop and the cache accumulates reply_finals over many
   *  turns) would re-fire the receive chime on every switch-in. */
  replayInflight(chatId: string, envelopes: any[]): void {
    if (!envelopes || envelopes.length === 0) return;
    diag(`proxy-client: replaying ${envelopes.length} inflight envelopes for ${chatId}`);
    for (const env of envelopes) {
      const t = typeof env?.type === 'string' ? env.type : '';
      if (!t) continue;
      handleEnvelope(t, { ...env, _replay: true }, chatId);
    }
  },

  async loadEarlier(id: string, beforeId: number) {
    if (id.startsWith('__parley:hint:')) {
      return { messages: [], firstId: null, hasMore: false };
    }
    const q = new URLSearchParams({ before: String(beforeId), limit: String(PAGE_LIMIT) });
    const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(id)}/messages?${q}`);
    if (!r.ok) throw new Error(`loadEarlier HTTP ${r.status}`);
    const d = await r.json();
    return {
      messages: d.messages || [],
      firstId: d.firstId ?? null,
      hasMore: !!d.hasMore,
    };
  },

  /** GET /sessions/<id>/messages?after=<cursor> → the next page of NEWER
   *  messages (load-newer), the symmetric counterpart to loadEarlier.
   *  Used to connect a floating deep `around` window back to the live
   *  tail. `hasMoreNewer===false` means this page reached the tail. */
  async loadLater(id: string, afterId: number) {
    if (id.startsWith('__parley:hint:')) {
      return { messages: [], lastId: null, hasMoreNewer: false };
    }
    const q = new URLSearchParams({ after: String(afterId), limit: String(PAGE_LIMIT) });
    const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(id)}/messages?${q}`);
    if (!r.ok) throw new Error(`loadLater HTTP ${r.status}`);
    const d = await r.json();
    return {
      messages: d.messages || [],
      lastId: d.lastId ?? null,
      hasMoreNewer: !!d.hasMoreNewer,
    };
  },

  /** GET /sessions/<id>/messages?around=<target> → a bounded window
   *  centered on the deep-drill target (context above + below) in ONE
   *  round trip instead of N serial loadEarlier pages. `targetFound===false`
   *  (with an empty list) means the target is missing; the caller falls
   *  back to its serial drill. `hasMore`/`hasMoreNewer` + `firstId`/`lastId`
   *  describe the bidirectional pagination cursors for the loaded window. */
  async fetchMessagesAround(id: string, target: string, limit?: number) {
    if (id.startsWith('__parley:hint:')) {
      return { messages: [], firstId: null, hasMore: false, lastId: null, hasMoreNewer: false, targetFound: false };
    }
    const q = new URLSearchParams({ around: String(target) });
    if (limit != null) q.set('limit', String(limit));
    const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(id)}/messages?${q}`);
    if (!r.ok) throw new Error(`fetchMessagesAround HTTP ${r.status}`);
    const d = await r.json();
    return {
      messages: d.messages || [],
      firstId: d.firstId ?? null,
      hasMore: !!d.hasMore,
      lastId: d.lastId ?? null,
      hasMoreNewer: !!d.hasMoreNewer,
      targetFound: !!d.targetFound,
      ...(Array.isArray(d.inflight) ? { inflight: d.inflight } : {}),
    };
  },

  /** GET /api/parley/settings/schema → agent-declared settings list,
   *  or `null` if the agent doesn't implement the optional extension
   *  (404). Caller (settings panel) hides the "Agent" group on null. */
  async getSettingsSchema(): Promise<any[] | null> {
    try {
      const r = await fetch(`${apiBase()}/settings/schema`);
      if (r.status === 404) return null;
      if (!r.ok) {
        diag(`proxy-client.getSettingsSchema: HTTP ${r.status}`);
        return null;
      }
      const j = await r.json();
      return Array.isArray(j?.data) ? j.data : [];
    } catch (e: any) {
      diag(`proxy-client.getSettingsSchema failed: ${e.message}`);
      return null;
    }
  },

  /** POST /api/parley/settings/{id} {value} → updated SettingDef.
   *  Throws on 4xx/5xx with the upstream's error.message extracted so
   *  the panel can revert + surface the message inline. */
  async updateSetting(id: string, value: unknown): Promise<any> {
    const r = await fetch(`${apiBase()}/settings/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        msg = j?.error?.message ?? msg;
      } catch {}
      const err = new Error(msg) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    return await r.json();
  },

  /** Scheduled-jobs extension (Settings › Cron). GET /api/parley/jobs →
   *  JobsPayload, or null when the agent has no scheduler (404). */
  async listJobs(): Promise<any | null> {
    try {
      const r = await fetch(`${apiBase()}/jobs`);
      if (r.status === 404) return null;
      if (!r.ok) { diag(`proxy-client.listJobs: HTTP ${r.status}`); return null; }
      return await r.json();
    } catch (e: any) {
      diag(`proxy-client.listJobs failed: ${e.message}`);
      return null;
    }
  },

  /** POST /api/parley/jobs/{id} {enabled?, deliver?, model?} → updated JobDef.
   *  Throws with the agent's message on rejection so the panel can revert. */
  async updateJob(id: string, body: Record<string, unknown>): Promise<any> {
    const r = await fetch(`${apiBase()}/jobs/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await errorMessage(r));
    return r.json();
  },

  /** GET /api/parley/health → {data: HealthCheck[]} or null when unsupported (404). */
  async listHealth(): Promise<any | null> {
    try {
      const r = await fetch(`${apiBase()}/health`);
      if (r.status === 404) return null;
      if (!r.ok) { diag(`proxy-client.listHealth: HTTP ${r.status}`); return null; }
      return await r.json();
    } catch (e: any) { diag(`proxy-client.listHealth failed: ${e.message}`); return null; }
  },

  /** POST /api/parley/health/{id}/run → fresh HealthCheck. May take minutes. */
  async runHealth(id: string): Promise<any> {
    const r = await fetch(`${apiBase()}/health/${encodeURIComponent(id)}/run`, { method: 'POST' });
    if (!r.ok) throw new Error(await errorMessage(r));
    return r.json();
  },

  /** DELETE /api/parley/jobs/{id} → {deleted:true}. Permanent. */
  async deleteJob(id: string): Promise<any> {
    const r = await fetch(`${apiBase()}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await errorMessage(r));
    return r.json();
  },

  /** POST /api/parley/jobs/{id}/run → JobDef (queued for the next tick). */
  async runJob(id: string): Promise<any> {
    const r = await fetch(`${apiBase()}/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' });
    if (!r.ok) throw new Error(await errorMessage(r));
    return r.json();
  },

  async renameSession(id: string, title: string) {
    // Two-step: stamp the local IDB row first (the listSessions merge
    // prefers `userTitle` over server auto-titles, so the rename feels
    // permanent from this device's POV), then fire-and-forget the
    // server-side PATCH so other connected clients (Mac + iPhone) pick
    // up the new title via /v1/events session_changed.
    //
    // Local stamp is the source of truth for THIS device — the server
    // PATCH is best-effort. We log a failure but never throw, because
    // a network blip on the propagation step shouldn't undo the local
    // rename the user just confirmed.
    if (id.startsWith('__parley:hint:')) return;
    const trimmed = title.trim();
    await conversations.setUserTitle(id, trimmed);
    log(`proxy-client: renamed session ${id} to "${trimmed.slice(0, 40)}"`);
    // Fire-and-forget — don't await.
    void (async () => {
      try {
        const r = await fetch(
          `${apiBase()}/sessions/${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: trimmed }),
          },
        );
        if (!r.ok && r.status !== 404 && r.status !== 503) {
          const errText = await r.text().catch(() => '');
          diag(`proxy-client.renameSession: server PATCH returned ${r.status}: ${errText.slice(0, 120)}`);
        }
      } catch (e: any) {
        diag(`proxy-client.renameSession: server PATCH failed: ${e?.message || String(e)}`);
      }
    })();
  },

  async deleteSession(id: string) {
    if (id.startsWith('__parley:hint:')) return;
    // Mark BEFORE the network round-trip so any concurrent resumeSession
    // for the same id sees the flag and short-circuits before its own
    // setActive(id) re-pins lastActiveChatId. Without this, click-then-
    // immediate-delete races re-pin after delete clears lastActiveChatId,
    // and the drawer paints a placeholder for the deleted chat.
    markRecentlyDeleted(id);
    // Server delete FIRST, and failures PROPAGATE (latency-audit A1,
    // 2026-07-13): the old best-effort swallow removed the local row
    // even when the server kept its copy — the session then resurrected
    // as a zombie on the next list refresh, which reads as "delete
    // randomly didn't work". The optimistic caller (sessionDrawer)
    // already removed the ROW from view; a thrown error here is its
    // rollback signal. Tolerated statuses:
    //   404            — already gone (success for our purposes)
    //   405 / 501      — backend has no delete endpoint (npx stub);
    //                    local-only delete is the feature, not a bug.
    const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok && ![404, 405, 501].includes(r.status)) {
      const errText = await r.text().catch(() => '');
      diag(`proxy-client.deleteSession: proxy returned ${r.status}: ${errText.slice(0, 120)}`);
      throw new Error(`server delete failed (HTTP ${r.status})`);
    }
    await conversations.remove(id);
    if (lastActiveChatId === id) {
      lastActiveChatId = null;
      await conversations.setActive(null);
    }
    log(`proxy-client: deleted session ${id}`);
  },

  async search(q: string, _kind: 'sessions' | 'messages' | 'both', opts?: { limit?: number; signal?: AbortSignal }) {
    const trimmed = (q || '').trim();
    if (!trimmed) return { sessions: [], hits: [] };
    const params = new URLSearchParams({ q: trimmed });
    if (opts?.limit) params.set('limit', String(opts.limit));
    try {
      const r = await fetch(`${apiBase()}/search?${params}`, { signal: opts?.signal });
      if (r.status === 404) return { sessions: [], hits: [] };
      if (!r.ok) {
        diag(`proxy-client.search: HTTP ${r.status}`);
        return { sessions: [], hits: [], error: `HTTP ${r.status}` };
      }
      const body = await r.json();
      return {
        sessions: Array.isArray(body?.sessions) ? body.sessions : [],
        hits: Array.isArray(body?.hits) ? body.hits : [],
      };
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      diag(`proxy-client.search: ${e?.message || String(e)}`);
      return { sessions: [], hits: [], error: e?.message || String(e) };
    }
  },
};
