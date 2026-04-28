// Scenario: clicking "new chat" without sending anything should NOT
// leave an empty session row in the drawer. If the user clicks 5
// times without typing, they shouldn't accumulate 5 zero-message
// "New chat" entries. Either: clicks past the first should no-op, OR
// switching away from an empty new-chat should garbage-collect it.
//
// Reported by Jonathan 2026-04-28 — screenshot showed 5 empty
// "New chat / just now / 0 msgs" rows from rapid new-chat clicks.
//
// Test plan:
//   1. Click new-chat 5 times in rapid succession without sending.
//   2. Send a message in the latest one.
//   3. Assert drawer shows ≤ 1 "New chat" row (the one we sent in,
//      which gets a real title eventually).
//
// Design open question: do we no-op repeat clicks (current chat is
// empty, no need to mint another), or GC empty chats on switch-away?
// Test should pass for either implementation.

export const NAME = 'drawer-empty-cleanup';
export const DESCRIPTION = 'Repeated new-chat without sending should not pollute drawer';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet');
}
