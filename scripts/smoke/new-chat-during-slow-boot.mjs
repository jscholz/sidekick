// Scenario: New chat pressed while boot is still deciding where to land
// must win. Same rule as tap-during-slow-boot — a user gesture is never
// superseded by programmatic navigation (UX_DETERMINISM_PLAN §6 rule 1)
// — through the OTHER door.
//
// Why a second door exists at all: the sidebar row click goes through
// switchCtl.begin('tap'), which sets the sticky hasUserNavigated() flag
// and makes every later programmatic begin() refuse. The New chat button
// does not switch to an existing chat, it ROTATES onto a freshly minted
// empty one — no fetch, nothing to gate — so it never called begin(). It
// called switchCtl.invalidate() + setOptimistic(null), which bumps the
// epoch but is anonymous: it says "whatever was in flight is dead", not
// "a human moved". So a boot navigation that had not yet claimed the
// epoch was still free to claim it AFTER the rotation and paint its chat
// over the user's brand-new one.
//
// The reachable shape (this test): a FRESH profile with existing server
// sessions. Boot has no last-viewed snapshot, no pin and no IDB active
// row, so `sid` is null and the restore block is skipped entirely —
// boot's only move is the most-recent FALLBACK, and that path mints no
// token before its `await backend.listSessions(50)`. With no token to
// compare generations against, the fallback's post-await "is this still
// ours?" check falls back to `!switchCtl.hasUserNavigated()` — which the
// New chat press did not set. Holding the sessions list open with
// mock.setSessionsDelay() puts the press squarely inside that window.
//
// Pre-change this fails at step 3: the most-recent chat's transcript
// replaces the fresh chat's "New chat started" once the list lands.
//
// It also matters that the press is not swallowed: the new-chat handler
// no-ops when there is already an active-but-empty chat. On a fresh
// profile getCurrentSessionId() is null, so the guard passes — which is
// the same condition that makes bootTok null. The two line up by
// construction, not by luck.

import { assert } from './lib.mjs';

export const NAME = 'new-chat-during-slow-boot';
export const DESCRIPTION = 'New chat pressed before boot picks a landing is never painted over by it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const OLD_CHAT = 'mock-ncsb-old';
const RECENT_CHAT = 'mock-ncsb-recent';
const OLD_MARKER = 'ncsb-older-conversation-marker';
const RECENT_MARKER = 'ncsb-recent-conversation-marker';

/** How long every /sessions list response is held. Boot's most-recent
 *  fallback cannot reach its begin() before this elapses; the New chat
 *  press has to land inside it or the scenario tests nothing. */
const SESSIONS_DELAY_MS = 3_500;

