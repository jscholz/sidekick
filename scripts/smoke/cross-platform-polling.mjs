// Scenario: drawer polls listSessions while foregrounded so cross-
// platform chats (telegram, slack, etc.) appear without a manual
// refresh. The hermes plugin only fires session_changed envelopes
// for sidekick-owned chats, so non-sidekick activity doesn't show up
// via the live SSE channel. Polling fills that gap.
//
// We don't wait for the natural ~5s tick — testing it would slow the
// suite. Instead, exercise the visibility-change path which forces an
// immediate refresh on returning to visible.
//
// Test plan (mocked):
//   1. Pre-populate sidekick chat A. Drawer renders A.
//   2. Add a new telegram chat T via mock.addChat (simulates activity
//      from another platform that the PWA wasn't notified about).
//   3. Dispatch a synthetic visibilitychange (hidden → visible) to
//      trigger the immediate-on-visible refresh.
//   4. Assert T appears in the drawer with TELEGRAM badge.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cross-platform-polling';
export const DESCRIPTION = 'Drawer auto-refreshes (visibility change) to surface non-sidekick chats';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SK_CHAT = 'mock-sk-poll';
const TG_CHAT = '99999';

export function MOCK_SETUP(mock) {
  mock.addChat(SK_CHAT, {
    source: 'sidekick',
    title: 'Sidekick chat',
    messages: [
      { role: 'user', content: 'hello', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'hi', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${SK_CHAT}"]`, { timeout: 5_000 });
  let tgPresent = await page.locator(`#sessions-list li[data-chat-id="${TG_CHAT}"]`).count();
  assert(tgPresent === 0, `pre-condition: telegram chat should not yet be in drawer`);
  log(`drawer pre-populated with sidekick chat only ✓`);

  // 2. Mock-side: a new telegram chat appears (simulating a message
  //    arriving from telegram → state.db).
  mock.addChat(TG_CHAT, {
    source: 'telegram',
    title: 'New telegram chat',
    messages: [
      { role: 'user', content: 'tg-marker', timestamp: Date.now() / 1000 },
      { role: 'assistant', content: 'tg-reply', timestamp: Date.now() / 1000 + 1 },
    ],
    lastActiveAt: Date.now(),
  });
  log(`telegram chat added to mock backend (drawer not yet aware)`);

  // 3. Trigger visibilitychange (hidden → visible) to force an
  //    immediate refresh. This simulates the user returning to the
  //    PWA after switching tabs.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  log(`dispatched visibilitychange (hidden → visible)`);

  // 4. Assert telegram chat now appears in drawer.
  try {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${TG_CHAT}"]`, { timeout: 3_000 });
  } catch {
    const ids = await page.evaluate(() => Array.from(
      document.querySelectorAll('#sessions-list li[data-chat-id]'),
    ).map(li => li.getAttribute('data-chat-id')));
    throw new Error(
      `telegram chat did not appear in drawer after visibilitychange.\n` +
      `  drawer chat_ids: ${JSON.stringify(ids)}`,
    );
  }
  log(`telegram chat surfaced in drawer after visibility refresh ✓`);
}
