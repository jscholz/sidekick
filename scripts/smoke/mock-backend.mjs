// Mock backend for sidekick PWA smoke scenarios.
//
// Intercepts /api/sidekick/* via Playwright page.route() and serves
// scripted responses. No real hermes/LLM/Deepgram calls.
//
// Use:
//   import { installMockBackend } from './mock-backend.mjs';
//   const mock = await installMockBackend(page);
//   // mock.addChat(chat_id, {title, messages, lastActiveAt})
//   // mock.simulateReply(chat_id, text)         — push a reply via the
//   //                                              persistent stream
//   // ...
//   await mock.close();   // tears down the in-process SSE server
//
// /api/sidekick/stream is served by a real in-process http.Server on
// an ephemeral 127.0.0.1 port (mirrors the proxy-test harness pattern
// at proxy/sidekick/__tests__/proxy-harness.ts).
// Playwright forwards the PWA's /api/sidekick/stream request to that
// local server via `route.continue({ url })`, so the EventSource sees
// a single long-lived connection — `pushReply` / `pushSessionChanged`
// land within milliseconds instead of having to wait for the
// `retry: 200` reconnect cycle that `route.fulfill` was forced into.
//
// Other endpoints (sessions list, messages, config, keyterms) stay as
// `route.fulfill` — they're one-shot HTTP, no streaming need.
//
// Scenarios that exercise the LLM logic itself (tool-turn, etc.)
// should use the real backend via export const BACKEND = 'real'.
// Drawer / UX / persistence tests don't care about LLM behavior and
// run fine against the mock — orders of magnitude faster.

import * as http from 'node:http';

/** @typedef {{
 *    chatId: string,
 *    title: string,
 *    messages: Array<{role: string, content: string, timestamp?: number}>,
 *    lastActiveAt: number,
 *  }} MockChat
 */

