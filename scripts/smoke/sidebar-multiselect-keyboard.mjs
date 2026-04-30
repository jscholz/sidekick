// Scenario: Shift+ArrowUp/ArrowDown extends the multi-select span;
// chained presses keep walking. The anchor advances with each press
// so growing the range and shrinking it both work.
//
// Pre-condition: focus is NOT in an input/textarea — the keyboard
// handler intentionally bails when typing in those (so arrow keys
// in the composer / filter still cursor through text the user is
// editing).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sidebar-multiselect-keyboard';
export const DESCRIPTION = 'Shift+Arrow extends selection; chained presses walk the range';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHATS = ['mock-kbA', 'mock-kbB', 'mock-kbC', 'mock-kbD'];

export function MOCK_SETUP(mock) {
  const now = Date.now();
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

  // Plain click B to set the active row; that's our anchor for the
  // first shift+arrow.
  await clickRow(page, 'mock-kbB');
  // Move focus off any input so the keyboard handler doesn't bail.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement)
    && document.activeElement.blur());

  // Shift+ArrowDown — extends to the next row. Display order is
  // [A, B, C, D] (most-recent first per lastActiveAt). B is index 1;
  // down from B = C → selection becomes {B, C}.
  await page.keyboard.press('Shift+ArrowDown');
  let sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-kbB', 'mock-kbC']),
    `step 1 (shift+down from B); expected [B,C] got ${JSON.stringify(sel)}`,
  );
  log('Shift+ArrowDown from B → B,C ✓');

  // Another Shift+ArrowDown — anchor advanced to C, so down = D.
  // selection grows to {B, C, D}.
  await page.keyboard.press('Shift+ArrowDown');
  sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-kbB', 'mock-kbC', 'mock-kbD']),
    `step 2 (shift+down from C); expected [B,C,D] got ${JSON.stringify(sel)}`,
  );
  log('Shift+ArrowDown again → B,C,D ✓');

  // Shift+ArrowUp from D — anchor was D, up = C. C is already in
  // the set, so we shrink (un-select the OLD anchor D), leaving
  // {B, C}.
  await page.keyboard.press('Shift+ArrowUp');
  sel = await selectedIds(page);
  assert(
    JSON.stringify(sel) === JSON.stringify(['mock-kbB', 'mock-kbC']),
    `step 3 (shift+up from D shrinks); expected [B,C] got ${JSON.stringify(sel)}`,
  );
  log('Shift+ArrowUp shrinks → B,C ✓');

  // Esc clears.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelectorAll('#sessions-list li.multiselected').length === 0,
    null,
    { timeout: 1_000, polling: 50 },
  );
  log('Esc cleared selection ✓');
}
