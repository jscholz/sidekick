/**
 * @fileoverview Chat transcript — line rendering, speaker labels, copy button.
 */

import { escapeHtml } from './util/dom.ts';
import { miniMarkdown, renderUserText, linkifyCaptureDocs } from './util/markdown.ts';
import { diag, log, isDebugEnabled } from './util/log.ts';
import {
  ensureSchemaFresh,
  loadSnapshot,
  saveSnapshot,
  clearSnapshot,
} from './chatSnapshot.ts';
import {
  hydrateScrollPositions,
  saveScrollPosition,
  flushScrollPosition,
  getScrollPosition,
} from './chatScrollPositions.ts';
import { isPinned as isPinMsg, pinMessage, unpinMessage, hydrate as hydratePins } from './pins/store.ts';
import { markUnread as markChatUnread } from './notifications/badge.ts';
import { markUnreadForMessage } from './notifications/activityStore.ts';
import { toast } from './toast.ts';
import * as backend from './backend.ts';
import { rerenderActive, isBackfillActive } from './transcript/index.ts';
import * as transcriptStore from './transcript/store.ts';
import * as switchCtl from './switchController.ts';
import { isDurableMessageKey } from './transcript/keys.ts';

let transcriptEl: HTMLElement | null = null;

/** Where legacy addLine consumers (system delimiter, backfill replay)
 *  should hand their `.line` divs. */
function contentTarget(): HTMLElement | null {
  return transcriptEl;
}
let scrollToBottomBtn: HTMLElement | null = null;
const speakerNames: Record<string | number, string> = {};
let speakerCount = 0;

/** In-memory mirror of the session id the current chat view corresponds to.
 *  Set by replaySessionMessages → trackViewedSession(id), cleared on
 *  chat.clear() so a New chat rotation doesn't keep a stale id in the
 *  next persisted snapshot. Stored alongside the HTML on persist so
 *  reload can restore the drawer highlight to the right row. */
let viewedSessionIdRef: string | null = null;

/** localStorage key holding the id of the session currently on screen.
 *  #225: the id used to live only inside the IDB snapshot, which is
 *  unreliable across exactly the reloads that need it — persist() is
 *  debounced + refused while a floating drill window is up, and
 *  ensureSchemaFresh nukes the snapshot DB on the first boot after a
 *  schema bump (i.e. on the reload a deploy forces). Written
 *  synchronously on every switch so ANY reload lands on the chat the
 *  user was actually viewing instead of falling through to the
 *  most-recent/pinned chat. */
const VIEWED_SESSION_LS_KEY = 'parley.viewed-session-id';

/** Per-msgId fold state. The "Show more / Show less" toggle on long
 *  bubbles needs to survive virt unmount/remount: a bubble scrolled
 *  outside the visible window is destroyed, its expanded class lost.
 *  Map lookup at addLine time restores the user's toggle. Cleared on
 *  chat.clear (New chat rotation) so the keyspace can't grow without
 *  bound. Module-level — same shape as pin store, simple + cheap. */
const foldStateByMsgId = new Map<string, 'expanded' | 'collapsed'>();

/** Let main.ts record which session the chat is currently rendering.
 *  Drawer reads it back after boot via getViewedSessionId() — survives
 *  page reload because we persist it in the chat snapshot. */
export function trackViewedSession(id: string | null) {
  if (id !== viewedSessionIdRef) {
    // Unread badge is per-viewed-chat — don't leak a count (or the
    // counted-id dedup set) across a session switch.
    missedWhileScrolled = 0;
    unreadSeenIds.clear();
    updateButton();
  }
  viewedSessionIdRef = id;
  // Synchronous write — survives any reload (SW update, crash, schema-bump
  // IDB nuke) even when the async/refusable snapshot persist below lags.
  try {
    if (id) localStorage.setItem(VIEWED_SESSION_LS_KEY, id);
    else localStorage.removeItem(VIEWED_SESSION_LS_KEY);
  } catch { /* private mode */ }
  persist();  // update the snapshot so reload picks it up
}

/** Return the session id the restored snapshot belongs to, if any.
 *  Called by main.ts boot to re-seed the drawer highlight after
 *  restoreSnapshot(). */
let restoredViewedSessionId: string | null = null;
export function getRestoredViewedSessionId(): string | null {
  return restoredViewedSessionId;
}

/** Pixels from bottom within which the user is considered "pinned" to the
 *  live edge — new messages auto-scroll. Past this threshold (they've
 *  scrolled up to read earlier content), auto-scroll is suspended and the
 *  jump-to-bottom button appears.
 *
 *  Generous threshold (300px) so user-scroll-to-near-the-edge still
 *  counts as pinned and autoScroll keeps following streaming replies. */
const PINNED_THRESHOLD_PX = 300;

let pinnedToBottom = true;
// Gesture-beats-geometry (field 2026-08-09, "network glitchiness" that
// wasn't): the scroll listener re-derives pinnedToBottom from GEOMETRY,
// and PINNED_THRESHOLD_PX is a generous 300px — so scrolling up to the
// start of a still-short STREAMING reply left the user inside the
// threshold, geometry re-latched pinned=true, and the next delta's
// autoScroll yanked them back to the bottom (repeatedly, until the
// message outgrew 300px). A deliberate upward gesture now unpins
// immediately and holds the geometric re-latch long enough for the
// gesture (incl. trackpad inertia ticks) to finish; scrolling back to
// the bottom after the hold re-pins as before.
let pinRelatchHoldUntil = 0;
let lastScrollTopSeen = 0;
// Distance-from-bottom measured at the last SCROLL EVENT — the
// pre-growth truth. autoScroll's lazy re-latch can't measure live:
// by the time it runs, the delta that triggered it has already grown
// scrollHeight, inflating the apparent distance (28px parked read as
// 160px after one delta).
let lastScrollEventDist = 0;
const PIN_RELATCH_HOLD_MS = 400;
const UPWARD_GESTURE_FRESH_MS = 400;
/** While `Date.now() < unpinnedHoldUntil`, the scroll listener must NOT
 *  re-derive pinnedToBottom from geometry — it stays false. Set by
 *  drillScrollTo (via holdUnpinnedFor): a drill's programmatic scroll can
 *  land clamped at the bottom when the target bubble is transiently
 *  mis-sorted to the tail (live-envelope timestamp, pre-durable-heal), and
 *  the geometric re-derivation would re-latch pinned=true — so the
 *  reconcile re-sort's rerender autoScroll snaps to the live edge and the
 *  drilled bubble scrolls out of view (the depin-vs-reconcile-repin race,
 *  field 2026-07-21 activity-row-drills-to-bubble 2/5 flake). Cleared by a
 *  real user gesture (user reclaims the scroll), by forceScrollToBottom /
 *  setPinnedToBottom(true) (explicit re-pins win), or by expiry. */
let unpinnedHoldUntil = 0;
let missedWhileScrolled = 0;
/** Message ids already counted toward (or exempt from) the unread badge.
 *  Dedups the many envelopes one message produces (delta…delta…final…
 *  durable echo) down to one badge unit. Ids first seen while PINNED are
 *  also recorded — the user watched that message arrive, so deltas that
 *  keep streaming after they scroll up must not count it. */
const unreadSeenIds = new Set<string>();

/** When true, the transcript `scroll` listener skips its
 *  saveCurrentScrollPosition() write. Set briefly by the switch-then-load
 *  clear: emptying the transcript collapses its scrollHeight, which fires
 *  a scroll-to-0 event WHILE viewedSessionIdRef still points at the
 *  LEAVING chat — without this guard that synthetic scroll overwrites the
 *  leaving chat's just-saved (real) position with scrollTop=0 and a
 *  garbage anchor, so switch-back restores to the wrong place. The explicit
 *  save in
 *  resume() already ran before the clear, so suppressing here loses
 *  nothing. */
let scrollSaveSuppressed = false;
/** Run `fn` (the transcript clear) with scroll-save suppressed, then
 *  re-enable on the next macrotask so the synchronous + any same-tick
 *  scroll events triggered by the clear are all skipped, but genuine
 *  user/restore scrolls afterward save normally. */
export function runWithScrollSaveSuppressed(fn: () => void): void {
  scrollSaveSuppressed = true;
  try { fn(); }
  finally {
    // Defer re-enable past the synchronous scroll dispatch the clear
    // induced. setTimeout(0) lands after the browser flushes the scroll
    // event queue for this clamp.
    setTimeout(() => { scrollSaveSuppressed = false; }, 0);
  }
}

/** Capture the first bubble whose top is at/below the viewport top, plus
 *  its pixel offset from the viewport top. This is the user-meaningful
 *  scroll anchor: restoring it puts the SAME message back at the SAME
 *  place, regardless of how off-screen content above re-measures (which
 *  is what raw scrollTop can't survive once `content-visibility: auto`
 *  renders off-screen rows from 100px placeholders to their real height).
 *  Every bubble is in the DOM (full-DOM render), so this is a direct
 *  query — no spacer math.
 *
 *  Skips past rows whose key is SYNTHETIC (the local thinking
 *  placeholder, the bottom turn-status line, gap markers, decorations —
 *  see src/transcript/keys.ts) to the next visible row that's a real
 *  message. This anchor gets persisted (saveCurrentScrollPosition) and
 *  later fed back as `around=<key>`; a synthetic key there returns
 *  nothing server-side (field 2026-09-05: boot's prewarm for
 *  `pending:turn:umsg_…`). If every visible row is synthetic, returns
 *  null so the caller falls back to a scrollTop-only save. */
export function getDomAnchor(): { key: string; offsetPx: number } | null {
  if (!transcriptEl) return null;
  const ct = transcriptEl.getBoundingClientRect().top;
  for (const el of Array.from(transcriptEl.querySelectorAll('.line[data-key]')) as HTMLElement[]) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= ct + 1) continue;
    const key = el.getAttribute('data-key') || '';
    if (!isDurableMessageKey(key)) continue;
    return { key, offsetPx: Math.round(r.top - ct) };
  }
  return null;
}

/** Restore a DOM anchor: scroll so the keyed bubble sits at `offsetPx`
 *  from the viewport top. Re-applies after a layout frame because
 *  `content-visibility` placeholders above the anchor settle to real
 *  heights once rendered, nudging the anchor. Returns false if the keyed
 *  bubble isn't in the DOM (paginated out / deleted) so the caller can
 *  fall back to a raw scrollTop restore. */
let _restoreAnchorGen = 0;
export function restoreDomAnchor(anchor: { key: string; offsetPx: number }): boolean {
  if (!transcriptEl || !anchor.key) return false;
  const el = transcriptEl;
  const target = el.querySelector(`.line[data-key="${CSS.escape(anchor.key)}"]`) as HTMLElement | null;
  if (!target) return false;
  // Converge across frames: each frame, re-seat the anchor at offsetPx.
  // Needed because `content-visibility: auto` rows above the anchor start
  // as 100px placeholders and settle to real heights as they render into
  // view — each settle shifts the anchor, so a single scroll undershoots.
  // Also absorbs a transient scrollTop reset fired mid-render (render-race).
  // Bails when stable or after ~20 frames; a newer restore supersedes via
  // the gen.
  const gen = ++_restoreAnchorGen;
  let frames = 0;
  let stable = 0;
  const step = () => {
    if (transcriptEl !== el || gen !== _restoreAnchorGen || !target.isConnected) return;
    const ct = el.getBoundingClientRect().top;
    const delta = (target.getBoundingClientRect().top - ct) - anchor.offsetPx;
    // Each re-seat absorbs whatever layout shifted since the last frame —
    // tell the relative settle compensator so it re-baselines instead of
    // adding its own delta for the same shift.
    if (Math.abs(delta) >= 1) { noteAbsoluteScrollSeat(); el.scrollTop += delta; stable = 0; }
    else stable++;
    // Don't bail on the first zero-delta: the rows ABOVE the anchor start
    // as 100px `content-visibility` placeholders and render to real height
    // over the next several frames, each pushing the anchor down. Keep
    // re-seating until the anchor holds for a few consecutive frames (or a
    // ~0.5s cap), so we converge to the settled layout, not the placeholder
    // one.
    if (stable < 3 && ++frames < 30) requestAnimationFrame(step);
  };
  step();
  return true;
}

