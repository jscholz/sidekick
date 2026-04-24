/**
 * Hermes backend plugin — opt-in server routes for the Hermes Agent backend.
 *
 * Exports a single `mountHermesRoutes(req, res)` function. On each incoming
 * request, check `/api/hermes/*` paths; handle matching ones and return
 * `true`, otherwise return `false` so the main router continues routing.
 *
 * If your fork targets a different agent, delete this file and the
 * `mountHermesRoutes` import + call from `server.ts` — nothing else
 * depends on it.
 *
 * Provides:
 *   - GET  /api/hermes/sessions                     → list sessions (direct sqlite read)
 *   - GET  /api/hermes/sessions/:name/messages      → message transcript for a session
 *   - POST /api/hermes/sessions/:name/rename        → rename via `hermes sessions rename`
 *   - DELETE /api/hermes/sessions/:name             → delete via `hermes sessions delete`
 *   - GET  /api/hermes/model                        → current model ref
 *   - POST /api/hermes/model                        → set model ref + restart gateway
 *   - GET  /api/hermes/models-catalog               → openrouter catalog (proxied, cached)
 *   - /api/hermes/*                                  → pass-through to Hermes upstream (/v1/*)
 */

import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const execFileP = promisify(execFile);

// ── Hermes API proxy config ────────────────────────────────────────────────
// Sidekick-facing shim for Hermes's OpenAI-compatible API server. Keeps the
// upstream loopback-bound and injects the bearer token server-side so the
// browser never handles it. Pipes responses (including SSE for
// /responses) straight through without buffering — SSE breaks if buffered.
const HERMES_UPSTREAM = process.env.SIDEKICK_HERMES_URL || 'http://127.0.0.1:8642';
const HERMES_TOKEN = process.env.SIDEKICK_HERMES_TOKEN || '';

// ─── Hermes session browser (direct sqlite read of response_store.db) ────────
// Hermes chains conversation turns server-side via previous_response_id,
// keyed by a `conversation:` name we send on each /v1/responses POST. The
// response_store.db holds (a) a conversations table mapping name → latest
// response_id, and (b) a responses table whose JSON payload includes the
// full conversation_history. We read both directly — fast, stable, no
// dependency on the auth-gated dashboard API.
const HERMES_STORE_DB = process.env.SIDEKICK_HERMES_STORE_DB
  || `${process.env.HOME || ''}/.hermes/response_store.db`;
const HERMES_STATE_DB = process.env.SIDEKICK_HERMES_STATE_DB
  || `${process.env.HOME || ''}/.hermes/state.db`;
const HERMES_CLI = process.env.SIDEKICK_HERMES_CLI
  || `${process.env.HOME || ''}/.local/bin/hermes`;
// Filter so random test names / non-sidekick conversations don't clutter the UI.
// The hermes adapter generates names as 'sidekick-main' or 'sidekick-<timestamp>'.
const HERMES_SESSION_PREFIX = process.env.SIDEKICK_HERMES_SESSION_PREFIX || 'sidekick-';

