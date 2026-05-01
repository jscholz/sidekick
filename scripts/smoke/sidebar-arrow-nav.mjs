// Scenario: ArrowUp/ArrowDown navigates between sessions in the
// drawer when the composer / filter input is not focused.
//
// Feature added 2026-04-30. Mirrors a click on the prev/next session
// row — same active-class flip + same resumeSession path — driven
// from the keyboard so the user can sweep through their drawer
// without lifting hands off the keys.
//
// Test plan (mocked):
//   1. Pre-populate three chats A, B, C with distinct messages.
//   2. Boot the PWA + open sidebar.
//   3. Click chat A — assert A is active, transcript shows A's marker.
//   4. Press ArrowDown — expect chat B (next-most-recent) to become
//      active and its transcript to render.
//   5. Press ArrowDown again — expect chat C.
//   6. Press ArrowDown at end of list — expect no change (clamp).
//   7. Press ArrowUp twice — expect we're back at A.
//   8. Focus the composer + press ArrowUp — expect NO navigation
//      (input focus excluded).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sidebar-arrow-nav';
export const DESCRIPTION = 'ArrowUp/ArrowDown navigates between drawer sessions';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-chat-arrow-A';
const CHAT_B = 'mock-chat-arrow-B';
const CHAT_C = 'mock-chat-arrow-C';
const MARK_A = 'unique-marker-A-arrow-nav';
const MARK_B = 'unique-marker-B-arrow-nav';
const MARK_C = 'unique-marker-C-arrow-nav';

export function MOCK_SETUP(mock) {
  // lastActiveAt: A is most recent (will appear at top of drawer),
  // C is oldest (bottom). Drawer sorts by last_active_at desc, so
  // visibleRowIds order will be [A, B, C].
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [{ role: 'user', content: MARK_A, timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [{ role: 'user', content: MARK_B, timestamp: Date.now() / 1000 - 120 }],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_C, {
    title: 'Chat C',
    messages: [{ role: 'user', content: MARK_C, timestamp: Date.now() / 1000 - 180 }],
    lastActiveAt: Date.now() - 120_000,
  });
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

async function activeChatId(page) {
  return page.evaluate(() =>
    document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') || null);
}

async function waitForActive(page, chatId, { timeout = 3_000 } = {}) {
  await page.waitForFunction(
    (id) => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') === id,
    chatId,
    { timeout, polling: 50 },
  );
}

async function waitForTranscript(page, marker, { timeout = 3_000 } = {}) {
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout, polling: 50 },
  );
}

export default async function run({ page, log, fail }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for all three drawer rows.
  for (const id of [CHAT_A, CHAT_B, CHAT_C]) {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${id}"]`, { timeout: 5_000 });
  }
  log('three chats visible in drawer ✓');

  // Click chat A → it becomes active.
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_A}"] .sess-body`).first().click();
  await waitForActive(page, CHAT_A);
  await waitForTranscript(page, MARK_A);
  log('clicked A; A active + transcript renders ✓');

  // Click outside any input so document-level keydown sees it.
  // The transcript area is fine — it's not focusable but the body
  // still receives the keydown.
  await page.evaluate(() => document.body.focus());

  // ArrowDown → B
  await page.keyboard.press('ArrowDown');
  await waitForActive(page, CHAT_B);
  await waitForTranscript(page, MARK_B);
  log('ArrowDown → B ✓');

  // ArrowDown → C
  await page.keyboard.press('ArrowDown');
  await waitForActive(page, CHAT_C);
  await waitForTranscript(page, MARK_C);
  log('ArrowDown → C ✓');

  // ArrowDown at end — no change. Wait a beat, then assert C still active.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const stillC = await activeChatId(page);
  assert(stillC === CHAT_C, `at end of list, expected still C, got ${stillC}`);
  log('ArrowDown at end clamped (still C) ✓');

  // ArrowUp → B
  await page.keyboard.press('ArrowUp');
  await waitForActive(page, CHAT_B);
  await waitForTranscript(page, MARK_B);
  log('ArrowUp → B ✓');

  // ArrowUp → A
  await page.keyboard.press('ArrowUp');
  await waitForActive(page, CHAT_A);
  await waitForTranscript(page, MARK_A);
  log('ArrowUp → A ✓');

  // Now focus the composer and verify ArrowUp does NOT navigate.
  await page.locator('#composer-input').click();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  const stillA = await activeChatId(page);
  assert(stillA === CHAT_A, `composer-focused ArrowUp should NOT navigate, got active=${stillA}`);
  log('ArrowUp inside composer ignored ✓');
}
