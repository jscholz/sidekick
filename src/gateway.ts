/**
 * @fileoverview Gateway WebSocket — connect, authenticate, send messages, emit events.
 */

import { log, diag } from './util/log.ts';

let socket = null;
let connected = false;
let reqId = 0;
let intentionalClose = false;
let lastOpts = null; // store for force-reconnect
/** Monotonic connection id. Stale sockets (from reconnect races) ignore events. */
let currentConnId = 0;
/** Wall-clock of the last inbound WS message. Used by status to detect
 *  weak signal — connection is nominally open but no traffic in N seconds. */
let lastInboundAt = 0;

/** @type {((d: Object) => void)|null} */
let onMessage = null;

/**
 * @param {Object} opts
 * @param {string} opts.wsUrl
 * @param {string} opts.token
 * @param {(connected: boolean) => void} opts.onStatus
 * @param {(d: Object) => void} opts.onEvent
 */
export function connect(opts) {
  const myId = ++currentConnId;
  intentionalClose = false;
  lastOpts = opts;
  onMessage = opts.onEvent;
  const mySocket = new WebSocket(opts.wsUrl);
  socket = mySocket;

  mySocket.onopen = () => {
    if (myId !== currentConnId) { try { mySocket.close(); } catch {} return; }
    opts.onStatus(false);
  };

  mySocket.onmessage = (ev) => {
    // Stale socket (from a reconnect race) — ignore completely. Prevents
    // the duplicate-message-in-UI bug where two sockets both forward the
    // same gateway event to handleGatewayEvent.
    if (myId !== currentConnId) return;

    lastInboundAt = Date.now();
    const d = JSON.parse(ev.data);
    console.log('GW:', d.type, d.event || d.method || d.id, JSON.stringify(d).substring(0, 200));

    // Challenge → authenticate
    if (d.type === 'event' && d.event === 'connect.challenge') {
      mySocket.send(JSON.stringify({
        type: 'req', id: String(++reqId), method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-control-ui', version: '2026.4.13', platform: 'web', mode: 'webchat' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
          caps: ['tool-events'],
          auth: { token: opts.token },
        },
      }));
      return;
    }

    // Connect success
    if (d.type === 'res' && d.ok && !connected) {
      connected = true;
      opts.onStatus(true);
      return;
    }

    // Connect error
    if (d.type === 'res' && d.error && !connected) {
      log('gateway error:', d.error.message || JSON.stringify(d.error));
      return;
    }

    // Forward all events to the app
    if (onMessage) onMessage(d);
  };

  mySocket.onclose = () => {
    if (myId !== currentConnId) return; // stale — newer socket is handling
    connected = false;
    opts.onStatus(false);
    if (!intentionalClose) setTimeout(() => connect(opts), 3000);
  };

  mySocket.onerror = () => {};
}

export function isConnected() { return connected; }

/** Milliseconds since the last inbound WS message. Used by the status
 *  bar to show "Weak signal" when the socket is nominally connected
 *  but traffic has stalled — catches flaky cell conditions where TCP
 *  buffers keep the socket "open" while no bytes actually flow. */
export function msSinceLastMessage(): number {
  if (!lastInboundAt) return 0;
  return Date.now() - lastInboundAt;
}

export function disconnect() {
  intentionalClose = true;
  connected = false;
  if (socket) { try { socket.close(); } catch {} socket = null; }
}

/** Force a fresh connection — close stale socket and re-open. Used when WiFi returns. */
export function reconnect() {
  if (!lastOpts) return;
  log('gateway: forcing reconnect');
  // Close existing socket without setting intentionalClose (we WANT auto-reconnect)
  if (socket) { try { socket.close(); } catch {} }
  connected = false;
  // Start fresh
  connect(lastOpts);
}

// Browser 'online' event — fires when network returns. WebSocket onclose
// doesn't always fire when WiFi drops (especially on iOS PWAs), so the
// `connected` flag may be stale-true when we come back online. Always
// force a reconnect to be safe — this guarantees onStatus(true) fires
// and flushOutbox runs for any queued items.
// Browser 'offline' event — mark the connection dead immediately so
// new sends take the offline path instead of hanging on stale sockets.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    log('gateway: browser reported online — forcing reconnect');
    if (lastOpts) reconnect();
  });
  window.addEventListener('offline', () => {
    log('gateway: browser reported offline — marking disconnected');
    if (connected) {
      connected = false;
      if (lastOpts?.onStatus) lastOpts.onStatus(false);
      if (socket) { try { socket.close(); } catch {} }
    }
  });
}

/**
 * Request recent chat history from the gateway.
 * @param {string} sessionKey
 * @param {number} [limit]
 * @returns {Promise<Object[]>} Array of message objects {role, content}
 */
export function fetchHistory(sessionKey = 'agent:main:main', limit = 50) {
  return new Promise((resolve) => {
    if (!socket) { resolve([]); return; }
    const s = socket; // pin the current socket — don't let reconnects swap it
    const id = String(++reqId);
    const handler = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === 'res' && d.id === id) {
        s.removeEventListener('message', handler);
        if (d.ok && d.payload?.messages) resolve(d.payload.messages);
        else resolve([]);
      }
    };
    s.addEventListener('message', handler);
    s.send(JSON.stringify({
      type: 'req', id, method: 'chat.history',
      params: { sessionKey, limit },
    }));
    setTimeout(() => {
      s.removeEventListener('message', handler);
      resolve([]);
    }, 5000);
  });
}

export function send(method, params) {
  if (!connected || !socket) {
    diag(`gateway.send: DROPPED (connected=${connected}) method=${method}`);
    return;
  }
  const id = String(++reqId);
  socket.send(JSON.stringify({ type: 'req', id, method, params }));
  // Diagnostic: ordered log of outgoing sends. Helps investigate
  // out-of-order issues — client-side send order should match what
  // the gateway receives (WS within a single connection is TCP-ordered).
  // If gateway logs show a different order from this, the reordering
  // is server-side and we can rule out client buffering.
  if (method === 'chat.send') {
    const preview = String(params?.message || '').slice(0, 40);
    diag(`gateway.send: id=${id} method=${method} "${preview}"`);
  }
}

/** Generic request/response: send a method + params, await the matching
 *  res payload. Resolves with payload on ok, null on error/timeout. */
export function request(method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve) => {
    if (!socket) { resolve(null); return; }
    const s = socket;
    const id = String(++reqId);
    const handler = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'res' && d.id === id) {
        s.removeEventListener('message', handler);
        resolve(d.ok ? (d.payload ?? null) : null);
      }
    };
    s.addEventListener('message', handler);
    s.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => {
      s.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Send a chat message. Optionally includes image attachments.
 * @param {string} text
 * @param {Object} [opts]
 * @param {Array<{type?:string, mimeType:string, fileName?:string, content:string}>} [opts.attachments]
 *   Each attachment's `content` is base64 (data-url prefix also accepted).
 */
export function sendChat(text: string, opts: {
  attachments?: Array<{ type?: string; mimeType: string; fileName?: string; content: string }>;
} = {}) {
  const params: {
    sessionKey: string;
    message: any;
    idempotencyKey: string;
    attachments?: Array<{ type?: string; mimeType: string; fileName?: string; content: string }>;
  } = {
    sessionKey: 'agent:main:main',
    message: text,
    idempotencyKey: crypto.randomUUID(),
  };
  if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
    params.attachments = opts.attachments;
  }
  send('chat.send', params);
}
