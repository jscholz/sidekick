// Regression: an approval push must use a DISTINCT notification tag from
// reply pushes, so the stream of `reply_final` ("Still working…") pushes
// during a long autonomous turn can't coalesce-overwrite the urgent,
// actionable approval banner on the same chat.
//
// Regression: an approval push was delivered (FCM delivered=1) but never
// surfaced — every push for the chat shared tag `chat:<id>`, so the next
// heartbeat reply replaced the approval banner. Fix: approvals tag as
// `approval:<id>`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { envelopeToPayload, isProgressHeartbeat, isPushEligible } from './dispatch.ts';

const CID = 'parley:ae6435b5-pitch-deck';

test('approval and reply pushes for the same chat use different tags', () => {
  const approval = envelopeToPayload({
    type: 'notification',
    kind: 'approval',
    chat_id: CID,
    content: '⚠️ Dangerous command requires approval:\n\nrm -rf /tmp/x\n\nReason: recursive delete',
  });
  const reply = envelopeToPayload({
    type: 'reply_final',
    chat_id: CID,
    content: 'Still working… (12 min elapsed — iteration 47/60)',
  });

  assert.equal(approval.tag, `approval:${CID}`, 'approval should get its own tag namespace');
  assert.equal(reply.tag, `chat:${CID}`, 'reply keeps the per-chat tag');
  assert.notEqual(
    approval.tag, reply.tag,
    'approval and reply tags must differ — otherwise a reply heartbeat coalesces over the approval',
  );
});

test('approvals for the same chat still coalesce with each other', () => {
  const a1 = envelopeToPayload({ type: 'notification', kind: 'approval', chat_id: CID, content: 'Dangerous command requires approval: a' });
  const a2 = envelopeToPayload({ type: 'notification', kind: 'approval', chat_id: CID, content: 'Dangerous command requires approval: b' });
  assert.equal(a1.tag, a2.tag, 'two approvals on the same chat share a tag (one outstanding banner)');
});

test('no chat_id → undefined tag (no coalescing key)', () => {
  const p = envelopeToPayload({ type: 'notification', kind: 'approval', content: 'x' });
  assert.equal(p.tag, undefined);
});

test('progress heartbeats are detected (and suppressed from push)', () => {
  // The exact shapes seen in the field (parley.sql).
  assert.ok(isProgressHeartbeat('⏳ Still working... (12 min elapsed — iteration 47/60, running: terminal)'));
  assert.ok(isProgressHeartbeat('⏳ Still working... (3 min elapsed — iteration 15/60, receiving stream response)'));
  // Structural fallback if the emoji is stripped somewhere upstream.
  assert.ok(isProgressHeartbeat('Still working (6 min elapsed — iteration 14/60, running: terminal)'));
  // hermes 0.21 shape.
  assert.ok(isProgressHeartbeat('⏳ Working — 3 min — iteration 4/60, terminal'));
  assert.ok(isProgressHeartbeat('⏳ Working — 1 min'));
});

test('real replies and approvals are NOT treated as heartbeats', () => {
  assert.ok(!isProgressHeartbeat('Here are the crons you have set up: ...'));
  assert.ok(!isProgressHeartbeat('Done — I migrated all 11 recurring jobs.'));
  assert.ok(!isProgressHeartbeat('⚠️ Dangerous command requires approval:\n\nrm -rf /tmp/x'));
  assert.ok(!isProgressHeartbeat(''));
  // A reply that merely mentions the phrase mid-sentence must not match.
  assert.ok(!isProgressHeartbeat('I was still working on the deck when you asked.'));
});

test('agent questions are push-eligible — the agent is blocked waiting', () => {
  // Field bug 2026-08-23: agent_question was absent from the allowlist
  // and the envelope carries no should_push, so every question was
  // dropped with reason=not_eligible and never reached a phone.
  assert.ok(isPushEligible({ type: 'agent_question' }));
  assert.ok(isPushEligible({ type: 'reply_final' }));
  assert.ok(isPushEligible({ type: 'notification' }));
  assert.ok(!isPushEligible({ type: 'reply_delta' }));
  assert.ok(!isPushEligible({ type: 'typing' }));
  // An explicit flag still preempts the allowlist in both directions.
  assert.ok(!isPushEligible({ type: 'agent_question', should_push: false }));
  assert.ok(isPushEligible({ type: 'typing', should_push: true }));
});
