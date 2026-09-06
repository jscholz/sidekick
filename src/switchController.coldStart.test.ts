// Cases that need switchController's PRE-NAVIGATION state.
//
// `userNavigated` is sticky for the module's lifetime by design and has
// no reset hook, so exactly one test in a file can observe the cold
// world — switchController.test.ts spends that budget on begin()'s
// authority rule (see its ordering note). node --test gives each FILE
// its own process, so this file buys a second cold module for
// noteUserNavigation(), which is the other way the flag gets set.
//
// What is under test: the New chat button and the meeting-capture
// landing navigate WITHOUT begin() — they rotate onto a chat that is
// empty by construction and paint it synchronously, so there is no
// fetch to gate and no token for a continuation to carry. Before this
// they called only invalidate() + setOptimistic(null), which bumps the
// epoch anonymously; hasUserNavigated() stayed false and a boot restore
// landing a moment later was still free to begin() and paint over the
// fresh chat. Same failure as the 2026-09-06 tap, a different door
// (UX_DETERMINISM_PLAN §5 Phase 1).
//
// ORDERING: the programmatic-origin case must stay FIRST — it is the
// only one that can prove noteUserNavigation left the flag alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as switchCtl from './switchController.ts';

test('noteUserNavigation: a programmatic origin cannot set the sticky flag', () => {
  // MUST BE FIRST — see the ordering note at the top of this file.
  assert.equal(switchCtl.hasUserNavigated(), false, 'no user navigation at module load');

  switchCtl.noteUserNavigation('chat-x', 'boot');
  assert.equal(switchCtl.hasUserNavigated(), false,
    'the authority flag means "a human moved" — a programmatic caller must not be able to claim it');

  // ...and the attempt is on the record rather than silently dropped, so
  // a miswired call site shows up in the ledger instead of quietly
  // conferring authority.
  const last = switchCtl.getNavLedger().pop();
  assert.equal(last?.origin, 'boot');
  assert.equal(last?.outcome, 'refused');
});

test('noteUserNavigation: New chat claims authority and boot is refused after it', () => {
  const genBefore = switchCtl.begin('chat-probe', 'boot')?.gen;
  assert.ok(genBefore, 'boot still lands while the user has not navigated');

  // The real sequence from main.ts's new-chat handler.
  switchCtl.invalidate();
  switchCtl.setOptimistic(null);
  switchCtl.noteUserNavigation('chat-fresh', 'new-chat');

  assert.equal(switchCtl.hasUserNavigated(), true, 'New chat is a user navigation');
  assert.equal(switchCtl.begin('chat-boot-restore', 'boot'), null,
    'a boot restore arriving after New chat must be refused, not allowed to paint over it');

  const committed = switchCtl.getNavLedger()
    .filter((e) => e.origin === 'new-chat' && e.outcome === 'committed');
  assert.equal(committed.length, 1, 'the rotation is recorded as a committed navigation');
  assert.equal(committed[0].id, 'chat-fresh');
});

test('noteUserNavigation: an unminted rotation still claims authority', () => {
  // Defensive: a backend with no newSession() leaves main.ts holding a
  // null id. The flag is the part that matters; the ledger says plainly
  // that we did not know which chat.
  switchCtl.noteUserNavigation(null, 'new-chat');
  const last = switchCtl.getNavLedger().pop();
  assert.equal(last?.outcome, 'committed');
  assert.equal(last?.id, '(unminted)', 'a sentinel no chat_id can collide with');
  assert.equal(switchCtl.hasUserNavigated(), true);
});
