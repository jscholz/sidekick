// UX_DETERMINISM_PLAN.md Phase 1 item 4 — placeholder-key anchors.
//
// Field bug (2026-09-05, UX_DETERMINISM_PLAN.md §1): boot's pin/activity
// prewarm issued `GET .../items?limit=40&around=pending:turn:umsg_…` —
// a saved anchor / pinned message keyed by a client-only SYNTHETIC id
// (the local thinking placeholder). The server has no such row, so the
// fetch came back empty. projection.ts's own comments record a sibling:
// "mark-unread wrote an activity row keyed pending:turn:*".
//
// src/transcript/keys.ts's isDurableMessageKey() is the fix: every write
// site that could persist a bubble's `data-key` as a message id (scroll
// anchors, pins, activity/mark-unread) now refuses a synthetic key, and
// every read site that could turn a persisted key into a network
// `?around=` fetch (fetchAroundWindowOnce — shared by drillViaAroundWindow,
// prewarmPinnedWindows, prewarmActivityWindows) skips the round trip for
// one that slips through anyway (a pin created before this fix shipped,
// or synced from another device that hasn't updated).
//
// Two parts:
//   A. WRITE guard — chat.ts's getDomAnchor() must not return a synthetic
//      key even when the first-visible row IS one (the thinking-dots
//      placeholder, or the bottom turn-status line).
//   B. READ guard — a pin seeded server-side (simulating a pre-fix /
//      cross-device legacy pin) with a synthetic msgId must never
//      trigger a `?around=<that key>` request, while a NORMAL pin in the
//      same boot still prewarms normally (the guard is targeted, not a
//      blanket break of #243's prewarm).

import { waitForReady, openSidebar, clickRow, clickNewChat, send, pollUntil, assert } from './lib.mjs';

export const NAME = 'anchor-key-hygiene';
export const DESCRIPTION = 'Synthetic bubble keys (pending:turn:…, turn:status, …) are never persisted as a scroll anchor / pin target, and a legacy one already persisted never triggers an ?around= fetch';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-anchor-hygiene-chat';
const TOTAL_MSGS = 20;
const REAL_PIN_IDX = 3;
const realPinMsg = `ahy-msg-${REAL_PIN_IDX}`;
// Exactly the shape the field bug hit: a client-minted user key wrapped
// in the local thinking-placeholder prefix (projection.ts step 5).
const BAD_PIN_KEY = 'pending:turn:umsg_1747000000000_legacy01';

