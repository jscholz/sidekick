// Scenario: a finalized assistant reply must NOT duplicate when the
// SSE channel delivers an envelope for a message that history fetch
// has ALSO already rendered.
//
// User-reported bug (2026-04-30): one assistant message in hermes DB
// renders as TWO bubbles in the chat. iOS PWA log showed one
// [bubble-diag] reply_delta + one reply_final per msg_id, so the
// duplication is happening in the render path — not at envelope
// receipt. User noted the two bubbles' timestamps differed by a
// minute, suggesting one was rendered via showStreamingIndicator
// (client Date.now() at the moment of receipt) and the other via
// renderHistoryMessage (using m.timestamp from hermes).
//
// The forcing condition is "history renders bubble A, then SSE
// delivers fresh delta+final → showStreamingIndicator creates bubble
// B." This commonly happens when:
//   - hermes pushes the reply AFTER /messages has been fetched, OR
//   - PWA reconnects without a usable last_event_id cursor and the
//     proxy's replay ring re-delivers an envelope whose message has
//     already been persisted to /messages.
//
// Test plan (mocked):
//   1. Pre-seed a chat in the mock's history (so /messages returns
//      the user msg + assistant reply).
//   2. Boot the PWA + click the chat. History renders bubble A
//      (no replyId; renderHistoryMessage doesn't set one).
//   3. Push a fresh reply_delta + reply_final via mock.pushReply.
//      The same logical message is now being delivered live.
//   4. Wait for the SSE handlers to settle.
//   5. Assert: exactly ONE .line.agent in #transcript. Two bubbles
//      = the bug; the SSE delivery created bubble B for a message
//      already rendered as bubble A.

import { waitForReady, openSidebar, assert, dumpLines } from './lib.mjs';

export const NAME = 'bubble-dupe-replay';
export const DESCRIPTION = 'SSE replay ring must not duplicate a bubble already rendered from history';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-bubble-dupe';
const USER_TEXT = 'tell me a joke';
const REPLY_TEXT = 'Why did the chicken cross the road?';
const MESSAGE_ID = 'mock-msg-dupe-1';

export function MOCK_SETUP(mock) {
  // Seed chat with user msg + assistant reply already in history,
  // tagging the assistant message with the SAME message_id we'll use
  // when re-broadcasting via the SSE channel mid-test. Real proxy
  // emits the upstream `it.id` for both /messages and SSE
  // `message_id`, so the dedup-by-id fix can take effect.
  mock.addChat(CHAT_ID, {
    title: 'Dupe test',
    messages: [
      { role: 'user', content: USER_TEXT, timestamp: Date.now() / 1000 - 60, message_id: `${MESSAGE_ID}-u` },
      { role: 'assistant', content: REPLY_TEXT, timestamp: Date.now() / 1000 - 59, message_id: MESSAGE_ID },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // No pre-pushed envelopes — we'll push them mid-test, after history
  // has rendered, to simulate a fresh SSE delivery for an already-
  // persisted message.
}

export default async function run({ page, log, mock, fail }) {
  // Capture all console output for diagnostic.
  const consoleLines = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[bubble-diag]') || t.includes('[stream-relay]') ||
        t.includes('replaySessionMessages') || t.includes('proxy-client:')) {
      consoleLines.push(t);
    }
  });

  await waitForReady(page);
  await openSidebar(page);

  // Wait for the seeded chat to appear in the drawer, then click it
  // (boot may auto-open the most recent — we want to be explicit).
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();

  // Wait for the assistant reply to render via history fetch.
  await page.waitForFunction(
    (text) => (document.getElementById('transcript')?.textContent || '').includes(text),
    REPLY_TEXT,
    { timeout: 5_000, polling: 50 },
  );
  log('history rendered the assistant reply ✓');

  // Settle — make sure replaySessionMessages is fully done, the
  // skipRebuild fingerprint is cached, etc.
  await page.waitForTimeout(500);

  // Now push the SAME logical message via SSE. In production this
  // happens when hermes emits the reply via the persistent stream
  // for a message it has ALSO just persisted to state.db (so a
  // subsequent /messages fetch already includes it). The PWA has
  // no envelope-ID-based dedup against history (different namespaces).
  log('pushing live reply for a message already in history…');
  mock.pushReply(CHAT_ID, REPLY_TEXT, MESSAGE_ID);

  // Wait for the SSE handlers to process the envelopes.
  await page.waitForTimeout(1500);

  const counts = await page.evaluate(() => {
    const transcript = document.getElementById('transcript');
    return {
      agentTotal: transcript?.querySelectorAll('.line.agent').length || 0,
      agentStreaming: transcript?.querySelectorAll('.line.agent.streaming').length || 0,
      agentFinalized: transcript?.querySelectorAll('.line.agent:not(.streaming)').length || 0,
      bubbleIds: Array.from(transcript?.querySelectorAll('.line.agent') || [])
        .map((el) => el.dataset.replyId || '∅'),
      texts: Array.from(transcript?.querySelectorAll('.line.agent .text') || [])
        .map((el) => (el.textContent || '').slice(0, 60)),
    };
  });

  log(`agent bubbles: total=${counts.agentTotal} streaming=${counts.agentStreaming} finalized=${counts.agentFinalized}`);
  log(`bubble reply ids: ${JSON.stringify(counts.bubbleIds)}`);
  log(`bubble texts: ${JSON.stringify(counts.texts)}`);
  log(`captured console lines (last 40):\n${consoleLines.slice(-40).map(l => '    ' + l).join('\n')}`);

  if (counts.agentTotal !== 1) {
    log(`DOM dump:\n${await dumpLines(page, 20)}`);
    fail(`expected exactly 1 .line.agent bubble in transcript, got ${counts.agentTotal}. ` +
      `Bug: SSE replay ring duplicated a bubble already rendered from history.`);
  }
}
