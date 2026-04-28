// Scenario: clicking a session in the sidebar switches the chat view
// reliably. Catches "click sometimes doesn't switch / switches and
// switches back ~0.2s later" reported 2026-04-28.
//
// Test plan:
//   1. Send marker "marker-a" in chat A.
//   2. New-chat → send marker "marker-b" in chat B.
//   3. Click chat A's drawer entry; assert transcript shows
//      "marker-a" and NOT "marker-b" within reasonable time.
//   4. After 1s settle, re-assert (catches the bounce-back case
//      where switch happens then reverts ~200ms later).
//   5. Click chat B's drawer entry; assert transcript shows
//      "marker-b" and NOT "marker-a".
//   6. Rapid alternation: click A → B → A → B → A in quick
//      succession (50ms apart). After settle, assert transcript
//      ends on "marker-a" (last click target wins).
//
// The chat content is the user-visible signal — using DOM transcript
// text rather than poking into JS state keeps the test honest about
// what the user actually sees.

import { waitForReady, openSidebar, clickNewChat, send, SEL, assert } from './lib.mjs';

export const NAME = 'drawer-switch';
export const DESCRIPTION = 'Drawer click reliably switches chat view (no bounce-back, no missed click)';
export const STATUS = 'implemented';

const MARKER_A = 'marker-alpha-distinct-12345';
const MARKER_B = 'marker-beta-distinct-67890';

/** Wait until the transcript contains `expect` and does NOT contain
 *  `forbid`. Times out with a useful diagnostic. */
async function waitForTranscript(page, expect, forbid, timeout = 10_000) {
  await page.waitForFunction(
    ({ exp, forbid }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(exp) && !t.includes(forbid);
    },
    { exp: expect, forbid },
    { timeout, polling: 100 },
  );
}

/** Snapshot the transcript text. */
async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

/** Click the drawer row matching `chatId` (set as li.dataset.chatId). */
async function clickRow(page, chatId) {
  const locator = page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`);
  await locator.first().click();
}

/** Capture the chat_id minted by the PWA's new-chat flow by watching
 *  the dbg console line `hermes-gateway: new session (chat_id=…)`.
 *  Returns a Promise that resolves with the latest chat_id seen. */
function captureNextChatId(page) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('new-session log not seen in 5s')), 5000);
    const handler = (msg) => {
      const m = /new session \(chat_id=([0-9a-f-]+)\)/.exec(msg.text());
      if (m) {
        clearTimeout(t);
        page.off('console', handler);
        resolve(m[1]);
      }
    };
    page.on('console', handler);
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Capture chat_ids by listening to the adapter's new-session debug
  // log — drawer rows aren't reliably identifiable by visible text
  // (titles arrive late + snippets may be empty), so we target by
  // the chat_id exposed via li.dataset.chatId.
  log('setting up chat A');
  const aIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatAId = await aIdP;
  log(`chat A id = ${chatAId}`);
  await send(page, MARKER_A);
  await page.waitForSelector(SEL.agentFinal, { timeout: 60_000 });
  await page.waitForTimeout(400);

  log('setting up chat B');
  const bIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatBId = await bIdP;
  log(`chat B id = ${chatBId}`);
  await send(page, MARKER_B);
  await page.waitForSelector(SEL.agentFinal, { timeout: 60_000 });
  await page.waitForTimeout(400);

  // Sanity: both chat rows should be present in the drawer.
  const aRows = await page.locator(`#sessions-list li[data-chat-id="${chatAId}"]`).count();
  const bRows = await page.locator(`#sessions-list li[data-chat-id="${chatBId}"]`).count();
  log(`drawer rows: A=${aRows} B=${bRows}`);
  assert(aRows >= 1, `chat A (${chatAId}) row not in drawer`);
  assert(bRows >= 1, `chat B (${chatBId}) row not in drawer`);

  // ── Single switch: click A ───────────────────────────────────────
  log('clicking chat A');
  await clickRow(page, chatAId);

  // The click handler synchronously flips the active class on the
  // clicked row. If that didn't happen, the click event never reached
  // the body element (locator wrong / drawer collapsed / element
  // off-screen).
  await page.waitForTimeout(100);
  const activeAfterClick = await page.evaluate(() => {
    const active = document.querySelector('#sessions-list li.active');
    return active ? active.dataset.chatId : null;
  });
  log(`drawer active after click: ${activeAfterClick}`);
  assert(activeAfterClick === chatAId,
    `click handler didn't flip active class: expected ${chatAId}, got ${activeAfterClick}`);

  try {
    await waitForTranscript(page, MARKER_A, MARKER_B);
  } catch (e) {
    const t = (await transcriptText(page)).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`switch to A failed: transcript snapshot ${JSON.stringify(t)}`);
  }
  log('switched to A ✓');

  // Bounce-back guard: after 1s, transcript should STILL show A.
  await page.waitForTimeout(1000);
  {
    const t = await transcriptText(page);
    assert(
      t.includes(MARKER_A) && !t.includes(MARKER_B),
      `bounced back from A to B within 1s: snapshot ${JSON.stringify(t.slice(0, 200))}`,
    );
  }
  log('A held for 1s ✓');

  // ── Switch B ─────────────────────────────────────────────────────
  log('clicking chat B');
  await clickRow(page, chatBId);
  try {
    await waitForTranscript(page, MARKER_B, MARKER_A);
  } catch {
    const t = (await transcriptText(page)).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`switch to B failed: transcript snapshot ${JSON.stringify(t)}`);
  }
  await page.waitForTimeout(1000);
  {
    const t = await transcriptText(page);
    assert(
      t.includes(MARKER_B) && !t.includes(MARKER_A),
      `bounced back from B to A within 1s: ${JSON.stringify(t.slice(0, 200))}`,
    );
  }
  log('switched to B and held ✓');

  // ── Rapid alternation A → B → A → B → A ──────────────────────────
  log('rapid alternation A→B→A→B→A');
  for (const id of [chatAId, chatBId, chatAId, chatBId, chatAId]) {
    await clickRow(page, id);
    await page.waitForTimeout(50);
  }
  // Last click was A. After settle, transcript should show A.
  await page.waitForTimeout(2_000);
  {
    const t = await transcriptText(page);
    assert(
      t.includes(MARKER_A) && !t.includes(MARKER_B),
      `rapid alternation final state wrong (expected A): ${JSON.stringify(t.slice(0, 200))}`,
    );
  }
  log('rapid alternation settled on A ✓');
}
