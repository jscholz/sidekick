// UpstreamAgent — the proxy's contract with whatever's behind it.
//
// Today: hermes-plugin (in-process with hermes-agent, exposing /v1/*
// HTTP endpoints — see hermes-plugin/__init__.py).
// Tomorrow: a stub agent (echo / gemini / ollama), or any third-party
// /v1/*-speaking server (OpenAI, Groq, Together, an Ollama OpenAI-compat
// proxy, the openclaw plugin via api.registerHttpRoute).
//
// One interface, one implementation. The PWA-facing routes in
// server-lib/sidekick/{messages,sessions,history}.ts call into this.

// No imports — this module is self-contained so it can be reused
// across upstreams (hermes-plugin, stub agent, etc.) without dragging
// in WS-specific machinery. Auth comes from env or constructor opts.

/** Sidekick envelope shape that the proxy's stream multiplexer consumes.
 *  Same shape as the legacy WS protocol — see hermes-plugin/__init__.py
 *  module docstring for the canonical wire spec. */
export type SidekickEnvelope =
  | { type: 'reply_delta'; chat_id: string; text: string; message_id: string; edit?: boolean }
  | { type: 'reply_final'; chat_id: string; message_id: string }
  | { type: 'tool_call'; chat_id: string; call_id: string; tool_name: string; args: unknown; started_at?: string }
  | { type: 'tool_result'; chat_id: string; call_id: string; tool_name: string; result: unknown; duration_ms?: number }
  | { type: 'typing'; chat_id: string }
  | { type: 'image'; chat_id: string; url: string; caption?: string }
  | { type: 'notification'; chat_id: string; kind: string; content: string }
  | { type: 'session_changed'; chat_id: string; session_id: string; title: string }
  | { type: 'error'; chat_id: string; message: string };

/** Drawer-list row, OAI Conversations API shape. */
export interface ConversationSummary {
  id: string;
  object: 'conversation';
  created_at: number;
  metadata: {
    title: string;
    message_count: number;
    last_active_at: number;
    first_user_message: string | null;
  };
}

/** Cross-platform drawer row from the optional `/v1/gateway/*`
 *  contract. Same shape as ConversationSummary plus `source` (telegram
 *  / slack / whatsapp / sidekick / …) and `chat_type` (dm / group)
 *  in metadata. Agents that aren't gateways don't implement the
 *  endpoint; the upstream returns null and the proxy falls back to
 *  the channel-only `/v1/conversations` view. */
export interface GatewayConversationSummary extends ConversationSummary {
  metadata: ConversationSummary['metadata'] & {
    source: string;
    chat_type: string;
  };
}

/** Single transcript item, OAI shape (with optional sidekick extension). */
export interface ConversationItem {
  id: number;
  object: 'message';
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  created_at: number;
  /** Sidekick extension: tool name for tool-role rows. Plumbed through
   *  the OAI item shape so the drawer's "agent activity" view can
   *  render the row with its tool label. Absent for non-tool rows. */
  tool_name?: string;
}

export interface UpstreamAgent {
  /** Dispatch a turn. Returns an async iterable of sidekick envelopes
   *  that the caller fans into the persistent /api/sidekick/stream
   *  multiplexer. The iterable terminates when the upstream emits
   *  response.completed (or response.error). `attachments` is the
   *  PWA's collected payload (data:URL-encoded images / videos /
   *  documents); the upstream materializes them on its side. */
  sendMessage(
    chatId: string,
    text: string,
    opts?: { signal?: AbortSignal; attachments?: unknown[] },
  ): AsyncIterable<SidekickEnvelope>;

  /** Drawer list. Most-recent-first, bounded by `limit`. */
  listConversations(limit?: number): Promise<ConversationSummary[]>;

  /** Cross-platform drawer list — optional gateway extension.
   *  Returns null when the upstream doesn't implement
   *  `/v1/gateway/conversations` (single-channel agents — stub, raw OAI
   *  third-parties); the caller falls back to `listConversations`. */
  listGatewayConversations(limit?: number): Promise<GatewayConversationSummary[] | null>;

