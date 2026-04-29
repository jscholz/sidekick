// Scenario: when the user has two PWA tabs open and changes a setting
// in tab A, tab B's UI must reflect the new value within ~1s — both
// the in-memory `settings.get()` cache AND the visible DOM control
// (e.g. the <select> for agentActivity).
//
// Pre-fix history:
//   - Commit 16edfcb wired a `storage`-event listener in load() so the
//     cross-tab cache refresh works (settings.get() returns the new
//     value in tab B). But hydrate() set the DOM control values once
//     at boot and never re-applied them on storage events, so tab B's
//     <select> still showed the OLD value until full reload.
//   - This test pins the DOM-side sync.
//
// Test plan (mocked — pure UI state, no LLM):
//   1. Open page A, wait for ready.
//   2. Open page B in the SAME browser context (so localStorage is
//      shared and the `storage` event will fire across them).
//   3. In page A: open the settings panel, change agentActivity from
//      'summary' to 'full' via the <select>.
//   4. Wait briefly for the storage event to propagate to B.
//   5. Assert in page B:
//      - settings.get().agentActivity === 'full' (the cache fix from 16edfcb).
//      - document.getElementById('set-agent-activity').value === 'full'
//        (the new DOM auto-update being added).
//   6. Reverse direction: change in B → assert A picks it up too.
//
// Notes:
//   - Two pages in one persistent Chromium context share localStorage
//     and DO fire `storage` events between them in Playwright. No
//     fallback needed.
//   - The settings panel doesn't need to be open in page B for the
//     DOM <select> to exist — the elements live in index.html's
//     hidden settings panel from boot.

import { waitForReady, openSidebar } from './lib.mjs';
import { installMockBackend } from './mock-backend.mjs';

export const NAME = 'settings-cross-tab-sync';
export const DESCRIPTION = 'Setting change in tab A reflects in tab B (cache + DOM) without reload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) {
  // No pre-populated chats needed — the settings panel renders
  // independent of chat state. Boot path is fine on an empty drawer.
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function getCacheValue(page, key) {
  return page.evaluate(async (k) => {
    const mod = await import('/build/settings.mjs');
    return mod.get()[k];
  }, key);
}

async function getDomSelectValue(page, id) {
  return page.evaluate((sel) => {
    const el = document.getElementById(sel);
    return el ? el.value : null;
  }, id);
}

async function waitForBoth(page, key, domId, expected, timeoutMs = 2000) {
  const start = Date.now();
  let lastCache = null;
  let lastDom = null;
  while (Date.now() - start < timeoutMs) {
    lastCache = await getCacheValue(page, key);
    lastDom = await getDomSelectValue(page, domId);
    if (lastCache === expected && lastDom === expected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(
    `cross-tab sync timeout: expected ${key}=${expected}, got cache=${JSON.stringify(lastCache)} dom=${JSON.stringify(lastDom)}`,
  );
}

export default async function run({ page: pageA, ctx, log }) {
  await waitForReady(pageA);
  await openSidebar(pageA);
  log('page A ready');

  // Open a second page in the same browser context. Same-origin =>
  // shared localStorage, and DOM `storage` events fire across pages
  // in the same context (this is the standard browser behavior the
  // production fix relies on).
  const pageB = await ctx.newPage();
  // Mock backend interception is per-page in Playwright — install on B too.
  await installMockBackend(pageB);
  await waitForReady(pageB);
  log('page B ready');

  // Sanity: both pages start with the default agentActivity = 'summary'.
  assertEq(await getCacheValue(pageA, 'agentActivity'), 'summary', 'page A initial cache');
  assertEq(await getCacheValue(pageB, 'agentActivity'), 'summary', 'page B initial cache');
  assertEq(await getDomSelectValue(pageA, 'set-agent-activity'), 'summary', 'page A initial DOM');
  assertEq(await getDomSelectValue(pageB, 'set-agent-activity'), 'summary', 'page B initial DOM');

  // --- Direction 1: change in A, expect B to update ---
  // Open settings panel in A and change the <select> via the same
  // dispatch path the user would (selectByValue + change event).
  await pageA.evaluate(() => {
    const btn = document.getElementById('sb-settings');
    if (btn) btn.click();
  });
  await pageA.waitForSelector('#set-agent-activity', { state: 'visible' });
  await pageA.selectOption('#set-agent-activity', 'full');
  log('page A: changed agentActivity -> full');

  await waitForBoth(pageB, 'agentActivity', 'set-agent-activity', 'full');
  log('page B: cache + DOM both reflect "full" ✓');

  // Page A itself should also be consistent (sanity, not the cross-
  // tab path under test).
  assertEq(await getCacheValue(pageA, 'agentActivity'), 'full', 'page A cache after self-change');
  assertEq(await getDomSelectValue(pageA, 'set-agent-activity'), 'full', 'page A DOM after self-change');

  // --- Direction 2: change in B, expect A to update ---
  // Don't bother opening the settings panel in B — selectOption works
  // on any present element, and the cross-tab path doesn't depend on
  // panel visibility.
  await pageB.evaluate(() => {
    const btn = document.getElementById('sb-settings');
    if (btn) btn.click();
  });
  await pageB.waitForSelector('#set-agent-activity', { state: 'visible' });
  await pageB.selectOption('#set-agent-activity', 'off');
  log('page B: changed agentActivity -> off');

  await waitForBoth(pageA, 'agentActivity', 'set-agent-activity', 'off');
  log('page A: cache + DOM both reflect "off" ✓');

  // Cleanup: close page B explicitly. Runner closes pageA + the
  // context; pageB belongs to the same context but won't be auto-
  // tracked for screenshots etc.
  await pageB.close();
}
