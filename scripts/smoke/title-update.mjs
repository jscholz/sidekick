// Scenario: when the gateway emits `session_changed` with a new
// title, the drawer entry's text should update IN PLACE without
// requiring a reload or click-elsewhere-and-back.
//
// Reported by Jonathan 2026-04-28. Root cause (audit): the PWA's
// session_changed handler at hermes-gateway.ts:385 writes
// `conversations.updateTitle(chatId, env.title)` to IDB but does
// not call `sessionDrawer.refresh()`. The drawer renders from
// `cachedSessions` (last server fetch) until something else
// triggers a refresh, so the title stays stale on screen.
//
// Mocked path (T6 in docs/UX_TEST_PLAN.md) — UX tests should never
// depend on real backend timing. Mock `pushSessionChanged` is
// instant; an unmocked equivalent would block on hermes' title
// generation, which is real-backend smoke territory.
//
// Test plan:
//   1. Pre-seed one chat with title=''. PWA renders "New chat".
//   2. Push session_changed envelope with title="Mocked Title".
//   3. Within 1s (mock is instant), assert drawer entry text
//      includes "Mocked Title".

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'title-update';
export const DESCRIPTION = 'session_changed envelope updates drawer entry title in place';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-titletest';
const NEW_TITLE = 'Mocked Title via session_changed';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: '',  // empty — drawer should render "New chat" placeholder
    messages: [
      { role: 'user', content: 'placeholder', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Confirm the drawer initially renders the chat with the placeholder
  // title. Without this, a logic bug elsewhere could let the test
  // pass for the wrong reason.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  const initial = await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-title, #sessions-list li[data-chat-id="${CHAT_ID}"]`).first().textContent();
  log(`initial drawer text: ${JSON.stringify(initial?.slice(0, 60))}`);
  assert(
    !initial?.includes(NEW_TITLE),
    `pre-condition: drawer should NOT yet show "${NEW_TITLE}", got ${JSON.stringify(initial)}`,
  );

  // Fire the session_changed envelope through the mock stream.
  // The PWA's hermes-gateway adapter receives it on the persistent
  // /api/sidekick/stream EventSource and updates IDB.
  mock.pushSessionChanged(CHAT_ID, NEW_TITLE);
  log(`pushed session_changed envelope title=${JSON.stringify(NEW_TITLE)}`);

  // Within ~1s, the drawer entry's title should flip to NEW_TITLE.
  // Mock is instant; any delay > 100ms is a missing refresh() call.
  try {
    await page.waitForFunction(
      ({ chatId, title }) => {
        const li = document.querySelector(`#sessions-list li[data-chat-id="${chatId}"]`);
        return li?.textContent?.includes(title) ?? false;
      },
      { chatId: CHAT_ID, title: NEW_TITLE },
      { timeout: 2_000, polling: 50 },
    );
  } catch {
    const snapshot = await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"]`).first().textContent();
    throw new Error(
      `drawer title did not update within 2s after session_changed.\n` +
      `  expected to include: ${JSON.stringify(NEW_TITLE)}\n` +
      `  current text:        ${JSON.stringify(snapshot?.slice(0, 200))}`,
    );
  }
  log(`drawer title updated to "${NEW_TITLE}" ✓`);
}
