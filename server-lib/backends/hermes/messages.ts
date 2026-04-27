// Hermes session messages + last-response-id reads. Both walk the
// recursive parent_session_id chain (when applicable) so compression-
// rotated sessions show their full transcript / chain back to a single
// canonical response_id.
import { sqlQuery } from '../../generic/sql.ts';
import { HERMES_STORE_DB, HERMES_STATE_DB } from './config.ts';
import { lookupSessionUuid } from './sessions.ts';
import { chainCteFromSession } from './cte.ts';

export async function handleHermesSessionMessages(req, res, name: string) {
  // id is either a sidekick conversation name ('sidekick-*') we need to
  // resolve to a session UUID, or a state.db session UUID we can query
  // directly (telegram / cli / any other channel where hermes creates
  // sessions without a response_store.db conversations row).
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
  // Pagination cursor: fetch messages with id < before. Omitted = newest page.
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
  // AUTHORITATIVE read path: state.db/messages keyed by the session UUID.
  // Earlier implementation read from responses.data.conversation_history
  // but that payload compounds across turns (each response embeds its
  // full input-context, which includes prior turns' contexts, growing
  // recursively). state.db/messages is the per-turn log hermes updates
  // exactly once per user/assistant entry.
  try {
    let uuid: string | null = null;
    if (name.startsWith('sidekick-') || name.startsWith('sideclaw-')) {
      const uuidSql = `SELECT json_extract(r.data, '$.session_id') AS uuid
        FROM conversations c LEFT JOIN responses r ON r.response_id = c.response_id
        WHERE c.name='${name}'`;
      const uuidRows = await sqlQuery(HERMES_STORE_DB, uuidSql);
      uuid = uuidRows[0]?.uuid || null;
    } else {
      uuid = name;
    }
    if (!uuid) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(uuid) || uuid.length > 128) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'derived session_id failed validation' }));
      return;
    }
    // Newest-first page, reversed client-visibly below. SQLite's `id` is
    // autoincrement so lower = older. hasMore is a peek of 1 extra row.
    //
    // Compression rotation: the resolved `uuid` may itself be a child of
    // a rotated chain (e.g. an orphan-resume id passed in raw). Walk
    // upward via parent_session_id to the root, then walk downward via
    // a recursive CTE to gather every descendant. Messages from any
    // session in the chain are returned, ordered globally by id DESC —
    // child sessions are created later than their parent, so id
    // ordering matches timestamp ordering across the chain (verified).
    // The `before=<id>` cursor still works because messages.id is a
    // global autoincrement, not per-session.
    const whereCursor = before !== null ? `AND m.id < ${before}` : '';
    const msgSql = `WITH RECURSIVE ${chainCteFromSession(uuid)}
      SELECT m.id, m.role, m.content, m.tool_name, m.timestamp FROM messages m
        WHERE m.session_id IN (SELECT id FROM chain) ${whereCursor}
        ORDER BY m.id DESC LIMIT ${limit + 1}`;
    const rows = await sqlQuery(HERMES_STATE_DB, msgSql);
    // Strip context-compaction handoff messages from the visible
    // transcript. Hermes injects these as role='assistant' rows whose
    // content starts with literal '[CONTEXT COMPACTION'. They're agent
    // bookkeeping (a summary of the prior context window), not a turn
    // the user wrote or read — surfacing them in the chat is noisy.
    // Filter post-CTE so the recursive chain walk + cursor pagination
    // above stay simple. The 'tool_name LIKE %compaction%' alternative
    // doesn't match in practice — verified against state.db: tool_name
    // is empty for all role='tool' rows; the marker lives in content.
    const compactionRe = /^\[CONTEXT COMPACTION\b/;
    const filtered = rows.filter((m: any) =>
      !(m.role === 'assistant' && typeof m.content === 'string' && compactionRe.test(m.content)),
    );
    const hasMore = filtered.length > limit;
    const trimmed = hasMore ? filtered.slice(0, limit) : filtered;
    // Reverse to chronological (oldest → newest).
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
    console.error('hermes session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/** Returns the latest response_id for a session, used by the hermes
 *  adapter to chain follow-up turns via `previous_response_id` when the
 *  session has no sidekick-prefixed conversation row (orphan-resume
 *  case — telegram/whatsapp/cli sessions, or api_server replies on
 *  behalf of another adapter). Without this, `conversation: <UUID>`
 *  misses `response_store.conversations` and api_server creates a fresh
 *  session for every turn. */
export async function handleHermesSessionLastResponseId(req, res, name: string) {
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
    const rows = await sqlQuery(HERMES_STORE_DB,
      `SELECT response_id FROM responses
       WHERE json_extract(data, '$.session_id')='${uuid}'
       ORDER BY accessed_at DESC LIMIT 1`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ responseId: rows[0]?.response_id || null }));
  } catch (e: any) {
    console.error('hermes session last-response-id failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
