// Scenario: clicking drawer rows must not double-render the sidebar
// list or the transcript body. DOM-stability invariant.
//
// Pre-fix sources of churn (per the drawer-race plan):
//   - Each successful click triggers TWO refresh() calls — one from
//     the cache callback, one from the server callback in
//     sessionDrawer.resume() (lines 549, 580 pre-fix).
//   - replaySessionMessages in main.ts:2423 ALSO calls
//     sessionDrawer.refresh(), giving up to 3 list rebuilds per click.
//   - refresh() rebuilds the entire <ul> via innerHTML='' + N
//     appendChild calls (sessionDrawer.ts:297-301), so every rebuild
//     is N+1 mutations on #sessions-list (+1 = the clear).
//
// Visible result: sidebar flicker on every click, worse on rapid
// clicks. Jonathan's 2026-04-29 session log showed alternating clicks
// at ~1-2/s producing a flicker on every cycle.
//
// Test plan:
//   1. Pre-populate 5 chats via MOCK_SETUP.
//   2. 100ms throttle on the messages endpoint so cache-cb and
//      server-cb refreshes both fall in the click window.
//   3. Install MutationObservers on #sessions-list (childList) and
//      #transcript (childList).
//   4. Click 5 distinct rows over 2 seconds (~400ms apart — normal
//      pacing, not rapid-fire).
//   5. Quiesce, then read the mutation counters.
//   6. Assert: total list-mutation count is within budget. With the
//      coalesce fix, ~1 rebuild per click = ~30 mutations across 5
//      clicks (each rebuild is 1 clear + 5 appendChilds for a 5-chat
//      drawer = 6 mutations). Pre-fix budget would be ~60+.
//   7. Click the SAME chat 5 times. Should be a no-op (resumeInFlight
//      dedup). Assert: zero or near-zero new list mutations from this
//      sub-sequence — proves the dedup actually shields refresh().

import {
  waitForReady, openSidebar, clickRow, waitForDrawerQuiet, assert,
} from './lib.mjs';

export const NAME = 'drawer-no-flicker';
export const DESCRIPTION = 'DOM stability: drawer clicks do not double-render the list';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LABELS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

export function MOCK_SETUP(mock) {
  for (let i = 0; i < LABELS.length; i++) {
    const label = LABELS[i];
    mock.addChat(`mock-chat-${label}`, {
      title: `Chat ${label}`,
      messages: [
        { role: 'user', content: `marker-${label}`, timestamp: Date.now() / 1000 - (LABELS.length - i) * 60 },
        { role: 'assistant', content: `Reply to ${label}`, timestamp: Date.now() / 1000 - (LABELS.length - i) * 60 + 1 },
      ],
      lastActiveAt: Date.now() - (LABELS.length - i) * 60_000,
    });
  }
}

async function installMutationObservers(page) {
  await page.evaluate(() => {
    /** @type {any} */ (window).__listMutations = 0;
    /** @type {any} */ (window).__transcriptMutations = 0;
    const list = document.getElementById('sessions-list');
    if (list) {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'childList') {
            /** @type {any} */ (window).__listMutations +=
              m.addedNodes.length + m.removedNodes.length;
          }
        }
      });
      obs.observe(list, { childList: true, subtree: false });
    }
    const t = document.getElementById('transcript');
    if (t) {
      const obs2 = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'childList') {
            /** @type {any} */ (window).__transcriptMutations +=
              m.addedNodes.length + m.removedNodes.length;
          }
        }
      });
      obs2.observe(t, { childList: true, subtree: false });
    }
  });
}

async function readMutationCounts(page) {
  return page.evaluate(() => ({
    list: /** @type {any} */ (window).__listMutations || 0,
    transcript: /** @type {any} */ (window).__transcriptMutations || 0,
  }));
}

async function resetMutationCounts(page) {
  await page.evaluate(() => {
    /** @type {any} */ (window).__listMutations = 0;
    /** @type {any} */ (window).__transcriptMutations = 0;
  });
}

