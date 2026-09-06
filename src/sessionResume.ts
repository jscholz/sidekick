// Session-resume rendering — drives the transcript when the user
// switches into a chat (initial replay, drawer click, cmdk search hit,
// service-worker resume) and when they scroll to top to load earlier.
// Extracted from main.ts 2026-05-11 for the Phase 2 / pre-notifications
// refactor.
//
// Three exports + an init for plumbing:
//
//   replaySessionMessages(id, messages, pagination?, targetMsg?, inflight?)
//     The big one. Same-session vs different-session policy, render
//     batching, divergence-detection self-heal, pagination registration,
//     cmdk drill-to-message scroll-and-flash, inflight envelope replay.
//
//   renderHistoryMessage(m, label, mode?, batch?)
//     Shared per-message renderer for both initial replay (append) and
//     load-earlier (prepend, batched). Picks parley_id over integer id
//     so the IDB-cached bubble dedupes against history-replay correctly.
//
//   loadEarlierHistory(beforeId)
//     Scroll-to-top lazy-load. Walks the older[] array oldest→newest so
//     prepends end up in chronological order at the top.
//
// Module-private state: viewedSessionForLoadEarlier. Pinned by
// replaySessionMessages, read by loadEarlierHistory. Lives here rather
// than in main.ts so the load-earlier callback is self-contained.
//
// Plumbing: the module needs `getAgentLabel`, `setComposerReadOnly`,
// and a `setHistoryLoaded` callback (the backfill flag in main.ts is
// flipped by replaySessionMessages so backfillHistory short-circuits
// after a resume). Wired once by initSessionResume.

import { log, diag } from './util/log.ts';
import * as chat from './chat.ts';
import * as replyNavigator from './audio/turn-based/replyNavigator.ts';
import * as sessionAnnounce from './sessionAnnounce.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as switchCtl from './switchController.ts';
import * as backend from './backend.ts';
import * as transcriptStore from './transcript/store.ts';
import * as sessionCache from './sessionCache.ts';
import * as windowCache from './drillWindowCache.ts';
import { listAllPins } from './pins/store.ts';
import { listActivity } from './notifications/activityStore.ts';
import { rerenderActive, requestWindowedReplay, cancelWindowedReplay } from './transcript/index.ts';
import { getScrollPosition } from './chatScrollPositions.ts';
import { isDurableMessageKey } from './transcript/keys.ts';

/** Persist the chat's now-grown in-memory transcript back to IDB so a
 *  later resume/drill reads the deeper history from cache instead of
 *  re-crawling the server page by page. Called after each loadEarlier
 *  prepend (scroll-back AND deep-pin drill), AND after the post-final
 *  durable refresh promotes a live reply into the durable store — that
 *  promotion grows the in-memory transcript past what the messages cache
 *  holds, and without writing it through a switch-away-and-back would
 *  cache-paint the pre-reply rows and the reply would vanish until the
 *  (slow) server reconcile heals it (field bug 2026-06-14). Fire-and-
 *  forget; the cap keeps a pathological session from eating disk. This is
 *  also what makes deep pins "get faster warm" — without it IDB only ever
 *  holds the newest page. */
export function persistGrownTranscript(id: string): void {
  const s = transcriptStore.getState(id);
  // Caching invariant: only persist a run that
  // reaches the live tail. A floating deep `around` window
  // (hasMoreNewer=true) is a disjoint slice from the middle of the
  // session — writing it would clobber the tail-anchored IDB cache with
  // content that doesn't connect to the newest page. Once loadLater
  // walks the window forward to the tail (hasMoreNewer flips false) the
  // run is contiguous-to-tail and safe to persist; it then grows the
  // cache so subsequent warm jumps within it hit IDB.
  if (s.pagination.hasMoreNewer) return;
  // A buffer carrying a gap marker is a spliced pin-window-plus-tail with
  // a KNOWN discontinuity in the middle; persisting it would write a
  // multi-segment snapshot the cold-resume path isn't shaped to load.
  // The drill window cache (drillWindowCache) already gives instant
  // re-drill, so skip the IDB write while a gap is present.
  if (s.durable.some(it => it.role === 'gap')) return;
  const capped = sessionCache.capTranscript(s.durable, s.pagination);
  void sessionCache.putMessagesCache(id, capped.messages, capped.pagination);
}

/** Pattern for assistant replies the plugin signals as "no reply" (the
 *  agent chose to stay silent). We drop them from the rendered
 *  transcript rather than show an empty bubble. Exported because the
 *  live SSE handlers in main.ts apply the same filter on reply_delta /
 *  reply_final before upserting. */
export const NO_REPLY_RE = /^\s*NO[-_]?(?:REPL(?:Y)?)?\.?\s*$/i;

let setComposerReadOnlyRef: (readOnly: boolean, source?: string) => void = () => {};
let setHistoryLoadedRef: () => void = () => {};

/** Session id the chat is currently viewing — used by the load-earlier
 *  callback so it knows which session to fetch older messages for.
 *  Updated by replaySessionMessages. */
let viewedSessionForLoadEarlier: string | null = null;

/** Wire the module's callbacks into main.ts. Called once at boot. */
export function initSessionResume(opts: {
  setComposerReadOnly: (readOnly: boolean, source?: string) => void;
  setHistoryLoaded: () => void;
}): void {
  setComposerReadOnlyRef = opts.setComposerReadOnly;
  setHistoryLoadedRef = opts.setHistoryLoaded;
}

/** Render a full set of session messages, replacing the current
 *  transcript. Same-session resumes (visibility flip, SSE reconnect,
 *  post-turn drawer refresh) skip the clear so renderedMessages.upsert
 *  can reconcile in place without the blank-and-repaint flicker.
 *  resume() can fire onResumeCb multiple times for the same id (cache-
 *  cb + server-cb when results match); when the viewed id is unchanged
 *  we skip the clear to avoid double-append.
 *
 *  Token-required paint (hardening invariant #1): the first argument is
 *  a PaintToken and the chat id comes FROM it — there is no way to call
 *  this with an id/authority mismatch. A dead token (superseded switch,
 *  view token for a chat the user has left) refuses up front, so late
 *  continuations can hold a stale closure safely: their paint is a
 *  no-op, not a hijack. Callers switching TO a chat pass the resume's
 *  SwitchToken (or mint one via switchCtl.begin); callers repainting
 *  the chat already on screen pass switchCtl.viewTokenFor(id).
 *
 *  Returns whether the paint HAPPENED — callers with paint-dependent
 *  follow-up effects (store promotion, cache write-through) chain on
 *  it instead of hand-rolling their own focus re-checks. */
