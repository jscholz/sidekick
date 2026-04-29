// Scenario: clicking new-chat from a chat with content should clean
// stale 0-msg chats from the drawer. Reported by Jonathan 2026-04-29
// after the first cleanup attempt didn't visibly remove old "New chat /
// 0 msgs" entries from his real PWA.
//
// The first attempt (commit 0fd7009) called `backend.deleteSession`
// fire-and-forget on each empty chat. This test runs that flow and
// verifies the drawer actually self-cleans.
//
// Test plan (mocked):
//   1. Pre-populate 1 chat with content (chat A) + 3 empty 0-msg chats.
//   2. Click chat A; verify A is active.
//   3. Send "hi" in chat A so hasContent guard passes on next new-chat.
//      (mock auto-replies, so chat A ends up with at least 2 msgs.)
//   4. Click new-chat (rotation).
//   5. Wait for the rotation's background cleanup + refresh.
//   6. Assert: drawer no longer contains the 3 stale 0-msg chats; only
//      chat A (with content) and the newly-minted chat remain.

import { waitForReady, openSidebar, clickNewChat, send, assert } from './lib.mjs';

export const NAME = 'empty-chat-rotation-cleanup';
export const DESCRIPTION = 'New-chat rotation drops stale 0-msg chats from drawer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-chat-with-content';
const STALE_IDS = [
  'mock-stale-empty-1',
  'mock-stale-empty-2',
  'mock-stale-empty-3',
];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat with content',
    messages: [
      { role: 'user', content: 'previous-msg', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'previous-reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  for (let i = 0; i < STALE_IDS.length; i++) {
    mock.addChat(STALE_IDS[i], {
      title: '',
      messages: [],
      lastActiveAt: Date.now() - (120 + i * 30) * 1000,
    });
  }
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function drawerChatIds(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#sessions-list li[data-chat-id]'),
  ).map(li => li.getAttribute('data-chat-id')));
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for the drawer to render the pre-populated rows.
  for (const id of [CHAT_A, ...STALE_IDS]) {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${id}"]`, { timeout: 5_000 });
  }
  log(`drawer pre-populated with ${1 + STALE_IDS.length} chats`);

  // Sanity: all 4 visible.
  let ids = await drawerChatIds(page);
  for (const id of [CHAT_A, ...STALE_IDS]) {
    assert(ids.includes(id), `pre-condition: drawer should include ${id}`);
  }

  // 2-3. Activate chat A and send a message so hasContent is true.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('previous-msg'),
    { timeout: 3_000 },
  );
  await send(page, 'hi');
  log('sent "hi" in chat A; waiting for mock reply');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('[mock] echo: hi'),
    { timeout: 5_000 },
  );

  // 4. Rotate via new-chat. Cleanup is fire-and-forget; give it a
  //    generous window to delete + refresh.
  await clickNewChat(page);
  log('clicked new-chat — rotation should trigger cleanup');

  // 5. Wait for the stale chats to disappear OR timeout.
  try {
    await page.waitForFunction(
      (staleIds) => {
        const present = Array.from(
          document.querySelectorAll('#sessions-list li[data-chat-id]'),
        ).map(li => li.getAttribute('data-chat-id'));
        return staleIds.every((id) => !present.includes(id));
      },
      STALE_IDS,
      { timeout: 5_000, polling: 100 },
    );
  } catch {
    const finalIds = await drawerChatIds(page);
    const remaining = STALE_IDS.filter(id => finalIds.includes(id));
    throw new Error(
      `stale 0-msg chats still in drawer after rotation cleanup.\n` +
      `  remaining stale: ${JSON.stringify(remaining)}\n` +
      `  full drawer:     ${JSON.stringify(finalIds)}`,
    );
  }

  // 6. Final state: chat A (with content) is still there, no stale rows.
  ids = await drawerChatIds(page);
  assert(
    ids.includes(CHAT_A),
    `chat A (with content) should remain after cleanup, got ${JSON.stringify(ids)}`,
  );
  for (const id of STALE_IDS) {
    assert(
      !ids.includes(id),
      `stale chat ${id} should be gone, drawer = ${JSON.stringify(ids)}`,
    );
  }
  log(`cleanup successful — ${STALE_IDS.length} stale 0-msg chats removed ✓`);
}