export function MOCK_SETUP(mock) {
  mock.addChat(OLD_CHAT, {
    source: 'parley',
    title: 'Old chat',
    messages: [
      { role: 'user', content: OLD_MARKER, timestamp: Date.now() / 1000 - 3600 },
      { role: 'assistant', content: 'old reply', timestamp: Date.now() / 1000 - 3599 },
    ],
    lastActiveAt: Date.now() - 3600_000,
  });
  mock.addChat(RECENT_CHAT, {
    source: 'parley',
    title: 'Recent chat',
    messages: [
      { role: 'user', content: RECENT_MARKER, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'recent reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Armed in MOCK_SETUP, not in run(): the window we need to be inside
  // opens on the FIRST load, before a scenario body gets control.
  mock.setSessionsDelay(SESSIONS_DELAY_MS);
}

const transcriptText = () => document.getElementById('transcript')?.textContent || '';

export default async function run({ page, log, mock, url }) {
  // Boot announces its landing decision in the diag log; capture from
  // the top so nothing is missed.
  const bootLog = [];
  page.on('console', (m) => bootLog.push(m.text()));

  // Navigate ourselves rather than via waitForReady: that helper blocks
  // on "Connected", and by then boot may already have made its landing
  // decision. The window we need opens at domcontentloaded.
  // ?debug=1 matches every other scenario (it is waitForReady's default)
  // and turns on dev mode, which makes an unaddressed send throw rather
  // than fall back — so this file also runs under the strict contract.
  const t0 = Date.now();
  await page.goto(`${url}?debug=1`, { waitUntil: 'domcontentloaded' });

  // ── Step 1: press New chat as early as the app will accept it ────────
  // NOT waitForReady: that syncs on "Connected", and the button's click
  // handler is wired by boot AFTER backend.connect() resolves — neither
  // event orders reliably against the other. Press it the way a user
  // would (repeatedly, until something happens) and record when it took.
  // The retry is harmless: once a fresh empty chat is on screen, the
  // handler's own no-op guard swallows further presses.
  await page.waitForSelector('#sb-new-chat', { state: 'attached', timeout: 10_000 });
  let pressedAt = null;
  while (Date.now() - t0 < SESSIONS_DELAY_MS - 500) {
    await page.evaluate(() => document.getElementById('sb-new-chat')?.click());
    const took = await page.evaluate(() => (document.getElementById('transcript')?.textContent || '')
      .includes('New chat started'));
    if (took) { pressedAt = Date.now() - t0; break; }
    await page.waitForTimeout(100);
  }
  assert(pressedAt !== null,
    `New chat never rotated within the ${SESSIONS_DELAY_MS}ms boot window — the press was swallowed, `
    + 'so this scenario would prove nothing');
  log(`New chat rotated at +${pressedAt}ms (boot's fallback is held until +${SESSIONS_DELAY_MS}ms) ✓`);

  const freshId = await page.evaluate(() => {
    try { return localStorage.getItem('parley.viewed-session-id'); } catch { return null; }
  });
  assert(freshId && freshId !== OLD_CHAT && freshId !== RECENT_CHAT,
    `New chat should have minted a brand-new chat id, got ${freshId}`);
  log(`fresh chat minted: ${freshId} ✓`);

  // ── Step 2: hold past the whole boot window ──────────────────────────
  // Poll rather than sleep-then-check: boot's wrong paint can be
  // transient in some orderings, and a repaint the user would have SEEN
  // is a failure even if a later refresh repairs it.
  const deadline = t0 + SESSIONS_DELAY_MS + 2_500;
  let sawBootChat = null;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(transcriptText);
    if (txt.includes(RECENT_MARKER)) { sawBootChat = `recent (+${Date.now() - t0}ms)`; break; }
    if (txt.includes(OLD_MARKER)) { sawBootChat = `old (+${Date.now() - t0}ms)`; break; }
    await page.waitForTimeout(100);
  }
  const nav = await page.evaluate(() => {
    const l = window.__parleyNav;
    return Array.isArray(l) ? l.map((e) => `${e.origin}/${e.id}/g${e.gen}/${e.outcome}`) : null;
  });
  if (sawBootChat !== null) {
    throw new Error(
      `boot's landing painted the ${sawBootChat} chat over the user's New chat — a user gesture `
      + `was superseded by programmatic navigation (UX_DETERMINISM_PLAN §5 Phase 1).\n`
      + `  nav ledger: ${JSON.stringify(nav)}`,
    );
  }
  log(`no boot chat ever painted through +${Date.now() - t0}ms ✓`);

  // ── Step 3: the fresh chat is still the committed view ───────────────
  const finalState = await page.evaluate(() => ({
    viewed: (() => { try { return localStorage.getItem('parley.viewed-session-id'); } catch { return null; } })(),
    text: document.getElementById('transcript')?.textContent || '',
    activeRow: document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null,
  }));
  assert(finalState.viewed === freshId,
    `committed viewed id should still be the fresh chat ${freshId}, got ${finalState.viewed} (nav: ${JSON.stringify(nav)})`);
  assert(finalState.text.includes('New chat started'),
    'the fresh chat\'s system line should still be on screen');
  assert(finalState.activeRow === null || finalState.activeRow === freshId,
    `drawer must not highlight a boot-chosen row, got ${finalState.activeRow}`);
  log('viewed id + transcript are still the fresh chat ✓');

  // ── Step 4: the ledger — the evidence the field incident lacked ──────
  assert(Array.isArray(nav), 'window.__parleyNav should expose the navigation ledger');
  const rotation = nav.find((e) => e.startsWith(`new-chat/${freshId}/`));
  assert(!!rotation,
    `ledger should record the New chat rotation as a user navigation, got ${JSON.stringify(nav)}`);
  assert(/\/committed$/.test(rotation), `the rotation should read committed, got ${rotation}`);

  // No programmatic navigation may hold the epoch after it.
  const progWon = nav.filter((e) => /^(boot|fallback|reconcile|prewarm)\//.test(e))
    .filter((e) => /\/(begun|committed)$/.test(e));
  assert(progWon.length === 0,
    `no programmatic navigation may hold the epoch after New chat, got ${JSON.stringify(progWon)} `
    + `— full ledger ${JSON.stringify(nav)}`);

  // ...and boot must have DECLINED out loud rather than merely not
  // having run: either it hit the hasUserNavigated() guard before the
  // list fetch, or the post-await re-ask abandoned the fallback, or a
  // begin() was refused.
  const abandonDiag = bootLog.find((l) => /boot: (user already navigated|restore of .* refused|.*fallback (abandoned|to .* refused))/.test(l));
  const declined = nav.find((e) => /^(boot|fallback)\/.*\/(refused|superseded)$/.test(e));
  assert(!!abandonDiag || !!declined,
    'boot should have recorded declining to navigate — no abandon diag and no refused/superseded ledger entry.\n'
    + `  ledger: ${JSON.stringify(nav)}\n`
    + `  boot-ish log lines: ${JSON.stringify(bootLog.filter((l) => l.includes('boot:')))}`);
  log(`nav ledger: ${JSON.stringify(nav)}`);
  log(`boot declined: ${abandonDiag ? abandonDiag.trim() : declined} ✓`);

  // Leave the mock as we found it — the knob outlives the page.
  mock.setSessionsDelay(0);
}
