// Scenario: a row tap that lands BEFORE the boot restore begins its
// switch must win. Boot restore is programmatic; the tap is the user.
//
// Field incident 2026-09-06 (docs/UX_DETERMINISM_PLAN.md §1): on a slow
// radio the app painted the drawer from the sessions list within a
// second, the user tapped "Time management" at 14:58:21, and the boot
// restore of the LAST-VIEWED chat ("Notion MCP Health Monitoring")
// reached its switchCtl.begin() three seconds later. The switch epoch is
// last-writer-wins with no notion of authority, so boot's newer
// generation superseded the tap: every continuation of the user's switch
// bailed at isCurrent(), boot painted Notion, committed viewed=Notion and
// re-aimed the send pointer. Nine minutes later a dictated dream log went
// to the wrong chat. Nothing on screen ever said the app had
// re-navigated.
//
// Why the boot begin() is LATE (this is the whole shape of the bug):
// main.ts runs the session landing inside backend.connect's
// onStatus(connected), which fires from the EventSource's onopen — but
// sessionDrawer.init() + its /sessions fetch run BEFORE connect and are
// not gated on it. A stalled SSE handshake therefore leaves a fully
// painted, fully tappable drawer sitting in front of a boot that has not
// yet claimed the epoch. mock.setStreamConnectDelay() reproduces exactly
// that window; delaying only /messages would NOT (boot's begin() runs
// before its fetch, so the tap would supersede it and the bug would hide).
//
// Test plan (mocked):
//   1. Two chats A and B with distinct seed markers.
//   2. Load, click B → B is the last-viewed chat (parley.viewed-session-id,
//      src/chat.ts:56) and the restored snapshot on the next boot.
//   3. Arm the slow boot: SSE handshake held 2s (boot's begin() lands at
//      ~2s), B's /messages held 3s (boot's paint of B would land at ~5s).
//   4. Reload. As soon as the drawer lists rows — well inside the 2s
//      window — click A.
//   5. Past the whole boot window, assert:
//        - the transcript shows A's seed,
//        - and NEVER shows B's seed again (polled across the window, so a
//          transient boot repaint fails the test even if it self-corrects),
//        - the committed viewed id is A,
//        - the drawer's active row is A,
//        - the nav ledger (window.__parleyNav) shows the tap committed and
//          shows B never taking the epoch, and boot said so out loud —
//          exactly one of:
//            * the abandon diag (the expected ordering: boot reaches its
//              hasUserNavigated() guard, skips before minting, and never
//              even fetches B), or
//            * a ledger entry for B reading refused (the guard raced and
//              begin() caught it) or superseded (the machine was slow
//              enough that boot got its begin() in before the click, so the
//              pre-existing generation rule handled it).
//          What must never appear is a B entry reading committed.
//
// Pre-change this fails at step 5: B's transcript replaces A's at ~5s.

import { waitForReady, openSidebar, clickRow, pollUntil, assert } from './lib.mjs';

export const NAME = 'tap-during-slow-boot';
export const DESCRIPTION = 'A row tap that precedes the boot restore is never superseded by it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-tapboot-a';
const CHAT_B = 'mock-tapboot-b';
const MARKER_A = 'tapboot-alpha-seed-marker';
const MARKER_B = 'tapboot-bravo-seed-marker';

/** How long the SSE open-handshake is held on the reload. Boot's
 *  switchCtl.begin() cannot run before this elapses. */
const STREAM_DELAY_MS = 2_000;
/** How long B's /messages is held. Boot's paint of B (the wrong paint
 *  we are guarding against) would land at STREAM_DELAY + this. */
