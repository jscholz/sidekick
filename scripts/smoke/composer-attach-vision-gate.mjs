// Pin the model-aware image-upload gate (Jonathan asked 2026-05-01):
// the camera + attach buttons in the composer enable only when the
// currently-selected agent model is multimodal/vision-capable.
//
// Heuristic match against common multimodal model name patterns lives
// in main.ts:isVisionCapableModel. This test verifies the gate fires
// for known-good (gemma-3-27b-it, claude-opus-4-6) and stays disabled
// for known-bad (qwen2.5-7b-instruct, gemma-2-9b-it).
//
// Test plan (mocked):
//   1. MOCK_SETUP declares a model setting whose initial value is a
//      vision-capable model.
//   2. Boot PWA, open settings panel so agentSettings.load fires.
//   3. Wait for agent-schema-loaded event side-effect: btn-attach is
//      enabled.
//   4. Change selection to a text-only model, POST round-trips.
//   5. Wait for agent-setting-changed event side-effect: btn-attach
//      is disabled.
//   6. Switch back to vision-capable; assert re-enabled.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'composer-attach-vision-gate';
export const DESCRIPTION = 'Image-upload buttons enable only when selected model supports vision';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'google/gemma-3-27b-it',
      options: [
        { value: 'google/gemma-3-27b-it', label: 'Gemma 3 27B (vision)' },
        { value: 'google/gemma-2-9b-it', label: 'Gemma 2 9B (text only)' },
        { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 (vision)' },
        { value: 'qwen/qwen2.5-7b-instruct', label: 'Qwen 2.5 7B (text only)' },
      ],
    },
  ]);
}

async function attachDisabled(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('btn-attach');
    return btn ? btn.disabled : null;
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Buttons start disabled in HTML.
  let initialDisabled = await attachDisabled(page);
  assert(initialDisabled === true, `btn-attach should start disabled, got ${initialDisabled}`);
  log('btn-attach starts disabled (HTML default) ✓');

  // Open settings panel — triggers agentSettings.load → schema fetch
  // → 'agent-schema-loaded' event → updateAttachButtonsState.
  await page.click('#sb-settings');
  await page.waitForFunction(
    () => document.getElementById('settings')?.classList.contains('on'),
    null,
    { timeout: 2_000 },
  );
  log('settings panel opened');

  // After schema loads with gemma-3-27b-it (vision-capable), the
  // gate should flip enabled.
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && !b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach enabled after schema loads (gemma-3-27b-it) ✓');

  // Switch to text-only model.
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) throw new Error('model select not found');
    sel.value = 'google/gemma-2-9b-it';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // POST round-trip + agent-setting-changed event → updateAttach.
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach disabled after switching to gemma-2-9b-it (text-only) ✓');

  // Switch to claude-sonnet-4 (vision).
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    sel.value = 'anthropic/claude-sonnet-4';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && !b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach re-enabled after switching to claude-sonnet-4 ✓');

  // Switch to qwen 2.5 (text-only).
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    sel.value = 'qwen/qwen2.5-7b-instruct';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach disabled after switching to qwen 2.5 (text-only) ✓');
}
