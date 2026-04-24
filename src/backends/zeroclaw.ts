/**
 * @fileoverview ZeroClaw BackendAdapter. Wraps the `/ws/chat` WebSocket
 * exposed by the zeroclaw gateway into the normalized BackendAdapter
 * interface so the shell doesn't need to know about zeroclaw's wire format.
 *
 * Wire protocol (subprotocol: 'zeroclaw.v1'):
 *   S→C: {type:'session_start', session_id, name, resumed, message_count}
 *   S→C: {type:'chunk', content}            — streaming token
 *   S→C: {type:'tool_call', name, args}
 *   S→C: {type:'tool_result', name, output}
 *   S→C: {type:'done', full_response}
 *   S→C: {type:'error', message, code?}
 *   C→S: {type:'message', content}
 *
 * Connection: via SideKick server's `/ws/zeroclaw` proxy, which relays to
 * the loopback-bound zeroclaw gateway (127.0.0.1:42617). Keeps zeroclaw
 * off the tailnet; browser sees only the same-origin proxy endpoint.
 *
 * @typedef {import('./types.ts').BackendAdapter} BackendAdapter
 * @typedef {import('./types.ts').ConnectOpts} ConnectOpts
 * @typedef {import('./types.ts').SendOpts} SendOpts
 */

import { log, diag } from '../util/log.ts';

let socket: WebSocket | null = null;
let connected = false;
let sessionId: string | null = null;
let intentionalClose = false;
let lastSubs: any = null;

// Reply-ID state. zeroclaw streams `chunk` events until a `done` event
// closes the reply; mint an id on first chunk, clear on done.
let currentReplyId: string | null = null;
let cumulativeText = '';

function newReplyId(): string {
  return `zc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/zeroclaw`;
}

function openSocket(subs: any) {
  const s = new WebSocket(wsUrl(), ['zeroclaw.v1']);
  socket = s;

  s.onopen = () => {
    // Do NOT flip connected yet — wait for `session_start` from the server
    // so downstream code can assume the agent is actually reachable (not
    // just that the WS upgrade succeeded).
    diag('zeroclaw: socket open, awaiting session_start');
  };

  s.onmessage = (ev) => {
    let d: any;
    try { d = JSON.parse(ev.data); } catch { return; }

    switch (d.type) {
      case 'session_start':
        sessionId = d.session_id || null;
        connected = true;
        log(`zeroclaw: session_start id=${sessionId} resumed=${d.resumed} messages=${d.message_count}`);
        subs.onStatus?.(true);
        return;

      case 'chunk': {
        const partial = d.content || '';
        if (!partial) return;
        if (!currentReplyId) {
          currentReplyId = newReplyId();
          cumulativeText = '';
        }
        cumulativeText += partial;
        subs.onActivity?.({ working: true, detail: 'streaming' });
        subs.onDelta?.({ replyId: currentReplyId, cumulativeText });
        return;
      }

      case 'tool_call': {
        const name = d.name || 'tool';
        subs.onActivity?.({ working: true, detail: name });
        subs.onToolEvent?.({ kind: 'tool_call', payload: { name, args: d.args } });
        return;
      }

      case 'tool_result':
        subs.onToolEvent?.({
          kind: 'tool_result',
          payload: { name: d.name, output: d.output },
        });
        return;

      case 'done': {
        const replyId = currentReplyId || newReplyId();
        const text = d.full_response ?? cumulativeText;
        currentReplyId = null;
        cumulativeText = '';
        subs.onActivity?.({ working: false });
        subs.onFinal?.({ replyId, text });
        return;
      }

      case 'error':
        log(`zeroclaw error: ${d.message || ''} (${d.code || ''})`);
        subs.onActivity?.({ working: false });
        return;

      default:
        diag(`zeroclaw: unhandled type=${d.type}`);
    }
  };

  s.onclose = () => {
    connected = false;
    subs.onStatus?.(false);
    if (!intentionalClose) {
      // Same reconnect cadence as the openclaw gateway client (gateway.ts).
      setTimeout(() => openSocket(subs), 3000);
    }
  };

  s.onerror = () => {
    // Errors always precede onclose here — handle reconnect there.
  };
}

// Browser 'online' / 'offline' events — match the openclaw gateway client
// behavior so reconnection after iOS PWA WiFi-switch works uniformly.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (lastSubs) {
      log('zeroclaw: browser online — forcing reconnect');
      intentionalClose = false;
      if (socket) { try { socket.close(); } catch {} }
      openSocket(lastSubs);
    }
  });
  window.addEventListener('offline', () => {
    if (connected) {
      log('zeroclaw: browser offline — marking disconnected');
      connected = false;
      lastSubs?.onStatus?.(false);
      if (socket) { try { socket.close(); } catch {} }
    }
  });
}

export const zeroclawAdapter = {
  name: 'zeroclaw',

  capabilities: {
    streaming: true,
    sessions: true,
    models: false,
    toolEvents: true,
    history: false,
    attachments: false,
  },

  async connect(opts: any) {
    lastSubs = opts;
    intentionalClose = false;
    openSocket(opts);
  },

  disconnect() {
    intentionalClose = true;
    connected = false;
    if (socket) { try { socket.close(); } catch {} socket = null; }
  },

  reconnect() {
    if (!lastSubs) return;
    log('zeroclaw: forcing reconnect');
    intentionalClose = false;
    if (socket) { try { socket.close(); } catch {} }
    openSocket(lastSubs);
  },

  isConnected() {
    return connected;
  },

  sendMessage(text: string, _opts?: any) {
    // Throw on inability to send so the caller (sendTypedMessage) can
    // clean up composer + mic state. A silent return here would leave
    // the mic hot and the send button greyed while the user thinks
    // their message shipped.
    if (!connected || !socket) {
      diag(`zeroclaw.sendMessage: DROPPED (connected=${connected})`);
      throw new Error('Gateway not connected');
    }
    try {
      socket.send(JSON.stringify({ type: 'message', content: text }));
    } catch (e) {
      diag(`zeroclaw.sendMessage: socket.send threw: ${(e as Error).message}`);
      throw e;
    }
  },

  newSession() {
    // zeroclaw's session is scoped to the WS connection via session_id.
    // "New session" = close + reopen without carrying the old id. The
    // server mints a fresh UUID on upgrade when no id is provided.
    sessionId = null;
    currentReplyId = null;
    cumulativeText = '';
    if (lastSubs) {
      intentionalClose = false;
      if (socket) { try { socket.close(); } catch {} }
      openSocket(lastSubs);
    }
  },
};
