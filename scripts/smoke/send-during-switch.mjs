// Invariant #3 of the hardening proposal: "sends are addressed, not
// pointed" — a send committed while a switch is still in flight must
// land in the chat the user is LOOKING AT (the clicked target), never
// the chat they just left. This is the /approve-into-wrong-session
// class (field bug 2026-06-12): sendMessage historically read a
// module-global pointer that a racing continuation could leave stale.
//
// Cell shape: viewing A → click B (history held open via
// setMessageDelay) → type + send while the fetch is pending. Assert
// server-side (mock chat store) that the message landed in B, not A,
// and that the user bubble renders in B once its history lands.

import { waitForReady, openSidebar, clickRow, send, waitForDrawerQuiet, assert } from './lib.mjs';

export const NAME = 'send-during-switch';
export const DESCRIPTION = 'Send committed mid-switch routes to the clicked/on-screen chat, never the one just left';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-sds-chat-a';
const CHAT_B = 'mock-sds-chat-b';
const MARKER = 'SDS-MIDFLIGHT-SEND';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'SDS A',
    messages: [{ role: 'user', content: 'SDS-A-SEED', parley_id: 'umsg_sds_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'SDS B',
    messages: [{ role: 'user', content: 'SDS-B-SEED', parley_id: 'umsg_sds_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SDS-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  log('viewing A');

  // Hold B's history open, click B, and send while the fetch is
  // pending. The user is looking at B (optimistic switch) — the send
  // is addressed to B.
  mock.setMessageDelay(CHAT_B, 2500);
  await clickRow(page, CHAT_B);
  await new Promise((r) => setTimeout(r, 250));   // switch armed, fetch pending
  await send(page, MARKER);
  log('send committed while B history fetch still in flight');

  // Server-side routing assert — the authoritative check.
  await page.waitForFunction(() => true, null, { timeout: 100 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const inA = mock.getChat(CHAT_A)?.messages.some((m) => (m.content || '').includes(MARKER)) ?? false;
  const inB = mock.getChat(CHAT_B)?.messages.some((m) => (m.content || '').includes(MARKER)) ?? false;
  if (inA) throw new Error('mid-switch send landed in the chat the user LEFT (module-global pointer stale) — the /approve-class bug');
  if (!inB) throw new Error('mid-switch send never reached the clicked chat server-side');
  log('server received the send addressed to B');

  // Let B's delayed history land; the sent bubble must be visible in
  // the final B transcript (optimistic bubble survives the replay).
  await new Promise((r) => setTimeout(r, 3200));
  await waitForDrawerQuiet(page);
  const final = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
  }));
  if (!final.text.includes('SDS-B-SEED')) throw new Error('B history never painted after the delayed fetch landed');
  if (!final.text.includes(MARKER)) throw new Error('sent bubble missing from B after history replay — optimistic bubble lost to the late paint');
  if (final.text.includes('SDS-A-SEED')) throw new Error('foreign content: A\'s transcript painted into B');
  if (final.loading) throw new Error('spinner left armed after everything settled');
  log('bubble visible in B after the delayed history landed — send routed and survived');

  // ── Variant 2: send in the SAME TICK as the row click ─────────────
  // The adapter's send pointer only re-aims when the switch's server
  // fetch starts (an await or two after the click), so a send committed
  // in the click's own task hits the ~40ms window where the pointer
  // still names the chat being LEFT. The view state (focusedId) flips
  // synchronously at click — sends addressed from it route correctly
  // (invariant #3). Click + send inside one page.evaluate so no
  // Playwright round-trip can widen the window.
  await waitForDrawerQuiet(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SDS-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  mock.setMessageDelay(CHAT_B, 1500);
  const MARKER2 = 'SDS-SAMETICK-SEND';
  await page.evaluate(({ target, marker }) => {
    const row = document.querySelector(`#sessions-list li[data-chat-id="${target}"] .sess-body`);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = document.getElementById('composer-input');
    input.value = marker;
    input.dispatchEvent(new Event('input'));
    document.getElementById('composer-send').click();
  }, { target: CHAT_B, marker: MARKER2 });
  await new Promise((r) => setTimeout(r, 800));
  const inA2 = mock.getChat(CHAT_A)?.messages.some((m) => (m.content || '').includes(MARKER2)) ?? false;
  const inB2 = mock.getChat(CHAT_B)?.messages.some((m) => (m.content || '').includes(MARKER2)) ?? false;
  if (inA2) throw new Error('same-tick send landed in the chat the user LEFT — send pointer read before the switch re-aimed it');
  if (!inB2) throw new Error('same-tick send never reached the clicked chat server-side');
  log('same-tick send routed to the clicked chat — addressed from view state, not the pointer');

  // ── Variant 3: a QUEUED send survives a switch ────────────────────
  // The other half of invariant #3: "captured at intent time" has to
  // hold for the whole life of the send, not just the first POST. An
  // offline send is parked in main.ts's `queuedSends` and re-POSTed
  // minutes later on reconnect — by which time the user is very
  // plausibly in another chat. If the retry re-resolved the target
  // (from the view, from a pointer, from anything) it would deliver a
  // message the user wrote in A into whatever they are reading now.
  //
  // Shape: view A → go offline → send (queues under A) → switch to B
  // while still offline → come back online → the flush must POST to A.
  // B's history is already in the IDB cache from variants 1-2, so the
  // switch commits from cache and does not need the network.
  const MARKER3 = 'SDS-QUEUED-ACROSS-SWITCH';
  await waitForDrawerQuiet(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('SDS-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  mock.setMessageDelay(CHAT_B, 0);
  await page.evaluate(() => import('/build/backend.mjs').then((m) => { window.__backend = m; }));

  mock.setStreamOutage(true);
  await page.waitForFunction(
    () => window.__backend && window.__backend.isConnected() === false,
    null, { timeout: 10_000, polling: 100 },
  );
  await send(page, MARKER3);
  // The POST failed at the network layer, so nothing reached the server
  // yet — the bubble is parked `.pending` with its address stamped on it.
  await page.waitForFunction(
    (m) => Array.from(document.querySelectorAll('#transcript .line.s0.pending'))
      .some((el) => (el.textContent || '').includes(m)),
    MARKER3, { timeout: 5_000, polling: 50 },
  );
  log('send queued .pending while offline, composed in A');

  // Move to B while the send is still owed. focusedId() is now B — the
  // value a re-resolving retry would pick up.
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    (t) => (window.__parleyNav || []).some((e) => e.id === t && e.outcome !== 'refused'),
    CHAT_B, { timeout: 5_000, polling: 50 },
  );
  log('switched to B with the send still queued');

  mock.setStreamOutage(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(
    () => window.__backend && window.__backend.isConnected() === true,
    null, { timeout: 10_000, polling: 100 },
  );
  // The flush is fired by the disconnected→connected transition; allow
  // for it plus the backoff safety net's first tick.
  await new Promise((r) => setTimeout(r, 2_000));

  const queuedInA = mock.getChat(CHAT_A)?.messages.some((m) => (m.content || '').includes(MARKER3)) ?? false;
  const queuedInB = mock.getChat(CHAT_B)?.messages.some((m) => (m.content || '').includes(MARKER3)) ?? false;
  assert(!queuedInB,
    'a queued send flushed after a switch landed in the chat the user moved TO — the retry re-resolved '
    + 'its target instead of carrying the address it was composed with');
  assert(queuedInA,
    'the queued send never reached the chat it was composed in after reconnect');
  log('queued send re-POSTed to the chat it was composed in, not the one on screen ✓');
}