/** User-gesture guard (#202, field 2026-06-12): a wheel/touch/pointer
 *  gesture on the transcript marks the scroll position as user-owned.
 *  Any in-flight anchor-restore convergence loop is cancelled (gen bump)
 *  so it can't fight the user's scrolling, and resume paths consult the
 *  timestamp to skip saved-position restores that would yank the view
 *  while the user is actively reading/scrolling (slow-link server
 *  callbacks arrive seconds after the cache render). */
let lastUserGestureAt = 0;
export function lastUserScrollGestureAt(): number { return lastUserGestureAt; }
export function cancelPendingScrollRestores(): void { _restoreAnchorGen++; }

/** ── [scroll-jump] Relative settle compensator (field 2026-07-27) ──────
 *  "when I'm scrolling in sessions the scroll often JUMPS … goes away
 *  when everything is loaded."
 *
 *  The app leans on the browser's native CSS scroll anchoring
 *  (`overflow-anchor: auto`, styles/app.css "our scroll-jump fix") to keep
 *  the viewport stable while content ABOVE it changes height — which it
 *  does constantly during scroll-up backfill: `.line` rows start as 100px
 *  `contain-intrinsic-size` placeholders and settle to real heights as
 *  they become render-relevant, churning scrollHeight ±30–105px/frame.
 *  iOS WKWebView (the CAP app — the field platform) implements NO CSS
 *  scroll anchoring, and the one app-level compensator on this path
 *  (prependHistory → restoreDomAnchor) is an ABSOLUTE re-seat whose
 *  convergence loop is gesture-cancelled (#202) — correct for
 *  saved-position restores, dead for the whole momentum fling. Every
 *  settle above the viewport then lands uncompensated: 53–104px eye-level
 *  jumps, repeatedly, until every row has rendered once (measured 19×/run
 *  by scripts/scroll-jump-diag-harness.mjs --no-anchor; 0× with Chromium
 *  anchoring on).
 *
 *  This loop is the RELATIVE compensator that survives gestures: track
 *  the first-visible bubble's CONTENT-SPACE offset (rect.top − transcript
 *  rect.top + scrollTop — pure layout, unchanged by any scrolling); when
 *  it moves by d, content above the viewport changed height, so apply
 *  scrollTop += d. Relative deltas compose with concurrent user scrolling
 *  — user input changes scrollTop, never a bubble's content offset — so
 *  unlike restoreDomAnchor this loop must NOT be gesture-cancelled;
 *  that's the whole point.
 *
 *  Interplay (don't fight the existing scroll owners):
 *   - Native anchoring: the correction is applied ONLY while the
 *     transcript's effective `overflow-anchor` is none (WebKit — or the
 *     harness emulating it). Under Chromium's anchoring the browser has
 *     ALREADY moved scrollTop by d when we'd measure, so adding our own d
 *     would double-compensate (content offset is layout truth and shifts
 *     by d regardless of who fixed scrollTop). Gated per-frame on
 *     computed style, not a boot-time capability check, so the harness's
 *     injected `overflow-anchor: none` engages it on Chromium too.
 *   - Pinned-to-bottom: while pinned AT the live edge, bottom-following
 *     (autoScroll / forceScrollToBottom / at-bottom repin) is the desired
 *     behavior and owns scrollTop — the loop stands down there and
 *     re-arms on the next transcript gesture / unpinned scroll. The
 *     stand-down is the LITERAL bottom edge (≤8px), not the generous
 *     300px pinned flag: a wheel-up's first ~300px keeps the flag true,
 *     and the near-tail placeholders settling right at drive start were
 *     the one jump that survived the flag-gated version (smoke, t≈150ms
 *     into the drive). Off the edge, compensating composes fine with
 *     bottom-following — its writes are scroll-only and never move a
 *     bubble's content offset, so they can't trigger us.
 *   - Absolute re-seats (restoreDomAnchor step writes, prependHistory's
 *     scrollHeight-diff fallback, drillScrollTo's target seat): each one
 *     bumps a generation via noteAbsoluteScrollSeat(); the first
 *     correction that observes a new generation ADOPTS the current layout
 *     as its new baseline instead of adding its own delta — the seat
 *     already accounted for the shift. One-shot: the very next settle is
 *     compensated again (a fixed time window here would eat the settle
 *     burst that follows a prepend and let jumps through).
 *   - Drill anchor defense (holdUnpinnedFor window): drillScrollTo's
 *     MO/RO/poll re-seats a SPECIFIC target at a fixed offset for
 *     DRILL_SETTLE_MS — same horizon as the unpinned hold — so while the
 *     hold is live the loop only re-baselines. A user gesture clears the
 *     hold AND stands the drill defense down, handing settles to us.
 *
 *  Corrections run from a ResizeObserver on the rows (fires post-layout,
 *  pre-paint — the settle is corrected in the SAME rendering update, so
 *  neither the user nor a rAF sampler ever sees the shifted frame) with a
 *  per-frame rAF tick as backstop + anchor/baseline maintenance. Writes
 *  go through el.scrollTop and are therefore visible to the [scroll-write]
 *  debug trace; each correction also emits a [scroll-jump] diag line. */
const NATIVE_ANCHORING_SUPPORTED =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
  && CSS.supports('overflow-anchor: auto');

let _absoluteSeatGen = 0;
/** Called by every ABSOLUTE scroll re-seat that compensates a layout shift
 *  itself (restoreDomAnchor, prependHistory fallback, drillScrollTo). The
 *  settle compensator re-baselines instead of double-correcting the shift
 *  that seat already absorbed. Scroll-only writes (autoScroll, saved
 *  scrollTop restores) never need this — they don't change any bubble's
 *  content offset, so the compensator is inherently a no-op for them. */
export function noteAbsoluteScrollSeat(): void { _absoluteSeatGen++; }

