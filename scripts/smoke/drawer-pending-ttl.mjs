// Pin the cross-device-delete-doesn't-propagate bug fix (Jonathan
// reported 2026-05-01): a chat announced via the SSE session-started
// event got added to pendingSessions on the local client and stayed
// there indefinitely. If the chat was later deleted from another
// device, the server's listSessions stopped returning it — but
// pendingSessions kept holding the synthesized row, and the drawer
// merged it back in via mergePending() forever.
//
// Fix (sessionDrawer.ts): pendingSessions entries carry _addedAt;
// refresh() drains entries older than PENDING_TTL_MS (60s in prod)
// that the server's listSessions did NOT include. Test overrides the
// TTL to a small value via window.__TEST_PENDING_TTL_MS__ so we can
// verify the drain in a few hundred ms instead of 60s.
//
// Test plan (mocked):
//   1. Boot PWA, open drawer.
//   2. Set __TEST_PENDING_TTL_MS__ = 100 (very short).
//   3. Inject a synthesized pending row via handleSessionAnnounced
//      with an id NOT in the mock's chat list.
//   4. Verify it appears in the drawer (mergePending merged it).
//   5. Wait 200ms (longer than the override TTL).
//   6. Trigger refresh.
//   7. Assert the orphan row is GONE — TTL drain kicked in.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'drawer-pending-ttl';
export const DESCRIPTION = 'Stale pending-session rows age out on refresh (cross-device delete propagation)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const ORPHAN_ID = 'mock-orphan-pending-row';
const REAL_ID = 'mock-real-confirmed-row';

export function MOCK_SETUP(mock) {
  // The "real" chat exists server-side and should remain visible
  // through the test — used to confirm refresh ran and the drawer
  // is otherwise functional.
  mock.addChat(REAL_ID, {
    title: 'Real Chat',
    messages: [{ role: 'user', content: 'hi', timestamp: Date.now() / 1000 }],
    lastActiveAt: Date.now(),
  });
  // ORPHAN_ID intentionally NOT in the mock — simulates "chat
  // announced via SSE but server doesn't know about it (deleted
  // elsewhere, or never persisted)."
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Wait for the real chat to appear in the drawer.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${REAL_ID}"]`, { timeout: 5_000 });
  log('real chat row visible ✓');

  // Set the test-only TTL override BEFORE injecting the orphan.
  // 100ms = short enough that a 200ms wait + refresh ages the entry
  // out cleanly.
  await page.evaluate(() => {
    window.__TEST_PENDING_TTL_MS__ = 100;
  });

  // Inject a synthesized pending row through the same path SSE
  // session-started uses.
  await page.evaluate(async (orphanId) => {
    const sd = await import('/build/sessionDrawer.mjs');
    sd.handleSessionAnnounced({
      id: orphanId,
      snippet: 'orphan from SSE',
      source: 'api_server',
    });
  }, ORPHAN_ID);

  // The pending row should be visible immediately (mergePending merged it).
  await page.waitForSelector(`#sessions-list li[data-chat-id="${ORPHAN_ID}"]`, { timeout: 3_000 });
  log('orphan pending row visible after handleSessionAnnounced ✓');

  // Wait past the test TTL.
  await page.waitForTimeout(200);

  // Trigger refresh — this is the path that should drain aged-out
  // pending entries.
  await page.evaluate(async () => {
    const sd = await import('/build/sessionDrawer.mjs');
    await sd.refresh();
  });

  // Settle.
  await page.waitForTimeout(150);

  // Orphan should be GONE.
  const orphanGone = await page.evaluate((id) =>
    !document.querySelector(`#sessions-list li[data-chat-id="${id}"]`),
    ORPHAN_ID,
  );
  assert(
    orphanGone,
    'orphan row should be drained from drawer after TTL elapsed + refresh',
  );
  log('orphan drained after TTL ✓');

  // Real chat still visible.
  const realStillVisible = await page.evaluate((id) =>
    !!document.querySelector(`#sessions-list li[data-chat-id="${id}"]`),
    REAL_ID,
  );
  assert(realStillVisible, 'real chat row should still be visible');
  log('real chat unaffected ✓');
}
