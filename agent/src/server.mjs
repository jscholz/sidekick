// Stub-agent HTTP server.
//
// Implements the sidekick Abstract Agent Protocol (a strict subset of
// the OpenAI Responses API). One endpoint:
//
//   POST /v1/responses
//
// Plus a tiny `GET /healthz` that returns `{ok: true, llm: <name>}`
// for readiness probes.
//
// Streaming behavior follows docs/ABSTRACT_AGENT_PROTOCOL.md:
//   - response.output_text.delta on each chunk
//   - response.completed once at end-of-stream with the full envelope
//
// Non-streaming requests return a single JSON object with the same
// `output` shape. Sidekick's openclaw backend client always sends
// `stream: true`, so that's the primary path.
//
// What we DO NOT implement (intentional simplicity):
//   - tool / function calls
//   - attachments (we 400 if any are sent)
//   - response.created / in_progress / output_text.done events
//     (the spec marks them optional; sidekick handles their absence)
//   - response listing / retrieval by id
//   - multi-tenant auth (single-token Bearer is supported, no user db)

import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {import('./conversations.mjs').Conversations} Conversations
 * @typedef {import('./llm/index.mjs').LLM} LLM
 */

/**
 * @param {{
 *   conversations: Conversations,
 *   llm: LLM,
 *   bearerToken?: string,
 * }} opts
 */
export function createServer({ conversations, llm, bearerToken }) {
  /** Out-of-turn event channel state. Stub agent rarely emits these
   *  (no cron, no proactive replies), but the contract requires the
   *  endpoint so proxies can subscribe. We keep a bounded ring +
   *  per-subscriber queues mirroring the hermes-plugin pattern. */
  const eventSubscribers = new Set();
  let eventIdCounter = 0;
  const eventReplayRing = [];
  const EVENT_REPLAY_CAP = 256;

  /** Push an envelope to the out-of-turn channel. Public so future
   *  hooks (cron, push reminders) can publish. Today: unused — the
   *  stub doesn't emit notifications. */
  function publishEvent(env) {
    eventIdCounter++;
    const eid = eventIdCounter;
    eventReplayRing.push({ id: eid, env });
    if (eventReplayRing.length > EVENT_REPLAY_CAP) eventReplayRing.shift();
    for (const q of eventSubscribers) {
      try { q.push({ id: eid, env }); } catch {}
    }
  }

  /** Bearer-token check for any auth-gated endpoint. Returns true if
   *  no token is configured (open-mode default for first-clone demos). */
  function checkAuth(req) {
    if (!bearerToken) return true;
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return got === bearerToken;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Both /health and /healthz are common conventions; accept both
      // so existing UpstreamAgent clients (which probe /health to match
      // the hermes-plugin) work unchanged.
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
        return json(res, 200, { status: 'ok', llm: llm.name });
      }
      // Conversation surface — drawer / replay / delete.
      const url = new URL(req.url || '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/v1/conversations') {
        if (!checkAuth(req)) return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
        const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
        return json(res, 200, { object: 'list', data: conversations.list(limit) });
      }
      const itemsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/items$/);
      if (req.method === 'GET' && itemsMatch) {
        if (!checkAuth(req)) return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
        const id = decodeURIComponent(itemsMatch[1]);
        const limitRaw = url.searchParams.get('limit');
        const beforeRaw = url.searchParams.get('before');
        const opts = {};
        if (limitRaw != null) {
          const n = Number.parseInt(limitRaw, 10);
          if (Number.isFinite(n)) opts.limit = n;
        }
        if (beforeRaw != null) {
          const n = Number.parseInt(beforeRaw, 10);
          if (Number.isFinite(n)) opts.before = n;
        }
        const result = conversations.items(id, opts);
        if (result == null) return json(res, 404, errorBody('invalid_request_error', 'conversation not found'));
        return json(res, 200, { object: 'list', ...result });
      }
      const deleteMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        if (!checkAuth(req)) return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
        const id = decodeURIComponent(deleteMatch[1]);
        const had = conversations.delete(id);
        if (!had) return json(res, 404, errorBody('invalid_request_error', 'conversation not found'));
        return json(res, 200, { ok: true });
      }
      // Out-of-turn SSE channel. Stub rarely emits but the contract
      // requires the endpoint so proxies can subscribe + reconnect.
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        if (!checkAuth(req)) return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
        return handleEvents(req, res, eventSubscribers, eventReplayRing);
      }
      // Optional settings extension — see
      // docs/ABSTRACT_AGENT_PROTOCOL.md "Optional settings extension".
      // The stub declares its current LLM as a 1-option enum. That's
      // enough to exercise the schema-renderer end-to-end (verifying
      // the model dropdown wires up) without giving the user a knob
      // that does nothing — POST validates against the single option,
      // so the value can only round-trip back to the same name.
      // Forks adding more knobs (persona, temperature, ...) extend the
      // returned array; nothing else needs to change.
      if (req.method === 'GET' && url.pathname === '/v1/settings/schema') {
        if (!checkAuth(req)) return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
        return json(res, 200, { object: 'list', data: settingsSchema(llm) });
      }
      const settingsPostMatch = url.pathname.match(/^\/v1\/settings\/([^/]+)$/);
      if (req.method === 'POST' && settingsPostMatch) {
        if (!checkAuth(req)) return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
        const id = decodeURIComponent(settingsPostMatch[1]);
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); }
        catch { return json(res, 400, errorBody('invalid_request_error', 'body is not valid JSON')); }
        return handleSettingsUpdate(res, llm, id, body?.value);
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        if (bearerToken) {
          const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          if (got !== bearerToken) {
            return json(res, 401, errorBody('authentication_error', 'invalid bearer token'));
          }
        }
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); }
        catch { return json(res, 400, errorBody('invalid_request_error', 'body is not valid JSON')); }

        if (Array.isArray(body.attachments) && body.attachments.length > 0) {
          return json(
            res,
            400,
            errorBody(
              'invalid_request_error',
              'this stub agent does not support attachments. drop them or wire up a different agent.',
            ),
          );
        }
        if (body.conversation && body.previous_response_id) {
          return json(
            res,
            400,
            errorBody(
              'invalid_request_error',
              '`conversation` and `previous_response_id` are mutually exclusive',
            ),
          );
        }
        const userText = coerceInput(body.input);
        if (userText == null) {
          return json(
            res,
            400,
            errorBody('invalid_request_error', '`input` is required (string or array of {role, content})'),
          );
        }
        const conversationId = body.conversation
          ? String(body.conversation)
          : body.previous_response_id
            ? `prev:${body.previous_response_id}`
            : `anon:${randomHex(8)}`;

        const history = conversations.history(conversationId).slice();
        history.push({ role: 'user', content: userText, timestamp: Date.now() / 1000 });

        if (body.stream === true) {
          await handleStream(res, { llm, history, conversationId, conversations });
        } else {
          await handleNonStream(res, { llm, history, conversationId, conversations });
        }
        return;
      }

      // Anything else.
      return json(res, 404, errorBody('invalid_request_error', `unknown endpoint: ${req.method} ${req.url}`));
    } catch (e) {
      console.error('[stub-agent] unhandled error', e);
      try { json(res, 500, errorBody('server_error', e?.message ?? 'unhandled error')); }
      catch { /* response may already be flushed */ }
    }
  });
  return server;
}

