// Scenario: an empty IDB-only chat (0 msgs, no draft, no attachments)
// gets dropped when the user navigates AWAY to a different chat.
//
// Reported by Jonathan 2026-04-30: a "New chat / 0 msgs" entry
// persisted mid-list after he created it and clicked another chat
// without sending. The new-chat button itself doesn't write IDB rows
// (lazy-create design — see hermes-gateway.ts:newSession), but
// cross-device hydrate, dangling rows from an aborted send, or older
// pre-lazy-create rows can leave orphans behind. This test directly
// simulates that state by seeding an IDB-only orphan, then exercising
// the navigate-away path.
//
// Companion to `empty-chat-rotation-cleanup` — same predicate
// (0 msgs + no draft + no attachments), different trigger
// (drawer-row click vs. new-chat-button click).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'empty-chat-navigate-away-cleanup';
export const DESCRIPTION = 'Switching from an empty IDB-only chat to another chat drops the orphan from the drawer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-chat-with-content-A';
const ORPHAN_ID = '00000000-orphan-empty-aaaa-000000000001';

export function MOCK_SETUP(mock) {
  // Real chat with messages on the backend.
  mock.addChat(CHAT_A, {
    title: 'Chat A with content',
    messages: [
      { role: 'user', content: 'previous-msg', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'previous-reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Note: the orphan is intentionally NOT added to the mock backend —
  // it lives only in the PWA's IDB. The drawer's listSessions merge
  // appends local-only IDB rows so the orphan still surfaces.
}

/** Write an empty conversation row into the PWA's IDB store from page
 *  context. Mirrors what `conversations.hydrate(id)` would do for a
 *  chat the user has navigated to but never sent in.
 *
 *  Opens the DB with the same version + upgrade handler the PWA uses
 *  (see src/conversations.ts) so the test works even before the PWA
 *  has initialized the store on its own. */
async function seedOrphanIdbRow(page, chatId) {
  await page.evaluate(async (id) => {
    const DB_NAME = 'sidekick-conversations';
    const STORE = 'conversations';
    const META = 'meta';
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'chat_id' });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        chat_id: id, title: 'New chat',
        // 2h ago — matches what Jonathan reported.
        created_at: Date.now() - 2 * 60 * 60 * 1000,
        last_message_at: Date.now() - 2 * 60 * 60 * 1000,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, chatId);
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function drawerChatIds(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#sessions-list li[data-chat-id]'),
  ).map(li => li.getAttribute('data-chat-id')));
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Seed the orphan IDB row, then reload so the boot-time
  // listSessions merge picks it up. (No load-time API to hot-refresh
  // the drawer post-seed; reload is cleanest.)
  await seedOrphanIdbRow(page, ORPHAN_ID);
  await page.evaluate(() => location.reload());
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_A}"]`, { timeout: 5_000 });
  await page.waitForFunction(
    (id) => Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
      .some(li => li.getAttribute('data-chat-id') === id),
    ORPHAN_ID,
    { timeout: 5_000, polling: 100 },
  );
  log(`pre-condition: orphan ${ORPHAN_ID.slice(0, 8)}… visible in drawer`);

  // Activate the orphan first by clicking it. Boot may have picked
  // chat A as the most-recent active row, so we need to navigate INTO
  // the orphan to set up the navigate-AWAY scenario the user reported.
  await clickRow(page, ORPHAN_ID);
  log('activated orphan — empty transcript should render');

  // Wait for the orphan to be the active row. resume() flips
  // optimisticActiveId synchronously; the .active class lands on the
  // next refresh.
  await page.waitForFunction(
    (id) => {
      const active = document.querySelector('#sessions-list li.active[data-chat-id]');
      return active?.getAttribute('data-chat-id') === id;
    },
    ORPHAN_ID,
    { timeout: 5_000, polling: 100 },
  );

  // Now click chat A. onBeforeSwitch fires with leaving = orphan.
  // cleanupAbandonedChat sees 0 msgs + no draft + no attachments and
  // fires deleteSession on the orphan.
  await clickRow(page, CHAT_A);
  log('clicked chat A — cleanup should drop the orphan');

  // Wait for the orphan to disappear from the drawer.
  try {
    await page.waitForFunction(
      (id) => {
        const present = Array.from(
          document.querySelectorAll('#sessions-list li[data-chat-id]'),
        ).map(li => li.getAttribute('data-chat-id'));
        return !present.includes(id);
      },
      ORPHAN_ID,
      { timeout: 5_000, polling: 100 },
    );
  } catch {
    const finalIds = await drawerChatIds(page);
    throw new Error(
      `orphan ${ORPHAN_ID} still in drawer after navigate-away.\n` +
      `  full drawer: ${JSON.stringify(finalIds)}`,
    );
  }

  // Sanity: chat A is still there.
  const ids = await drawerChatIds(page);
  assert(
    ids.includes(CHAT_A),
    `chat A should still be in drawer, got ${JSON.stringify(ids)}`,
  );
  log(`navigate-away cleanup successful — orphan removed ✓`);
}
