// Shared helpers for parley PWA smoke scenarios.
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

// Resolve the chromium binary in priority order:
//   1. SMOKE_CHROMIUM env (explicit override).
//   2. The Playwright-bundled chromium under ~/.cache/ms-playwright
//      (any chromium-*/chrome-linux64/chrome). This is the right
//      default — the mock-backend smoke harness uses an in-process
//      HTTP server forwarding /api/parley/stream as SSE, and
//      consumer chromium builds (Google Chrome stable on Ubuntu)
//      ship aggressive default "block 3rd-party SSE / private-
//      network" heuristics that surface as net::ERR_BLOCKED_BY_CLIENT
//      on the forwarded stream — breaks every smoke that touches the
//      live stream channel. The Playwright build doesn't ship those
//      blocks. Note: those 3 smokes (tool-row-reload-dedup,
//      multi-session-bubble-survival, cross-device-pin-sync) appeared
//      as flakes under google-chrome-stable; all 3 pass cleanly under
//      the Playwright build.
//   3. /usr/bin/chromium (apt package) as last resort.
import { existsSync, readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
function _findPlaywrightChromium() {
  const home = process.env.HOME || '';
  if (!home) return null;
  const dir = pathJoin(home, '.cache', 'ms-playwright');
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir);
    // Prefer the highest-numbered chromium-XXXX/chrome-linux64/chrome.
    const chromiumDirs = entries
      .filter((e) => /^chromium-\d+$/.test(e))
      .sort()
      .reverse();
    for (const d of chromiumDirs) {
      const bin = pathJoin(dir, d, 'chrome-linux64', 'chrome');
      if (existsSync(bin)) return bin;
    }
  } catch { /* ignore — fall through */ }
  return null;
}
export const CHROMIUM = process.env.SMOKE_CHROMIUM
  || _findPlaywrightChromium()
  || '/usr/bin/chromium';
export const DEFAULT_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3001';

/** Launch a single Chromium process for the entire smoke run. Returns
 *  the `Browser` and a `closeShared()` to tear down at the end. Each
 *  scenario gets its own ephemeral `BrowserContext` (isolated storage,
 *  IDB, SW state) via `launchBrowser(browser)` — that's ~100ms vs. the
 *  ~2-3s per-scenario cost of relaunching Chromium. */
export async function launchSharedBrowser({ headed = false } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: !headed,
    args: [
      '--no-sandbox',
      // Chromium-built-in fake mic — generates a silent stream by default
      // and skips the permission prompt. Required for any smoke that
      // exercises getUserMedia + MediaRecorder (the listen-* tests):
      // their old hand-rolled MediaStream stubs fail with "parameter 1
      // is not of type 'MediaStream'" because MediaRecorder validates
      // its input is a real native MediaStream.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const closeShared = async () => {
    try { await browser.close(); } catch {}
  };
  return { browser, closeShared };
}

/** Spin up a fresh per-scenario context off the shared browser. Each
 *  context has its own cookie jar, localStorage, IndexedDB and service-
 *  worker registration — same isolation guarantee as the old
 *  per-scenario `launchPersistentContext` path, minus the Chromium boot
 *  cost. Caller must `await cleanup()` when the scenario finishes. */