/**
 * Persistent SSE for out-of-turn envelopes. Caller-owned subscriber
 * queue lifecycle: registered on connect, drained as events arrive,
 * removed on disconnect.
 *
 * Uses a tiny push-based async iterator so the handler can await new
 * events without polling. Last-Event-ID support replays from the ring
 * (events with id > cursor) before resuming live.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Set<{push: (ev: any) => void; end: () => void}>} subscribers
 * @param {Array<{id: number; env: any}>} replayRing
 */
function handleEvents(req, res, subscribers, replayRing) {
  const lastEventIdRaw = req.headers['last-event-id'];
  const cursor = (typeof lastEventIdRaw === 'string')
    ? Number.parseInt(lastEventIdRaw, 10)
    : NaN;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    'connection': 'keep-alive',
  });
  res.write('retry: 1000\n\n');

  // Replay ring entries newer than cursor.
  for (const { id, env } of replayRing) {
    if (Number.isFinite(cursor) && id <= cursor) continue;
    res.write(`id: ${id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`);
  }

  // Live subscriber: a tiny push-handle that the publish path calls.
  const queue = [];
  let waiter = null;
  const subscriber = {
    push(ev) {
      queue.push(ev);
      if (waiter) { waiter(); waiter = null; }
    },
    end() {
      queue.push(null);
      if (waiter) { waiter(); waiter = null; }
    },
  };
  subscribers.add(subscriber);

  const drop = () => {
    subscribers.delete(subscriber);
    subscriber.end();
    try { res.end(); } catch {}
  };
  req.on('close', drop);
  res.on('close', drop);

  (async () => {
    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev == null) return; // end-of-stream sentinel
        try {
          res.write(`id: ${ev.id}\nevent: ${ev.env.type}\ndata: ${JSON.stringify(ev.env)}\n\n`);
        } catch {
          return;
        }
      }
      await new Promise((resolve) => { waiter = resolve; });
    }
  })().catch((e) => console.warn('[stub-agent] /v1/events writer error:', e?.message));
}

/**
 * @param {http.ServerResponse} res
 * @param {{
 *   llm: LLM,
 *   history: Array<{role: string, content: string, timestamp?: number}>,
 *   conversationId: string,
 *   conversations: Conversations,
 * }} ctx
 */
