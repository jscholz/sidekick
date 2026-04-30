// Scenario: under rapid-fire clicks (< 100ms apart) across N chats,
// the drawer-active-row and the transcript body MUST agree. Same chat,
// every step, every settle.
//
// This is the strict 1:1 invariant test that drawer-switch.mjs
// deliberately punted on (its lines 174-181 call out the rapid-fire
// race and skip exercising it). Jonathan's normal clicking exposes the
// race in production: stale `onResumeCb` callbacks fire AFTER newer
// clicks because `resumeInFlight` was keyed by id only — different-id
// concurrent resumes both run to completion, last-one-wins by
// completion order rather than click order.
//
// Failure mode this test catches:
//   - drawer highlights chat B, transcript renders chat A
//   - drawer flips through clicks but transcript shows a stale chat
//   - "(N messages, hasMore=…)" log lines outnumber actual click count
//     (each superseded server callback fires its log even when the
//      render itself was correctly skipped)
//
// Test plan:
//   1. Pre-populate 8 chats with distinct markers via MOCK_SETUP.
//   2. Throttle the messages endpoint by 200ms — forces cache-cb and
//      server-cb callbacks to overlap, opening the race window. On
//      localhost without throttling the race never manifests.
//   3. Click 12 rows in rapid sequence (75ms between clicks, NO
//      assertSwitched between them). Capture `{activeId, transcript}`
//      after each click.
//   4. Quiesce: wait for /messages requests to go quiet for 800ms.
//   5. Final-state asserts: transcript == LAST clicked, drawer == LAST
//      clicked, no other chat's marker leaks into the transcript.
//   6. Per-step 1:1 asserts: every captured snapshot must agree —
//      drawer activeId points to chat X iff transcript has marker-X.
//      A snapshot showing "active=B, transcript-only-has-marker-A" is
//      the bug we're hunting.
//   7. Negative log assertion: count "sessionDrawer: resumed <id> (N
//      messages, hasMore=…)" log lines (note the absence of "from
//      cache"). Should be ≤ click-count post-fix; pre-fix fires extras
//      per superseded callback.

import {
  waitForReady, openSidebar, attachConsoleCapture, clickRow,
  waitForDrawerQuiet, getDrawerSnapshot, assert,
} from './lib.mjs';

export const NAME = 'drawer-rapid-switch';
export const DESCRIPTION = '1:1 invariant under rapid-fire clicks (race regression)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LABELS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];

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

/** Build a 12-click sequence that avoids same-id-twice-in-a-row (which
 *  would be dedup'd by resumeInFlight and not exercise the cross-id
 *  race), and includes at least one A→B→A oscillation (the canonical
 *  three-promise race scenario from the plan). */
function buildRapidSequence(chats) {
  // Hard-coded sequence rather than random so failures are reproducible.
  // Mix of local oscillations and long jumps; each chat appears at least
  // once. 12 entries.
  const idxs = [0, 2, 4, 6, 1, 0, 7, 3, 0, 5, 7, 0];
  return idxs.map(i => chats[i]);
}