  /** Transcript replay. */
  getMessages(
    chatId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<{ items: ConversationItem[]; first_id: number | null; has_more: boolean }>;

  /** Drawer delete. Cascades upstream (transcript + memory store). */
  deleteConversation(chatId: string): Promise<void>;

  /** Persistent SSE subscription for out-of-turn envelopes
   *  (notifications, session_changed for chats not currently in a
   *  /v1/responses turn, late tool events). The iterable runs until
   *  `signal` aborts or the connection drops. */
  subscribeEvents(opts?: { signal?: AbortSignal; lastEventId?: number }): AsyncIterable<{ id: number; envelope: SidekickEnvelope }>;

  /** Liveness check. */
  healthcheck(): Promise<{ ok: boolean }>;
}

// ────────────────────────────────────────────────────────────────────
// HTTPAgentUpstream — the production impl. Talks /v1/* HTTP+SSE.
// ────────────────────────────────────────────────────────────────────

const DEFAULT_URL = process.env.UPSTREAM_URL || 'http://127.0.0.1:8645';
// Fall back to the same shared secret the WS path uses; this lets
// hermes-plugin auth both transports with one env var.
const DEFAULT_AUTH = (
  process.env.UPSTREAM_TOKEN || process.env.SIDEKICK_PLATFORM_TOKEN || ''
).trim();

export interface HTTPAgentUpstreamOpts {
  url?: string;
  token?: string;
}

export class HTTPAgentUpstream implements UpstreamAgent {
  private readonly url: string;
  private readonly token: string;

