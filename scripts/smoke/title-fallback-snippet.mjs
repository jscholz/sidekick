// Scenario: a chat with messageCount > 0 but title='' should render
// a snippet of the first user message in the drawer — NOT the
// "New chat" placeholder. Once hermes generates a title and emits
// a `session_changed` envelope, the drawer flips from snippet to
// the real title.
//
// Reported by Jonathan 2026-04-28. Real chats periodically end up
// untitled (model error, blip, race) and the drawer's "New chat"
// fallback makes them indistinguishable from never-sent stubs. The
// proxy now exposes `first_user_message` per session row and the
// drawer's `s.title || s.snippet || s.id` chain picks it up when
// title is empty.
//
// Mocked path — no hermes / LLM. The mock's /api/sidekick/sessions
// derives first_user_message from each chat's first role='user'
// message exactly like the proxy does.
//
// Test plan:
//   1. Pre-seed one chat with title='' and a non-empty user message.
//   2. Drawer renders the snippet of the user message (NOT "New chat").
//   3. Push a session_changed envelope with title="Real title".
//   4. Drawer row flips from snippet to "Real title" within ~1s.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'title-fallback-snippet';
export const DESCRIPTION = 'Untitled chat falls back to first-user-message snippet, then flips to real title on session_changed';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-snippet-test';
const FIRST_USER_MSG = 'Plan a trip to Lisbon for next weekend';
const REAL_TITLE = 'Lisbon weekend trip';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: '',  // empty — drawer should fall back to the snippet
    messages: [
      { role: 'user', content: FIRST_USER_MSG, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'Sure — when do you want to leave?', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for the drawer row to appear at all.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });

  // Snippet phase: title is empty, so the drawer should show the
  // first-user-message snippet, NOT "New chat" or the chat-id UUID.
  // We poll for up to 2s because the initial render uses the cached
  // (snippet-less) shape until the first server fetch lands.
  try {
    await page.waitForFunction(
      ({ chatId, snippet }) => {
        const li = document.querySelector(`#sessions-list li[data-chat-id="${chatId}"]`);
        const text = li?.querySelector('.sess-snippet')?.textContent ?? '';
        return text.includes(snippet);
      },
      { chatId: CHAT_ID, snippet: FIRST_USER_MSG },
      { timeout: 2_000, polling: 50 },
    );
  } catch {
    const dump = await page.evaluate((cid) => {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`);
      return {
        snippet: li?.querySelector('.sess-snippet')?.textContent ?? null,
        outer: li?.outerHTML?.slice(0, 400) ?? null,
      };
    }, CHAT_ID);
    throw new Error(
      `drawer did not show first-user-message snippet within 2s.\n` +
      `  expected to include: ${JSON.stringify(FIRST_USER_MSG)}\n` +
      `  current snippet:     ${JSON.stringify(dump.snippet)}\n` +
      `  outer (truncated):   ${JSON.stringify(dump.outer)}`,
    );
  }
  log(`drawer initially renders snippet "${FIRST_USER_MSG}" ✓`);

  // Pre-condition assertion: the row MUST NOT show "New chat" while
  // title is empty + a snippet is available. This pins the regression.
  const snippetText = await page.locator(
    `#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-snippet`,
  ).first().textContent();
  assert(
    !snippetText?.trim().startsWith('New chat'),
    `pre-condition: drawer should NOT show "New chat" placeholder when a snippet is available, got ${JSON.stringify(snippetText)}`,
  );

  // Now flip the title via a session_changed envelope — same path as
  // the existing title-update.mjs scenario. Mock instantly broadcasts
  // and updates its in-memory chat title, so the drawer's
  // session_changed handler + IDB write + refresh chain should land
  // within ~1s.
  mock.pushSessionChanged(CHAT_ID, REAL_TITLE);
  log(`pushed session_changed envelope title=${JSON.stringify(REAL_TITLE)}`);

  try {
    await page.waitForFunction(
      ({ chatId, title }) => {
        const li = document.querySelector(`#sessions-list li[data-chat-id="${chatId}"]`);
        const text = li?.querySelector('.sess-snippet')?.textContent ?? '';
        return text.includes(title);
      },
      { chatId: CHAT_ID, title: REAL_TITLE },
      { timeout: 2_000, polling: 50 },
    );
  } catch {
    const snapshot = await page.locator(
      `#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-snippet`,
    ).first().textContent();
    throw new Error(
      `drawer title did not update within 2s after session_changed.\n` +
      `  expected to include: ${JSON.stringify(REAL_TITLE)}\n` +
      `  current text:        ${JSON.stringify(snapshot?.slice(0, 200))}`,
    );
  }
  log(`drawer flipped to real title "${REAL_TITLE}" ✓`);
}
