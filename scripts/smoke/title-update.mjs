// Scenario: when hermes assigns a title to a session (via the
// session_changed envelope), the drawer entry's text should update
// from "New chat" placeholder to the real title without requiring a
// reload or click-elsewhere-and-back.
//
// Reported by Jonathan 2026-04-28 — drawer kept showing "New chat"
// for a session that hermes had clearly titled (visible after a
// reload). The PWA's session_changed handler writes to IDB but
// doesn't fire sessionDrawer.refresh(), so the on-screen title is
// stale until something else triggers a refresh.
//
// Test plan:
//   1. Send a message in a fresh chat.
//   2. Wait for reply_final.
//   3. Within reasonable time (e.g. 30s for title generation +
//      session_changed envelope), assert drawer entry text changes
//      from "New chat" to something else.

export const NAME = 'title-update';
export const DESCRIPTION = 'session_changed envelope updates drawer entry title in place';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet');
}
