/**
 * @fileoverview isDurableMessageKey — every accept/reject class named in
 * src/transcript/keys.ts, cross-checked against the actual mint sites in
 * projection.ts (durable/inflight key shapes) and their synthetic
 * counterparts (pending placeholder, activity row, turn-status, gap,
 * decorations).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDurableMessageKey } from './keys.ts';

describe('isDurableMessageKey: accepts real message-id shapes', () => {
  it('accepts a client-minted user key (main.ts umsg_<epoch-ms>_<rand>)', () => {
    assert.equal(isDurableMessageKey('umsg_1747000000000_ab12cd'), true);
  });

  it('accepts a plugin-minted assistant key (msg_…)', () => {
    assert.equal(isDurableMessageKey('msg_9f8e7d6c'), true);
  });

  it('accepts a plugin-minted notification key (notif_…)', () => {
    assert.equal(isDurableMessageKey('notif_abc123'), true);
  });

  it('accepts a state.db synthetic-shaped assistant id (sk-<unix>-<seq>)', () => {
    assert.equal(isDurableMessageKey('sk-1747000000-3'), true);
  });

  it('accepts a bare numeric state.db rowid (used when parley_id is absent)', () => {
    assert.equal(isDurableMessageKey('42'), true);
  });

  it('accepts a legacy reconcile-twin key (legacy:<state_id> — real row, odd shape)', () => {
    assert.equal(isDurableMessageKey('legacy:8831'), true);
  });
});

describe('isDurableMessageKey: rejects synthetic client-only shapes', () => {
  it('rejects the local thinking placeholder (project() step 5, pending:turn:<userKey>)', () => {
    assert.equal(isDurableMessageKey('pending:turn:umsg_1747000000000_ab12cd'), false);
  });

  it('rejects an activity-row key keyed to a user turn (turn:<userKey>)', () => {
    assert.equal(isDurableMessageKey('turn:umsg_1747000000000_ab12cd'), false);
  });

  it('rejects an orphaned activity-row key (turn:orphan:<ts>)', () => {
    assert.equal(isDurableMessageKey('turn:orphan:1747000000000'), false);
  });

  it('rejects the fixed bottom turn-status key (project() step 6, turn:status)', () => {
    assert.equal(isDurableMessageKey('turn:status'), false);
  });

  it('rejects a gap-discontinuity marker (project() step 1, gap:<older>:<newer>)', () => {
    assert.equal(isDurableMessageKey('gap:msg_1:msg_2'), false);
    assert.equal(isDurableMessageKey('gap:∅:msg_2'), false);
  });

  it('rejects a client-only system-line decoration (chat.ts, deco_<ts>_<rand>)', () => {
    assert.equal(isDurableMessageKey('deco_1747000000000_x7y8z9'), false);
  });

  it('rejects a voice-memo playback card decoration (memoOutbox.ts, memo:<memoId>)', () => {
    assert.equal(isDurableMessageKey('memo:rec-42'), false);
  });

  it('rejects an ephemeral inflight-notification key with no parley_id yet (inflight:<ts>)', () => {
    assert.equal(isDurableMessageKey('inflight:1747000000001'), false);
  });
});

describe('isDurableMessageKey: sanity-shape fallback', () => {
  it('rejects the empty string', () => {
    assert.equal(isDurableMessageKey(''), false);
  });

  it('rejects a key containing whitespace (no real id shape ever does)', () => {
    assert.equal(isDurableMessageKey('msg_123 abc'), false);
    assert.equal(isDurableMessageKey('msg_123\nabc'), false);
  });

  it('does not false-positive on a durable key that merely CONTAINS a synthetic substring '
    + 'mid-string (only a PREFIX match is a deny)', () => {
    // Defensive: a hypothetical real id that happens to embed "turn:"
    // after its own prefix must not be rejected — the deny-list is
    // startsWith, not "includes".
    assert.equal(isDurableMessageKey('msg_contains_turn:not_a_prefix'), true);
  });
});