let settleCompensatorRunning = false;
function ensureSettleCompensator(): void {
  if (settleCompensatorRunning || !transcriptEl) return;
  if (typeof requestAnimationFrame === 'undefined') return;
  const el = transcriptEl;
  settleCompensatorRunning = true;

  /** Bottom-follow owns the viewport only when the user is pinned AND the
   *  scrollbar is at the literal edge — there the browser's own clamp
   *  keeps the tail anchored and a compensation write could pull the view
   *  up off the live edge. Everywhere else (including pinned-but-300px-up)
   *  the reading position is the thing to defend. */
  const bottomFollowOwns = (): boolean =>
    pinnedToBottom && el.scrollHeight - el.scrollTop - el.clientHeight <= 8;

  let anchorEl: HTMLElement | null = null;
  let anchorContentY = 0;
  let seatGenSeen = _absoluteSeatGen;
  // Refreshed once per rAF tick; RO callbacks between ticks reuse it.
  let nativeAnchoringActive = NATIVE_ANCHORING_SUPPORTED;

  /** Layout-truth offset of a row: scroll-independent, so user input can
   *  never masquerade as a settle (and vice versa). */
  const contentYOf = (node: HTMLElement): number =>
    node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;

  const pickAnchor = (): void => {
    anchorEl = null;
    const ct = el.getBoundingClientRect().top;
    for (const line of Array.from(el.querySelectorAll('.line[data-key]')) as HTMLElement[]) {
      const r = line.getBoundingClientRect();
      if (r.bottom > ct + 1) { anchorEl = line as HTMLElement; break; }
    }
    if (anchorEl) anchorContentY = contentYOf(anchorEl);
  };

  const correct = (src: string): void => {
    if (transcriptEl !== el || nativeAnchoringActive) return;
    if (!anchorEl || !anchorEl.isConnected) { pickAnchor(); return; }
    const y = contentYOf(anchorEl);
    if (bottomFollowOwns()) {
      // The at-bottom clamp already absorbed this shift — sanction it, so
      // a wheel-up in the next frame can't get it applied a second time.
      anchorContentY = y;
      return;
    }
    if (seatGenSeen !== _absoluteSeatGen || Date.now() < unpinnedHoldUntil) {
      // An absolute seat / drill defense owns this shift — adopt, don't add.
      seatGenSeen = _absoluteSeatGen;
      anchorContentY = y;
      return;
    }
    const d = y - anchorContentY;
    if (Math.abs(d) >= 1) {
      el.scrollTop += d;
      anchorContentY = y;
      diag(`[scroll-jump] settle-compensate d=${Math.round(d)} src=${src} anchor=${(anchorEl.getAttribute('data-key') || '').slice(0, 24)}`);
    }
  };

  // RO on every row: a content-visibility placeholder settling to real
  // height is a border-box change on that .line; the callback runs after
  // layout in the same rendering update, so the correction is painted
  // atomically with the settle. (The transcript's own box never changes —
  // observing rows, not the scroller, is load-bearing.)
  const observed = new WeakSet<Element>();
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => correct('ro'))
    : null;

  const tick = () => {
    if (transcriptEl !== el || bottomFollowOwns()) {
      // Back at the live edge (or torn down): bottom-following owns the
      // viewport; the resting state costs nothing. Gestures / unpinned
      // scrolls / mid-chat restores re-arm us.
      settleCompensatorRunning = false;
      ro?.disconnect();
      return;
    }
    nativeAnchoringActive = NATIVE_ANCHORING_SUPPORTED
      && getComputedStyle(el).getPropertyValue('overflow-anchor') !== 'none';
    if (nativeAnchoringActive) {
      // Browser owns settle compensation; drop state so a later flip to
      // `none` (harness emulation) re-baselines fresh instead of applying
      // a stale delta.
      anchorEl = null;
    } else {
      correct('raf');   // backstop for shifts the RO can't see (node inserts)
      if (ro) {
        for (const line of Array.from(el.querySelectorAll('.line'))) {
          if (!observed.has(line)) { observed.add(line); ro.observe(line); }
        }
      }
      pickAnchor();     // follow the user's reading position frame-to-frame
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** #227: true when the on-screen transcript is NOT a clean tail-anchored
 *  view — either a floating deep `around` window (hasMoreNewer) or a
 *  SPLICED view (a drilled pin window retained alongside the tail with a
 *  `…` gap row). In both cases the on-screen layout, scroll offset and
 *  pinned-ness are meaningless against the tail-only snapshot the next boot
 *  restores, so the persist/scroll-save/isPinned guards must keep the last
 *  clean tail-anchored state instead of capturing the drilled one. */
function transcriptNotTailAnchored(): boolean {
  if (paginationHasMoreNewer) return true;
  return !!transcriptEl?.querySelector('.transcript-gap');
}

export function saveCurrentScrollPosition(): void {
  if (!transcriptEl || !viewedSessionIdRef) return;
  // Tail invariant: positions inside a floating deep window OR a spliced
  // pin+tail view are ephemeral — their anchors/offsets are meaningless
  // against the tail-anchored transcript the next resume renders. Keep the
  // last tail-anchored position instead of overwriting it.
  if (transcriptNotTailAnchored()) return;
  // Capture the anchor (first-visible bubble key + offset) alongside raw
  // scrollTop. The anchor is the user-meaningful position: restore puts
  // the same message back at the same offset even as off-screen content
  // above re-measures. scrollTop is the fallback when the anchor key is
  // gone (paginated out / deleted).
  saveScrollPosition(viewedSessionIdRef, transcriptEl.scrollTop, isPinned(), getDomAnchor());
}


function isPinned(): boolean {
  if (!transcriptEl) return true;
  // A floating deep window OR a spliced pin+tail view is never "at the live
  // tail" in the user's frame — there's a discontinuity below the drilled
  // position, so live deltas must NOT stick to its bottom and the
  // jump-to-bottom affordance stays visible.
  if (transcriptNotTailAnchored()) return false;
  const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  return distance <= PINNED_THRESHOLD_PX;
}

function updateButton(): void {
  if (!scrollToBottomBtn) return;
  scrollToBottomBtn.classList.toggle('visible', !pinnedToBottom);
  scrollToBottomBtn.classList.toggle('has-unread', missedWhileScrolled > 0);
  scrollToBottomBtn.setAttribute('aria-hidden', pinnedToBottom ? 'true' : 'false');
  if (missedWhileScrolled > 0) {
    const badge = scrollToBottomBtn.querySelector('.scroll-to-bottom-badge');
    if (badge) badge.textContent = String(Math.min(missedWhileScrolled, 99));
  }
}

/** #214 TFC-badge: the jump-to-latest badge counts UNREADS — live
 *  messages (reply / notification / cross-device send) that arrived while
 *  the user was scrolled up — not "rows appended while not pinned". The
 *  counter used to live in autoScroll's else-branch, so every render
 *  pass, dictation interim update, batch flush, and resume reconcile
 *  bumped it (field 2026-06-12: badge "happens without a fresh reply,
 *  and is inconsistent"). Live ingestion sites (backendEventHandlers /
 *  backendEvents) call this instead, already replay-guarded. */
export function noteLiveMessage(chatId: string | null | undefined, messageId: string | null | undefined): void {
  const key = messageId ? String(messageId) : '';
  if (!key) return;
  // The badge belongs to the on-screen transcript. Null viewed (boot
  // race) renders to the only transcript there is — count it too.
  if (!chatId || (viewedSessionIdRef && chatId !== viewedSessionIdRef)) return;
  if (unreadSeenIds.has(key)) return;
  unreadSeenIds.add(key);
  if (pinnedToBottom) return;
  missedWhileScrolled++;
  updateButton();
}

/** Edge spinner shown while a scroll-triggered pagination load is in
 *  flight, anchored to the edge being loaded (top = older history,
 *  bottom = newer). Gives the user immediate "your scroll registered"
 *  feedback. Lazily created; CSS delays the fade-in ~150ms so an instant
 *  cache hit never flashes a spinner. */
let edgeLoaderEl: HTMLDivElement | null = null;
/** Session switches must drop a stale edge spinner: the pagination
 *  loader belongs to the chat that was scrolling, and left visible it
 *  stacks with the incoming chat's .transcript-loading — the exact
 *  duplicate-spinner case from the 2026-07-10 walking-test report. */
export function clearEdgeLoader(): void { setEdgeLoading(null); }

/** Clear the edge spinner ONLY when no pagination fetch is in flight —
 *  an in-flight load owns its spinner (its finally clears it). Called by
 *  the backfill pump's terminal paths so a spinner armed before/during a
 *  backfill can't outlive it; a legit post-backfill pagination keeps
 *  spinning untouched. */
export function clearEdgeLoaderIfIdle(): void {
  if (!paginationLoading && !paginationLoadingNewer) setEdgeLoading(null);
}

function setEdgeLoading(dir: 'earlier' | 'later' | null): void {
  const parent = transcriptEl?.parentElement;
  if (!parent) return;
  if (!edgeLoaderEl) {
    if (!dir) return; // don't create until first needed
    edgeLoaderEl = document.createElement('div');
    edgeLoaderEl.id = 'transcript-edge-loader';
    edgeLoaderEl.className = 'transcript-edge-loader';
    edgeLoaderEl.setAttribute('aria-hidden', 'true');
    edgeLoaderEl.innerHTML = '<span class="transcript-edge-spinner"></span>';
    parent.appendChild(edgeLoaderEl);
  }
  edgeLoaderEl.classList.toggle('at-top', dir === 'earlier');
  edgeLoaderEl.classList.toggle('at-bottom', dir === 'later');
  edgeLoaderEl.classList.toggle('visible', dir != null);
}

/** Unconditional scroll to the live edge. Used by initial loads,
 *  user-initiated jump-to-bottom, and anywhere we deliberately want to
 *  override the "user scrolled up" state.
 *
 *  Bypasses smooth-scroll via `behavior: 'instant'` because session-resume
 *  triggers multiple cascading scrolls (renderSession, backfillHistory,
 *  snapshot restore, image/code-block reflows) — with `scroll-behavior:
 *  smooth` in CSS each call animates separately and the user sees a stutter.
 *  Streaming deltas still go through autoScroll() which keeps smooth so the
 *  follow-along during reply still glides. */
let _stickBottomGen = 0;
export function forceScrollToBottom(): void {
  if (!transcriptEl) return;
  const el = transcriptEl;
  unpinnedHoldUntil = 0; // explicit re-pin overrides any drill hold
  pinnedToBottom = true;
  missedWhileScrolled = 0;
  updateButton();

  // CONVERGE to the true bottom across frames. Under virtualization,
  // scrollHeight is computed from per-kind height ESTIMATES for the rows
  // that aren't rendered yet (DEFAULT_HEIGHTS) — so a single
  // scrollTo(scrollHeight) lands at the *estimated* bottom. The jump
  // reveals the real bottom rows; the virtualizer's ResizeObserver then
  // measures them, scrollHeight shifts, and the view is left part-way.
  // Re-scroll to scrollHeight every frame until it stops changing (or a
  // safety cap) so we track the bottom as the revealed rows are measured.
  //
  // Bails the instant the user scrolls up: the scroll listener flips
  // `pinnedToBottom` false on their gesture, so the loop yields and never
  // fights an intentional reading position. A newer forceScrollToBottom
  // (chat switch, new turn) bumps the generation and supersedes us.
  const gen = ++_stickBottomGen;
  // Bail the loop only on a REAL user gesture (wheel/touch/pointerdown),
  // never on a transient `pinnedToBottom` flip. A scroll event fired by our
  // own scrollTo recomputes isPinned() against the CURRENT scrollHeight — so
  // if content below grows between the scrollTo and that event (image decode,
  // play-bar attach, code reflow, deferred tool body), distance jumps past
  // the threshold and `pinnedToBottom` latches false, which used to abort the
  // loop mid-converge and strand the user above the true bottom (field
  // 2026-06-17: "down arrow takes 2-3 clicks"). Distinguishing the two means
  // content growth keeps the loop re-scrolling while a genuine scroll-up
  // still yields.
  const startGesture = lastUserGestureAt;
  let lastSh = -1;
  let stable = 0;
  let frames = 0;
  const step = () => {
    // Element swapped (chat switch tore down + rebuilt), superseded by a
    // newer call, or the user actively scrolled up — stop and leave them be.
    if (transcriptEl !== el || gen !== _stickBottomGen || lastUserGestureAt > startGesture) return;
    // This is a deliberate jump; keep ownership of the pinned state even if a
    // growth-induced scroll event flipped it false a frame ago.
    pinnedToBottom = true;
    const sh = el.scrollHeight;
    el.scrollTo({ top: sh, behavior: 'instant' as ScrollBehavior });
    // iOS PWA paint anchor: scrollTop reaches the right value but WebKit
    // doesn't paint until a real DOM child is the scroll target.
    // Last-element seek is the difference between paint and not-paint;
    // no-op cost on other browsers.
    const last = el.lastElementChild as HTMLElement | null;
    if (last && typeof last.scrollIntoView === 'function') {
      try { last.scrollIntoView({ block: 'end', inline: 'nearest' }); } catch { /* noop */ }
    }
    stable = sh === lastSh ? stable + 1 : 0;
    lastSh = sh;
    // Settled: scrollHeight unchanged across consecutive frames. Cap at
    // ~30 frames (~0.5s) so a chat that never stops growing (live images)
    // can't pin the main thread — the scheduleAtBottomRepin RO + per-delta
    // autoScroll cover any later growth.
    if (stable >= 2 || ++frames >= 30) return;
    requestAnimationFrame(step);
  };
  step();
}

/** Scroll to the live edge ONLY if the user is already pinned. If they've
 *  scrolled up to read earlier, leave their position alone and count the
 *  new message toward the unread badge on the jump-to-bottom button.
 *
 *  Tracks the "owner" of the most recent autoScroll burst — when many calls
 *  arrive in quick succession (resume + render + reflow) only the FIRST
 *  animates smoothly; subsequent calls within 200ms snap instantly so the
 *  user doesn't see two animations chained together. Streaming-delta
 *  cadence (one call per ~100ms with steady scrollHeight growth) flows
 *  through the smooth path naturally because each call re-establishes the
 *  burst window from the same call site. */
let _autoScrollBurstUntil = 0;
export function autoScroll(): void {
  if (!transcriptEl) return;
  // Diagnose dictation/streaming auto-scroll regression: log before+after
  // state so we can see whether autoScroll is being CALLED but failing
  // (pinned=false because of a stale flip) vs being called but scrolling
  // to a stale scrollHeight (layout not yet reflowed) vs not being called
  // at all (the streaming render path skips autoScroll). Read both before
  // and after the scroll to catch the stale-scrollHeight case.
  const stBefore = transcriptEl.scrollTop;
  const shBefore = transcriptEl.scrollHeight;
  const ch = transcriptEl.clientHeight;
  if (pinnedToBottom) {
    const now = performance.now();
    const inBurst = now < _autoScrollBurstUntil;
    _autoScrollBurstUntil = now + 200;
    // Both branches use scrollTo(behavior:'instant'). Raw scrollTop
    // assignment honors CSS scroll-behavior:smooth on .transcript and
    // animates over ~300ms — under virt every intermediate scroll
    // event triggers a rerender + spacer height adjustment, which
    // surfaces as a "twitch" during streaming / dictation newlines.
    // The first-of-burst case previously used the smooth path to give
    // a gentle ride on the very first reply_delta of a turn; with virt
    // the rerender cost makes that animation visibly chunky. Instant
    // is cleaner across both paths.
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
    const stAfter = transcriptEl.scrollTop;
    const shAfter = transcriptEl.scrollHeight;
    const tail = shAfter - stAfter - ch;
    diag(`[autoscroll] pinned scrollTop ${stBefore}→${stAfter} scrollHeight ${shBefore}→${shAfter} ch=${ch} tail=${tail} burst=${inBurst}`);
  } else {
    // Lazy re-latch at the LITERAL live edge: a fast wheel-down over
    // content-visibility rows produces browser scroll-anchoring
    // adjustments that read as tiny upward moves — each one re-arms the
    // gesture-beats-geometry re-latch hold, and once scroll events stop
    // there's nothing left to re-derive pinned. If the user is parked
    // at the strict bottom (≤48px — wheel-down rests ~28px off the edge on padded layouts; NOT the generous 300px threshold,
    // which is exactly the yank zone this machinery exists to protect)
    // with every hold expired, they've demonstrably returned to the
    // live edge: re-pin and follow this delta.
    if (Date.now() >= unpinnedHoldUntil && Date.now() >= pinRelatchHoldUntil
        && !transcriptNotTailAnchored()) {
      // Judge by the LAST SCROLL EVENT's distance, not a live read —
      // the delta that invoked us already grew scrollHeight, so a live
      // measurement inflates a parked-at-the-edge user into the yank
      // zone (28px read as 160px after one delta).
      const dist = lastScrollEventDist;
      if (dist <= 48) {
        pinnedToBottom = true;
        missedWhileScrolled = 0;
        transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
        updateButton();
        diag(`[autoscroll] lazy re-latch at live edge (dist=${dist})`);
        return;
      }
    }
    // No badge bump here: autoScroll fires for every appended/updated row
    // (render passes, dictation interim, batch flushes, replays), which
    // made the unread badge count garbage. Live ingestion sites call
    // noteLiveMessage instead.
    diag(`[autoscroll] skipped (not pinned) scrollTop=${stBefore} scrollHeight=${shBefore} ch=${ch}`);
  }
}

/** Explicitly set the pinned-to-bottom flag. Session-restore calls this
 *  with `false` for a mid/anchor restore so autoScroll() can't snap the
 *  incoming chat to the live edge while it renders and fight the anchor
 *  restore. The scroll listener already re-derives pinned on the next real
 *  scroll, so this just removes the window where a false-positive isPinned()
 *  (at scrollTop≈0 right after the switch-then-load clear collapses
 *  scrollHeight) lets autoScroll run. */
/** DEBUG-ONLY: trace every programmatic scroll write on the transcript —
 *  both `el.scrollTo(...)` and `el.scrollTop = …` — with a caller hint, so a
 *  repro names the EXACT code re-asserting a scroll target (field 2026-05-27:
 *  scroll-to-bottom snaps back to a saved anchor via an un-logged writer).
 *  Only installed when the debug pill is on: `new Error().stack` per write is
 *  too costly for production. The browser's own smooth-scroll animation
 *  frames don't go through these JS setters, so the trace stays sparse —
 *  one line per genuine code-issued scroll write. */
function installScrollWriteTracing(el: HTMLElement): void {
  const callerHint = (): string =>
    ((new Error().stack || '').split('\n').slice(2, 5)
      .map(s => s.trim().replace(/^at\s+/, ''))
      .filter(s => s && !s.includes('installScrollWriteTracing') && !s.includes('callerHint'))
      .join('  ←  ')) || '?';
  const origScrollTo = el.scrollTo.bind(el);
  (el as any).scrollTo = (...args: any[]) => {
    const o = args[0];
    const top = (o && typeof o === 'object') ? o.top : args[1];
    const beh = (o && typeof o === 'object') ? o.behavior : undefined;
    diag(`[scroll-write] scrollTo top=${Math.round(Number(top) || 0)} beh=${beh || 'auto'} via ${callerHint()}`);
    return (origScrollTo as any)(...args);
  };
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (desc?.get && desc.set) {
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return desc.get!.call(el); },
      set(v: number) {
        diag(`[scroll-write] scrollTop= ${Math.round(Number(v) || 0)} via ${callerHint()}`);
        desc.set!.call(el, v);
      },
    });
  }
}