export function replaySessionMessages(
  tok: switchCtl.PaintToken,
  messages: any[],
  pagination?: { firstId: number | null; hasMore: boolean },
  targetMessageId?: string,
  inflight?: any[],
  opts?: { preserveScrollIfLive?: boolean },
): boolean {
  const id = tok.id;
  if (!switchCtl.canPaint(tok)) {
    diag(
      `[chat-resume] REFUSED chat_id=${id} — paint token dead ` +
      `(${'gen' in tok ? `switch gen=${tok.gen}` : 'view token'}, ` +
      `focused=${switchCtl.focusedId() ?? ''} viewed=${switchCtl.viewedId() ?? ''})`,
    );
    return false;
  }
  const viewed = switchCtl.viewedId();
  const sameSession = viewed === id;
  diag(
    `[chat-resume] enter chat_id=${id} viewed=${viewed ?? ''} ` +
    `sameSession=${sameSession} msgCount=${messages.length} ` +
    `inflightCount=${inflight?.length ?? 0} ` +
    `targetMessageId=${targetMessageId ?? ''} ` +
    `firstId=${pagination?.firstId ?? ''} hasMore=${pagination?.hasMore ?? ''}`,
  );
  if (!sameSession) {
    // Per-reply playback pointer — drop the previous chat's state so
    // a stale `.replaying` highlight doesn't survive the switch.
    replyNavigator.reset();
  }
  setHistoryLoadedRef();

  // Read the saved position BEFORE committing the new view / mutating
  // the transcript. Saves run unconditionally on every scroll event
  // (last write wins), so transient renders that fire scroll(0) just
  // get overwritten by the post-restore scroll(saved). No suppression.
  const saved = !targetMessageId ? getScrollPosition(id) : null;

  // Promotion is atomic with the paint and must run BEFORE the store
  // mutates so the reconciler subscription sees the new active chat
  // (it skips re-renders for non-active chats; we'd lose this render
  // otherwise). Switch tokens promote through the state machine's
  // commit (side-effecting twin in sessionDrawer, adopted by hardening
  // Phase 1); canPaint passed above and this function is synchronous
  // through the render, so the commit cannot fail nor be superseded
  // before the DOM lands. View tokens repaint an already-committed
  // view — setViewed re-runs the seen/engagement effects as before.
  if ('gen' in tok) sessionDrawer.commitView(tok);
  else sessionDrawer.setViewed(id);

  // Composer read-only when viewing a non-parley chat.
  const source = sessionDrawer.getSourceForChat(id);
  setComposerReadOnlyRef(source !== 'parley', source);

  sessionDrawer.scheduleRefresh();
  chat.trackViewedSession(id);
  viewedSessionForLoadEarlier = id;

  // Windowed replay (feedback-before-payload phase 2): arm the tail/
  // anchor window BEFORE the store mutation below — setDurable fires the
  // reconciler subscriber synchronously, and that first render is the
  // one that must be windowed (on a huge chat the full render is a
  // 1.4s+ main-thread block). Policy:
  //   - drill (targetMessageId): NEVER window — the target bubble must
  //     be queryable immediately after the render (drillScrollTo /
  //     drillToOlderMessage decide off that lookup).
  //   - different-session switch: window, seeded with the saved scroll
  //     anchor when the user left mid-history (the initial window must
  //     contain the anchor so restoreDomAnchor below can seat it).
  //   - legacy mid-history save (scrollTop but no anchorKey): render
  //     full — a raw scrollTop restore against a partial window would
  //     land nowhere near the saved position.
  //   - same-session re-render: leave any active window alone (its
  //     backfill continues; the slice is a superset of what's on
  //     screen).
  if (targetMessageId) {
    cancelWindowedReplay();
  } else if (!sameSession) {
    // isDurableMessageKey guards a LEGACY saved anchor from before this
    // check existed (getDomAnchor now refuses to save a synthetic key —
    // src/chat.ts, src/transcript/keys.ts). Without it a stale
    // `turn:status`/`pending:turn:…` anchorKey could coincidentally
    // match a same-keyed row in the freshly resumed session (the
    // turn-status line is a fixed, reused key) and window the initial
    // render around the wrong thing.
    const anchorKey = saved && !saved.atBottom
      && saved.anchorKey && typeof saved.anchorOffsetPx === 'number'
      && isDurableMessageKey(saved.anchorKey)
      ? saved.anchorKey : null;
    const legacyMidChat = !!(saved && !saved.atBottom && !anchorKey);
    if (legacyMidChat) cancelWindowedReplay();
    else {
      requestWindowedReplay(id, {
        anchorKey,
        // The saved offset rides along so backfill prepends keep
        // re-seating the SAVED anchor (not the drifting first-visible
        // bubble) until the user takes over with a gesture.
        anchorOffsetPx: anchorKey ? saved!.anchorOffsetPx ?? null : null,
      });
    }
  }

  // Drive the store: durable rows + inflight envelopes. Projection +
  // reconciler bring the DOM into agreement. NO clear/iterate loop —
  // the reconciler walks both old and new keys, updates in place,
  // removes orphans. NO divergence-heal — the store IS the source.
  if (opts?.preserveScrollIfLive && sameSession) {
    // Background reconcile refetch of the ON-SCREEN chat (the post-reply
    // durable refresh / disconnect reconcile) fetches only the TAIL page.
    // Merge it so loaded-earlier history the user scrolled up to load
    // survives (field bug 2026-06-15). A fresh navigation / boot resume —
    // which doesn't pass preserveScrollIfLive — still replaces wholesale.
    transcriptStore.mergeTailRefresh(id, messages, {
      firstId: pagination?.firstId ?? null,
      hasMore: !!pagination?.hasMore,
    });
  } else {
    transcriptStore.setDurable(id, messages, {
      firstId: pagination?.firstId ?? null,
      hasMore: !!pagination?.hasMore,
    });
  }
  // Only clobber inflight when the caller explicitly passed an array.
  // The cache-render path in sessionDrawer.resume passes undefined so
  // the live inflight envelopes (user_message echo + reply_delta
  // accumulated while a SEPARATE chat was viewed) survive switch-back.
  // Without this guard, a cached resume's setInflight([]) would wipe
  // in-flight envelopes (user_message echo + reply_delta) accumulated
  // while a separate chat was viewed — the user bubble + agent reply
  // would vanish on switch-back. The full server-fetch re-render
  // normally repopulates, but the cache-match optimization doesn't
  // always re-paint cleanly.
  // Staleness guard: a server fetch races the live SSE stream — its
  // inflight snapshot reflects REQUEST time, and by the time the
  // response lands the stream may already have delivered reply_final
  // for the turn. Applying such a snapshot wipes the final from the
  // store: the reply bubble vanishes and the turn's tool activity row
  // regresses from 'complete' back to an in-progress spinner until the
  // post-final durable refresh repairs it (~1s of visible rollback;
  // deterministic flake in mid-turn-switch-tools-survive). If the
  // incoming snapshot would LOSE a reply_final the store currently
  // holds, it's provably stale — keep the newer live state. An empty
  // incoming inflight still applies when we hold no reply_final (the
  // reconnect-after-gap drain path relies on that).
  if (Array.isArray(inflight)) {
    const incomingFinals = new Set(
      inflight
        .filter((e: any) => e?.type === 'reply_final')
        .map((e: any) => e.message_id),
    );
    const losesFinal = transcriptStore.getState(id).inflight.some(
      (e: any) =>
        e.type === 'reply_final' &&
        (e as { message_id?: string }).message_id &&
        !incomingFinals.has((e as { message_id?: string }).message_id),
    );
    if (losesFinal) {
      diag(
        `[chat-resume] skipping stale inflight snapshot chat=${id} ` +
        `incoming=${inflight.length} (would drop a live reply_final)`,
      );
    } else {
      transcriptStore.setInflight(id, inflight);
    }
  }

  // Force a render — setViewed may have flipped during a notify pass
  // and the subscriber's last call landed on the old chat. rerenderActive
  // is idempotent.
  rerenderActive();

  // Switch-then-load: the row-click handler may have added
  // `.transcript-loading` (blanked + spinner) for this switch. rerenderInto
  // clears it once a NON-EMPTY render lands, but an empty chat (0 durable
  // messages, no inflight) would never trip that path and the spinner
  // would spin forever. Clear unconditionally here now that the target
  // chat's content has been applied — this is the definitive "incoming
  // transcript is rendered" signal.
  document.getElementById('transcript')?.classList.remove('transcript-loading');

  // Announce-on-switch: fires the toast + spoken nickname iff this render
  // matches a user-armed drawer tap and it's a real different-session
  // switch. Placed AFTER replyNavigator.reset() (line ~116) so the spoken
  // nickname isn't immediately cancelled by the switch's TTS reset.
  sessionAnnounce.consume(id, sameSession);

  // Read the cursors back from the store: a preserve-head merge (above)
  // keeps the buffer's OLDER cursor rather than the tail page's, so the
  // tail-page firstId here would be wrong (it would point load-earlier at
  // the wrong place and re-fetch already-loaded rows). The store holds the
  // authoritative cursors after the durable mutation.
  const effPag = transcriptStore.getState(id).pagination;
  chat.setPaginationState(
    effPag.firstId, effPag.hasMore, effPag.lastId, effPag.hasMoreNewer,
  );
  // If the resume was driven by a message-search hit, find the matching
  // bubble and scroll it into view + flash. Best-effort: if the hit
  // predates the initial replay window (older than the first ~200
  // messages), the bubble isn't in the DOM and we fall back to the
  // standard scroll-to-bottom. Drill-to-message via load-earlier is
  // a separate backlog item — see backlog.md.
  if (targetMessageId) {
    const transcriptEl = document.getElementById('transcript');
    // Bubble data-key is the bare parley_id post-v2 (2026-05-29);
    // matches activity-tray's stored messageId 1:1 with no prefix
    // gymnastics. Plain querySelector lookup.
    const target: HTMLElement | null =
      transcriptEl?.querySelector(`[data-key="${CSS.escape(targetMessageId)}"]`) as HTMLElement | null;
    if (target) {
      chat.suppressLazyLoadFor(1200);
      drillScrollTo(target);
      target.classList.add('search-target-flash');
      const flashTarget = target;
      setTimeout(() => flashTarget.classList.remove('search-target-flash'), 1500);
      return true;   // painted (drill-flash path skips only the scroll-restore below)
    }
    // Target ISN'T in the initial replay window — drive load-earlier
    // pages until we find it or run out. Async / fire-and-forget.
    log(`[cmdk] target ${targetMessageId} not in initial window — driving load-earlier drill`);
    void drillToOlderMessage(id, targetMessageId, pagination?.firstId ?? null, !!pagination?.hasMore);
  }
  // Restore scroll. Three cases:
  //   - cache miss → scroll to bottom (default for new / never-viewed chats).
  //   - saved.atBottom=true → user was at the live edge at save time. Snap
  //     to the current bottom + scheduleAtBottomRepin (handles "new messages
  //     arrived while away" + post-render layout growth).
  //   - saved.atBottom=false → mid-chat. Restore the literal scrollTop
  //     with a single instant scrollTo. NO maxTop heuristic: comparing
  //     saved against the current maxTop falsely fires "at-edge" when the
  //     initial cache render is partial (a 335-message chat painting just
  //     200 → maxTop=6958 even though the chat's true height ends up
  //     12836). Field bug 2026-05-24 (scroll_save_failing2.mov sequel):
  //     [pitch deck] mid-history restored to bottom + repin → drift
  //     5385px as more bubbles + tool rows + images rendered.
  if (opts?.preserveScrollIfLive && sameSession && !targetMessageId) {
    // BACKGROUND refetch of the chat already on screen — NOT a user
    // navigation. Callers that pass this flag are reconcile paths: the
    // post-reply durable refresh (schedulePostFinalDurableRefresh) and the
    // disconnect reconcile (onResume). The on-screen scroll position is
    // LIVE truth here; re-applying the SAVED anchor/at-edge position fights
    // the user. A post-reply re-resume's anchor-restore can yank the view
    // UP away from the just-arrived reply and fight manual scrolling. Follow
    // the
    // live edge only if still pinned (so a reply the user is watching keeps
    // streaming into view); otherwise leave scroll EXACTLY as-is.
    //
    // This is deliberately NOT the broad `sameSession` gate: boot/reload
    // ALSO re-resumes with sameSession=true (boot setViewed precedes the
    // restoring resume) and legitimately needs to restore saved scroll —
    // those paths don't pass preserveScrollIfLive, so their restore below
    // still runs.
    if (chat.isPinnedToBottom()) chat.forceScrollToBottom();
  } else if (sameSession && Date.now() - chat.lastUserScrollGestureAt() < 1500 && !targetMessageId) {
    // #202 (field 2026-06-12): a same-session re-resume (server callback
    // landing seconds after the cache render on a slow link) must NOT
    // re-apply the saved position while the user is actively scrolling —
    // the restore yanks the view out from under their finger. The live
    // on-screen position IS the user's position; leave it alone. A fresh
    // navigation (different session) still restores: the gesture happened
    // in the sidebar, not the transcript, so this gate doesn't fire.
    log('[chat-resume] skip saved-position restore — user gesture <1.5s ago');
  } else if (saved && !targetMessageId) {
    const el = document.getElementById('transcript');
    if (el) {
      // Anchor restore: when the saved record carries an anchorKey, put
      // that same bubble back at the same viewport offset via the DOM
      // (every bubble is in the DOM under full-DOM render). Falls back to
      // atBottom/scrollTop if the key isn't present (paginated out /
      // deleted).
      //
      // Precedence: saved.atBottom WINS over anchor restore. The anchor
      // key captures whichever bubble was first-visible at save time —
      // for an at-bottom view that's some row roughly one viewport above
      // the live edge. Restoring to that anchor pins the user to that
      // row, not to the bottom; if new turns arrived the user ends up
      // visibly ABOVE the bottom. atBottom is the user-intent flag;
      // honor it first.
      // isDurableMessageKey rejects a LEGACY saved anchor from before
      // getDomAnchor started refusing synthetic keys (src/chat.ts). A
      // diag line names the bad key so we can tell, from the field,
      // how many pre-fix saves are still floating around.
      if (saved.anchorKey && !isDurableMessageKey(saved.anchorKey)) {
        diag(`[chat-resume] discarding synthetic saved anchor key=${saved.anchorKey}`);
      }
      const tryAnchor = !saved.atBottom
        && saved.anchorKey && typeof saved.anchorOffsetPx === 'number'
        && isDurableMessageKey(saved.anchorKey)
        ? chat.restoreDomAnchor({ key: saved.anchorKey, offsetPx: saved.anchorOffsetPx })
        : false;
      if (tryAnchor) {
        log(`[chat-resume] restore via anchor key=${saved.anchorKey?.slice(0, 16)} offset=${saved.anchorOffsetPx}`);
        // We are NOT at the bottom — assert it so a stray autoScroll (or a
        // false-positive isPinned() at the post-clear scrollTop≈0) can't
        // snap us to the live edge while the chat finishes rendering and
        // fight this anchor restore. Field 2026-05-26 (pitch deck).
        chat.setPinnedToBottom(false);
        // NO load-earlier suppress here. The anchor restore lands the
        // user back on the SAME bubble they were viewing, with the SAME
        // viewport offset. Unlike the legacy mid-chat scrollTop restore,
        // we don't need a 1.5s suppress window — the chat IS in a
        // user-meaningful position immediately after restoreAnchor,
        // and any subsequent scroll-to-top is a genuine user gesture
        // that should fire load-earlier. Field bug 2026-05-25 (smoke):
        // load-earlier-history failed because two duplicate resumes
        // both ran the anchor branch (cache-cb + server-cb path), the
        // second suppress blocked the smoke's immediate scrollTop=0.
      } else if (saved.atBottom) {
        log(`[chat-resume] restore at-edge (atBottom=true savedScrollTop=${saved.scrollTop}) → forceScrollToBottom + repin`);
        // Suppress lazy-prepend across the open render: the full-DOM
        // reconcile briefly sits at scrollTop≈0 before forceScrollToBottom
        // lands, which would trip maybeLoadEarlier and fetch+prepend an
        // older page on every open — cascading toward the top of a big
        // chat (the "load everything on open" cost the virtualizer used to
        // hide). The user is at the live edge here; a genuine scroll-to-top
        // after the window expires still loads earlier.
        chat.suppressLazyLoadFor(800);
        chat.forceScrollToBottom();
        scheduleAtBottomRepin();
      } else {
        log(`[chat-resume] restore mid-chat saved=${saved.scrollTop}`);
        // Cancel any sibling chat's still-live at-bottom repin
        // observer — it would otherwise scroll us to the live edge
        // as A's content fills the transcript.
        cancelActiveAtBottomRepin?.();
        // Suppress lazy-prepend for a beat. Restoring near scrollTop=0
        // would otherwise trip maybeLoadEarlier (any scrollTop within
        // LOAD_EARLIER_THRESHOLD_PX of 0 fires lazy-load), and
        // prependHistory would shift scrollTop by the height of the
        // prepended content — dragging the user off `saved`.
        chat.suppressLazyLoadFor(1500);
        chat.setPinnedToBottom(false);
        el.scrollTo({ top: saved.scrollTop, behavior: 'instant' as ScrollBehavior });
        // The scrollTo fires a scroll event synchronously; the listener
        // updates pinnedToBottom from isPinned() against the restored
        // position, so subsequent autoScroll calls during post-render
        // layout settle correctly skip (mid-chat → pinned=false).
      }
    }
  } else if (!targetMessageId) {
    log(`[chat-resume] no saved position for ${id.slice(-12)} → forceScrollToBottom`);
    // See at-bottom branch: suppress the open-render scrollTop≈0 transient
    // from triggering a load-earlier prepend cascade on a fresh open.
    chat.suppressLazyLoadFor(800);
    chat.forceScrollToBottom();
    scheduleAtBottomRepin();
  }
  return true;
}

