// Scenario: an envelope tagged for chat A must NOT render in chat B's
// transcript when the user is viewing B. Switching back to A must
// show the envelope; switching forward to B again must hide it.
//
// Bug class this guards: hot spot #2 in docs/FRONTEND_ARCHITECTURE.md.
// The PWA gates inbound envelopes via sessionDrawer.getViewed():
//
//   if (env.conversation !== sessionDrawer.getViewed()) return;
//
// Recent regression ("three replies in active chat") was caused by
// this gate dropping envelopes during a stale-getViewed window. The
// proxy's `?chat_id=` filter (server-lib/backends/hermes-gateway/
// stream.ts) makes it impossible for cross-chat envelopes to escape
// the proxy in the first place — but the PWA today subscribes to the
// firehose to get cross-chat notification / session_changed events.
// So the gate is still load-bearing.
//
// Test plan (mocked, 2 chats):
//   1. Pre-populate chat A and chat B with marker history.
//   2. Click chat A in drawer; verify A's marker is visible.
//   3. Click chat B in drawer; verify B's marker is visible.
//   4. mock.pushReply(A, 'unique-A-reply'). PWA receives the envelope
//      via the persistent stream; gate at handleReplyDelta MUST drop
//      it (we're viewing B, env.conversation=A).
//   5. Verify B's transcript does NOT contain 'unique-A-reply'.
//   6. Click chat A. resumeSession refetches A's history (which now
//      includes the new reply via mock state). Verify 'unique-A-reply'
//      shows up.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sse-envelope-routing';
export const DESCRIPTION = 'SSE envelope tagged for chat A does not render in chat B';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-chat-A';
const CHAT_B = 'mock-chat-B';
const MARKER_A = 'marker-from-chat-A';
const MARKER_B = 'marker-from-chat-B';
const A_LATE_REPLY = 'unique-A-reply-arriving-while-viewing-B';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [
      { role: 'user', content: MARKER_A, timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'reply-A', timestamp: Date.now() / 1000 - 119 },
    ],
    lastActiveAt: Date.now() - 120_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [
      { role: 'user', content: MARKER_B, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'reply-B', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

async function waitForTranscript(page, marker, { timeout = 3_000 } = {}) {
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout, polling: 50 },
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for drawer to render both chats from MOCK_SETUP.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_A}"]`, { timeout: 5_000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_B}"]`, { timeout: 5_000 });

  // 2. Click chat A; verify its marker is visible.
  await clickRow(page, CHAT_A);
  await waitForTranscript(page, MARKER_A);
  log(`viewing chat A — marker visible ✓`);

  // 3. Click chat B; verify its marker is visible AND chat A's marker is gone.
  await clickRow(page, CHAT_B);
  await waitForTranscript(page, MARKER_B);
  let txt = await transcriptText(page);
  assert(
    !txt.includes(MARKER_A),
    `after switching to B, chat A's marker should not appear, got ${JSON.stringify(txt.slice(0, 200))}`,
  );
  log(`viewing chat B — A's marker gone ✓`);

  // 4. Push a reply to chat A while we're viewing B. The mock also
  //    appends to chat A's in-memory message history so the next
  //    resume of A includes it.
  // Persist the reply into chat A's mock state so future resume
  // fetches return it. Without this, switching back to A and
  // re-fetching history would not show the late reply.
  const aChat = mock.getChat(CHAT_A);
  if (aChat) {
    aChat.messages.push({
      role: 'assistant',
      content: A_LATE_REPLY,
      timestamp: Date.now() / 1000,
    });
    aChat.lastActiveAt = Date.now();
  }
  mock.pushReply(CHAT_A, A_LATE_REPLY);
  log(`pushed late reply to chat A while viewing B`);

  // Give the stream + gate a beat to process.
  await page.waitForTimeout(500);

  // 5. Chat B's transcript should NOT contain the chat A reply.
  txt = await transcriptText(page);
  assert(
    !txt.includes(A_LATE_REPLY),
    `cross-chat leak: chat A's reply should not render while viewing chat B.\n  transcript: ${JSON.stringify(txt.slice(0, 300))}`,
  );
  log(`gate correctly dropped A's envelope while viewing B ✓`);

  // 6. Switch back to A; A's late reply should now be visible.
  await clickRow(page, CHAT_A);
  await waitForTranscript(page, A_LATE_REPLY, { timeout: 4_000 });
  log(`switched back to A — late reply visible ✓`);
}
