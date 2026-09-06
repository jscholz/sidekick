// Token semantics for the hardening Phase-1 paint gate, plus the
// navigation-authority rules layered on top of it
// (docs/UX_DETERMINISM_PLAN.md §5 Phase 1.1). The module is a pure leaf
// with module-level state and no reset, so every case establishes its
// own state via the public API (begin/setOptimistic/setViewed) rather
// than assuming a clean slate.
//
// ORDERING NOTE: `hasUserNavigated()` is deliberately STICKY for the
// module's lifetime — that is the whole point of the rule — and there is
// no reset hook to undo it. The one case that needs the pre-navigation
// state ("programmatic begin is granted before the user has navigated")
// must therefore stay FIRST in this file. Everything after it runs in
// the post-user-navigation world, which is also where the app spends
// ~all of its time. Do not insert a case above it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as switchCtl from './switchController.ts';

/** begin() returns null only when the authority rule refuses it, and a
 *  user-class origin is never refused. Unwrap so the epoch cases below
 *  read the way they did before authority existed. */
function beginUser(id: string, origin: switchCtl.NavOrigin = 'tap'): switchCtl.SwitchToken {
  const tok = switchCtl.begin(id, origin);
  if (!tok) throw new Error(`user begin(${id}, ${origin}) must be granted`);
  return tok;
}

/** The most recent GRANTED ledger entry for a generation. A refusal is
 *  recorded with the generation it WOULD have taken (the counter itself
 *  is left alone), so the same gen can appear twice — once as the
 *  refusal, once as whichever navigation actually claimed it later. Only
 *  granted entries own an epoch, so those are the ones to match. */
function entryForGen(gen: number): switchCtl.NavLedgerEntry | undefined {
  return switchCtl.getNavLedger().filter((e) => e.gen === gen && e.outcome !== 'refused').pop();
}

test('authority: programmatic begins are granted until the user navigates', () => {
  // MUST BE FIRST — see the ordering note at the top of this file.
  assert.equal(switchCtl.hasUserNavigated(), false, 'no user navigation at module load');

  const boot = switchCtl.begin('chat-boot', 'boot');
  assert.ok(boot, 'boot restore is allowed to land when the user has not chosen anything');
  assert.equal(switchCtl.hasUserNavigated(), false, 'a programmatic begin is not a user navigation');
  assert.equal(switchCtl.canPaint(boot), true);

  // The user taps while boot's resume is still out. User outranks
  // programmatic AND wins on generation, so boot's paint dies.
  const tap = beginUser('chat-a', 'tap');
  assert.equal(switchCtl.hasUserNavigated(), true);
  assert.equal(switchCtl.canPaint(boot), false, "the tap supersedes boot's switch");
  assert.equal(switchCtl.canPaint(tap), true);
  assert.equal(entryForGen(boot.gen)?.outcome, 'superseded', 'the beaten token reads superseded');
  assert.equal(entryForGen(tap.gen)?.outcome, 'begun');
});

test('authority: a programmatic begin after a user begin is refused, epoch untouched', () => {
  const tap = beginUser('chat-a', 'tap');
  const genBefore = tap.gen;
  const optimisticBefore = switchCtl.optimisticId();

  // This is the 2026-09-06 incident, in one assertion: the boot restore
  // reaching begin() AFTER the user's tap must not take the epoch.
  const boot = switchCtl.begin('chat-boot', 'boot');
  assert.equal(boot, null, 'programmatic navigation cannot supersede a user gesture');
  assert.equal(switchCtl.canPaint(tap), true, "the user's switch still owns the pane");
  assert.equal(switchCtl.optimisticId(), optimisticBefore, 'a refusal must not touch the highlight');

  // The generation is untouched, so a refusal disturbs nothing in flight.
  const next = beginUser('chat-b', 'tap');
  assert.equal(next.gen, genBefore + 1, 'the refused begin consumed no generation');

  // ...but it IS on the record, stamped with the gen it would have taken.
  const refused = switchCtl.getNavLedger().filter((e) => e.outcome === 'refused');
  const last = refused[refused.length - 1];
  assert.equal(last?.origin, 'boot');
  assert.equal(last?.id, 'chat-boot');
  assert.equal(last?.gen, genBefore + 1, 'refused entries carry the generation they would have taken');
});

test('authority: every programmatic origin is refused; every user origin is granted', () => {
  for (const origin of ['boot', 'fallback', 'reconcile', 'prewarm'] as switchCtl.NavOrigin[]) {
    assert.equal(switchCtl.originClass(origin), 'programmatic', `${origin} is programmatic`);
    assert.equal(switchCtl.begin('chat-prog', origin), null, `${origin} must be refused`);
  }
  for (const origin of ['tap', 'keyboard', 'cmdk', 'push-tap', 'drill', 'delete-landing',
                        'new-chat', 'capture-landing'] as switchCtl.NavOrigin[]) {
    assert.equal(switchCtl.originClass(origin), 'user', `${origin} is a user gesture`);
    assert.ok(switchCtl.begin('chat-user', origin), `${origin} must be granted`);
  }
});

