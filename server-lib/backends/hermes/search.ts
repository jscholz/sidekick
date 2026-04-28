// ─── Hermes session management — read this before touching anything below ──
//
// PROBLEM SHAPE
//
// Sidekick presents the user with one row per "logical conversation" in the
// drawer. Hermes does not. Hermes maintains TWO independent identifier
// spaces that don't fully agree on what a conversation is:
//
//   1. session_id (state.db.sessions)  — transport key. Generated per
//      gateway "context window." Subject to rotation.
//   2. conversation slug (response_store.db.conversations) — logical key.
//      Stable across rotations from the client's point of view; sidekick
//      always sends `conversation=sidekick-<slug>` on every POST.
//
// One conversation slug can map to N session rows. The drawer must collapse
// these to one row, and delete must cascade across all members. That is what
// this section of server.ts implements.
//
// HOW SESSIONS FORK (two independent mechanisms, both produce N rows from 1)
//
//   A) Compression rotation. When the agent's prompt context exceeds budget,
//      hermes ends the current session (`end_reason='compression'`) and
//      creates a NEW session with `parent_session_id` pointing at the old
//      one. Reference: run_agent.py:7580. Forks are linked.
//
//   B) Cold-start fork. When the gateway restarts or its in-memory
//      `_response_store` LRU-evicts the previous response_id, the next POST
//      with the same conversation slug mints a fresh ROOT session with
//      `parent_session_id=NULL` — there's no live response_id to link to.
//      Forks are NOT linked. Filed upstream at NousResearch/hermes-agent#16517;
//      they may fix it (use slug→session lookup on fallback) or document it as
//      intentional. Either way, we dedup defensively until then.
//
// HOW WE COLLAPSE (two paths matching the two fork mechanisms)
//
//   1) SQL recursive CTE in searchSessionsImpl walks `parent_session_id`,
//      returns one row per root with chain-aggregated message counts.
//      Catches mechanism (A).
//
//   2) JS post-pass in mergeForkRows merges rows that share the same id
//      (which is the slug for api_server sessions, set by the SELECT's
//      CASE WHEN). Catches mechanism (B). SQL inner-LIMIT is bumped to
//      limit*4 so we have enough pre-merge rows to fill the window.
//
// HOW DELETE CASCADES (lookupAllSessionUuids)
//
//   - Slug ids ('sidekick-*' / 'sideclaw-*') → enumerate all session_ids
//     ever attached to the slug via response_store.db. Every fork of a slug
//     has at least one row in `responses` whose data.session_id points at it.
//   - Non-slug ids → walk parent_session_id up to the root, then back down
//     through descendants. Same CTE shape as listing.
//   - Each member uuid gets its own `hermes sessions delete` CLI invocation
//     plus a hindsight scrub. Then the slug's response_store rows are wiped.
//   - Without the cascade, deleting a slug-row removed only the latest fork
//     and the older forks would re-aggregate into the drawer on the next
//     list call — looking like the row "came back" with stale counts.
//
// WHY HERE AND NOT IN HERMES
//
// Don't stack hermes patches for sidekick-specific UX. All three mechanisms
// above are sidekick concerns: hermes can keep its own internal model.
// The cost is this comment block plus mergeForkRows + lookupAllSessionUuids
// — a price worth paying to keep hermes upgrades clean. If upstream #16517
// lands, mechanism (B) goes away and so can the JS merge step (the SQL
// CTE alone covers (A)).
//
// IF YOU'RE EDITING ANYTHING IN THIS SECTION
//
//   - Anything that returns sessions to the drawer must run through
//     mergeForkRows — drawer treats id as the conversation key.
//   - Anything that deletes a session must use lookupAllSessionUuids, not
//     lookupSessionUuid — the latter only finds the latest fork.
//   - The slug join goes through response_store.db, not state.db. Both DBs
//     are ATTACHed in the search query.
//   - Tests in test/ exercise the merge directly — add a row to those when
//     adding a new fork-producing scenario.
//
// ───────────────────────────────────────────────────────────────────────────

import { sqlQuery } from '../../generic/sql.ts';
import { HERMES_STORE_DB, HERMES_STATE_DB } from './config.ts';

