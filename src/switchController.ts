/**
 * @fileoverview Single owner of the session-switch epoch.
 *
 * Session focus used to live in three loosely-coupled globals inside
 * sessionDrawer (optimisticActiveId, viewedSessionId, resumeGen), read
 * with inconsistent precedence at ~15 sites — and only resumeGen carried
 * any epoch protection, scoped to resume()'s own body. The result was a
 * split-brain: the drawer highlight (painted by refresh() off a stale
 * pre-await snapshot) and the transcript (gated by a lagging viewed id)
 * could disagree, producing the A→B→A highlight bounce on slow links.
 *
 * This module makes "which switch is current" a single source of truth.
 * A switch mints one token via begin(); EVERY async continuation that
 * wants to write focus, highlight, or transcript checks isCurrent(tok)
 * (or routes through ifStillFocused) and no-ops when superseded. Only the
 * latest switch can write.
 *
 * Epoch alone is not enough: it is last-writer-wins, and for two years a
 * programmatic navigation had exactly the same standing as a finger on a
 * row. On 2026-09-06 that cost a real mis-send — the user tapped a
 * session on a slow radio, and 3s later the boot restore of the
 * last-viewed chat reached its begin(), took the newer generation, and
 * repainted a different chat under him; nine minutes later a dictation
 * went to it. (docs/UX_DETERMINISM_PLAN.md §1. The boot site's comment
 * claimed the token protected "a user click landing DURING the slow boot
 * fetch" — true only for clicks AFTER boot's begin(); a click BEFORE it
 * was superseded BY boot.)
 *
 * So begin() also takes an AUTHORITY: every navigation declares a
 * NavOrigin, which is either user-class (tap, keyboard, cmd-K, a push
 * notification the user tapped, a drill from pins/activity/banner) or
 * programmatic (boot restore, most-recent fallback, reconcile, prewarm).
 * The rule, one line: **once the user has navigated this app-session, a
 * programmatic begin() is refused** — it returns null, bumps nothing,
 * touches nothing, and its caller abandons. A user begin() always
 * succeeds and still wins on generation against an earlier user begin.
 * This sits ON TOP of the token model rather than replacing it
 * (UX_DETERMINISM_PLAN §6 rule 6): every continuation still carries and
 * checks its token.
 *
 * State machine:
 *   - `optimistic` — the row to highlight while a switch is in flight.
 *     Set synchronously at click/begin so refresh() paints the clicked
 *     row even before the transcript fetch resolves.
 *   - `viewed` — the session whose transcript is COMMITTED on screen.
 *     Promoted from optimistic on the first render (cache or, for a cold
 *     chat, server) via commit(). This is what the live-delta / SSE /
 *     engagement gates read.
 *   - `gen` — monotonic generation. A GRANTED begin() bumps it; a token
 *     is "current" iff its gen still equals the live gen. A refused
 *     begin() leaves it alone, so nothing in flight is disturbed.
 *   - `userNavigated` — sticky for the app session; set by the first
 *     user-class begin(). The authority gate reads only this.
 *   - `ledger` — a 100-entry ring of every begin() and how it ended
 *     (begun / committed / superseded / refused), mirrored read-only at
 *     `window.__parleyNav` and sampled into the send-time diag in
 *     proxyClient.sendMessage. The 2026-09-06 incident had to be
 *     reconstructed from SERVER logs because the client recorded nothing
 *     about which navigation put that chat on screen; this is that
 *     evidence (UX_DETERMINISM_PLAN §5 Phase 0.3).
 *
 * The token carries an optional targetMessageId (the pin/activity drill
 * anchor) so a future range-aware cache can resolve "which cached window
 * to paint for this switch" without a side channel — the controller owns
 * WHAT we're switching to (session + anchor); sessionCache owns the best
 * cached range for that target.
 *
 * Pure leaf module: no app imports, so it stays trivially testable and
 * cycle-free (its ONE ambient touch is the guarded window.__parleyNav
 * getter at the bottom — diagnostics, no behaviour). The side effects of
 * "a view changed" (badge clear, activity read-marking, reportChatSwitch,
 * highlight clear) stay in sessionDrawer.setViewed — this module only
 * owns the identity + epoch + authority.
 */

export interface SwitchToken {
  readonly gen: number;
  readonly id: string;
  /** Pin/activity drill anchor, if this switch targets a specific bubble. */
  readonly targetMessageId?: string;
}

/** Paint authority for a chat that is ALREADY focused — background
 *  reconciles (foreground resume, post-final durable refresh) that
 *  repaint what's on screen rather than switching to something new.
 *  Dies the moment focus moves: focus flips synchronously at click
 *  (setOptimistic), so a continuation holding a ViewToken for the old
 *  chat can never paint over the new one. Distinguished from
 *  SwitchToken by the absence of `gen`. */
export interface ViewToken {
  readonly view: true;
  readonly id: string;
}

