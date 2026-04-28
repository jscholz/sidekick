/**
 * @fileoverview Hermes-gateway BackendAdapter — sidekick's "platform-adapter"
 * peer of telegram/slack/signal in hermes-agent. Wraps the proxy's
 * /api/sidekick/* HTTP/SSE surface (server-lib/backends/hermes-gateway/)
 * into the BackendAdapter contract. Coexists with the legacy hermes.ts
 * adapter, which talks to /api/hermes/responses (/v1/responses) — both
 * stay live; the user picks one via the backend setting.
 *
 * Wire path:
 *   PWA → POST /api/sidekick/messages {chat_id, text}    (fire-and-forget)
 *           ↓ (proxy WS client)
 *   hermes platform adapter (in-process, ws://127.0.0.1:8645)
 *           ↓
 *   gateway agent run, owns sessions per chat_id
 *           ↓
 *   adapter → reply_delta / reply_final / image / typing /
 *             session_changed / notification envelopes back over WS
 *           ↓
 *   proxy fans every envelope onto /api/sidekick/stream (one
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
 * @typedef {import('./types.ts').BackendAdapter} BackendAdapter
 * @typedef {import('./types.ts').ConnectOpts} ConnectOpts
 * @typedef {import('./types.ts').SendOpts} SendOpts
 */

import { log, diag } from '../util/log.ts';
import * as conversations from '../conversations.ts';

let subs: any = null;
let connected = false;
/** Active chat_id memoized in-process. Hydrated on connect() from IDB.
 *  setCurrentSessionId / resumeSession / newSession / first-message
 *  paths all funnel through this so lookups don't hit IDB on the
 *  hot path. */
let activeChatId: string | null = null;
/** Per-bubble streaming state, keyed off the envelope's message_id so
 *  multiple in-flight bubbles (across the same or different chats)
 *  stream cleanly without colliding. The map gets cleared on each
 *  bubble's reply_final so it doesn't grow unbounded. */
const bubbleReplyIds = new Map<string, string>();
/** Health-poll handle. We use GET /api/sidekick/sessions as a cheap
 *  liveness probe — its handler is the same one the drawer calls, so
 *  there's no separate health route to mount. */
let healthTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_INTERVAL_MS = 30_000;
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