/** The single source of truth for "is the scrollbar at the live edge?".
 *  Maintained by the scroll listener on EVERY scroll event (user wheel/
 *  touch AND programmatic/virtualizer scrolls), so anything gating on it
 *  (autoScroll follow-tail, the at-bottom re-pin) yields the instant the
 *  user scrolls up. */
export function isPinnedToBottom(): boolean {
  return pinnedToBottom;
}

export function setPinnedToBottom(v: boolean): void {
  if (v) unpinnedHoldUntil = 0; // explicit re-pin overrides any drill hold
  pinnedToBottom = v;
  // A mid-chat restore unpins without any scroll event having fired yet —
  // arm the settle compensator here too, not just in the scroll listener.
  if (!v) ensureSettleCompensator();
  updateButton();
}

/** Keep pinnedToBottom false for `ms` regardless of scroll geometry —
 *  the scroll listener's re-derivation is suspended for the window (see
 *  unpinnedHoldUntil above for the drill race this closes). autoScroll
 *  therefore no-ops for the duration, so post-drill rerenders can't yank
 *  the viewport to the live edge. A real user gesture, or an explicit
 *  forceScrollToBottom / setPinnedToBottom(true) / jump-to-bottom,
 *  releases the hold immediately. */
export function holdUnpinnedFor(ms: number): void {
  unpinnedHoldUntil = Date.now() + ms;
  pinnedToBottom = false;
  // Unpinned by a drill: run the compensator loop (it only re-baselines
  // while the hold is live — the drill defense owns the viewport — and
  // takes over the instant the hold clears / a gesture releases it).
  ensureSettleCompensator();
  updateButton();
}

/** Cross-module hook so a session switch can cancel any live at-bottom
 *  repin (owned by sessionResume) BEFORE the switch-then-load clear
 *  collapses scrollHeight — otherwise the LEAVING chat's repin
 *  ResizeObserver wakes on the 0→tall transition and snaps the incoming
 *  chat to the bottom mid-restore. sessionResume registers its canceller;
 *  sessionDrawer invokes it at switch start. Routed through chat.ts to
 *  avoid a sessionDrawer↔sessionResume import cycle. */
let _atBottomRepinCanceller: (() => void) | null = null;
export function registerAtBottomRepinCanceller(fn: (() => void) | null): void {
  _atBottomRepinCanceller = fn;
}
export function cancelAtBottomRepin(): void {
  try { _atBottomRepinCanceller?.(); } catch { /* noop */ }
}

/** Symmetric seam: lets the jump-to-bottom button engage the same
 *  settle-window re-pin ResizeObserver that sessionResume installs after a
 *  restore-to-bottom. forceScrollToBottom's rAF loop only covers the first
 *  ~0.5s; late async height (image decode, play-bars, code reflow, deferred
 *  tool bodies) lands after it exits and would otherwise strand the user
 *  above the true bottom (field 2026-06-17: "down arrow takes 2-3 clicks").
 *  sessionResume owns the RO (it has the cancel-on-switch + isPinned-yield
 *  semantics); routed through chat.ts to avoid an import cycle. */
let _atBottomRepinScheduler: (() => void) | null = null;
export function registerAtBottomRepinScheduler(fn: (() => void) | null): void {
  _atBottomRepinScheduler = fn;
}
export function scheduleAtBottomRepin(): void {
  try { _atBottomRepinScheduler?.(); } catch { /* noop */ }
}

/** Returns true if a transcript snapshot was restored. Caller may still
 *  run backfill — dedup on text handles overlap. Async because IDB reads
 *  can't be synchronous; the cold-boot flash is sub-frame on modern devices. */