/** What paint paths accept: a supersedable switch (authorizes TAKING
 *  OVER the pane) or a view token (authorizes REPAINTING the focused
 *  chat). Checked by canPaint at paint time, not mint time. */
export type PaintToken = SwitchToken | ViewToken;

/** Mint a view token for a chat believed to be on screen. Cheap and
 *  unconditional — validity is evaluated by canPaint() when the paint
 *  actually happens, which is what makes late continuations safe. */
export function viewTokenFor(id: string): ViewToken {
  return { view: true, id };
}

/** THE paint gate (hardening invariant #1): may `tok` write the
 *  transcript pane right now? Switch tokens paint while their epoch is
 *  live; view tokens paint while their chat is still the focused one.
 *  Every replay/resume render funnels through this via
 *  replaySessionMessages — call sites don't hand-roll epoch checks. */
export function canPaint(tok: PaintToken): boolean {
  if ('gen' in tok) return tok.gen === gen;
  return focusedId() === tok.id;
}

/** Who asked for this navigation. Required at begin() — positional, not
 *  optional, so adding an origin is a type error at every call site
 *  rather than a silent default that classifies a new caller wrong.
 *
 *  user-class:
 *    tap       — a sidebar row click
 *    keyboard  — arrow-nav in the session list
 *    cmdk      — a cmd-K palette pick
 *    push-tap  — a push notification the user tapped (reserved: the CAP
 *                path currently arrives as a ?chat= deep link)
 *    deep-link — a ?chat=/&msg= URL landing. The OS opened it, but a
 *                human tapped the notification that produced it, so it
 *                outranks anything programmatic.
 *    drill     — "open in chat" from pins / activity / in-app banner /
 *                question popup
 *    delete-landing — where we land after the user deletes the chat they
 *                were viewing. Not a race: it is the direct continuation
 *                of a user gesture, and refusing it would strand the user
 *                on a deleted chat's transcript.
 *  programmatic:
 *    boot      — the boot restore of the last-viewed / pinned chat
 *    fallback  — boot's most-recent landing when the restore came back
 *                empty
 *    reconcile — a background repaint that re-aims the pane (none today;
 *                reconciles use ViewToken)
 *    prewarm   — a speculative fetch/paint (none today) */
export type NavOrigin =
  | 'tap' | 'keyboard' | 'cmdk' | 'push-tap' | 'deep-link' | 'drill' | 'delete-landing'
  | 'boot' | 'fallback' | 'reconcile' | 'prewarm';

/** THE authority rule, as a pure function so it is testable and so the
 *  classification lives in exactly one place. */
export function originClass(o: NavOrigin): 'user' | 'programmatic' {
  switch (o) {
    case 'tap':
    case 'keyboard':
    case 'cmdk':
    case 'push-tap':
    case 'deep-link':
    case 'drill':
    case 'delete-landing':
      return 'user';
    default:
      return 'programmatic';
  }
}

/** How a navigation ended.
 *    begun      — minted, still in flight (or never resolved: the app
 *                 was closed, the fetch is still out)
 *    committed  — its transcript reached the screen (commit())
 *    superseded — a newer begin()/invalidate() took the epoch first
 *    refused    — the authority rule rejected it; nothing was touched */
export type NavOutcome = 'begun' | 'committed' | 'superseded' | 'refused';

export interface NavLedgerEntry {
  readonly t: number;
  readonly gen: number;
  readonly id: string;
  readonly origin: NavOrigin;
  /** Mutated in place as the navigation resolves — an entry is written
   *  once at begin() and later stamped by commit()/supersede. */
  outcome: NavOutcome;
}

/** Ring cap. Big enough to hold a boot plus a long session's worth of
 *  switches, small enough that keeping it costs nothing. */
const NAV_LEDGER_CAP = 100;

let gen = 0;
let optimistic: string | null = null;
let viewed: string | null = null;
/** Sticky for the app session — see the header. Only a GRANTED
 *  user-class begin() sets it. */
let userNavigated = false;
const ledger: NavLedgerEntry[] = [];
/** The most recent granted entry that hasn't resolved yet, so a
 *  supersede/commit can stamp it without scanning. Null once resolved. */
let liveEntry: NavLedgerEntry | null = null;

function record(entry: NavLedgerEntry): NavLedgerEntry {
  ledger.push(entry);
  if (ledger.length > NAV_LEDGER_CAP) ledger.shift();
  return entry;
}

/** Stamp the in-flight navigation as beaten. Called by begin() and
 *  invalidate() — the two ways an epoch dies. */
function supersedeLive(): void {
  if (liveEntry && liveEntry.outcome === 'begun') liveEntry.outcome = 'superseded';
  liveEntry = null;
}