const B_MESSAGES_DELAY_MS = 3_000;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    source: 'parley',
    title: 'Time management',
    messages: [
      { role: 'user', content: MARKER_A, timestamp: Date.now() / 1000 - 300 },
      { role: 'assistant', content: 'alpha-reply', timestamp: Date.now() / 1000 - 299 },
    ],
    lastActiveAt: Date.now() - 300_000,
  });
  mock.addChat(CHAT_B, {
    source: 'parley',
    title: 'Notion MCP Health Monitoring',
    messages: [
      { role: 'user', content: MARKER_B, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'bravo-reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

const transcriptText = () => document.getElementById('transcript')?.textContent || '';

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_B}"]`, { timeout: 5_000 });

  // ── Step 2: make B the last-viewed chat ──────────────────────────────
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    MARKER_B,
    { timeout: 5_000 },
  );
  const lastViewed = await page.evaluate(() => {
    try { return localStorage.getItem('parley.viewed-session-id'); } catch { return null; }
  });
  assert(lastViewed === CHAT_B, `last-viewed should be B before the reload, got ${lastViewed}`);
  log('B is the last-viewed chat ✓');

  // ── Step 3: arm the slow boot ────────────────────────────────────────
  mock.setStreamConnectDelay(STREAM_DELAY_MS);
  mock.setMessageDelay(CHAT_B, B_MESSAGES_DELAY_MS);
  // Boot announces its decision in the diag log. Capture from here so the
  // reload's lines are all in the ring (the runner's own capture isn't
  // handed to scenarios).
  const bootLog = [];
  page.on('console', (m) => bootLog.push(m.text()));

  // ── Step 4: reload, then tap A inside the pre-begin() window ─────────
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  // NOT waitForReady — that waits for "Connected", i.e. for the very
  // onStatus we are deliberately holding back. Sync on the drawer
  // instead: rows are painted from the (undelayed) sessions list.
  //
  // Wait for a ROW before touching the sidebar toggle. openSidebar reads
  // the expanded class once and clicks if it's missing; run against a
  // domcontentloaded page whose main.ts hasn't restored the persisted
  // drawer state yet, that click lands AFTER the restore and collapses
  // the drawer instead of opening it.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_A}"]`, { state: 'attached', timeout: 8_000 });
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  const tapAt = Date.now() - t0;
  log(`tapped A at +${tapAt}ms (boot's begin() is held until +${STREAM_DELAY_MS}ms)`);
  assert(
    tapAt < STREAM_DELAY_MS,
    `the tap must land BEFORE boot's begin() or the scenario tests nothing — tapped at +${tapAt}ms`,
  );

  // A's transcript paints from the tap's own resume (A has no delay).
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    MARKER_A,
    { timeout: 5_000 },
  );
  log(`A painted at +${Date.now() - t0}ms ✓`);

  // ── Step 5: hold past the entire boot window and assert A sticks ─────
  // Poll rather than sleep-then-check: boot's wrong paint is transient in
  // some orderings (a later refresh can repair it), and a repaint the user
  // would have SEEN is a failure even if it heals.
  const deadline = t0 + STREAM_DELAY_MS + B_MESSAGES_DELAY_MS + 2_000;
  let sawB = null;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(transcriptText);
    if (txt.includes(MARKER_B)) { sawB = Date.now() - t0; break; }
    await page.waitForTimeout(100);
  }
  const nav = await page.evaluate(() => {
    const l = window.__parleyNav;
    return Array.isArray(l) ? l.map((e) => `${e.origin}/${e.id}/g${e.gen}/${e.outcome}`) : null;
  });
  if (sawB !== null) {
    throw new Error(
      `boot restore painted B over the user's tap at +${sawB}ms — a user gesture was superseded ` +
      `by programmatic navigation (UX_DETERMINISM_PLAN §1).\n  nav ledger: ${JSON.stringify(nav)}`,
    );
  }
  log(`B never repainted through +${Date.now() - t0}ms ✓`);

  const finalViewed = await page.evaluate(() => {
    try { return localStorage.getItem('parley.viewed-session-id'); } catch { return null; }
  });
  assert(finalViewed === CHAT_A, `committed viewed id should be A, got ${finalViewed} (nav: ${JSON.stringify(nav)})`);

  const activeId = await page.evaluate(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null,
  );
  assert(activeId === CHAT_A, `drawer active row should be A, got ${activeId} (nav: ${JSON.stringify(nav)})`);
  log('viewed id + active row are both A ✓');

  // ── The ledger: the evidence the field incident did not have ─────────
  assert(Array.isArray(nav), 'window.__parleyNav should expose the navigation ledger');
  const tapEntry = nav.find((e) => e.startsWith(`tap/${CHAT_A}/`));
  assert(!!tapEntry, `ledger should record the tap on A, got ${JSON.stringify(nav)}`);
  assert(/\/(begun|committed)$/.test(tapEntry), `the tap should own the epoch, got ${tapEntry}`);
  // B must never have taken the epoch, whatever route boot took.
  const bEntries = nav.filter((e) => e.includes(`/${CHAT_B}/`));
  const bWon = bEntries.filter((e) => /\/(begun|committed)$/.test(e));
  assert(
    bWon.length === 0,
    `no navigation to B may hold the epoch after the tap, got ${JSON.stringify(bWon)} — full ledger ${JSON.stringify(nav)}`,
  );
  // ...and boot must have DECLINED out loud rather than merely not having
  // run. Either it hit the hasUserNavigated() guard and skipped before
  // minting (the expected ordering — it never even fetches B), or it got
  // as far as begin() and was refused / superseded there.
  const abandonDiag = bootLog.find((l) => /boot: (user already navigated|restore of .* refused|.*fallback (abandoned|to .* refused))/.test(l));
  const bDeclined = bEntries.find((e) => /\/(refused|superseded)$/.test(e));
  assert(
    !!abandonDiag || !!bDeclined,
    'boot should have recorded declining to navigate — no abandon diag and no refused/superseded ledger entry for B.\n' +
    `  ledger: ${JSON.stringify(nav)}\n` +
    `  boot-ish log lines: ${JSON.stringify(bootLog.filter((l) => l.includes('boot:')))}`,
  );
  log(`nav ledger: ${JSON.stringify(nav)}`);
  log(`boot declined: ${abandonDiag ? abandonDiag.trim() : bDeclined} ✓`);

  // Leave the mock as we found it — the knobs outlive the page, not the
  // scenario, but an explicit reset keeps a future shared-mock refactor
  // from inheriting a 3s stall.
  mock.setStreamConnectDelay(0);
  mock.setMessageDelay(CHAT_B, 0);
}