  constructor(opts: HTTPAgentUpstreamOpts = {}) {
    this.url = (opts.url || DEFAULT_URL).replace(/\/+$/, '');
    this.token = (opts.token || DEFAULT_AUTH).trim();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async healthcheck(): Promise<{ ok: boolean }> {
    try {
      const r = await fetch(`${this.url}/health`, { headers: this.headers() });
      if (!r.ok) return { ok: false };
      const j: any = await r.json().catch(() => ({}));
      return { ok: j.status === 'ok' };
    } catch {
      return { ok: false };
    }
  }

  async listConversations(limit = 50): Promise<ConversationSummary[]> {
    const r = await fetch(
      `${this.url}/v1/conversations?limit=${limit}`,
      { headers: this.headers() },
    );
    if (!r.ok) throw new Error(`upstream listConversations: HTTP ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  /** Probe the gateway extension. 404 = upstream is single-channel —
   *  return null so the caller falls back to listConversations. Other
   *  errors throw so transient outages don't silently degrade the
   *  drawer to channel-only. */
  async listGatewayConversations(
    limit = 50,
  ): Promise<GatewayConversationSummary[] | null> {
    const r = await fetch(
      `${this.url}/v1/gateway/conversations?limit=${limit}`,
      { headers: this.headers() },
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`upstream listGatewayConversations: HTTP ${r.status}`);
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  }

  async getMessages(
    chatId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<{ items: ConversationItem[]; first_id: number | null; has_more: boolean }> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.before != null) params.set('before', String(opts.before));
    const qs = params.toString();
    const r = await fetch(
      `${this.url}/v1/conversations/${encodeURIComponent(chatId)}/items${qs ? `?${qs}` : ''}`,
      { headers: this.headers() },
    );
    if (r.status === 404) {
      return { items: [], first_id: null, has_more: false };
    }
    if (!r.ok) throw new Error(`upstream getMessages: HTTP ${r.status}`);
    const j: any = await r.json();
    return {
      items: Array.isArray(j?.data) ? j.data : [],
      first_id: j?.first_id ?? null,
      has_more: !!j?.has_more,
    };
  }

  async deleteConversation(chatId: string): Promise<void> {
    const r = await fetch(
      `${this.url}/v1/conversations/${encodeURIComponent(chatId)}`,
      { method: 'DELETE', headers: this.headers() },
    );
    if (r.status === 404) return; // idempotent — already gone
    if (!r.ok) throw new Error(`upstream deleteConversation: HTTP ${r.status}`);
  }

  /** Translate a /v1/responses SSE stream into sidekick envelopes.
   *  Maintains per-turn assembled-text state to compute additive
   *  deltas (the multiplexer's reply_delta protocol expects either
   *  initial-content OR edit=true with running total — see the
   *  plugin's reply_delta emit logic). For the proxy → PWA leg we
   *  emit deltas as additive (each reply_delta's text is what to
   *  append; matches what the PWA already handles). */
  async *sendMessage(
    chatId: string,
    text: string,
    opts: { signal?: AbortSignal; attachments?: unknown[] } = {},
  ): AsyncIterable<SidekickEnvelope> {
    // Plugins that implement the sidekick `attachments` extension on
    // /v1/responses materialize them server-side. Raw OAI-compat
    // upstreams ignore the field — additive, OAI tolerates unknown
    // body keys.
    const body: Record<string, unknown> = {
      conversation: chatId,
      input: text,
      stream: true,
    };
    if (opts.attachments && opts.attachments.length > 0) {
      body.attachments = opts.attachments;
    }
    const r = await fetch(`${this.url}/v1/responses`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!r.ok || !r.body) {
      const errText = await r.text().catch(() => '');
      yield {
        type: 'error',
        chat_id: chatId,
        message: `upstream sendMessage HTTP ${r.status}: ${errText.slice(0, 240)}`,
      };
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let assembled = '';
    let messageId: string | null = null;
    let closed = false;

    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by \n\n. Parse each complete frame.
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');

          let event = '';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            // Other lines (id:, retry:) — we don't currently need them
            // on the per-turn /v1/responses stream.
          }
          if (!data) continue;

          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }

          for (const env of translateOAIEvent(event, payload, chatId, {
            getAssembled: () => assembled,
            setAssembled: (v) => { assembled = v; },
            getMessageId: () => messageId,
            setMessageId: (v) => { messageId = v; },
          })) {
            yield env;
          }

          if (event === 'response.completed' || event === 'response.error') {
            closed = true;
            break;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  /** Persistent SSE subscription. Reconnect-aware via Last-Event-ID. */
  async *subscribeEvents(
    opts: { signal?: AbortSignal; lastEventId?: number } = {},
  ): AsyncIterable<{ id: number; envelope: SidekickEnvelope }> {
    const headers = this.headers();
    if (opts.lastEventId != null) {
      headers['last-event-id'] = String(opts.lastEventId);
    }
    const r = await fetch(`${this.url}/v1/events`, {
      headers,
      signal: opts.signal,
    });
    if (!r.ok || !r.body) {
      throw new Error(`upstream subscribeEvents: HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');

          let id: number | null = null;
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) {
              const n = Number.parseInt(line.slice(3).trim(), 10);
              if (Number.isFinite(n)) id = n;
            } else if (line.startsWith('data:')) {
              data += line.slice(5).trim();
            }
          }
          if (!data || id == null) continue;
          let envelope: SidekickEnvelope | null = null;
          try { envelope = JSON.parse(data) as SidekickEnvelope; } catch { continue; }
          if (!envelope || typeof (envelope as any).type !== 'string') continue;
          yield { id, envelope };
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// OAI → sidekick envelope translator (private)
// ────────────────────────────────────────────────────────────────────

interface TranslatorState {
  getAssembled: () => string;
  setAssembled: (v: string) => void;
  getMessageId: () => string | null;
  setMessageId: (v: string) => void;
}

function* translateOAIEvent(
  event: string,
  payload: any,
  chatId: string,
  state: TranslatorState,
): Generator<SidekickEnvelope> {
  switch (event) {
    case 'response.in_progress':
      yield { type: 'typing', chat_id: chatId };
      return;

    case 'response.output_text.delta': {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      const itemId = typeof payload?.item_id === 'string' ? payload.item_id : null;
      if (itemId && state.getMessageId() == null) state.setMessageId(itemId);
      if (delta) {
        const messageId = state.getMessageId() ?? itemId ?? `msg_${chatId}`;
        state.setAssembled(state.getAssembled() + delta);
        // Emit additive reply_delta: text=accumulated, edit=true after first.
        // PWA's chat.streamingDelta accepts cumulative text via edit.
        const isFirst = state.getAssembled() === delta;
        yield {
          type: 'reply_delta',
          chat_id: chatId,
          text: state.getAssembled(),
          message_id: messageId,
          ...(isFirst ? {} : { edit: true }),
        };
      }
      return;
    }

    case 'response.completed': {
      const messageId = state.getMessageId() ?? `msg_${chatId}`;
      yield { type: 'reply_final', chat_id: chatId, message_id: messageId };
      return;
    }

    case 'response.output_item.added': {
      const item = payload?.item;
      if (item?.type === 'function_call') {
        let args: unknown = {};
        try { args = item.arguments ? JSON.parse(item.arguments) : {}; }
        catch { args = item.arguments ?? {}; }
        yield {
          type: 'tool_call',
          chat_id: chatId,
          call_id: item.id ?? '',
          tool_name: item.name ?? '',
          args,
        };
      }
      return;
    }

    case 'response.output_item.done': {
      const item = payload?.item;
      if (item?.type === 'function_call_output') {
        yield {
          type: 'tool_result',
          chat_id: chatId,
          call_id: item.call_id ?? '',
          tool_name: '',
          result: item.output ?? '',
        };
      }
      return;
    }

    case 'response.error': {
      const msg = payload?.error?.message ?? 'upstream error';
      yield { type: 'error', chat_id: chatId, message: String(msg) };
      return;
    }

    default:
      // Unknown event types — skip silently. The OAI Responses spec
      // explicitly says clients MUST tolerate unknown event types.
      return;
  }
}
