// Scenario: Cmd/Ctrl + Backspace deletes session(s) from the sidebar.
//
// Mac convention: cmd+delete (Backspace key) deletes whatever's
// "in front of you." In sidekick that's:
//   - the currently-active chat (single delete), if no multi-select; OR
//   - all multi-selected chats (bulk delete), if a selection is active.
// Both routes go through the same confirm + backend.deleteSession path
// the row's overflow menu and the multi-select panel use.
//
// Test plan (mocked):
//   Phase A — single-active path:
//     1. Pre-populate three chats (A most-recent, B, C oldest).
//     2. Click chat A — A becomes active.
//     3. Press Cmd+Backspace, auto-accept the confirm.
//     4. A disappears from drawer; B + C remain.
//   Phase B — bulk path:
//     5. Click B, shift-click C → multi-select panel mounts.
//     6. Press Cmd+Backspace, auto-accept the confirm.
//     7. B + C disappear; drawer is empty.
//
// Wired in 2026-05-01 alongside the arrow-key navigation feature.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sidebar-cmd-delete';
export const DESCRIPTION = 'Cmd+Backspace deletes active session OR multi-selection';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-cmddel-A';
const CHAT_B = 'mock-cmddel-B';
const CHAT_C = 'mock-cmddel-C';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [
      { role: 'user', content: 'a-msg', timestamp: now / 1000 - 60 },
      { role: 'assistant', content: 'a-reply', timestamp: now / 1000 - 59 },
    ],
    lastActiveAt: now - 1_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [
      { role: 'user', content: 'b-msg', timestamp: now / 1000 - 120 },
      { role: 'assistant', content: 'b-reply', timestamp: now / 1000 - 119 },
    ],
    lastActiveAt: now - 60_000,
  });
  mock.addChat(CHAT_C, {
    title: 'Chat C',
    messages: [
      { role: 'user', content: 'c-msg', timestamp: now / 1000 - 180 },
      { role: 'assistant', content: 'c-reply', timestamp: now / 1000 - 179 },
    ],
    lastActiveAt: now - 120_000,
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
  // Auto-accept the window.confirm dialogs both delete paths trigger.
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

  await waitForReady(page);
  await openSidebar(page);

  for (const id of [CHAT_A, CHAT_B, CHAT_C]) {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${id}"]`, { timeout: 5_000 });
  }
  log('drawer pre-populated with 3 chats');

  // --- Phase A: single-active delete --------------------------------
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    (id) => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') === id,
    CHAT_A,
    { timeout: 3_000 },
  );
  log('chat A active');

  // Move focus off the composer / inputs so document-level keydown sees it.
  await page.evaluate(() => document.body.focus());

  // Cmd+Backspace — single delete path.
  await page.keyboard.press('Meta+Backspace');
  log('pressed Cmd+Backspace with single active session');

  // Wait for A to disappear.
  try {
    await page.waitForFunction(
      (id) => !Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
        .some(li => li.getAttribute('data-chat-id') === id),
      CHAT_A,
      { timeout: 5_000, polling: 100 },
    );
  } catch {
    const ids = await drawerChatIds(page);
    throw new Error(`single delete didn't remove A; drawer = ${JSON.stringify(ids)}`);
  }
  let ids = await drawerChatIds(page);
  assert(ids.includes(CHAT_B) && ids.includes(CHAT_C),
    `B + C should remain after deleting A; drawer = ${JSON.stringify(ids)}`);
  log('Phase A: A deleted; B + C remain ✓');

  // --- Phase B: bulk delete -----------------------------------------
  await clickRow(page, CHAT_B);
  await clickRow(page, CHAT_C, { modifiers: ['Shift'] });
  await page.waitForSelector('#multi-select-panel', { timeout: 3_000 });
  log('shift-clicked B+C — multi-select panel mounted');

  await page.evaluate(() => document.body.focus());

  // Cmd+Backspace — bulk path.
  await page.keyboard.press('Meta+Backspace');
  log('pressed Cmd+Backspace with multi-selection');

  // Wait for both B + C to drain.
  try {
    await page.waitForFunction(
      ([b, c]) => {
        const present = Array.from(
          document.querySelectorAll('#sessions-list li[data-chat-id]'),
        ).map(li => li.getAttribute('data-chat-id'));
        return !present.includes(b) && !present.includes(c);
      },
      [CHAT_B, CHAT_C],
      { timeout: 5_000, polling: 100 },
    );
  } catch {
    ids = await drawerChatIds(page);
    throw new Error(`bulk delete didn't drain B + C; drawer = ${JSON.stringify(ids)}`);
  }
  log('Phase B: B + C deleted via bulk path ✓');

  // Multi-select panel should be gone.
  const panelGone = await page.evaluate(() => !document.getElementById('multi-select-panel'));
  assert(panelGone, 'multi-select panel should unmount after bulk delete');
}
