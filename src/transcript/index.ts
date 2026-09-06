/**
 * @fileoverview Crack A — transcript pipeline bootstrap.
 *
 * Wires the store → projection → reconciler chain to the live
 * transcript element. Called once from main.ts boot. After this,
 * every mutation through the store (setDurable, appendInflight,
 * addPendingSend, …) automatically re-renders the active chat.
 *
 * Background-chat events still mutate the store but the reconciler
 * skips them — they re-render on the next session switch.
 */

import { project } from './projection.ts';
import { reconcile, resetActivityExpandState } from './reconciler.ts';
import { getState, subscribe } from './store.ts';
import type { BubbleSpec } from './types.ts';
import {
  scheduleSnapshotPersist, runWithScrollSaveSuppressed, autoScroll,
  prependHistory, suppressLazyLoadFor,
  restoreDomAnchor, lastUserScrollGestureAt, noteAbsoluteScrollSeat,
  clearEdgeLoaderIfIdle,
} from '../chat.ts';

let getTranscriptEl: () => HTMLElement | null = () => document.getElementById('transcript');
let getFocusedChatId: () => string | null = () => null;

/** Transcript elements we've already wired the loading-label cleanup
 *  observer onto — guards against attaching a second observer if
 *  showTranscriptLoading fires more than once against the same node. */
const labelCleanupWired = new WeakSet<HTMLElement>();

/** `.transcript-loading` has three legitimate clear sites (this file's
 *  rerenderInto, plus main.ts's new-chat/meeting-session shells, which
 *  supersede an in-flight resume and clear the class directly without
 *  going through rerenderInto). Chasing every clear site to also remove
 *  the label would leave the label's lifecycle hostage to code this
 *  module doesn't own. Instead: the label is a pure function of the
 *  class. Wire it once per transcript element so ANY removal of
 *  `.transcript-loading` — present or future call site — clears the
 *  label too, without those sites needing to know the label exists. */
