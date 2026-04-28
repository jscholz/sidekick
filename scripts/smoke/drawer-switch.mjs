// Scenario: clicking a session in the sidebar switches the chat view
// reliably. Catches the "click sometimes doesn't switch / switches and
// switches back ~0.2s later" glitch Jonathan reported 2026-04-28.
//
// Test plan:
//   1. Create chat A (send "first message in A").
//   2. Click new-chat → chat B (send "first message in B").
//   3. Click chat A's drawer entry → assert active chat changes:
//      transcript shows "first message in A" within reasonable time.
//   4. Click chat B's drawer entry → assert it switches BACK without
//      bouncing to A within 1 s.
//   5. Repeat the A↔B click 5 times rapidly → final state should match
//      the last click target.
//
// Pre-fix expectation: this test FAILS with either a stuck-on-old-chat
// or a flicker-back-to-old-chat assertion failure.

export const NAME = 'drawer-switch';
export const DESCRIPTION = 'Drawer click reliably switches chat view (no bounce-back)';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet — write FIRST, see it fail, then fix the race');
}
