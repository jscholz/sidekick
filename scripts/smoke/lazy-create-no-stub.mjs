// Scenario: clicking "New chat" must NOT create an empty drawer row.
// Option B (Jonathan 2026-04-29): the chat materializes only on first
// send, so the drawer never shows "New chat / 0 msgs" stubs. Once the
// user actually sends, the chat shows up in the drawer normally.
//
// Test plan (mocked):
//   1. Empty server (no MOCK_SETUP). Drawer should be empty on boot.
//   2. Click "New chat". Wait briefly. Drawer should STILL be empty
//      — no stub appears.
//   3. Send "hi". Wait for the auto-reply.
//   4. After the reply, drawer should now show the chat (single row).

import { waitForReady, openSidebar, clickNewChat, send, assert } from './lib.mjs';

export const NAME = 'lazy-create-no-stub';
export const DESCRIPTION = 'New-chat click does not create drawer stub; chat appears only after first send';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) {
  // No chats pre-populated.
}

async function drawerRowCount(page) {
  return page.evaluate(() =>
    document.querySelectorAll('#sessions-list li[data-chat-id]').length,
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Step 1: empty drawer at boot.
  let count = await drawerRowCount(page);
  assert(count === 0, `step 1: drawer should be empty at boot (no chats), got ${count}`);
  log(`drawer empty at boot ✓`);

  // Step 2: click new-chat. Drawer should NOT add a stub.
  await clickNewChat(page);
  // Give the drawer a beat to refresh (would normally show a stub
  // if Option B wasn't shipped).
  await page.waitForTimeout(500);
  count = await drawerRowCount(page);
  assert(
    count === 0,
    `step 2: clicking New chat must NOT create a drawer row before first send, got ${count}`,
  );
  log(`new-chat click → no stub in drawer ✓`);

  // Step 3+4: send a message; drawer should populate after the reply.
  await send(page, 'hi-from-lazy-create-test');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('[mock] echo: hi'),
    { timeout: 5_000, polling: 100 },
  );
  log(`message sent + agent reply received`);

  // After the reply settles, drawer should show this chat. Wait for
  // the listSessions refresh (triggered by reply_final or polling).
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li[data-chat-id]').length === 1,
    { timeout: 6_000, polling: 200 },
  );
  log(`drawer shows the chat after first reply ✓`);
}