/** Re-pin to the bottom of the transcript whenever scrollHeight grows
 *  during a brief window after a forceScrollToBottom restore. Handles
 *  async DOM enhancement (play-bars, copy buttons, etc.) that add
 *  height after the initial render — without this, the user lands at
 *  the (smaller) post-render bottom and drifts mid-chat as content
 *  grows. Disconnects on first user scroll-up so we don't fight an
 *  intentional reading position. 1.5s window covers the common
 *  cases without lingering. */
const REPIN_WINDOW_MS = 1500;
/** The active scheduleAtBottomRepin's teardown callback. Cancel before
 *  starting a new replay so a fast switch (chat B at-edge → chat A
 *  mid-chat within REPIN_WINDOW_MS) doesn't have B's still-live
 *  ResizeObserver dragging A's scrollTop to the live edge. */
let cancelActiveAtBottomRepin: (() => void) | null = null;
function scheduleAtBottomRepin(): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl || typeof ResizeObserver === 'undefined') return;
  // Cancel any previous repin from a sibling chat that hasn't expired yet.
  cancelActiveAtBottomRepin?.();
  // Re-pin to the bottom when the transcript (or a child bubble) resizes
  // during the settle window after a restore-to-bottom — BUT only while the
  // user is still pinned to the bottom. `chat.isPinnedToBottom()` is the
  // SINGLE source of truth, updated on EVERY scroll event (wheel, touch,
  // AND programmatic / virtualizer-rerender scrolls), so the instant the
  // user scrolls up off the bottom this re-pin yields — it can no longer
  // fight the user. The old wheel/touch/pointerdown "intent" detection
  // missed programmatic + rerender-driven scrolls and snapped the user back
  // to the bottom (field 2026-05-27: scroll-up didn't stick). Follow-the-
  // tail during streaming is handled by autoScroll() on each append; this
  // RO just covers async height growth (play-bars, late images) post-restore.
  // ALSO yield once the user has scroll-gestured on the transcript since
  // this repin was armed (field 2026-07-27, scroll-jump-diag-harness
  // variant 1): a wheel-up's first ~300px keeps isPinnedToBottom() true
  // (PINNED_THRESHOLD_PX is generous by design), so within that window a
  // late server render's height growth woke this RO and yanked the view
  // +135px DOWN against the user's active wheel. The gesture timestamp is
  // the same #202 signal that cancels anchor restores; arming time is
  // captured here so gestures BEFORE the restore (e.g. scrolling around,
  // then clicking jump-to-bottom — a button click is not a transcript
  // gesture) don't starve a legitimate repin.
  const armedAt = Date.now();
  const ro = new ResizeObserver(() => {
    if (!chat.isPinnedToBottom()) return;
    if (chat.lastUserScrollGestureAt() >= armedAt) return;
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
  });
  ro.observe(transcriptEl);
  // Also observe direct children — scrollHeight changes when a CHILD grows
  // (e.g. a bubble gets a play-bar appended); the parent RO fires for its
  // own size only, not children's.
  for (const child of Array.from(transcriptEl.children)) {
    if (child instanceof HTMLElement) ro.observe(child);
  }
  const teardown = () => {
    ro.disconnect();
    if (cancelActiveAtBottomRepin === teardown) cancelActiveAtBottomRepin = null;
  };
  cancelActiveAtBottomRepin = teardown;
  // Let a session switch cancel this repin at switch START (before the
  // switch-then-load clear collapses scrollHeight and wakes the RO). The
  // closure always cancels whatever the current active repin is.
  chat.registerAtBottomRepinCanceller(() => cancelActiveAtBottomRepin?.());
  setTimeout(teardown, REPIN_WINDOW_MS);
}