async function sqlQuery(db: string, sql: string): Promise<any[]> {
  const { stdout } = await execFileP('sqlite3', ['-json', db, sql], {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout);
}

async function handleHermesSessionsList(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '', 'http://x');
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  // Strict prefix sanitization — value is used in string-concatenated SQL.
  const prefix = HERMES_SESSION_PREFIX.replace(/[^a-zA-Z0-9_\-]/g, '');
  // ATTACH state.db so we can pull title from its sessions table alongside
  // the conversation + response data in response_store.db. Titles get set
  // via `hermes sessions rename` (see rename route below) and stored on
  // state.db/sessions.title keyed by derived session UUID.
  const sql = `
    ATTACH '${HERMES_STATE_DB.replace(/'/g, "''")}' AS s;
    SELECT c.name AS id, r.accessed_at AS lastMessageAt,
      json_array_length(json_extract(r.data, '$.conversation_history')) AS messageCount,
      substr(json_extract(r.data, '$.conversation_history[#-1].content'), 1, 120) AS snippet,
      s.sessions.title AS title
    FROM conversations c
    LEFT JOIN responses r ON r.response_id = c.response_id
    LEFT JOIN s.sessions ON s.sessions.id = json_extract(r.data, '$.session_id')
    WHERE c.name LIKE '${prefix}%'
    ORDER BY r.accessed_at DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await sqlQuery(HERMES_STORE_DB, sql);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: rows }));
  } catch (e: any) {
    console.error('hermes sessions list failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/** Map a conversation name to the derived session UUID (stored inside
 *  responses.data.session_id). Needed because `hermes sessions rename /
 *  delete` take the UUID, not the conversation name. Returns null if the
 *  conversation or its response row can't be found. */
async function lookupSessionUuid(name: string): Promise<string | null> {
  const sql = `SELECT json_extract(r.data, '$.session_id') AS uuid
    FROM conversations c
    LEFT JOIN responses r ON r.response_id = c.response_id
    WHERE c.name='${name}'`;
  const rows = await sqlQuery(HERMES_STORE_DB, sql);
  return rows[0]?.uuid || null;
}

async function handleHermesSessionRename(req: IncomingMessage, res: ServerResponse, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let payload: any;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end('invalid json'); return; }
    const title = (payload?.title || '').toString().trim();
    if (!title || title.length > 200) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'title required (<=200 chars)' }));
      return;
    }
    try {
      const uuid = await lookupSessionUuid(name);
      if (!uuid) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      // `hermes sessions rename <session_id> <title...>` — CLI takes title
      // as positional args (joined by argparse internally).
      await execFileP(HERMES_CLI, ['sessions', 'rename', uuid, title], {
        env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, title }));
    } catch (e: any) {
      console.error('hermes sessions rename failed:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

async function handleHermesSessionDelete(req: IncomingMessage, res: ServerResponse, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  try {
    const uuid = await lookupSessionUuid(name);
    if (!uuid) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    // Step 1: hermes CLI removes the row from state.db/sessions + cascades
    // to its messages table. --yes skips the confirmation prompt.
    await execFileP(HERMES_CLI, ['sessions', 'delete', '--yes', uuid], {
      env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
    });
    // Step 2: hermes's CLI does NOT clean up response_store.db — conversation
    // name + response chain stay orphaned. Our list reads from conversations,
    // so without this cleanup the "deleted" row would still appear in the UI.
    // Remove the conversation entry + any response rows it referenced.
    // Strict name regex above protects against SQL injection here.
    await execFileP('sqlite3', [HERMES_STORE_DB,
      `DELETE FROM responses WHERE response_id IN (SELECT response_id FROM conversations WHERE name='${name}');`,
      `DELETE FROM conversations WHERE name='${name}';`,
    ]);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e: any) {
    console.error('hermes sessions delete failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── Hermes model selector (shells out to `hermes config`) ─────────────────
// POST /api/hermes/model triggers a `hermes config set model <ref>` followed
// by `systemctl --user restart hermes-gateway`. The gateway restart is brief
// (~1-2s) but does drop any in-flight SSE; the sidekick shell picks the
// connection back up via the existing health-check / onStatus flow in
// hermesAdapter.connect/reconnect. GET uses `hermes config show` (there is
// no `hermes config get` subcommand — config show is the supported read path).
// In-memory cache for the openrouter catalog — it's a ~100KB payload that
// rarely changes. Avoid hammering the API on every settings-panel open.
let openrouterCatalogCache: { at: number; entries: any[] } | null = null;
const OPENROUTER_CATALOG_TTL_MS = 10 * 60 * 1000;

async function handleHermesModelsCatalog(req: IncomingMessage, res: ServerResponse) {
  // Hermes's own /v1/models only returns the 'hermes-agent' placeholder —
  // the actual inference catalog is whatever the configured provider
  // exposes. Default deployments use openrouter, so fetch openrouter's
  // catalog directly and return it in the ModelEntry shape the settings
  // picker expects. OPENROUTER_API_KEY is read server-side so the client
  // never sees it; catalog listing doesn't strictly require an API key
  // but providing one gets better availability.
  const now = Date.now();
  if (openrouterCatalogCache && now - openrouterCatalogCache.at < OPENROUTER_CATALOG_TTL_MS) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: openrouterCatalogCache.entries, cached: true }));
    return;
  }
  const key = process.env.OPENROUTER_API_KEY || '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: key ? { 'Authorization': `Bearer ${key}` } : {},
    });
    if (!r.ok) {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `openrouter ${r.status}` }));
      return;
    }
    const d: any = await r.json();
    // Project to the sidekick ModelEntry shape + filter out models we can't
    // actually use (hermes enforces a 64K context minimum at startup).
    const entries = (d.data || [])
      .filter((m: any) => (m.context_length || 0) >= 64000)
      .map((m: any) => ({ id: m.id, name: m.name || m.id }));
    entries.sort((a: any, b: any) => a.name.localeCompare(b.name));
    openrouterCatalogCache = { at: now, entries };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: entries, cached: false }));
  } catch (e: any) {
    console.error('openrouter catalog fetch failed:', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleHermesModelGet(req: IncomingMessage, res: ServerResponse) {
  try {
    const { stdout } = await execFileP(HERMES_CLI, ['config', 'show'], {
      env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
    });
    // Output has a "◆ Model" section containing a "  Model:        <ref>" line.
    // Match the first such line after the Model section heading.
    const m = stdout.match(/◆ Model[\s\S]*?Model:\s*(\S+)/);
    const model = m ? m[1] : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model }));
  } catch (e: any) {
    console.error('hermes config show failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleHermesModelSet(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let payload: any;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end('invalid json'); return; }
    const model = (payload?.model || '').toString().trim();
    // Strict allow-list — value goes into a shelled-out command. Accept only
    // chars that appear in real model refs (vendor/name.variant-size).
    if (!model || model.length > 128 || !/^[a-zA-Z0-9._/\-]+$/.test(model)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid model ref (letters, digits, -, /, ., max 128 chars)' }));
      return;
    }
    try {
      await execFileP(HERMES_CLI, ['config', 'set', 'model', model], {
        env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
      });
      // Restart hermes-gateway so the new model takes effect for subsequent
      // /v1/responses calls. Brief downtime; client reconnects via onStatus.
      await execFileP('systemctl', ['--user', 'restart', 'hermes-gateway']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model }));
    } catch (e: any) {
      console.error('hermes model set failed:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

async function handleHermesSessionMessages(req: IncomingMessage, res: ServerResponse, name: string) {
  // Session names are user-chosen strings; we only accept the chars the
  // adapter actually produces ('sidekick-main', 'sidekick-<base36>').
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  const sql = `SELECT data FROM responses WHERE response_id = (SELECT response_id FROM conversations WHERE name='${name}')`;
  try {
    const rows = await sqlQuery(HERMES_STORE_DB, sql);
    if (rows.length === 0) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    const d = JSON.parse(rows[0].data);
    const history = d.conversation_history || [];
    // Map to SessionMessage shape. `content` can be a string or an array
    // of content parts; stringify non-string shapes so the shell can render.
    const messages = history.map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      toolName: m.name || undefined,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages }));
  } catch (e: any) {
    console.error('hermes session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function handleHermesProxy(req: IncomingMessage, res: ServerResponse) {
  // Map /api/hermes/<path> → /v1/<path> upstream.
  const suffix = (req.url || '').replace(/^\/api\/hermes/, '') || '/';
  const upstreamPath = `/v1${suffix}`;
  const upstream = new URL(upstreamPath, HERMES_UPSTREAM);

  const headers: Record<string, string> = {};
  // Forward content headers + accept. Strip cookies/host — the upstream
  // only cares about method + body + our injected auth.
  for (const h of ['content-type', 'content-length', 'accept']) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  if (HERMES_TOKEN) headers['authorization'] = `Bearer ${HERMES_TOKEN}`;

  const lib = upstream.protocol === 'https:' ? https : http;
  const upReq = lib.request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers,
  }, (upRes) => {
    // Strip hop-by-hop headers; keep SSE-critical ones.
    const out = { ...upRes.headers };
    delete out.connection;
    delete out['transfer-encoding'];
    // Preserve content-type (text/event-stream for /responses with stream=true).
    res.writeHead(upRes.statusCode || 502, out as any);
    upRes.pipe(res);
  });

  upReq.on('error', (e) => {
    console.error('hermes proxy: upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
    } else {
      res.end();
    }
  });

  // Forward client body (POST) or just end (GET).
  if (req.method === 'POST' || req.method === 'PUT') req.pipe(upReq);
  else upReq.end();
}

/**
 * Intercept Hermes routes. Returns `true` if the request was handled
 * (response was / will be written), `false` if the main router should
 * continue matching.
 *
 * Call this early in your server's request handler:
 *
 *   if (mountHermesRoutes(req, res)) return;
 *   // ...other routes...
 */
export function mountHermesRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url;
  if (!url || !url.startsWith('/api/hermes')) return false;

  // Session-browser routes (handled locally via sqlite; must match before
  // the generic /api/hermes pass-through proxy below).
  const msgMatch = req.method === 'GET' && url.match(/^\/api\/hermes\/sessions\/([^/?]+)\/messages(?:\?.*)?$/);
  if (msgMatch) { handleHermesSessionMessages(req, res, decodeURIComponent(msgMatch[1])); return true; }
  const renameMatch = req.method === 'POST' && url.match(/^\/api\/hermes\/sessions\/([^/?]+)\/rename(?:\?.*)?$/);
  if (renameMatch) { handleHermesSessionRename(req, res, decodeURIComponent(renameMatch[1])); return true; }
  const deleteMatch = req.method === 'DELETE' && url.match(/^\/api\/hermes\/sessions\/([^/?]+)(?:\?.*)?$/);
  if (deleteMatch) { handleHermesSessionDelete(req, res, decodeURIComponent(deleteMatch[1])); return true; }
  if (req.method === 'GET' && /^\/api\/hermes\/sessions(?:\?.*)?$/.test(url)) { handleHermesSessionsList(req, res); return true; }
  if (req.method === 'GET' && /^\/api\/hermes\/models-catalog(?:\?.*)?$/.test(url)) { handleHermesModelsCatalog(req, res); return true; }
  if (req.method === 'GET' && /^\/api\/hermes\/model(?:\?.*)?$/.test(url)) { handleHermesModelGet(req, res); return true; }
  if (req.method === 'POST' && /^\/api\/hermes\/model(?:\?.*)?$/.test(url)) { handleHermesModelSet(req, res); return true; }

  // Fall-through: generic /api/hermes/* → upstream /v1/* proxy.
  handleHermesProxy(req, res);
  return true;
}