async function handleStream(res, { llm, history, conversationId, conversations }) {
  const responseId = `resp_${randomHex(24)}`;
  const messageId = `msg_${randomHex(20)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    'connection': 'keep-alive',
  });

  const writeFrame = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let outputIndex = 0;
  let contentIndex = 0;
  let assembled = '';
  try {
    for await (const delta of llm.stream(history)) {
      if (typeof delta !== 'string' || delta.length === 0) continue;
      assembled += delta;
      writeFrame('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: messageId,
        output_index: outputIndex,
        content_index: contentIndex,
        delta,
      });
    }
  } catch (e) {
    const msg = `[${llm.name} error] ${e?.message ?? e}`;
    assembled += msg;
    writeFrame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: messageId,
      output_index: outputIndex,
      content_index: contentIndex,
      delta: msg,
    });
  }

  // Persist the assembled reply BEFORE emitting `response.completed`
  // so a client that races to the next turn sees the prior reply in
  // history.
  conversations.append(conversationId, { role: 'user', content: history[history.length - 1].content, timestamp: Date.now() / 1000 });
  conversations.append(conversationId, { role: 'assistant', content: assembled, timestamp: Date.now() / 1000 });

  writeFrame('response.completed', {
    type: 'response.completed',
    response: buildResponseEnvelope({
      id: responseId,
      createdAt,
      model: llm.name,
      messageId,
      assembled,
    }),
  });
  res.end();
}

/**
 * @param {http.ServerResponse} res
 */
async function handleNonStream(res, { llm, history, conversationId, conversations }) {
  const responseId = `resp_${randomHex(24)}`;
  const messageId = `msg_${randomHex(20)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let assembled = '';
  try {
    for await (const delta of llm.stream(history)) {
      if (typeof delta === 'string') assembled += delta;
    }
  } catch (e) {
    assembled += `[${llm.name} error] ${e?.message ?? e}`;
  }
  conversations.append(conversationId, { role: 'user', content: history[history.length - 1].content, timestamp: Date.now() / 1000 });
  conversations.append(conversationId, { role: 'assistant', content: assembled, timestamp: Date.now() / 1000 });
  json(res, 200, buildResponseEnvelope({
    id: responseId,
    createdAt,
    model: llm.name,
    messageId,
    assembled,
  }));
}

/** Settings the stub agent declares. One entry: a read-locked
 *  "model" enum reflecting the configured LLM. Listed as an enum
 *  with a single option so the PWA's generic dropdown renders
 *  correctly, and POST validates against `llm.name`. Forks add
 *  more entries here.
 *
 * @param {LLM} llm
 */
function settingsSchema(llm) {
  return [
    {
      id: 'model',
      label: 'Model',
      description: 'LLM the stub is wired to (set via AGENT_LLM env at boot)',
      category: 'Agent',
      type: 'enum',
      value: llm.name,
      options: [{ value: llm.name, label: llm.name }],
    },
  ];
}

/**
 * @param {http.ServerResponse} res
 * @param {LLM} llm
 * @param {string} id
 * @param {unknown} value
 */
function handleSettingsUpdate(res, llm, id, value) {
  const def = settingsSchema(llm).find((s) => s.id === id);
  if (!def) return json(res, 404, errorBody('invalid_request_error', `unknown setting: ${id}`));
  if (def.type === 'enum') {
    const ok = (def.options ?? []).some((o) => o.value === value);
    if (!ok) {
      return json(
        res,
        400,
        errorBody(
          'invalid_request_error',
          `value not in options[]: ${JSON.stringify(value)}`,
        ),
      );
    }
  }
  // No-op success: stub LLM is fixed at boot. Returning the def
  // matches the contract's "return updated SettingDef" rule.
  return json(res, 200, def);
}

function buildResponseEnvelope({ id, createdAt, model, messageId, assembled }) {
  return {
    id,
    object: 'response',
    status: 'completed',
    created_at: createdAt,
    model,
    output: [
      {
        type: 'message',
        id: messageId,
        role: 'assistant',
        content: [{ type: 'output_text', text: assembled }],
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Accepts either a plain string or the array-of-{role,content} form
 * from the OpenAI Responses API. Returns the user's text or null if
 * the shape is unrecognized.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
function coerceInput(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    // Concatenate all content fields from user-role messages — the
    // sidekick PWA only sends string input today, so this is a
    // best-effort branch for direct-API callers.
    const parts = [];
    for (const m of input) {
      if (!m || typeof m !== 'object') continue;
      const role = /** @type {any} */ (m).role;
      const content = /** @type {any} */ (m).content;
      if (role !== 'user' && role !== 'system') continue;
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
    }
    if (parts.length === 0) return null;
    return parts.join('\n\n');
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorBody(type, message, code) {
  return { error: { type, message, ...(code ? { code } : {}) } };
}

function randomHex(n) {
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}
