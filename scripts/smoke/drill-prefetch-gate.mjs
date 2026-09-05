// Deep-jump perf invariants. Codifies the four fixes that killed the multi-second
// same-session drill stalls, using only synthetic chats + the mock's
// per-chat artificial /messages delay (mock.setMessageDelay) as a stand-in
// for a slow network — the behavioral equivalent of Chrome DevTools'
// network throttling:
//
//   (a) warm prefetch fetches a TINY page (?limit=12), never the full page.
//   (b) warm prefetch never STARTS a fetch while a user-initiated read
//       (resume / around-drill) is in flight — the foreground gate. (An
//       already-in-flight prefetch may finish; (a) makes that negligible.)
//   (c) a deep drill issues a single bounded window (?around=...&limit=40).
//   (d) no ?before=/?after= pagination fires within the post-drill suppress
//       window (the drill's own render-scroll must not auto-walk).
//
// Setup: 8 "background" chats (the prefetch top-8) plus one OLDER "deep"
// chat (out of the prefetch set) that we drill into. Background fetches are
// slowed so the prefetch walk outlasts the drill; the deep chat is slowed
// more so its foreground reads are unambiguously in-flight while prefetch
// wants to run.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drill-prefetch-gate';
export const DESCRIPTION = 'warm prefetch uses a tiny page + defers to in-flight drills; deep drill is one bounded window with no post-drill walk';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const DEEP_CHAT = 'gate-deep-chat';
const BG_COUNT = 8;                 // == PREFETCH_TOP_N
const BG_DELAY_MS = 400;            // per background /messages fetch
const DEEP_DELAY_MS = 600;          // per deep-chat /messages fetch
const TOTAL_MSGS = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;                 // far older than the newest 30 → floating window

function bgId(i) { return `gate-bg-${i}`; }

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);

  // Background chats: more recent than the deep chat → they fill the
  // prefetch top-8; the deep chat sorts last and is never prefetched.
  for (let i = 1; i <= BG_COUNT; i++) {
    const msgs = [];
    for (let j = 1; j <= 6; j++) {
      const role = j % 2 === 1 ? 'user' : 'assistant';
      msgs.push({
        role,
        content: `bg ${i} msg ${j}`,
        parley_id: `bg-${i}-msg-${j}`,
        timestamp: Date.now() / 1000 - (6 - j) * 60,
      });
    }
    mock.addChat(bgId(i), {
      title: `Background ${i}`,
      source: 'parley',
      messages: msgs,
      lastActiveAt: Date.now() - i * 1000,
    });
    mock.setMessageDelay(bgId(i), BG_DELAY_MS);
  }

  const deepMsgs = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    deepMsgs.push({
      role,
      content: role === 'user' ? `deep user ${idx}` : `deep agent ${idx}`,
      parley_id: `deep-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(DEEP_CHAT, {
    title: 'Deep chat',
    source: 'parley',
    messages: deepMsgs,
    lastActiveAt: Date.now() - 10 * 60_000,  // oldest → outside prefetch top-8
  });
  mock.setMessageDelay(DEEP_CHAT, DEEP_DELAY_MS);
}

async function seedPin(page, chatId, idx, role) {
  await page.evaluate(({ chatId, msgId, role }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role, text: `deep ${role} pin`, timestamp: Date.now(),
    }));
  }, { chatId, msgId: `deep-msg-${idx}`, role });
}

async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`);
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
}