// Let the jump-to-bottom button engage the same settle-window repin the
// restore paths use. Registered at module init (sessionResume is imported
// during boot) so the seam is live before the first chevron click.
chat.registerAtBottomRepinScheduler(scheduleAtBottomRepin);

// Crack A: renderHistoryMessage and its anchor helpers are GONE.
// The projection + reconciler own per-row rendering from the canonical
// ChatState. inflightSignalsMidTurn / bubbleIdFor / findReplayAnchor
// / isNotificationItem all deleted alongside.

/** Scroll the target bubble's TOP to the top of the transcript
 *  viewport — bypassing CSS `scroll-behavior: smooth` set on
 *  `.transcript`. Direct `scrollTop` assignment is universally
 *  instant; `scrollIntoView({behavior:'instant'})` is NOT honored on
 *  iOS WKWebView (Safari treats `'instant'` as `'auto'` which defers
 *  to the CSS smooth, so the animation runs — racing layout shifts
 *  and load-earlier triggers along the way). Without the rAF re-fire,
 *  iOS pins could drift because the smooth animation kept running past
 *  load-earlier prepends.
 *
 *  Compute target scrollTop from current rects so prior layout shifts
 *  (load-earlier prepends, etc.) don't matter. Then re-fire on rAF
 *  to catch any post-paint shifts (image decode, tool-call expansion). */
function drillScrollTo(target: HTMLElement): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  // Cancel any still-live scheduleAtBottomRepin observer. Without
  // this, the RO sees post-drill scrollHeight growth (e.g. from the
  // load-earlier prepend that brought the target into view) and
  // snaps scrollTop back to scrollHeight — the drillScrollTo retries
  // race against repin and the user lands at the wrong position.
  // Field bug 2026-05-25 (pin-drawer-cycle-scrollback · mobile flake).
  cancelActiveAtBottomRepin?.();
  // De-pin so autoScroll() in rerenderInto (the follow-tail hook we
  // added with the virtualizer gut) doesn't snap us back to the bottom
  // on the next render — the user explicitly asked to be at THIS
  // bubble, not the live edge. Without this, autoScroll can yank back
  // to scrollHeight on a duplicate-resume render after drillScrollTo.
  //
  // HOLD the de-pin, don't just set it (depin-vs-reconcile-repin race,
  // field 2026-07-21, activity-row-drills-to-bubble 2/5 flake once a
  // tap-time unread-clear shifted the timing). Two-part pathology:
  //   1. The target bubble can be transiently MIS-SORTED to the tail
  //      when the drill render runs (a background reply's live-envelope
  //      bubble carries arrival-time until the durable reconcile heals
  //      its timestamp), so `apply` scrolls to the BOTTOM (clamped) —
  //      and the scroll listener's geometric re-derivation re-latches
  //      pinnedToBottom=true (distance 0 ≤ threshold). Every subsequent
  //      rerender's autoScroll then snaps to the live edge while the
  //      heal re-sorts the bubble up and out of view.
  //   2. The one-shot 120ms retry expires before that reconcile lands.
  // holdUnpinnedFor suspends the geometric re-latch (and therefore
  // autoScroll) for the settle window; the settle loop below re-anchors
  // the target if a late re-sort moves it. A real user gesture releases
  // both immediately.
  chat.holdUnpinnedFor(DRILL_SETTLE_MS);
  const drillStartedAt = Date.now();
  const apply = () => {
    const tr = transcriptEl.getBoundingClientRect();
    const tg = target.getBoundingClientRect();
    // Desired scrollTop: bring target's top to transcript's top (with
    // an 8px slack so the bubble has visual breathing room from the
    // viewport edge). CSS `scroll-behavior: smooth` on .transcript
    // applies to programmatic scrolls too (including direct scrollTop
    // assignment), which racing the smooth animation against layout
    // shifts produces the iOS "lands wrong" symptom. Override inline,
    // assign, restore — the change is observable only within this
    // microtask, no flicker.
    const prevBehavior = transcriptEl.style.scrollBehavior;
    transcriptEl.style.scrollBehavior = 'auto';
    const desired = transcriptEl.scrollTop + (tg.top - tr.top) - 8;
    // Absolute target seat — re-baseline chat's relative settle
    // compensator so it can't add its own delta for a shift this apply
    // just absorbed (belt over the holdUnpinnedFor gate: the settle
    // watchers below outlive the hold by ~50ms).
    chat.noteAbsoluteScrollSeat();
    transcriptEl.scrollTop = Math.max(0, desired);
    transcriptEl.style.scrollBehavior = prevBehavior;
  };
  target.classList.add('search-target-flash');
  apply();
  // Task-boundary correction. The drill can run MID-render-task: rows the
  // same task appends AFTER this call (timestamp-sorted inserts above a
  // transiently mis-sorted target) push the target away from the position
  // the synchronous apply just established — and the MutationObserver
  // below only sees mutations from LATER tasks (observe starts after this
  // task's mutations already fired). A microtask runs at THIS task's end,
  // after all of its DOM work, before any other task (or a smoke's
  // evaluate) can observe the transcript — so the drill task never leaves
  // a visibly wrong position behind. (Measured: without this, the target
  // sat below the fold for the ~70ms until the next rAF under render
  // load — activity-row-drills-to-bubble's sample window.)
  queueMicrotask(() => { if (target.isConnected && drifted()) apply(); });
  requestAnimationFrame(apply);
  // Settle defense: re-anchor the target through the reconcile window.
  // Late-rendering content (images decoding, tool summaries hydrating),
  // the durable-heal re-sort described above, AND width-change re-wraps
  // all move the target after the first paint. Three watchers, one apply:
  //   - A MutationObserver re-anchors in the SAME task as a reconcile
  //     re-sort (MO callbacks are microtasks — they run before the next
  //     paint and before any other task can observe the target sitting
  //     out of view). The 150ms-poll version of this lost the race to
  //     anything sampling right after the re-sort.
  //   - A ResizeObserver on the transcript + its rows catches pure
  //     LAYOUT drift, which mutates no nodes and is invisible to the MO
  //     (measured: the activity drawer closing over the drill re-wraps
  //     every row — ~170px of growth above the target across ~70ms —
  //     and shoved the target below the fold between rAF frames). RO
  //     callbacks fire in the rendering steps, so each frame's drift is
  //     corrected pre-paint instead of accumulating. Same pattern as
  //     scheduleAtBottomRepin, opposite anchor.
  //   - A slow poll backstops anything neither observer sees.
  // All stand down when the window expires, the target leaves the DOM
  // (session switched), or the user scrolls (their gesture owns the
  // viewport from that instant) — and all only write when the target
  // actually drifted off the anchor position.
  const drifted = () => {
    const tr = transcriptEl.getBoundingClientRect();
    const tg = target.getBoundingClientRect();
    return Math.abs((tg.top - tr.top) - 8) > 4;
  };
  let settleDone = false;
  const finish = () => { settleDone = true; mo.disconnect(); ro.disconnect(); };
  const stillDrilling = () => {
    if (settleDone) return false;
    if (Date.now() - drillStartedAt > DRILL_SETTLE_MS
        || !target.isConnected
        || chat.lastUserScrollGestureAt() >= drillStartedAt) {
      finish();
      return false;
    }
    return true;
  };
  const mo = new MutationObserver(() => {
    if (stillDrilling() && drifted()) apply();
  });
  mo.observe(transcriptEl, { childList: true, subtree: true });
  const ro = new ResizeObserver(() => {
    if (stillDrilling() && drifted()) apply();
  });
  ro.observe(transcriptEl);
  for (const child of Array.from(transcriptEl.children)) {
    if (child instanceof HTMLElement) ro.observe(child);
  }
  const poll = () => {
    if (!stillDrilling()) return;
    if (drifted()) apply();
    setTimeout(poll, 150);
  };
  setTimeout(poll, 120);
  setTimeout(finish, DRILL_SETTLE_MS + 50);
}
/** How long drillScrollTo defends the drilled position against late
 *  layout shifts / reconcile re-sorts. Mirrors REPIN_WINDOW_MS — the
 *  same "post-restore settle" horizon, opposite anchor. */
