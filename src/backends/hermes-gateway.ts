/**
 * @fileoverview Hermes-gateway BackendAdapter — sidekick's "platform-adapter"
 * peer of telegram/slack/signal in hermes-agent. Wraps the proxy's
 * /api/sidekick/* HTTP/SSE surface (server-lib/backends/hermes-gateway/)
 * into the BackendAdapter contract. Coexists with the legacy hermes.ts
 * adapter, which talks to /api/hermes/responses (/v1/responses) — both
 * stay live until Phase 4.
 *
 * Wire path:
 *   PWA → POST /api/sidekick/messages {chat_id, text}
 *           ↓ (proxy WS client)
 *   hermes platform adapter (in-process, ws://127.0.0.1:8645)
 *           ↓
 *   gateway agent run, owns sessions per chat_id
 *           ↓
 *   adapter → reply_delta / reply_final / image / typing /
 *             session_changed / notification envelopes back over WS
 *           ↓
 *   proxy mirrors as SSE (event=type, data=envelope verbatim)
 *           ↓
 *   we parse here; emit normalized BackendAdapter events.
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
let inflight: AbortController | null = null;
/** Active chat_id memoized in-process. Hydrated on connect() from IDB.
 *  setCurrentSessionId / resumeSession / newSession / first-message
 *  paths all funnel through this so lookups don't hit IDB on the
 *  hot path. */
let activeChatId: string | null = null;
/** Per-turn streaming state. The adapter sends `reply_delta` with the
 *  FULL cumulative text per envelope (BasePlatformAdapter contract),
 *  so we can pass `text` straight through as `cumulativeText`. */
let currentReplyId: string | null = null;
/** Health-poll handle. We use GET /api/sidekick/sessions as a cheap
 *  liveness probe — its handler is the same one the drawer calls, so
 *  there's no separate health route to mount. */
let healthTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_INTERVAL_MS = 30_000;
/** Persistent notifications EventSource. EventSource auto-reconnects
 *  on transient failures (5s retry hint set by the server), so we
 *  open once on connect() and let it handle redial. */
let notifyES: EventSource | null = null;