async function clickPinForMsg(page, msgId) {
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    li?.querySelector('.pin-item-jump-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, msgId);
}

// Classify a /messages request and parse its cursor/limit params.
function parseMessagesReq(url) {
  const m = /\/sessions\/([^/]+)\/messages/.exec(url);
  if (!m) return null;
  const chatId = decodeURIComponent(m[1]);
  const u = new URL(url);
  const limitRaw = u.searchParams.get('limit');
  const limit = limitRaw == null ? null : parseInt(limitRaw, 10);
  const around = u.searchParams.get('around');
  const before = u.searchParams.get('before');
  const after = u.searchParams.get('after');
  // Prefetch is uniquely identified by ?limit=12 (warmPrefetch's tiny page);
  // a plain first-page resume sends no limit (or the full page). The app
  // auto-opens the newest chat at boot, so don't key resume off the chat id.
  let kind;
  if (around != null) kind = 'drill';
  else if (before != null) kind = 'before';
  else if (after != null) kind = 'after';
  else if (limit === 12) kind = 'prefetch';
  else kind = 'resume';
  return { chatId, limit, around, before, after, kind };
}

export default async function run({ page, log }) {
  // Record start/end of every /messages request.
  const events = [];
  const pending = new Map();
  const onReq = (req) => {
    const info = parseMessagesReq(req.url());
    if (!info) return;
    const rec = { ...info, url: req.url(), start: Date.now(), end: null };
    pending.set(req, rec);
    events.push(rec);
  };
  const onDone = (req) => {
    const rec = pending.get(req);
    if (rec) { rec.end = Date.now(); pending.delete(req); }
  };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  await waitForReady(page);

  // Open the deep chat and let its (delayed) resume settle so it's the
  // viewed session before we drill — the warm-prefetch walk (slowed to
  // ~300ms/item) is still in flight throughout.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${DEEP_CHAT}"]`, { state: 'attached', timeout: 10_000 });
  await openChat(page, DEEP_CHAT);
  await page.waitForTimeout(900);
  await seedPin(page, DEEP_CHAT, DEEP_IDX, 'user');
  await page.waitForTimeout(200);
  await openPinDrawer(page);

  const deepMsg = `deep-msg-${DEEP_IDX}`;
  await clickPinForMsg(page, deepMsg);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg,
    { timeout: 10_000, polling: 60 },
  );

  // Wait until the prefetch walk has clearly progressed past the drill, so
  // the gate's "deferred past the drill" signal is present (non-vacuous).
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const prefetchDone = events.filter((e) => e.kind === 'prefetch' && e.end != null).length;
    if (prefetchDone >= BG_COUNT) break;
    await page.waitForTimeout(150);
  }
  // Let the suppress window (1200ms) fully elapse so a violating before/after
  // walk, if any, would have fired and been recorded.
  await page.waitForTimeout(400);

  page.off('request', onReq);
  page.off('requestfinished', onDone);
  page.off('requestfailed', onDone);

  const drills = events.filter((e) => e.kind === 'drill');
  const prefetches = events.filter((e) => e.kind === 'prefetch');
  // The gate is about user-initiated reads of the chat we're drilling — the
  // deep chat's first-page resume + the around drill. (The boot auto-open of
  // the newest chat is incidental and excluded to keep the assertion stable.)
  const foregrounds = events.filter((e) =>
    e.kind === 'drill' || (e.kind === 'resume' && e.chatId === DEEP_CHAT));

  log(`requests: drill=${drills.length} prefetch=${prefetches.length} deep-resume=${foregrounds.length - drills.length}`);

  // (c) the deep drill is exactly one bounded ?around=&limit=40 window.
  assert(drills.length === 1, `expected exactly one ?around= drill, got ${drills.length}`);
  assert(drills[0].limit === 40, `drill window must use limit=40, got ${drills[0].limit}`);
  log(`(c) deep drill = one ?around=&limit=40 window ✓`);

  // (a) every warm-prefetch fetch uses the tiny ?limit=12 page. We expect the
  // prefetch to cover ~all of the top-8 background chats; a reverted Fix 4
  // would emit full-page fetches (no ?limit=12), classified as 'resume', and
  // collapse this count toward 0 — so the floor is a real regression guard.
  assert(prefetches.length >= BG_COUNT - 1,
    `expected the warm prefetch to fetch ~all ${BG_COUNT} background sessions with ?limit=12, got ${prefetches.length}`);
  for (const p of prefetches) {
    assert(p.limit === 12, `prefetch ${p.chatId} must use limit=12 (tiny page), got limit=${p.limit}`);
  }
  log(`(a) all ${prefetches.length} warm-prefetch fetches use ?limit=12 ✓`);

  // (b) GATE: no prefetch STARTS while a foreground read is in flight.
  for (const p of prefetches) {
    for (const f of foregrounds) {
      const fEnd = f.end ?? Infinity;
      // Half-open [start, end): the gate releases prefetch the moment the
      // foreground read completes, and both stamps are whole ms from the
      // same clock — a prefetch that starts in the SAME ms the foreground
      // ended is "after", not "during". The inclusive form flaked ~1 in 3
      // on both a pre-change and post-change tree (2026-09-05), always
      // with p.start === fEnd. Matches the `>= drillEnd` deferral check
      // below, which already counts a same-ms start as deferred.
      const startedDuringForeground = p.start >= f.start && p.start < fEnd;
      assert(!startedDuringForeground,
        `gate violated: prefetch ${p.chatId} started at +${p.start} during foreground ${f.kind} [${f.start}..${fEnd}]`);
    }
  }
  // Non-vacuous: the drill must have actually held prefetch work back —
  // at least one prefetch started only AFTER the drill fetch completed.
  const drillEnd = drills[0].end ?? Infinity;
  const deferred = prefetches.filter((p) => p.start >= drillEnd).length;
  assert(deferred >= 1,
    `gate test is vacuous: no prefetch was deferred past the drill (drillEnd=${drillEnd}, prefetch starts=${prefetches.map((p) => p.start).join(',')})`);
  log(`(b) no prefetch started during a foreground read; ${deferred} deferred past the drill ✓`);

  // (d) no ?before=/?after= walk within the post-drill suppress window.
  const drillStart = drills[0].start;
  const suppressEnd = (drills[0].end ?? drillStart) + 1200;
  const walks = events.filter((e) =>
    (e.kind === 'before' || e.kind === 'after') &&
    e.chatId === DEEP_CHAT &&
    e.start >= drillStart && e.start <= suppressEnd);
  assert(walks.length === 0,
    `post-drill suppress window must block lazy-load walks, saw ${walks.length}: ${walks.map((w) => w.kind).join(',')}`);
  log(`(d) no ?before=/?after= walk within the post-drill suppress window ✓`);

  log('deep-jump perf invariants hold (tiny prefetch + gate + bounded window + suppress) ✓');
}