export default async function run({ page, log, ctx }) {
  // 200ms throttle on the messages endpoint forces the race window
  // open. Without this, both cache-cb and server-cb resolve in <10ms
  // and stale callbacks land before they can be superseded.
  await ctx.route('**/api/sidekick/sessions/*/messages*', async (route) => {
    await new Promise(r => setTimeout(r, 200));
    await route.continue();
  });
  log('history endpoint throttled +200ms');

  const tail = attachConsoleCapture(page, 500);

  await waitForReady(page);
  await openSidebar(page);

  const chats = LABELS.map(label => ({
    id: `mock-chat-${label}`,
    marker: `marker-${label}`,
    label,
  }));
  for (const c of chats) {
    const count = await page.locator(`#sessions-list li[data-chat-id="${c.id}"]`).count();
    assert(count >= 1, `chat ${c.id} not in drawer after MOCK_SETUP`);
  }

  const allMarkers = chats.map(c => c.marker);
  const sequence = buildRapidSequence(chats);
  log(`rapid sequence: ${sequence.map(c => c.label).join(' → ')}`);

  // Per-step snapshot trace — captured immediately after each click,
  // before the next click fires. The OPTIMISTIC class flip in the
  // click handler should already make activeId == clicked id.
  const trace = [];
  for (let i = 0; i < sequence.length; i++) {
    const target = sequence[i];
    await clickRow(page, target.id);
    // Don't await async work between clicks — that's the whole point.
    // 75ms is faster than the 200ms server throttle so callbacks WILL
    // overlap.
    await page.waitForTimeout(75);
    const snap = await getDrawerSnapshot(page, allMarkers);
    trace.push({ idx: i, target, snap });
  }

  // Quiesce — let all in-flight /messages requests settle so we're
  // asserting against final reconciled state, not mid-transit.
  await waitForDrawerQuiet(page, 800);

  const last = sequence[sequence.length - 1];
  const finalSnap = await getDrawerSnapshot(page, allMarkers);
  log(`final: active=${finalSnap.activeId}, markers=${finalSnap.transcriptMarkers.join(',')}`);

  // ── Final-state asserts ────────────────────────────────────────────
  assert(
    finalSnap.activeId === last.id,
    `final drawer activeId mismatch: expected ${last.id}, got ${finalSnap.activeId}`,
  );
  assert(
    finalSnap.transcriptMarkers.length === 1 && finalSnap.transcriptMarkers[0] === last.marker,
    `final transcript should contain only ${last.marker}, got [${finalSnap.transcriptMarkers.join(',')}] — ` +
    `transcript=${JSON.stringify(finalSnap.transcriptText)}`,
  );

  // ── Per-step 1:1 invariant ─────────────────────────────────────────
  // The drawer's activeId at snapshot time must point at SOME chat in
  // the sequence so far (typically the just-clicked one), and whatever
  // markers the transcript contains must be a SUBSET of {that chat's
  // marker}. The mismatch we're hunting is "active=X, transcript shows
  // marker-Y where Y != X" — that means a stale callback won.
  const violations = [];
  for (const { idx, target, snap } of trace) {
    if (snap.transcriptMarkers.length === 0) continue; // empty/clearing — fine
    if (snap.transcriptMarkers.length > 1) {
      violations.push(
        `step[${idx}] (clicked ${target.label}): transcript has multiple markers ` +
        `[${snap.transcriptMarkers.join(',')}] — chat.clear() didn't run between resumes`,
      );
      continue;
    }
    const sole = snap.transcriptMarkers[0];
    // active is whatever the click handler painted (sync), transcript is
    // whatever resume() rendered (async). Both must point to the same chat.
    if (snap.activeId) {
      const expectedMarker = `marker-${snap.activeId.replace(/^mock-chat-/, '')}`;
      if (sole !== expectedMarker) {
        violations.push(
          `step[${idx}] (clicked ${target.label}): active=${snap.activeId} ` +
          `but transcript shows ${sole}`,
        );
      }
    }
  }
  if (violations.length) {
    throw new Error(`1:1 invariant violated:\n  ${violations.join('\n  ')}`);
  }
  log(`per-step 1:1 invariant OK across ${trace.length} clicks`);

  // ── Negative log assertion ─────────────────────────────────────────
  // Each click should produce AT MOST one "(N messages, hasMore=…)" log
  // — that's the path that actually rendered the server result. The pre-
  // fix code logs that line for every server fetch that completed, even
  // when its onResumeCb was superseded and skipped. Use 1.5x click-count
  // as a generous slack for cache-mismatch (chat with content drift)
  // legitimate re-renders.
  const lines = tail(500);
  const renderLogs = lines.filter(l => /sessionDrawer: resumed [^ ]+ \(\d+ messages, hasMore=/.test(l));
  const budget = Math.ceil(sequence.length * 1.5);
  assert(
    renderLogs.length <= budget,
    `too many "resumed (N messages)" logs: got ${renderLogs.length}, budget ${budget} for ${sequence.length} clicks. ` +
    `Either we have stale callbacks logging past their supersede, or many cache-misses fired full re-renders. ` +
    `Sample: ${renderLogs.slice(-3).join(' | ')}`,
  );
  log(`render-log count ${renderLogs.length} ≤ ${budget} ✓`);
}