export async function init(el: HTMLElement | null): Promise<boolean> {
  transcriptEl = el;
  if (transcriptEl && isDebugEnabled()) installScrollWriteTracing(transcriptEl);
  // Schema check FIRST — if the on-disk format is stale, nuke IDB
  // before any reader path runs. Avoids racing a delete against a
  // concurrent loadSnapshot. See SCHEMA_VERSION comment for policy.
  await ensureSchemaFresh();
  // Hydrate per-chat scroll positions from IDB into an in-memory
  // cache so sessionResume's first read returns the persisted value.
  // AWAITED (not fire-and-forget) so the first replaySessionMessages
  // after boot doesn't race the IDB read — otherwise the snapshot-
  // restore's forceScrollToBottom would overwrite cache with the
  // bottom of the snapshot before the persisted user-intent value
  // lands. IDB read is fast (~10ms), well under perceptible delay.
  const t0 = performance.now();
  await hydrateScrollPositions();
  diag(`[chat-scroll] hydrate finished ${Math.round(performance.now() - t0)}ms after chat.init`);
  // Hydrate the pinned-messages store so the per-bubble pin button
  // paints with correct state on the first render. Fire-and-forget —
  // server fetch is fast (~50ms on LAN); a bubble rendered before the
  // hydrate resolves just gets a momentary "unpinned" indicator that
  // flips via the parley:pins-changed listener once the server-
  // driven cache populates.
  void hydratePins();
  // Flush the pending scroll-position write on page unload so a reload
  // immediately after a scroll (faster than the 200ms IDB debounce)
  // still picks up the latest position on next boot.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (viewedSessionIdRef) flushScrollPosition(viewedSessionIdRef);
      // Force-flush the snapshot debounce. Without this, a reload
      // immediately after a chat switch loses the last 250ms of activity
      // — the IDB-persisted snapshot still reflects the PREVIOUS chat
      // and post-reload boot restores the wrong one.
      flushSnapshotPersist();
    });
  }
  // Repaint all bubble pin indicators when the pin set changes.
  // Fires on: hydrate completion (catches bubbles that rendered
  // before the server fetch resolved), explicit pinMessage /
  // unpinMessage from anywhere, and the cross-device sync path
  // (server-pins-changed via proxyClient). Cheap — walks .pin-btn
  // elements only (most bubbles don't have one — only those with a
  // stable msgId), reads isPinned() synchronously.
  if (typeof window !== 'undefined') {
    window.addEventListener('parley:pins-changed', () => {
      if (!transcriptEl || !viewedSessionIdRef) return;
      const chatId = viewedSessionIdRef;
      transcriptEl.querySelectorAll<HTMLElement>('.line[data-message-id]').forEach((line) => {
        const msgId = line.dataset.messageId || '';
        if (!msgId) return;
        const pinned = isPinMsg(chatId, msgId);
        line.classList.toggle('pinned', pinned);
        const btn = line.querySelector<HTMLButtonElement>('.pin-btn');
        if (btn) btn.classList.toggle('pinned', pinned);
      });
    });
  }

  // Jump-to-bottom button wiring. The button lives outside the transcript
  // scroller (as a sibling inside .chat-column) so it stays fixed while
  // the transcript scrolls.
  scrollToBottomBtn = document.getElementById('scroll-to-bottom');
  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', () => {
      // With a floating deep window open, "jump to bottom" means jump to
      // the LIVE TAIL — re-resume the session — not scroll to the bottom
      // of the partially-loaded window. Falls back to a plain scroll when
      // no jump-to-latest handler is registered.
      if (paginationHasMoreNewer && jumpToLatestCb) jumpToLatestCb();
      else { forceScrollToBottom(); scheduleAtBottomRepin(); }
    });
  }
  if (transcriptEl) {
    transcriptEl.addEventListener('scroll', () => {
      maybeLoadEarlier();
      maybeLoadLater();
      // Save the current scroll position on every scroll event — both
      // user-driven and JS-driven (autoScroll, restore). Last write
      // wins, which is the actual user-visible position. No user-vs-JS
      // distinction needed: the FINAL scrollTop after all events fire
      // is what should persist.
      if (transcriptEl && viewedSessionIdRef && !scrollSaveSuppressed) {
        saveCurrentScrollPosition();
      }
      // Re-evaluate pinned on every scroll. autoScroll's `if (pinned)`
      // guard does the right thing in both directions:
      //   - User scrolls up → distance > threshold → pinned=false →
      //     autoScroll stops following the live edge as content grows.
      //   - User scrolls back to bottom (or autoScroll lands at bottom)
      //     → distance ≤ threshold → pinned=true → autoScroll resumes.
      //   - JS-driven restore sets scrollTop=N → if N is mid-chat →
      //     pinned=false → subsequent bubble adds don't drag the user
      //     away from the restored position.
      const wasPinned = pinnedToBottom;
      // Upward movement backed by a fresh user gesture unpins REGARDLESS
      // of the 300px geometry threshold and holds the re-latch — covers
      // touch drags + momentum where the wheel handler below can't see
      // direction. JS writes (autoScroll, restores) move DOWN or lack a
      // fresh gesture, so they fall through to the geometric path.
      const st = transcriptEl.scrollTop;
      const movedUp = st < lastScrollTopSeen - 1;
      lastScrollTopSeen = st;
      lastScrollEventDist = transcriptEl.scrollHeight - st - transcriptEl.clientHeight;
      if (movedUp && Date.now() - lastUserGestureAt < UPWARD_GESTURE_FRESH_MS) {
        pinnedToBottom = false;
        pinRelatchHoldUntil = Date.now() + PIN_RELATCH_HOLD_MS;
      } else {
        pinnedToBottom = (Date.now() < unpinnedHoldUntil || Date.now() < pinRelatchHoldUntil)
          ? false : isPinned();
      }
      if (pinnedToBottom && !wasPinned) missedWhileScrolled = 0;
      // Off the live edge → the settle compensator guards the reading
      // position (no-op where native scroll anchoring is active; see its
      // header). Idempotent — cheap to call on every unpinned scroll.
      if (!pinnedToBottom) ensureSettleCompensator();
      updateButton();
    }, { passive: true });
    // #202: real input events (NOT 'scroll', which JS writes also fire)
    // mark the position as user-owned and cancel in-flight restores.
    for (const evt of ['wheel', 'touchstart', 'pointerdown'] as const) {
      transcriptEl.addEventListener(evt, () => {
        lastUserGestureAt = Date.now();
        unpinnedHoldUntil = 0; // user reclaims the scroll — drop any drill hold
        cancelPendingScrollRestores();
        // Arm the settle compensator on the GESTURE, not the later unpin
        // flip: the first wheel ticks of a scroll-up stay inside the
        // generous pinned threshold, and near-tail placeholders settling
        // in exactly that window were the one jump the unpin-armed
        // version let through. Gesture-cancelling restores + arming the
        // gesture-immune compensator here is the #202 handoff.
        ensureSettleCompensator();
      }, { passive: true });
    }
    // #214 TFC-E: lazy-load NEWER on a pull-up gesture at the bottom of a
    // floating window. maybeLoadLater otherwise only runs on scroll
    // events — at the window's bottom edge scrollTop is already at max,
    // so a wheel/drag toward newer produces NO scroll event and the next
    // page never loads (field: "when i drag down it doesn't load"). The
    // gates inside maybeLoadLater (hasMoreNewer, in-flight, ≤150px from
    // bottom, drill suppression) make this a cheap no-op everywhere else.
    transcriptEl.addEventListener('wheel', (e) => {
      // Direction is explicit on wheel — unpin on the first upward tick
      // (the scroll-event path above also catches this, but the wheel
      // event can fire a beat earlier than its scroll event; being
      // early here means the very next delta can't slip a yank in).
      if (e.deltaY < 0 && pinnedToBottom) {
        pinnedToBottom = false;
        pinRelatchHoldUntil = Date.now() + PIN_RELATCH_HOLD_MS;
        updateButton();
      }
      if (e.deltaY > 0) maybeLoadLater();
    }, { passive: true });
    let lastTouchMoveY: number | null = null;
    transcriptEl.addEventListener('touchstart', (e) => {
      lastTouchMoveY = e.touches[0]?.clientY ?? null;
    }, { passive: true });
    transcriptEl.addEventListener('touchmove', (e) => {
      const y = e.touches[0]?.clientY ?? null;
      const prev = lastTouchMoveY;
      lastTouchMoveY = y;
      // Finger moving UP drags content up = pulling toward newer.
      if (prev != null && y != null && y < prev - 2) maybeLoadLater();
    }, { passive: true });
  }

  // #225: the synchronously-written viewed-session id is the source of
  // truth for WHERE the user was; the IDB snapshot only supplies cached
  // pixels, and only when it belongs to that same chat. A snapshot for a
  // DIFFERENT chat (persist() refused while a drill window floated, or a
  // debounced write lost to a reload) must not hijack the landing.
  let lastViewed: string | null = null;
  try { lastViewed = localStorage.getItem(VIEWED_SESSION_LS_KEY); } catch { /* private mode */ }
  try {
    const saved = await loadSnapshot();
    const snapshotMatchesViewed = !lastViewed || !saved?.sessionId || saved.sessionId === lastViewed;
    if (saved && transcriptEl && saved.state && saved.sessionId && snapshotMatchesViewed) {
      // Virt-path cold-load: inject the persisted store state and
      // let the projection + reconciler render. The active chat-id is
      // claimed here (so concurrent backfill / boot's most-recent
      // fallback can't double-up) and the scroll position restores
      // from the chat-scroll cache. Server fetch arrives later via
      // backfillHistory / replaySessionMessages and replaces durable
      // wholesale; the snapshot is just the offline-cache bridge.
      restoredViewedSessionId = saved.sessionId;
      viewedSessionIdRef = restoredViewedSessionId;
      transcriptStore.setDurable(
        saved.sessionId,
        saved.state.durable,
        saved.state.pagination,
      );
      // The render itself happens in bindTranscriptPipeline's subscriber
      // (fired by setDurable above) — but that subscriber isn't bound
      // yet at chat.init time. trigger the render here so the cached
      // transcript paints before the server fetch lands. Lazy
      // ensureVirtualizer is fine; the upstream caller resumes from
      // here and the virt slot will already exist when SSE replay /
      // resume fire.
      rerenderActive();
      // Restore the user's last scroll position from the hydrated
      // cache. Cache miss → scroll to bottom.
      const savedRec = getScrollPosition(restoredViewedSessionId);
      if (savedRec?.atBottom) forceScrollToBottom();
      else if (savedRec) transcriptEl.scrollTo({ top: savedRec.scrollTop, behavior: 'instant' as ScrollBehavior });
      else forceScrollToBottom();
      return true;
    }
    if (saved && transcriptEl && saved.html && snapshotMatchesViewed) {
      transcriptEl.innerHTML = saved.html;
      restoredViewedSessionId = saved.sessionId || null;
      viewedSessionIdRef = restoredViewedSessionId;
      // Strip stale memo cards — their audio element + blob reference are dead
      // after serialization. Caller re-seeds them fresh from IndexedDB
      // (restoreMemoCards → memo decorations). NOW ESSENTIAL, not just
      // tidy: post-migration the snapshot HTML carries memo cards WITH
      // data-key, and the reconciler would ADOPT a dead-blob node as the
      // spec's element instead of creating a live one.
      transcriptEl.querySelectorAll('.memo-card').forEach(el => el.remove());
      // Strip stale activity rows. saveSnapshot() (below) excludes them
      // going forward, but existing IDB snapshots written by older builds
      // may still carry them and would dupe with fresh inflight replay.
      // Idempotent: a fresh snapshot has none.
      transcriptEl.querySelectorAll('.activity-row').forEach(el => el.remove());
      // Initial load: restore the user's last scroll position from the
      // hydrated cache (already loaded above). Cache miss → scroll to
      // bottom. Note: forceScrollToBottom is intentionally NOT called
      // unconditionally here — that used to overwrite the persisted
      // user-intent value before sessionResume's restore could read it.
      if (restoredViewedSessionId) {
        const savedRec = getScrollPosition(restoredViewedSessionId);
        if (savedRec) {
          if (savedRec.atBottom) {
            forceScrollToBottom();
          } else {
            transcriptEl.scrollTo({ top: savedRec.scrollTop, behavior: 'instant' as ScrollBehavior });
          }
        } else {
          forceScrollToBottom();
        }
      } else {
        forceScrollToBottom();
      }
      // Re-wire copy buttons on restored elements. Same source-of-truth as
      // the live-create path: prefer dataset.text (raw markdown) over
      // rendered textContent so round-trip copy is lossless.
      transcriptEl.querySelectorAll<HTMLElement>('.copy-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const line = btn.closest<HTMLElement>('.line');
          const text = line?.dataset.text
            || line?.querySelector('.text')?.textContent
            || '';
          navigator.clipboard.writeText(text).catch(() => {});
        };
      });
      // Re-wire show-more/show-less buttons. Snapshot restores the DOM
      // text but the onclick handler is lost across page reload. Without
      // this re-attach, buttons existed visually but did nothing.
      transcriptEl.querySelectorAll<HTMLElement>('.bubble-fold-toggle').forEach(btn => {
        const line = btn.closest<HTMLElement>('.line');
        if (!line) return;
        btn.onclick = (e) => {
          e.stopPropagation();
          const expanded = line.classList.toggle('expanded');
          btn.textContent = expanded ? 'Show less' : 'Show more';
        };
      });
      // Reset play-bar state on restored agent bubbles. Audio buffers are
      // in-memory and don't survive reload; serialized bar widths + state
      // classes would give a false "already loaded / already played" look.
      // User clicks play → re-synthesis happens fresh.
      const seenIds = new Set<string>();
      transcriptEl.querySelectorAll<HTMLElement>('.line.agent').forEach(line => {
        line.classList.remove('tts-active', 'tts-streaming', 'tts-playing', 'tts-paused', 'tts-played');
        const loaded = line.querySelector<HTMLElement>('.play-bar-loaded');
        const played = line.querySelector<HTMLElement>('.play-bar-played');
        if (loaded) loaded.style.width = '0%';
        if (played) played.style.width = '0%';
        // Invariant: each agent bubble must have a unique data-reply-id.
        // If a snapshot contains duplicates (from a version that let
        // streamingTtsReplyId leak across replies), re-mint on the
        // duplicates so play-click routing can distinguish them.
        const id = line.dataset.replyId;
        if (!id || seenIds.has(id)) {
          line.dataset.replyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        seenIds.add(line.dataset.replyId);
      });
      return true;
    }
  } catch {}
  // No usable snapshot (nuked by a schema bump, or it belongs to a
  // different chat). Still restore the viewed-session id so boot lands
  // on the right chat; the transcript paints from the server fetch.
  if (lastViewed) {
    restoredViewedSessionId = lastViewed;
    viewedSessionIdRef = lastViewed;
  }
  return false;
}

/** Fire-and-forget snapshot write to IndexedDB. Backfill from the gateway
 *  still plugs any gap on next connect (see always-run-backfill branch in
 *  main.ts) in case the IDB write fails mid-flight.
 *
 *  Activity rows (`.activity-row` — the collapsed "N tools · done"
 *  surface) are stripped before serialization. Reason: they have no
 *  `data-message-id` and so are invisible to `renderedMessages.upsert`'s
 *  dedup-by-id path. Persisting them produces a cascading dupe — every
 *  reload restores the prior DOM row AND a fresh replay from inflight
 *  appends another (since the in-memory `rows` Map is empty post-JS-
 *  reset). 3 reloads → 3 stacked "N tools · done" rows on the same chat
 *
 *  Trade-off: past-turn activity rows disappear on reload. Acceptable
 *  for now; the principled fix is to extend renderHistoryMessage to
 *  reconstruct activity rows from state.db's `role='tool'` /
 *  `role='assistant' (tool_calls JSON)` rows. Follow-up. */
function persist(): void {
  if (!transcriptEl) return;
  // Tail invariant (#214, field 2026-06-12): NEVER snapshot a floating
  // deep window. The DOM on screen is a disjoint mid-session slice; if it
  // were persisted, the next boot would innerHTML-restore it, the boot
  // resume would upsert the tail page INTO it, and the user would see
  // window+tail concatenated with a silently missing middle ("the UI
  // forgot the end of the session"). The same holds for a SPLICED pin+tail
  // view (#227): never snapshot the drilled window + `…` gap; keep the last
  // clean tail-anchored snapshot so boot always paints the session end.
  if (transcriptNotTailAnchored()) return;
  const clone = transcriptEl.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.activity-row').forEach((el) => el.remove());
  const html = clone.innerHTML;
  saveSnapshot({ html }, viewedSessionIdRef).catch((e) => diag(`chat.persist failed: ${e?.message || 'idb error'}`));
}

let scheduledPersistTimer: number | null = null;

/** Persist the current reconciled transcript after a short quiet period.
 *  The transcript pipeline updates existing DOM nodes for durable replay
 *  and streaming deltas; without this hook, the boot-time DOM snapshot can
 *  remain older than the canonical store and briefly reappear on refresh. */
export function scheduleSnapshotPersist(delayMs = 250): void {
  if (scheduledPersistTimer != null) {
    window.clearTimeout(scheduledPersistTimer);
  }
  scheduledPersistTimer = window.setTimeout(() => {
    scheduledPersistTimer = null;
    persist();
  }, delayMs);
}

/** Force-fire the pending snapshot persist now. pagehide handler uses
 *  this so a reload immediately after a chat switch doesn't lose the
 *  250ms-debounced write. */
export function flushSnapshotPersist(): void {
  if (scheduledPersistTimer != null) {
    window.clearTimeout(scheduledPersistTimer);
    scheduledPersistTimer = null;
  }
  persist();
}

