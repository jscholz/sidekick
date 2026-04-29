// Scenario: send a message, reload the page, expect the chat to
// restore from IDB snapshot (chat_id active, transcript visible,
// drawer highlights the right row).
//
// Mobile-critical: iOS PWA backgrounding kills the tab; restoration
// must be reliable. From docs/UX_TEST_PLAN.md T5.
//
// Bug surface this guards:
//   - chat.saveSnapshot / loadSnapshot regressions (transcript lost)
//   - sessionDrawer.getRestoredViewedSessionId returning wrong id
//     (drawer highlights wrong row after reload)
//   - active chat_id not hydrating on connect (next message goes to
//     the wrong session)
//
// Test plan (mocked):
//   1. Click new chat. Capture chat_id from the dbg log.
//   2. Send "persistence-marker-{rand}".
//   3. Wait for the agent reply to finalize.
//   4. page.reload().
//   5. After waitForReady, assert:
//      - Transcript contains both the user marker and the agent reply.
//      - Drawer's highlighted row matches the original chat_id.
//      - composer is empty (clean reload, not mid-typing).

import { waitForReady, openSidebar, clickNewChat, send, SEL, assert } from './lib.mjs';

export const NAME = 'persistence-reload';
export const DESCRIPTION = 'Reload after sending a message restores the chat in place';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) {
  // No pre-populated chats — scenario creates one via the PWA flow.
}

/** Capture the chat_id minted by the PWA's new-chat flow by watching
 *  the dbg console line `hermes-gateway: new session (chat_id=…)`. */
function captureNextChatId(page) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('new-session log not seen in 5s')), 5000);
    const handler = (msg) => {
      const m = /new session \(chat_id=([0-9a-f-]+)\)/.exec(msg.text());
      if (m) {
        clearTimeout(t);
        page.off('console', handler);
        resolve(m[1]);
      }
    };
    page.on('console', handler);
  });
}

const MARKER = `persistence-marker-${Math.random().toString(36).slice(2, 8)}`;
const MOCK_REPLY_PREFIX = '[mock] echo:';

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1 + 2: mint a fresh chat, capture id, send the marker.
  const idP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await idP;
  log(`minted chat_id=${chatId}`);

  await send(page, MARKER);
  log(`sent marker: ${MARKER}`);

  // 3. Wait for the mock's auto-reply to finalize. The mock sends a
  //    typing → reply_delta → reply_final sequence ~50ms after the
  //    POST. Allow generous timeout for build slowness.
  await page.waitForFunction(
    ({ prefix, marker }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(marker) && t.includes(prefix);
    },
    { prefix: MOCK_REPLY_PREFIX, marker: MARKER },
    { timeout: 5_000, polling: 100 },
  );
  log('user marker + agent reply visible in transcript');

  // 4. Reload. IDB persists across reload within the same Playwright
  //    persistent context (mkdtemp dir from launchBrowser).
  log('reloading page...');
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);

  // 5. Assertions on restored state.
  // 5a: transcript shows both the marker and the agent reply.
  const transcript = await page.evaluate(
    () => document.getElementById('transcript')?.textContent || '',
  );
  assert(
    transcript.includes(MARKER),
    `transcript should include user marker after reload, got ${JSON.stringify(transcript.slice(0, 200))}`,
  );
  assert(
    transcript.includes(MOCK_REPLY_PREFIX),
    `transcript should include agent reply after reload, got ${JSON.stringify(transcript.slice(0, 200))}`,
  );
  log('transcript restored ✓');

  // 5b: drawer's active row matches the original chat_id.
  const activeChatId = await page.evaluate(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null,
  );
  assert(
    activeChatId === chatId,
    `drawer active row should match original chat_id ${chatId}, got ${activeChatId}`,
  );
  log(`drawer highlight matches chat_id ${chatId} ✓`);

  // 5c: composer is empty (clean reload, not preserving in-flight text).
  const composerValue = await page.locator(SEL.composer).inputValue();
  assert(
    composerValue === '',
    `composer should be empty after reload, got ${JSON.stringify(composerValue)}`,
  );
  log('composer empty after reload ✓');
}
