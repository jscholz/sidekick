// Shared SQL fragments for hermes session walks. Hermes' compression-
// rotation mechanism creates a parent_session_id chain from any
// session up to its root and back down through descendants; multiple
// callsites need the same recursive CTE to resolve a single uuid into
// its whole chain (delete cascade, message read across rotations, etc.).
//
// See server-lib/backends/hermes/search.ts for the canonical mental-
// model anchor on why these chains exist and how they fork.

/** Build the body of a `WITH RECURSIVE` block that resolves the chain a
 *  given session belongs to. Walks `parent_session_id` upward to the
 *  root, then back downward through every descendant. The CTE exposes
 *  one usable term: `chain(id)` — every session UUID in the rotation
 *  chain (including the input uuid itself, the root, and any siblings
 *  reached through the root).
 *
 *  Use it inline:
 *
 *    `WITH RECURSIVE ${chainCteFromSession(uuid)} SELECT ... IN (SELECT id FROM chain)`
 *
 *  The caller is responsible for SQL-injection safety on `uuid` — every
 *  current callsite validates against `/^[a-zA-Z0-9_-]+$/` before
 *  passing the value through. */
export function chainCteFromSession(uuid: string): string {
  return `
    up(id) AS (
      SELECT id FROM sessions WHERE id='${uuid}'
      UNION ALL
      SELECT s.parent_session_id FROM sessions s JOIN up ON s.id = up.id
        WHERE s.parent_session_id IS NOT NULL
    ),
    root(id) AS (SELECT id FROM up WHERE id IN (SELECT id FROM sessions WHERE parent_session_id IS NULL)),
    chain(id) AS (
      SELECT id FROM root
      UNION ALL
      SELECT s.id FROM sessions s JOIN chain ON s.parent_session_id = chain.id
    )`;
}
