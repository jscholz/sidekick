// Q1: optimistic user bubble starts `.pending` after send, flips to
// `.failed` with Retry/Dismiss when the send throws. Architecture
// audit hot spot #1 — the original code added the bubble + cleared
// composer synchronously, so a send-failure left the user staring
// at a delivered-looking bubble that never reached the agent. They'd
// re-type, re-send, transcript ends up with duplicates.
//
// Test plan (mocked, FAILURE PATH ONLY):
//   1. Pre-populate one sidekick chat (so drawer has something).
//   2. Override the mock POST to return 503 from the start.
//   3. Click into the chat. Send "test-fail-marker".
//   4. Bubble should appear (briefly pending) then flip to .failed
//      with a Retry button rendered.
//   5. Click Retry — bubble removed, composer text restored.
//
// We don't test the success path (pending → finalized on agent ack)
// here because the mock's auto-reply triggers chat-replay paths that
// wipe local state. The pending → finalized state machine is a side
// effect of receiving any agent envelope; smoke tests cover envelope
// handling elsewhere (text-turn.mjs, sse-envelope-routing.mjs).

import { waitForReady, openSidebar, SEL, assert } from './lib.mjs';

export const NAME = 'atomic-bubble-pending-failed';
export const DESCRIPTION = 'Send-failure flips user bubble → .failed with Retry; click restores composer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SK_CHAT = 'mock-sk-atomic-bubble';
const FAIL_MARKER = 'test-fail-marker';

export function MOCK_SETUP(mock) {
  mock.addChat(SK_CHAT, {
    source: 'sidekick',
    title: 'Atomic-bubble test chat',
    messages: [
      { role: 'user', content: 'seed', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'ack', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

export default async function run({ page, log }) {
  // Override the mock POST handler BEFORE the PWA loads, so every send
  // 503's. Page-level routes take precedence over context-level, so
  // unroute the existing handler first (mock-backend installs its
  // own page.route for the same pattern).
  await page.unroute('**/api/sidekick/messages');
  await page.route('**/api/sidekick/messages', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'gateway_down_for_test' }),
    });
  });

  await waitForReady(page);
  await openSidebar(page);

  // Click into the seeded chat.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${SK_CHAT}"]`, { timeout: 5_000 });
  await clickRow(page, SK_CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('seed'),
    { timeout: 3_000 },
  );

  // Send the fail-marker.
  await page.fill(SEL.composer, FAIL_MARKER);
  await page.evaluate(() => document.getElementById('composer-send')?.click());

  // Bubble should flip to .failed with a Retry button. The
  // hermes-gateway adapter's sendMessage throws on !res.ok, so
  // sendTypedMessage's catch path runs → markBubbleFailed.
  await page.waitForFunction(
    (m) => {
      const all = Array.from(document.querySelectorAll('#transcript .line.s0.failed'));
      return all.some(el => (el.textContent || '').includes(m));
    },
    FAIL_MARKER,
    { timeout: 3_000, polling: 50 },
  );
  log(`send-failure → bubble flipped to .failed ✓`);

  // Verify retry button is present (inside the .send-failed-row, not
  // the line's own copy/source icons).
  const retryButton = page.locator('#transcript .line.s0.failed .send-failed-row button:has-text("Retry")').first();
  await retryButton.waitFor({ timeout: 1_000 });
  log(`retry button rendered ✓`);

  // Click Retry: bubble removed + composer holds the marker.
  await retryButton.click();
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.s0.failed').length === 0,
    { timeout: 2_000, polling: 50 },
  );
  const composerValue = await page.locator(SEL.composer).inputValue();
  assert(
    composerValue === FAIL_MARKER,
    `composer should hold restored marker text after Retry, got ${JSON.stringify(composerValue)}`,
  );
  log(`Retry: failed bubble removed + composer text restored ✓`);
}