function ensureLoadingLabelCleanup(el: HTMLElement): void {
  if (labelCleanupWired.has(el)) return;
  labelCleanupWired.add(el);
  new MutationObserver(() => {
    if (!el.classList.contains('transcript-loading')) {
      el.querySelector(':scope > .transcript-loading-label')?.remove();
    }
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
}

export interface BindOpts {
  transcriptEl: () => HTMLElement | null;
  getFocusedChatId: () => string | null;
}

/** Wire the store to the DOM. Returns an unsubscribe fn (mainly for
 *  tests; production never unbinds). */
export function bindTranscriptPipeline(opts: BindOpts): () => void {
  getTranscriptEl = opts.transcriptEl;
  getFocusedChatId = opts.getFocusedChatId;
  return subscribe((chatId) => {
    // Gate on the FOCUSED chat (optimistic ?? viewed) — the same pointer
    // that drives the drawer highlight — so the transcript always agrees
    // with the highlight. Skip ONLY when focus is set AND explicitly
    // differs; a null focus (boot before any switch, fresh-PWA-first-send
    // before any drawer click) renders the change — there's no other chat
    // on screen to protect.
    //
    // #255: gating on the COMMITTED `viewed` pointer instead leaked the
    // outgoing chat's live reply during a cold/slow switch — viewed lags
    // for the whole load (it only commits when the incoming transcript
    // renders) while the highlight already shows the target, so a busy
    // chat's reply_delta painted into the on-screen transcript.
    const focused = getFocusedChatId();
    if (focused && chatId !== focused) return;
    rerenderInto(chatId);
  });
}

/** Switch-then-load: blank the transcript + show the loading spinner
 *  IMMEDIATELY when the user clicks a different chat row, before the
 *  incoming transcript is ready. Pure in-DOM operation — empties the
 *  rendered content and adds the `.transcript-loading` class (the CSS
 *  spinner fades in after 200ms; a fast cache hit clears it first via
 *  rerenderInto's `specs.length > 0` removal so no flash). Decoupled
 *  from any IDB persistence: the click handler calls this synchronously,
 *  and "which session is viewed" stays on its existing async path. This
 *  is why it can't reintroduce the IDB-pagehide race that reverted the
 *  prior attempt — nothing here writes to (or awaits) IndexedDB.
 *
 *  OWNER-ONLY (hardening invariant #4, one loading signal): the sole
 *  legal caller is sessionDrawer.resume()'s mem-gate fall-through — the
 *  rung that has verified we hold NO paintable bytes in memory. Do not
 *  add call sites; a spinner armed anywhere else will fight the paint
 *  ladder (stale-paint-then-reconcile paints CONTENT on every rung that
 *  has any).
 *
 *  `label` (UX_DETERMINISM_PLAN Phase 0 #2) names the target underneath
 *  the spinner — e.g. "Opening Time management…" — so the blank pane
 *  during a slow switch says where it's going instead of just spinning.
 *  Rendered as a real DOM element (not `::after` content) tagged
 *  `data-island` so the reconciler's keyed-child sweep leaves it in place
 *  across any windowed-replay batches that land while it's showing (see
 *  reconciler.ts's TRANSCRIPT OWNERSHIP CONTRACT). rerenderInto below
 *  removes it in the same step that clears `.transcript-loading`. */
export function showTranscriptLoading(label: string): void {
  const el = getTranscriptEl();
  if (!el) return;
  // Switching chats: forget per-row tool-list expand choices so the incoming
  // chat's (and this chat's, on switch-back) tool lists default collapsed —
  // old tool runs are long + rarely interesting.
  // Cold load starts with an empty map already.
  resetActivityExpandState();
  // Emptying the transcript collapses its scrollHeight and fires a
  // synthetic scroll-to-0 event while the LEAVING chat is still the
  // viewed one. Suppress the scroll listener's position-save across the
  // clear so that synthetic scroll doesn't clobber the leaving chat's
  // just-saved position with a garbage (empty-transcript) anchor.
  runWithScrollSaveSuppressed(() => {
    el.innerHTML = '';
  });
  el.classList.add('transcript-loading');
  const labelEl = document.createElement('div');
  labelEl.className = 'transcript-loading-label';
  labelEl.setAttribute('data-island', 'transcript-loading-label');
  labelEl.textContent = label;
  el.appendChild(labelEl);
  ensureLoadingLabelCleanup(el);
}

/** Force a re-render of the active chat. Call after a session-switch
 *  finishes (the store mutations may have run while a different chat
 *  was viewed, so the subscriber skipped them). */
export function rerenderActive(): void {
  const chatId = getFocusedChatId();
  if (!chatId) return;
  rerenderInto(chatId);
}

function rerenderInto(chatId: string): void {
  const el = getTranscriptEl();
  if (!el) return;
  const specs = project(getState(chatId));
  // Windowed replay (feedback-before-payload phase 2): while a session-
  // switch backfill is in flight, render only the resolved window slice —
  // the pump below grows it in time-sliced batches until it covers the
  // whole projection. Steady state (no window) renders the full spec
  // list: off-screen render cost is handled by CSS `content-visibility:
  // auto` on `.line`, and scroll stability by the browser's native
  // scroll anchoring (`overflow-anchor: auto`) plus chat.ts's WKWebView
  // settle compensator.
  let renderSpecs = specs;
  if (replayWindow) {
    if (replayWindow.chatId === chatId) {
      const slice = windowSlice(el, specs);
      if (slice) renderSpecs = slice;
      else { replayWindow = null; clearEdgeLoaderIfIdle(); }   // complete / ineligible → full render
    } else {
      // A render for a different chat means focus moved without a new
      // replay request (e.g. new-chat placeholder) — the old window is
      // dead; drop it so its pump can't touch the wrong session.
      replayWindow = null;
    }
  }
  reconcile(el, renderSpecs);
  // Switch-then-load: the row-click handler sets .transcript-loading
  // synchronously when flipping focus to a new chat. Clear it as soon
  // as the first non-empty render lands so the spinner disappears
  // when content arrives (whether from cache or server). The named
  // loading label (Phase 0 #2) clears synchronously here too — the
  // MutationObserver in ensureLoadingLabelCleanup is a backstop for the
  // OTHER clear sites, not the primary path.
  if (renderSpecs.length > 0) {
    el.classList.remove('transcript-loading');
    el.querySelector(':scope > .transcript-loading-label')?.remove();
  }
  // Follow the tail while streaming: when a reply_delta grows the last
  // assistant bubble (an UPDATE, not a create — so per-bubble autoScroll
  // doesn't fire), keep the live edge in view. autoScroll() is a no-op
  // unless the user is pinned to the bottom, so a scrolled-up reader is
  // never yanked, and a mid-chat restore (which sets pinnedToBottom=false
  // and scrolls last) wins over this.
  autoScroll();
  scheduleSnapshotPersist();
}

// ── Windowed replay + time-sliced backfill (field 2026-08-02 follow-up) ──
//
// A session-switch replay of a huge transcript used to project +
// reconcile EVERY durable row in one synchronous task — 1.4-1.6s of
// main-thread block on a 180-row fat-markdown chat (measured headless),
// during which typing/scrolling/another switch stalled. The fix is a
// two-phase render:
//
//   1. The switch's first render paints only the region the user will
//      actually see: a tail window (switch-back lands pinned-to-bottom)
//      or a window around the saved scroll anchor (mid-history restore).
//   2. A pump grows the window in adaptive batches (~40ms budget each,
//      one per frame) until it covers the full projection: DOWNWARD to
//      the tail first (appends below the viewport never move content),
//      then UPWARD via chat.prependHistory, whose DOM-anchor re-seat
//      keeps the first-visible bubble at its exact offset through every
//      prepend (same contract as scroll-back pagination).
//
// Cancellation is structural: the pump re-checks identity (replayWindow
// === its state object) and focus every tick, so a second resume() or
// any focus change kills in-flight backfill with no orphan paints.
// Degradation is structural too: if the window's keys vanish from the
// projection (wholesale server replace, drill splice) or a gap row
// appears (#227 splice), the pump bails to ONE full render — correct,
// just not sliced.
//
// The window is requested (requestWindowedReplay) BEFORE the store
// mutation that triggers the subscriber render, and resolved lazily on
// the first rerenderInto against the actual projection — the specs
// don't exist until the store mutation lands.

interface ReplayWindowState {
  chatId: string;
  /** Saved-scroll anchor the initial window must contain (mid-history
   *  restore); null → tail window. */
  anchorKey: string | null;
  /** The saved anchor's viewport offset. While the user hasn't gestured
   *  since the window was armed, every prepend batch re-seats THIS
   *  anchor at THIS offset (not the transient first-visible bubble):
   *  each restoreDomAnchor call bumps the restore generation and would
   *  otherwise KILL the switch-restore's convergence loop mid-settle,
   *  locking in `content-visibility` placeholder drift (field: the
   *  scroll-mid-history-survives-switch regression — restored view
   *  ended 5 bubbles above the saved anchor). */
  anchorOffsetPx: number | null;
  /** Arm time — a user scroll gesture at/after this yields anchor
   *  authority back to the relative (first-visible) hold so the pump
   *  never fights the user's reading position. */
  armedAt: number;
  /** Keys are resolved against the live projection on first render. */
  resolved: boolean;
  /** Oldest rendered spec key. */
  startKey: string | null;
  /** Newest rendered spec key; null = window reaches through the tail
   *  (includes live/inflight rows as they append). */
  endKey: string | null;
  /** Adaptive rows-per-batch for the pump. */
  batchRows: number;
  pumpScheduled: boolean;
}

let replayWindow: ReplayWindowState | null = null;

/** Don't window transcripts below this row count — the full render is
 *  already fast and the pump machinery would be pure overhead. */
const WINDOW_MIN_TOTAL = 80;
/** Initial suffix rows for a tail-anchored (at-bottom / no-save) switch:
 *  roughly two viewports of typical bubbles. */
const WINDOW_TAIL_ROWS = 30;
/** Rows above/below the saved anchor for a mid-history restore window. */
const WINDOW_ANCHOR_ABOVE = 12;
const WINDOW_ANCHOR_BELOW = 24;
/** If windowing would defer fewer rows than this, render full — not
 *  worth a pump cycle. */
const WINDOW_MIN_REMAINDER = 24;
/** Per-batch main-thread budget. Batch size adapts toward it. */
const BACKFILL_BUDGET_MS = 40;
const BACKFILL_MIN_BATCH = 8;
const BACKFILL_MAX_BATCH = 120;

/** Arm windowed rendering for the next replay of `chatId`. Call BEFORE
 *  the store mutation whose subscriber render should be windowed.
 *  `anchorKey` (saved mid-history scroll anchor) guarantees the initial
 *  window contains that bubble so restoreDomAnchor can seat it. */
export function requestWindowedReplay(
  chatId: string,
  opts: { anchorKey?: string | null; anchorOffsetPx?: number | null } = {},
): void {
  replayWindow = {
    chatId,
    anchorKey: opts.anchorKey ?? null,
    anchorOffsetPx: opts.anchorOffsetPx ?? null,
    armedAt: Date.now(),
    resolved: false,
    startKey: null,
    endKey: null,
    batchRows: 24,
    pumpScheduled: false,
  };
}

/** Drop any pending/active replay window — next render is full-DOM.
 *  Used by drill paths (targetMessageId): the target bubble must be
 *  queryable in the DOM immediately after the render. */
export function cancelWindowedReplay(): void {
  replayWindow = null;
}

/** True while a switch backfill is still growing the rendered window.
 *  Exposed for diagnostics/tests. */
export function isBackfillActive(): boolean {
  return replayWindow !== null;
}

/** Resolve the window request against the live projection. Returns
 *  false when windowing shouldn't apply (small transcript, anchor
 *  missing, transcript already fully rendered in DOM). */
function resolveWindow(el: HTMLElement, w: ReplayWindowState, specs: BubbleSpec[]): boolean {
  const n = specs.length;
  if (n < WINDOW_MIN_TOTAL) return false;
  // If this chat's tail row is ALREADY in the DOM (boot snapshot restore
  // hydrated the full transcript, or a re-replay of a rendered chat),
  // windowing would REMOVE rows above the window only to re-add them —
  // strictly worse than a full reconcile that reuses every node.
  const tailKey = specs[n - 1]?.key;
  if (tailKey && el.querySelector(`[data-key="${cssEscape(tailKey)}"]`)) return false;
  let start: number;
  let end: number | null = null;
  if (w.anchorKey) {
    const a = specs.findIndex((s) => s.key === w.anchorKey);
    if (a < 0) return false;  // unknown anchor → full render, restore falls back
    if (a >= n - (WINDOW_TAIL_ROWS + WINDOW_ANCHOR_ABOVE)) {
      // Anchor sits near the tail — one suffix window covers both.
      start = Math.max(0, Math.min(n - WINDOW_TAIL_ROWS, a - WINDOW_ANCHOR_ABOVE));
    } else {
      start = Math.max(0, a - WINDOW_ANCHOR_ABOVE);
      let e = Math.min(n - 1, a + WINDOW_ANCHOR_BELOW);
      // Close enough to the tail → take the suffix and skip the
      // downward-growth phase entirely.
      if (e >= n - 1 - WINDOW_MIN_REMAINDER) e = n - 1;
      end = e === n - 1 ? null : e;
    }
  } else {
    start = n - WINDOW_TAIL_ROWS;
  }
  if (start < WINDOW_MIN_REMAINDER) return false;
  w.startKey = specs[start].key;
  w.endKey = end == null ? null : specs[end].key;
  w.resolved = true;
  schedulePump(w);
  return true;
}

/** The slice of `specs` the active window covers, or null when the
 *  window is complete/ineligible and the caller should render full.
 *  Monotonic: the window only ever grows, so successive slices are
 *  supersets — reconcile never removes a previously rendered row. */
function windowSlice(el: HTMLElement, specs: BubbleSpec[]): BubbleSpec[] | null {
  const w = replayWindow;
  if (!w) return null;
  if (!w.resolved && !resolveWindow(el, w, specs)) return null;
  // A gap row means a drill spliced a disjoint range (#227) — windowed
  // slicing has no idea which side of the gap matters; bail to full.
  for (const s of specs) if (s.kind === 'gap') return null;
  const startIdx = specs.findIndex((s) => s.key === w.startKey);
  if (startIdx < 0) return null;   // wholesale replace — bail to full
  if (w.endKey === null) {
    return startIdx === 0 ? null : specs.slice(startIdx);
  }
  let endIdx = -1;
  for (let i = startIdx; i < specs.length; i++) {
    if (specs[i].key === w.endKey) { endIdx = i; break; }
  }
  if (endIdx < 0) return null;
  return specs.slice(startIdx, endIdx + 1);
}

/** CSS.escape with a node-safe fallback (unit tests run without DOM). */
function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/** One pump tick per painted frame: rAF → 0ms timer, with a backstop
 *  timer because rAF never fires on a hidden document (a backgrounded
 *  backfill must still complete, just unpaced). */
function schedulePump(w: ReplayWindowState): void {
  if (w.pumpScheduled) return;
  w.pumpScheduled = true;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    w.pumpScheduled = false;
    pump(w);
  };
  const backstop = setTimeout(fire, 150);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { clearTimeout(backstop); setTimeout(fire, 0); });
  }
}

