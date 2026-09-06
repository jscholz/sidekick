/**
 * @fileoverview Durable-vs-synthetic key classification.
 *
 * `BubbleSpec.key` (projection.ts) becomes the row's `data-key` in the
 * DOM. Most keys are real message ids the server can look up: durable
 * rows key off `parley_id || id` (userKey/assistantKey, projection.ts),
 * which is one of `umsg_<epoch-ms>_…` (client-minted user sends,
 * main.ts), `msg_…` / `notif_…` / `sk-<unix>-<seq>` (plugin/state.db-
 * minted — see backends/hermes/plugin/parley_db.py's `id TEXT PRIMARY
 * KEY` comment and the openclaw schema, which enumerate exactly these
 * four shapes plus bare numeric ids), a bare numeric `id` (state.db
 * rowid, used when `parley_id` is absent), or `legacy:<state_id>`
 * (projection.ts step 1 comment — a reconcile-twin row the plugin
 * still persists under a real, fetchable id despite the odd shape).
 * Every one of these exists as a row the server can center an `around=`
 * window on.
 *
 * A handful of keys are SYNTHETIC: minted client-side by `project()`
 * for rows that never round-trip through the server. Persisting one of
 * these as a scroll anchor or a pin/activity target and later feeding
 * it back as `around=<key>` returns nothing — this morning's field bug
 * (`around=pending:turn:umsg_…` from a pin/activity prewarm, UX_DETERM-
 * INISM_PLAN.md §1) is exactly that shape, and projection.ts's own
 * comments record a sibling ("mark-unread wrote an activity row keyed
 * pending:turn:*").
 *
 * `isDurableMessageKey` is the one predicate every writer/reader of a
 * persisted anchor should consult before trusting a bubble's key as a
 * message id.
 */

// Prefixes minted ONLY by projection.ts (or its direct collaborators)
// for rows that have no server-side existence. Listed with the exact
// mint site so a future synthetic shape gets added here instead of
// silently slipping through.
const SYNTHETIC_KEY_PREFIXES: readonly string[] = [
  // Local thinking placeholder — project() step 5 splices this directly
  // after the newest live user bubble while a reply is in flight
  // (`pending:turn:${userKey}`). Retired the moment a real reply_delta/
  // reply_final lands; never durable.
  'pending:',
  // Two distinct mints share this prefix, neither ever server-side:
  //   - Activity-row keys, `turn:${userKey}` / `turn:orphan:${ts}`
  //     (project() steps 1–2, `currentTurnKey` / `ensureActivityRow`) —
  //     a grouping row for a turn's tool calls, not a message.
  //   - The bottom "agent is working" indicator, fixed key `turn:status`
  //     (project() step 6).
  'turn:',
  // Discontinuity marker between two non-contiguous durable runs,
  // `gap:${olderId}:${newerId}` (project() step 1). Synthetic by
  // construction — there is no row to fetch "around".
  'gap:',
  // Client-only system line decoration, `deco_${ts}_${rand}`
  // (src/chat.ts pushDecoration-equivalent write site; see
  // ChatState.decorations / SystemDecoration in types.ts).
  'deco_',
  // Voice-memo playback card decoration, `memo:${memoId}`
  // (src/memoOutbox.ts / src/main.ts). The memo's data lives in the
  // voiceMemos IDB store, never in state.db.
  'memo:',
  // Ephemeral inflight notification minted with no parley_id yet,
  // `inflight:${ts}` (project() step 2, the `notification` envelope
  // case). Exists only until the durable row lands under its real key.
  'inflight:',
];

/**
 * True iff `key` is a real, server-fetchable message id — i.e. safe to
 * persist as a scroll anchor, a pin, or an activity-tray target, and
 * safe to feed back into `GET .../items?around=<key>`.
 *
 * Deny-list first (the synthetic prefixes above, each minted by a named
 * site in projection.ts or a decoration writer), then a shape sanity
 * check: every durable key format enumerated above is a single token
 * with no embedded whitespace. A key that fails both is treated as
 * durable by default (real ids we haven't special-cased, e.g. a future
 * plugin-minted prefix) — this predicate exists to catch KNOWN
 * synthetic shapes, not to whitelist a closed id grammar.
 */
export function isDurableMessageKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  for (const prefix of SYNTHETIC_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return false;
  }
  // Whitespace/newlines never appear in any real id shape above; a key
  // that has one isn't a message id even if it dodges the prefix list.
  if (/\s/.test(key)) return false;
  return true;
}