test('noteUserNavigation: records authority without disturbing the epoch', () => {
  // The New chat / meeting-capture doors (UX_DETERMINISM_PLAN §5 Phase
  // 1). They own their own invalidate()/setOptimistic()/setViewed(); all
  // this adds is the sticky flag and a ledger line, so it must leave the
  // generation and the highlight exactly where it found them — a live
  // switch elsewhere in the app cannot be collateral damage.
  const live = switchCtl.begin('chat-live', 'tap');
  assert.ok(live);
  switchCtl.setOptimistic('chat-live');

  switchCtl.noteUserNavigation('chat-fresh', 'new-chat');

  assert.equal(switchCtl.canPaint(live), true, 'noteUserNavigation must not bump the generation');
  assert.equal(switchCtl.optimisticId(), 'chat-live', 'noteUserNavigation must not touch the highlight');
  assert.equal(switchCtl.viewedId() !== 'chat-fresh', true, 'and must not commit a view on the caller\'s behalf');

  const last = switchCtl.getNavLedger().pop();
  assert.equal(last?.origin, 'new-chat');
  assert.equal(last?.id, 'chat-fresh');
  assert.equal(last?.outcome, 'committed', 'the landing is a decided fact by the time it is recorded');

  // The entry is resolved on arrival, so a later begin() must not
  // re-stamp it as superseded the way it does a `begun` one.
  switchCtl.begin('chat-after', 'tap');
  const stillCommitted = switchCtl.getNavLedger()
    .filter((e) => e.origin === 'new-chat' && e.id === 'chat-fresh');
  assert.equal(stillCommitted[stillCommitted.length - 1].outcome, 'committed');
});

test('authority: a deep link counts as a user navigation', () => {
  // The OS opened the URL, but a human tapped the push notification
  // behind it — so it outranks boot, and a boot restore that lands after
  // it is refused rather than allowed to repaint over it.
  const link = switchCtl.begin('chat-deeplink', 'deep-link');
  assert.equal(switchCtl.originClass('deep-link'), 'user');
  assert.ok(link, 'a deep link is never refused');
  assert.equal(switchCtl.begin('chat-boot', 'boot'), null, 'boot cannot supersede a deep link');
  assert.equal(switchCtl.canPaint(link), true);
});

test('nav ledger: records outcomes and stays capped', () => {
  const committed = beginUser('chat-committed', 'tap');
  switchCtl.commit(committed);
  assert.equal(entryForGen(committed.gen)?.outcome, 'committed');

  // A committed navigation is resolved — a later begin() must not
  // re-stamp it as superseded.
  beginUser('chat-next', 'tap');
  assert.equal(entryForGen(committed.gen)?.outcome, 'committed');

  // invalidate() (delete / new-chat rotation) kills the live entry too.
  const doomed = beginUser('chat-doomed', 'tap');
  switchCtl.invalidate();
  assert.equal(entryForGen(doomed.gen)?.outcome, 'superseded');

  // Ring, not a leak: 120 more switches leave exactly the cap, newest last.
  for (let i = 0; i < 120; i++) beginUser(`chat-ring-${i}`, 'tap');
  const nav = switchCtl.getNavLedger();
  assert.equal(nav.length, 100, 'ledger is capped at 100 entries');
  assert.equal(nav[nav.length - 1].id, 'chat-ring-119', 'newest entry is last');
  assert.equal(nav[0].id, 'chat-ring-20', 'oldest entries are evicted first');

  // The snapshot is a copy — poking at it from the console can't rewrite
  // the record.
  nav[0].outcome = 'refused';
  assert.notEqual(switchCtl.getNavLedger()[0].outcome, 'refused');
});

test('switch token: current until superseded by a newer begin()', () => {
  const a = beginUser('chat-a');
  assert.equal(switchCtl.canPaint(a), true);
  const b = beginUser('chat-b');
  assert.equal(switchCtl.canPaint(a), false, 'superseded switch must not paint');
  assert.equal(switchCtl.canPaint(b), true);
});

test('switch token: invalidate() kills the live switch', () => {
  const a = beginUser('chat-a');
  switchCtl.invalidate();
  assert.equal(switchCtl.canPaint(a), false);
});

test('commit promotes optimistic→viewed only while current', () => {
  const a = beginUser('chat-a');
  const b = beginUser('chat-b');
  assert.equal(switchCtl.commit(a), false, 'stale switch must not claim the view');
  assert.notEqual(switchCtl.viewedId(), 'chat-a');
  assert.equal(switchCtl.commit(b), true);
  assert.equal(switchCtl.viewedId(), 'chat-b');
});

test('view token: paints while its chat is focused, dies when focus moves', () => {
  const b = beginUser('chat-b');
  switchCtl.commit(b);
  switchCtl.clearOptimisticIfCurrent(b);
  const view = switchCtl.viewTokenFor('chat-b');
  assert.equal(switchCtl.canPaint(view), true, 'focused chat repaints');

  // A click flips optimistic synchronously — the view token for the
  // old chat must die IMMEDIATELY, before the new switch commits.
  // This is the backendEventHandlers hole the token model closes:
  // viewedId() still says chat-b here, but focus has moved.
  beginUser('chat-c');
  assert.equal(switchCtl.viewedId(), 'chat-b', 'viewed lags until the incoming chat paints');
  assert.equal(switchCtl.canPaint(view), false, 'stale view token must not paint over an in-flight switch');
});

test('view token for a never-focused chat never paints', () => {
  const b = beginUser('chat-b');
  switchCtl.commit(b);
  switchCtl.clearOptimisticIfCurrent(b);
  assert.equal(switchCtl.canPaint(switchCtl.viewTokenFor('chat-z')), false);
});

test('clearOptimisticIfCurrent: only the owning token may release the highlight', () => {
  const a = beginUser('chat-a');
  const b = beginUser('chat-b');
  switchCtl.clearOptimisticIfCurrent(a);
  assert.equal(switchCtl.optimisticId(), 'chat-b', 'stale token must not clear the newer claim');
  switchCtl.clearOptimisticIfCurrent(b);
  assert.equal(switchCtl.optimisticId(), null);
});