function pump(w: ReplayWindowState): void {
  // Identity + focus gates: a newer switch replaced the window, or focus
  // moved off this chat → this backfill is dead. No DOM was touched.
  if (replayWindow !== w || !w.resolved) return;
  const focused = getFocusedChatId();
  if (focused && focused !== w.chatId) { replayWindow = null; clearEdgeLoaderIfIdle(); return; }
  const el = getTranscriptEl();
  if (!el) { replayWindow = null; return; }
  const specs = project(getState(w.chatId));
  const n = specs.length;
  const bailFull = () => { replayWindow = null; clearEdgeLoaderIfIdle(); rerenderInto(w.chatId); };
  for (const s of specs) if (s.kind === 'gap') { bailFull(); return; }
  const startIdx = specs.findIndex((s) => s.key === w.startKey);
  if (startIdx < 0 || n === 0) { bailFull(); return; }
  // Keep scroll-edge pagination quiet while local rows are still
  // materializing — a scroll-to-top mid-backfill must grow the window
  // from the store, not fire a server ?before= fetch for rows we
  // already hold. Rolling: re-armed each tick, expires ~400ms after
  // the last batch.
  suppressLazyLoadFor(400);
  const t0 = performance.now();
  if (w.endKey !== null) {
    // Phase 1: grow DOWNWARD to the tail. Appends below the viewport
    // never move visible content — no compensation needed. (Only the
    // mid-history anchor window has this phase; the user is above, and
    // reaching the tail fast matters so live/inflight rows render.)
    let endIdx = -1;
    for (let i = startIdx; i < n; i++) {
      if (specs[i].key === w.endKey) { endIdx = i; break; }
    }
    if (endIdx < 0) { bailFull(); return; }
    const nextEnd = Math.min(n - 1, endIdx + w.batchRows);
    w.endKey = nextEnd >= n - 1 ? null : specs[nextEnd].key;
    reconcile(el, specs.slice(startIdx, nextEnd + 1), { batchBubbles: true });
  } else {
    // Phase 2: grow UPWARD, holding the reading position through each
    // prepend. Two anchor authorities:
    //   - Saved-anchor hold (mid-history restore, no user gesture since
    //     arming): re-seat the ORIGINAL saved anchor at its SAVED
    //     offset. Re-anchoring to the transient first-visible bubble
    //     instead would lock in whatever `content-visibility`
    //     placeholder drift accumulated since the last frame — and the
    //     gen bump inside restoreDomAnchor kills the switch-restore's
    //     own convergence loop, so nothing would ever correct back.
    //   - Relative hold (at-bottom windows, or after a user gesture):
    //     prependHistory's first-visible re-seat — the user's current
    //     position is the truth, saved coordinates are stale.
    const newStart = Math.max(0, startIdx - w.batchRows);
    w.startKey = specs[newStart].key;
    const savedHold = w.anchorKey && typeof w.anchorOffsetPx === 'number'
      && lastUserScrollGestureAt() < w.armedAt
      ? { key: w.anchorKey, offsetPx: w.anchorOffsetPx } : null;
    if (savedHold) {
      const beforeTop = el.scrollTop;
      const beforeH = el.scrollHeight;
      reconcile(el, specs.slice(newStart), { batchBubbles: true });
      if (!restoreDomAnchor(savedHold)) {
        // Anchor key vanished (should be impossible — the window always
        // contains it): scrollHeight-diff fallback, re-baselining the
        // settle compensator like prependHistory's fallback does.
        noteAbsoluteScrollSeat();
        el.scrollTop = beforeTop + (el.scrollHeight - beforeH);
      }
      scheduleSnapshotPersist();
    } else {
      prependHistory(
        () => reconcile(el, specs.slice(newStart), { batchBubbles: true }),
        { deferPersist: true },
      );
    }
    if (newStart === 0) {
      // Complete — steady-state full renders from here on. Clear any
      // stale edge spinner that got armed around the backfill (a legit
      // in-flight pagination keeps its own — the IfIdle guard).
      replayWindow = null;
      clearEdgeLoaderIfIdle();
      scheduleSnapshotPersist();
      return;
    }
  }
  const took = performance.now() - t0;
  if (took > BACKFILL_BUDGET_MS) {
    w.batchRows = Math.max(BACKFILL_MIN_BATCH, Math.floor(w.batchRows / 2));
  } else if (took < BACKFILL_BUDGET_MS / 2) {
    w.batchRows = Math.min(BACKFILL_MAX_BATCH, Math.floor(w.batchRows * 1.5));
  }
  schedulePump(w);
}

// Re-export the public surface from neighboring modules so call sites
// only need to import from './transcript'.
export { project } from './projection.ts';
export { reconcile } from './reconciler.ts';
export * as store from './store.ts';
export type * from './types.ts';
