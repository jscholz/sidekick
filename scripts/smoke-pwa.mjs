#!/usr/bin/env node
/**
 * End-to-end PWA smoke. Drives a real Chromium, exercises the full
 * sidekick stack (JS execution, DOM, EventSource, render gates),
 * and asserts the agent's reply actually appears on screen.
 *
 * Catches the class of bugs that scripts/smoke-flow.py can't:
 * UI-side regressions where the protocol works but the PWA doesn't
 * render — render gates, sessionDrawer state mismatches, IDB races.
 *
 * Usage:
 *   node scripts/smoke-pwa.mjs                    # default: localhost:3001
 *   node scripts/smoke-pwa.mjs --headed           # show the browser (debug)
 *   node scripts/smoke-pwa.mjs --keep-data        # preserve user-data-dir
 *
 * Exit 0 on PASS, 1 on FAIL with diagnostic output.
 */

import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = new Set(process.argv.slice(2));
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:3001';
const HEADED = argv.has('--headed');
const KEEP = argv.has('--keep-data');
const TIMEOUT_PER_TURN = 60_000;

const CHROMIUM = '/usr/bin/chromium';

function log(msg) { console.log(`[pwa-smoke] ${msg}`); }
function fail(msg) { console.error(`[pwa-smoke] FAIL: ${msg}`); process.exit(1); }

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pwa-smoke-'));
log(`user-data-dir: ${userDataDir}`);

// Persistent context (rather than browser+context) so the PWA's IDB +
// service-worker behave normally. Each smoke gets a clean profile.
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROMIUM,
  headless: !HEADED,
  args: ['--no-sandbox'],
});
const page = await ctx.pages()[0] || await ctx.newPage();

// Surface page console errors immediately — they're the most useful
// diagnostic when an assertion fails.
page.on('console', (msg) => {
  if (msg.type() === 'error') log(`page-error: ${msg.text()}`);
});
page.on('pageerror', (err) => log(`page-pageerror: ${err.message}`));

let exitCode = 0;
try {
  log(`navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  log('waiting for composer input');
  await page.waitForSelector('#composer-input', { timeout: 10_000 });

  // Clean slate: hit the new-chat button so we exercise the
  // newSession() path that just got fixed.
  log('clicking new-chat');
  // sb-new-chat lives in the sidebar drawer. On desktop layout the
  // drawer is collapsed; click whichever new-chat trigger is visible.
  const newChatSelector = '#sb-new-chat:visible, [data-testid="new-chat"]:visible';
  const hasNewChat = await page.locator(newChatSelector).count();
  if (hasNewChat > 0) {
    await page.click(newChatSelector);
  } else {
    // Drawer may need to open first. Try clicking the menu button.
    log('new-chat not visible — opening drawer');
    const drawerToggle = await page.locator('#sb-toggle, .menu-button, button[aria-label="Menu"]').first();
    if (await drawerToggle.count()) await drawerToggle.click();
    await page.waitForSelector('#sb-new-chat', { state: 'visible', timeout: 5000 });
    await page.click('#sb-new-chat');
  }

  // Turn 1: send "hi" — assert an assistant bubble appears.
  log('turn 1: sending "hi"');
  await page.fill('#composer-input', 'hi');
  await page.click('#composer-send');

  log(`turn 1: waiting for assistant bubble (≤${TIMEOUT_PER_TURN}ms)`);
  // chat.ts builds bubbles as `<div class="line {role}">…</div>` where
  // role is `agent` (for assistant replies) or `user`.
  const assistantSel = '.line.agent';
  const userSel = '.line.user';

  try {
    await page.waitForSelector(assistantSel, { timeout: TIMEOUT_PER_TURN });
  } catch (e) {
    const composerState = await page.locator('#composer-input').inputValue().catch(() => '?');
    const userBubbles = await page.locator(userSel).count();
    const agentBubbles = await page.locator(assistantSel).count();
    const allLines = await page.locator('.line').count();
    const stuckSending = await page.locator(':text("sending")').count();
    fail(`turn 1: no .line.agent within ${TIMEOUT_PER_TURN}ms.\n` +
         `  composer value: ${JSON.stringify(composerState)}\n` +
         `  user bubbles: ${userBubbles}\n` +
         `  agent bubbles: ${agentBubbles}\n` +
         `  total .line elements: ${allLines}\n` +
         `  'sending…' present: ${stuckSending > 0}`);
  }
  log('turn 1: assistant bubble appeared ✓');

  const replyText = await page.locator(assistantSel).last().innerText().catch(() => '');
  log(`turn 1: reply text "${replyText.slice(0, 80).replace(/\n/g, ' ')}"`);

  if (!replyText || replyText.trim().length === 0) {
    fail('turn 1: assistant bubble found but empty');
  }

  log('PASS');
} catch (e) {
  console.error(`[pwa-smoke] uncaught: ${e.stack || e.message}`);
  exitCode = 1;
} finally {
  await ctx.close();
  if (!KEEP) {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  } else {
    log(`kept user-data-dir: ${userDataDir}`);
  }
  process.exit(exitCode);
}