export default async function run({ page, log, ctx }) {
  // 100ms throttle — modest. We want both cache-cb and server-cb to
  // land within a click window so both refresh() calls happen, but we
  // don't need a hard race here.
  await ctx.route('**/api/sidekick/sessions/*/messages*', async (route) => {
    await new Promise(r => setTimeout(r, 100));
    await route.continue();
  });
  log('history endpoint throttled +100ms');

  await waitForReady(page);
  await openSidebar(page);

  // Sanity: drawer has all rows.
  const chats = LABELS.map(label => ({ id: `mock-chat-${label}`, label }));
  for (const c of chats) {
    const count = await page.locator(`#sessions-list li[data-chat-id="${c.id}"]`).count();
    assert(count >= 1, `chat ${c.id} not in drawer after MOCK_SETUP`);
  }

  await installMutationObservers(page);
  await resetMutationCounts(page);

  // ── Phase 1: 5 distinct clicks at normal pacing ────────────────────
  log('phase 1: 5 distinct clicks @ 400ms apart');
  for (const c of chats) {
    await clickRow(page, c.id);
    await page.waitForTimeout(400);
  }
  await waitForDrawerQuiet(page, 600);
  const phase1 = await readMutationCounts(page);
  log(`phase 1 mutations: list=${phase1.list}, transcript=${phase1.transcript}`);

  // Each rebuild ≈ 1 clear + 5 appendChild = 6 mutations on a 5-chat
  // drawer. Pre-fix triggers cache-refresh + server-refresh + replay-
  // refresh (up to 7 per click) = ~220 mutations. Post-fix (coalesced
  // refresh + fingerprint bypass on no-op renders): ~50 mutations,
  // about 1 rebuild per click. Budget at 60 catches the pre-fix path
  // (any regression from 50ish back to 100+ is a real flicker
  // regression) while leaving slack for legitimate header churn.
  const PHASE1_BUDGET = 60;
  assert(
    phase1.list <= PHASE1_BUDGET,
    `phase 1 list mutations ${phase1.list} > budget ${PHASE1_BUDGET}. ` +
    `Each click is rebuilding the drawer 2-3x — refresh() is not being coalesced.`,
  );

  // Transcript: each chat-switch should produce one clear + N appends
  // (N = message count). We render 2 messages per chat × 5 chats = 10
  // additions. Plus 5 clears (one per switch) = 15 mutations. Pre-fix
  // double-render of transcript would push that to 30+. Budget at 25.
  const PHASE1_TRANSCRIPT_BUDGET = 25;
  assert(
    phase1.transcript <= PHASE1_TRANSCRIPT_BUDGET,
    `phase 1 transcript mutations ${phase1.transcript} > budget ${PHASE1_TRANSCRIPT_BUDGET}. ` +
    `Either onResumeCb fires twice per click (cache + server unchanged-content) ` +
    `or replaySessionMessages renders the same content twice.`,
  );

  // ── Phase 2: same chat clicked 5 times — should be a no-op ─────────
  await resetMutationCounts(page);
  const sameTarget = chats[2]; // arbitrary mid-list chat
  log(`phase 2: 5 identical clicks on ${sameTarget.label}`);
  for (let i = 0; i < 5; i++) {
    await clickRow(page, sameTarget.id);
    await page.waitForTimeout(150);
  }
  await waitForDrawerQuiet(page, 600);
  const phase2 = await readMutationCounts(page);
  log(`phase 2 mutations: list=${phase2.list}, transcript=${phase2.transcript}`);

  // First click might do work if we're switching from a different chat
  // (we just clicked epsilon last in phase 1, so clicking gamma here
  // is a real switch). The other 4 clicks should be dedup'd. Budget
  // at 12 = 1 real switch (~6 mutations) + slack.
  const PHASE2_BUDGET = 12;
  assert(
    phase2.list <= PHASE2_BUDGET,
    `phase 2 list mutations ${phase2.list} > budget ${PHASE2_BUDGET}. ` +
    `Clicking the same row 5x should dedup to ≤1 real switch — ` +
    `resumeInFlight isn't shielding subsequent clicks.`,
  );
  // Transcript: one switch = 1 clear + 2 appends = 3 mutations. Budget 8.
  const PHASE2_TRANSCRIPT_BUDGET = 8;
  assert(
    phase2.transcript <= PHASE2_TRANSCRIPT_BUDGET,
    `phase 2 transcript mutations ${phase2.transcript} > budget ${PHASE2_TRANSCRIPT_BUDGET}. ` +
    `Same-row clicks are re-rendering the transcript.`,
  );

  log(`✓ both phases within DOM-stability budgets`);
}