export async function installMockBackend(page) {
  const chats = new Map();          // chat_id → MockChat
  /** Active SSE responses (real http.ServerResponse objects). */
  const streamSubs = new Set();
  let envelopeId = 0;
  // Replay ring — so a freshly-connecting PWA tab (or a Last-Event-Id
  // resume after a temporary disconnect) sees recent envelopes.
  const recent = [];

  const broadcast = (env) => {
    envelopeId++;
    const id = envelopeId;
    recent.push({ id, env });
    if (recent.length > 128) recent.shift();
    const frame = `id: ${id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
    for (const sub of streamSubs) {
      try { sub.write(frame); }
      catch {}
    }
  };

  // Real in-process http.Server hosting /api/sidekick/stream as a
  // proper persistent SSE endpoint. Playwright redirects the PWA's
  // request here via route.continue({ url }) below.
  const sseServer = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    // Read Last-Event-Id from header OR ?lastEventId= (Playwright may
    // strip non-allowlisted request headers when forwarding).
    const headerId = req.headers['last-event-id'];
    const url = new URL(req.url || '/', 'http://x');
    const queryId = url.searchParams.get('lastEventId');
    const cursor = headerId
      ? Number.parseInt(String(headerId), 10)
      : queryId
      ? Number.parseInt(queryId, 10)
      : -1;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      'connection': 'keep-alive',
    });
    // Tiny retry hint so a connection drop reconnects fast (the real
    // proxy uses 5000ms; tests want sub-second).
    res.write('retry: 200\n\n');
    // Replay anything since the cursor.
    for (const entry of recent) {
      if (entry.id <= cursor) continue;
      res.write(`id: ${entry.id}\nevent: ${entry.env.type}\ndata: ${JSON.stringify(entry.env)}\n\n`);
    }
    streamSubs.add(res);
    const drop = () => { streamSubs.delete(res); };
    req.on('close', drop);
    res.on('close', drop);
  });
  // Track open sockets so `close()` can hang up immediately rather
  // than waiting for the OS keep-alive timeout to drain.
  const openSockets = new Set();
  sseServer.on('connection', (sock) => {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
  });
  await new Promise((resolve, reject) => {
    sseServer.once('error', reject);
    sseServer.listen(0, '127.0.0.1', () => resolve());
  });
  const sseAddr = sseServer.address();
  const ssePort = typeof sseAddr === 'object' && sseAddr ? sseAddr.port : 0;
  const sseUrl = `http://127.0.0.1:${ssePort}/stream`;

  // GET /api/sidekick/sessions — canned list from the in-memory map.
  await page.route('**/api/sidekick/sessions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/messages')) {
      // Per-chat history endpoint — handled by the next route.
      return route.fallback();
    }
    if (route.request().method() !== 'GET') return route.fallback();
    const sessions = Array.from(chats.values()).map(c => {
      // Mirror the proxy's first_user_message derivation: pick the
      // first role='user' message and truncate to 80 chars. Lets the
      // drawer fall back to a snippet when title is still empty.
      const firstUser = c.messages.find(m => m.role === 'user');
      const firstUserMessage = firstUser
        ? String(firstUser.content || '').slice(0, 80)
        : null;
      return {
        chat_id: c.chatId,
        session_id: `mock-${c.chatId}`,
        source: c.source || 'sidekick',
        title: c.title,
        last_active_at: new Date(c.lastActiveAt).toISOString(),
        message_count: c.messages.length,
        created_at: new Date(c.lastActiveAt).toISOString(),
        first_user_message: firstUserMessage,
      };
    });
    sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions }),
    });
  });

  // GET /api/sidekick/sessions/<chat_id>/messages — canned transcript.
  // Each message's `id` matches the SSE envelope `message_id` the
  // proxy emitted for that same content — mirrors the real proxy
  // (proxy/sidekick/history.ts maps `id: it.id` and upstream.ts
  // emits the same `it.id` as `message_id` on reply_delta /
  // reply_final). Tests rely on this alignment for cross-path dedup.
  await page.route(/.*\/api\/sidekick\/sessions\/[^/]+\/messages/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)\/messages/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    const chat = chats.get(chatId);
    const messages = chat ? chat.messages.map((m, i) => ({
      id: m.message_id || `mock-msg-history-${chatId}-${i}`,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || (chat.lastActiveAt / 1000),
    })) : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages, firstId: null, hasMore: false }),
    });
  });

  // DELETE /api/sidekick/sessions/<chat_id> — drop from the in-memory map.
  await page.route(/.*\/api\/sidekick\/sessions\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)$/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    chats.delete(chatId);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // POST /api/sidekick/messages — fire-and-forget, returns 202.
  // Body has {chat_id, text}. Auto-creates the chat in our map and
  // schedules a reply envelope on the persistent stream.
  await page.route('**/api/sidekick/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body;
    try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    const chatId = body.chat_id;
    const text = body.text || '';
    if (chatId) {
      let chat = chats.get(chatId);
      if (!chat) {
        chat = { chatId, title: '', messages: [], lastActiveAt: Date.now() };
        chats.set(chatId, chat);
      }
      chat.messages.push({ role: 'user', content: text, timestamp: Date.now() / 1000 });
      chat.lastActiveAt = Date.now();
      // Synthetic agent reply with deterministic content.
      const replyText = `[mock] echo: ${text}`;
      const messageId = `mock-msg-${envelopeId + 1}`;
      // Schedule the envelope sequence after the POST returns.
      setTimeout(() => {
        broadcast({ type: 'typing', chat_id: chatId });
        broadcast({
          type: 'reply_delta',
          chat_id: chatId,
          text: replyText,
          message_id: messageId,
        });
        broadcast({ type: 'reply_final', chat_id: chatId, message_id: messageId });
        chat.messages.push({ role: 'assistant', content: replyText, timestamp: Date.now() / 1000 });
        chat.lastActiveAt = Date.now();
      }, 50);
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, message_id: `mock-${envelopeId + 1}` }),
    });
  });

  // GET /api/sidekick/stream — persistent SSE forwarded to the
  // in-process http.Server above. Playwright's `route.continue({ url })`
  // re-issues the request to the new URL and pipes the response body
  // back to the page, including streamed chunks. That gives us a real
  // long-lived SSE channel: `pushReply` / `pushSessionChanged` write
  // straight to `streamSubs` and the PWA sees them immediately, no
  // EventSource-reconnect hop required.
  await page.route('**/api/sidekick/stream', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const lastEventId = route.request().headers()['last-event-id'];
    // Forward Last-Event-Id as a query param too — some Playwright
    // versions strip the header when overriding `url`.
    const target = lastEventId
      ? `${sseUrl}?lastEventId=${encodeURIComponent(lastEventId)}`
      : sseUrl;
    await route.continue({ url: target });
  });

  // GET /config — minimal config so the PWA doesn't 404.
  await page.route('**/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        gwToken: 'mock-token',
        appName: 'SideKick',
        appSubtitle: 'Agent Portal',
        agentLabel: 'Clawdian',
        themePrimary: '',
        backend: 'proxy-client',
      }),
    });
  });

  // /api/sidekick/settings/* — agent-declared settings extension.
  // Tests configure schema via mock.setSettingsSchema([...]). null
  // schema = agent doesn't implement extension (route returns 404),
  // matching the contract for opt-out agents.
  let settingsSchema = null;            // null | SettingDef[]
  /** Records the most recent /api/sidekick/settings/{id} POST so
   *  tests can assert the body shape forwarded matches what they
   *  expected. */
  let lastSettingsPost = null;
  await page.route(/.*\/api\/sidekick\/settings(?:\/.*)?/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'GET' && url.pathname.endsWith('/settings/schema')) {
      if (settingsSchema === null) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'settings not supported' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ object: 'list', data: settingsSchema }),
      });
      return;
    }
    const m = method === 'POST' && url.pathname.match(/\/settings\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      let body;
      try { body = JSON.parse(route.request().postData() || '{}'); }
      catch { body = {}; }
      lastSettingsPost = { id, body };
      if (settingsSchema === null) {
        await route.fulfill({ status: 404, contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'settings not supported' } }) });
        return;
      }
      const def = settingsSchema.find((s) => s.id === id);
      if (!def) {
        await route.fulfill({ status: 404, contentType: 'application/json',
          body: JSON.stringify({ error: { message: `unknown setting: ${id}` } }) });
        return;
      }
      const value = body?.value;
      if (def.type === 'enum') {
        const ok = (def.options ?? []).some((o) => o.value === value);
        if (!ok) {
          await route.fulfill({ status: 400, contentType: 'application/json',
            body: JSON.stringify({ error: { message: `value not in options[]: ${JSON.stringify(value)}` } }) });
          return;
        }
      }
      def.value = value;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(def) });
      return;
    }
    return route.fallback();
  });

  // GET /api/keyterms — empty list, harmless.
  await page.route('**/api/keyterms', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  return {
    /** Add a synthetic chat to the mock's in-memory state. The PWA
     *  drawer will list it; clicking it returns the canned messages.
     *  Use `??` for `title` so callers can pre-seed an empty-string
     *  title (untitled-chat scenarios), which `||` would otherwise
     *  swap for the "Mock chat" default. */
    addChat(chatId, opts = {}) {
      chats.set(chatId, {
        chatId,
        source: opts.source || 'sidekick',
        title: opts.title ?? 'Mock chat',
        messages: opts.messages || [],
        lastActiveAt: opts.lastActiveAt || Date.now(),
      });
    },
    /** Push a reply envelope as if the agent generated it. The active
     *  stream subscriber will receive it on its next reconnect.
     *  `messageId` lets the test pin a stable id — useful for
     *  cross-path dedup tests where history's `id` must match the
     *  envelope's `message_id`. Defaults to a fresh synthetic id. */
    pushReply(chatId, text, messageId) {
      const id = messageId || `mock-msg-${envelopeId + 1}`;
      broadcast({ type: 'reply_delta', chat_id: chatId, text, message_id: id });
      broadcast({ type: 'reply_final', chat_id: chatId, message_id: id });
    },
    /** Push a session_changed envelope (e.g. for title-update tests).
     *  Also updates the in-memory chat's title to match — mimics what
     *  real hermes does (state.db title column updated alongside the
     *  envelope), so the next listSessions response carries the new
     *  title and the drawer's refresh catches up. */
    pushSessionChanged(chatId, title, sessionId = `mock-${chatId}`) {
      const chat = chats.get(chatId);
      if (chat) chat.title = title;
      broadcast({ type: 'session_changed', chat_id: chatId, session_id: sessionId, title });
    },
    /** Configure the /v1/settings/schema response. Pass null to
     *  declare the agent doesn't implement the extension (route
     *  returns 404). The handler also recognizes POST /settings/{id}
     *  with an enum-validation pass; getLastSettingsPost() returns
     *  what the PWA most recently sent. */
    setSettingsSchema(schema) {
      settingsSchema = schema;
      lastSettingsPost = null;
    },
    getLastSettingsPost() { return lastSettingsPost; },

    /** Inspect/snapshot. */
    chatCount() { return chats.size; },
    listChats() { return Array.from(chats.values()); },
    getChat(chatId) { return chats.get(chatId); },
    /** Tear down the in-process SSE server. Call from the runner's
     *  cleanup so we don't leak ports between scenarios. */
    async close() {
      // Close active SSE responses + sockets first so server.close()
      // resolves immediately instead of waiting for the keep-alive
      // timeout to drain.
      for (const sub of streamSubs) {
        try { sub.end(); } catch {}
      }
      streamSubs.clear();
      for (const sock of openSockets) {
        try { sock.destroy(); } catch {}
      }
      openSockets.clear();
      await new Promise((resolve) => sseServer.close(() => resolve()));
    },
  };
}