/** Public flush helper — callers that batch many addLine calls (e.g.
 *  `replaySessionMessages` rendering a 200-message chat) skip the
 *  per-line autoScroll + persist via `batch: true`, then call this
 *  ONCE at the end. Without batching, the resume loop is O(N²): each
 *  `persist()` reads `transcriptEl.innerHTML` (O(N) DOM serialization)
 *  and writes the full snapshot to IDB — N calls × O(N) bytes per
 *  call. Without batching, a 200-message chat took ~5s to render
 *  client-side (server-side fetch was <1s); the per-call DOM serialization
 *  cost dominates at scale. */
export function flushBatchedRender(): void {
  autoScroll();
  persist();
}

export function speakerLabel(id: string | number | null | undefined): string {
  if (id == null) return 'Speaker';
  if (!speakerNames[id]) speakerNames[id] = `Speaker ${++speakerCount}`;
  return speakerNames[id];
}

/** Format a timestamp as HH:MM (24h) for top-right display on each line. */
function formatTime(ts: number | Date | string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// Desktop-only hover open/close for the caret menu. Gated on pointer
// capability (same pattern as the copy-icon hover gate) so touch stays
// click-only. Close is delayed so the pointer can travel caret → menu.
const msgMenuHoverCapable = () => typeof window !== 'undefined'
  && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;
const MSG_MENU_HOVER_OPEN_MS = 120;
const MSG_MENU_HOVER_CLOSE_MS = 250;
let msgMenuHoverOpenTimer: number | null = null;
let msgMenuHoverCloseTimer: number | null = null;

function cancelMsgMenuHoverOpen(): void {
  if (msgMenuHoverOpenTimer !== null) { clearTimeout(msgMenuHoverOpenTimer); msgMenuHoverOpenTimer = null; }
}
function cancelMsgMenuHoverClose(): void {
  if (msgMenuHoverCloseTimer !== null) { clearTimeout(msgMenuHoverCloseTimer); msgMenuHoverCloseTimer = null; }
}
function scheduleMsgMenuHoverClose(): void {
  cancelMsgMenuHoverClose();
  msgMenuHoverCloseTimer = window.setTimeout(() => {
    msgMenuHoverCloseTimer = null;
    closeAllMsgMenus();
  }, MSG_MENU_HOVER_CLOSE_MS);
}

/** Open the per-message action menu anchored to `line`. The menu reuses the
 *  existing copy/pin/play buttons (kept in the DOM but hidden via CSS) by
 *  synthesizing `.click()` on them — so all their handler logic, the
 *  pins-changed listener, and the replyPlayer delegation keep working
 *  untouched. Only "Mark unread" carries its own logic. */
function openMsgMenu(line: HTMLElement): void {
  closeAllMsgMenus();
  cancelMsgMenuHoverClose();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  const isAgent = line.classList.contains('agent');
  const playBtn = line.querySelector<HTMLButtonElement>('.play-btn');
  const pinBtn = line.querySelector<HTMLButtonElement>('.pin-btn');
  const copyBtn = line.querySelector<HTMLButtonElement>('.copy-btn');
  const msgId = line.dataset.messageId || '';

  // The menu overflows the bubble box; `.line { content-visibility: auto }`
  // (a scroll-jank mitigation) implies paint containment that would clip it
  // to the bubble. `.menu-open` lifts that containment for the open bubble
  // only. Cleared on every close path via closeMsgMenu.
  const closeMsgMenu = () => { menu.remove(); line.classList.remove('menu-open'); };

  // Icon glyphs mirror the in-bubble buttons so the menu reads with the
  // same visual vocabulary. `active` paints the icon sage (--primary) to
  // carry the same state the standalone buttons did: a cached/playable
  // reply and a pinned message go green; everything else stays muted grey.
  const ICON = {
    play: `<svg viewBox="0 0 16 16" fill="none"><polygon points="5 3 13 8 5 13 5 3" fill="currentColor"/></svg>`,
    pause: `<svg viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/></svg>`,
    pinOutline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>`,
    pinFilled: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5" stroke-linecap="round"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>`,
    copy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5V3.5a1.5 1.5 0 0 1 1.5-1.5h7"/></svg>`,
    unread: `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="4" fill="currentColor"/></svg>`,
  };

  const addItem = (label: string, iconSvg: string, onClick: () => void, active = false) => {
    const b = document.createElement('button');
    const icon = document.createElement('span');
    icon.className = active ? 'mi-icon mi-active' : 'mi-icon';
    icon.innerHTML = iconSvg;
    const text = document.createElement('span');
    text.className = 'mi-label';
    text.textContent = label;
    b.append(icon, text);
    b.onclick = (e) => { e.stopPropagation(); closeMsgMenu(); onClick(); };
    menu.appendChild(b);
  };

  if (isAgent && playBtn) {
    const playing = line.classList.contains('tts-playing');
    const cached = line.classList.contains('tts-cached');
    addItem(playing ? 'Pause' : 'Play', playing ? ICON.pause : ICON.play,
      () => playBtn.click(), cached);
  }
  if (pinBtn) {
    const pinned = line.classList.contains('pinned');
    addItem(pinned ? 'Unpin' : 'Pin', pinned ? ICON.pinFilled : ICON.pinOutline,
      () => pinBtn.click(), pinned);
  }
  if (copyBtn) addItem('Copy', ICON.copy, () => copyBtn.click());
  // Gated on isDurableMessageKey for the same reason as the pin button
  // above: the thinking-dots placeholder is an agent bubble too, and
  // "Mark unread" would otherwise persist an activity row keyed
  // `pending:turn:…` — the exact shape the field bug this comment
  // describes elsewhere in this file already hit once.
  if (isAgent && msgId && isDurableMessageKey(msgId)) {
    addItem('Mark unread', ICON.unread, () => {
      const chatId = viewedSessionIdRef || backend.getCurrentSessionId?.() || null;
      const liveText = line.dataset.text
        || (line.querySelector('.text') as HTMLElement | null)?.textContent || '';
      const ts = Number(line.dataset.ts) || Date.now();
      markUnreadForMessage({ chatId, messageId: msgId, text: liveText.slice(0, 500), createdAt: ts });
      if (chatId) void markChatUnread(chatId);
      toast('Marked unread');
    });
  }

  menu.addEventListener('click', (e) => e.stopPropagation());
  if (msgMenuHoverCapable()) {
    menu.addEventListener('pointerenter', cancelMsgMenuHoverClose);
    menu.addEventListener('pointerleave', scheduleMsgMenuHoverClose);
  }
  line.classList.add('menu-open');
  line.appendChild(menu);
  setTimeout(() => {
    const closer = (e: MouseEvent) => {
      if (menu.contains(e.target as Node)) return;
      closeMsgMenu();
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
  }, 0);
}

/** Remove any open per-message menus and clear their `.menu-open` flag.
 *  Used on open (to dismiss a sibling menu) and by the caret toggle. */
function closeAllMsgMenus(): void {
  document.querySelectorAll('.msg-menu').forEach((m) => {
    m.closest('.line')?.classList.remove('menu-open');
    m.remove();
  });
}

/** Append (or prepend) a line to the transcript. Returns the rendered
 *  `<div>` so callers can attach pending/failed state. Returns `null`
 *  if the transcript element hasn't been wired via `init()` yet. */
export function addLine(speaker: string, text: string, cls = '', opts: {
  /** Input source indicator — voice or typed (drives the small icon
   *  next to the speaker label). */
  source?: 'voice' | 'text' | 'sent';
  /** Render `text` as markdown (used for agent replies). */
  markdown?: boolean;
  /** Message timestamp; defaults to now. */
  timestamp?: number | Date | string;
  /** Image / video thumbnails rendered under the line. */
  attachments?: Array<{ dataUrl: string; mimeType: string; fileName?: string }>;
  /** TTS reply id for agent lines — links bubble to playback events
   *  (loading bar + play-icon wiring). */
  replyId?: string;
  /** Adapter-side message id (e.g. SSE `message_id`). Stored as
   *  `data-message-id` so handlers can dedup an envelope arriving for a
   *  message a parallel render path (history fetch) has already
   *  surfaced. */
  messageId?: string;
  /** Insert at the top of the transcript instead of appending. Used by
   *  lazy-loaded history. */
  prepend?: boolean;
  /** Skip autoScroll + persist. Caller runs them once after the batch.
   *  Used by prependHistory to preserve scroll position and avoid N IDB writes. */
  batch?: boolean;
  /** Mark the bubble `.pending` — visual signal that the send is in flight.
   *  Caller is responsible for calling `markBubbleFinalized` / `markBubbleFailed`
   *  via the returned div. Used by the atomic-send path (Q1). */
  pending?: boolean;
} = {}): HTMLElement | null {
  if (!transcriptEl) return null;
  const div = document.createElement('div');
  div.className = `line ${cls}${opts.pending ? ' pending' : ''}`;
  if (opts.replyId) div.dataset.replyId = opts.replyId;
  if (opts.messageId) div.dataset.messageId = String(opts.messageId);
  if (cls.includes('agent')) div.dataset.text = text;  // replyPlayer uses this for replay

  // Source icon: minimal line-style indicator of voice vs typed
  const micSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z"/><path d="M4 7a4 4 0 0 0 8 0"/><path d="M8 12v2.5M6 14.5h4"/></svg>`;
  const kbdSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3.5" width="14" height="9" rx="1.5"/><path d="M4 10.5h8"/><circle cx="5" cy="7" r="0.5" fill="currentColor"/><circle cx="8" cy="7" r="0.5" fill="currentColor"/><circle cx="11" cy="7" r="0.5" fill="currentColor"/></svg>`;
  const sourceIcon = opts.source === 'voice' ? `<span class="source-icon" title="voice">${micSvg}</span>`
    : opts.source === 'text' ? `<span class="source-icon" title="typed">${kbdSvg}</span>`
    : '';

  const speakerSpan = `<span class="speaker">${sourceIcon}${escapeHtml(speaker)}:</span> `;
  // For plain (non-markdown) lines — typically user input — preserve
  // line breaks AND render `> ` quote blocks (from select-to-quote) as
  // <blockquote>. renderUserText escapes first, then groups quote lines and
  // converts remaining newlines to <br>, so a quoted reply shows indented
  // while everything else the user typed stays literal. Without the <br>
  // handling, long multi-paragraph prompts collapse into a wall of text.
  // Capture transcript paths become doc-open links in BOTH bubble
  // kinds — the "Recording started" line is a user-side message, so
  // markdown-only linkification would miss it (field 2026-07-09 #6).
  const rendered = linkifyCaptureDocs(opts.markdown
    ? miniMarkdown(text)
    : renderUserText(text));
  div.innerHTML = speakerSpan + `<span class="text">${rendered}</span>`;

  // Timestamp — top-right, left of the copy icon
  const ts = opts.timestamp ?? Date.now();
  div.dataset.ts = String(ts);  // epoch, read by the Mark-unread action
  const tsEl = document.createElement('span');
  tsEl.className = 'line-ts';
  tsEl.textContent = formatTime(ts);
  tsEl.title = new Date(ts).toLocaleString();
  div.appendChild(tsEl);

  // Copy button — standard overlapping-rectangles icon
  const copySvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5V3.5a1.5 1.5 0 0 1 1.5-1.5h7"/></svg>`;
  const checkSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>`;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy text';
  copyBtn.innerHTML = copySvg;
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    // Read text live from the bubble (not the closure `text` arg), since
    // agent streaming mutates .text span + dataset.text after creation.
    // Prefer dataset.text (raw source) for agent lines — lossless for
    // round-trip paste. Falls back to textContent (strips speaker label
    // since it's in a separate .speaker span).
    const liveText = div.dataset.text
      || (div.querySelector('.text') as HTMLElement | null)?.textContent
      || '';
    navigator.clipboard.writeText(liveText).then(() => {
      copyBtn.innerHTML = checkSvg;
      setTimeout(() => { copyBtn.innerHTML = copySvg; }, 1500);
    });
  };
  div.appendChild(copyBtn);

  // Per-bubble pin toggle — adds the bubble to the pinned-messages
  // store (drives the right-side pins drawer's cross-chat aggregation).
  // Shown on any bubble with a stable, DURABLE msgId — gated so the
  // affordance never appears on a synthetic row (the local thinking
  // placeholder renders as an agent bubble keyed `pending:turn:…` and
  // would otherwise offer a working Pin button for a message id the
  // server has never heard of; see src/transcript/keys.ts). The chat_id
  // is resolved LAZILY at click time from viewedSessionIdRef so the
  // button works even on optimistic user bubbles rendered before
  // trackViewedSession has stamped the chat id (fresh-new-chat path:
  // send() runs before backend.newSession() completes its assignment).
  // Without the lazy read, the fresh-new-chat smoke caught the button
  // missing entirely
  // (2026-05-12).
  //
  // Icon swap is CSS-driven (.pin-btn.pinned hides outline, shows
  // filled) so the global parley:pins-changed listener at init()
  // only needs to toggle the `.pinned` class — no innerHTML rebuild
  // per repaint cycle.
  if (opts.messageId && isDurableMessageKey(String(opts.messageId))) {
    const msgId = String(opts.messageId);
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn';
    // Thumbtack — recognizable as a pin (vs an abstract paperclip
     // shape, which is ambiguous). Two SVGs in DOM; CSS swaps visibility
     // via .pinned.
    pinBtn.innerHTML = `
      <svg class="pin-icon pin-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>
      <svg class="pin-icon pin-filled" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5" stroke-linecap="round"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>
    `;
    // Initial paint: we don't know the chat_id yet if this is an
    // optimistic bubble on a fresh chat. Re-paint will fire via
    // parley:pins-changed once trackViewedSession stamps it.
    if (viewedSessionIdRef && isPinMsg(viewedSessionIdRef, msgId)) {
      pinBtn.classList.add('pinned');
      pinBtn.title = 'Unpin message';
      div.classList.add('pinned');
    } else {
      pinBtn.title = 'Pin message';
    }
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      // viewedSessionIdRef is set by replaySessionMessages (drawer
      // click path), but fresh-new-chat optimistic bubbles render
      // BEFORE that fires. Fall back to backend.getCurrentSessionId
      // which the adapter tracks on every send/new-chat operation
      // — gives a correct chatId for the fresh-chat case the smoke
      // pin-toggle-on-bubble pins.
      const chatId = viewedSessionIdRef || backend.getCurrentSessionId?.() || null;
      if (!chatId) {
        log(`[pin-click] no viewed/current chat — bailing (msgId=${msgId})`);
        return;
      }
      const currentlyPinned = isPinMsg(chatId, msgId);
      log(`[pin-click] chat=${chatId} msgId=${msgId} currentlyPinned=${currentlyPinned}`);
      if (currentlyPinned) {
        void unpinMessage(chatId, msgId);
        pinBtn.classList.remove('pinned');
        pinBtn.title = 'Pin message';
        div.classList.remove('pinned');
      } else {
        // Pull the live text — same lossless source the copy button
        // uses (dataset.text for streaming agent lines, .text span
        // otherwise). Truncate to ~280 chars so the drawer doesn't
        // store entire pasted documents.
        const liveText = div.dataset.text
          || (div.querySelector('.text') as HTMLElement | null)?.textContent
          || '';
        // Store up to ~16000 chars so even a long markdown reply shows
        // IN FULL when the drawer item expands. The earlier 1500 cap
        // truncated common expanded reads. 16K is well under IDB pressure
        // for any realistic pin count (1 MB at 60 pins of max size).
        const preview = liveText.length > 16000 ? liveText.slice(0, 15997) + '…' : liveText;
        const role = cls.includes('agent') ? 'assistant'
          : cls.includes('system') ? 'system'
          : 'user';
        const ts = typeof opts.timestamp === 'number' ? opts.timestamp
          : opts.timestamp instanceof Date ? opts.timestamp.getTime()
          : typeof opts.timestamp === 'string' ? Date.parse(opts.timestamp)
          : Date.now();
        void pinMessage({ chatId, msgId, role, text: preview, timestamp: ts });
        pinBtn.classList.add('pinned');
        pinBtn.title = 'Unpin message';
        div.classList.add('pinned');
      }
    };
    div.appendChild(pinBtn);
  }

  // Per-bubble play/pause chip + playback bar for AGENT lines. The
  // DOM is emitted here; ALL interaction (click, scrub, class-flip,
  // bar widths) is owned by src/audio/turn-based/replyPlayer.ts via
  // delegated handlers on the transcript element. No per-bubble
  // listener attachment — new bubbles "just work."
  //
  // Both play + pause SVGs are emitted; CSS swaps visibility based on
  // .tts-playing state. Color encodes cache state via .tts-cached.
  // Bar layers (.play-bar-loaded under .play-bar-played) are present
  // in the DOM but invisible until styled by .tts-active states —
  // see styles/app.css for the visual spec.
  if (cls.includes('agent')) {
    const playGlyph = `<svg class="glyph-play" viewBox="0 0 16 16" fill="none"><polygon points="5 3 13 8 5 13 5 3" fill="currentColor"/></svg>`;
    const pauseGlyph = `<svg class="glyph-pause" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/></svg>`;
    // Loading spinner — minimal line-style ring; CSS spins it via
    // @keyframes when .tts-streaming is on the bubble. Replaces the
    // play glyph during /tts fetch so the user sees "loading, hands
    // off" instead of an unchanged play button (tap-then-nothing was
    // the field-bug: 6 taps over 80s while waiting for the first one).
    const loadingGlyph = `<svg class="glyph-loading" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M14 8a6 6 0 1 1-3-5.196"/></svg>`;
    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.title = 'Play / pause this reply';
    playBtn.innerHTML = playGlyph + pauseGlyph + loadingGlyph;
    div.appendChild(playBtn);

    const bar = document.createElement('div');
    bar.className = 'play-bar';
    bar.innerHTML = `<div class="play-bar-loaded"></div><div class="play-bar-played"></div>`;
    div.appendChild(bar);
  }

  // Action caret — a single hover affordance in the bubble corner that
  // opens a popover (Play/Pin/Copy/Mark-unread). The copy/pin/play buttons
  // above stay in the DOM but are hidden via CSS; the menu synthesizes
  // clicks on them so all their wiring (pin store, replyPlayer delegation,
  // copy feedback) keeps working untouched. Only Mark-unread is bespoke.
  const caretBtn = document.createElement('button');
  caretBtn.className = 'msg-caret';
  caretBtn.title = 'Message actions';
  caretBtn.setAttribute('aria-label', 'Message actions');
  caretBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`;
  caretBtn.onclick = (e) => {
    e.stopPropagation();
    cancelMsgMenuHoverOpen();
    const existing = div.querySelector('.msg-menu');
    if (existing) { closeAllMsgMenus(); return; }  // toggle closed
    openMsgMenu(div);
  };
  if (msgMenuHoverCapable()) {
    caretBtn.addEventListener('pointerenter', () => {
      cancelMsgMenuHoverClose();
      if (div.querySelector('.msg-menu')) return;
      cancelMsgMenuHoverOpen();
      msgMenuHoverOpenTimer = window.setTimeout(() => {
        msgMenuHoverOpenTimer = null;
        if (!div.querySelector('.msg-menu')) openMsgMenu(div);
      }, MSG_MENU_HOVER_OPEN_MS);
    });
    caretBtn.addEventListener('pointerleave', () => {
      cancelMsgMenuHoverOpen();
      if (div.querySelector('.msg-menu')) scheduleMsgMenuHoverClose();
    });
  }
  div.appendChild(caretBtn);

  // All links in rendered markdown open in new tab
  if (opts.markdown) {
    div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  }

  // Attachment thumbnails — images render as tappable <img>, videos as
  // in-place <video controls>. Both link out via the lightbox for a
  // larger view. Gateway handling is permissive: it bundles both as
  // `type: 'image'` blocks; which models accept video is model-
  // specific (Gemini / some Gemma variants do).
  if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
    const attDiv = document.createElement('div');
    attDiv.className = 'line-attachments';
    for (const att of opts.attachments) {
      if (!att?.dataUrl) continue;
      if (att.mimeType?.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.alt = att.fileName || 'attachment';
        img.title = att.fileName || 'attachment';
        img.loading = 'lazy';
        img.onclick = () => openLightbox(att.dataUrl);
        attDiv.appendChild(img);
      } else if (att.mimeType?.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = att.dataUrl;
        vid.controls = true;
        vid.preload = 'metadata';
        vid.playsInline = true;
        vid.title = att.fileName || 'attachment';
        attDiv.appendChild(vid);
      } else if (att.mimeType === 'application/pdf') {
        // PDF preview: minimal label chip. Click opens the data: URL in
        // a new tab so the user can sanity-check what they sent without
        // pdf.js bulk. Local-only — the chip lives in DOM memory and
        // disappears on hard refresh (no server-side persistence needed).
        const a = document.createElement('a');
        a.href = att.dataUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'pdf-chip';
        a.title = att.fileName || 'PDF attachment';
        a.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 1.5h7L13 4.5V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5z"/><path d="M9.5 1.5V4.5H13"/></svg><span class="pdf-chip-label">${escapeHtml(att.fileName || 'PDF')}</span>`;
        attDiv.appendChild(a);
      }
    }
    if (attDiv.children.length > 0) div.appendChild(attDiv);
  }

  // Long-bubble fold. Bubbles whose source text exceeds the threshold
  // get clipped with a "Show more" toggle. Per-
  // bubble state lives in `foldStateByMsgId` so a virt unmount/remount
  // preserves the user's toggle — the bubble's DOM is gone after a
  // scroll-out, but msgId is stable; remount restores the prior state
  // via the map lookup below.
  // CSS in app.css controls the preview height (--bubble-fold-preview-lines)
  // and fade. Threshold lives here so it scales with content type
  // (markdown lines render shorter than user-typed lines).
  // Streaming agent bubbles: this fires at addLine time on the initial
  // text. If a streamed bubble grows past the threshold mid-stream, no
  // fold (acceptable v1 limitation; most long bubbles are pasted/replayed).
  const FOLD_THRESHOLD_CHARS = 1500;
  const FOLD_THRESHOLD_LINES = 25;
  const lineCount = (text.match(/\n/g) || []).length + 1;
  if (text.length > FOLD_THRESHOLD_CHARS || lineCount > FOLD_THRESHOLD_LINES) {
    div.classList.add('foldable');
    // Default state: agent replies start EXPANDED (you usually want to read
    // them in full); user bubbles start FOLDED (own messages are reference,
    // collapse by default to save scroll real estate). Either side can be
    // toggled per-bubble.
    const defaultExpanded = cls.includes('agent');
    const persistedState = opts.messageId ? foldStateByMsgId.get(String(opts.messageId)) : undefined;
    const startExpanded = persistedState === undefined ? defaultExpanded : persistedState === 'expanded';
    if (startExpanded) div.classList.add('expanded');
    const foldBtn = document.createElement('button');
    foldBtn.className = 'bubble-fold-toggle';
    foldBtn.textContent = startExpanded ? 'Show less' : 'Show more';
    foldBtn.onclick = (e) => {
      e.stopPropagation();
      const expanded = div.classList.toggle('expanded');
      foldBtn.textContent = expanded ? 'Show less' : 'Show more';
      if (opts.messageId) foldStateByMsgId.set(String(opts.messageId), expanded ? 'expanded' : 'collapsed');
    };
    div.appendChild(foldBtn);
  }

  // Under virtualization, target the virtualizer's slot so the line
  // lands inside the scrollable content area rather than after the
  // bottom spacer. Falls back to transcriptEl when virt is off.
  const target = contentTarget();
  if (!target) return null;
  if (opts.prepend) {
    target.insertBefore(div, target.firstChild);
  } else {
    target.appendChild(div);
  }
  if (!opts.batch) {
    autoScroll();
    persist();
  }
  return div;
}

