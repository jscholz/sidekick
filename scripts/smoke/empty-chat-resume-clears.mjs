// Scenario: clicking a 0-msg chat in the drawer must CLEAR the
// transcript, even if the previous active chat had content. Reported
// by Jonathan 2026-04-29: clicking "New chat / 0 msgs" rows shows
// the previous chat's content, not an empty transcript. UX-confusing
// — looks like the empty chat "is" the previous chat.
//
// Root cause: sessionDrawer.resume() has a cache-matched-skip
// optimization that returns early when cached.messages.length ===
// server.messages.length. For empty chats (both 0), this returns
// without firing onResumeCb, so replaySessionMessages (which calls
// chat.clear()) never runs.
//
// Test plan (mocked):
//   1. Pre-populate chat A with marker text + chat B with 0 messages.
//   2. Click A → assert marker visible.
//   3. Click B → assert transcript clears (no marker, 0 bubbles).
//   4. Click A → assert marker visible again (this populates B's
//      empty-array cache via the previous step's putMessagesCache).
//   5. Click B AGAIN → assert transcript clears (the SECOND visit
//      to an empty chat — cache for B is now {messages: []}, both
//      cache and server are length 0, cache-matched skip would
//      incorrectly bypass chat.clear() if the optimization is wrong).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'empty-chat-resume-clears';
export const DESCRIPTION = 'Clicking a 0-msg chat clears the transcript (no leak from previous chat)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-chat-with-content-resume';
const CHAT_B = 'mock-chat-empty-resume';
const MARKER_A = 'marker-from-A-resume-test';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [
      { role: 'user', content: MARKER_A, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'reply-A', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Empty chat — has a server entry but 0 messages.
  mock.addChat(CHAT_B, {
    title: 'Chat B (empty)',
    messages: [],
    lastActiveAt: Date.now() - 30_000,
  });
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

async function lineCount(page) {
  return page.evaluate(() =>
    document.querySelectorAll('#transcript .line.s0, #transcript .line.agent').length,
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_A}"]`, { timeout: 5_000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_B}"]`, { timeout: 5_000 });

  // 2. Click A; verify marker visible.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    MARKER_A,
    { timeout: 3_000, polling: 50 },
  );
  log(`viewing chat A — marker visible ✓`);

  // 3. Click B (empty) — first click should clear cleanly.
  await clickRow(page, CHAT_B);
  await waitForTranscriptCleared(page, MARKER_A, 'first click on B');
  let lines = await lineCount(page);
  assert(lines === 0, `step 3: empty chat should render 0 bubbles, got ${lines}`);
  log(`empty chat B (1st click) clears transcript correctly ✓`);

  // 4. Click A again → marker re-renders. This caches B's empty
  //    state from the prior step (putMessagesCache wrote []).
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    MARKER_A,
    { timeout: 3_000, polling: 50 },
  );
  log(`returned to A — marker visible again ✓`);

  // 5. SECOND click on empty B — cache now has {messages: []}.
  //    The cache-matched-skip optimization incorrectly bypasses
  //    chat.clear() because cached.length === server.length === 0.
  //    A's marker stays in the transcript. THIS is the user's bug.
  await clickRow(page, CHAT_B);
  await waitForTranscriptCleared(page, MARKER_A, 'second click on B (post-cache)');
  lines = await lineCount(page);
  assert(lines === 0, `step 5: empty chat (2nd click) should render 0 bubbles, got ${lines}`);
  log(`empty chat B (2nd click, post-cache) clears transcript correctly ✓`);
}

async function waitForTranscriptCleared(page, marker, label) {
  try {
    await page.waitForFunction(
      (m) => !(document.getElementById('transcript')?.textContent || '').includes(m),
      marker,
      { timeout: 3_000, polling: 50 },
    );
  } catch {
    const txt = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
    throw new Error(
      `[${label}] empty-chat click did NOT clear previous chat's content.\n` +
      `  transcript still contains: ${JSON.stringify(marker)}\n` +
      `  full transcript: ${JSON.stringify(txt.slice(0, 300))}`,
    );
  }
}
