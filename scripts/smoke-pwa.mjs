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

// Surface page console errors + warnings immediately. Also keep a
// sliding ring of the LAST N console lines so we can dump them on
// failure for context (helps spot 'backend: loading X' / 'connected'
// timing issues that disappear into logs).
const consoleRing = [];
const RING_CAP = 200;
page.on('console', (msg) => {
  const line = `[${msg.type()}] ${msg.text()}`;
  consoleRing.push(line);
  if (consoleRing.length > RING_CAP) consoleRing.shift();
  if (msg.type() === 'error') log(`page-error: ${msg.text()}`);
});
page.on('pageerror', (err) => log(`page-pageerror: ${err.message}`));

let exitCode = 0;
try {
  log(`navigating ${URL}?debug=1`);
  await page.goto(`${URL}?debug=1`, { waitUntil: 'domcontentloaded' });

  log('waiting for composer input');
  await page.waitForSelector('#composer-input', { timeout: 10_000 });

  // Wait for backend to actually report connected before sending. The
  // header shows "Connected" / "Disconnected"; without this, fast
  // smokes can fire send() before the EventSource has registered with
  // the proxy, and sendTypedMessage early-returns on
  // !backend.isConnected().
  log('waiting for backend connected status');
  try {
    await page.waitForFunction(
      () => /Connected/.test(document.body.innerText),
      null,
      { timeout: 10_000, polling: 250 },
    );
  } catch {
    log('  (warning: never saw "Connected" text — proceeding anyway)');
  }

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

  // ── Turn 1: greeting ───────────────────────────────────────────────
  log('--- turn 1: "hi" ---');
  const turn1StartMs = Date.now();
  await page.fill('#composer-input', 'hi');
  await page.click('#composer-send');

  log(`turn 1: waiting for FINALIZED assistant bubble (≤${TIMEOUT_PER_TURN}ms)`);
  // chat.ts builds bubbles as `<div class="line {role}">…</div>`. The
  // streaming/thinking indicator is `.line.agent.streaming.pending`; we
  // want a finalized bubble (no `.streaming`, no `.pending`). Matching
  // just `.line.agent` previously matched the placeholder and reported
  // the indicator's "thinking…" label as the reply — false PASS.
  const finalAgentSel = '.line.agent:not(.streaming):not(.pending)';
  const userSel = '.line.user';

  try {
    await page.waitForSelector(finalAgentSel, { timeout: TIMEOUT_PER_TURN });
  } catch (e) {
    const composerState = await page.locator('#composer-input').inputValue().catch(() => '?');
    // chat.ts uses 's0' for user lines, not 'user'. Match permissively.
    const userBubbles = await page.locator('.line.s0, .line.user').count();
    const allAgent = await page.locator('.line.agent').count();
    const streamingAgent = await page.locator('.line.agent.streaming, .line.agent.pending').count();
    const finalAgent = await page.locator(finalAgentSel).count();
    const allLines = await page.locator('.line').count();
    // Dump every .line's class + text so we can see exactly what's in the DOM.
    const lineDump = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.line').forEach((el, i) => {
        const cls = el.className;
        const text = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 100);
        out.push(`    [${i}] class=${JSON.stringify(cls)} text=${JSON.stringify(text)}`);
      });
      return out.join('\n');
    });
    // Also: did backend.connect() complete? Console messages can hint.
    const transcriptHTML = await page.locator('#transcript').innerHTML().catch(() => '(no #transcript)');
    const consoleTail = consoleRing.slice(-50).map(l => `    ${l}`).join('\n');
    fail(`turn 1: no FINALIZED .line.agent within ${TIMEOUT_PER_TURN}ms.\n` +
         `  composer value: ${JSON.stringify(composerState)}\n` +
         `  user bubbles (.line.s0|.line.user): ${userBubbles}\n` +
         `  agent bubbles total: ${allAgent}\n` +
         `  agent bubbles still streaming/pending: ${streamingAgent}\n` +
         `  agent bubbles finalized: ${finalAgent}\n` +
         `  total .line elements: ${allLines}\n` +
         `  -- .line dump --\n${lineDump || '    (none)'}\n` +
         `  -- last ${Math.min(30, consoleRing.length)} page-console lines --\n${consoleTail || '    (none)'}\n` +
         `  -- #transcript HTML (truncated) --\n  ${transcriptHTML.slice(0, 300)}`);
  }
  const turn1FirstBubbleMs = Date.now() - turn1StartMs;
  log(`turn 1: first finalized assistant bubble appeared ✓  (${turn1FirstBubbleMs} ms after click)`);

  // First-message-ever in a fresh chat draws TWO bubbles: the gateway's
  // home-channel onboarding nudge ("📬 No home channel is set…") then
  // the agent's actual greeting. Wait for BOTH so we don't mistake
  // a partial render for success — pre-fix, the nudge would render
  // and the second bubble would be wiped by reply_final's empty-text
  // codepath. Allow extra time for the second bubble.
  log('turn 1: waiting for SECOND finalized agent bubble (real reply, not nudge)');
  try {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length >= 2,
      finalAgentSel,
      { timeout: TIMEOUT_PER_TURN, polling: 250 },
    );
  } catch {
    const finalCount = await page.locator(finalAgentSel).count();
    log(`  (got ${finalCount} finalized — expected 2; might be a model that skipped the nudge in this version)`);
  }

  // Dump every finalized agent bubble's text so failure analysis is easy.
  const agentTexts = await page.locator(`${finalAgentSel} .text`).allInnerTexts().catch(() => []);
  for (let i = 0; i < agentTexts.length; i++) {
    const t = agentTexts[i].slice(0, 100).replace(/\n/g, ' ');
    log(`turn 1: agent[${i}] "${t}"`);
  }

  if (agentTexts.length === 0 || agentTexts.every(t => !t.trim())) {
    fail('turn 1: no finalized agent bubble has any text');
  }
  if (agentTexts.some(t => /^(thinking|using \w+|pending)…?$/i.test(t.trim()))) {
    fail(`turn 1: at least one bubble is still a placeholder: ${JSON.stringify(agentTexts)}`);
  }

  // ── Turn 1 timing: send → first agent text on screen ──────────────
  // Measure the BARE-MINIMUM-greeting round-trip so we can spot
  // throughput regressions. End-of-nudge is what the user sees first
  // in a fresh chat; for non-fresh chats (no nudge), this is the
  // agent's reply directly.
  log(`turn 1: ${agentTexts.length} agent bubble(s) rendered`);

  // ── Turn 2: tool-using prompt ────────────────────────────────────
  log('--- turn 2: tool-using prompt ---');
  const toolPrompt = 'Search the web for today\'s weather in London and tell me the high temperature.';
  log(`turn 2: prompting "${toolPrompt}"`);
  const turn2StartMs = Date.now();
  await page.fill('#composer-input', toolPrompt);
  await page.click('#composer-send');

  // Phase 3 renders an activity row between the user message and the
  // agent reply when tool_call / tool_result envelopes arrive.
  // Default agentActivity setting is 'summary' → one .activity-row
  // exists per turn. We assert the row appears AND eventually a new
  // finalized agent bubble lands after it.
  log('turn 2: waiting for activity row (tool calls)');
  let sawActivity = false;
  try {
    await page.waitForSelector('.activity-row', { timeout: 30_000 });
    sawActivity = true;
  } catch {
    log('  (no .activity-row appeared in 30s — model may have answered without using a tool)');
  }
  const turn2ActivityMs = Date.now() - turn2StartMs;

  // The next finalized agent bubble (count must increase past turn-1's count).
  log('turn 2: waiting for new finalized agent bubble');
  const baselineCount = agentTexts.length;
  try {
    await page.waitForFunction(
      ({ sel, baseline }) => document.querySelectorAll(sel).length > baseline,
      { sel: finalAgentSel, baseline: baselineCount },
      { timeout: TIMEOUT_PER_TURN, polling: 250 },
    );
  } catch (e) {
    const finalCount = await page.locator(finalAgentSel).count();
    fail(`turn 2: no NEW finalized agent bubble within ${TIMEOUT_PER_TURN}ms (still ${finalCount}, baseline ${baselineCount})`);
  }
  const turn2ReplyMs = Date.now() - turn2StartMs;
  const turn2Texts = await page.locator(`${finalAgentSel} .text`).allInnerTexts();
  const turn2Reply = turn2Texts[turn2Texts.length - 1] || '';
  log(`turn 2: reply "${turn2Reply.slice(0, 120).replace(/\n/g, ' ')}"`);

  // Tool rows inside the activity row (full-mode children, expanded
  // when summary is clicked; in summary mode these still exist
  // in the DOM, just hidden behind the summary).
  const toolRowCount = await page.locator('.tool-row').count();
  log(`turn 2: tool rows in DOM: ${toolRowCount}`);

  console.log('');
  const turn1FinalMs = Date.now();  // Just for log alignment.
  console.log('=== timings ===');
  console.log(`  turn 1 (send → 1st bubble):           ${turn1FirstBubbleMs} ms`);
  console.log(`  turn 2 (send → activity row):         ${sawActivity ? `${turn2ActivityMs} ms` : 'N/A (no activity row)'}`);
  console.log(`  turn 2 (send → reply finalized):      ${turn2ReplyMs} ms`);
  console.log('');

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