// ─── Lazy-load / pagination ─────────────────────────────────────────────────

let paginationOldestId: number | null = null;
let paginationHasMore = false;
let paginationLoading = false;
let paginationCb: ((beforeId: number) => Promise<void>) | null = null;
/** Pixels from the top that trigger a background "load earlier" fetch. */
const LOAD_EARLIER_THRESHOLD_PX = 150;

// Symmetric "load later" (load-newer) state. Non-trivial only while a
// floating deep `around` window is open — i.e. the loaded run does NOT
// reach the live tail. On a normal tail-anchored resume newestId is null
// and hasMoreNewer is false, so this machinery stays inert.
let paginationNewestId: number | null = null;
let paginationHasMoreNewer = false;
let paginationLoadingNewer = false;
let paginationLaterCb: ((afterId: number) => Promise<void>) | null = null;
let jumpToLatestCb: (() => void) | null = null;
/** Pixels from the bottom that trigger a background "load later" fetch. */
const LOAD_LATER_THRESHOLD_PX = 150;

/** Called by main.ts after replaying a page of session history so chat
 *  knows whether there's older content to fetch and what cursor to use.
 *  Pass oldestId=null, hasMore=false to disable pagination (e.g. for
 *  fresh sessions or cached replays with the full transcript).
 *
 *  `newestId`/`hasMoreNewer` describe the symmetric load-later cursor —
 *  non-default only for a floating deep `around` window that hasn't been
 *  connected to the live tail. They default to "tail-anchored" (null /
 *  false), which is correct for a normal resume / load-earlier. */