const DRILL_SETTLE_MS = 1500;

/** Page through older history pages until the target message renders
 *  in the DOM, then scroll-and-flash it. Driven by the pin-drawer
 *  jump path (and any cmdk hit on a message OLDER than the resume
 *  window). Caps at 10 pages (~500 msgs) so a stale msgId can't drive
 *  an unbounded backfill. Field bug 2026-05-13. */
const DRILL_PAGE_CAP = 10;
async function drillToOlderMessage(
  chatId: string,
  targetMessageId: string,
  initialFirstId: number | null,
  initialHasMore: boolean,
): Promise<void> {
  // One bounded around-window fetch first (the 5–20s deep-pin lag fix);
  // fall through to the serial loadEarlier loop only when the target is
  // missing from the around result.
  if (await drillViaAroundWindow(chatId, targetMessageId)) {
    await ensureTailAfterDrill(chatId);
    return;
  }
  await drillViaSerialOlderPages(chatId, targetMessageId, initialFirstId, initialHasMore);
}

/** Same-session jump to a message bubble — the chat is ALREADY rendered.
 *  Must NOT route through sessionDrawer.resume(): that re-resumes the
 *  session (cache render + server reconcile, EACH driving its own drill =
 *  redundant ~1MB ?around= round trips that saturate a high-latency link)
 *  AND its in-flight dedup keys only on chat id, so a rapid second jump to
 *  a DIFFERENT target in the same session gets swallowed and the bubble
 *  never appears (one jump can hang forever while the next fires several
 *  concurrent large fetches). Instead: scroll+flash if the bubble is already
 *  in the DOM (instant), else ONE bounded around fetch, else serial
 *  older-page paging. */
export async function drillToMessageInViewedSession(
  chatId: string,
  targetMessageId: string,
): Promise<void> {
  const transcriptEl = document.getElementById('transcript');
  const existing = transcriptEl?.querySelector(
    `[data-key="${CSS.escape(targetMessageId)}"]`,
  ) as HTMLElement | null;
  if (existing) {
    chat.suppressLazyLoadFor(1200);
    existing.classList.add('search-target-flash');
    drillScrollTo(existing);
    setTimeout(() => existing.classList.remove('search-target-flash'), 1500);
    return;
  }
  if (await drillViaAroundWindow(chatId, targetMessageId)) {
    await ensureTailAfterDrill(chatId);
    return;
  }
  const s = transcriptStore.getState(chatId);
  await drillViaSerialOlderPages(
    chatId, targetMessageId, s.pagination.firstId, s.pagination.hasMore,
  );
}

/** Single-flight bounded "items around target" drill. Returns true once
 *  the target rendered + scrolled. Keyed by chat+target so the cache-render
 *  and server-render passes of one resume() collapse to a SINGLE ?around=
 *  fetch instead of two concurrent ~1MB round trips. The plugin returns a
 *  window centered on the target (context above + below), capped at ~limit
 *  rows — payload O(limit), independent of how deep the target sits. We
 *  REPLACE the transcript with this floating window and arm BIDIRECTIONAL
 *  pagination: scroll-up walks older via loadEarlierHistory, scroll-down
 *  walks newer via loadLaterHistory back toward the live tail. */
// Keep the initial drill window TIGHT — just enough rows to render the
// target centered with a screenful of scrollback. A row can carry a large
// tool result, so a full 200-row page is ~830KB; over a high-latency link
// that's the bulk of a deep jump's wait over a high-latency link.
// A ~40-row window is ~290KB (~1/3) and still fills the viewport; the user
// pulls more in by scrolling (gated loadEarlier/loadLater).
const DRILL_AROUND_LIMIT = 40;
let aroundDrillInFlight: { key: string; promise: Promise<boolean> } | null = null;

// Shared single-flight for the bounded ?around= fetch, keyed
// `${chatId}::${targetMessageId}`. Both the pin prewarm (#243) and a user
// drill route their around fetch through here, so a drill that races a
// just-fired prewarm — or a prewarm that races a drill — reuses the ONE
// in-flight request instead of issuing a redundant ~290KB round trip on a
// slow link (the double-fetch drill-prefetch-gate would otherwise count).
// The resolved window is written to drillWindowCache exactly once.
const aroundFetchInFlight = new Map<string, Promise<any>>();

