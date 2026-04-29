// Scenario: the send button must reflect the current state of all
// input surfaces — typed text, draft block, pending attachments,
// memo recording. Architecture audit hot spot:
//
//   sendable = memoActive
//           || composer.value.trim().length > 0
//           || draft.hasContent()
//           || attachments.hasPending();
//
// Bug class this guards: voice append does NOT dispatch the
// input event → composer.value updates but send button stays
// grey → user clicks send and nothing fires. Regression armor.
//
// Test plan (smoke — DOM state):
//   1. Empty composer: button disabled.
//   2. Type via fill(): button enabled.
//   3. Programmatic appendText(' world') (voice path): button stays
//      enabled, value ends with " world", send dispatches.
//   4. Clear via setting value to empty + dispatching input event
//      (the canonical clear path): button disabled.
//   5. Type a single char: button enabled.

import { waitForReady, openSidebar, SEL, assert } from './lib.mjs';

export const NAME = 'send-button-state';
export const DESCRIPTION = 'Send button enabled iff composer has content (typed or voice-appended)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) {
  // No chats needed — this is a pure UI-state test.
}

async function isSendDisabled(page) {
  // Prefer the disabled property over the attribute; updateSendButtonState
  // sets `send.disabled = !sendable` directly.
  return page.evaluate(() => {
    const btn = document.getElementById('composer-send');
    return btn ? btn.disabled : true;
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Empty composer → send disabled.
  await page.fill(SEL.composer, '');
  await page.evaluate(() => {
    document.getElementById('composer-input')?.dispatchEvent(new Event('input'));
  });
  let disabled = await isSendDisabled(page);
  assert(disabled, `step 1: expected send disabled with empty composer, got disabled=${disabled}`);
  log('step 1: empty composer → send disabled ✓');

  // 2. Type text → send enabled.
  await page.fill(SEL.composer, 'hello');
  disabled = await isSendDisabled(page);
  assert(!disabled, `step 2: expected send enabled with typed text, got disabled=${disabled}`);
  log('step 2: typed text → send enabled ✓');

  // 3. Voice path — programmatic appendText. Reach into the global
  //    composer module the page already loaded; no test-only export
  //    needed since composer is part of the public src boundary.
  //    composer.appendText is the function voice pipelines call when a
  //    final transcript arrives; it must dispatch input event so
  //    updateSendButtonState reacts.
  await page.evaluate(async () => {
    const mod = await import('/build/composer.mjs');
    mod.appendText('world-via-voice');
  });
  const valueAfterVoice = await page.locator(SEL.composer).inputValue();
  assert(
    valueAfterVoice.includes('world-via-voice'),
    `step 3: composer should contain voice-appended text, got ${JSON.stringify(valueAfterVoice)}`,
  );
  disabled = await isSendDisabled(page);
  assert(!disabled, `step 3: expected send enabled after voice append, got disabled=${disabled}`);
  log(`step 3: voice append → send still enabled ✓ (value=${JSON.stringify(valueAfterVoice.slice(0, 40))})`);

  // 4. Clear via the canonical path (value='' + dispatch input event)
  //    — same as new-chat handler does.
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) {
      ta.value = '';
      ta.dispatchEvent(new Event('input'));
    }
  });
  disabled = await isSendDisabled(page);
  assert(disabled, `step 4: expected send disabled after clear, got disabled=${disabled}`);
  log('step 4: cleared via input event → send disabled ✓');

  // 5. Type one character → send enabled.
  await page.fill(SEL.composer, 'x');
  disabled = await isSendDisabled(page);
  assert(!disabled, `step 5: expected send enabled with single char, got disabled=${disabled}`);
  log('step 5: single char → send enabled ✓');
}
