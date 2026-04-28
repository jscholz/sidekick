// Sessions endpoints for the hermes-gateway backend.
//
// Sources of truth:
//   - PWA-side IDB owns the canonical chat_id list (each sidebar row IS
//     a chat_id; "new chat" mints a UUID locally). The proxy never
//     learned a row exists until the user sends the first message.
//   - hermes' state.db `sessions` table maps each chat_id we've seen
//     to the latest gateway session_id + compression-aware title.
//
// For v1 we enrich whatever PWA-side IDB sends us against state.db so
// the drawer can show titles + last-message timestamps without each
// PWA tab maintaining that metadata locally. The PWA can also fall
// back to its own IDB cache when the adapter is unreachable.
//
// The chat_id <-> session_id mapping is stored under the standard
// gateway session-key shape:
//   `agent:main:sidekick:dm:<chat_id>`
// We match on that prefix so the query is local-DB-only (no JOINs into
// response_store.db; gateway-managed adapters don't write there).

import { sqlQuery } from '../../generic/sql.ts';
import { HERMES_STATE_DB } from '../hermes/config.ts';
import { client } from './client.ts';

const SIDEKICK_KEY_PREFIX = 'agent:main:sidekick:dm:';

interface SidekickSessionRow {
  chat_id: string;
  session_id: string | null;
  title: string | null;
  message_count: number;
  last_active_at: string | null;
  created_at: string | null;
}

/** GET /api/sidekick/sessions
 *
 *  Returns: { sessions: [{ chat_id, session_id, title, message_count,
 *                          last_active_at, created_at }] }
 *
 *  Order: most-recently-active first.
 *
 *  Limit via ?limit=N (1..200, default 50). Same query semantics as
 *  /api/hermes/sessions for drawer parity.
 *
 *  No-token / no-DB cases return an empty list rather than 503 — the
 *  PWA can render its own IDB-backed drawer offline; this endpoint is
 *  enrichment, not source-of-truth. */
export async function handleSidekickSessionsList(req, res) {
  // Enrichment endpoint — gracefully degrade when the platform isn't
  // configured. Drawer falls back to IDB.
  if (!client.isConfigured()) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [], unconfigured: true }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  // The session_key looks like `agent:main:sidekick:dm:<chat_id>`. Pull
  // the chat_id off via substr(). state.db.sessions stores the active
  // session row only — compression-rotated rows live under the same
  // session_key (with the previous gateway behavior of mutating in
  // place), so this query naturally returns the latest fork.
  const sql = `
    SELECT
      substr(session_key, ${SIDEKICK_KEY_PREFIX.length + 1}) AS chat_id,
      id AS session_id,
      COALESCE(title, '') AS title,
      COALESCE(message_count, 0) AS message_count,
      COALESCE(last_message_at, updated_at, started_at) AS last_active_at,
      started_at AS created_at
    FROM sessions
    WHERE session_key LIKE '${SIDEKICK_KEY_PREFIX}%'
    ORDER BY COALESCE(last_message_at, updated_at, started_at) DESC
    LIMIT ${limit}
  `;
  let rows: SidekickSessionRow[] = [];
  try {
    rows = await sqlQuery(HERMES_STATE_DB, sql);
  } catch (e: any) {
    // sessions table column names can drift — surface but don't 500
    // (a fresh hermes install with no sidekick rows yet returns []).
    console.warn('[hermes-gateway] sessions list query failed:', e.message);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sessions: rows }));
}

/** DELETE /api/sidekick/sessions/<chat_id>
 *
 *  Asks the adapter to drop its in-memory state for `chat_id` and
 *  removes the matching state.db row. This is best-effort — the
 *  PWA-side IDB is still the source of truth, and a stale state.db
 *  row mostly just means the drawer enrichment shows an old title.
 *
 *  Returns 200 on success, 404 if there's no row to delete, 503 if
 *  the platform isn't configured. */
export async function handleSidekickSessionDelete(req, res, chatId: string) {
  if (!client.isConfigured()) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  if (!chatId || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  // Tell the adapter to forget any in-memory state for this chat_id.
  // The adapter doesn't have a delete envelope today; a `command` with
  // /forget is a graceful future hook. For now we just drop the DB row;
  // the next inbound message creates a fresh session under the same
  // chat_id automatically.
  const sessionKey = `${SIDEKICK_KEY_PREFIX}${chatId}`;
  // sqlite3 -json doesn't return rowcount on DELETE, so we round-trip
  // a SELECT first to surface 404 vs 200 sensibly.
  let rows: any[] = [];
  try {
    rows = await sqlQuery(HERMES_STATE_DB,
      `SELECT id FROM sessions WHERE session_key='${sessionKey}' LIMIT 1`);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  if (rows.length === 0) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  try {
    await sqlQuery(HERMES_STATE_DB,
      `DELETE FROM sessions WHERE session_key='${sessionKey}'`);
    // Best-effort: also drop the messages rows for this session so the
    // next chat_id reuse doesn't accidentally inherit history.
    await sqlQuery(HERMES_STATE_DB,
      `DELETE FROM messages WHERE session_id='${rows[0].id}'`);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