/** Unified search endpoint — handles three modes via `kind`:
 *
 *    kind=sessions  → SQL LIKE (glob → %) over title/source/id/conv-name.
 *                     Same shape as /api/hermes/sessions: {sessions: [...]}.
 *                     Empty `q` returns ALL sessions (limit=50), so the
 *                     drawer can call this endpoint for both filter and
 *                     no-filter cases.
 *    kind=messages  → FTS5 against messages_fts. {hits: [...]}.
 *    kind=both      → both keys in the same envelope: {sessions, hits}.
 *
 *  Default kind=both keeps cmd+K's existing behavior for ANY caller that
 *  was hitting /api/hermes/search without a kind param — but the cmd+K
 *  client now passes kind=both explicitly so this default is a safety
 *  net, not load-bearing.
 *
 *  Sanitization (FTS5 path): input is restricted to [a-zA-Z0-9_\s\-*] —
 *  strips punctuation FTS5 would otherwise interpret as syntax (parens,
 *  NEAR, quotes, colons, etc.) so users can't accidentally hit a syntax
 *  error by typing a question mark or apostrophe. Tokens are joined with
 *  spaces for FTS5's default AND semantics.
 *
 *  Sanitization (sessions path): same character class as the legacy
 *  /api/hermes/sessions endpoint — `[a-zA-Z0-9_\-*:@.]`. Differs from
 *  the FTS5 path because `:` and `@` and `.` are valid in session ids
 *  and source labels, and we want users to be able to filter on them. */
export async function handleHermesSearch(req, res) {
  const url = new URL(req.url, 'http://x');
  const rawQ = url.searchParams.get('q') || '';
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '20', 10)));
  const kind = (url.searchParams.get('kind') || 'both').toLowerCase();

  let sessions: any[] | undefined;
  let hits: any[] | undefined;
  let hitsError: string | undefined;

  if (kind === 'sessions' || kind === 'both') {
    sessions = await searchSessionsImpl(rawQ, limit);
  }
  if (kind === 'messages' || kind === 'both') {
    const r = await searchMessagesImpl(rawQ, limit);
    hits = r.hits;
    hitsError = r.error;
  }

  const body: any = {};
  if (sessions !== undefined) body.sessions = sessions;
  if (hits !== undefined) body.hits = hits;
  if (hitsError !== undefined) body.error = hitsError;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Shared session-search implementation. Returns the same row shape as
 *  /api/hermes/sessions (title/source/id/snippet/messageCount/lastMessageAt)
 *  so callers can swap endpoints without re-mapping. Empty `rawQ` → all
 *  sessions (limit). Non-empty → glob-split (commas + whitespace), each
 *  token converted `*` → `%` and matched against title/source/id/conv-name.
 *
 *  Fork dedup — TWO mechanisms work together:
 *
 *    1. SQL recursive CTE walks `parent_session_id`. Hermes' compression
 *       rotation (`run_agent.py:7580` sets parent_session_id when context
 *       budget is exceeded) creates a child session linked to its parent;
 *       the CTE collapses the chain to one row per root and aggregates
 *       message_count / lastMessageAt / snippet across the whole chain.
 *
 *    2. JS post-pass merges roots that share a `sidekick-*` / `sideclaw-*`
 *       slug. This catches the SECOND fork mode: when the gateway restarts
 *       or hermes' in-memory `_response_store` LRU-evicts, the next POST
 *       with `conversation=sidekick-foo` mints a fresh ROOT session
 *       (parent_session_id is null — there's nothing to link to) but the
 *       slug is the same. Without (2), the sidebar would show "sidekick-foo"
 *       twice. JS merge sums messageCount, takes max lastMessageAt, latest
 *       snippet. This case shows up after a gateway restart or LRU eviction
 *       cycle — sidebar would otherwise duplicate the slug with split counts.
 *
 *  Why JS merge instead of more SQL? The CTE already aggregates within a
 *  chain; a second SQL grouping over the result requires another CTE
 *  layer + GROUP BY, doubling query complexity. JS merge over ~hundreds
 *  of rows is negligible. The SQL inner-LIMIT is bumped (limit * 4) so we
 *  have enough pre-merge rows to fill the requested `limit` post-merge. */
export async function searchSessionsImpl(rawQ: string, limit: number): Promise<any[]> {
  // Tokenize on commas + whitespace. Sanitizer matches the legacy
  // /api/hermes/sessions semantics; `:` permitted because users may try
  // `source:whatsapp` (we strip the prefix client-side, but the colon
  // can still slip through if they type fast).
  const tokens = rawQ
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.replace(/[^a-zA-Z0-9_\-*:@.]/g, '').replace(/\*/g, '%'))
    .filter(Boolean);

  let whereClause: string;
  if (tokens.length === 0) {
    // Empty query → all sessions (still hide tool-source).
    whereClause = "s.source != 'tool'";
  } else {
    const clauses: string[] = [];
    for (const t of tokens) {
      // If the token has no glob, wrap with %…% so it acts as a substring
      // match (matches the client-side applyFilter behavior). If it
      // already had a glob, the user explicitly anchored — leave it.
      const needle = t.includes('%') ? t : `%${t}%`;
      clauses.push(`s.title LIKE '${needle}'`);
      clauses.push(`s.source LIKE '${needle}'`);
      clauses.push(`s.id LIKE '${needle}'`);
      clauses.push(`EXISTS (
        SELECT 1 FROM store.responses r
        JOIN store.conversations c ON c.response_id = r.response_id
        WHERE json_extract(r.data, '$.session_id') = s.id
          AND c.name LIKE '${needle}'
      )`);
    }
    whereClause = clauses.join(' OR ');
  }

  // Hermes auto-rotates state.db sessions when the agent's internal
  // context grows past budget (run_agent.py:7572-7585): old session is
  // ended with end_reason='compression', a new session is created with
  // parent_session_id pointing back. The drawer still shows ONE row per
  // root (rotations are an internal detail), but message_count /
  // lastMessageAt / snippet must aggregate over the entire chain or the
  // drawer freezes at the moment compression fired. Recursive CTE walks
  // root → descendants; aggregates pull from any session in the chain.
  const sql = `
    ATTACH '${HERMES_STORE_DB.replace(/'/g, "''")}' AS store;
    WITH RECURSIVE chain(root, id) AS (
      SELECT s.id, s.id FROM sessions s WHERE s.parent_session_id IS NULL
      UNION ALL
      SELECT c.root, s.id FROM sessions s JOIN chain c ON s.parent_session_id = c.id
    )
    SELECT
      CASE WHEN s.source = 'api_server'
        THEN COALESCE(
          (SELECT c.name FROM store.responses r
             JOIN store.conversations c ON c.response_id = r.response_id
             WHERE json_extract(r.data, '$.session_id') = s.id
               AND (c.name LIKE 'sidekick-%' OR c.name LIKE 'sideclaw-%')
             ORDER BY r.accessed_at DESC LIMIT 1),
          s.id)
        ELSE s.id END AS id,
      s.source,
      s.title,
      (SELECT COALESCE(SUM(s2.message_count), 0) FROM sessions s2
         JOIN chain ch ON ch.id = s2.id WHERE ch.root = s.id) AS messageCount,
      (SELECT MAX(m.timestamp) FROM messages m
         JOIN chain ch ON ch.id = m.session_id WHERE ch.root = s.id) AS lastMessageAt,
      (SELECT substr(m.content, 1, 120) FROM messages m
         JOIN chain ch ON ch.id = m.session_id WHERE ch.root = s.id
           AND m.role IN ('user','assistant') AND m.content IS NOT NULL
         ORDER BY m.id DESC LIMIT 1) AS snippet
    FROM sessions s
    WHERE (${whereClause})
      AND s.parent_session_id IS NULL
    ORDER BY lastMessageAt DESC NULLS LAST
    LIMIT ${limit * 4}
  `;
  try {
    const rows = await sqlQuery(HERMES_STATE_DB, sql);
    return mergeForkRows(rows, limit);
  } catch (e: any) {
    console.error('hermes search (sessions) failed:', e.message);
    return [];
  }
}

