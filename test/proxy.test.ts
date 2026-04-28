/**
 * Tests for the hermes-gateway proxy at the HTTP+SSE boundary.
 *
 * Each test spins up a fresh scratch state.db, sessions.json, and
 * FakePlugin WS server. Then it exercises the proxy via real HTTP
 * fetches and asserts on response bodies, FakePlugin recordings, and
 * scratch state.db rows.
 *
 * RED tests at scaffold time: T1, T3, T4, T5, T7, T8. Each will go
 * green in the relevant commit.
 *
 * Run: npm test -- --test-name-pattern=proxy
 *      (or just `npm test`, which runs all *.test.ts including this)
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sqlQuery } from '../server-lib/generic/sql.ts';
import { setupProxyTest, SseClient, waitFor, type ProxyRig } from './proxy-harness.ts';

const SIDEKICK_KEY_PREFIX = 'agent:main:sidekick:dm:';

describe('proxy: hermes-gateway HTTP+SSE contract', () => {
  let rig: ProxyRig;

  before(async () => {
    rig = await setupProxyTest();
  });
  after(async () => {
    await rig.cleanup();
  });

  // T1: orphan in sessions.json doesn't appear in the list.
  it('T1: sessions list excludes orphans whose session_id has no state.db row', async () => {
    // Reset state
    rig = await freshRig(rig);

    await rig.seedSession({ id: 'S1', source: 'sidekick', title: 'Real chat', message_count: 2 });
    await rig.writeSessionsIndex({
      [`${SIDEKICK_KEY_PREFIX}chatA`]: {
        session_key: `${SIDEKICK_KEY_PREFIX}chatA`,
        session_id: 'S1',
        platform: 'sidekick',
        chat_id: 'chatA',
        updated_at: '2026-04-28T10:00:00',
      },
      [`${SIDEKICK_KEY_PREFIX}chatGHOST`]: {
        session_key: `${SIDEKICK_KEY_PREFIX}chatGHOST`,
        session_id: 'S99',  // orphan — no state.db row
        platform: 'sidekick',
        chat_id: 'chatGHOST',
        updated_at: '2026-04-28T11:00:00',
      },
    });

    const resp = await fetch(`${rig.proxyUrl}/api/sidekick/sessions`);
    const body = await resp.json() as any;
    const ids = (body.sessions || []).map((s: any) => s.chat_id).sort();
    assert.deepEqual(ids, ['chatA'], 'orphan chatGHOST should not appear');
    const row = body.sessions[0];
    assert.equal(row.session_id, 'S1');
    assert.equal(row.title, 'Real chat');
    assert.equal(row.message_count, 2);
  });

  // T2: sending first message → exactly one state.db session row + correct WS envelope.
  it('T2: first message creates exactly one state.db session via the plugin', async () => {
    rig = await freshRig(rig);

    // FakePlugin mimics gateway side-effects when it receives the first
    // message envelope: insert a sessions row + sessions.json entry.
    rig.fakePlugin.onMessage = async (env) => {
      if (env?.type !== 'message') return;
      const sessionId = `S_${env.chat_id}`;
      await rig.seedSession({
        id: sessionId, source: 'sidekick',
        title: 'auto-titled', message_count: 1,
      });
      await rig.writeSessionsIndex({
        [`${SIDEKICK_KEY_PREFIX}${env.chat_id}`]: {
          session_key: `${SIDEKICK_KEY_PREFIX}${env.chat_id}`,
          session_id: sessionId,
          platform: 'sidekick',
          chat_id: env.chat_id,
          updated_at: new Date().toISOString(),
        },
      });
    };

    const resp = await fetch(`${rig.proxyUrl}/api/sidekick/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'newChat', text: 'hi' }),
    });
    assert.equal(resp.status, 202, 'POST should return 202 Accepted');
    const body = await resp.json() as any;
    assert.equal(body.ok, true);

    // Wait for FakePlugin to receive + process the message.
    await waitFor(() => rig.fakePlugin.received.length > 0);
    const env = rig.fakePlugin.received[0];
    assert.equal(env.type, 'message');
    assert.equal(env.chat_id, 'newChat');
    assert.equal(env.text, 'hi');

    // After plugin's mimicked side-effect, exactly one sidekick row.
    await waitFor(async () => {
      const rows = await sqlQuery(rig.stateDb, `SELECT id FROM sessions WHERE source='sidekick'`);
      return rows.length === 1;
    });

    // GET /sessions surfaces that one row.
    const list = await (await fetch(`${rig.proxyUrl}/api/sidekick/sessions`)).json() as any;
    const ids = (list.sessions || []).map((s: any) => s.chat_id);
    assert.deepEqual(ids, ['newChat']);
  });

  // T3: SSE events carry chat_id; ?chat_id= filter excludes other chats.
  it('T3: SSE filters by ?chat_id and drops envelopes without chat_id', async () => {
    rig = await freshRig(rig);

    // Subscribe filtered to chat B.
    const sse = new SseClient(`${rig.proxyUrl}/api/sidekick/stream?chat_id=B`);
    await sse.start();

    // Plugin emits events for A, B, A, plus one missing chat_id (should drop).
    rig.fakePlugin.emit({ type: 'reply_delta', chat_id: 'A', text: 'a1' });
    rig.fakePlugin.emit({ type: 'reply_delta', chat_id: 'B', text: 'b1' });
    rig.fakePlugin.emit({ type: 'reply_delta', chat_id: 'A', text: 'a2' });
    rig.fakePlugin.emit({ type: 'reply_delta', text: 'orphan' }); // no chat_id

    await waitFor(() => sse.events.some((e) => e.data?.text === 'b1'));
    // Give the bus a moment to deliver any other in-flight events.
    await new Promise((r) => setTimeout(r, 100));

    const texts = sse.events
      .filter((e) => e.event === 'reply_delta')
      .map((e) => e.data?.text);
    assert.deepEqual(texts, ['b1'], `expected only chat B's events, got ${JSON.stringify(texts)}`);

    sse.close();
  });

  // T4: Last-Event-ID replay returns missed events only, in order.
  it('T4: Last-Event-ID replay yields only post-cursor events, in order', async () => {
    rig = await freshRig(rig);

    // Drive 5 events for chat A while no subscriber is connected.
    for (let i = 1; i <= 5; i++) {
      rig.fakePlugin.emit({ type: 'reply_delta', chat_id: 'A', text: `msg${i}` });
    }
    // Allow events to land in ring.
    await new Promise((r) => setTimeout(r, 50));

    // Connect with Last-Event-ID = 3. Should only see events with id 4, 5.
    const sse = new SseClient(`${rig.proxyUrl}/api/sidekick/stream?chat_id=A`, {
      'Last-Event-ID': '3',
    });
    await sse.start();
    await waitFor(() => sse.events.some((e) => e.data?.text === 'msg5'));

    const replayed = sse.events
      .filter((e) => e.event === 'reply_delta')
      .map((e) => ({ id: Number(e.id), text: e.data?.text }));
    assert.deepEqual(replayed, [
      { id: 4, text: 'msg4' },
      { id: 5, text: 'msg5' },
    ]);

    sse.close();
  });

  // T5: DELETE wipes state.db + sessions.json + jsonl atomically.
  it('T5: DELETE drops state.db rows, sessions.json key, and jsonl', async () => {
    rig = await freshRig(rig);

    await rig.seedSession({ id: 'S1', source: 'sidekick', title: 'gone', message_count: 1 });
    await rig.seedMessage({ session_id: 'S1', role: 'user', content: 'hi' });
    await rig.writeSessionsIndex({
      [`${SIDEKICK_KEY_PREFIX}chatX`]: {
        session_key: `${SIDEKICK_KEY_PREFIX}chatX`,
        session_id: 'S1',
        platform: 'sidekick',
        chat_id: 'chatX',
        updated_at: '2026-04-28T10:00:00',
      },
    });
    await rig.writeJsonl('S1', '{"role":"user","content":"hi"}\n');

    const resp = await fetch(`${rig.proxyUrl}/api/sidekick/sessions/chatX`, { method: 'DELETE' });
    assert.equal(resp.status, 200);

    // state.db rows gone
    const sRows = await sqlQuery(rig.stateDb, `SELECT id FROM sessions WHERE id='S1'`);
    assert.equal(sRows.length, 0, 'session row should be deleted');
    const mRows = await sqlQuery(rig.stateDb, `SELECT id FROM messages WHERE session_id='S1'`);
    assert.equal(mRows.length, 0, 'message rows should be deleted');

    // sessions.json key gone
    const idx = JSON.parse(await (await import('node:fs')).promises.readFile(rig.sessionsJson, 'utf8'));
    assert.ok(!idx[`${SIDEKICK_KEY_PREFIX}chatX`], 'sessions.json sidekick key should be removed');

    // jsonl file gone
    const fs = (await import('node:fs')).promises;
    let jsonlExists = true;
    try { await fs.access(`${rig.sessionsDir}/S1.jsonl`); } catch { jsonlExists = false; }
    assert.equal(jsonlExists, false, 'transcript jsonl should be deleted');

    // Drawer list now empty.
    const list = await (await fetch(`${rig.proxyUrl}/api/sidekick/sessions`)).json() as any;
    assert.deepEqual(list.sessions || [], []);
  });

  // T6: There is no proxy endpoint that creates a chat without a message.
  it('T6: no chat-create endpoint exists; POST /api/sidekick/sessions returns 404', async () => {
    rig = await freshRig(rig);

    const resp = await fetch(`${rig.proxyUrl}/api/sidekick/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'foo' }),
    });
    assert.equal(resp.status, 404);

    const list = await (await fetch(`${rig.proxyUrl}/api/sidekick/sessions`)).json() as any;
    assert.deepEqual(list.sessions || [], []);
  });

  // T7: cross-chat isolation end-to-end via two SSE subscribers.
  it('T7: subscriber for chat B does not receive chat A envelopes', async () => {
    rig = await freshRig(rig);

    const subB = new SseClient(`${rig.proxyUrl}/api/sidekick/stream?chat_id=B`);
    await subB.start();

    rig.fakePlugin.onMessage = (env) => {
      if (env?.type === 'message' && env.chat_id === 'A') {
        rig.fakePlugin.emit({ type: 'reply_delta', chat_id: 'A', text: 'response-to-A' });
      }
    };

    await fetch(`${rig.proxyUrl}/api/sidekick/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'A', text: 'hi from A' }),
    });
    // Wait until plugin's reply has had time to propagate.
    await waitFor(() => rig.fakePlugin.received.length > 0);
    await new Promise((r) => setTimeout(r, 100));

    const seen = subB.events
      .filter((e) => e.event === 'reply_delta')
      .map((e) => e.data?.text);
    assert.deepEqual(seen, [], `chat B subscriber should see no chat A events, got ${JSON.stringify(seen)}`);

    subB.close();

    // A new subscriber for chat A now reconnects (no Last-Event-ID) and
    // gets the chat-A event from the replay ring.
    const subA = new SseClient(`${rig.proxyUrl}/api/sidekick/stream?chat_id=A`);
    await subA.start();
    await waitFor(() => subA.events.some((e) => e.data?.text === 'response-to-A'));
    subA.close();
  });

  // T8: state.db row for sidekick session without sessions.json mapping is dropped.
  it('T8: state.db row without sessions.json mapping is excluded from list', async () => {
    rig = await freshRig(rig);

    // S2 exists in state.db but no sessions.json key points to it.
    await rig.seedSession({ id: 'S2', source: 'sidekick', title: 'unmapped', message_count: 5 });
    // (no writeSessionsIndex call → empty index)

    const list = await (await fetch(`${rig.proxyUrl}/api/sidekick/sessions`)).json() as any;
    const ids = (list.sessions || []).map((s: any) => s.chat_id);
    assert.deepEqual(ids, [], `unmapped state.db row should not surface, got ${JSON.stringify(ids)}`);
  });
});

/** Tear down the rig and start a fresh one. Used between tests because
 *  hermes-gateway client is a process-singleton and state.db is path-bound. */
async function freshRig(prev: ProxyRig): Promise<ProxyRig> {
  await prev.cleanup();
  return setupProxyTest();
}