function newReplyId(): string {
  return `sk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/** Open the persistent notifications channel. Idempotent — calling
 *  twice keeps the existing source. EventSource handles reconnect via
 *  the `retry: 5000` hint the server emits, so we don't manage the
 *  lifecycle ourselves beyond open / close on connect / disconnect. */
function startNotificationsChannel(): void {
  if (notifyES) return;
  try {
    notifyES = new EventSource(`${apiBase()}/notifications`);
  } catch (e: any) {
    diag(`hermes-gateway: notifications EventSource open failed: ${e.message}`);
    return;
  }
  notifyES.addEventListener('notification', (ev: MessageEvent) => {
    let env: any;
    try { env = JSON.parse(ev.data); }
    catch {
      diag('hermes-gateway: notifications non-JSON frame ignored');
      return;
    }
    const chatId = typeof env?.chat_id === 'string' ? env.chat_id : '';
    if (!chatId) return;
    const kind = typeof env?.kind === 'string' ? env.kind : 'unknown';
    const content = typeof env?.content === 'string' ? env.content : '';
    log(`hermes-gateway: notification kind=${kind} chat_id=${chatId}`);
    subs?.onNotification?.({ chatId, kind, content });
    // Bump the drawer ordering so the chat with the freshest notification
    // floats up. last_message_at semantically tracks "most-recent
    // activity" — a cron-pushed message qualifies.
    conversations.updateLastMessageAt(chatId, Date.now()).catch(() => {});
  });
  notifyES.onerror = (e) => {
    // EventSource auto-reconnects; just log so transient blips are
    // visible without closing the source (closing would prevent retry).
    diag(`hermes-gateway: notifications stream errored (will retry): ${(e as any)?.message || ''}`);
  };
}

function stopNotificationsChannel(): void {
  if (notifyES) {
    try { notifyES.close(); } catch {}
    notifyES = null;
  }
}

// ─── SSE parsing ─────────────────────────────────────────────────────────────

/** Parse the SSE stream from POST /api/sidekick/messages. Each event
 *  is one envelope verbatim; SSE event name == envelope.type. We map
 *  type → BackendAdapter event the same way hermes.ts does for
 *  /v1/responses, but with a much smaller event vocabulary. */
async function parseSSE(response: Response, chatId: string): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    let chunk;
    try { chunk = await reader.read(); }
    catch (e) { diag(`hermes-gateway: SSE read error: ${(e as Error).message}`); break; }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (rawEvent.trim()) dispatchSSEEvent(rawEvent, chatId);
    }
  }
}

function dispatchSSEEvent(raw: string, chatId: string): void {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  let payload: any;
  try { payload = JSON.parse(data); }
  catch {
    diag(`hermes-gateway: non-JSON data in event=${eventName}: ${data.slice(0, 80)}`);
    return;
  }
  const type = payload.type || eventName;
  handleEnvelope(type, payload, chatId);
}

function handleEnvelope(type: string, env: any, chatId: string): void {
  switch (type) {
    case 'typing':
      subs?.onActivity?.({ working: true, detail: 'pending', conversation: chatId });
      return;

    case 'reply_delta': {
      const text = typeof env.text === 'string' ? env.text : '';
      if (!text) return;
      if (!currentReplyId) currentReplyId = newReplyId();
      subs?.onActivity?.({ working: true, detail: 'streaming', conversation: chatId });
      // Adapter contract guarantees `text` is the full cumulative text
      // for this turn — pass straight through as cumulativeText.
      subs?.onDelta?.({ replyId: currentReplyId, cumulativeText: text, conversation: chatId });
      return;
    }

    case 'reply_final': {
      const replyId = currentReplyId || newReplyId();
      const finalText = typeof env.text === 'string' ? env.text : '';
      currentReplyId = null;
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
      // reminder). Normally arrives via the dedicated notifications
      // EventSource (see startNotificationsChannel above) — but the
      // adapter MAY emit one mid-turn on the per-message SSE if a
      // background event lands while a turn is streaming, so handle it
      // here too. Idempotent at the shell level (system rows are
      // append-only; minor duplication is fine).
      const kind = typeof env.kind === 'string' ? env.kind : 'unknown';
      const content = typeof env.content === 'string' ? env.content : '';
      log(`hermes-gateway: notification (in-stream) for ${chatId}: ${kind}`);
      subs?.onNotification?.({ chatId, kind, content });
      return;
    }

    case 'error':
      log(`hermes-gateway: error for ${chatId}: ${env.detail || 'unknown'}`);
      subs?.onActivity?.({ working: false, conversation: chatId });
      return;

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
    toolEvents: false,        // image envelope is a placeholder; no canvas wiring v1
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
    startNotificationsChannel();
  },

  disconnect() {
    if (inflight) { try { inflight.abort(); } catch {} inflight = null; }
    stopHealthPoll();
    stopNotificationsChannel();
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

    // Single in-flight per session — barge-in cancels the previous
    // SSE read but does NOT cancel the agent run (proxy /messages
    // handler keeps the WS subscription alive on PWA disconnect, by
    // design — see server-lib/backends/hermes-gateway/messages.ts).
    if (inflight) { try { inflight.abort(); } catch {} }
    inflight = new AbortController();

    const body: Record<string, any> = { chat_id: chatId, text };
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      body.attachments = opts.attachments;
    }

    try {
      const res = await fetch(`${apiBase()}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
        body: JSON.stringify(body),
        signal: inflight.signal,
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
      subs?.onActivity?.({ working: true, detail: 'pending', conversation: chatId });
      await parseSSE(res, chatId);
    } catch (e: any) {
      if (e.name === 'AbortError') {
        diag('hermes-gateway: request aborted');
        subs?.onActivity?.({ working: false, conversation: chatId });
        return;
      }
      diag(`hermes-gateway.sendMessage failed: ${e.message}`);
      subs?.onActivity?.({ working: false, conversation: chatId });
      throw e;
    } finally {
      inflight = null;
    }
  },

  async newSession() {
    // Mint a fresh chat_id locally + flip active. The proxy / adapter
    // learns about it the moment the user sends their first message
    // under it; until then nothing crosses the wire.
    const conv = await conversations.create();
    await conversations.setActive(conv.chat_id);
    activeChatId = conv.chat_id;
    currentReplyId = null;
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
    currentReplyId = null;
  },

  async listSessions(_limit = 50) {
    // Source-of-truth = PWA IDB. We then enrich with proxy
    // metadata (titles + last_active_at + message counts) when the
    // proxy can answer; on degraded paths the IDB rows are still
    // returned so the drawer doesn't go blank.
    const local = await conversations.list();
    let enrich: SessionsResponse['sessions'] = [];
    let unconfigured = false;
    try {
      const r = await fetch(`${apiBase()}/sessions?limit=200`);
      if (r.ok) {
        const d = (await r.json()) as SessionsResponse;
        enrich = d.sessions || [];
        unconfigured = !!d.unconfigured;
      }
    } catch (e: any) {
      diag(`hermes-gateway.listSessions enrichment failed: ${e.message}`);
    }
    const byId = new Map<string, SessionsResponse['sessions'][number]>();
    for (const row of enrich) byId.set(row.chat_id, row);

    const merged = local.map((conv) => {
      const e = byId.get(conv.chat_id);
      const lastActive = e?.last_active_at != null
        ? (typeof e.last_active_at === 'number' ? e.last_active_at
           : Math.floor(new Date(e.last_active_at).getTime() / 1000))
        : Math.floor(conv.last_message_at / 1000);
      return {
        id: conv.chat_id,
        title: (e?.title || conv.title || 'New chat'),
        lastMessageAt: lastActive,
        messageCount: e?.message_count || 0,
      };
    });

    // Surface the unconfigured state via a synthetic top row so the
    // drawer renders a clear hint without needing a new chrome path.
    // Distinct id namespace (`__sidekick:hint:*`) so click handlers
    // can ignore it. Removed for v1 if the merged list is non-empty —
    // hint is most useful on a fresh install where the drawer would
    // otherwise be blank with no explanation.
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
    await conversations.setActive(id);
    currentReplyId = null;
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