function fetchAroundWindowOnce(chatId: string, targetMessageId: string): Promise<any> {
  // Read-side guard (shared by drillViaAroundWindow, prewarmPinnedWindows,
  // prewarmActivityWindows — every caller of this function): a saved
  // anchor or prewarm target keyed by a client-only SYNTHETIC id
  // (pending:turn:…, turn:status, gap:…, …) has no server-side row to
  // build an `around=` window on. This is the round trip §1 of
  // UX_DETERMINISM_PLAN.md caught (`around=pending:turn:umsg_…`, n=0,
  // field 2026-09-05). Skip the fetch and report shape-compatible
  // "not found" so every caller falls back exactly as it would for a
  // deleted/missing target — never issue the doomed request.
  if (!isDurableMessageKey(targetMessageId)) {
    diag(`[around-window] skip synthetic key chat=${chatId} key=${targetMessageId}`);
    return Promise.resolve({ targetFound: false, messages: [] });
  }
  const key = `${chatId}::${targetMessageId}`;
  const existing = aroundFetchInFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    const around: any = await backend.fetchMessagesAround(chatId, targetMessageId, DRILL_AROUND_LIMIT);
    if (around?.targetFound && Array.isArray(around.messages) && around.messages.length) {
      void windowCache.putWindow(chatId, targetMessageId, around.messages, {
        firstId: around.firstId ?? null,
        hasMore: !!around.hasMore,
        lastId: around.lastId ?? null,
        hasMoreNewer: !!around.hasMoreNewer,
      });
    }
    return around;
  })();
  aroundFetchInFlight.set(key, p);
  void p.catch(() => {}).finally(() => {
    if (aroundFetchInFlight.get(key) === p) aroundFetchInFlight.delete(key);
  });
  return p;
}

// #243 — pin around-window prewarm.
//
// A pinned message's deep `around` window only lands in drillWindowCache
// AFTER the user's first manual drill to it (drillViaAroundWindow →
// putWindow). So the FIRST click on each pin pays the full cold ?around=
// round trip — the "ages"-long spinner on a slow link — and only after
// cycling every pin once did they all turn instant (Jonathan, CAP,
// 2026-06-15). warmPrefetch warms top-recent session TAILS, not pin
// around-windows, so it never closed this gap. Fix: warm each pinned
// message's window in the background — on boot (after pins hydrate) and on
// pin-add — so the first real click is a cache hit. Bounded: one ?around=
// per pin, serial and yielding to any active drill so a speculative
// prewarm never steals bandwidth from a user-initiated one.
//
// prewarmedPinKeys remembers keys fetched (or being fetched) this
// app-session so the repeated `parley:pins-changed` events (boot
// hydrate, server reconcile, cross-device sync) don't re-issue work for
// windows already warm. A transient fetch failure deletes its key so a
// later trigger retries.
const prewarmedPinKeys = new Set<string>();
let prewarmRunning = false;
let prewarmDirty = false;

export async function prewarmPinnedWindows(): Promise<void> {
  // Single-flight: a trigger arriving mid-run sets dirty so we re-loop
  // once (picks up a pin added during the run) instead of overlapping.
  if (prewarmRunning) { prewarmDirty = true; return; }
  prewarmRunning = true;
  try {
    do {
      prewarmDirty = false;
      for (const pin of listAllPins()) {
        const key = `${pin.chatId}::${pin.msgId}`;
        if (prewarmedPinKeys.has(key)) continue;
        // Yield to a user-initiated drill in flight — its window matters
        // more than a speculative prewarm, and they'd compete for the link.
        if (aroundDrillInFlight) await aroundDrillInFlight.promise.catch(() => {});
        // Already cached from a previous drill/prewarm? Mark + skip the fetch.
        const cached = await windowCache.getWindow(pin.chatId, pin.msgId);
        if (cached) { prewarmedPinKeys.add(key); continue; }
        prewarmedPinKeys.add(key);
        try {
          // Routes through the shared single-flight so a concurrent user
          // drill to the same pin reuses this fetch (and vice-versa); the
          // helper writes the window to drillWindowCache on success.
          const around: any = await fetchAroundWindowOnce(pin.chatId, pin.msgId);
          if (around?.targetFound && Array.isArray(around.messages) && around.messages.length) {
            diag(`[pin-prewarm] warmed ${key} (n=${around.messages.length})`);
          } else {
            diag(`[pin-prewarm] ${key} target not found; skipping`);
          }
        } catch (e: any) {
          // Transient failure — allow a later trigger to retry this key.
          prewarmedPinKeys.delete(key);
          diag(`[pin-prewarm] ${key} fetch failed: ${e?.message ?? e}`);
        }
        // Breathe between fetches so a burst of pins doesn't saturate the link.
        await new Promise<void>(r => setTimeout(r, 0));
      }
    } while (prewarmDirty);
  } finally {
    prewarmRunning = false;
  }
}

// Activity around-window prewarm — same class of fix as the pin prewarm
// above, applied to the activity tray.
//
// Field report (CAP, 2026-06-15): a cron/agent_reply row arrives in the
// activity tray; clicking it routes to the right session but the message
// isn't there and loads ~20s later. Root cause is identical to the pin
// case: an activity item carries BOTH a chatId and a messageId
// (activityStore ActivityItem), and clicking the row drills via the
// bounded ?around= window centered on that (often DEEP) messageId
// (main.ts onActivityOpen → drillToChatMessage → drillViaAroundWindow).
// That window only lands in drillWindowCache AFTER the first manual drill,
// so the first click pays the full cold round trip.
//
// Fix: warm each activity item's around-window in the background — on boot
// (after activity hydrates) and whenever the activity store changes
// (`parley:activity-changed` + the server-reconcile
// `parley:server-activity-changed`). The target (chatId, messageId) pair
// is known at INGEST time, well before the click, so we can warm it ahead.
//
// Shares fetchAroundWindowOnce + drillWindowCache with the pin prewarm and
// the live drill — keyed `${chatId}::${messageId}` — so a prewarmed
// activity window is a cache HIT on click, and an activity item that points
// at the SAME (chatId, messageId) as a pin reuses the one in-flight fetch
// (no double round trip). prewarmedActivityKeys dedups repeated change
// events this app-session; a transient fetch failure deletes its key so a
// later trigger retries.
//
// Bounding: the activity store fetches up to 200 items. We cap to the most
// recent ACTIVITY_PREWARM_CAP (listActivity is sorted newest-first, modulo
// unresolved-approval priority) — the rows the user is realistically about
// to tap. Items WITHOUT a messageId are skipped: their click resumes the
// tail (no around-window), so there's nothing deep to warm. The
// getWindow-skip + key dedup keep a near-tail messageId cheap (it just
// produces a small contiguous window), so we don't try to guess depth.
const ACTIVITY_PREWARM_CAP = 20;
const prewarmedActivityKeys = new Set<string>();
let prewarmActivityRunning = false;
let prewarmActivityDirty = false;

export async function prewarmActivityWindows(): Promise<void> {
  // Single-flight: a trigger arriving mid-run sets dirty so we re-loop once
  // (picks up an item ingested during the run) instead of overlapping.
  if (prewarmActivityRunning) { prewarmActivityDirty = true; return; }
  prewarmActivityRunning = true;
  try {
    do {
      prewarmActivityDirty = false;
      const items = listActivity().slice(0, ACTIVITY_PREWARM_CAP);
      for (const item of items) {
        const chatId = item.chatId;
        const msgId = item.messageId;
        // Skip rows that don't drill to a specific bubble: no chatId, or no
        // messageId (those resume the tail, which warmPrefetch already
        // covers — there's no deep around-window to prewarm).
        if (!chatId || !msgId) continue;
        const key = `${chatId}::${msgId}`;
        if (prewarmedActivityKeys.has(key)) continue;
        // Yield to a user-initiated drill in flight — its window matters
        // more than a speculative prewarm, and they'd compete for the link.
        if (aroundDrillInFlight) await aroundDrillInFlight.promise.catch(() => {});
        // Already cached (by a previous drill, a pin prewarm, or an earlier
        // activity prewarm)? Mark + skip the fetch.
        const cached = await windowCache.getWindow(chatId, msgId);
        if (cached) { prewarmedActivityKeys.add(key); continue; }
        prewarmedActivityKeys.add(key);
        try {
          // Shared single-flight: a concurrent user drill (or pin prewarm)
          // to the same (chatId, messageId) reuses this fetch and vice-
          // versa; the helper writes the window to drillWindowCache on
          // success.
          const around: any = await fetchAroundWindowOnce(chatId, msgId);
          if (around?.targetFound && Array.isArray(around.messages) && around.messages.length) {
            diag(`[activity-prewarm] warmed ${key} (n=${around.messages.length})`);
          } else {
            diag(`[activity-prewarm] ${key} target not found; skipping`);
          }
        } catch (e: any) {
          // Transient failure — allow a later trigger to retry this key.
          prewarmedActivityKeys.delete(key);
          diag(`[activity-prewarm] ${key} fetch failed: ${e?.message ?? e}`);
        }
        // Breathe between fetches so a burst of items doesn't saturate the link.
        await new Promise<void>(r => setTimeout(r, 0));
      }
    } while (prewarmActivityDirty);
  } finally {
    prewarmActivityRunning = false;
  }
}