export async function launchBrowser(browser, { headed: _headed = false, mobile = false } = {}) {
  // Mobile mode uses an iPhone-ish viewport (375x812) + touch +
  // mobile UA so the PWA's @media (max-width: 699px) rules apply
  // and the sidebar swipe gesture (sidebarSwipe.ts) engages. Without
  // these flags the mobile-only code paths (.mobile-only buttons,
  // sidebar overlay vs rail, swipe handlers) are never exercised
  // and the desktop-default suite ships with implicit iOS-coverage
  // holes. Scenarios opt in via `MOBILE = true` in the module.
  const ctx = mobile
    ? await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
          + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        isMobile: true,
        hasTouch: true,
      })
    : await browser.newContext({
        // Desktop viewport — parley's mobile breakpoint auto-collapses
        // the sidebar drawer on small screens, which would make drawer
        // rows non-clickable in tests. Pin to a stable desktop size.
        viewport: { width: 1280, height: 800 },
      });
  const page = await ctx.newPage();

  // Reliability floor for explicit wait timeouts. Many scenarios hardcode
  // tight waitForFunction/waitForSelector timeouts (~2-3s) that are fine on
  // a fast box but flake under full-suite load on slower hosts — the wait
  // genuinely needs ~2.8s but the cap is 3s, so it tips over
  // non-deterministically (a different scenario fails each full run). We
  // raise any explicit timeout below MIN_WAIT_MS up to the floor. This is
  // SAFE: it only ever *increases* a wait budget, and the suite's real
  // timing assertions ("connect <1s", barge fire <1.5s, …) are wall-clock
  // Date.now() + assert, NOT wait-timeouts — so flooring can't make a slow
  // path pass a latency check. A negative wait (expected to time out) just
  // waits a bit longer; still correct. Set SMOKE_MIN_WAIT_MS=0 to disable.
  const MIN_WAIT_MS = Number(process.env.SMOKE_MIN_WAIT_MS ?? 8000);
  if (MIN_WAIT_MS > 0) {
    const floor = (args) => {
      const last = args[args.length - 1];
      if (last && typeof last === 'object' && typeof last.timeout === 'number'
          && last.timeout < MIN_WAIT_MS) {
        last.timeout = MIN_WAIT_MS;
      }
      return args;
    };
    for (const m of ['waitForFunction', 'waitForSelector']) {
      const orig = page[m].bind(page);
      page[m] = (...args) => orig(...floor(args));
    }
  }

  const cleanup = async () => {
    try { await ctx.close(); } catch {}
  };
  return { ctx, page, cleanup };
}

/** Launch a DEDICATED Chromium that feeds a real WAV into getUserMedia
 *  instead of the silent default fake device. This is the linchpin for
 *  real-speech browser E2E: `--use-file-for-fake-audio-capture` makes
 *  the mic track play `fixtureAbsPath` so MediaRecorder captures actual
 *  audio (turn-based) and the WebRTC mic track carries real speech
 *  (realtime barge) — the silent shared-browser fake device exercises
 *  only the getUserMedia/MediaRecorder plumbing, never the audio itself.
 *
 *  WAV must be 16-bit PCM (linear16); Chromium rejects float/compressed.
 *
 *  Unlike launchSharedBrowser this is per-scenario: the flag binds ONE
 *  file at launch, and each audio scenario wants its own fixture. The
 *  runner tears it down after the scenario (vs. the shared browser that
 *  lives for the whole run). Returns the same { ctx, page, cleanup }
 *  shape as launchBrowser PLUS the owning browser so cleanup can close
 *  both. `noLoop` appends %noloop so the file plays once then goes
 *  silent (needed for silence-based turn commit); default loops it
 *  (needed to sustain speech for barge). */