/** Collapse rows that share the same id (slug for api_server sessions).
 *  See the long comment on searchSessionsImpl for the why. */
export function mergeForkRows(rows: any[], limit: number): any[] {
  const merged = new Map<string, any>();
  for (const row of rows) {
    const existing = merged.get(row.id);
    if (!existing) {
      merged.set(row.id, { ...row });
      continue;
    }
    existing.messageCount = (existing.messageCount || 0) + (row.messageCount || 0);
    if ((row.lastMessageAt || 0) > (existing.lastMessageAt || 0)) {
      existing.lastMessageAt = row.lastMessageAt;
      existing.snippet = row.snippet;
    }
    if (!existing.title && row.title) existing.title = row.title;
  }
  return [...merged.values()]
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .slice(0, limit);
}

/** Shared message-search implementation (FTS5). Empty `rawQ` or all-
 *  sanitized-away → empty hits + no error. SQL failure → empty hits +
 *  `error: 'search index unavailable'`. */
export async function searchMessagesImpl(rawQ: string, limit: number): Promise<{ hits: any[]; error?: string }> {
  const sanitized = rawQ.replace(/[^a-zA-Z0-9_\s\-*]/g, ' ').trim();
  if (!sanitized) return { hits: [] };
  const tokens = sanitized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { hits: [] };
  const ftsExpr = tokens.map(t => t.replace(/\*+$/, '*')).join(' ');
  const escapedExpr = ftsExpr.replace(/'/g, "''");
  const sql = `
    SELECT
      m.session_id AS session_id,
      m.id AS message_id,
      m.role AS role,
      substr(m.content, 1, 160) AS snippet,
      m.timestamp AS timestamp,
      s.title AS session_title,
      s.source AS session_source
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH '${escapedExpr}'
      AND s.parent_session_id IS NULL
      AND s.source != 'tool'
      AND m.role IN ('user', 'assistant')
    ORDER BY m.timestamp DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await sqlQuery(HERMES_STATE_DB, sql);
    return { hits: rows };
  } catch (e: any) {
    console.error('hermes search (messages) failed:', e.message);
    return { hits: [], error: 'search index unavailable' };
  }
}