/** Render a bounded around-window into the transcript and scroll/flash
 *  the target. Shared by the cache-first paint and the server pass of
 *  drillViaAroundWindow. Returns the target element, or null when the
 *  target didn't land in the DOM (caller falls back). */
async function renderAroundWindow(
  chatId: string,
  targetMessageId: string,
  messages: any[],
  pagination: windowCache.WindowPagination,
  opts: { skipScroll?: boolean; mode?: 'replace' | 'splice' } = {},
): Promise<HTMLElement | null> {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return null;
  // Drill renders must be full-DOM: the target lookup below decides
  // whether more paging is needed, and a still-active switch backfill
  // window would hide rows the store already holds.
  cancelWindowedReplay();
  // Arm the lazy-load suppress window BEFORE any render/scroll. The
  // bounded window lands the target mid-transcript, so the render +
  // scroll below can fire a scroll that would otherwise trip
  // maybeLoadEarlier/maybeLoadLater into a wasteful ?before=/?after=
  // page right after the drill. Setting it here (not after the scroll)
  // closes that leak.
  chat.suppressLazyLoadFor(1200);
  // We are jumping into the MIDDLE of the session — not at the live
  // tail. Assert un-pinned BEFORE the render so autoScroll can't snap
  // us to the window's bottom while it settles.
  chat.setPinnedToBottom(false);
  if (opts.mode === 'splice') {
    // Splice the window ALONGSIDE the existing tail with a gap marker
    // (issue #227): the tail stays in the buffer so scroll-to-bottom is
    // instant, and the disjoint range shows a tappable "…". spliceWindow
    // derives the resulting pagination (keeps the tail cursor); publish
    // it AFTER so chat's guards see the real post-splice state.
    transcriptStore.spliceWindow(chatId, messages, pagination);
    const sp = transcriptStore.getState(chatId).pagination;
    chat.setPaginationState(sp.firstId, sp.hasMore, sp.lastId, sp.hasMoreNewer);
  } else {
    // Arm pagination BEFORE the store mutation: setDurable fires the
    // reconciler synchronously, and chat's tail-invariant guards
    // (persist/saveCurrentScrollPosition skip while hasMoreNewer) must
    // already see the floating-window state when that render runs —
    // otherwise a windowed snapshot could slip into IDB.
    chat.setPaginationState(
      pagination.firstId, pagination.hasMore,
      pagination.lastId, pagination.hasMoreNewer,
    );
    transcriptStore.setDurable(chatId, messages, pagination);
  }
  rerenderActive();
  // Persist is a no-op while the window floats (hasMoreNewer); it
  // only writes once loadLater connects the run to the tail.
  persistGrownTranscript(chatId);
  await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const found = transcriptEl.querySelector(
    `[data-key="${CSS.escape(targetMessageId)}"]`,
  ) as HTMLElement | null;
  if (!found) return null;
  if (!opts.skipScroll) {
    found.classList.add('search-target-flash');
    drillScrollTo(found);
    setTimeout(() => found.classList.remove('search-target-flash'), 1500);
  }
  return found;
}

function drillViaAroundWindow(chatId: string, targetMessageId: string): Promise<boolean> {
  const key = `${chatId}::${targetMessageId}`;
  if (aroundDrillInFlight?.key === key) return aroundDrillInFlight.promise;
  const promise = (async (): Promise<boolean> => {
    if (!document.getElementById('transcript')) return false;
    // Decide ONCE, at drill start, whether to SPLICE the window alongside
    // the current tail or REPLACE the buffer with a floating window. Splice
    // only when the buffer already reaches the live tail (hasMoreNewer
    // false) and isn't empty — then the tail is preserved and the pin
    // window slots in above a gap marker (issue #227). Captured once so the
    // cache-paint and server-reconcile passes agree (the second pass is a
    // no-op against the spliced buffer). When the buffer is already a
    // floating window, replace (old behavior).
    const startState = transcriptStore.getState(chatId);
    const mode: 'replace' | 'splice' =
      !startState.pagination.hasMoreNewer && startState.durable.length > 0
        ? 'splice' : 'replace';
    // #214 TFC-C: cache-first. A window fetched by a previous drill to
    // this same anchor paints instantly from IDB; the server fetch below
    // STILL runs and re-renders (reconciling any drift and refreshing
    // the record's LRU recency via putWindow).
    const drillStartedAt = Date.now();
    let cacheRendered = false;
    try {
      const cached = await windowCache.getWindow(chatId, targetMessageId);
      if (cached && switchCtl.viewedId() === chatId) {
        cacheRendered = !!(await renderAroundWindow(
          chatId, targetMessageId, cached.messages, cached.pagination, { mode }));
        if (cacheRendered) log(`[cmdk] drill painted ${targetMessageId} from window cache; server reconcile in flight`);
      }
    } catch { /* cache problems → plain server drill */ }
    // #232 field fix: a deep drill that misses the window cache waits 5-20s
    // on the around-window fetch with NO feedback (the bubble isn't in the
    // DOM yet so there's nothing to flash). Show the centered transcript
    // spinner over the current view for the duration of the server fetch.
    // A cache hit already painted, so skip the spinner there (no flash).
    // rerenderInto clears `.transcript-loading` on the first non-empty render
    // when the window lands; the finally below guarantees removal on every
    // early return / failure path.
    const drillSpinnerEl = !cacheRendered ? document.getElementById('transcript') : null;
    drillSpinnerEl?.classList.add('transcript-loading');
    try {
      // Route through the shared single-flight so a concurrent prewarm of
      // this same pin reuses this fetch (and vice-versa); the helper writes
      // the window to drillWindowCache on success.
      const around: any = await fetchAroundWindowOnce(chatId, targetMessageId);
      // #241 instrumentation: log what session the server actually scoped the
      // around-window to. If `requested` ≠ the chat_id stamped on the returned
      // rows, the wrong-session render is server-side (data-model), not client.
      const sampleChatId = Array.isArray(around?.messages) && around.messages.length
        ? (around.messages[0]?.chat_id ?? around.messages[0]?.conversation ?? '∅') : '∅';
      diag(`[drill #241] around requested=${chatId} target=${targetMessageId} `
        + `targetFound=${!!around?.targetFound} n=${(around?.messages || []).length} rowChatId=${sampleChatId}`);
      if (switchCtl.viewedId() !== chatId) {
        log(`[cmdk] drill aborted — session changed during around fetch`);
        return cacheRendered;
      }
      if (!(around?.targetFound && Array.isArray(around.messages) && around.messages.length)) {
        // Server can't find the target (deleted?). If the cache already
        // painted it, keep that view rather than crawling older pages.
        return cacheRendered;
      }
      const pagination: windowCache.WindowPagination = {
        firstId: around.firstId ?? null,
        hasMore: !!around.hasMore,
        lastId: around.lastId ?? null,
        hasMoreNewer: !!around.hasMoreNewer,
      };
      // (putWindow now happens inside fetchAroundWindowOnce.)
      // After a cache paint on a slow link the user may already be
      // reading — don't re-yank the viewport if they've gestured since.
      const skipScroll = cacheRendered && chat.lastUserScrollGestureAt() > drillStartedAt;
      const found = await renderAroundWindow(
        chatId, targetMessageId, around.messages, pagination, { skipScroll, mode });
      if (!found) {
        if (cacheRendered) return true;
        log(`[cmdk] around window returned but ${targetMessageId} not in DOM — serial fallback`);
        return false;
      }
      log(`[cmdk] drill found ${targetMessageId} via bounded around window (1 round trip)`);
      return true;
    } catch (e: any) {
      if (cacheRendered) {
        diag(`[cmdk] around fetch failed after cache paint — keeping cached window: ${e?.message || e}`);
        return true;
      }
      diag(`[cmdk] around-window drill failed: ${e?.message || e} — serial fallback`);
      return false;
    } finally {
      // Guarantee the drill spinner clears on every exit (success, target
      // missing, session-changed, fetch failure) — rerenderInto only clears
      // it when a non-empty window actually rendered.
      drillSpinnerEl?.classList.remove('transcript-loading');
    }
  })();
  aroundDrillInFlight = { key, promise };
  return promise.finally(() => {
    if (aroundDrillInFlight?.key === key) aroundDrillInFlight = null;
  });
}

