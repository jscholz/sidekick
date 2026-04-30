// Scenario: shift-click + ctrl/cmd-click + Esc selection modifiers.
// Pins the new selection-modifier matrix (2026-04-30 UX update).
//
//   shift           → range select from anchor to clicked id
//   ctrl OR meta    → toggle clicked id (additive)
//   plain           → clear + resume
//   Esc             → clear selection
//
// Companion to `sidebar-multiselect-bulk-delete` (which covers the
// stats-panel + delete plumbing). This one focuses on the selection
// state machine alone, with 4 chats so range-select can span more
// than 2 rows.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sidebar-multiselect-modifiers';
export const DESCRIPTION = 'shift=range, ctrl/cmd=toggle, Esc=cancel selection';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHATS = ['mock-modA', 'mock-modB', 'mock-modC', 'mock-modD'];

export function MOCK_SETUP(mock) {
  const now = Date.now();
  // Most-recent-first display order matches the lastActiveAt ordering.
  CHATS.forEach((id, i) => {
    mock.addChat(id, {
      title: `Chat ${id.slice(-1)}`,
      messages: [
        { role: 'user', content: `${id}-msg`, timestamp: now / 1000 - 60 - i * 10 },
        { role: 'assistant', content: `${id}-reply`, timestamp: now / 1000 - 59 - i * 10 },
      ],
      lastActiveAt: now - (60 + i * 10) * 1000,
    });
  });
}

async function clickRow(page, chatId, modifiers = []) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`)
    .first().click({ modifiers });
}

async function selectedIds(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessions-list li.multiselected'))
      .map(li => li.getAttribute('data-chat-id'))
      .sort(),
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  for (const id of CHATS) {
    await page.waitForSelector(`#sessions-list li[data-chat-id="${id}"]`, { timeout: 5_000 });
  }
  log('drawer pre-populated with 4 chats');

  // Step 1 — plain click on A activates it. No selection yet.
  await clickRow(page, 'mock-modA');
  let sel = await selectedIds(page);
  assert.equal ? assert.equal(sel.length, 0) : assert(sel.length === 0,
    `pre-condition: no selection after plain click; got ${JSON.stringify(sel)}`);

  // Step 2 — shift-click C: range from A → C should include A, B, C.
  await clickRow(page, 'mock-modC', ['Shift']);
  sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-modA', 'mock-modB', 'mock-modC']),
    `step 2 (shift-click range A→C); expected [A,B,C] got ${JSON.stringify(sel)}`,
  );
  log('shift-click range A→C → A,B,C ✓');

  // Step 3 — ctrl-click D: additive toggle, adds D to the existing selection.
  await clickRow(page, 'mock-modD', ['Control']);
  sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-modA', 'mock-modB', 'mock-modC', 'mock-modD']),
    `step 3 (ctrl-click toggle add D); expected [A,B,C,D] got ${JSON.stringify(sel)}`,
  );
  log('ctrl-click toggle add D → A,B,C,D ✓');

  // Step 4 — ctrl-click B: toggle removes B (it was already in the set).
  await clickRow(page, 'mock-modB', ['Control']);
  sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-modA', 'mock-modC', 'mock-modD']),
    `step 4 (ctrl-click toggle remove B); expected [A,C,D] got ${JSON.stringify(sel)}`,
  );
  log('ctrl-click toggle remove B → A,C,D ✓');

  // Step 4.5 — Mac ctrl+click path. macOS Chrome / Safari fire
  // `contextmenu` instead of `click` when ctrlKey is held, so the
  // onclick handler never sees the gesture. Dispatch a synthetic
  // contextmenu event to verify the body-row interceptor catches
  // it and routes to the toggle path. Adds B back to the selection
  // so the next step (Esc) clears a non-trivial set.
  await page.evaluate((id) => {
    const el = document.querySelector(
      `#sessions-list li[data-chat-id="${id}"] .sess-body`,
    );
    const ev = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, ctrlKey: true,
    });
    el.dispatchEvent(ev);
  }, 'mock-modB');
  sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-modA', 'mock-modB', 'mock-modC', 'mock-modD']),
    `step 4.5 (Mac ctrl+click via contextmenu); expected [A,B,C,D] got ${JSON.stringify(sel)}`,
  );
  log('Mac ctrl+click (contextmenu route) → A,B,C,D ✓');

  // Step 5 — Esc clears selection.
  await page.keyboard.press('Escape');
  // Give the keyboard handler a tick to land + DOM to update.
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.multiselected').length === 0,
    null,
    { timeout: 1_000, polling: 50 },
  );
  // Stats panel should also be gone.
  const panelGone = await page.evaluate(() => !document.getElementById('multi-select-panel'));
  assert(panelGone, 'Esc should unmount the stats panel');
  log('Esc cleared selection + dismissed panel ✓');

  // Step 6 — body class is also cleared so native text-select works again.
  const bodyHasClass = await page.evaluate(() =>
    document.body.classList.contains('session-multiselect-active'));
  assert(!bodyHasClass, 'body should not have session-multiselect-active class after Esc');
  log('body class cleared, text-select restored ✓');
}
