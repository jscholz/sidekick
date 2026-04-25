/**
 * @fileoverview Tests for the shared session filter parser/applier.
 * Run with: npm test (uses node --test --experimental-strip-types).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, applyFilter } from '../src/sessionFilter.ts';

const sessions = [
  { id: 'sidekick-main', title: 'Project Hermes', snippet: 'migration plan', source: 'api_server' },
  { id: 'wa-2026-04-20-jane', title: 'WhatsApp: Jane', snippet: 'lunch tomorrow', source: 'whatsapp' },
  { id: 'tg-bob', title: null, snippet: 'standup notes', source: 'telegram' },
  { id: 'cli-debug', title: 'Debug session', snippet: 'log inspection', source: 'cli' },
  { id: 'sidekick-1234', title: 'Trip to Paris', snippet: 'flights and hotels', source: 'api_server' },
];

describe('sessionFilter.parseQuery', () => {
  it('returns empty query for empty input', () => {
    const q = parseQuery('');
    assert.equal(q.raw, '');
    assert.deepEqual(q.terms, []);
    assert.deepEqual(q.globs, []);
  });

  it('tokenizes plain whitespace-separated terms', () => {
    const q = parseQuery('hermes plan');
    assert.deepEqual(q.terms, ['hermes', 'plan']);
    assert.deepEqual(q.globs, []);
  });

  it('classifies tokens with * or ? as globs', () => {
    const q = parseQuery('foo* bar?baz plain');
    assert.deepEqual(q.terms, ['plain']);
    assert.deepEqual(q.globs, ['foo*', 'bar?baz']);
  });

  it('tolerates reserved field prefixes by stripping them', () => {
    // source:whatsapp → 'whatsapp' as a regular term (no field-aware
    // matching yet; the tolerance prevents user-typed prefixes from
    // crashing or filtering to zero).
    const q = parseQuery('source:whatsapp Jane');
    assert.deepEqual(q.terms, ['whatsapp', 'Jane']);
  });

  it('drops empty-value reserved-prefix tokens', () => {
    const q = parseQuery('source: jane');
    assert.deepEqual(q.terms, ['jane']);
  });
});

describe('sessionFilter.applyFilter', () => {
  it('empty query passes through all sessions', () => {
    const out = applyFilter(sessions, parseQuery(''));
    assert.equal(out.length, sessions.length);
  });

  it('single term substring matches title/snippet/source/id union', () => {
    const out = applyFilter(sessions, parseQuery('paris'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'sidekick-1234');
  });

  it('multi-term query AND-matches across the union', () => {
    // 'whatsapp' hits source, 'jane' hits title — both must match.
    const out = applyFilter(sessions, parseQuery('whatsapp jane'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'wa-2026-04-20-jane');
  });

  it('glob with * matches across union', () => {
    // 'sidekick-*' should hit both sidekick-* sessions via id.
    const out = applyFilter(sessions, parseQuery('sidekick-*'));
    assert.equal(out.length, 2);
    assert.ok(out.every((s) => s.id.startsWith('sidekick-')));
  });

  it('case-insensitive', () => {
    const out = applyFilter(sessions, parseQuery('HERMES'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'sidekick-main');
  });

  it('no-match returns empty array', () => {
    const out = applyFilter(sessions, parseQuery('zzzzznevergonnamatch'));
    assert.deepEqual(out, []);
  });

  it('handles missing optional fields without crashing', () => {
    // tg-bob has title=null. Searching for 'standup' (in snippet) still hits.
    const out = applyFilter(sessions, parseQuery('standup'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'tg-bob');
  });

  it('combined term + glob both required', () => {
    // 'sidekick-*' filters to the two sidekick rows; 'paris' narrows to one.
    const out = applyFilter(sessions, parseQuery('sidekick-* paris'));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'sidekick-1234');
  });
});
