// Mock backend for parley PWA smoke scenarios.
//
// Intercepts /api/parley/* via Playwright page.route() and serves
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
// /api/parley/stream is served by a real in-process http.Server on
// an ephemeral 127.0.0.1 port (mirrors the proxy-test harness pattern
// at proxy/parley/__tests__/proxy-harness.ts).
// Playwright forwards the PWA's /api/parley/stream request to that
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
  /** Mirrors the real proxy's inflight cache. Tests opt in via
   *  setInflight(chatId, [...]) to simulate a chat with envelopes
   *  not yet persisted in state.db (e.g. an in-flight turn). The
   *  history-fetch handler appends these as the `inflight` field. */
  const inflightByChat = new Map();
  /** When true (default), POST /api/parley/messages auto-emits a
   *  reply via SSE 50ms later. Tests that want to drive envelopes
   *  manually (e.g. assert the thinking-dots label transitions
   *  across typing → tool_call → canvas.show) call
   *  mock.setAutoReplyEnabled(false) to suppress the auto-reply
   *  and push their own envelopes via pushEnvelope. */
  let autoReplyEnabled = true;
  // When true, POST /messages skips the user_message envelope echo.
  // Used by smokes that need to assert the PWA's optimistic user-
  // bubble path renders WITHOUT relying on a server-side echo.
  let suppressUserMessageBroadcast = false;
  /** Mirror hermes-core's post-turn persistence semantics. When true,
   *  the sessions list endpoint suppresses `first_user_message` for
   *  chats that have no assistant message yet — i.e. mid-turn, hermes
   *  hasn't fired `append_to_transcript` and the server-side state.db
   *  is empty for that chat. Tests that exercise the in-flight window
   *  (drawer snippets, mid-turn switch-away) flip this to `true`. The
   *  default `false` matches the legacy mock behavior most tests rely
   *  on (persistence is instant at POST time, which is wrong vs prod
   *  but convenient for non-timing tests). */
  let postTurnPersistence = false;
  /** Opt-in tool-row durability (2026-08-14). Real hermes persists a
   *  turn's tool_call / tool_result rows into state.db, so the
   *  post-final durable refresh carries them and the projection
   *  rebuilds the activity row from DURABLE after the inflight
   *  envelopes drain. The mock's pushEnvelope only broadcast tool
   *  envelopes (never persisted them), so post-final refresh returned
   *  a durable with the reply but NO tools → the activity row lost its
   *  only source and vanished (tool-progress-not-bubbles flake, ~3/8;
   *  NOT a production bug — prod durable carries the tools). Off by
   *  default so the 7 other tool_call-pushing smokes are unaffected;
   *  tool-progress-not-bubbles flips it on. Shape matches what
   *  tool-list-collapse-default seeds (proven to project → activityRow):
   *  an assistant row carrying tool_calls + a role:'tool' result row. */
  let persistToolRows = false;
  let toolPersistSeq = 0;
  /** Optional cap on the `limit` param the /messages endpoint honors,
   *  applied to the FIRST page only (requests without `?before=`).
   *  Used by load-earlier-history.mjs to force pagination in a small
   *  fixture without seeding 200+ messages. null = honor whatever the
   *  PWA sends. */
  let historyFirstPageLimit = null;
  const messageDelays = new Map();  // chat_id -> artificial /messages delay in ms
  /** SSE-disconnect simulation (offline-first smokes). While true:
   *   - /api/parley/stream is answered with a 503 → the PWA's
   *     EventSource HARD-fails (readyState CLOSED, no native retry) →
   *     proxyClient flips connected=false, exactly the spotty-mobile
   *     shape the field bug reproduced (isConnected() gate class).
   *   - live SSE subscribers are killed so the drop is immediate.
   *   - POST /messages and the sessions/history GETs are aborted at the
   *     network layer (fetch rejects with a TypeError) — the offline
   *     shape, distinct from an answered HTTP error.
   *  Recovery: setStreamOutage(false) then have the page dispatch a
   *  window 'online' event — the closed EventSource never retries on
   *  its own; the OS-lifecycle handler calls forceReconnect (mirrors
   *  real mobile foreground/online behavior). */
  let streamOutage = false;
  let sessionsFailStatus = 0;
  let sessionsDelayMs = 0;      // artificial /sessions list latency
  /** Artificial latency before the SSE stream response is forwarded.
   *  The PWA gates its whole boot LANDING (last-viewed restore +
   *  most-recent fallback, main.ts onStatus) on the EventSource
   *  opening, while the drawer renders from the (undelayed) sessions
   *  list long before that. Holding the stream open-handshake is
   *  therefore the only way to reproduce the field window in which the
   *  user taps a row BEFORE boot has begun its switch — the
   *  2026-09-06 mis-send (docs/UX_DETERMINISM_PLAN.md §1). */
  let streamConnectDelayMs = 0;
  const messageFailStatus = new Map();
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

  // Real in-process http.Server hosting /api/parley/stream as a
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
      const replayEnv = { ...entry.env, _replay: true };
      res.write(`id: ${entry.id}\nevent: ${entry.env.type}\ndata: ${JSON.stringify(replayEnv)}\n\n`);
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

  // GET /api/parley/sessions — canned list from the in-memory map.
  await page.route('**/api/parley/sessions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/messages')) {
      // Per-chat history endpoint — handled by the next route.
      return route.fallback();
    }
    if (route.request().method() !== 'GET') return route.fallback();
    if (streamOutage) return route.abort('connectionfailed');
    if (sessionsDelayMs > 0) {
      await new Promise((r) => setTimeout(r, sessionsDelayMs));
    }
    if (sessionsFailStatus > 0) {
      await route.fulfill({
        status: sessionsFailStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'mock sessions failure' }),
      });
      return;
    }
    const sessions = Array.from(chats.values()).map(c => {
      // Mirror the proxy's first_user_message derivation: pick the
      // first role='user' message and truncate to 80 chars. Lets the
      // drawer fall back to a snippet when title is still empty.
      //
      // Post-turn persistence mode (real hermes behavior): suppress
      // first_user_message until at least one assistant message has
      // landed — production hermes' append_to_transcript fires AFTER
      // agent_result is computed, so during the in-flight window the
      // server-side state.db has nothing for this chat. Tests that
      // verify drawer behavior during in-flight turns set
      // mock.setPostTurnPersistence(true).
      const hasAssistantReply = c.messages.some(m => m.role === 'assistant');
      const firstUser = c.messages.find(m => m.role === 'user');
      const visiblePostTurn = !postTurnPersistence || hasAssistantReply;
      const firstUserMessage = firstUser && visiblePostTurn
        ? String(firstUser.content || '').slice(0, 80)
        : null;
      // message_count is also gated: real hermes' append_to_transcript
      // fires post-turn, so /v1/gateway/conversations returns 0 until
      // reply_final lands. Both `first_user_message` AND `message_count`
      // need the same gate or the PWA's cleanup heuristic (messageCount
      // > 0 → "server knows", spare from cleanup) misbehaves only in
      // production, not in tests.
      const messageCount = visiblePostTurn ? c.messages.length : 0;
      return {
        chat_id: c.chatId,
        session_id: `mock-${c.chatId}`,
        source: c.source || 'parley',
        title: c.title,
        last_active_at: new Date(c.lastActiveAt).toISOString(),
        message_count: messageCount,
        created_at: new Date(c.lastActiveAt).toISOString(),
        first_user_message: firstUserMessage,
        session_ids: c.sessionIds || undefined,
      };
    });
    sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions }),
    });
  });

  // GET /api/parley/sessions/<chat_id>/messages — canned transcript.
  // Each message's `id` matches the SSE envelope `message_id` the
  // proxy emitted for that same content — mirrors the real proxy
  // (proxy/parley/history.ts maps `id: it.id` and upstream.ts
  // emits the same `it.id` as `message_id` on reply_delta /
  // reply_final). Tests rely on this alignment for cross-path dedup.
  await page.route(/.*\/api\/parley\/sessions\/[^/]+\/messages/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (streamOutage) return route.abort('connectionfailed');
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)\/messages/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    const chat = chats.get(chatId);
    const failStatus = messageFailStatus.get(chatId) || 0;
    if (failStatus > 0) {
      await route.fulfill({
        status: failStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'mock messages failure' }),
      });
      return;
    }
    const delayMs = messageDelays.get(chatId) || 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    // Honor ?limit + ?before for pagination — matches the real proxy's
    // contract (history.ts). Ids are integer-shape (chat-local i+1000
    // unless the test sets m.message_id) so the `before` cursor — which
    // the proxy validator forces to /^\d+$/ — actually works against
    // the mock. Pre-2026-05-11 the mock used string ids and ignored
    // the params; this broke load-earlier-history end-to-end coverage.
    let limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
    // `around=<parley_id|integer id>` — one-shot deep-drill BOUNDED
    // window. Mirrors the plugin (list_messages_around_for_chat_with_
    // state_db_source): a slice CENTERED on the target (context above +
    // below), capped at ~limit rows — payload is O(limit), independent of
    // how deep the target sits. targetFound=false (empty list) when the
    // target is missing.
    const aroundRaw = url.searchParams.get('around');
    const around = aroundRaw && /^[A-Za-z0-9._:-]{1,128}$/.test(aroundRaw) ? aroundRaw : null;
    // `after=<integer id>` — load-newer page (symmetric to `before`).
    // Walks a floating deep `around` window forward toward the live tail.
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw && /^\d+$/.test(afterRaw) ? parseInt(afterRaw, 10) : null;
    // Test-controlled cap on the first page (no `before`) so smokes
    // can force pagination with a small fixture (see
    // load-earlier-history.mjs). Subsequent loadEarlier requests
    // carry their own ?before cursor and use the PWA's actual limit.
    if (before === null && typeof historyFirstPageLimit === 'number' && historyFirstPageLimit > 0) {
      limit = Math.min(limit, historyFirstPageLimit);
    }
    const allMessages = chat ? chat.messages.map((m, i) => {
      const integerId = 1000 + i;  // chat-local, deterministic for assertions
      const out = {
        id: m.message_id != null ? m.message_id : integerId,
        role: m.role,
        content: m.content,
        // Use `!=` so smokes can intentionally drive timestamp=0
        // (mirrors the field-bug shape where parley.db.msg_links
        // had `created_at=0` and the bubble rendered at unix 0).
        timestamp: m.timestamp != null ? m.timestamp : (chat.lastActiveAt / 1000),
      };
      // Mirror the real plugin's surfacing of parley_id from
      // parley_msg_links — present when the live SSE round-trip
      // recorded a link, absent for legacy / other-channel rows.
      // Tests can opt in per-message by setting `parley_id` on the
      // mock chat's message dict.
      if (m.parley_id) out.parley_id = m.parley_id;
      // Tool-call linkage (hermes plugin /items extension, 2026-05-17).
      // role='tool' rows carry tool_call_id referencing back to the
      // assistant message that issued the call. role='assistant'
      // rows that orchestrated tool calls carry `tool_calls` (JSON
      // string — already serialized on disk; pass through verbatim).
      // PWA renderHistoryMessage routes these to activityRow to
      // reconstruct the "N tools · done" surface on history replay.
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      // Notification kind annotation (approval, cron, reminder). The
      // projection's `isNotificationLikeItem` keys off `kind`; without
      // it, a seeded notification row gets projected as a normal
      // assistant bubble and the drill won't find the `notif:${sk}`
      // key. Pass through so smokes can seed durable approvals/crons.
      if (m.kind) out.kind = m.kind;
      return out;
    }) : [];
    // Around (deep-drill) window takes precedence over before-paging.
    // BOUNDED CENTERED window: context above the target (~2/3 of limit)
    // + context below (~1/3), so payload is O(limit) regardless of how
    // deep the target sits. firstId/hasMore expose the older edge (toward
    // head); lastId/hasMoreNewer expose the newer edge (toward the live
    // tail). A deep window is "floating" — it reaches the tail only once
    // hasMoreNewer flips false (loaded the last row), at which point the
    // PWA may persist it. Mirrors the plugin's
    // list_messages_around_for_chat_with_state_db_source.
    if (around !== null) {
      const idx = allMessages.findIndex(
        (m) => String(m.parley_id || '') === around || String(m.id) === around,
      );
      let body;
      if (idx < 0) {
        body = {
          messages: [], firstId: null, hasMore: false,
          lastId: null, hasMoreNewer: false, targetFound: false,
        };
      } else {
        const ctxBefore = Math.max(20, Math.floor((limit * 2) / 3));
        const ctxAfter = Math.max(10, Math.floor(limit / 3));
        const start = Math.max(0, idx - ctxBefore);
        const end = Math.min(allMessages.length, idx + ctxAfter + 1);
        const window = allMessages.slice(start, end);
        body = {
          messages: window,
          firstId: window.length > 0 ? window[0].id : null,
          hasMore: start > 0,
          lastId: window.length > 0 ? window[window.length - 1].id : null,
          hasMoreNewer: end < allMessages.length,
          targetFound: true,
        };
      }
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(body),
      });
      return;
    }
    // `after=<integer id>` — load-newer page (exclusive: id > after),
    // bounded by limit, walking a floating deep window forward toward the
    // live tail. lastId/hasMoreNewer expose the newer edge so the PWA
    // knows when it has connected the window to the tail.
    if (after !== null) {
      // Positional slice past the cursor row when it exists. The real
      // proxy pages by state.db rowid, where EVERY row has an integer
      // id; the mock persists live-POSTed rows with their SSE-shape
      // string ids (see the POST handler), so a pure `id > after`
      // numeric filter silently DROPPED them — a delta resume after a
      // reconnect then repainted stale pre-POST state over the newest
      // turn (surfaced by send-while-offline-queues). Fall back to the
      // numeric filter when the cursor row is gone.
      const cursorIdx = allMessages.findIndex((m) => typeof m.id === 'number' && m.id === after);
      const newer = cursorIdx >= 0
        ? allMessages.slice(cursorIdx + 1)
        : allMessages.filter((m) => typeof m.id === 'number' && m.id > after);
      const page = newer.slice(0, limit);
      const lastId = page.length > 0 ? page[page.length - 1].id : null;
      const hasMoreNewer = page.length < newer.length;
      // Mirror the real proxy (history.ts): an after-page that reaches
      // the live tail (hasMoreNewer=false) is a delta-resume snapshot
      // (#191) and carries the in-flight envelopes; intermediate pages
      // stay bare.
      const afterInflight = !hasMoreNewer ? (inflightByChat.get(chatId) || []) : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: page,
          lastId: typeof lastId === 'number' ? lastId : null,
          hasMoreNewer,
          ...(afterInflight.length > 0 ? { inflight: afterInflight } : {}),
        }),
      });
      return;
    }
    // Apply pagination. `before` is exclusive (return messages with
    // id < before); no `before` means "newest page". Slice tail-side.
    const upTo = before != null
      ? allMessages.findIndex((m) => typeof m.id === 'number' && m.id >= before)
      : allMessages.length;
    const sliceEnd = upTo < 0 ? allMessages.length : upTo;
    const sliceStart = Math.max(0, sliceEnd - limit);
    const messages = allMessages.slice(sliceStart, sliceEnd);
    const firstId = messages.length > 0 ? messages[0].id : null;
    const hasMore = sliceStart > 0;
    // Inflight envelopes — mirror the real proxy's behavior of
    // surfacing envelopes from in-flight turns (the user message +
    // tool calls + streaming reply deltas that haven't been
    // persisted to state.db yet). Tests opt in by calling
    // mock.setInflight(chatId, [envelopes...]). Only on fresh pages
    // (before=null) — older pages can't contain inflight by definition.
    const inflightEnvelopes = before === null ? (inflightByChat.get(chatId) || []) : [];
    const responseBody = {
      messages,
      firstId: typeof firstId === 'number' ? firstId : null,
      hasMore,
      ...(inflightEnvelopes.length > 0 ? { inflight: inflightEnvelopes } : {}),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseBody),
    });
  });

  // DELETE /api/parley/sessions/<chat_id> — drop from the in-memory map.
  await page.route(/.*\/api\/parley\/sessions\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)$/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    chats.delete(chatId);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // ── Setup wizard status: always "configured" ──
  // Without this, running the suite against an UNCONFIGURED server
  // (fresh worktree, no .env → stub echo agent) pops the first-run
  // wizard overlay, which intercepts pointer events over the whole
  // page and breaks every click-based smoke. Mocked smokes must not
  // depend on the host's .env; no smoke exercises the wizard itself.
  await page.route('**/api/parley/setup/status', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        needsSetup: false,
        upstream: { ok: true, kind: 'custom', llm: null },
        ollama: { available: false, models: [] },
        voice: { configured: true },
      }),
    });
  });

  // ── Meeting capture (proxy capture.ts contract, minimal mock) ──
  // In-memory manifests + segment acks; `setCaptureOutage(true)` makes
  // segment POSTs 503 so smokes can exercise the durable-uploader
  // retry path. Mirrors the two-phase lifecycle (2026-08-18 postmortem):
  // create → 'pending'; POST /activate (or a first segment) →
  // 'recording'; /abort-start fails in place; /discard tombstones;
  // DELETE is guarded exactly like the real server. Every lifecycle
  // call is logged so smokes can assert "DELETE was never called".
  const captures = new Map();
  const captureLifecycle = [];   // { action, id, body? } in arrival order
  let captureOutage = false;
  // Regex, not the '**/api/parley/captures' glob: globs must match the
  // FULL url, so `?include=discarded` (the Recently-Deleted UI's opt-in
  // view, B2) fell through to the real isolated server — which knows
  // none of the mock's captures and answered an empty list.
  await page.route(/.*\/api\/parley\/captures(?:\?.*)?$/, async (route) => {
    // GET = the capture list meetingsIndex fetches at boot (and on
    // capture_changed envelopes). Served from the mock's map so
    // has-recording drawer state is test-controlled — falling back to
    // the real dev proxy here would leak whatever real captures exist
    // on the host into the smoke.
    if (route.request().method() === 'GET') {
      // Default view hides Recently Deleted, like the real server
      // (?include=discarded opts in).
      const includeDiscarded = /[?&]include=discarded\b/.test(route.request().url());
      const rows = Array.from(captures.values())
        .filter((c) => includeDiscarded || c.status !== 'discarded');
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ captures: rows }),
      });
    }
    if (route.request().method() !== 'POST') return route.fallback();
    let body;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
    const id = `cap_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const capture = {
      id,
      title: body.title || `Meeting ${new Date().toISOString().slice(0, 10)}`,
      linked_chat: body.linked_chat === 'new'
        ? `parley:mock-capture-${Math.random().toString(16).slice(2, 8)}`
        : (body.linked_chat || null),
      diarize: body.diarize !== false,
      status: 'pending',
      started_at: Date.now(),
      ended_at: null,
      marks: [],
      speakers: {},
      segments: [],
    };
    captures.set(id, capture);
    captureLifecycle.push({ action: 'create', id });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ capture }) });
  });
  // Two-phase lifecycle verbs (postmortem 2026-08-18): activate,
  // abort-start, discard, restore, purge. One route, dispatch on tail.
  await page.route(/.*\/api\/parley\/captures\/[^/]+\/(activate|abort-start|discard|restore|purge)$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const m = new URL(route.request().url()).pathname
      .match(/\/captures\/([^/]+)\/(activate|abort-start|discard|restore|purge)$/);
    const cap = captures.get(m ? m[1] : '');
    const verb = m ? m[2] : '';
    let body;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
    captureLifecycle.push({ action: verb, id: m ? m[1] : '', body });
    const reply = (status, payload) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (!cap) return reply(404, { error: 'unknown capture' });
    if (verb === 'activate') {
      if (cap.status === 'recording') return reply(200, { capture: cap });
      if (cap.status !== 'pending') return reply(409, { error: `capture is ${cap.status}; cannot activate` });
      cap.status = 'recording';
      cap.activated_at = Date.now();
      return reply(200, { capture: cap });
    }
    if (verb === 'abort-start') {
      if (cap.status === 'failed') return reply(200, { capture: cap });
      if (cap.status !== 'pending') return reply(409, { error: `capture is ${cap.status}; abort-start only applies to a pending capture` });
      if (cap.segments.length) return reply(409, { error: 'capture has segments; use /discard' });
      cap.status = 'failed';
      cap.failed_reason = body.reason || 'startup aborted';
      cap.ended_at = Date.now();
      return reply(200, { capture: cap });
    }
    if (verb === 'discard') {
      if (cap.status !== 'discarded') {
        cap.pre_discard_status = cap.status;
        cap.status = 'discarded';
        cap.discarded_at = Date.now();
        if (!cap.ended_at) cap.ended_at = Date.now();
      }
      return reply(200, { capture: cap });
    }
    if (verb === 'restore') {
      if (cap.status !== 'discarded') return reply(409, { error: `capture is ${cap.status}; only discarded captures can be restored` });
      cap.status = (cap.pre_discard_status === 'complete' || cap.pre_discard_status === 'failed')
        ? cap.pre_discard_status
        : (cap.segments.length ? 'complete' : 'failed');
      delete cap.discarded_at;
      delete cap.pre_discard_status;
      return reply(200, { capture: cap });
    }
    // purge — discarded-only, irreversible.
    if (cap.status !== 'discarded') return reply(409, { error: `capture is ${cap.status}; purge requires Recently Deleted` });
    captures.delete(cap.id);
    return reply(200, { ok: true, purged: cap.id });
  });
  await page.route(/.*\/api\/parley\/captures\/[^/]+\/segments\/\d+$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (captureOutage) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"outage"}' });
    }
    const m = new URL(route.request().url()).pathname.match(/\/captures\/([^/]+)\/segments\/(\d+)$/);
    const cap = captures.get(m ? m[1] : '');
    if (!cap) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unknown capture"}' });
    // Terminal/discarded captures freeze segments ('frozen' is
    // load-bearing — the uploader parks and keeps its durable copy).
    if (cap.status === 'complete' || cap.status === 'failed' || cap.status === 'discarded') {
      return route.fulfill({
        status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: `capture is ${cap.status}; segments are frozen` }),
      });
    }
    // Legacy-compat gate: a first segment on a pending capture implies
    // activation (matches proxy/parley/capture.ts).
    if (cap.status === 'pending') {
      cap.status = 'recording';
      cap.activated_at = Date.now();
      captureLifecycle.push({ action: 'activate-implied', id: cap.id });
    }
    const seq = Number(m[2]);
    const duplicate = cap.segments.some((s) => s.seq === seq);
    if (!duplicate) {
      cap.segments.push({ seq, bytes: (route.request().postDataBuffer() || Buffer.alloc(0)).length });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seq, duplicate }) });
  });
  await page.route(/.*\/api\/parley\/captures\/[^/]+\/stop$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const m = new URL(route.request().url()).pathname.match(/\/captures\/([^/]+)\/stop$/);
    const cap = captures.get(m ? m[1] : '');
    captureLifecycle.push({ action: 'stop', id: m ? m[1] : '' });
    // Idempotent; a still-pending capture stays pending (server sweep
    // fails it in place later) — matches proxy/parley/capture.ts.
    if (cap && cap.status === 'recording') { cap.status = 'complete'; cap.ended_at = Date.now(); }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ capture: cap || null }) });
  });
  // GET /captures/{id}/transcript — the reconcile heal path (stale
  // "(live)" shelf docs, field report 2026-08-26). Mirrors the real
  // server: 404 for unknown captures or no transcript content;
  // discarded → status + title WITHOUT content.
  await page.route(/.*\/api\/parley\/captures\/[^/]+\/transcript(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const m = new URL(route.request().url()).pathname.match(/\/captures\/([^/]+)\/transcript$/);
    const cap = captures.get(m ? m[1] : '');
    const reply = (status, payload) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (!cap) return reply(404, { error: 'unknown capture' });
    if (cap.status === 'discarded') {
      return reply(200, { capture_id: cap.id, status: cap.status, title: cap.title });
    }
    if (typeof cap.transcript !== 'string') {
      return reply(404, { error: `capture ${cap.id} has no transcript` });
    }
    return reply(200, {
      capture_id: cap.id, status: cap.status, title: cap.title,
      format: 'markdown', content: cap.transcript,
    });
  });
  await page.route(/.*\/api\/parley\/captures\/[^/]+$/, async (route) => {
    // GET = single-capture manifest fetch (the stale-doc reconcile's
    // status probe). Served from the mock's map like the list route —
    // falling back to the isolated real server would 404 every mock
    // capture and make the reconciler DELETE docs the smoke seeded.
    if (route.request().method() === 'GET') {
      const gm = new URL(route.request().url()).pathname.match(/\/captures\/([^/]+)$/);
      const gcap = captures.get(gm ? gm[1] : '');
      return route.fulfill({
        status: gcap ? 200 : 404, contentType: 'application/json',
        body: JSON.stringify(gcap ? { capture: gcap } : { error: 'unknown capture' }),
      });
    }
    if (route.request().method() !== 'DELETE') return route.fallback();
    const m = new URL(route.request().url()).pathname.match(/\/captures\/([^/]+)$/);
    const cap = captures.get(m ? m[1] : '');
    captureLifecycle.push({ action: 'delete', id: m ? m[1] : '' });
    if (!cap) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unknown capture"}' });
    }
    // Safety-mapped like the real server (2026-08-18 incident): legacy
    // DELETE on anything live/segment-bearing tombstones (soft
    // discard); empty pending fails in place; discarded → 409; only a
    // terminal empty husk is actually removed.
    if (cap.status === 'discarded') {
      return route.fulfill({
        status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: 'capture is in Recently Deleted; use /purge' }),
      });
    }
    if (cap.segments.length || cap.status === 'recording' || cap.status === 'transcribing') {
      cap.pre_discard_status = cap.status;
      cap.status = 'discarded';
      cap.discarded_at = Date.now();
      if (!cap.ended_at) cap.ended_at = Date.now();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, deleted: cap.id }) });
    }
    if (cap.status === 'pending') {
      cap.status = 'failed';
      cap.failed_reason = 'legacy DELETE on a pending capture — failed in place';
      cap.ended_at = Date.now();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, deleted: cap.id }) });
    }
    captures.delete(cap.id);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, deleted: cap.id }) });
  });
  await page.route(/.*\/api\/parley\/captures\/[^/]+\/marks$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const m = new URL(route.request().url()).pathname.match(/\/captures\/([^/]+)\/marks$/);
    const cap = captures.get(m ? m[1] : '');
    let body;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
    if (cap) cap.marks.push({ t_ms: Number(body.t_ms) || 0 });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, marks: cap?.marks || [] }) });
  });

  // POST /api/parley/messages — fire-and-forget, returns 202.
  // Body has {chat_id, text}. Auto-creates the chat in our map and
  // schedules a reply envelope on the persistent stream.
  await page.route('**/api/parley/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (streamOutage) return route.abort('connectionfailed');
    let body;
    try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    const chatId = body.chat_id;
    const text = body.text || '';
    // user_message_id may ride on the body OR on metadata.
    // Mirrors what real plugin reads — see backends/hermes/plugin/__init__.py.
    const incomingUserMsgId =
      body.user_message_id
      || (body.metadata && body.metadata.user_message_id)
      || null;
    if (chatId) {
      let chat = chats.get(chatId);
      if (!chat) {
        chat = { chatId, title: '', messages: [], lastActiveAt: Date.now() };
        chats.set(chatId, chat);
      }
      // Mirror plugin behavior: emit a user_message envelope BEFORE
      // dispatch so cross-device clients render the bubble. Echo back
      // the PWA-supplied user_message_id (if any) so the originating
      // device's renderedMessages.upsert collapses idempotently.
      const userMsgId = incomingUserMsgId || `umsg_mock_${envelopeId + 1}`;
      const replyText = `[mock] echo: ${text}`;
      const messageId = `mock-msg-${envelopeId + 1}`;
      // Persist the user+assistant rows with their SSE-shape ids so a
      // later history-fetch returns parley_id matching what the live
      // user_message / reply_final envelopes carried. Without this, the
      // smoke's history endpoint mints synthetic ids that DON'T match
      // the optimistic-bubble or user_message keys — and the smoke
      // silently exercises a different upsert path than production.
      // Reproducing field bug 2026-05-11: the user bubble in production
      // is keyed by umsg_*, the history-replay path ALSO needs to upsert
      // with umsg_* (via parley_id) for the bubble to render after a
      // switch-away-and-back clear-and-replay.
      chat.messages.push({
        role: 'user',
        content: text,
        message_id: userMsgId,
        parley_id: userMsgId,
        timestamp: Date.now() / 1000,
      });
      chat.lastActiveAt = Date.now();
      if (!autoReplyEnabled) {
        // Test wants to drive envelopes manually — skip the auto-
        // reply but still broadcast user_message so cross-device
        // optimistic-bubble dedup works. Tests that explicitly want
        // to assert the PWA's optimistic user-bubble path can set
        // suppressUserMessageBroadcast=true to silence this echo.
        if (!suppressUserMessageBroadcast) {
          setTimeout(() => {
            broadcast({
              type: 'user_message',
              chat_id: chatId,
              message_id: userMsgId,
              text,
            });
          }, 0);
        }
      } else {
      setTimeout(() => {
        broadcast({
          type: 'user_message',
          chat_id: chatId,
          message_id: userMsgId,
          text,
        });
        broadcast({ type: 'typing', chat_id: chatId });
        broadcast({
          type: 'reply_delta',
          chat_id: chatId,
          text: replyText,
          message_id: messageId,
        });
        broadcast({ type: 'reply_final', chat_id: chatId, message_id: messageId });
        chat.messages.push({
          role: 'assistant',
          content: replyText,
          message_id: messageId,
          parley_id: messageId,
          timestamp: Date.now() / 1000,
        });
        chat.lastActiveAt = Date.now();
      }, 50);
      }
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, message_id: `mock-${envelopeId + 1}` }),
    });
  });

  // GET /api/parley/stream — persistent SSE forwarded to the
  // in-process http.Server above. Playwright's `route.continue({ url })`
  // re-issues the request to the new URL and pipes the response body
  // back to the page, including streamed chunks. That gives us a real
  // long-lived SSE channel: `pushReply` / `pushSessionChanged` write
  // straight to `streamSubs` and the PWA sees them immediately, no
  // EventSource-reconnect hop required.
  await page.route('**/api/parley/stream', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (streamOutage) {
      // Non-200 makes the EventSource fail HARD (readyState CLOSED, no
      // native retry) — that's what flips proxyClient's connected=false.
      // A network abort would leave it in the CONNECTING retry loop with
      // connected stuck true, which is a different failure shape.
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'mock stream outage' });
    }
    if (streamConnectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, streamConnectDelayMs));
    }
    const lastEventId = route.request().headers()['last-event-id'];
    // Forward Last-Event-Id as a query param too — some Playwright
    // versions strip the header when overriding `url`.
    const target = lastEventId
      ? `${sseUrl}?lastEventId=${encodeURIComponent(lastEventId)}`
      : sseUrl;
    await route.continue({ url: target });
  });

  // GET /config — minimal config so the PWA doesn't 404. Anchor to
  // origin-root with a regex; a glob like `**/config` also matches
  // `/api/parley/config`, which silently turned settings.load() into
  // a no-op (the runtime-config payload has no `settings` field) — every
  // mocked-backend test was reading DEFAULTS for every yaml-backed key.
  await page.route(/^https?:\/\/[^/]+\/config(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        gwToken: 'mock-token',
        appName: 'Parley',
        appSubtitle: 'Agent Portal',
        agentLabel: 'Clawdian',
        themePrimary: '',
        backend: 'proxy-client',
      }),
    });
  });

  // /api/parley/settings/* — agent-declared settings extension.
  // Tests configure schema via mock.setSettingsSchema([...]). null
  // schema = agent doesn't implement extension (route returns 404),
  // matching the contract for opt-out agents.
  let settingsSchema = null;            // null | SettingDef[]
  /** Records the most recent /api/parley/settings/{id} POST so
   *  tests can assert the body shape forwarded matches what they
   *  expected. */
  let lastSettingsPost = null;
  // /api/parley/health* — health extension (Settings › Health).
  let health = null;                     // null | HealthCheck[]
  let lastHealthRun = null;
  await page.route(/.*\/api\/parley\/health(?:\/.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const notSupported = () => route.fulfill({ status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'agent does not implement /v1/health' } }) });
    if (health === null) return notSupported();
    if (method === 'GET' && /\/health\/?$/.test(url.pathname)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: health }) });
      return;
    }
    const m = url.pathname.match(/\/health\/([^/]+)\/run$/);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]); lastHealthRun = id;
      const c = health.find((x) => x.id === id);
      if (!c) { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'no such check' } }) }); return; }
      Object.assign(c, { worst: 'OK', report: '✅ mock health — later — 0 FAIL · 0 WARN · 1 OK\nOK   all — good', counts: { fail: 0, warn: 0, ok: 1 }, last_run_at: new Date().toISOString() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(c) });
      return;
    }
    return route.fallback();
  });

  // /api/parley/jobs* — scheduled-jobs extension (Settings › Cron).
  // Tests configure via mock.setJobs([...]); null = agent has no
  // scheduler (404, section shows "not supported").
  let jobs = null;                       // null | JobDef[]
  let lastJobPost = null;                // { id, action: 'update'|'run', body }
  await page.route(/.*\/api\/parley\/jobs(?:\/.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const notSupported = () => route.fulfill({ status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'agent does not implement /v1/jobs' } }) });
    if (method === 'GET' && /\/jobs\/?$/.test(url.pathname)) {
      if (jobs === null) return notSupported();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        object: 'list', data: jobs,
        options: {
          deliver: [
            { value: 'origin', label: 'Origin chat', group: 'Routing' },
            { value: 'local', label: 'Save only', group: 'Routing' },
            { value: 'parley:chat-press', label: 'Press radar chat', group: 'Parley chats' },
          ],
          model: [
            { value: '', label: 'Follow default (gpt-6-astra)', group: 'Default' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', group: 'OpenAI Codex' },
          ],
        },
        default_model: 'gpt-6-astra',
      }) });
      return;
    }
    const m = url.pathname.match(/\/jobs\/([^/]+)(\/run|\/runs)?$/);
    if (!m) return route.fallback();
    const id = decodeURIComponent(m[1]);
    if (jobs === null) return notSupported();
    const job = jobs.find((j) => j.id === id);
    if (m[2] === '/runs') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ object: 'list', data: [] }) });
      return;
    }
    if (method === 'DELETE' && !m[2]) {
      lastJobPost = { id, action: 'delete', body: null };
      if (!job) { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'no such job' } }) }); return; }
      jobs = jobs.filter((j) => j.id !== id);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: true, id }) });
      return;
    }
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    lastJobPost = { id, action: m[2] === '/run' ? 'run' : 'update', body };
    if (!job) {
      await route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'not_found', message: 'no such job' } }) });
      return;
    }
    if (m[2] === '/run') { job.enabled = true; job.state = 'scheduled'; }
    else {
      Object.assign(job, body);
      if (typeof body.enabled === 'boolean') job.state = body.enabled ? 'scheduled' : 'paused';
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(job) });
  });

  await page.route(/.*\/api\/parley\/settings(?:\/.*)?/, async (route) => {
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

  // /api/parley/commands — slash-command catalog. Tests configure
  // via mock.setCommandsCatalog([...]). null = upstream agent doesn't
  // implement the extension (route returns 404), matching the
  // contract for opt-out agents. Default is null so existing smokes
  // see a no-op slashCommands module.
  let commandsCatalog = null;        // null | CommandDef[]
  await page.route(/.*\/api\/parley\/commands(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (commandsCatalog === null) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'commands not supported' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ object: 'list', data: commandsCatalog }),
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

  // ── Server-driven unread state (SSOT after the 2026-05 refactor) ──
  //
  // Real plugin owns unread_state in parley.db; the proxy forwards
  // /api/parley/notifications/{unread,seen,mark} to /v1/unread/*.
  // Mock mirrors that surface here so tests can drive the badge flow
  // through the same code paths the PWA uses in production.
  //
  // Auto-bumping: pushEnvelope() detects `notification` and
  // `reply_final` envelopes and increments the per-chat unread count
  // (mimics what the plugin's responses-handler does when an
  // assistant row lands). POST /notifications/seen clears the count
  // for one chat. The PWA's 1500ms debounced refresh picks up the
  // new state on its next fetch.
  const unreadByChat = new Map();   // chat_id → unread_count
  const markedUnread = new Set();   // chat_ids with sticky-unread
  // Artificial GET /notifications/unread latency. SNAPSHOT-THEN-DELIVER
  // (unlike sessionsDelayMs, which delays before computing): the body is
  // computed at request time and delivered after the hold, so a mutation
  // landing mid-flight makes the held response genuinely STALE — the
  // exact race the badge stale-snapshot guard must discard. Delaying
  // first would deliver fresh state and mask the revert under test.
  let unreadDelayMs = 0;
  function bumpUnread(chatId) {
    if (!chatId) return;
    unreadByChat.set(chatId, (unreadByChat.get(chatId) || 0) + 1);
  }
  function clearUnreadFor(chatId) {
    unreadByChat.delete(chatId);
    markedUnread.delete(chatId);
  }
  await page.route(/.*\/api\/parley\/notifications\/unread$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const out = [];
    const seen = new Set();
    for (const [cid, n] of unreadByChat) {
      out.push({ chat_id: cid, unread_count: n, marked_unread: markedUnread.has(cid) });
      seen.add(cid);
    }
    for (const cid of markedUnread) {
      if (!seen.has(cid)) out.push({ chat_id: cid, unread_count: 0, marked_unread: true });
    }
    // Body is fully computed above — the hold only delays DELIVERY.
    if (unreadDelayMs > 0) {
      await new Promise((r) => setTimeout(r, unreadDelayMs));
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ chats: out, total: out.reduce((a, c) => a + Math.max(c.unread_count, c.marked_unread ? 1 : 0), 0) }),
    });
  });
  await page.route(/.*\/api\/parley\/notifications\/seen$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body; try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    if (body.chat_id) clearUnreadFor(body.chat_id);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route(/.*\/api\/parley\/notifications\/mark$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body; try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    if (body.chat_id) {
      if (body.marked === true) markedUnread.add(body.chat_id);
      else markedUnread.delete(body.chat_id);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // ── Notification prefs + mutes isolation (push-prefs incident,
  // 2026-07-25) ──
  //
  // These endpoints write through the live proxy into the REAL
  // parley.db (push_prefs / push_mutes) — the only notifications
  // routes with durable server state that mocked smokes could
  // corrupt. Serve them from in-memory state so no mocked scenario
  // can EVER touch production push prefs, no matter what UI it
  // clicks. Shape mirrors the proxy's preferences response
  // (prefs.ts DEFAULT_PREFS + normalizePluginPrefs).
  const pushPrefs = {
    quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
    kinds: { agent_reply: true, cron: true, approval: true },
  };
  await page.route(/.*\/api\/parley\/notifications\/preferences$/, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      let body; try { body = JSON.parse(route.request().postData() || '{}'); }
      catch { body = {}; }
      if (body.quiet_hours && typeof body.quiet_hours === 'object') {
        Object.assign(pushPrefs.quiet_hours, body.quiet_hours);
      }
      if (body.kinds && typeof body.kinds === 'object') {
        Object.assign(pushPrefs.kinds, body.kinds);
      }
    } else if (method !== 'GET') {
      return route.fallback();
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(pushPrefs),
    });
  });
  const mutedChats = new Set();
  await page.route(/.*\/api\/parley\/notifications\/mutes$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ muted_chats: Array.from(mutedChats) }),
    });
  });
  await page.route(/.*\/api\/parley\/notifications\/mute$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body; try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    if (body.chat_id) {
      if (body.muted) mutedChats.add(body.chat_id);
      else mutedChats.delete(body.chat_id);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // ── Server-driven pin state (SSOT after the 2026-05 refactor) ──
  //
  // Real plugin owns the `pins` table in parley.db; the proxy
  // forwards /api/parley/pins/* to /v1/pins/*. Mock mirrors that
  // surface here so tests that use pinMessage() / unpinMessage() drive
  // the real server-roundtrip code paths.
  const pinsByKey = new Map();  // `${chatId}|${msgId}` → pin record
  const pkey = (cid, mid) => `${cid}|${mid}`;
  await page.route(/.*\/api\/parley\/pins(\?.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      const out = Array.from(pinsByKey.values()).sort((a, b) => b.pinnedAt - a.pinnedAt);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ pins: out }),
      });
      return;
    }
    if (method === 'POST') {
      let body; try { body = JSON.parse(route.request().postData() || '{}'); }
      catch { body = {}; }
      const { chat_id, msg_id, role, text, timestamp } = body;
      if (chat_id && msg_id) {
        pinsByKey.set(pkey(chat_id, msg_id), {
          chatId: chat_id, msgId: msg_id,
          role: role || 'user',
          text: text || '',
          timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
          pinnedAt: Date.now(),
        });
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    return route.fallback();
  });
  await page.route(/.*\/api\/parley\/pins\/[^/]+\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/pins\/([^/]+)\/([^/]+)$/);
    if (m) {
      const cid = decodeURIComponent(m[1]);
      const mid = decodeURIComponent(m[2]);
      pinsByKey.delete(pkey(cid, mid));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"removed":true}' });
  });

  // ── Synced user settings (parley.db user_settings) ──
  //
  // Real plugin owns the `user_settings` table; the proxy forwards
  // GET/PUT /api/parley/prefs/<key> to /v1/user-settings. Mock keys
  // a Map by setting name so cross-device sync tests (e.g. STT
  // key-terms) drive the same server-roundtrip path the PWA uses.
  //
  // Mirrors the post-incident (2026-07-31 keyterms clobber) contract:
  //   - GET carries an explicit `missing` flag (a missing key is NOT
  //     the same as a transient failure) plus the row's `updated_at`.
  //   - PUT honors an optional `base_updated_at` compare-and-swap:
  //     absent = LWW (old clients); null = "row must not exist";
  //     number = must equal the row's current updated_at, else 409
  //     with the current {value, updated_at}.
  //   - `prefsReadOutage` fails per-key GETs with 503 while leaving
  //     PUTs working — the exact incident shape (flaky cellular read,
  //     adoption write then lands). setPrefsReadOutage() flips it.
  const userSettingsByKey = new Map();
  const userSettingsMeta = new Map(); // key → updated_at (CAS token)
  let prefsReadOutage = false;
  let prefsClock = 1_000; // deterministic, strictly-increasing updated_at
  const stampUserSetting = (key, value) => {
    prefsClock += 1;
    userSettingsByKey.set(key, value);
    userSettingsMeta.set(key, prefsClock);
    return prefsClock;
  };
  await page.route(/.*\/api\/parley\/prefs\/[^/]+$/, async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/prefs\/([^/]+)$/);
    const key = m ? decodeURIComponent(m[1]) : '';
    if (method === 'GET') {
      if (prefsReadOutage) {
        await route.fulfill({
          status: 503, contentType: 'application/json',
          body: '{"error":"upstream_unavailable"}',
        });
        return;
      }
      const missing = !userSettingsByKey.has(key);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          key,
          value: missing ? null : userSettingsByKey.get(key),
          missing,
          updated_at: missing ? null : userSettingsMeta.get(key),
        }),
      });
      return;
    }
    if (method === 'PUT') {
      let body; try { body = JSON.parse(route.request().postData() || '{}'); }
      catch { body = {}; }
      if (body && typeof body === 'object'
          && Object.prototype.hasOwnProperty.call(body, 'base_updated_at')) {
        const current = userSettingsMeta.has(key) ? userSettingsMeta.get(key) : null;
        if (body.base_updated_at !== current) {
          await route.fulfill({
            status: 409, contentType: 'application/json',
            body: JSON.stringify({
              error: 'conflict', key,
              value: userSettingsByKey.has(key) ? userSettingsByKey.get(key) : null,
              updated_at: current,
            }),
          });
          return;
        }
      }
      const ts = stampUserSetting(key, body?.value ?? null);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, key, value: userSettingsByKey.get(key), updated_at: ts }),
      });
      return;
    }
    return route.fallback();
  });

  // Bare list: GET /api/parley/prefs → {settings:{key:value,…}} for every
  // key the PWA has written this session. settings.ts load() reads this first
  // (DB-as-source-of-truth) and only seeds-forward from /config for keys it
  // doesn't find here. Disjoint from the per-key regex above (no trailing
  // /<key> segment). The Map is fresh-empty per scenario, so absent a seed
  // the PWA naturally backfills synced values from the real-server YAML.
  await page.route(/.*\/api\/parley\/prefs(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        settings: Object.fromEntries(userSettingsByKey),
        updated_at: Object.fromEntries(userSettingsMeta),
      }),
    });
  });

  // ── Server-driven Activity state (SSOT after the right-drawer tray) ──
  const activityById = new Map();
  const normalizeActivity = (item) => ({
    id: item.id,
    chatId: item.chatId ?? item.chat_id ?? null,
    kind: item.kind || 'notification',
    title: item.title || 'Notification',
    body: item.body || '',
    createdAt: item.createdAt ?? item.created_at ?? (Date.now() / 1000),
    urgent: item.urgent === true,
    read: item.read === true,
    messageId: item.messageId ?? item.message_id ?? null,
    resolved: item.resolved ?? null,
  });
  await page.route(/.*\/api\/parley\/activity(\?.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      const out = Array.from(activityById.values()).sort((a, b) => {
        const au = a.kind === 'approval' && !a.resolved ? 1 : 0;
        const bu = b.kind === 'approval' && !b.resolved ? 1 : 0;
        if (au !== bu) return bu - au;
        return b.createdAt - a.createdAt;
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: out }) });
      return;
    }
    if (method === 'POST') {
      let body; try { body = JSON.parse(route.request().postData() || '{}'); }
      catch { body = {}; }
      if (body?.id) activityById.set(body.id, normalizeActivity(body));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    return route.fallback();
  });
  await page.route(/.*\/api\/parley\/activity\/resolve$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body; try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    const item = body?.id ? activityById.get(body.id) : null;
    if (item) activityById.set(body.id, { ...item, read: true, resolved: body.resolution || 'dismissed' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route(/.*\/api\/parley\/activity\/seen$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body; try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    const chatId = body?.chat_id ?? body?.chatId ?? null;
    for (const [id, item] of Array.from(activityById.entries())) {
      if (body?.all === true || (chatId && item.chatId === chatId)) {
        activityById.set(id, { ...item, read: true });
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route(/.*\/api\/parley\/activity\/clear$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    for (const [id, item] of Array.from(activityById.entries())) {
      if (item.kind === 'approval' && !item.resolved) continue;
      activityById.delete(id);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route(/.*\/api\/parley\/activity\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const removed = activityById.delete(id);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, removed }) });
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
        source: opts.source || 'parley',
        title: opts.title ?? 'Mock chat',
        messages: opts.messages || [],
        lastActiveAt: opts.lastActiveAt || Date.now(),
        // Space-joined raw hermes session ids (mirrors the plugin's
        // session_ids metadata) — session-id filter tests set this.
        sessionIds: opts.sessionIds || '',
      });
    },
    /** Push a reply envelope as if the agent generated it. The active
     *  stream subscriber will receive it on its next reconnect.
     *  `messageId` lets the test pin a stable id — useful for
     *  cross-path dedup tests where history's `id` must match the
     *  envelope's `message_id`. Defaults to a fresh synthetic id. */
    /** Stream a reply as N cumulative reply_delta envelopes at
     *  `intervalMs` cadence, then reply_final — mirrors real hermes
     *  streaming (deltas carry cumulativeText, edit:true upstream).
     *  Returns a promise that resolves after reply_final. */
    async streamReply(chatId, fullText, { chunks = 8, intervalMs = 150, messageId } = {}) {
      const id = messageId || `mock-msg-${envelopeId + 1}`;
      const step = Math.ceil(fullText.length / chunks);
      for (let i = 1; i <= chunks; i++) {
        broadcast({
          type: 'reply_delta', chat_id: chatId,
          text: fullText.slice(0, Math.min(i * step, fullText.length)),
          message_id: id,
        });
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      broadcast({ type: 'reply_final', chat_id: chatId, message_id: id });
      const chat = chats.get(chatId);
      if (chat) {
        chat.messages.push({
          role: 'assistant', content: fullText, message_id: id,
          parley_id: id, timestamp: Date.now() / 1000,
        });
      }
      return id;
    },
    pushReply(chatId, text, messageId) {
      const id = messageId || `mock-msg-${envelopeId + 1}`;
      broadcast({ type: 'reply_delta', chat_id: chatId, text, message_id: id });
      broadcast({ type: 'reply_final', chat_id: chatId, message_id: id });
      // Persist to chat.messages so the next /messages fetch includes
      // the reply — mirrors real hermes' post-turn append_to_transcript
      // which writes assistant messages to state.db after reply_final.
      // Without this, a test that switches away after pushReply and
      // back again finds the reply gone from the cache + server,
      // looking like the PWA dropped it (false-positive vs the real
      // behavior where the reply IS persisted by then).
      const chat = chats.get(chatId);
      if (chat) {
        chat.messages.push({
          role: 'assistant',
          content: text,
          message_id: id,
          parley_id: id,
          timestamp: Date.now() / 1000,
        });
        chat.lastActiveAt = Date.now();
      }
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
    /** Generic escape hatch — broadcast an arbitrary envelope onto the
     *  SSE channel. Smokes that need to exercise envelope shapes the
     *  built-in helpers don't cover (tool_call, tool_result, custom
     *  notification kinds) call this directly. The envelope must
     *  include a `type` field; `chat_id` is also required by the PWA's
     *  router.
     *
     *  Side effect: `notification` and `reply_final` envelopes also
     *  bump the per-chat unread counter (mirrors the plugin's
     *  responses-handler write into `unread_state` when an assistant
     *  row lands). The PWA reads this state via the
     *  /api/parley/notifications/unread route mocked above. */
    pushEnvelope(env) {
      if (env && (env.type === 'notification' || env.type === 'reply_final')) {
        bumpUnread(env.chat_id);
      }
      // Tool-row durability (opt-in): mirror hermes persisting the
      // turn's tool activity so the post-final durable refresh carries
      // it (see persistToolRows comment). Append BEFORE broadcasting so
      // a subsequent /messages fetch is coherent.
      if (persistToolRows && env && (env.type === 'tool_call' || env.type === 'tool_result') && env.chat_id) {
        const chat = chats.get(env.chat_id);
        if (chat) {
          const baseTs = Date.now() / 1000 + (toolPersistSeq++) * 0.001;
          if (env.type === 'tool_call') {
            chat.messages.push({
              role: 'assistant', content: '',
              tool_calls: JSON.stringify([{
                id: env.call_id, call_id: env.call_id, type: 'function',
                function: { name: env.tool_name, arguments: JSON.stringify(env.args || {}) },
              }]),
              timestamp: baseTs,
            });
          } else {
            chat.messages.push({
              role: 'tool',
              content: typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? { ok: true }),
              tool_call_id: env.call_id,
              timestamp: baseTs,
            });
          }
        }
      }
      broadcast(env);
      // Mirror what the real plugin does on a DELETE: remove from
      // server-side state so subsequent /sessions list fetches don't
      // bring the row back. Tests that simulate a "remote delete" can
      // just push the envelope; the mock keeps state coherent.
      if (env && env.type === 'conversation_deleted' && env.chat_id) {
        chats.delete(env.chat_id);
        clearUnreadFor(env.chat_id);
      }
    },
    /** Simulate an SSE disconnect + network outage (see the streamOutage
     *  block comment above for the exact per-endpoint behavior). While
     *  on, the PWA's isConnected() goes false — the state whose gates
     *  the offline-first smokes exercise. Turn off, then dispatch a
     *  window 'online' event in-page to reconnect (the CLOSED
     *  EventSource never retries on its own). */
    setStreamOutage(on) {
      streamOutage = !!on;
      if (streamOutage) {
        // Kill live subscribers so the drop is immediate: the client's
        // EventSource sees the stream die, retries (retry: 200), hits
        // the 503 above, and hard-fails → connected=false within ms.
        for (const sub of streamSubs) { try { sub.end(); } catch {} }
        streamSubs.clear();
        for (const sock of openSockets) { try { sock.destroy(); } catch {} }
      }
    },
    /** Meeting capture: flip the mocked segment endpoint into a 503
     *  outage (and back) — exercises the client uploader's durable
     *  retry path. `getCaptures()` exposes the mock's manifests for
     *  assertions (segment acks, marks, stop state). */
    setCaptureOutage(on) { captureOutage = !!on; },
    getCaptures() { return Array.from(captures.values()); },
    /** Force a capture into a terminal state SERVER-SIDE without the
     *  client doing it — models the stale-heal sweep failing a recording
     *  the client still believes in (incident 2026-08-27). */
    setCaptureStatus(id, status, extra = {}) {
      const cap = captures.get(id);
      if (!cap) throw new Error(`mock: unknown capture ${id}`);
      cap.status = status;
      Object.assign(cap, extra);
      return { ...cap };
    },
    /** Lifecycle calls in arrival order ({action, id, body?}) — lets
     *  smokes assert e.g. "DELETE was never called" (postmortem
     *  regression: startup failure must abort-start, not delete). */
    getCaptureLifecycle() { return captureLifecycle.slice(); },
    /** Pre-seed a (finished) capture linked to a chat — feeds the
     *  drawer's has-recording filter + row badges via the GET list
     *  above. Call from MOCK_SETUP so the boot-time meetingsIndex
     *  fetch sees it. */
    addCapture(chatId, opts = {}) {
      const id = opts.id || `cap_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      captures.set(id, {
        id,
        title: opts.title || `Meeting ${new Date().toISOString().slice(0, 10)}`,
        linked_chat: chatId || null,
        diarize: false,
        status: opts.status || 'complete',
        started_at: opts.startedAt || Date.now() - 60_000,
        ended_at: opts.endedAt ?? Date.now() - 30_000,
        marks: [],
        speakers: {},
        segments: opts.segments || [{ seq: 0, bytes: 1024 }],
        // Served by the mocked GET /captures/{id}/transcript (stale-doc
        // reconcile). Omit for "no transcript ever landed" → 404 there.
        ...(typeof opts.transcript === 'string' ? { transcript: opts.transcript } : {}),
        // Seeding a TOMBSTONE (status:'discarded') carries the discard
        // bookkeeping a real /discard writes: discarded_at drives the
        // Recently-Deleted UI's "Deleted 2h ago", pre_discard_status is
        // the /restore target hint. Without these a seeded tombstone
        // would restore to a shape no real capture can reach.
        ...(opts.status === 'discarded' ? {
          discarded_at: opts.discardedAt ?? Date.now() - 3_600_000,
          pre_discard_status: opts.preDiscardStatus || 'complete',
        } : {}),
      });
      return id;
    },
    /** Test escape hatch: set raw unread state. Use this when a test
     *  needs to simulate the plugin having pre-existing unread (e.g.
     *  cross-device scenarios where another device left mark-unread). */
    setUnread(chatId, count) {
      if (count > 0) unreadByChat.set(chatId, count);
      else unreadByChat.delete(chatId);
    },
    setMarkedUnread(chatId, marked) {
      if (marked) markedUnread.add(chatId);
      else markedUnread.delete(chatId);
    },
    clearUnread(chatId) { clearUnreadFor(chatId); },
    getUnreadState() {
      return { byChat: new Map(unreadByChat), marked: new Set(markedUnread) };
    },
    /** Hold GET /notifications/unread responses open for `ms`,
     *  snapshot-then-deliver (see unreadDelayMs above) — stages the
     *  stale-refresh-vs-optimistic-mutation race deterministically.
     *  In-flight holds keep the delay they captured at request time;
     *  pass 0 to make subsequent GETs instant. */
    setUnreadDelay(ms) {
      unreadDelayMs = typeof ms === 'number' && ms > 0 ? ms : 0;
    },
    /** Test escape hatch: seed a pin directly in the mock's server-
     *  side store. Use this when a test wants to verify cross-device
     *  hydration (pre-existing pins from another device) without
     *  going through the PWA's POST path. */
    seedPin(chatId, msgId, opts = {}) {
      pinsByKey.set(pkey(chatId, msgId), {
        chatId, msgId,
        role: opts.role || 'user',
        text: opts.text || '',
        timestamp: opts.timestamp || Date.now(),
        pinnedAt: opts.pinnedAt || Date.now(),
      });
    },
    getPinState() { return new Map(pinsByKey); },
    /** Test escape hatch: seed a synced user setting directly in the
     *  mock's server store (simulates a value saved on another device).
     *  Use for cross-device sync scenarios like STT key-terms. Stamps
     *  an updated_at like a real write so CAS-aware clients get a
     *  coherent base. */
    seedUserSetting(key, value) { stampUserSetting(key, value); },
    getUserSetting(key) {
      return userSettingsByKey.has(key) ? userSettingsByKey.get(key) : null;
    },
    /** Fail per-key GET /api/parley/prefs/<key> with 503 while on;
     *  PUTs keep working. This is the 2026-07-31 incident's network
     *  shape (flaky cellular: the read times out, the write that a
     *  buggy client fires right after still lands). The bare-list GET
     *  stays up so settings boot is unaffected. */
    setPrefsReadOutage(on) { prefsReadOutage = !!on; },
    getUserSettingsState() { return new Map(userSettingsByKey); },
    seedActivity(item) {
      if (item?.id) activityById.set(item.id, normalizeActivity(item));
    },
    activityItems() {
      return Array.from(activityById.values());
    },
    /** Set the inflight envelope list for a chat. The next
     *  /api/parley/sessions/<chatId>/messages GET will include
     *  these as the `inflight` field, mirroring the real proxy's
     *  in-memory inflight cache. Pass `null` or an empty array to
     *  clear. Tests use this to simulate the "switch-back during
     *  in-flight turn" scenario without needing the real proxy.
     */
    setInflight(chatId, envelopes) {
      if (!envelopes || envelopes.length === 0) {
        inflightByChat.delete(chatId);
      } else {
        inflightByChat.set(chatId, envelopes);
      }
    },
    /** Suppress the auto-reply on POST /messages. Tests that drive
     *  envelopes by hand (label-transition state machines, manual
     *  reply timing) call setAutoReplyEnabled(false). The
     *  user_message broadcast still fires (cross-device dedup
     *  expects it); the typing + reply envelopes do not. */
    setAutoReplyEnabled(enabled) {
      autoReplyEnabled = !!enabled;
    },
    /** Suppress the user_message envelope echo on POST. Use when a
     *  test needs to prove the PWA renders the user bubble via its
     *  own optimistic upsert path, without an envelope arriving from
     *  the server to mask the failure. Has no effect when
     *  autoReplyEnabled is true (that path doesn't gate on the flag
     *  — it always emits the full envelope sequence). */
    setSuppressUserMessageBroadcast(enabled) {
      suppressUserMessageBroadcast = !!enabled;
    },
    /** Toggle the in-flight persistence semantics. Default `false`
     *  (legacy: chats are visible in /sessions immediately on POST).
     *  Set `true` for tests that need to mirror real hermes behavior
     *  where first_user_message is absent until reply_final lands. */
    setPostTurnPersistence(enabled) {
      postTurnPersistence = !!enabled;
    },
    /** Opt into durable tool-row persistence (see persistToolRows). */
    setPersistToolRows(enabled) {
      persistToolRows = !!enabled;
    },
    /** Cap the FIRST /messages page to at most N messages (default
     *  unlimited). Used by load-earlier-history.mjs to force pagination
     *  in a small fixture without seeding 200+ messages. The cap only
     *  applies to requests without a `?before=` cursor — older pages
     *  use whatever limit the PWA's loadEarlier path sends. Pass null
     *  to clear. */
    setHistoryFirstPageLimit(n) {
      historyFirstPageLimit = typeof n === 'number' && n > 0 ? n : null;
    },
    setMessageDelay(chatId, ms) {
      if (!chatId) return;
      if (typeof ms === 'number' && ms > 0) messageDelays.set(chatId, ms);
      else messageDelays.delete(chatId);
    },
    setSessionsFailure(status = 503) {
      sessionsFailStatus = status > 0 ? status : 0;
    },
    /** Hold the /sessions LIST response open for `ms` — simulates the
     *  slow-list window where a single-flight refresh is in flight and
     *  drawer paints must NOT wait for it. */
    setSessionsDelay(ms) {
      sessionsDelayMs = typeof ms === 'number' && ms > 0 ? ms : 0;
    },
    /** Hold the SSE open-handshake for `ms` — simulates the slow/retrying
     *  radio that delays onStatus(connected) and therefore the whole boot
     *  landing, while the drawer is already painted and tappable. */
    setStreamConnectDelay(ms) {
      streamConnectDelayMs = typeof ms === 'number' && ms > 0 ? ms : 0;
    },
    setMessageFailure(chatId, status = 503) {
      if (!chatId) return;
      if (status > 0) messageFailStatus.set(chatId, status);
      else messageFailStatus.delete(chatId);
    },
    /** Configure the /v1/settings/schema response. Pass null to
     *  declare the agent doesn't implement the extension (route
     *  returns 404). The handler also recognizes POST /settings/{id}
     *  with an enum-validation pass; getLastSettingsPost() returns
     *  what the PWA most recently sent. */
    /** Health checks served at /api/parley/health (null = 404). */
    setHealth(list) { health = list; lastHealthRun = null; },
    getLastHealthRun() { return lastHealthRun; },
    /** Scheduled jobs served at /api/parley/jobs (null = 404). */
    setJobs(list) { jobs = list; lastJobPost = null; },
    getLastJobPost() { return lastJobPost; },
    setSettingsSchema(schema) {
      settingsSchema = schema;
      lastSettingsPost = null;
    },
    getLastSettingsPost() { return lastSettingsPost; },
    /** Configure /api/parley/commands. Pass null to declare the
     *  agent doesn't implement the extension (route returns 404).
     *  Each entry is a CommandDef from
     *  proxy/parley/upstream.ts — { name, description, category,
     *  aliases, args_hint, subcommands }. */
    setCommandsCatalog(catalog) { commandsCatalog = catalog; },

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