function newReplyId(): string {
  return `sk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Resolve a stable replyId for a streaming bubble. The adapter sends
 *  its own message_id on every reply_delta / reply_final for a bubble,
 *  so use that as the map key. Falls back to a synthetic id keyed on
 *  chat_id when message_id is missing — the shell still stitches
 *  delta + final by replyId, so cohesion within one bubble is
 *  preserved either way. */
function replyIdFor(env: any, chatId: string): string {
  const msgId = typeof env?.message_id === 'string' && env.message_id
    ? env.message_id
    : `chat:${chatId}`;
  let id = bubbleReplyIds.get(msgId);
  if (!id) {
    id = newReplyId();
    bubbleReplyIds.set(msgId, id);
  }
  return id;
}

function clearBubble(env: any, chatId: string): void {
  const msgId = typeof env?.message_id === 'string' && env.message_id
    ? env.message_id
    : `chat:${chatId}`;
  bubbleReplyIds.delete(msgId);
}

function apiBase(): string {
  return `${location.origin}/api/sidekick`;
}

interface SessionsResponse {
  sessions: Array<{
    chat_id: string;
    session_id?: string | null;
    title?: string | null;
    message_count?: number;
    last_active_at?: string | number | null;
    created_at?: string | number | null;
  }>;
  unconfigured?: boolean;
}

/** Probe the proxy. `unconfigured: true` from the server means the
 *  proxy is running but `SIDEKICK_PLATFORM_TOKEN` is unset — surface
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

function startHealthPoll(): void {
  if (healthTimer) return;
  const tick = async () => {
    const { ok } = await probeSessions();
    if (ok !== connected) {
      connected = ok;
      subs?.onStatus?.(ok);
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
    log('hermes-gateway: stream channel already open, replacing');
    try { streamES.close(); } catch {}
    streamES = null;
  }
  try {
    streamES = new EventSource(`${apiBase()}/stream`);
    log('hermes-gateway: stream channel (re)opened');
  } catch (e: any) {
    diag(`hermes-gateway: stream EventSource open failed: ${e.message}`);
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
      diag('hermes-gateway: stream non-JSON frame ignored');
      return;
    }
    const type = (env && typeof env.type === 'string') ? env.type : ev.type;
    const chatId = typeof env?.chat_id === 'string' ? env.chat_id : '';
    if (!chatId) return;
    handleEnvelope(type, env, chatId);
  };
  for (const t of ['reply_delta', 'reply_final', 'image', 'typing',
                   'notification', 'session_changed', 'error',
                   'tool_call', 'tool_result']) {
    streamES.addEventListener(t, onEvent as any);
  }
  streamES.onerror = (e) => {
    // EventSource auto-reconnects on transient errors (DNS hiccup,
    // brief WiFi gap) using the server's `retry: 5000` hint, so we
    // intentionally do NOT call forceReconnect here — calling close()
    // would defeat native retry. The OS-lifecycle listeners
    // (visibility/online/pageshow) are the belt-and-suspenders path
    // for the mobile-Safari background-kill case where native retry
    // doesn't fire at all.
    diag(`hermes-gateway: stream errored (will retry): ${(e as any)?.message || ''}`);
  };
}

function stopStreamChannel(): void {
  if (streamES) {
    try { streamES.close(); } catch {}
    streamES = null;
  }
  bubbleReplyIds.clear();
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
      diag(`hermes-gateway: reconcile failed: ${e.message}`);
    });
  }, 500);
}

/** Refetch + replay the active chat's transcript when the stream channel
 *  has been down long enough that the server's 128-entry replay ring may
 *  not cover what we missed. Skips when:
 *    - no active chat (nothing to reconcile against)
 *    - no shell subscription (adapter not wired up)
 *    - the gap since the previous reconnect is short (<10s) — ring
 *      replay via Last-Event-ID should have caught us up.
 *  When fired, delegates to the SAME path the drawer-click resume uses
 *  (`onResume` callback → shell clears + re-renders). The shell already
 *  knows how to reconcile a fresh transcript dump, so we don't need an
 *  incremental diff; the brief "loading…" flash is acceptable for the
 *  rare iOS-backgrounding case. */
async function reconcileActiveChat(gapMs: number): Promise<void> {
  if (!activeChatId || !subs?.onResume) return;
  if (gapMs < RECONCILE_GAP_MS) {
    diag(`hermes-gateway: reconcile skipped (gap ${gapMs}ms < ${RECONCILE_GAP_MS}ms)`);
    return;
  }
  log(`[resume-trace] reconcileActiveChat firing for ${activeChatId.slice(0,8)} (gap ${gapMs}ms)`);
  log(`hermes-gateway: reconciling active chat ${activeChatId} after ${gapMs}ms gap`);
  try {
    const r = await fetch(
      `${apiBase()}/sessions/${encodeURIComponent(activeChatId)}/messages`,
    );
    if (!r.ok) {
      diag(`hermes-gateway: reconcile HTTP ${r.status}`);
      return;
    }
    const d = await r.json();
    const messages = Array.isArray(d.messages) ? d.messages : [];
    // Clear in-flight bubble state — the shell will repaint from
    // history, so any half-rendered bubble we were streaming into is
    // now stale. The dedupe guard sits in the shell's onResume
    // handler (it clears + re-renders the chat).
    bubbleReplyIds.clear();
    subs.onResume({
      messages,
      conversation: activeChatId,
      firstId: d.firstId ?? null,
      hasMore: !!d.hasMore,
    });
  } catch (e: any) {
    diag(`hermes-gateway: reconcile fetch failed: ${e.message}`);
  }
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
    if (document.visibilityState === 'visible') {
      log('hermes-gateway: visibilitychange → forceReconnect');
      forceReconnect();
    }
  });
  window.addEventListener('online', () => {
    log('hermes-gateway: online → forceReconnect');
    forceReconnect();
  });
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) {
      log('hermes-gateway: pageshow(persisted) → forceReconnect');
      forceReconnect();
    }
  });
}

function handleEnvelope(type: string, env: any, chatId: string): void {
  switch (type) {
    case 'typing':
      subs?.onActivity?.({ working: true, detail: 'pending', conversation: chatId });
      return;

    case 'reply_delta': {
      const text = typeof env.text === 'string' ? env.text : '';
      if (!text) return;
      const replyId = replyIdFor(env, chatId);
      subs?.onActivity?.({ working: true, detail: 'streaming', conversation: chatId });
      // Adapter contract guarantees `text` is the full cumulative text
      // for this bubble — pass straight through as cumulativeText.
      subs?.onDelta?.({ replyId, cumulativeText: text, conversation: chatId });
      return;
    }

    case 'reply_final': {
      const replyId = replyIdFor(env, chatId);
      const finalText = typeof env.text === 'string' ? env.text : '';
      clearBubble(env, chatId);
      // Note: working=false here means "this bubble is done." If the
      // adapter sends a follow-up bubble (bootstrap nudge → reply, or
      // tool-result-as-text), the next reply_delta will flip activity
      // back on. The shell's two-state thinking indicator can flicker
      // briefly between bubbles — acceptable.
      subs?.onActivity?.({ working: false, conversation: chatId });
      subs?.onFinal?.({ replyId, text: finalText, conversation: chatId });
      // Bump last_message_at so the drawer sort surfaces this row even
      // before /api/sidekick/sessions enrichment refreshes.
      conversations.updateLastMessageAt(chatId, Date.now()).catch(() => {});
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

    case 'session_changed': {
      // Compression rotated the gateway session. Update the local
      // title so the drawer reflects whatever auto-numbered name the
      // adapter sent (e.g. "My project" → "My project #2"). No special
      // UI affordance for "compressed" state in v1.
      if (typeof env.title === 'string' && env.title) {
        conversations.updateTitle(chatId, env.title).catch(() => {});
      }
      return;
    }

    case 'notification': {
      // Push notification (cron, /background result, scheduled
      // reminder). May target ANY chat_id, not just the active one;
      // shell decides what to render where (system row in the matching
      // thread, badge on the drawer entry, etc.).
      const kind = typeof env.kind === 'string' ? env.kind : 'unknown';
      const content = typeof env.content === 'string' ? env.content : '';
      log(`hermes-gateway: notification kind=${kind} chat_id=${chatId}`);
      subs?.onNotification?.({ chatId, kind, content });
      // Bump the drawer ordering so the chat with the freshest
      // notification floats up. last_message_at semantically tracks
      // "most-recent activity" — a cron-pushed message qualifies.
      conversations.updateLastMessageAt(chatId, Date.now()).catch(() => {});
      return;
    }

    case 'error':
      log(`hermes-gateway: error for ${chatId}: ${env.detail || 'unknown'}`);
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
      subs?.onToolResult?.({
        callId,
        result,
        error,
        truncated,
        durationMs,
        conversation: chatId,
      });
      return;
    }

    default:
      diag(`hermes-gateway: ignored envelope type=${type}`);
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export const hermesGatewayAdapter = {
  name: 'hermes-gateway',

  capabilities: {
    streaming: true,
    sessions: true,           // chat_id provides multi-session semantics
    models: false,            // not exposed via the gateway adapter (yet)
    toolEvents: true,         // tool_call / tool_result envelopes (Phase 3); image is also tool-like

    history: true,            // /api/sidekick/sessions/<chat_id>/messages
    attachments: false,       // wire shape allows it, no PWA composer support yet
    sessionBrowsing: true,    // /api/sidekick/sessions
    slashCommands: true,      // gateway parses /new, /compress, /resume, /undo, /background
  },

  async connect(opts: any) {
    subs = opts;
    // Hydrate the active chat_id from IDB so getCurrentSessionId can
    // answer synchronously after connect resolves. We don't AUTO-mint
    // here — first-send / explicit-new-chat allocates lazily.
    try {
      activeChatId = await conversations.getActive();
    } catch (e: any) {
      diag(`hermes-gateway: getActive failed: ${e.message}`);
      activeChatId = null;
    }
    const probe = await probeSessions();
    connected = probe.ok;
    opts.onStatus?.(probe.ok);
    if (probe.ok) {
      if (probe.unconfigured) {
        log('hermes-gateway: connected (proxy reports SIDEKICK_PLATFORM_TOKEN unset — sends will 503)');
      } else {
        log('hermes-gateway: connected');
      }
    } else {
      log('hermes-gateway: probe failed — is the proxy running?');
    }
    startHealthPoll();
    startStreamChannel();
    // OS-lifecycle hardening: visibility/online/pageshow trigger a
    // forceReconnect because mobile-Safari silently kills the
    // EventSource on background / radio suspend / network handoff
    // without firing onerror. Bound once per page lifetime.
    bindLifecycleHandlers();
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
      if (ok) log('hermes-gateway: reconnected');
    });
  },

  isConnected() {
    return connected;
  },

  async sendMessage(text: string, opts: any = {}) {
    if (!connected) {
      diag('hermes-gateway.sendMessage: DROPPED (not connected)');
      throw new Error('Sidekick proxy not connected');
    }
    // Lazy-allocate: first send under no active chat_id mints one.
    // Drawer entries created by the user clicking "new chat" go via
    // newSession() below.
    if (!activeChatId) {
      const conv = await conversations.getOrCreateActive();
      activeChatId = conv.chat_id;
    }
    const chatId = activeChatId!;

    const body: Record<string, any> = { chat_id: chatId, text };
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      body.attachments = opts.attachments;
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
        throw new Error(`Sidekick HTTP ${res.status}: ${detail}`);
      }
      // Optimistic activity flip — flips back to working=true on the
      // first reply_delta / typing envelope. Pre-confirm "we sent it"
      // so the UI shows a live indicator even if the agent takes a
      // moment before its first stream tick.
      subs?.onActivity?.({ working: true, detail: 'pending', conversation: chatId });
    } catch (e: any) {
      diag(`hermes-gateway.sendMessage failed: ${e.message}`);
      subs?.onActivity?.({ working: false, conversation: chatId });
      throw e;
    }
  },

  async newSession() {
    // Mint a fresh chat_id locally + flip active. The proxy / adapter
    // learns about it the moment the user sends their first message
    // under it; until then nothing crosses the wire.
    const conv = await conversations.create();
    await conversations.setActive(conv.chat_id);
    activeChatId = conv.chat_id;
    bubbleReplyIds.clear();
    log(`hermes-gateway: new session (chat_id=${conv.chat_id})`);
  },

  getCurrentSessionId() {
    return activeChatId;
  },

  /** Imperative active-chat setter. Currently UNUSED by the shell:
   *  every active-chat flip funnels through resumeSession (drawer
   *  click) or newSession (toolbar / first-message), both of which
   *  already write activeChatId + persist to IDB. Kept on the adapter
   *  so callers that want a no-history-fetch session switch (e.g. a
   *  future cmdk palette quick-jump that does its own snapshot replay)
   *  have a stable hook. NOT exported through src/backend.ts —
   *  promote it through the dispatcher when a real call site lands. */
  async setCurrentSessionId(chat_id: string | null) {
    activeChatId = chat_id;
    await conversations.setActive(chat_id);
    bubbleReplyIds.clear();
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
      diag(`hermes-gateway.listSessions: server unreachable, falling back to local-only: ${e.message}`);
    }

    if (!serverReachable) {
      // Offline / proxy down — render whatever we have locally so the
      // drawer doesn't go blank.
      return local.map(conv => ({
        id: conv.chat_id,
        title: conv.title || 'New chat',
        lastMessageAt: Math.floor(conv.last_message_at / 1000),
        messageCount: 0,
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
      return {
        id: e.chat_id,
        title: e.title || localConv?.title || 'New chat',
        lastMessageAt: lastActive,
        messageCount: e.message_count || 0,
      };
    });

    // Append local-only rows the server doesn't know about yet — chats
    // the user just minted but hasn't sent in. Without this, the
    // newly-created drawer entry would vanish on the first refresh
    // (server doesn't have it yet → not in `enrich` → dropped).
    const serverIds = new Set(enrich.map(e => e.chat_id));
    for (const conv of local) {
      if (!serverIds.has(conv.chat_id)) {
        merged.push({
          id: conv.chat_id,
          title: conv.title || 'New chat',
          lastMessageAt: Math.floor(conv.last_message_at / 1000),
          messageCount: 0,
        });
      }
    }
    // Resort: server may already be sorted but the appended local-only
    // rows could be older OR newer than the server's tail.
    merged.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));

    // Surface the unconfigured state via a synthetic top row so the
    // drawer renders a clear hint without needing a new chrome path.
    if (unconfigured && merged.length === 0) {
      merged.unshift({
        id: '__sidekick:hint:unconfigured',
        title: 'Sidekick proxy missing SIDEKICK_PLATFORM_TOKEN — sends will 503',
        lastMessageAt: Math.floor(Date.now() / 1000),
        messageCount: 0,
      });
    }
    return merged;
  },

  async resumeSession(id: string) {
    // Synthetic-hint row: silently ignore.
    if (id.startsWith('__sidekick:hint:')) {
      return { messages: [], firstId: null, hasMore: false };
    }
    // Flip the active pointer FIRST. The next sendMessage uses this
    // chat_id even if the history fetch below errors — the gateway
    // resolves (Platform.SIDEKICK, chat_id) → session_id internally
    // so the conversation continues server-side regardless. We don't
    // need a token-monotonic guard like hermes.ts because the active
    // chat_id is the single source of truth and IDB write is atomic.
    activeChatId = id;
    // Lazily hydrate the local IDB row if this is a server-side chat
    // we've never touched on this device (cross-device, or after a
    // clear-site-data on a device that previously had it). Without
    // this, conversations.setActive/updateLastMessageAt downstream
    // would silently no-op on missing rows.
    try {
      await conversations.hydrate(id);
    } catch (e: any) {
      diag(`hermes-gateway.resumeSession: IDB hydrate failed: ${e.message}`);
    }
    await conversations.setActive(id);
    bubbleReplyIds.clear();
    // Fetch transcript via the proxy. The endpoint resolves chat_id →
    // session_id by looking up state.db.sessions.session_key, then walks
    // the parent_session_id chain so compression rotations show their
    // full transcript. On any failure (proxy down, unconfigured token,
    // unknown chat_id) we return an empty transcript and let the user
    // continue the chat — better than a hard error toast for what is
    // strictly enrichment.
    try {
      const r = await fetch(
        `${apiBase()}/sessions/${encodeURIComponent(id)}/messages`,
      );
      if (!r.ok) {
        diag(`hermes-gateway.resumeSession: HTTP ${r.status} for ${id}`);
        log(`hermes-gateway: resumed (chat_id=${id}, history fetch failed)`);
        return { messages: [], firstId: null, hasMore: false };
      }
      const d = await r.json();
      const result = {
        messages: d.messages || [],
        firstId: d.firstId ?? null,
        hasMore: !!d.hasMore,
      };
      log(`hermes-gateway: resumed (chat_id=${id}, ${result.messages.length} messages, hasMore=${result.hasMore})`);
      return result;
    } catch (e: any) {
      diag(`hermes-gateway.resumeSession: ${e.message}`);
      return { messages: [], firstId: null, hasMore: false };
    }
  },

  async loadEarlier(id: string, beforeId: number) {
    if (id.startsWith('__sidekick:hint:')) {
      return { messages: [], firstId: null, hasMore: false };
    }
    const q = new URLSearchParams({ before: String(beforeId) });
    const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(id)}/messages?${q}`);
    if (!r.ok) throw new Error(`loadEarlier HTTP ${r.status}`);
    const d = await r.json();
    return {
      messages: d.messages || [],
      firstId: d.firstId ?? null,
      hasMore: !!d.hasMore,
    };
  },

  async deleteSession(id: string) {
    if (id.startsWith('__sidekick:hint:')) return;
    // Drop the proxy-side row first (best-effort — the local row is
    // the source of truth, but we want the drawer-enrichment query
    // to stop returning this id immediately). Then drop locally + clear
    // active pointer if needed.
    try {
      const r = await fetch(`${apiBase()}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404 && r.status !== 503) {
        const errText = await r.text().catch(() => '');
        diag(`hermes-gateway.deleteSession: proxy returned ${r.status}: ${errText.slice(0, 120)}`);
      }
    } catch (e: any) {
      diag(`hermes-gateway.deleteSession: proxy delete failed: ${e.message}`);
    }
    await conversations.remove(id);
    if (activeChatId === id) {
      activeChatId = null;
      await conversations.setActive(null);
    }
    log(`hermes-gateway: deleted session ${id}`);
  },
};