export async function launchAudioBrowser(fixtureAbsPath, { headed = false, noLoop = false } = {}) {
  if (!existsSync(fixtureAbsPath)) {
    throw new Error(`launchAudioBrowser: fixture not found: ${fixtureAbsPath}`);
  }
  const fileArg = noLoop ? `${fixtureAbsPath}%noloop` : fixtureAbsPath;
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: !headed,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fileArg}`,
    ],
  });
  const { ctx, page, cleanup: closeCtx } = await launchBrowser(browser, { headed });
  const cleanup = async () => {
    try { await closeCtx(); } catch {}
    try { await browser.close(); } catch {}
  };
  return { browser, ctx, page, cleanup };
}

/** CDP network throttling. Emulates a constrained link (latency +
 *  bandwidth caps) on the page's renderer so the HTTP audio paths
 *  (/transcribe, /tts, SSE turn stream) are exercised under the kind of
 *  flaky/slow connection a phone hits in the field — where loading-state
 *  wedges and tap-dead-during-fetch bugs actually surface. Profiles:
 *    'slow3g'  ~400ms RTT, 400/400 kbps  (worst realistic mobile)
 *    'fast3g'  ~150ms RTT, 1.5/0.75 Mbps (typical degraded mobile)
 *  WebRTC media (realtime peer track) rides a separate transport CDP
 *  doesn't fully shape, so this most faithfully throttles the turn-based
 *  HTTP path; for realtime it still adds signaling latency (offer/ice). */
export async function throttleNetwork(page, profile = 'fast3g') {
  const PROFILES = {
    slow3g: { latency: 400, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8 },
    fast3g: { latency: 150, downloadThroughput: 1.5 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  };
  const cond = PROFILES[profile] || PROFILES.fast3g;
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', { offline: false, ...cond });
  return client;
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

/** Poll an in-page (possibly async) predicate until it is truthy.
 *
 *  WHY THIS EXISTS: Playwright's page.waitForFunction does NOT await
 *  async predicates. An `async` pageFunction (or a sync one returning a
 *  Promise, e.g. `() => fetch(...).then(...)`) hands the poller a
 *  Promise object, which is truthy — so the wait resolves immediately
 *  and VACUOUSLY, regardless of what the predicate would eventually
 *  return. page.evaluate() DOES await in-page promises, so this helper
 *  is the required pattern for any wait whose check needs `await`
 *  inside the page (dynamic import(), fetch(), IDB reads, …). Sync
 *  DOM-only predicates should keep using waitForFunction. A unit test
 *  (test/smoke-no-async-waitforfunction.test.ts) rejects async /
 *  Promise-returning waitForFunction predicates in smoke sources.
 *
 *  `fn` runs in the page via page.evaluate(fn, arg) on each tick.
 *  Resolves with the first truthy result; throws `label` on timeout.
 *  Evaluate errors (e.g. execution context destroyed mid-navigation)
 *  do not abort the poll — the condition just isn't true yet.
 *  Honors the same SMOKE_MIN_WAIT_MS reliability floor that
 *  launchBrowser applies to waitForFunction/waitForSelector. */
export async function pollUntil(page, fn, arg = undefined, {
  timeout = 8_000, polling = 100, label = 'pollUntil: condition not met',
} = {}) {
  const floor = Number(process.env.SMOKE_MIN_WAIT_MS ?? 8000);
  const budget = (floor > 0 && timeout < floor) ? floor : timeout;
  const start = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const v = await page.evaluate(fn, arg);
      if (v) return v;
      lastErr = null;
    } catch (e) { lastErr = e; }
    if (Date.now() - start >= budget) break;
    await page.waitForTimeout(polling);
  }
  throw new Error(`${label} (after ${budget}ms)`
    + (lastErr ? ` — last evaluate error: ${lastErr.message}` : ''));
}

/** Reset proxy-side yaml-backed settings to known values BEFORE the
 *  page boots. Smokes share the server's parley.config.yaml across
 *  scenarios — per-scenario BrowserContext gives clean localStorage +
 *  IDB, but the proxy's settings table is global. Tests that flip
 *  settings (mic-mode toggles, agent schema POSTs, etc.) leak state
 *  to subsequent scenarios. Call this in scenario setup to opt into
 *  a clean baseline.
 *
 *  Defaults match src/settings.ts DEFAULTS for keys these tests touch.
 *  Add to the map if a new test depends on a specific starting value. */
export async function resetServerSettings(page, overrides = {}) {
  const defaults = {
    // micCall was retired in 2026-05 (two-button-split refactor); the
    // call button replaces the toggle. `streaming` is the new mic-mode
    // selector (false=memo, true=cursor-aware dictation).
    streaming: false,
    micAutoSend: false,
    realtime: false,
    tts: false,
    silenceSec: 15,
    commitPhrase: 'over',
    bargeIn: true,
    bargeThreshold: 0.10,
    autoSend: true,
    // Body-STT engine (default = server-side blob → /transcribe). Tests
    // that exercise the local Web Speech path override to 'local'.
    streamingEngine: 'server',
    // Mic-tap dictation mode (src/settings.ts DEFAULTS). Added to the map
    // 2026-09-06: dictation-draft-binds-to-origin flips it to false to
    // exercise the batch/checkmark path, and the proxy's settings table
    // is shared across scenarios — without a reset here that leaks to
    // every later scenario that touches the mic.
    dictateRealtime: true,
  };
  const target = { ...defaults, ...overrides };
  // Use a Promise.all of fetches; the proxy handles each independently.
  // Errors are non-fatal (some keys may not exist on every backend).
  const results = await Promise.all(
    Object.entries(target).map(async ([key, value]) => {
      try {
        // Target the SAME origin the page-under-test loads from
        // (DEFAULT_URL honors SMOKE_URL). Hardcoding :3001 meant a
        // worktree run on an alt port wrote settings to the wrong server
        // while the page read config from its own — e.g. streamingEngine
        // stayed 'server' and listen-local-engine spuriously failed.
        const r = await fetch(`${DEFAULT_URL}/api/parley/config/${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        return { key, ok: r.ok };
      } catch (e) {
        return { key, ok: false, err: e.message };
      }
    }),
  );
  return results;
}