export function setPaginationState(
  oldestId: number | null,
  hasMore: boolean,
  newestId: number | null = null,
  hasMoreNewer = false,
) {
  paginationOldestId = oldestId;
  paginationHasMore = hasMore;
  paginationLoading = false;
  paginationNewestId = newestId;
  paginationHasMoreNewer = hasMoreNewer;
  paginationLoadingNewer = false;
}

/** Register the cursor-to-messages callback. Called once on boot; the cb
 *  is expected to fetch, prepend via prependHistory(), and re-call
 *  setPaginationState with the new cursor. */
export function onLoadEarlier(cb: (beforeId: number) => Promise<void>) {
  paginationCb = cb;
}

/** Register the load-newer callback — symmetric to onLoadEarlier. The cb
 *  fetches the page after the cursor, appends via appendHistory(), and
 *  re-calls setPaginationState with the new newer cursor. */
export function onLoadLater(cb: (afterId: number) => Promise<void>) {
  paginationLaterCb = cb;
}

/** Register the "jump to live tail" callback. When a floating deep window
 *  is open (hasMoreNewer), the jump-to-bottom button re-resumes to the
 *  tail via this callback instead of scrolling to the window's bottom. */
export function onJumpToLatest(cb: () => void) {
  jumpToLatestCb = cb;
}

/** Batch-prepend historical messages while preserving the user's scroll
 *  position. renderFn should call addLine(..., {prepend: true, batch: true})
 *  per message, iterating oldest→newest so chronological order is
 *  preserved at the top of the transcript. */
export function prependHistory(renderFn: () => void, opts: { deferPersist?: boolean } = {}) {
  if (!transcriptEl) { renderFn(); return; }
  // Anchor-based preservation (#202, field 2026-06-12): the old
  // scrollHeight-diff math is open-loop — prepended rows measure as 100px
  // `content-visibility` placeholders and not-yet-decoded images as 0px at
  // this point, so the diff undershoots their settled heights and the view
  // jumps as they render (worst on slow links / iOS WebKit, which has no
  // native scroll anchoring). Instead, re-seat the first-visible bubble at
  // its exact viewport offset; restoreDomAnchor's convergence loop absorbs
  // the placeholder settles (and a user gesture cancels it). The diff math
  // remains only as the fallback when no anchor exists.
  const anchor = getDomAnchor();
  const oldScrollTop = transcriptEl.scrollTop;
  const oldScrollHeight = transcriptEl.scrollHeight;
  renderFn();
  if (!(anchor && restoreDomAnchor(anchor))) {
    // scrollHeight-diff fallback is itself an absolute compensation for
    // the prepend's layout shift — re-baseline the settle compensator.
    noteAbsoluteScrollSeat();
    transcriptEl.scrollTop = oldScrollTop + (transcriptEl.scrollHeight - oldScrollHeight);
  }
  // deferPersist: the time-sliced backfill pump prepends a batch per
  // frame — a synchronous full-DOM clone+serialize per batch would eat
  // the frame budget it exists to protect. The debounced scheduler
  // coalesces to one snapshot after the batches go quiet.
  if (opts.deferPersist) scheduleSnapshotPersist();
  else persist();
}

/** Drill-scroll guard: while a pin-drawer / cmdk drill is scrolling
 *  the target message into view, suppress lazy-load in BOTH directions.
 *  Without this, scrolling near an edge of the transcript triggers
 *  maybeLoadEarlier / maybeLoadLater mid-flight; the resulting prepend or
 *  append shifts the target's y-coordinate but the smooth-scroll keeps
 *  animating to the *old* coordinate, landing the user on the wrong
 *  message. Each successive click triggers another page until pagination
 *  exhausts. The load-LATER direction matters since the bounded drill window
 *  lands the target near the window's bottom edge (within the loadLater
 *  threshold); unsuppressed, a deep jump would walk all the way to the live
 *  tail. Sets a deadline; both
 *  maybeLoadEarlier and maybeLoadLater bail until it passes. */
let suppressLazyLoadUntil = 0;
export function suppressLazyLoadFor(ms: number): void {
  suppressLazyLoadUntil = Math.max(suppressLazyLoadUntil, Date.now() + ms);
}

async function maybeLoadEarlier() {
  if (Date.now() < suppressLazyLoadUntil) return;
  // Structural gate (field 2026-08-04, CAP/WKWebView): while a switch
  // backfill is growing the rendered window, edge pagination must NOT
  // fire. The store already holds the rows the pump is about to render;
  // a ?before= fetch here targets rows ABOVE the full buffer, whose
  // prepend lands outside the window slice and never renders — scrollTop
  // stays at the (partial) top, so the loop refires page after page: an
  // invisible pagination cascade with the edge spinner cycling for its
  // whole duration (field report: 30-60s). The pump's rolling
  // suppressLazyLoadFor(400) was the only guard, and on real WKWebView
  // hardware rAF/timer stalls (touch-scroll throttling, foreground
  // transitions) open >400ms gaps between pump ticks that this timer
  // can't cover. Gate on the STATE, not a timer.
  if (isBackfillActive()) return;
  if (!paginationHasMore || paginationLoading || !paginationCb || paginationOldestId == null) return;
  if (!transcriptEl) return;
  if (transcriptEl.scrollTop > LOAD_EARLIER_THRESHOLD_PX) return;
  paginationLoading = true;
  setEdgeLoading('earlier');
  const cursor = paginationOldestId;
  try {
    await paginationCb(cursor);
  } catch (e: any) {
    diag(`chat.loadEarlier failed: ${e?.message || e}`);
  } finally {
    paginationLoading = false;
    setEdgeLoading(null);
  }
}

/** Batch-append newer messages while preserving the user's scroll
 *  position — symmetric to prependHistory. renderFn should call
 *  addLine(..., {batch: true}) per message oldest→newest so the new rows
 *  land at the bottom in chronological order. Appending below the
 *  viewport doesn't move on-screen content, so scrollTop stays
 *  valid as-is. */
export function appendHistory(renderFn: () => void) {
  if (!transcriptEl) { renderFn(); return; }
  renderFn();
  persist();
}

async function maybeLoadLater() {
  if (Date.now() < suppressLazyLoadUntil) return;
  // Same structural backfill gate as maybeLoadEarlier above.
  if (isBackfillActive()) return;
  if (!paginationHasMoreNewer || paginationLoadingNewer || !paginationLaterCb || paginationNewestId == null) return;
  if (!transcriptEl) return;
  const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  if (distance > LOAD_LATER_THRESHOLD_PX) return;
  paginationLoadingNewer = true;
  setEdgeLoading('later');
  const cursor = paginationNewestId;
  try {
    await paginationLaterCb(cursor);
  } catch (e: any) {
    diag(`chat.loadLater failed: ${e?.message || e}`);
  } finally {
    paginationLoadingNewer = false;
    setEdgeLoading(null);
  }
}

/** Open a full-screen overlay showing the given image. Tap anywhere to dismiss. */
function openLightbox(src: string): void {
  document.getElementById('lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'lightbox';
  overlay.onclick = () => overlay.remove();
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  document.body.appendChild(overlay);
}

/** Render a muted, italic, centered "system" line — for session events
 *  like model changes or new-chat resets. Distinct visually from regular
 *  agent/user messages.
 *
 *  Hardening phase 4: routed through the transcript MODEL as an
 *  owner-scoped decoration — keyed, per-chat, rendered by the
 *  reconciler like everything else. Replays can't stack duplicates and
 *  a repaint can't orphan it; the line lives with ITS chat (a model
 *  note stays in the chat where it was issued) instead of floating on
 *  whatever transcript is on screen. The legacy keyless DOM append
 *  survives only as the no-chat fallback (fresh boot before any chat
 *  exists), where there is no model to write into. */
export function addSystemLine(text: string): HTMLElement | null {
  const chatId = switchCtl.focusedId() ?? viewedSessionIdRef;
  if (chatId) {
    transcriptStore.addDecoration(chatId, {
      key: `deco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      text,
      timestamp: Date.now(),
    });
    autoScroll();
    return null;
  }
  const target = contentTarget();
  if (!target) return null;
  const div = document.createElement('div');
  div.className = 'line system';
  div.textContent = text;
  target.appendChild(div);
  autoScroll();
  persist();
  return div;
}

/** Clear transcript and persisted state (used by refresh). */
export function clear(): void {
  if (transcriptEl) transcriptEl.innerHTML = '';
  viewedSessionIdRef = null;
  restoredViewedSessionId = null;
  try { localStorage.removeItem(VIEWED_SESSION_LS_KEY); } catch { /* private mode */ }
  foldStateByMsgId.clear();
  missedWhileScrolled = 0;
  unreadSeenIds.clear();
  setEdgeLoading(null);
  updateButton();
  clearSnapshot().catch(() => {});
}

/** Atomic-bubble (Q1): drop the `.pending` class once the send has
 *  been ack'd by the agent (first reply_delta / typing arrived). */
export function markBubbleFinalized(div: HTMLElement | null): void {
  if (!div) return;
  div.classList.remove('pending');
  persist();
}

/** Atomic-bubble (Q1): mark the bubble `.failed` with a retry/dismiss
 *  affordance. `onRetry` re-attempts the send (caller restores
 *  composer text + removes the bubble inside the handler).
 *  `onDismiss` removes the bubble without retry. */
export function markBubbleFailed(
  div: HTMLElement | null,
  opts: { onRetry?: () => void; onDismiss?: () => void } = {},
): void {
  if (!div) return;
  div.classList.remove('pending');
  div.classList.add('failed');
  // Don't double-add the row if marked failed twice.
  if (div.querySelector('.send-failed-row')) return;
  const row = document.createElement('div');
  row.className = 'send-failed-row';
  const label = document.createElement('span');
  label.textContent = 'Send failed.';
  row.appendChild(label);
  if (opts.onRetry) {
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = (e) => {
      e.preventDefault();
      div.remove();
      opts.onRetry?.();
    };
    row.appendChild(retry);
  }
  if (opts.onDismiss) {
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = (e) => {
      e.preventDefault();
      div.remove();
      opts.onDismiss?.();
    };
    row.appendChild(dismiss);
  }
  div.appendChild(row);
  persist();
}
