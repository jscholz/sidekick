// Sessions endpoints for the hermes-gateway backend.
//
// Sources of truth:
//   - PWA-side IDB owns the canonical chat_id list (each sidebar row IS
//     a chat_id; "new chat" mints a UUID locally). The proxy doesn't
//     know a chat_id exists until the user sends the first message.
//   - ~/.hermes/sessions/sessions.json maps every session_key (incl.
//     `agent:main:sidekick:dm:<chat_id>`) to its current session_id.
//   - state.db `sessions` table holds title + message_count + timestamps
//     keyed by session_id.
//
// For drawer enrichment we walk sessions.json for the sidekick prefix,
// then JOIN those session_ids against state.db for the metadata.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sqlQuery } from '../../generic/sql.ts';
import { HERMES_STATE_DB } from '../hermes/config.ts';
import { client } from './client.ts';
import {
  listAllChats,
  resolveChatIdToSessionId,
  SIDEKICK_KEY_PREFIX,
  parseSessionKey,
} from './session-index.ts';

interface SidekickSessionRow {
  chat_id: string;
  session_id: string | null;
  source: string;
  title: string | null;
  message_count: number;
  last_active_at: string | null;
  created_at: string | null;
  /** Snippet of the first user message in this session, truncated to
   *  ~80 chars. Lets the drawer fall back to a meaningful label when
   *  hermes hasn't generated a title yet (model error / blip / race).
   *  Null when there's no user message on disk yet. */
  first_user_message: string | null;
}

/** Max length for the first-user-message snippet exposed to the drawer.
 *  Tuned to fit a single drawer row at typical font sizes; the actual
 *  width is constrained by CSS but truncating at the source keeps the
 *  payload small. */
const FIRST_USER_MESSAGE_SNIPPET_MAX = 80;

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
  let rows: SidekickSessionRow[] = [];
  try {
    // Walk sessions.json across ALL platforms (sidekick + telegram +
    // slack + whatsapp + …). Drawer renders source badges for non-
    // sidekick rows; composer goes read-only when viewing them.
    const chats = await listAllChats(limit);
    if (chats.length === 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    // Build a single SELECT against state.db keyed by session_id IN (...).
    // Each session_id is a 24-char timestamp_hash literal (e.g.
    // 20260428_095730_19b8b637) — strict-match safe to inline.
    const idList = chats
      .filter(c => /^[A-Za-z0-9_]{1,64}$/.test(c.session_id))
      .map(c => `'${c.session_id}'`).join(',');
    if (!idList) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    // sessions.json is the source-of-truth for chat_id ↔ session_id (it
    // tracks compression-rotation; state.db preserves both old and new
    // forks via parent_session_id). state.db is the source-of-truth for
    // existence: a chat_id whose session_id has no state.db row is an
    // orphan (sessions.json is written synchronously on session-create,
    // but state.db is written async and may have failed silently — see
    // gateway/session.py:817 vs :833). Drop those orphans so the drawer
    // never surfaces ghosts.
    // Subquery picks the EARLIEST user-role message per session by id
    // ASC LIMIT 1 — id is the messages PK and monotonic per insert, so
    // it's a stable proxy for "first turn". COALESCE to NULL stays
    // NULL (sqlite3's -json driver emits null for unset cells), which
    // the drawer treats as "no snippet, fall back to chat id".
    const dbRows = await sqlQuery(HERMES_STATE_DB, `
      SELECT s.id AS session_id,
             COALESCE(s.source, '') AS source,
             COALESCE(s.title, '') AS title,
             COALESCE(s.message_count, 0) AS message_count,
             s.started_at,
             s.ended_at,
             (SELECT m.content FROM messages m
              WHERE m.session_id = s.id AND m.role = 'user'
              ORDER BY m.id ASC LIMIT 1) AS first_user_msg
      FROM sessions s
      WHERE s.id IN (${idList})
    `);
    const dbBySessionId = new Map<string, any>();
    for (const r of dbRows) dbBySessionId.set(r.session_id, r);
    let droppedOrphans = 0;
    rows = [];
    for (const c of chats) {
      const meta = dbBySessionId.get(c.session_id);
      if (!meta) { droppedOrphans++; continue; }
      // Truncate the snippet at the proxy boundary so the drawer
      // doesn't have to know the limit. Keep the original null when
      // there's no user message yet (drawer falls back to chat id).
      const rawSnippet = typeof meta.first_user_msg === 'string' ? meta.first_user_msg : null;
      const snippet = rawSnippet
        ? rawSnippet.slice(0, FIRST_USER_MESSAGE_SNIPPET_MAX)
        : null;
      rows.push({
        chat_id: c.chat_id,
        session_id: c.session_id,
        source: meta.source || c.source,
        title: meta.title || '',
        message_count: meta.message_count || 0,
        last_active_at: c.updated_at,
        created_at: meta.started_at ? new Date(meta.started_at * 1000).toISOString() : null,
        first_user_message: snippet,
      });
    }
    if (droppedOrphans > 0) {
      console.warn(`[hermes-gateway] sessions list: dropped ${droppedOrphans} orphan(s) — sessions.json had keys whose session_id has no state.db row`);
    }
  } catch (e: any) {
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
  const sessionId = await resolveChatIdToSessionId(chatId);
  if (!sessionId) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(sessionId)) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'derived session_id failed validation' }));
    return;
  }
  try {
    await sqlQuery(HERMES_STATE_DB,
      `DELETE FROM sessions WHERE id='${sessionId}'`);
    await sqlQuery(HERMES_STATE_DB,
      `DELETE FROM messages WHERE session_id='${sessionId}'`);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  // Best-effort cleanup of sessions.json and the transcript jsonl. The
  // gateway is the canonical writer of sessions.json; it'll re-derive
  // the file on the next session-create, so a failure here is
  // recoverable. We still scrub directly because waiting for the next
  // create can leave an orphan visible in the drawer for hours.
  await scrubSessionsIndexAndJsonl(chatId, sessionId);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function scrubSessionsIndexAndJsonl(chatId: string, sessionId: string): Promise<void> {
  const hermesHome = path.dirname(HERMES_STATE_DB);
  const sessionsDir = path.join(hermesHome, 'sessions');
  const indexPath = path.join(sessionsDir, 'sessions.json');
  const key = `${SIDEKICK_KEY_PREFIX}${chatId}`;
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const idx = JSON.parse(raw);
    if (idx && typeof idx === 'object' && key in idx) {
      delete idx[key];
      const tmp = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(idx, null, 2), 'utf-8');
      await fs.rename(tmp, indexPath);
    }
  } catch (e: any) {
    console.warn('[hermes-gateway] sessions.json scrub failed:', e.message);
  }
  try {
    await fs.unlink(path.join(sessionsDir, `${sessionId}.jsonl`));
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.warn('[hermes-gateway] jsonl scrub failed:', e.message);
    }
  }
}