/** Synthesize a mic-button tap. The mic button uses pointerdown/pointerup
 *  (not click) for press-and-hold + tap-toggle support, so element.click()
 *  is a silent no-op. This dispatches the pointer events directly so
 *  tests don't need viewport math + page.mouse coordinates.
 *
 *  Mic button has a 500ms double-tap guard (TOGGLE_STOP_GUARD_MS in
 *  main.ts) that swallows pointerdowns within 500ms of a toggle-start —
 *  prevents stray double-clicks from killing a recording instantly.
 *  Tests doing tap-then-tap to toggle on/off must space the taps, so
 *  the helper takes an optional pre-delay. */
export async function tapMic(page, { afterPrevTapMs = 0 } = {}) {
  if (afterPrevTapMs > 0) await page.waitForTimeout(afterPrevTapMs);
  await page.evaluate(() => {
    const btn = document.getElementById('btn-mic');
    if (!btn) throw new Error('tapMic: #btn-mic not found');
    const opts = { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup', opts));
  });
}

/** Ensure the sidebar drawer is expanded (so drawer rows are clickable).
 *  Parley collapses by default on every fresh load — no LocalStorage
 *  preference saved → drawer hidden. Tests need it open. */
export async function openSidebar(page, { timeout = 3_000 } = {}) {
  const isExpanded = await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    return sb?.classList.contains('expanded') || false;
  });
  if (isExpanded) return;
  // Toggle button id: sb-toggle (desktop, lives INSIDE the sidebar so
  // it's off-screen when the sidebar is in mobile-collapsed
  // translateX(-100%) state) or sb-toggle-mobile (in the toolbar,
  // .mobile-only). Pick the visible one — locator(':visible') resolves
  // at click time, not when the locator's created, so this works for
  // both viewport modes without per-scenario branching.
  const toggle = page.locator('#sb-toggle:visible, #sb-toggle-mobile:visible').first();
  await toggle.click();
  await page.waitForFunction(
    () => document.getElementById('sidebar')?.classList.contains('expanded'),
    null,
    { timeout, polling: 100 },
  );
}

/** Open the settings panel and switch to a specific section. The
 *  desktop two-column shell (commit 384140e) hides every settings group
 *  except the active one — clicking `#sb-settings` alone leaves the
 *  Agent / Voice / Interaction groups invisible. Smokes that drive
 *  agent-setting controls (model picker, agent-declared rows) must
 *  navigate to their section explicitly. Section names match
 *  `[data-section]` on `.settings-group` and `[data-target]` on the
 *  nav buttons: notifications, display, agent, voice-input,
 *  voice-output, voice-phrases, interaction. */
/** Sections that share one nav tab (data-nav-target in index.html). Scenarios
 *  keep addressing the group by its data-section; we click the owning tab. */
const NAV_TARGET_FOR_SECTION = { 'voice-input': 'voice', 'voice-output': 'voice', 'voice-phrases': 'voice' };

export async function openSettingsSection(page, section, { timeout = 3_000 } = {}) {
  await page.click('#sb-settings');
  await page.waitForFunction(
    () => document.getElementById('settings')?.classList.contains('on'),
    null,
    { timeout },
  );
  await page.click(`.settings-nav-btn[data-target="${NAV_TARGET_FOR_SECTION[section] || section}"]`);
  await page.waitForSelector(`.settings-group[data-section="${section}"]:not([hidden])`, { timeout });
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

/**
 * THE SUPPRESSION INVARIANT, in one reusable line.
 *
 * `ttsPlaying` gates every user transcript in a call (main.ts drops
 * them outright while it is set). It must be a LEVEL signal that tracks
 * real playback — never a latch. Once a reply round is over and nothing
 * is coming out of the speaker, it must be false; if it isn't, the mic
 * is wedged and the user's next utterance goes nowhere. That is the
 * 2026-08-26 field bug, and its whole family.
 *
 * Cheap enough to drop at the end of ANY voice scenario, which is the
 * point: broad coverage beats one clever test. Call it after a reply
 * round has completed. `graceMs` lets a scenario ride out a legitimate
 * tail (the barge drain grace is 1.5 s).
 *
 * NOTE this asserts on the internal boolean, deliberately unlike the
 * multi-round smokes which assert at the end of the pipe (a user
 * utterance reaching dispatch). It is the version that is cheap to
 * apply everywhere; the end-of-pipe version is the version that would
 * have caught the field bug on its own. Use both.
 */
export async function assertMicGateReleased(page, label, { graceMs = 0, timeoutMs = 6_000 } = {}) {
  if (graceMs) await page.waitForTimeout(graceMs);
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(async () => {
      try {
        const s = await import('/build/audio/realtime/suppress.mjs');
        return { ok: true, playing: s.isTtsPlaying() };
      } catch (e) {
        return { ok: false, err: String(e?.message || e) };
      }
    });
    if (!last.ok) throw new Error(`assertMicGateReleased(${label}): ${last.err}`);
    if (last.playing === false) return Date.now() - start;
    await page.waitForTimeout(150);
  }
  throw new Error(
    `assertion failed: mic gate still shut ${timeoutMs}ms after "${label}" — `
    + 'suppress.isTtsPlaying() never cleared, so every user transcript from here '
    + 'on is dropped (the 2026-08-26 post-reply wedge)',
  );
}

