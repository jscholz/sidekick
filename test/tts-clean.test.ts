/**
 * @fileoverview Tests for the TTS text-cleaning logic — strips markdown,
 * URLs, emoji, asterisks, etc. before the text hits Deepgram Aura.
 *
 * The real implementation lives in src/pipelines/classic/tts.ts as a
 * non-exported `cleanForTts`. Same pattern as commit-word.test.ts:
 * replicate the logic here so the test is free of DOM imports. Keep
 * the two in sync — if the source changes, update this file too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Replicated from src/pipelines/classic/tts.ts `cleanForTts`.
function cleanForTts(text: string): string {
  let t = text;
  t = t.replace(/^\[[A-Za-z0-9_\- ]+\]\s*/, '');
  t = t.replace(/```[\s\S]*?```/g, '[code block]');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/^[\s]*[-*•]\s+/gm, '');
  t = t.replace(/^#+\s+/gm, '');
  t = t.replace(/https?:\/\/[^\s<)\]"']+/g, '(link in canvas)');
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  t = t.replace(/\*/g, '');
  t = t.replace(/^[#\-\s]+$/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 1800);
}

describe('cleanForTts — speaker-tag stripping', () => {
  it('strips leading [Label] prefix', () => {
    assert.equal(cleanForTts('[Clawdian] Hello there'), 'Hello there');
  });

  it('strips leading bracket with numbers and dashes', () => {
    assert.equal(cleanForTts('[R2-Assistant] reply body'), 'reply body');
  });

  it('does not strip brackets mid-sentence', () => {
    assert.equal(
      cleanForTts('I said [loud] and clear'),
      'I said [loud] and clear',
    );
  });
});

describe('cleanForTts — markdown stripping', () => {
  it('strips bold markers', () => {
    assert.equal(cleanForTts('**Hello** world'), 'Hello world');
  });

  it('strips italic markers (*)', () => {
    assert.equal(cleanForTts('he said *really*?'), 'he said really?');
  });

  it('strips italic markers (_)', () => {
    assert.equal(cleanForTts('she was _furious_'), 'she was furious');
  });

  it('strips code fences to a placeholder', () => {
    assert.equal(
      cleanForTts('Try this:\n```js\nconst x = 1;\n```\ndone'),
      'Try this: [code block] done',
    );
  });

  it('strips inline code backticks', () => {
    assert.equal(cleanForTts('use the `foo()` helper'), 'use the foo() helper');
  });

  it('strips leading bullet at start of line', () => {
    assert.equal(cleanForTts('* Item one\n* Item two'), 'Item one Item two');
  });

  it('strips leading dash bullets', () => {
    assert.equal(cleanForTts('- first\n- second'), 'first second');
  });

  it('strips leading heading markers', () => {
    assert.equal(cleanForTts('# Title\nbody text'), 'Title body text');
    assert.equal(cleanForTts('### sub\nbody'), 'sub body');
  });
});

describe('cleanForTts — asterisks should never leak', () => {
  // Regression tests for the "agent says 'asterisk asterisk' around bold
  // words" bug. Any surviving `*` gets pronounced by Deepgram Aura.

  it('kills unpaired mid-word asterisk', () => {
    assert.ok(!cleanForTts('some*thing').includes('*'));
  });

  it('kills three-run asterisks', () => {
    assert.ok(!cleanForTts('***bold-italic***').includes('*'));
  });

  it('kills solitary asterisk', () => {
    assert.ok(!cleanForTts('just * here').includes('*'));
  });

  it('kills nested markers', () => {
    assert.ok(!cleanForTts('**outer *inner* end**').includes('*'));
  });
});

describe('cleanForTts — URLs and emoji', () => {
  it('replaces URLs with "(link in canvas)"', () => {
    assert.equal(
      cleanForTts('see https://example.com/foo for details'),
      'see (link in canvas) for details',
    );
  });

  it('strips a common emoji', () => {
    assert.equal(cleanForTts('🤖 hello'), 'hello');
  });

  it('strips an older-range emoji', () => {
    assert.equal(cleanForTts('✅ done'), 'done');
  });
});

describe('cleanForTts — whitespace + length limits', () => {
  it('collapses runs of whitespace', () => {
    assert.equal(cleanForTts('a    b\n\n\nc'), 'a b c');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(cleanForTts('   hi   '), 'hi');
  });

  it('caps at 1800 characters', () => {
    const input = 'x'.repeat(2500);
    assert.equal(cleanForTts(input).length, 1800);
  });
});
