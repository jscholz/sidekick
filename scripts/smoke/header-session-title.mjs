// Header session title + named loading state (UX_DETERMINISM_PLAN Phase 0
// #1/#2).
//
// Field report this doc reconstructs (docs/UX_DETERMINISM_PLAN.md §1): a
// boot-restore navigation superseded a user's tap 3s after the click, and
// nothing on screen said the view had moved — a dictation composed for
// "Time management" landed in "Notion MCP Health Monitoring" instead. The
// header showing only the brand (never the current session) is named as
// "the single cheapest fix in this document and would have prevented the
// mis-send on its own."
//
// Contract:
//   * Once a switch settles, #header-title equals the viewed session's
//     title.
//   * While a switch is in flight (its target not yet cached in memory,
//     server fetch delayed), #header-title reads "Opening <target>…" and
//     the transcript's named loading label (a real element under the
//     spinner, not ::after content) names the same target.
//   * Once the target's transcript lands, both settle back to the plain
//     title and the loading label is gone.
//
// Cold-switch technique borrowed from cold-switch-no-transcript-leak.mjs:
// the boot warm-up prefetches the top-8 most-recent sessions
// (PREFETCH_TOP_N in sessionDrawer.ts), so CHAT_B is seeded as the LEAST
// recent of ten chats — kept genuinely uncached — so its switch stays
// in-flight for the full setMessageDelay window instead of resolving
// instantly from a prefetched IDB cache.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'header-session-title';
export const DESCRIPTION = 'header always names the current/opening session; the transcript loading label names the switch target; both clear once it lands';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-header-title-a';
const CHAT_B = 'mock-header-title-b';
const TITLE_A = 'Time management';
const TITLE_B = 'Notion MCP Health Monitoring';
const A_SEED = 'HEADER-TITLE-A-SEED';
const B_SEED = 'HEADER-TITLE-B-SEED';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  const t0 = now / 1000 - 300;

  // Most recent — within the top-8 prefetch window (doesn't matter for
  // this test either way; clicked first and awaited to settle).
  mock.addChat(CHAT_A, {
    title: TITLE_A,
    messages: [
      { role: 'user', content: `plan my week ${A_SEED}`, parley_id: 'umsg_header_a', timestamp: t0 },
      { role: 'assistant', content: `Monday looks light ${A_SEED}`, parley_id: 'msg_header_a', timestamp: t0 + 1 },
    ],
    lastActiveAt: now - 500,
  });

  // Eight fillers MORE recent than CHAT_B, pushing it out of the top-8
  // boot prefetch so it stays genuinely cold at switch time.
  for (let i = 0; i < 8; i++) {
    mock.addChat(`mock-header-title-filler-${i}`, {
      title: `Filler ${i}`,
      messages: [
        { role: 'user', content: `filler ${i} msg`, parley_id: `umsg_header_filler_${i}`, timestamp: t0 - 10 - i },
      ],
      lastActiveAt: now - 1_000 - i * 100,
    });
  }

  // Least recent of the ten chats — outside PREFETCH_TOP_N and outside
  // the stale-tail sweep's cache-refresh path (no cache to refresh).
  mock.addChat(CHAT_B, {
    title: TITLE_B,
    messages: [
      { role: 'user', content: `any alerts? ${B_SEED}`, parley_id: 'umsg_header_b', timestamp: t0 - 600 },
      { role: 'assistant', content: `all clear ${B_SEED}`, parley_id: 'msg_header_b', timestamp: t0 - 599 },
    ],
    lastActiveAt: now - 120_000,
  });

  mock.setAutoReplyEnabled(false);
}

async function headerText(page) {
  return page.evaluate(() => document.getElementById('header-title')?.textContent ?? '');
}

async function loadingLabelText(page) {
  return page.evaluate(() =>
    document.querySelector('#transcript .transcript-loading-label')?.textContent ?? null);
}

async function isTranscriptLoading(page) {
  return page.evaluate(() =>
    !!document.getElementById('transcript')?.classList.contains('transcript-loading'));
}

async function transcriptHas(page, marker) {
  return page.evaluate(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Open A, wait for its transcript to land, assert the header settles
  //    to A's title.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    A_SEED,
    { timeout: 5_000, polling: 50 },
  );
  await page.waitForTimeout(100);
  const afterA = await headerText(page);
  assert(afterA === TITLE_A,
    `header should read A's title once its transcript lands, got ${JSON.stringify(afterA)}`);
  log(`header settles to the viewed title ✓ (${afterA})`);

  // 2. Slow B's server fetch, click B — B has no in-memory or IDB cache
  //    (pushed out of the prefetch window above), so resume() takes the
  //    blank+spinner path and stays there for the full delay.
  mock.setMessageDelay(CHAT_B, 1_500);
  await clickRow(page, CHAT_B);
  // switchCtl.begin() + headerTitle.sync() + showTranscriptLoading all run
  // synchronously inside the click handler's resume() call (no await
  // before them), so the in-flight state is already on screen the instant
  // clickRow's .click() resolves; this wait is just a safety margin.
  await page.waitForTimeout(50);

  const stillA = await transcriptHas(page, A_SEED);
  const coldB = await transcriptHas(page, B_SEED);
  assert(!coldB,
    'repro invalid: B already rendered — it was not genuinely cold (prefetch window leaked it in)');
  const opening = await headerText(page);
  const openingLabel = await loadingLabelText(page);
  assert(opening === `Opening ${TITLE_B}…`,
    `header should read the opening state for B while its fetch is in flight, got ${JSON.stringify(opening)}`);
  assert(openingLabel === `Opening ${TITLE_B}…`,
    `transcript loading label should name B while its fetch is in flight, got ${JSON.stringify(openingLabel)}`);
  log(`in-flight: header+label both read "Opening ${TITLE_B}…" (A still on screen=${stillA}) ✓`);

  // 3. Once B's delayed fetch resolves, both the header and the loading
  //    label must settle — the label is not just visually hidden, it's
  //    cleared out of the DOM (rerenderInto's explicit removal / the
  //    MutationObserver backstop in transcript/index.ts).
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    B_SEED,
    { timeout: 6_000, polling: 50 },
  );
  await page.waitForTimeout(150);
  const afterB = await headerText(page);
  const labelAfter = await loadingLabelText(page);
  const stillLoading = await isTranscriptLoading(page);
  assert(afterB === TITLE_B,
    `header should read B's title once its transcript lands, got ${JSON.stringify(afterB)}`);
  assert(labelAfter === null,
    `loading label should be gone once B's transcript renders, got ${JSON.stringify(labelAfter)}`);
  assert(!stillLoading, 'transcript-loading class should be cleared once B renders');
  log('header + loading label settle to B and the label clears once B lands ✓');
}
