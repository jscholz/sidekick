// Scenario: if the user has existing sessions but no chat snapshot
// (fresh install, cleared site-data, or activeChatId points to an
// unsent stub), the boot path should pick the MOST RECENT session
// and render it. Avoids the empty/blank state and the "selected
// stub but body shows another chat" divergence Jonathan reported
// 2026-04-29.
//
// Test plan (mocked):
//   1. Pre-populate two server chats: older (1h ago) + recent (1m ago).
//   2. Open PWA fresh — no chat snapshot in IDB.
//   3. After boot, drawer should highlight the RECENT chat AND the
//      transcript should show the recent chat's content.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'boot-picks-most-recent';
export const DESCRIPTION = 'Fresh boot with existing sessions picks most recent and renders it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const OLD_CHAT = 'mock-chat-old';
const RECENT_CHAT = 'mock-chat-recent';
const OLD_MARKER = 'older-conversation-marker';
const RECENT_MARKER = 'recent-conversation-marker';

export function MOCK_SETUP(mock) {
  mock.addChat(OLD_CHAT, {
    source: 'sidekick',
    title: 'Old chat',
    messages: [
      { role: 'user', content: OLD_MARKER, timestamp: Date.now() / 1000 - 3600 },
      { role: 'assistant', content: 'old reply', timestamp: Date.now() / 1000 - 3599 },
    ],
    lastActiveAt: Date.now() - 3600 * 1000,  // 1 hour ago
  });
  mock.addChat(RECENT_CHAT, {
    source: 'sidekick',
    title: 'Recent chat',
    messages: [
      { role: 'user', content: RECENT_MARKER, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'recent reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60 * 1000,  // 1 minute ago
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for drawer to render both chats.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${OLD_CHAT}"]`, { timeout: 5_000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${RECENT_CHAT}"]`, { timeout: 5_000 });

  // Allow the boot path's most-recent fallback to run + render.
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    RECENT_MARKER,
    { timeout: 5_000, polling: 100 },
  );
  log(`recent chat content rendered after boot ✓`);

  // Drawer's active row should be the recent chat.
  const activeId = await page.evaluate(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null,
  );
  assert(
    activeId === RECENT_CHAT,
    `drawer active row should be the recent chat after boot.\n  expected: ${RECENT_CHAT}\n  got:      ${activeId}`,
  );
  log(`drawer active row = recent chat ✓`);

  // Verify body shows recent's marker, not the old's.
  const txt = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(txt.includes(RECENT_MARKER), `body should contain recent marker`);
  assert(!txt.includes(OLD_MARKER), `body should NOT contain old marker`);
  log(`body matches highlighted row ✓`);
}
