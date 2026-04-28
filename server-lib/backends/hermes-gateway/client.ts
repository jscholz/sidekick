// Persistent WebSocket client to the hermes sidekick platform adapter.
//
// The adapter (see ../../../hermes-plugin/sidekick_platform.py) runs as
// an aiohttp WS server bound to 127.0.0.1, peer of telegram/slack/etc.
// This client connects ONCE at sidekick proxy startup and stays
// connected for the proxy's lifetime — every chat_id-tagged envelope
// flows over the same socket. See `docs/SIDEKICK_AUDIO_PROTOCOL.md`
// (the "Hermes-Gateway WS contract" section) for the wire shape.
//
// Why a persistent connection (and not a new WS per message)?
//   - The adapter pushes notifications (cron output, /background
//     results, future session_changed) without being asked. That only
//     works if we keep a socket open.
//   - Reduces the per-message handshake cost.
//
// Reconnect strategy: exponential backoff capped at 30s — 1, 2, 4, 8,
// 16 (capped at 30), 30, 30… The adapter's WS lives on loopback so the
// usual reason a connect fails is "hermes hasn't started yet" or "user
// hasn't applied the patch + plugin." Both clear in seconds-to-minutes,
// not hours; 30s ceiling keeps reconnect latency bounded without
// spamming the log.
//
// We deliberately do NOT enqueue inbound messages while disconnected.
// The PWA-facing endpoints in `messages.ts` check `isConnected()` and
// fail-fast with 503 — better to show the user "agent unreachable"
// than silently buffer a bike-ride dictation that never gets sent.

import { WebSocket } from 'ws';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

type Envelope = Record<string, unknown> & { type: string; chat_id?: string };

/** Per-chat_id outbound envelope listeners. Registered by request
 *  handlers (e.g. messages.ts) for the duration of one POST/SSE turn. */
type EnvelopeListener = (env: Envelope) => void;

class HermesGatewayClient {
  private url = '';
  private token = '';
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shutdown = false;
  private connected = false;
  // chat_id → set of listeners. A listener returns false → unregister.
  private listeners = new Map<string, Set<EnvelopeListener>>();
  // Wildcard listeners (no chat_id filter) — used by session_changed/
  // notification fan-out which can target any chat_id.
  private wildcardListeners = new Set<EnvelopeListener>();

  /** Wire env-derived config and start the persistent connect loop.
   *  Idempotent — calling twice is a no-op (used to be a footgun during
   *  hot-reload experiments). */
  init(opts: { token: string; url: string }) {
    if (this.url) {
      console.warn('[hermes-gateway] init() called twice; ignoring');
      return;
    }
    this.url = opts.url;
    this.token = (opts.token || '').trim();
    if (!this.token) {
      console.warn(
        '[hermes-gateway] SIDEKICK_PLATFORM_TOKEN unset — /api/sidekick/* '
        + 'endpoints will return 503 until configured.',
      );
      return;
    }
    this.connect();
  }

  /** Tear down the client (used by tests; production never calls this). */
  shutdownClient() {
    this.shutdown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.close(1000, 'shutdown'); } catch { /* noop */ }
    }
    this.ws = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Auth status for the 503 path. False if we never had a token. */
  isConfigured(): boolean {
    return !!this.token;
  }

  /** Send an envelope to the adapter. Returns true on writable socket,
   *  false otherwise (callers MUST handle the false return — usually by
   *  surfacing a 503 to the PWA). We don't queue here because the
   *  proxy is single-process: if we're disconnected, the adapter on
   *  the other end isn't running, and a queued message would dispatch
   *  to a brand-new agent state machine that has no idea what came
   *  before. Better to fail loudly. */
  send(env: Envelope): boolean {
    if (!this.isConnected() || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(env));
      return true;
    } catch (e: any) {
      console.warn('[hermes-gateway] send failed:', e.message);
      return false;
    }
  }

  /** Subscribe to outbound envelopes for one chat_id. Returns the
   *  unsubscribe fn so handlers can clean up on request close. */
  subscribe(chatId: string, fn: EnvelopeListener): () => void {
    let bucket = this.listeners.get(chatId);
    if (!bucket) { bucket = new Set(); this.listeners.set(chatId, bucket); }
    bucket.add(fn);
    return () => {
      const b = this.listeners.get(chatId);
      if (!b) return;
      b.delete(fn);
      if (b.size === 0) this.listeners.delete(chatId);
    };
  }

  /** Subscribe to ALL outbound envelopes. Used by the drawer-events
   *  bridge so session_changed / notification envelopes can fan out
   *  without needing a chat_id allow-list. */
  subscribeAll(fn: EnvelopeListener): () => void {
    this.wildcardListeners.add(fn);
    return () => { this.wildcardListeners.delete(fn); };
  }

  // ── internals ────────────────────────────────────────────────────────

  private connect() {
    if (this.shutdown) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      // 30s heartbeat matches the adapter's heartbeat= setting on
      // aiohttp.web.WebSocketResponse, so the two sides agree on
      // ping cadence.
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      console.log(`[hermes-gateway] connected to ${this.url}`);
    });

    ws.on('message', (raw) => {
      let env: Envelope;
      try { env = JSON.parse(raw.toString('utf8')); }
      catch {
        console.warn('[hermes-gateway] non-JSON frame ignored');
        return;
      }
      if (!env || typeof env !== 'object' || typeof env.type !== 'string') {
        console.warn('[hermes-gateway] envelope missing type; ignoring');
        return;
      }
      this.dispatchInbound(env);
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      this.ws = null;
      if (this.shutdown) return;
      const reasonStr = reason?.toString?.() || '';
      console.warn(
        `[hermes-gateway] disconnected (code=${code}${reasonStr ? `, reason=${reasonStr}` : ''}); will retry`,
      );
      this.scheduleReconnect();
    });

    ws.on('error', (e: any) => {
      // 'error' fires before 'close' on connect failure. Don't double-
      // schedule — the close handler will pick it up.
      this.connected = false;
      console.warn('[hermes-gateway] ws error:', e?.message || e);
    });
  }

  private scheduleReconnect() {
    if (this.shutdown) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this.reconnectAttempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatchInbound(env: Envelope) {
    // Fan out to per-chat_id listeners first (covers reply_delta /
    // reply_final / typing for an in-flight POST), then wildcard
    // listeners (session_changed / notification — destination chat_id
    // is in the envelope payload itself).
    const chatId = typeof env.chat_id === 'string' ? env.chat_id : '';
    if (chatId) {
      const bucket = this.listeners.get(chatId);
      if (bucket) {
        for (const fn of bucket) {
          try { fn(env); } catch (e: any) {
            console.warn('[hermes-gateway] listener threw:', e?.message);
          }
        }
      }
    }
    for (const fn of this.wildcardListeners) {
      try { fn(env); } catch (e: any) {
        console.warn('[hermes-gateway] wildcard listener threw:', e?.message);
      }
    }
  }
}

// Singleton — server.ts wires env in once at startup, request handlers
// import this default export and call its methods.
export const client = new HermesGatewayClient();