/** Open a new switch: bump the generation and claim the optimistic
 *  highlight synchronously. Returns the token that authorizes every
 *  subsequent write for THIS switch — or **null when the authority rule
 *  refuses it**, which happens only for a programmatic origin after the
 *  user has navigated. A refusal is inert by construction: no generation
 *  bump, no optimistic claim, nothing in flight disturbed. Callers must
 *  abandon on null (no paint, no resumeSession, no highlight change);
 *  the ledger records why. */
export function begin(id: string, origin: NavOrigin, targetMessageId?: string): SwitchToken | null {
  if (originClass(origin) === 'programmatic' && userNavigated) {
    // Record the generation it WOULD have taken — the counter itself is
    // deliberately untouched, so the live switch keeps its epoch. That
    // makes `gen` non-unique in the ledger (the refusal and whichever
    // navigation later claims that number both carry it); read a gen as
    // an epoch only on entries that aren't `refused`.
    record({ t: Date.now(), gen: gen + 1, id, origin, outcome: 'refused' });
    return null;
  }
  supersedeLive();
  gen += 1;
  optimistic = id;
  if (originClass(origin) === 'user') userNavigated = true;
  liveEntry = record({ t: Date.now(), gen, id, origin, outcome: 'begun' });
  return { gen, id, targetMessageId };
}

/** True once any user-class begin() has been granted this app-session.
 *  Boot reads it to abandon its restore outright rather than race — the
 *  begin() refusal is the safety net, this is the readable intent. */
export function hasUserNavigated(): boolean {
  return userNavigated;
}

/** Read-only snapshot of the navigation ledger, oldest first. Copies the
 *  entries so a caller (or the console) can't rewrite history. */
export function getNavLedger(): NavLedgerEntry[] {
  return ledger.map((e) => ({ ...e }));
}

/** True iff `tok` is still the live switch (no newer begin()/invalidate()
 *  has superseded it). Async continuations gate on this. */
export function isCurrent(tok: SwitchToken): boolean {
  return tok.gen === gen;
}

/** Supersede the current switch without starting a new one — used when a
 *  chat is deleted out from under an in-flight resume so its render
 *  continuation bails. Callers clear optimistic/viewed as appropriate. */
export function invalidate(): void {
  supersedeLive();
  gen += 1;
}

/** Commit `tok`'s session as the on-screen view (optimistic → viewed),
 *  iff still current. Returns whether the commit happened. No-op when
 *  superseded so a stale render can't claim the view. */
export function commit(tok: SwitchToken): boolean {
  if (tok.gen !== gen) return false;
  viewed = tok.id;
  if (liveEntry && liveEntry.gen === tok.gen) {
    liveEntry.outcome = 'committed';
    // Resolved: a later begin() must not re-stamp it as superseded.
    liveEntry = null;
  }
  return true;
}

/** Highlight/engagement focus: the in-flight click target if any, else
 *  the committed view. */
export function focusedId(): string | null {
  return optimistic ?? viewed;
}

/** The session whose transcript is committed on screen — what the
 *  live-delta / SSE / render gates compare against. */
export function viewedId(): string | null {
  return viewed;
}

/** The in-flight switch target, or null when no switch is pending. */
export function optimisticId(): string | null {
  return optimistic;
}

/** Synchronously claim the optimistic highlight without minting a token —
 *  the click/keyboard/drill handlers call this so a scheduleRefresh racing
 *  the async resume() paints the clicked row, not the old one. */
export function setOptimistic(id: string | null): void {
  optimistic = id;
}

/** Set the committed view directly (raw — no side effects). The
 *  side-effecting entry point is sessionDrawer.setViewed. */
export function setViewed(id: string | null): void {
  viewed = id;
}

/** Clear the optimistic highlight iff `tok` is still current and it still
 *  points at `tok.id` — the resume() finally-block cleanup. A newer switch
 *  already owns optimistic; touching it would corrupt that switch. */
export function clearOptimisticIfCurrent(tok: SwitchToken): void {
  if (tok.gen === gen && optimistic === tok.id) optimistic = null;
}

/** Run `fn` only if focus hasn't moved away from `expectedId` — the guard
 *  for fire-and-forget repaints / reconciles that don't own a token
 *  (refresh repaint, onResume SSE reconcile, pollers). */
export function ifStillFocused(expectedId: string | null, fn: () => void): void {
  if (focusedId() === expectedId) fn();
}

// Diagnostics mirror: `window.__parleyNav` in the console (or a smoke's
// page.evaluate) answers "what navigated this app, in what order, and
// which ones lost" without a rebuild or a server log. A getter, not a
// field, so it can't go stale — and it hands back getNavLedger()'s copy,
// so poking at it in the console can't corrupt the real ledger.
// Guarded on `window` because this module is unit-tested under plain
// node, and wrapped because a hardened/frozen window must not take the
// app down over a debug aid.
if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, '__parleyNav', {
      get: () => getNavLedger(),
      configurable: true,
    });
  } catch { /* diagnostics are optional */ }
}