/** Option (2) guarantee (issue #227): a deep drill must never leave the
 *  buffer as a bare "floating window" with the live tail evicted — that's
 *  the "pin and tail are mutually exclusive" field complaint. When a drill
 *  REPLACED the buffer with a window that doesn't reach the tail
 *  (hasMoreNewer still true), fetch the newest page and SPLICE it alongside
 *  the window with a gap marker, so scroll-to-bottom is instant and the deep
 *  target stays visible. No-op when the buffer already reaches the tail
 *  (the common splice-mode path) or already carries a spliced gap. */
async function ensureTailAfterDrill(chatId: string): Promise<void> {
  const st = transcriptStore.getState(chatId);
  if (!st.pagination.hasMoreNewer) return;            // already at the tail
  if (st.durable.some(it => it.role === 'gap')) return; // tail already spliced
  try {
    const result: any = await backend.resumeSession(chatId);
    if (switchCtl.viewedId() !== chatId) return;
    const tail = result.messages || [];
    if (!tail.length) return;
    const tailPagination: windowCache.WindowPagination = {
      firstId: result.firstId ?? null,
      hasMore: !!result.hasMore,
      lastId: result.lastId ?? null,
      hasMoreNewer: false,
    };
    const outcome = transcriptStore.spliceWindow(chatId, tail, tailPagination);
    if (Array.isArray(result.inflight)) transcriptStore.setInflight(chatId, result.inflight);
    const sp = transcriptStore.getState(chatId).pagination;
    chat.setPaginationState(sp.firstId, sp.hasMore, sp.lastId, sp.hasMoreNewer);
    rerenderActive();
    persistGrownTranscript(chatId);
    log(`[cmdk] ensureTailAfterDrill spliced live tail alongside drill window (${outcome})`);
  } catch (e: any) {
    diag(`[cmdk] ensureTailAfterDrill failed: ${e?.message || e}`);
  }
}

async function drillViaSerialOlderPages(
  chatId: string,
  targetMessageId: string,
  initialFirstId: number | null,
  initialHasMore: boolean,
): Promise<void> {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  let cursor = initialFirstId;
  let hasMore = initialHasMore;
  for (let i = 0; i < DRILL_PAGE_CAP && hasMore && cursor != null; i++) {
    if (switchCtl.viewedId() !== chatId) {
      log(`[cmdk] drill aborted — session changed mid-fetch`);
      return;
    }
    try {
      const result: any = await backend.loadEarlier(chatId, cursor);
      const older = result.messages || [];
      if (!older.length) { hasMore = false; break; }
      // Prepend into the store — projection orders by timestamp; the
      // reconciler walks the spec list and DOM-positions the new
      // bubbles above the existing ones. Wrap in chat.prependHistory
      // so scrollTop is held to the pre-prepend logical position
      // (otherwise drilling lurches the viewport upward at each page).
      chat.prependHistory(() => {
        transcriptStore.prependDurable(chatId, older, {
          firstId: result.firstId ?? null,
          hasMore: !!result.hasMore,
        });
      });
      cursor = result.firstId ?? null;
      hasMore = !!result.hasMore;
      chat.setPaginationState(cursor, hasMore);
      persistGrownTranscript(chatId);
    } catch (e: any) {
      diag(`[cmdk] drill page ${i + 1} fetch failed: ${e?.message || e}`);
      return;
    }
    const target = transcriptEl.querySelector(
      `[data-key="${CSS.escape(targetMessageId)}"]`,
    ) as HTMLElement | null;
    if (target) {
      log(`[cmdk] drill found ${targetMessageId} after ${i + 1} page(s)`);
      chat.suppressLazyLoadFor(1200);
      drillScrollTo(target);
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
  }
  log(`[cmdk] drill exhausted — target ${targetMessageId} not found within ${DRILL_PAGE_CAP} pages`);
}

/** Scroll-to-top lazy-load. Fetches messages older than `beforeId`
 *  via backend.loadEarlier and prepends them into the store. No-op
 *  if no chat is currently being viewed.
 *
 *  Scroll preservation: wrap the store mutation in `chat.prependHistory`
 *  so the transcript's scrollTop is adjusted by exactly the amount of
 *  new content inserted above the user's viewport. Without this, the
 *  same logical message they were looking at appears to JUMP upward
 *  by `newScrollHeight - oldScrollHeight` pixels when new rows are
 *  prepended above the viewport. */
export async function loadEarlierHistory(beforeId: number): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadEarlier(id, beforeId);
  const older = result.messages || [];
  if (!older.length) {
    chat.setPaginationState(null, false);
    return;
  }
  // Store mutation fires the reconciler subscriber synchronously, so by
  // the time the renderFn returns the new bubbles are in the DOM and
  // prependHistory's scrollHeight delta is accurate.
  chat.prependHistory(() => {
    transcriptStore.prependDurable(id, older, {
      firstId: result.firstId ?? null,
      hasMore: !!result.hasMore,
    });
  });
  // prependDurable preserves the newer cursor; re-publish BOTH halves so
  // chat's load-later state survives a load-earlier on a floating window.
  const sEarlier = transcriptStore.getState(id);
  chat.setPaginationState(
    result.firstId ?? null, !!result.hasMore,
    sEarlier.pagination.lastId, sEarlier.pagination.hasMoreNewer,
  );
  persistGrownTranscript(id);
}

/** Scroll-to-bottom lazy-load — the symmetric counterpart to
 *  loadEarlierHistory. Fetches messages newer than `afterId` via
 *  backend.loadLater and appends them, walking a floating deep `around`
 *  window forward toward the live tail. When the fetch reaches the tail
 *  (hasMoreNewer=false) the now-contiguous run becomes eligible for IDB
 *  persistence (persistGrownTranscript's guard lifts). No-op if no chat
 *  is currently being viewed. */
export async function loadLaterHistory(afterId: number): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadLater(id, afterId);
  const newer = result.messages || [];
  chat.appendHistory(() => {
    transcriptStore.appendDurable(id, newer, {
      lastId: result.lastId ?? null,
      hasMoreNewer: !!result.hasMoreNewer,
    });
  });
  const s = transcriptStore.getState(id);
  chat.setPaginationState(
    s.pagination.firstId, s.pagination.hasMore,
    s.pagination.lastId, s.pagination.hasMoreNewer,
  );
  persistGrownTranscript(id);
}

/** Shrink/close a spliced-window gap from its OLDER edge. Wired to the
 *  reconciler's inline `…` placeholder (parley:load-gap). Fetches the
 *  page after the gap's fill cursor and hands it to fillGap, which either
 *  connects the two runs (gap removed) or advances the gap cursor. Scroll
 *  position is preserved via prependHistory's DOM-anchor because the gap
 *  sits mid-transcript and inserting rows there shifts content below it. */
export async function loadGapHistory(afterId: number): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id || afterId == null) return;
  const result: any = await backend.loadLater(id, afterId);
  const rows = result.messages || [];
  const reachedTail = !result.hasMoreNewer;
  chat.prependHistory(() => {
    transcriptStore.fillGap(id, afterId, rows, reachedTail);
  });
  rerenderActive();
  persistGrownTranscript(id);
}

/** Jump to the live tail from a floating deep window. Re-resumes the
 *  viewed session (fetches the newest page), replaces the floating
 *  window with the tail-anchored transcript, and scrolls to the bottom.
 *  Wired as chat's jump-to-bottom handler while hasMoreNewer is true. */
export async function jumpToLatest(): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) { chat.forceScrollToBottom(); return; }
  try {
    const result: any = await backend.resumeSession(id);
    if (switchCtl.viewedId() !== id) return;
    transcriptStore.setDurable(id, result.messages || [], {
      firstId: result.firstId ?? null,
      hasMore: !!result.hasMore,
    });
    if (Array.isArray(result.inflight)) transcriptStore.setInflight(id, result.inflight);
    rerenderActive();
    chat.setPaginationState(result.firstId ?? null, !!result.hasMore);
    persistGrownTranscript(id);
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    chat.forceScrollToBottom();
  } catch (e: any) {
    diag(`[jump-to-latest] failed: ${e?.message || e}`);
  }
}
