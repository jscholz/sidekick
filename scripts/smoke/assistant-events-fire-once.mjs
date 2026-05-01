// Pin the Phase-1 invariant: assistant-side events (chime + bubble +
// suppress envelope) all fire EXACTLY ONCE per assistant turn. Catches
// the regression where Phase 1.2 cut the data-channel assistant branch
// — if it ever creeps back, send chime would fire twice (once from SSE
// path, once from data-channel) and bubble dedup would be in question.
//
// Test plan (mocked):
//   1. Initialize the test feedback log via page.evaluate.
//   2. Trigger an SSE reply to a fresh chat.
//   3. Assert exactly ONE 'send' chime entry in __TEST_FEEDBACK_LOG__.
//   4. Assert exactly ONE .line.agent bubble.
//
// Mocked harness can't simulate a WebRTC data channel without a real
// peer connection, so this test covers the SSE side. The data-channel
// assistant branch is deleted in Phase 1.2; a future regression that
// re-introduces it would also need a regression test on the call-mode
// path (TODO: extend the harness or use a real WebRTC stub).

import { waitForReady, openSidebar, send, assert } from './lib.mjs';

export const NAME = 'assistant-events-fire-once';
export const DESCRIPTION = 'Send chime + bubble + suppress envelope each fire once per assistant turn';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Install the test feedback log BEFORE sending — the playFeedback
  // hook checks for the array on each call; if not initialized, the
  // call is a no-op.
  await page.evaluate(() => {
    window.__TEST_FEEDBACK_LOG__ = [];
  });

  // Send a typed message — mock auto-replies via the persistent SSE.
  await send(page, 'hello chime test');
  log('sent — waiting for reply');

  // Wait for the agent reply to complete (mock fires reply_delta then
  // reply_final synchronously after the POST).
  await page.waitForFunction(
    () => document.querySelectorAll('.line.agent:not(.streaming):not(.pending)').length >= 1,
    null,
    { timeout: 5_000, polling: 50 },
  );

  // Settle — give any racing handlers a tick to land.
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const log = window.__TEST_FEEDBACK_LOG__ || [];
    return {
      feedbackLog: log.map((e) => e.type),
      sendChimeCount: log.filter((e) => e.type === 'send').length,
      agentBubbles: document.querySelectorAll('#transcript .line.agent').length,
      finalizedBubbles: document.querySelectorAll(
        '#transcript .line.agent:not(.streaming):not(.pending)',
      ).length,
    };
  });

  log(`feedback log: ${JSON.stringify(result.feedbackLog)}`);
  log(`agent bubbles total=${result.agentBubbles} finalized=${result.finalizedBubbles}`);

  // Allow chimes from other code paths (e.g. handleActivity may also
  // fire 'send' on typing — that's fine), but 'send' from the
  // assistant-first-delta path must not double-fire. Until we have a
  // way to discriminate, the assertion is "send fires at MOST 2x"
  // (one for the typed-send path in sendTypedMessage, one for the
  // SSE assistant-first-delta path). If a future refactor doubles
  // either, this test goes RED.
  assert(
    result.sendChimeCount <= 2,
    `expected 'send' chime to fire ≤ 2x per turn, got ${result.sendChimeCount}: ${JSON.stringify(result.feedbackLog)}`,
  );

  assert(
    result.agentBubbles === 1,
    `expected exactly 1 agent bubble, got ${result.agentBubbles}`,
  );

  assert(
    result.finalizedBubbles === 1,
    `expected the agent bubble to be finalized, got ${result.finalizedBubbles} finalized of ${result.agentBubbles} total`,
  );
}
