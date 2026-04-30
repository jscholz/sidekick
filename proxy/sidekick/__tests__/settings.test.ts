/**
 * Integration tests for the agent-settings proxy routes.
 *
 * Pin the contract documented in docs/ABSTRACT_AGENT_PROTOCOL.md
 * "Optional settings extension" section: GET schema forwards
 * verbatim, POST {id} forwards body + returns updated def, 404 on
 * the agent surfaces as 404 from the proxy (so the PWA hides the
 * group), validation errors propagate.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { startRig, type SettingDef } from './proxy-harness.ts';

const MODEL_ENUM: SettingDef = {
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
};

test('settings schema — forwards upstream list', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setSettingsSchema([MODEL_ENUM]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/schema`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, 'model');
    assert.equal(body.data[0].type, 'enum');
    assert.equal(body.data[0].value, 'anthropic/claude-opus-4-6');
    assert.equal(body.data[0].options.length, 2);
  } finally {
    await rig.stop();
  }
});

test('settings schema — agent without extension returns 404', async () => {
  const rig = await startRig();
  try {
    // setSettingsSchema(null) tells FakeAgent the route is unsupported —
    // it will return 404, mirroring the contract for agents that don't
    // implement the optional settings extension.
    rig.fakeAgent.setSettingsSchema(null);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/schema`);
    assert.equal(r.status, 404);
  } finally {
    await rig.stop();
  }
});

test('settings update — forwards body, returns updated def', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setSettingsSchema([MODEL_ENUM]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'google/gemini-3-flash-preview' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, 'model');
    assert.equal(body.value, 'google/gemini-3-flash-preview');

    // Upstream observed exactly what the PWA sent.
    const last = rig.fakeAgent.lastSettingsPost;
    assert.equal(last?.id, 'model');
    assert.deepEqual(last?.body, { value: 'google/gemini-3-flash-preview' });
  } finally {
    await rig.stop();
  }
});

test('settings update — unknown id propagates 404', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setSettingsSchema([MODEL_ENUM]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/nonexistent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x' }),
    });
    assert.equal(r.status, 404);
  } finally {
    await rig.stop();
  }
});

test('settings update — validation error propagates 400', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setSettingsSchema([MODEL_ENUM]);

    // Value not in the enum's options[]. FakeAgent returns 400
    // with the OAI-shaped error body; the proxy passes it through
    // so the PWA can surface the message.
    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'bogus/model-ref' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error?.message ?? '', /not in options/i);
  } finally {
    await rig.stop();
  }
});

test('settings update — string-list type round-trips a list', async () => {
  const rig = await startRig();
  try {
    const def: SettingDef = {
      id: 'preferred_models',
      label: 'Preferred models',
      type: 'string-list',
      value: ['anthropic/*'],
      placeholder: 'e.g. anthropic/* + Enter',
    };
    rig.fakeAgent.setSettingsSchema([def]);

    // Schema endpoint surfaces the new type + initial list.
    const sR = await fetch(`${rig.proxyUrl}/api/sidekick/settings/schema`);
    assert.equal(sR.status, 200);
    const sBody = await sR.json();
    assert.equal(sBody.data[0].type, 'string-list');
    assert.deepEqual(sBody.data[0].value, ['anthropic/*']);

    // Update with a fresh list — chip add/remove sends the entire
    // updated list per the contract.
    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/preferred_models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: ['anthropic/*', 'google/gemini-*'] }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.value, ['anthropic/*', 'google/gemini-*']);
  } finally {
    await rig.stop();
  }
});

test('settings update — string-list rejects non-array body', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setSettingsSchema([{
      id: 'preferred_models',
      label: 'Preferred models',
      type: 'string-list',
      value: [],
    }]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/settings/preferred_models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'not-a-list' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error?.message ?? '', /string\[\]/);
  } finally {
    await rig.stop();
  }
});

test('settings update — id validated at proxy boundary', async () => {
  const rig = await startRig();
  try {
    rig.fakeAgent.setSettingsSchema([MODEL_ENUM]);

    // Path traversal / weird chars rejected at the proxy without
    // even hitting the agent — the id is part of the URL, so we
    // gate on the same charset the contract calls out ([a-z0-9_]+).
    const r = await fetch(
      `${rig.proxyUrl}/api/sidekick/settings/${encodeURIComponent('../foo')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x' }),
      },
    );
    assert.equal(r.status, 400);
    // FakeAgent's recorder stays untouched — proxy short-circuited.
    assert.equal(rig.fakeAgent.lastSettingsPost, null);
  } finally {
    await rig.stop();
  }
});
