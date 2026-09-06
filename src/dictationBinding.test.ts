/**
 * @fileoverview The dictation binding rule, pinned.
 *
 * The 2026-09-06 mis-send (UX_DETERMINISM_PLAN §1) and the 2026-08-30
 * dropped-dictation incident are both "the text went where the app was
 * pointing instead of where it was aimed". The fix is one predicate and
 * one non-clobbering append; both live here so the rule can be read
 * without a browser.
 *
 * Deliberately covers `deliver()` and not just the predicate: routing
 * correctly and then writing to the wrong place would satisfy a
 * predicate-only test. Under node there is no `document`, so the toast
 * self-disables and composer.appendText (no bound textarea) is inert —
 * which makes "the visible composer was NOT touched" observable as "no
 * draft was written for the focused chat".
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// composerDrafts persists through IndexedDB, which node has none of; its
// persist path is already try/catch'd, so the in-memory cache — the
// synchronous read source the composer restores from — works untouched.
import * as switchCtl from './switchController.ts';
import * as drafts from './composerDrafts.ts';
import { routeDictation, deliver, captureOrigin } from './dictationBinding.ts';

const A = 'chat-aaaa-0001';
const B = 'chat-bbbb-0002';

describe('routeDictation — the rule', () => {
  it('keeps the transcript in the visible composer when focus never moved', () => {
    assert.equal(routeDictation({ focusedId: A, originChatId: A }), 'composer');
  });

  it('sends it to the origin chat\'s draft once focus has moved', () => {
    assert.equal(routeDictation({ focusedId: B, originChatId: A }), 'draft');
  });

  it('treats "no chat focused" as moved — an unfocused app is not the origin', () => {
    assert.equal(routeDictation({ focusedId: null, originChatId: A }), 'draft');
  });

  it('falls back to the composer when the dictation has no binding', () => {
    // Legacy outbox rows (queued before the binding shipped) and
    // dictations started before any view committed. Hiding those in a
    // draft nobody can find would be worse than the old behaviour.
    assert.equal(routeDictation({ focusedId: B, originChatId: null }), 'composer');
    assert.equal(routeDictation({ focusedId: null, originChatId: null }), 'composer');
  });

  it('is decided only by the two ids — no hidden state', () => {
    // Same inputs, opposite live focus: the answer must not move.
    switchCtl.setViewed(B);
    assert.equal(routeDictation({ focusedId: A, originChatId: A }), 'composer');
    switchCtl.setViewed(A);
    assert.equal(routeDictation({ focusedId: B, originChatId: A }), 'draft');
  });
});

describe('captureOrigin', () => {
  it('reads switchController, the single source of truth for the current chat', () => {
    switchCtl.setOptimistic(null);
    switchCtl.setViewed(A);
    assert.equal(captureOrigin(), A);
    // An in-flight switch counts immediately: the user has already
    // chosen, so a dictation started now belongs to the target.
    switchCtl.setOptimistic(B);
    assert.equal(captureOrigin(), B);
  });
});

describe('deliver — where the words land', () => {
  beforeEach(() => {
    drafts.clearDraft(A);
    drafts.clearDraft(B);
    switchCtl.setOptimistic(null);
  });

  it('parks the transcript in the origin chat\'s draft when focus has moved', () => {
    switchCtl.setViewed(B);
    const route = deliver('the dream log I dictated', { originChatId: A });
    assert.equal(route, 'draft');
    assert.equal(drafts.getDraft(A), 'the dream log I dictated');
    // The chat on screen must be untouched — this is the whole point.
    assert.equal(drafts.getDraft(B), '');
  });

  it('does not write a draft at all when the user is still in the origin chat', () => {
    switchCtl.setViewed(A);
    const route = deliver('still here', { originChatId: A });
    assert.equal(route, 'composer');
    assert.equal(drafts.getDraft(A), '');
  });

  it('appends without clobbering what is already drafted there', () => {
    switchCtl.setViewed(B);
    deliver('first utterance', { originChatId: A });
    deliver('second utterance', { originChatId: A });
    assert.equal(drafts.getDraft(A), 'first utterance\n\nsecond utterance');
  });

  it('joins streaming fragments of one utterance with a space, not a paragraph', () => {
    switchCtl.setViewed(B);
    deliver('the first half', { originChatId: A, separator: ' ' });
    deliver('and the second half', { originChatId: A, separator: ' ' });
    assert.equal(drafts.getDraft(A), 'the first half and the second half');
  });

  it('ignores empty / whitespace-only transcripts rather than writing blanks', () => {
    switchCtl.setViewed(B);
    assert.equal(deliver('   ', { originChatId: A }), 'composer');
    assert.equal(deliver('', { originChatId: A }), 'composer');
    assert.equal(drafts.getDraft(A), '');
  });

  it('trims the transcript before it is stored', () => {
    switchCtl.setViewed(B);
    deliver('  padded speech \n', { originChatId: A });
    assert.equal(drafts.getDraft(A), 'padded speech');
  });

  it('never routes an unbound dictation into a draft', () => {
    switchCtl.setViewed(B);
    assert.equal(deliver('unbound', { originChatId: null }), 'composer');
    assert.equal(drafts.getDraft(B), '');
  });
});
