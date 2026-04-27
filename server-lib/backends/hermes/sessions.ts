// Hermes session list + id resolution + rename.
//
// Reads cross the `state.db` (sessions/messages) and `response_store.db`
// (conversations/responses) sqlite files; the long doc-block at the top
// of search.ts is the canonical mental-model anchor for how these two
// id spaces relate. Read that before touching anything in this file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sqlQuery } from '../../generic/sql.ts';
import { HERMES_STORE_DB, HERMES_STATE_DB, HERMES_CLI } from './config.ts';
import { searchSessionsImpl } from './search.ts';
import { chainCteFromSession } from './cte.ts';

const execFileP = promisify(execFile);

// TODO: migrate callers to /api/hermes/search?kind=sessions and retire
// this endpoint. Kept as a thin alias so the existing client (backend.
// listSessions, deployed service workers with cached old bundles) keeps
// working while sidekickv2.29+ rolls out. The `prefix` query param is
// also accepted for the same reason — older clients still send it.
export async function handleHermesSessionsList(req, res) {
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  // Legacy `prefix=` is comma-separated globs; the unified endpoint
  // accepts the same syntax via `q`, so we just pass it through.
  const rawFilter = url.searchParams.get('prefix') || '';
  try {
    const sessions = await searchSessionsImpl(rawFilter, limit);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  } catch (e: any) {
    console.error('hermes sessions list failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/** Map an id used by the drawer to the canonical state.db session UUID.
 *  Sidekick webchat rows come in as conversation names ('sidekick-*') —
 *  we look those up via response_store.db → responses.data.session_id.
 *  Telegram / cli rows come in as the UUID already (they have no
 *  response_store conversations row), so we pass them through after a
 *  sanity check that state.db/sessions has that row. Returns null if
 *  the id doesn't resolve to a known session.
 *
 *  NOTE: returns the LATEST fork only. For cascade delete use
 *  lookupAllSessionUuids instead. See header comment above. */
export async function lookupSessionUuid(name: string): Promise<string | null> {
  if (name.startsWith('sidekick-') || name.startsWith('sideclaw-')) {
    const sql = `SELECT json_extract(r.data, '$.session_id') AS uuid
      FROM conversations c
      LEFT JOIN responses r ON r.response_id = c.response_id
      WHERE c.name='${name}'`;
    const rows = await sqlQuery(HERMES_STORE_DB, sql);
    return rows[0]?.uuid || null;
  }
  const rows = await sqlQuery(HERMES_STATE_DB,
    `SELECT id FROM sessions WHERE id='${name}' LIMIT 1`);
  return rows[0]?.id || null;
}

/** Resolve a drawer id to ALL state.db session UUIDs that belong to its
 *  logical conversation. Used by the delete handler to cascade across
 *  forks; without this, deleting "sidekick-foo" only removed the latest
 *  fork and orphaned earlier ones (the cause of "I deleted but the row
 *  came back with stale messageCount" — the ghost was the older fork
 *  that got re-aggregated by the dedup query).
 *
 *  Two fork mechanisms (see searchSessionsImpl comment):
 *    - sidekick/sideclaw slugs → join through response_store; every
 *      response carrying that slug is from one of the forks, so the set
 *      of distinct session_ids in those responses IS the fork set.
 *    - non-slug ids (whatsapp/cli/etc) → walk parent_session_id chain
 *      both up to root and down through descendants. */
export async function lookupAllSessionUuids(name: string): Promise<string[]> {
  if (name.startsWith('sidekick-') || name.startsWith('sideclaw-')) {
    const sql = `SELECT DISTINCT json_extract(r.data, '$.session_id') AS uuid
      FROM conversations c
      LEFT JOIN responses r ON r.response_id = c.response_id
      WHERE c.name='${name}' AND r.data IS NOT NULL`;
    const rows = await sqlQuery(HERMES_STORE_DB, sql);
    return rows.map((r: any) => r.uuid).filter(Boolean);
  }
  const sql = `
    WITH RECURSIVE ${chainCteFromSession(name)}
    SELECT DISTINCT id FROM chain
  `;
  const rows = await sqlQuery(HERMES_STATE_DB, sql);
  return rows.map((r: any) => r.id).filter(Boolean);
}

export async function handleHermesSessionRename(req, res, name: string) {
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
