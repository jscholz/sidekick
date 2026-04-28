// Per-chat_id transcript history for the hermes-gateway backend.
//
// GET /api/sidekick/sessions/<chat_id>/messages?limit=N
//
// The gateway owns sessions per (Platform.SIDEKICK, chat_id) and writes
// every turn to state.db/messages keyed by the resolved session_id. We
// resolve chat_id → session_id via the gateway's session-key shape:
//
//     session_key = `agent:main:sidekick:dm:<chat_id>`
//
// then walk the parent_session_id chain (in case the active session was
// compression-rotated) and read messages.id-DESC ordered, mirroring the
// /api/hermes/sessions/<id>/messages handler so the PWA renderer code
// path is identical.
//
// Why duplicate the recursive CTE rather than import the hermes
// version: the lookup PATH differs (hermes resolves slug → session_id
// via response_store.db; we resolve session_key → session_id via
// state.db), but the CTE body itself can be shared. We import
// chainCteFromSession from the hermes module so the SQL stays in one
// place.
//
// Like the legacy hermes endpoint, a missing chat_id returns 404 and
// `[CONTEXT COMPACTION ...]` rows are filtered out so the visible
// transcript stays clean.

import { sqlQuery } from '../../generic/sql.ts';
import { HERMES_STATE_DB } from '../hermes/config.ts';
import { chainCteFromSession } from '../hermes/cte.ts';
import { client } from './client.ts';

const SIDEKICK_KEY_PREFIX = 'agent:main:sidekick:dm:';

export async function handleSidekickSessionMessages(req, res, chatId: string) {
  // Validate chat_id shape — IDB-minted UUIDs are URL-safe base16+dash,
  // but be permissive on length to accommodate the fallback uuid()
  // implementation in src/conversations.ts.
  if (!chatId || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  // Like the sessions list endpoint, gracefully degrade when the
  // platform isn't configured — the PWA falls back to its IDB cache and
  // would otherwise see an unhelpful 503 here.
  if (!client.isConfigured()) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [], firstId: null, hasMore: false, unconfigured: true }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
  try {
    // Resolve chat_id → session_id via the gateway's session_key shape.
    // The gateway mutates this row in place across compression rotations,
    // so the latest fork is what the lookup returns.
    const sessionKey = `${SIDEKICK_KEY_PREFIX}${chatId}`;
    const idRows = await sqlQuery(HERMES_STATE_DB,
      `SELECT id FROM sessions WHERE session_key='${sessionKey}' LIMIT 1`);
    const uuid = idRows[0]?.id || null;
    if (!uuid) {
      // No session for this chat_id yet — common case on a fresh chat
      // where the user opened the drawer entry but never sent. Return
      // an empty transcript rather than 404 so the renderer can show
      // "no messages yet" without an error toast.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [], firstId: null, hasMore: false }));
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(uuid) || uuid.length > 128) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'derived session_id failed validation' }));
      return;
    }
    // Cursor + chain walk identical to the legacy hermes endpoint —
    // see server-lib/backends/hermes/messages.ts for the comment block
    // explaining why this works (messages.id is a global autoincrement,
    // child sessions are created later than their parents).
    const whereCursor = before !== null ? `AND m.id < ${before}` : '';
    const msgSql = `WITH RECURSIVE ${chainCteFromSession(uuid)}
      SELECT m.id, m.role, m.content, m.tool_name, m.timestamp FROM messages m
        WHERE m.session_id IN (SELECT id FROM chain) ${whereCursor}
        ORDER BY m.id DESC LIMIT ${limit + 1}`;
    const rows = await sqlQuery(HERMES_STATE_DB, msgSql);
    const compactionRe = /^\[CONTEXT COMPACTION\b/;
    const filtered = rows.filter((m: any) =>
      !(m.role === 'assistant' && typeof m.content === 'string' && compactionRe.test(m.content)),
    );
    const hasMore = filtered.length > limit;
    const trimmed = hasMore ? filtered.slice(0, limit) : filtered;
    trimmed.reverse();
    const messages = trimmed.map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content || '',
      timestamp: m.timestamp,
      toolName: m.tool_name || undefined,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages,
      firstId: messages.length ? messages[0].id : null,
      hasMore,
    }));
  } catch (e: any) {
    console.error('[hermes-gateway] session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
