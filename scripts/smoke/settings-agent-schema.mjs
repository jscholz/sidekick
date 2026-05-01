// Scenario: agent-declared settings (model picker etc.) render via
// the schema contract documented in
// docs/ABSTRACT_AGENT_PROTOCOL.md "Optional settings extension".
//
// Test plan (mocked):
//   1. Mock /api/sidekick/settings/schema with one enum setting
//      ("model" with two options).
//   2. Open the settings panel.
//   3. Assert the model dropdown rendered with both options + the
//      expected current value selected.
//   4. Change the dropdown to the other value.
//   5. Assert the PWA POSTed { value: <new> } to
//      /api/sidekick/settings/model and the dropdown reflects the
//      agent's response.

import { waitForReady } from './lib.mjs';
import { installMockBackend } from './mock-backend.mjs';

export const NAME = 'settings-agent-schema';
export const DESCRIPTION = 'agent-declared settings render via /v1/settings/schema; updates POST back';
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
      value: 'anthropic/claude-opus-4-6',
      options: [
        { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
        { value: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      ],
    },
  ]);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Open settings panel via the sidebar's "Settings" button. The
  // panel renderer fires agentSettings.load() in its open path.
  await page.click('#sb-settings');
  await page.waitForFunction(
    () => document.getElementById('settings')?.classList.contains('on'),
    null,
    { timeout: 2_000 },
  );
  log('settings panel opened');

  // The schema row injects with data-agent-setting="model"; wait for
  // it to render (the static placeholder ships with the same attr,
  // but disabled — schema render replaces it with an enabled select).
  const sel = await page.waitForSelector(
    '#settings-group-agent [data-agent-setting="model"] select:not([disabled])',
    { timeout: 3_000 },
  );
  log('model dropdown rendered');

  const initial = await sel.evaluate(
    (s) => ({
      value: s.value,
      options: Array.from(s.options).map((o) => ({ value: o.value, label: o.textContent })),
    }),
  );
  assert(initial.value === 'anthropic/claude-opus-4-6',
    `pre-condition: initial dropdown value; got ${initial.value}`);
  assert(initial.options.length === 2,
    `pre-condition: 2 options rendered; got ${initial.options.length}`);
  assert(initial.options.some((o) => o.value === 'google/gemini-3-flash-preview'),
    `pre-condition: gemini option present; got ${JSON.stringify(initial.options)}`);
  log('initial dropdown state OK');

  // Change to the other value. The renderer's onchange handler
  // POSTs to /api/sidekick/settings/model.
  await sel.selectOption('google/gemini-3-flash-preview');

  // Wait briefly for the POST to fire + return.
  await page.waitForFunction(
    () => {
      const s = document.querySelector(
        '#settings-group-agent [data-agent-setting="model"] select',
      );
      return s && s.value === 'google/gemini-3-flash-preview';
    },
    null,
    { timeout: 2_000 },
  );
  log('dropdown reflects new value after POST round-trip');

  const last = mock.getLastSettingsPost();
  assert(last && last.id === 'model',
    `POST should have hit /settings/model; got ${JSON.stringify(last)}`);
  assert(last.body && last.body.value === 'google/gemini-3-flash-preview',
    `POST body should carry the new value; got ${JSON.stringify(last.body)}`);
  log('proxy POST body verified ✓');
}