export function MOCK_SETUP(mock) {
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `ahy-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Anchor key hygiene',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
  // A NORMAL pin — control, proves the guard doesn't break real prewarm.
  mock.seedPin(CHAT_ID, realPinMsg, {
    role: 'user', text: `user marker ${REAL_PIN_IDX}`,
    timestamp: Date.now(), pinnedAt: Date.now() - 5000,
  });
  // The LEGACY bad pin — server-seeded (mock.seedPin bypasses the app's
  // own pinMessage(), which now refuses this key — see src/pins/store.ts
  // — so this simulates a pin that was created before that guard existed,
  // or synced from a device running the old build).
  mock.seedPin(CHAT_ID, BAD_PIN_KEY, {
    role: 'assistant', text: '',
    timestamp: Date.now(), pinnedAt: Date.now(),
  });
}

function parseMessagesAroundReq(url) {
  const m = /\/sessions\/([^/]+)\/messages\?/.exec(url);
  if (!m) return null;
  const u = new URL(url);
  const around = u.searchParams.get('around');
  if (around == null) return null;
  return { chatId: decodeURIComponent(m[1]), around };
}

export default async function run({ page, log, mock }) {
  // Track every ?around= request from the moment the page starts loading —
  // the boot-time prewarm (main.ts, `void prewarmPinnedWindows()`) can fire
  // before any of our post-load polling starts.
  const aroundRequests = [];
  page.on('request', (req) => {
    const info = parseMessagesAroundReq(req.url());
    if (info) aroundRequests.push(info);
  });

  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForTimeout(500);

  // ── B. READ guard — control pin prewarms; the bad pin's window never
  // gets fetched or cached, and its key never appears in a request.
  await pollUntil(page,
    async ({ c, m }) => {
      const wc = await import('/build/drillWindowCache.mjs');
      const rec = await wc.getWindow(c, m);
      return !!rec && rec.messages.length > 0;
    },
    { c: CHAT_ID, m: realPinMsg },
    { timeout: 8_000, polling: 150, label: `control pin ${realPinMsg} never prewarmed — prewarm itself must be unaffected by the guard` });
  log(`control pin prewarmed normally: ${realPinMsg} ✓`);

  // Give the (nonexistent) fetch for the bad key every chance it would
  // have had — same budget as the control's poll above.
  await page.waitForTimeout(500);

  const badKeyCached = await page.evaluate(async ({ c, m }) => {
    const wc = await import('/build/drillWindowCache.mjs');
    const rec = await wc.getWindow(c, m);
    return !!rec;
  }, { c: CHAT_ID, m: BAD_PIN_KEY });
  assert(!badKeyCached, `BUG: the synthetic-keyed pin's window got cached — fetchAroundWindowOnce should have skipped it entirely`);

  const badRequests = aroundRequests.filter((r) => r.around === BAD_PIN_KEY);
  assert(badRequests.length === 0,
    `BUG: ${badRequests.length} request(s) issued with around=${BAD_PIN_KEY} — a synthetic key must never reach the server (field 2026-09-05)`);
  log(`no ?around=${BAD_PIN_KEY} request was ever issued (${aroundRequests.length} around-requests total, all for real keys) ✓`);

  // ── A. WRITE guard — getDomAnchor() must skip a synthetic first-visible
  // row. Force the pending-placeholder AND the turn-status line to be the
  // ONLY conversational row on screen (mock held silent), scroll each to
  // the very top of the transcript viewport, and confirm getDomAnchor()
  // never returns their key.
  mock.setAutoReplyEnabled(false);
  mock.setSuppressUserMessageBroadcast(true);

  // A1: thinking-dots placeholder (agent has already spoken in this chat,
  // so the first-turn gate — projection.ts step 5 — doesn't suppress it).
  await send(page, 'anchor hygiene probe 1');
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line.agent.streaming[data-key^="pending:turn:"]'),
    null, { timeout: 4000, polling: 50 });
  const placeholderAnchor = await page.evaluate(async () => {
    const t = document.getElementById('transcript');
    const row = t.querySelector('.line[data-key^="pending:turn:"]');
    row.scrollIntoView({ block: 'start', inline: 'nearest' });
    const chat = await import('/build/chat.mjs');
    const keys = await import('/build/transcript/keys.mjs');
    const anchor = chat.getDomAnchor();
    return {
      rowKey: row.getAttribute('data-key'),
      anchor,
      anchorIsDurable: anchor ? keys.isDurableMessageKey(anchor.key) : null,
    };
  });
  log(`placeholder row=${placeholderAnchor.rowKey} getDomAnchor()=${JSON.stringify(placeholderAnchor.anchor)}`);
  assert(!placeholderAnchor.anchor || placeholderAnchor.anchor.key !== placeholderAnchor.rowKey,
    `BUG: getDomAnchor() captured the synthetic thinking-placeholder key ${placeholderAnchor.rowKey} — it must skip to the next durable row or return null`);
  if (placeholderAnchor.anchor) {
    assert(placeholderAnchor.anchorIsDurable,
      `BUG: getDomAnchor() returned a non-null anchor (${placeholderAnchor.anchor.key}) that isDurableMessageKey rejects`);
  }
  log('getDomAnchor() never anchors on the thinking-placeholder row ✓');

  // A2: bottom turn-status line, alone (fresh chat — first-turn gate
  // suppresses the placeholder, so `turn:status` is the only synthetic
  // row and, being the sole conversational row, is trivially first-visible).
  await clickNewChat(page);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('New chat started'),
    null, { timeout: 5000, polling: 50 });
  await send(page, 'anchor hygiene probe 2 (fresh chat)');
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line.turn-status[data-key="turn:status"]'),
    null, { timeout: 4000, polling: 50 });
  const statusAnchor = await page.evaluate(async () => {
    const t = document.getElementById('transcript');
    const row = t.querySelector('.line[data-key="turn:status"]');
    row.scrollIntoView({ block: 'start', inline: 'nearest' });
    const chat = await import('/build/chat.mjs');
    const keys = await import('/build/transcript/keys.mjs');
    const anchor = chat.getDomAnchor();
    return {
      rowKey: row.getAttribute('data-key'),
      anchor,
      anchorIsDurable: anchor ? keys.isDurableMessageKey(anchor.key) : null,
    };
  });
  log(`turn-status row=${statusAnchor.rowKey} getDomAnchor()=${JSON.stringify(statusAnchor.anchor)}`);
  assert(!statusAnchor.anchor || statusAnchor.anchor.key !== 'turn:status',
    `BUG: getDomAnchor() captured the synthetic turn:status key — it must skip to the next durable row or return null`);
  if (statusAnchor.anchor) {
    assert(statusAnchor.anchorIsDurable,
      `BUG: getDomAnchor() returned a non-null anchor (${statusAnchor.anchor.key}) that isDurableMessageKey rejects`);
  }
  log('getDomAnchor() never anchors on the turn-status row ✓');

  // Transcript still restores sensibly: switch away and back to the probed
  // chat, and confirm the real message history is intact and visible —
  // the guard must degrade gracefully (scrollTop-only save), never break
  // the ordinary session-switch restore.
  //
  // TOTAL_MSGS=20 alternates user/assistant starting at idx=1 (user), so
  // the LAST message (idx=20) is the assistant's "agent reply 20" — the
  // durable tail-most row a correct restore must still surface.
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('agent reply 20'),
    null, { timeout: 5000, polling: 50 },
  ).catch(() => {});
  const stillThere = await page.evaluate(() =>
    (document.getElementById('transcript')?.textContent || '').includes('agent reply 20'));
  assert(stillThere, `switching back to ${CHAT_ID} lost real transcript content — the guard broke ordinary restore`);
  log('ordinary session-switch restore is unaffected ✓');
}
