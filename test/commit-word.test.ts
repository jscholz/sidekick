/**
 * @fileoverview Tests for the commit-word (send word) regex pattern.
 * Verifies that "over" at end-of-segment triggers commit,
 * mid-sentence "over" does not, and compound words are safe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Reproduce the regex from main.ts (configurable phrase = "over")
function matchCommitWord(transcript, phrase = 'over') {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(.*)\\s*\\b${escaped}\\b[\\s.,!?]*$`, 'i');
  const m = transcript.match(re);
  if (!m) return null;
  return m[1].trim();
}

describe('commit word detection', () => {
  it('matches bare "over"', () => {
    assert.equal(matchCommitWord('over'), '');
  });

  it('matches "Over."', () => {
    assert.equal(matchCommitWord('Over.'), '');
  });

  it('matches "over" at end of sentence', () => {
    assert.equal(matchCommitWord('check it out. Over.'), 'check it out.');
  });

  it('strips trailing "over" and keeps content', () => {
    assert.equal(matchCommitWord('Hand it over'), 'Hand it');
  });

  it('matches LAST "over" in sentence with multiple', () => {
    assert.equal(
      matchCommitWord('I went over to the store and the trip is over'),
      'I went over to the store and the trip is'
    );
  });

  it('handles "over" followed by comma then "over"', () => {
    assert.equal(
      matchCommitWord('The game is over, over.'),
      'The game is over,'
    );
  });

  it('does NOT match "moreover"', () => {
    assert.equal(matchCommitWord('Moreover I think'), null);
  });

  it('does NOT match "takeover"', () => {
    assert.equal(matchCommitWord('the takeover is complete'), null);
  });

  it('matches "takeover is complete over"', () => {
    assert.equal(
      matchCommitWord('the takeover is complete over'),
      'the takeover is complete'
    );
  });

  it('does NOT match mid-sentence "over"', () => {
    assert.equal(matchCommitWord('I went over the bridge today'), null);
  });

  it('handles "over" with trailing question mark', () => {
    // "over?" at end matches — strips "over?" and keeps the rest
    assert.equal(matchCommitWord('is it over?'), 'is it');
  });

  it('works with custom phrase "send it"', () => {
    assert.equal(matchCommitWord('here is my message send it', 'send it'), 'here is my message');
  });

  it('works with custom phrase "roger"', () => {
    assert.equal(matchCommitWord('got it, roger', 'roger'), 'got it,');
  });

  it('custom phrase does not match partial', () => {
    assert.equal(matchCommitWord('the roger rabbit movie', 'roger'), null);
    // "roger" is at the end? No — "movie" is at the end. Correct: null.
  });
});
