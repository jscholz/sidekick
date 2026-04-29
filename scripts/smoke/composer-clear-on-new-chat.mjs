// Scenario: clicking "New chat" must atomically clear ALL input
// surfaces — composer textarea, draft segments, attachments. The
// architecture audit (docs/FRONTEND_ARCHITECTURE.md hot spot #4)
// flagged this as a half-state hole: today the new-chat handler
// dismisses the draft + clears chat but leaves composer.value
// intact. Repro: type "hello" → click new-chat → "hello" still
// in textarea. Type "world", send → message is "helloworld".
//
// Test plan:
//   1. Type "leftover-text-marker" into the composer (don't send).
//   2. Click new chat.
//   3. Assert composer.value === '' AND no draft block visible AND
//      send button is disabled (since there's no content + no
//      attachments + no memo).

import { waitForReady, openSidebar, clickNewChat, SEL, assert } from './lib.mjs';

export const NAME = 'composer-clear-on-new-chat';
export const DESCRIPTION = 'Clicking New chat clears composer, draft, and attachments atomically';
export const STATUS = 'implemented';
// Pure UX behavior — no LLM round-trip needed.
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  // No pre-existing chats needed — we never send. Just need the
  // mocked session list to render so the drawer is visible.
}

const MARKER = 'leftover-text-marker';

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Type into composer, don't send.
  await page.fill(SEL.composer, MARKER);
  log(`typed marker into composer: ${MARKER}`);

  // Send button should be ENABLED now (we have non-empty text).
  const sendDisabledBefore = await page.locator(SEL.send).getAttribute('disabled');
  assert(
    sendDisabledBefore === null,
    `send button should be enabled with composer text, got disabled=${sendDisabledBefore}`,
  );

  // Click new chat. This is the transition under test.
  await clickNewChat(page);
  log('clicked new chat');

  // Wait briefly for the new-chat side-effects to settle (chat clear,
  // any drawer re-render, optimistic active flip).
  await page.waitForTimeout(150);

  // Composer.value should be empty.
  const composerValue = await page.locator(SEL.composer).inputValue();
  assert(
    composerValue === '',
    `composer should be empty after new-chat click, got ${JSON.stringify(composerValue)}`,
  );

  // No draft block visible (draft.dismiss should have cleaned it up).
  const draftBlocks = await page.locator('.draft-block').count();
  assert(
    draftBlocks === 0,
    `expected 0 draft-block elements, found ${draftBlocks}`,
  );

  // Send button should be DISABLED again (no content + no
  // attachments + no memo).
  const sendDisabledAfter = await page.locator(SEL.send).getAttribute('disabled');
  assert(
    sendDisabledAfter !== null,
    `send button should be disabled after new-chat click clears the composer, got disabled=${sendDisabledAfter}`,
  );

  log('composer + draft + send-button all cleared atomically ✓');
}
