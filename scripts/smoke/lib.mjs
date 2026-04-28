// Shared helpers for sidekick PWA smoke scenarios.
//
// Each scenario file in scripts/smoke/ exports a default async function
// that takes a SmokeContext { page, log, fail, url } and returns when
// the scenario is satisfied. Throwing or calling fail() = scenario
// failed; resolving = passed.
//
// Goals:
//   - One scenario per file. Independent. Fresh chat_id per run.
//   - Fast feedback: timing per scenario printed by the runner.
//   - Loose assertions on LLM content (model is non-deterministic).
//     Assert SHAPE: bubble appeared, tool fired, summary rendered.

import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROMIUM = '/usr/bin/chromium';
export const DEFAULT_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3001';

/** Launch a fresh persistent context. Each scenario gets one — so
 *  IDB / SW state is clean and scenarios can't leak into each other.
 *  Caller must `await ctx.close()` and `cleanup()` when done. */
export async function launchBrowser({ headed = false, debug = true } = {}) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'sk-smoke-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROMIUM,
    headless: !headed,
    args: ['--no-sandbox'],
    // Desktop viewport — sidekick's mobile breakpoint auto-collapses
    // the sidebar drawer on small screens, which would make drawer
    // rows non-clickable in tests. Pin to a stable desktop size.
    viewport: { width: 1280, height: 800 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const cleanup = async () => {
    try { await ctx.close(); } catch {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return { ctx, page, userDataDir, cleanup };
}

/** Attach console-line capture to a Playwright page. Returns a function
 *  that returns the last N lines (for diagnostic dump on failure). */
export function attachConsoleCapture(page, cap = 200) {
  const ring = [];
  page.on('console', (msg) => {
    ring.push(`[${msg.type()}] ${msg.text()}`);
    if (ring.length > cap) ring.shift();
  });
  page.on('pageerror', (e) => ring.push(`[pageerror] ${e.message}`));
  return (n = 50) => ring.slice(-n);
}

/** Wait for the PWA to load and report connected status. Hard-fails if
 *  it doesn't connect — every scenario depends on this. */
export async function waitForReady(page, url = DEFAULT_URL, { debug = true, timeout = 15_000 } = {}) {
  const target = debug ? `${url}?debug=1` : url;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout });
  // Header text flips to "Connected" once backend.connect resolves.
  await page.waitForFunction(
    () => /Connected/.test(document.body.innerText),
    null,
    { timeout, polling: 250 },
  );
}

/** Ensure the sidebar drawer is expanded (so drawer rows are clickable).
 *  Sidekick collapses by default on every fresh load — no LocalStorage
 *  preference saved → drawer hidden. Tests need it open. */
export async function openSidebar(page, { timeout = 3_000 } = {}) {
  const isExpanded = await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    return sb?.classList.contains('expanded') || false;
  });
  if (isExpanded) return;
  // Toggle button id: sb-toggle (desktop) or sb-toggle-mobile (mobile).
  // We're on a 1280px viewport so desktop applies.
  const toggle = page.locator('#sb-toggle, #sb-toggle-mobile').first();
  await toggle.click();
  await page.waitForFunction(
    () => document.getElementById('sidebar')?.classList.contains('expanded'),
    null,
    { timeout, polling: 100 },
  );
}

/** Click the new-chat button. Handles both the desktop (drawer-open)
 *  and mobile (drawer-collapsed) layouts. */
export async function clickNewChat(page, { timeout = 5_000 } = {}) {
  const visible = await page.locator('#sb-new-chat:visible').count();
  if (visible > 0) {
    await page.click('#sb-new-chat:visible');
    return;
  }
  // Drawer collapsed — open it first.
  const toggle = page.locator('#sb-toggle, [aria-label="Menu"]').first();
  if (await toggle.count()) await toggle.click();
  await page.waitForSelector('#sb-new-chat', { state: 'visible', timeout });
  await page.click('#sb-new-chat');
}

/** Type into the composer + click send. Returns the timestamp of the
 *  click so the caller can compute round-trip timings.
 *
 *  Uses programmatic click via DOM rather than Playwright's mouse
 *  click — at our test viewport the ambient weather widget can
 *  overlap the send button, causing Playwright's intercept-detection
 *  to retry forever. End users hit Enter (which dispatches a
 *  programmatic click anyway), so this matches that path. */
export async function send(page, text) {
  await page.fill('#composer-input', text);
  const t0 = Date.now();
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  return t0;
}

// Useful selectors. Centralized so a UI rename (e.g. .line.s0 → .line.user)
// is one diff, not 10.
export const SEL = {
  composer: '#composer-input',
  send: '#composer-send',
  newChat: '#sb-new-chat',
  drawerEntry: '.session-row',  // adjust if the drawer renames
  filterInput: '#sb-filter',
  // Chat bubbles
  userBubble: '.line.s0, .line.user',
  agentBubble: '.line.agent',
  agentFinal: '.line.agent:not(.streaming):not(.pending)',
  // Phase 3 activity / tool rendering
  activityRow: '.activity-row',
  activityRowSummary: '.activity-row-summary',
  activityRowFull: '.activity-row-full',
  toolRow: '.tool-row',
  // System lines (e.g. "New chat started")
  systemLine: '.line.system',
};

/** Assert helper that throws with a useful failure message. */
export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** Dump the first N .line elements as `[i] class="…" text="…"` for
 *  diagnostic context on failure. */
export async function dumpLines(page, n = 20) {
  return page.evaluate((cap) => {
    const out = [];
    document.querySelectorAll('.line').forEach((el, i) => {
      if (i >= cap) return;
      const cls = el.className;
      const text = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 100);
      out.push(`  [${i}] class=${JSON.stringify(cls)} text=${JSON.stringify(text)}`);
    });
    return out.join('\n');
  }, n);
}
