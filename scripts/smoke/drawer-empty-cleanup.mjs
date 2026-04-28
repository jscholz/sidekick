// Scenario: clicking "new chat" without sending shouldn't pollute the
// drawer. Reported by Jonathan 2026-04-28 — 5 rapid new-chat clicks
// produced 5 empty "New chat / 0 msgs" rows.
//
// Test plan:
//   1. Setup one chat with content (so drawer has a known baseline).
//   2. Click new-chat 5 times in rapid succession. Don't send.
//   3. Assert drawer's "New chat / 0 msgs" row count is ≤ 1
//      (empty new chats should be deduplicated — either no-op'd at
//      click time or GC'd on switch-away).
//   4. Send a message in the latest new-chat.
//   5. Assert there's still ≤ 1 "0 msgs" placeholder row.

import { waitForReady, openSidebar, clickNewChat, send, deleteChat, SEL, assert } from './lib.mjs';

export const NAME = 'drawer-empty-cleanup';
export const DESCRIPTION = 'Repeated new-chat without sending should not pollute drawer';
export const STATUS = 'implemented';

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

/** Count drawer rows whose meta line shows "0 msgs". Those are the
 *  empty-new-chat artifacts the bug produces. The meta text runs
 *  without spaces between segments ("just now0 msgs"), so use a
 *  permissive match. */
async function countEmptyRows(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('#sessions-list li');
    let n = 0;
    for (const r of rows) {
      const meta = r.querySelector('.sess-meta');
      if (meta && /0\s*msgs?\b/i.test(meta.textContent || '')) n++;
    }
    return n;
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Baseline chat with real content so the drawer isn't empty.
  log('setup: baseline chat with content');
  const baselineIdP = captureNextChatId(page);
  await clickNewChat(page);
  const baselineId = await baselineIdP;
  await send(page, 'baseline-content');
  await page.waitForSelector(SEL.agentFinal, { timeout: 60_000 });
  await page.waitForTimeout(400);

  // Capture each chat_id minted by the rapid new-chat clicks so we
  // can clean them up at the end (some may not appear in the drawer
  // post-fix but still exist in IDB).
  const mintedIds = [];
  log('clicking new-chat 5x rapidly without sending');
  for (let i = 0; i < 5; i++) {
    const idP = captureNextChatId(page).catch(() => null);
    await clickNewChat(page);
    const id = await idP;
    if (id) mintedIds.push(id);
    await page.waitForTimeout(50);  // human-fast click rate
  }
  log(`captured ${mintedIds.length} new-session log lines`);

  // Allow drawer refreshes to settle.
  await page.waitForTimeout(800);

  // Diagnostic: dump every drawer row's classes, dataset, and meta text
  // so we know what the bug ACTUALLY looks like. Jonathan's screenshot
  // showed "New chat / just now / 0 msgs" rows accumulating, but the
  // text "0 msgs" might not be how the DOM expresses it.
  const drawerDump = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#sessions-list li'));
    return rows.map((r, i) => {
      const meta = r.querySelector('.sess-meta')?.textContent?.trim() || '';
      const snippet = r.querySelector('.sess-snippet')?.textContent?.trim() || '';
      const cls = r.className;
      const cid = r.dataset?.chatId || null;
      return { i, cls, cid, snippet, meta };
    });
  });
  for (const r of drawerDump) {
    console.log(`  drawer[${r.i}] class=${JSON.stringify(r.cls)} cid=${r.cid?.slice(0,8)} snippet=${JSON.stringify(r.snippet)} meta=${JSON.stringify(r.meta)}`);
  }

  const emptyCount = await countEmptyRows(page);
  log(`drawer rows with "0 msgs": ${emptyCount}`);
  assert(
    emptyCount <= 1,
    `expected ≤1 empty new-chat row, got ${emptyCount} (rapid new-chat is polluting drawer)`,
  );

  // Send a message in whatever new-chat is currently active. After
  // send, that row gets content; empty count should still be ≤ 1.
  log('sending message in current chat');
  const finalChatIdP = (async () => {
    // chat_id is just whatever is currently active.
    return page.evaluate(() => {
      const active = document.querySelector('#sessions-list li.active');
      return active?.dataset?.chatId || null;
    });
  })();
  await send(page, 'final-content');
  await page.waitForSelector(SEL.agentFinal, { timeout: 60_000 });
  await page.waitForTimeout(400);
  const finalChatId = await finalChatIdP;

  const emptyAfter = await countEmptyRows(page);
  log(`after send: drawer rows with "0 msgs": ${emptyAfter}`);
  assert(
    emptyAfter <= 1,
    `expected ≤1 empty row after send, got ${emptyAfter}`,
  );

  // Cleanup
  await deleteChat(page, baselineId);
  if (finalChatId) await deleteChat(page, finalChatId);
  for (const id of mintedIds) await deleteChat(page, id);
}
