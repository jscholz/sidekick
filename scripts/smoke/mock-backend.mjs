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
//
// Scenarios that exercise the LLM logic itself (tool-turn, etc.)
// should use the real backend via export const BACKEND = 'real'.
// Drawer / UX / persistence tests don't care about LLM behavior and
// run fine against the mock — orders of magnitude faster.

/** @typedef {{
 *    chatId: string,
 *    title: string,
 *    messages: Array<{role: string, content: string, timestamp?: number}>,
 *    lastActiveAt: number,
 *  }} MockChat
 */

export async function installMockBackend(page) {
  const chats = new Map();          // chat_id → MockChat
  const streamSubs = new Set();     // active stream connections (for replays)
  let envelopeId = 0;
  // Replay ring — same shape as the real /api/sidekick/stream so a
  // freshly-connecting PWA tab sees recent envelopes.
  const recent = [];

  const broadcast = (env) => {
    envelopeId++;
    const id = envelopeId;
    recent.push({ id, env });
    if (recent.length > 128) recent.shift();
    for (const sub of streamSubs) {
      try { sub.write(`id: ${id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`); }
      catch {}
    }
  };

  // GET /api/sidekick/sessions — canned list from the in-memory map.
  await page.route('**/api/sidekick/sessions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/messages')) {
      // Per-chat history endpoint — handled by the next route.
      return route.fallback();
    }
    if (route.request().method() !== 'GET') return route.fallback();
    const sessions = Array.from(chats.values()).map(c => ({
      chat_id: c.chatId,
      session_id: `mock-${c.chatId}`,
      source: c.source || 'sidekick',
      title: c.title,
      last_active_at: new Date(c.lastActiveAt).toISOString(),
      message_count: c.messages.length,
      created_at: new Date(c.lastActiveAt).toISOString(),
    }));
    sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions }),
    });
  });

  // GET /api/sidekick/sessions/<chat_id>/messages — canned transcript.
  await page.route(/.*\/api\/sidekick\/sessions\/[^/]+\/messages/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)\/messages/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    const chat = chats.get(chatId);
    const messages = chat ? chat.messages.map((m, i) => ({
      id: i,
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

  // GET /api/sidekick/stream — persistent SSE. Replay ring + live broadcasts.
  // Playwright's page.route doesn't support streaming bodies easily, so we
  // use a different mechanism: continue() + intercept inside a CDP helper.
  // Simpler approach: implement the stream as a long-poll-ish response that
  // closes after a flush; the PWA's EventSource auto-reconnects via the
  // server's `retry: 5000` hint. For tests, we serve a one-shot dump of
  // the ring + active subscription registration via a mock-friendly path.
  //
  // Instead: route the PWA's GET /api/sidekick/stream to a streaming
  // response built via the underlying request fulfill API. We can't write
  // multiple chunks via route.fulfill, so we use a request handler that
  // pipes a Readable.
  await page.route('**/api/sidekick/stream', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    // Build the initial replay payload + a short "keepalive" so the
    // EventSource doesn't immediately error. The PWA reconnects on
    // close; live envelopes between reconnects fall through to the
    // recent ring on the next subscribe. For test purposes this is
    // enough: scenarios send a message → POST handler schedules
    // envelopes → next stream connect serves them via the ring.
    const lastEventId = route.request().headers()['last-event-id'];
    const cursor = lastEventId ? Number.parseInt(lastEventId, 10) : -1;
    // Tests need live envelopes (pushReply / pushSessionChanged) to
    // reach the PWA quickly. Real proxy uses retry: 5000; the mock
    // stream serves a one-shot ring dump and closes, so the
    // EventSource reconnects on the retry interval and picks up
    // any envelopes pushed since. Shorten to 200ms so live envelopes
    // land within an assertion window of ~1s.
    let body = 'retry: 200\n\n';
    for (const entry of recent) {
      if (entry.id <= cursor) continue;
      body += `id: ${entry.id}\nevent: ${entry.env.type}\ndata: ${JSON.stringify(entry.env)}\n\n`;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
      body,
    });
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
        backend: 'hermes-gateway',
      }),
    });
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
     *  drawer will list it; clicking it returns the canned messages. */
    addChat(chatId, opts = {}) {
      chats.set(chatId, {
        chatId,
        source: opts.source || 'sidekick',
        title: opts.title || 'Mock chat',
        messages: opts.messages || [],
        lastActiveAt: opts.lastActiveAt || Date.now(),
      });
    },
    /** Push a reply envelope as if the agent generated it. The active
     *  stream subscriber will receive it on its next reconnect. */
    pushReply(chatId, text) {
      const messageId = `mock-msg-${envelopeId + 1}`;
      broadcast({ type: 'reply_delta', chat_id: chatId, text, message_id: messageId });
      broadcast({ type: 'reply_final', chat_id: chatId, message_id: messageId });
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
    /** Inspect/snapshot. */
    chatCount() { return chats.size; },
    listChats() { return Array.from(chats.values()); },
    getChat(chatId) { return chats.get(chatId); },
  };
}