/** Capture the chat_id minted by the PWA's new-chat flow by watching
 *  the dbg console line `hermes-gateway: new session (chat_id=…)`.
 *  Call BEFORE clicking new-chat — the returned promise resolves on
 *  the next matching console line. Times out after 5s. */
export function captureNextChatId(page, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`new-session log not seen in ${timeoutMs}ms`)),
      timeoutMs,
    );
    const handler = (msg) => {
      // Post-v0.383 unification: chat_ids are now prefixed
      // (`parley:<uuid>`). Regex accepts BOTH the prefixed shape
      // and the legacy bare-uuid shape so this helper stays
      // forward-and-back-compat with any old log line that might
      // surface during a partial deploy.
      const m = /new session \(chat_id=([^)\s]+)\)/.exec(msg.text());
      if (m) {
        clearTimeout(t);
        page.off('console', handler);
        resolve(m[1]);
      }
    };
    page.on('console', handler);
  });
}

/** Best-effort: ask the server to forget a chat_id. Used by tests to
 *  clean up the sessions they created so smoke runs don't pollute the
 *  real user's drawer. Failures are swallowed — server might be in a
 *  weird state at teardown, that's not the test's concern. */
export async function deleteChat(page, chatId) {
  try {
    await page.evaluate(async (id) => {
      try {
        await fetch(`/api/parley/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch {}
    }, chatId);
  } catch {}
}

/** Click a drawer row by chat id. No waits, no assertions — centralized
 *  so rapid-fire and steady-pace tests share identical click semantics
 *  (tests that diverge here drift on selectors). */
export async function clickRow(page, chatId) {
  const locator = page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`);
  await locator.first().click();
}

/** Wait until no `/api/parley/sessions/<id>/messages` request has
 *  fired for `idleMs`. Used by drawer tests to synchronize on "all in-
 *  flight resume() callbacks have settled" before asserting final state.
 *  Without this, a test that asserts immediately after the last click
 *  will race the trailing server fetch. */
export async function waitForDrawerQuiet(page, idleMs = 500, timeoutMs = 10_000) {
  let lastSeenAt = Date.now();
  const onReq = (req) => {
    if (/\/api\/parley\/sessions\/[^/]+\/messages/.test(req.url())) lastSeenAt = Date.now();
  };
  page.on('request', onReq);
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (Date.now() - lastSeenAt >= idleMs) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`waitForDrawerQuiet: still seeing /messages requests after ${timeoutMs}ms`);
  } finally {
    page.off('request', onReq);
  }
}

/** Snapshot the drawer-vs-transcript 1:1 invariant in one page.evaluate
 *  call so the read isn't itself raced by ongoing async work. Returns
 *  `{ activeId, transcriptText, transcriptMarkers }` where
 *  `transcriptMarkers` is the subset of `allMarkers` currently rendered
 *  in #transcript. */
export async function getDrawerSnapshot(page, allMarkers) {
  return page.evaluate((markers) => {
    const t = document.getElementById('transcript')?.textContent || '';
    return {
      activeId: document.querySelector('#sessions-list li.active')?.dataset?.chatId || null,
      transcriptText: t.slice(0, 200),
      transcriptMarkers: markers.filter((m) => t.includes(m)),
    };
  }, allMarkers);
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
