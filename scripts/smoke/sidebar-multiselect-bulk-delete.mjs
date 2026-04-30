// Scenario: shift-click two drawer rows → stats panel mounts → click
// Delete → both rows disappear from the drawer.
//
// Adds the multi-select + bulk-delete workflow Jonathan asked for.
// Same predicate as `empty-chat-rotation-cleanup` (deleteSession per
// chat) but driven by the user's selection rather than an empty-chat
// auto-cleanup.
//
// Test plan (mocked):
//   1. Pre-populate 3 chats: A (with content), B, C (all distinct).
//   2. Click row A — activates normally.
//   3. Shift-click B — both A and B selected; stats panel mounts.
//   4. Stats panel shows count of 2 + has Delete button.
//   5. Auto-confirm window.confirm via page.on('dialog').
//   6. Click Delete — both A and B removed from drawer.
//   7. C survives.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sidebar-multiselect-bulk-delete';
export const DESCRIPTION = 'Shift-click multi-select + bulk delete drains drawer rows';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-multi-A';
const CHAT_B = 'mock-multi-B';
const CHAT_C = 'mock-multi-C';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [
      { role: 'user', content: 'a-msg', timestamp: now / 1000 - 60 },
      { role: 'assistant', content: 'a-reply', timestamp: now / 1000 - 59 },
    ],
    lastActiveAt: now - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [
      { role: 'user', content: 'b-msg', timestamp: now / 1000 - 120 },
      { role: 'assistant', content: 'b-reply', timestamp: now / 1000 - 119 },
    ],
    lastActiveAt: now - 120_000,
  });
  mock.addChat(CHAT_C, {
    title: 'Chat C',
    messages: [
      { role: 'user', content: 'c-msg', timestamp: now / 1000 - 180 },
      { role: 'assistant', content: 'c-reply', timestamp: now / 1000 - 179 },
    ],
    lastActiveAt: now - 180_000,
  });
}

async function clickRow(page, chatId, opts = {}) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click(opts);
}

async function drawerChatIds(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#sessions-list li[data-chat-id]'),
  ).map(li => li.getAttribute('data-chat-id')));
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  for (const id of [CHAT_A, CHAT_B, CHAT_C]) {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${id}"]`, { timeout: 5_000 });
  }
  log('drawer pre-populated with 3 chats');

  // Step 2: plain click A
  await clickRow(page, CHAT_A);

  // Step 3: shift-click B → multi-select kicks in.
  await clickRow(page, CHAT_B, { modifiers: ['Shift'] });
  log('shift-clicked B — expecting multi-select panel');

  // Wait for the panel to appear.
  await page.waitForSelector('#multi-select-panel', { timeout: 3_000 });
  // Stats panel announces "2 sessions selected". The exact wording
  // is "X sessions selected" — match flexibly so renaming the copy
  // doesn't break the test.
  const titleText = await page.locator('#multi-select-panel .ms-title').textContent();
  assert(
    /\b2\b/.test(titleText || ''),
    `expected '2' in panel title; got ${JSON.stringify(titleText)}`,
  );
  log('stats panel mounted with count=2');

  // Both A and B should have the .multiselected class.
  const selected = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessions-list li.multiselected'))
      .map(li => li.getAttribute('data-chat-id')),
  );
  assert(selected.includes(CHAT_A) && selected.includes(CHAT_B),
    `expected A + B in multiselect; got ${JSON.stringify(selected)}`);

  // Auto-accept the confirm dialog the delete button triggers.
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

  // Click Delete.
  await page.locator('#multi-select-panel #ms-delete').click();
  log('clicked Delete — chats should drain');

  // Wait for A + B to disappear.
  try {
    await page.waitForFunction(
      ([a, b]) => {
        const present = Array.from(
          document.querySelectorAll('#sessions-list li[data-chat-id]'),
        ).map(li => li.getAttribute('data-chat-id'));
        return !present.includes(a) && !present.includes(b);
      },
      [CHAT_A, CHAT_B],
      { timeout: 5_000, polling: 100 },
    );
  } catch {
    const finalIds = await drawerChatIds(page);
    throw new Error(
      `bulk delete didn't drain A + B from drawer.\n  remaining: ${JSON.stringify(finalIds)}`,
    );
  }

  // Stats panel should be gone (selection cleared).
  const panelGone = await page.evaluate(() => !document.getElementById('multi-select-panel'));
  assert(panelGone, 'stats panel should unmount after bulk delete');

  // C survives.
  const ids = await drawerChatIds(page);
  assert(ids.includes(CHAT_C), `C should survive; drawer = ${JSON.stringify(ids)}`);
  log(`bulk delete successful — A + B removed, C remains ✓`);
}
