// Scenario: after a fresh reload, the drawer's active (highlighted)
// row must match the chat whose content is rendered in the body.
// Reported by Jonathan 2026-04-29: drawer showed an empty "New chat"
// stub highlighted, but body rendered the WhatsApp chat's content.
//
// Repro: pre-existing local-only IDB stub + a server-side chat the
// user last viewed. Hard reload. Boot path restores chat snapshot
// (last-viewed) BUT drawer renders the local-only stub at top.
//
// Test plan (mocked):
//   1. Pre-populate sidekick chat A (no content) so drawer has at
//      least one server row at boot. WhatsApp chat W (with content).
//   2. Open PWA → click W to render its content (this writes the
//      chat snapshot via chat.persist + chat.trackViewedSession).
//   3. Click "New chat" — mints a local-only IDB stub. activeChatId
//      now equals the stub.
//   4. Click W AGAIN — activeChatId returns to W, snapshot stays.
//   5. page.reload().
//   6. After waitForReady, assert:
//      - Drawer's li.active matches W's chat_id (NOT the stub).
//      - Body contains W's marker.
//      - Composer is disabled (W is whatsapp).

import { waitForReady, openSidebar, clickNewChat, assert } from './lib.mjs';

export const NAME = 'boot-active-row-matches-content';
export const DESCRIPTION = 'After reload, drawer highlight matches the chat whose content body renders';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SK_CHAT = 'mock-sk-bootactive';
const WA_CHAT = 'mock-wa-bootactive';
const WA_MARKER = 'whatsapp-content-marker-bootactive';

export function MOCK_SETUP(mock) {
  // A sidekick chat so the drawer has more than just one row.
  mock.addChat(SK_CHAT, {
    source: 'sidekick',
    title: 'Sidekick chat',
    messages: [
      { role: 'user', content: 'sk-msg', timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'sk-reply', timestamp: Date.now() / 1000 - 119 },
    ],
    lastActiveAt: Date.now() - 120_000,
  });
  mock.addChat(WA_CHAT, {
    source: 'whatsapp',
    title: 'Current Weather Conditions in London',
    messages: [
      { role: 'user', content: WA_MARKER, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'wa-reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Step 1+2: click WhatsApp; content renders + snapshot saved.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${WA_CHAT}"]`, { timeout: 5_000 });
  await clickRow(page, WA_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    WA_MARKER,
    { timeout: 3_000 },
  );
  log(`whatsapp content visible + snapshot persisted ✓`);

  // Step 3: click new-chat — mints a local-only stub. activeChatId
  // becomes the stub.
  await clickNewChat(page);
  // Capture the stub's chat_id from the dbg log.
  const stubId = await page.evaluate(async () => {
    // Read conversations IDB to find the most-recent local conv.
    const mod = await import('/build/conversations.mjs');
    const list = await mod.list();
    return list.length > 0 ? list[0].chat_id : null;
  });
  log(`new-chat stub minted: ${stubId?.slice(0, 8) ?? 'null'}`);

  // Step 4: click W again — activeChatId returns to W.
  await clickRow(page, WA_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    WA_MARKER,
    { timeout: 3_000 },
  );

  // Step 5: reload.
  log(`reloading page...`);
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);

  // Step 6: assertions.
  // Wait for drawer + content to settle.
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li[data-chat-id]').length > 0,
    { timeout: 5_000 },
  );
  // Allow boot path's resumeSession + render to complete.
  await page.waitForTimeout(400);

  // Active row.
  const activeId = await page.evaluate(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null,
  );
  // Body content.
  const txt = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  // Composer state.
  const composerDisabled = await page.evaluate(() => {
    const el = document.getElementById('composer-input');
    return el?.disabled ?? null;
  });

  if (activeId !== WA_CHAT) {
    throw new Error(
      `bug A: drawer's active row should be WhatsApp after reload (snapshot was saved with WA).\n` +
      `  expected active: ${WA_CHAT}\n` +
      `  actual active:   ${activeId}\n` +
      `  body contains WA marker: ${txt.includes(WA_MARKER)}\n` +
      `  body sample: ${JSON.stringify(txt.slice(0, 200))}`,
    );
  }
  assert(txt.includes(WA_MARKER), `body should contain WhatsApp marker after reload, got ${JSON.stringify(txt.slice(0, 200))}`);
  assert(composerDisabled === true, `composer should be disabled (WA is whatsapp), got disabled=${composerDisabled}`);
  log(`reload: active row = whatsapp; body shows whatsapp content; composer disabled ✓`);
}
