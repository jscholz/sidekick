/**
 * Integration tests for the sidekick proxy module.
 *
 * Tests run serially — the proxy holds singleton state (the upstream
 * + the SSE multiplexer wired flag), so concurrent tests would step
 * on each other. Each test starts a fresh rig + tears it down.
 *
 * These cover the critical user-facing behaviors after the agent-
 * contract refactor (steps 1-8); see STATUS.md and
 * docs/SIDEKICK_BACKEND_REFACTOR.md for the full architecture
 * context. Pre-step-6 there were 9 WS-shaped tests; this file is the
 * post-step-6 HTTP-shaped subset and is meant to grow.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { startRig } from './proxy-harness.ts';

/** Subscribe to an SSE endpoint and collect parsed envelopes for `ms`
 *  ms, then abort. Returns the envelopes received during the window. */
async function collectEnvelopesFor(
  url: string, ms: number,
): Promise<{ id: string | null; envelope: any }[]> {
  const ac = new AbortController();
  const out: { id: string | null; envelope: any }[] = [];
  const r = await fetch(url, { signal: ac.signal });
  if (!r.ok || !r.body) throw new Error(`SSE fetch failed: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastId: string | null = null;
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const tick = Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((rs) =>
          setTimeout(() => rs({ value: undefined, done: false }), 50),
        ),
      ]);
      const { value, done } = await tick;
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let data = '';
        let id: string | null = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (id) lastId = id;
        if (!data) continue;
        try { out.push({ id, envelope: JSON.parse(data) }); } catch {}
      }
    }
  } finally {
    ac.abort();
    try { reader.releaseLock(); } catch {}
  }
  return out;
}

test('sessions list — gateway endpoint surfaces multi-source rows', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.setGatewaySessions([
      {
        id: 'sk-1',
        created_at: 1700000000,
        metadata: {
          title: 'sidekick chat',
          message_count: 3,
          last_active_at: 1700000060,
          first_user_message: 'hi',
          source: 'sidekick',
          chat_type: 'dm',
        },
      },
      {
        id: 'tg-1',
        created_at: 1700001000,
        metadata: {
          title: 'telegram chat',
          message_count: 5,
          last_active_at: 1700001100,
          first_user_message: "hey what's the weather?",
          source: 'telegram',
          chat_type: 'dm',
        },
      },
    ]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/sessions?limit=10`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sessions.length, 2);
    const sources = body.sessions.map((s: any) => s.source).sort();
    assert.deepEqual(sources, ['sidekick', 'telegram']);

    // ISO timestamp formatting at the proxy boundary (plugin returns
    // unix seconds; proxy reformats for parity with legacy wire shape).
    const tg = body.sessions.find((s: any) => s.source === 'telegram');
    assert.equal(tg.last_active_at, '2023-11-14T22:31:40.000Z');
    assert.equal(tg.first_user_message, "hey what's the weather?");
  } finally {
    await rig.stop();
  }
});

test('sessions list — falls back to channel endpoint on gateway 404', async () => {
  const rig = await startRig({ mode: 'channel-only' });
  try {
    rig.fakeAgent.setSessions([
      {
        id: 'stub-chat-1',
        created_at: 1700000000,
        metadata: {
          title: 'stub agent chat',
          message_count: 2,
          last_active_at: 1700000060,
          first_user_message: 'hello',
        },
      },
    ]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/sessions`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sessions.length, 1);
    // Channel-only fallback stamps source='sidekick' so the composer
    // stays editable in the drawer (main.ts:setComposerReadOnly).
    assert.equal(body.sessions[0].source, 'sidekick');
    assert.equal(body.sessions[0].chat_id, 'stub-chat-1');
  } finally {
    await rig.stop();
  }
});

test('history — proxy forwards items with tool_name preserved', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.setItems('chat-with-tools', [
      { id: 1, role: 'user', content: 'find recent news', created_at: 1700000000 },
      { id: 2, role: 'tool', content: '{"results":[]}', created_at: 1700000005, tool_name: 'web_search' },
      { id: 3, role: 'assistant', content: 'no results', created_at: 1700000010 },
    ]);

    const r = await fetch(`${rig.proxyUrl}/api/sidekick/sessions/chat-with-tools/messages`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.messages.length, 3);
    const toolRow = body.messages.find((m: any) => m.role === 'tool');
    assert.equal(toolRow.toolName, 'web_search',
      `expected toolName='web_search'; got ${JSON.stringify(toolRow)}`);
    // Non-tool rows shouldn't carry an empty toolName field.
    const userRow = body.messages.find((m: any) => m.role === 'user');
    assert.equal(userRow.toolName, undefined);
  } finally {
    await rig.stop();
  }
});

test('delete — proxy cascades through to upstream', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    const r = await fetch(`${rig.proxyUrl}/api/sidekick/sessions/doomed-chat`, {
      method: 'DELETE',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(rig.fakeAgent.hasDeleted('doomed-chat'), true,
      'upstream should have recorded the delete');
  } finally {
    await rig.stop();
  }
});

test('messages — attachments forwarded on /v1/responses request body', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Pre-load a minimal turn so the dispatch terminates promptly.
    rig.fakeAgent.enqueueTurnEvents([
      { event: 'response.completed', data: { type: 'response.completed' } },
    ]);

    const attachments = [
      {
        type: 'image',
        mimeType: 'image/png',
        fileName: 'pic.png',
        content: 'data:image/png;base64,iVBORw0KGgo=',
      },
    ];
    const r = await fetch(`${rig.proxyUrl}/api/sidekick/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'attach-test', text: 'caption me', attachments,
      }),
    });
    assert.equal(r.status, 202);
    // Give the fire-and-forget upstream POST a tick to land.
    await new Promise<void>((rs) => setTimeout(rs, 100));
    assert.equal(rig.fakeAgent.lastResponsesConversation, 'attach-test');
    assert.deepEqual(rig.fakeAgent.lastResponsesAttachments, attachments,
      'upstream should have received the attachments array verbatim');
  } finally {
    await rig.stop();
  }
});

test('SSE multiplexer — POST /messages dispatches via /v1/responses and fans envelopes', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Pre-load the FakeAgent's response queue. /v1/responses will
    // replay these as it streams back.
    rig.fakeAgent.enqueueTurnEvents([
      { event: 'response.in_progress', data: { type: 'response.in_progress' } },
      {
        event: 'response.output_text.delta',
        data: { delta: 'hi back', item_id: 'msg_test_001' },
      },
      { event: 'response.completed', data: { type: 'response.completed' } },
    ]);

    // Open the proxy's SSE channel BEFORE posting so we don't miss
    // the in-turn envelopes. The replay ring would catch a small
    // delay, but tests should be deterministic.
    const ac = new AbortController();
    const sse = fetch(`${rig.proxyUrl}/api/sidekick/stream`, { signal: ac.signal });
    // Give the subscription a tick to attach.
    await new Promise<void>((r) => setTimeout(r, 50));

    // POST a message turn.
    const post = await fetch(`${rig.proxyUrl}/api/sidekick/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'test-chat', text: 'hi' }),
    });
    assert.equal(post.status, 202);
    const ack = await post.json();
    assert.equal(ack.ok, true);

    // The FakeAgent recorded the conversation id off the wire — proves
    // the proxy did call /v1/responses.
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal(rig.fakeAgent.lastResponsesConversation, 'test-chat');

    // Drain the SSE for ~500ms and check we got reply_delta + reply_final
    // tagged with our chat_id.
    const sseRes = await sse;
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 1500;
    let buf = '';
    const events: { type: string; chat_id?: string; text?: string }[] = [];
    while (Date.now() < deadline && events.find((e) => e.type === 'reply_final') === undefined) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: Uint8Array | undefined; done: boolean }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 100),
        ),
      ]);
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { events.push(JSON.parse(data)); } catch {}
      }
    }
    ac.abort();

    const finals = events.filter((e) => e.type === 'reply_final' && e.chat_id === 'test-chat');
    assert.ok(
      finals.length >= 1,
      `expected reply_final for test-chat; saw ${JSON.stringify(events)}`,
    );
  } finally {
    await rig.stop();
  }
});

test('SSE — chat_id filter blocks cross-chat envelopes', async () => {
  const rig = await startRig({ mode: 'gateway' });
  // Open subscribers SEQUENTIALLY (await each fetch before opening the
  // next). Concurrent fetches against the test rig's bare http.Server
  // race in a way that loses the first subscriber's response stream;
  // sequential opens are deterministic and exercise exactly the same
  // fan-out logic in production.
  const acA = new AbortController();
  const acB = new AbortController();
  try {
    const rA = await fetch(`${rig.proxyUrl}/api/sidekick/stream?chat_id=chat-A`, { signal: acA.signal });
    const rB = await fetch(`${rig.proxyUrl}/api/sidekick/stream?chat_id=chat-B`, { signal: acB.signal });
    assert.equal(rA.status, 200);
    assert.equal(rB.status, 200);
    const readerA = rA.body!.getReader();
    const readerB = rB.body!.getReader();
    const dec = new TextDecoder();
    const eventsA: any[] = [];
    const eventsB: any[] = [];

    const drain = async (
      label: 'A' | 'B', reader: ReadableStreamDefaultReader<Uint8Array>,
      bag: any[], deadline: number,
    ) => {
      let buf = '';
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((rs) =>
            setTimeout(() => rs({ value: undefined, done: false }), 50),
          ),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { bag.push(JSON.parse(data)); } catch {}
        }
      }
    };

    // Push events with a flush between so the proxy's subscribeEvents
    // reader processes each frame deterministically.
    await new Promise<void>((r) => setTimeout(r, 100));
    rig.fakeAgent.pushOutOfTurnEvent({
      type: 'notification', chat_id: 'chat-A', kind: 'cron', content: 'hi A',
    });
    await new Promise<void>((r) => setTimeout(r, 200));
    rig.fakeAgent.pushOutOfTurnEvent({
      type: 'notification', chat_id: 'chat-B', kind: 'cron', content: 'hi B',
    });

    const deadline = Date.now() + 1000;
    await Promise.all([
      drain('A', readerA, eventsA, deadline),
      drain('B', readerB, eventsB, deadline),
    ]);

    const aChats = eventsA.map((e) => e.chat_id);
    const bChats = eventsB.map((e) => e.chat_id);
    assert.ok(aChats.every((c) => c === 'chat-A'),
      `subscriber A leaked: ${JSON.stringify(aChats)}`);
    assert.ok(bChats.every((c) => c === 'chat-B'),
      `subscriber B leaked: ${JSON.stringify(bChats)}`);
    assert.equal(aChats.length, 1, `A should have received one (saw ${eventsA.length})`);
    assert.equal(bChats.length, 1, `B should have received one (saw ${eventsB.length})`);
  } finally {
    acA.abort();
    acB.abort();
    await rig.stop();
  }
});

test('SSE — live_only=1 skips ring replay, only forwards live envelopes', async () => {
  // Used by the audio bridge: it opens a fresh subscriber per turn
  // and wants ONLY envelopes broadcast after its connection.
  // Without this opt-out the bridge replays the ring on every turn,
  // re-feeds Aura TTS, and breaks out on a stale reply_final before
  // the actual new agent reply arrives.
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Phase 1: push some envelopes WITHOUT a subscriber so they land
    // in the ring with no live consumer.
    await new Promise<void>((rs) => setTimeout(rs, 50));
    rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'pre-1' });
    rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'pre-2' });
    await new Promise<void>((rs) => setTimeout(rs, 100));

    // Phase 2: open subscriber with live_only=1.
    const seen = await (async () => {
      const ac = new AbortController();
      const out: any[] = [];
      const r = await fetch(
        `${rig.proxyUrl}/api/sidekick/stream?chat_id=c&live_only=1`,
        { signal: ac.signal },
      );
      assert.equal(r.status, 200);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      // Push a 3rd envelope AFTER the subscriber attaches.
      await new Promise<void>((rs) => setTimeout(rs, 100));
      rig.fakeAgent.pushOutOfTurnEvent({
        type: 'notification', chat_id: 'c', content: 'live-3',
      });

      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((rs) =>
            setTimeout(() => rs({ value: undefined, done: false }), 50),
          ),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { out.push(JSON.parse(data)); } catch {}
        }
      }
      ac.abort();
      try { reader.releaseLock(); } catch {}
      return out;
    })();

    const contents = seen.map((e) => e.content);
    assert.ok(!contents.includes('pre-1'),
      `live_only=1 must NOT replay ring entries (saw ${JSON.stringify(contents)})`);
    assert.ok(!contents.includes('pre-2'),
      `live_only=1 must NOT replay ring entries (saw ${JSON.stringify(contents)})`);
    assert.ok(contents.includes('live-3'),
      `live_only=1 must still receive live envelopes (saw ${JSON.stringify(contents)})`);
  } finally {
    await rig.stop();
  }
});

test('SSE — last_event_id query param resumes from the ring (manual reconnect)', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Phase 1: subscribe, push 2 envelopes, capture ids, disconnect.
    const phase1 = await (async () => {
      const ac = new AbortController();
      const out: string[] = [];
      const r = await fetch(`${rig.proxyUrl}/api/sidekick/stream`, { signal: ac.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // Push two events.
      await new Promise<void>((rs) => setTimeout(rs, 50));
      rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'one' });
      rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'two' });
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && out.length < 2) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((rs) =>
            setTimeout(() => rs({ value: undefined, done: false }), 100),
          ),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) out.push(line.slice(3).trim());
          }
        }
      }
      ac.abort();
      try { reader.releaseLock(); } catch {}
      return out;
    })();
    assert.ok(phase1.length >= 2, `phase 1 saw ids ${JSON.stringify(phase1)}`);
    const cursor = phase1[phase1.length - 1];

    // Phase 2: push a 3rd event while disconnected, then reconnect with
    // ?last_event_id=<cursor>. We should ONLY see the 3rd, not 1+2.
    rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'three' });
    await new Promise<void>((rs) => setTimeout(rs, 100));
    const replayed = await collectEnvelopesFor(
      `${rig.proxyUrl}/api/sidekick/stream?last_event_id=${cursor}`, 400,
    );
    const contents = replayed.map((e) => e.envelope.content);
    assert.ok(!contents.includes('one'),
      `cursor honored: 'one' should not replay (saw ${JSON.stringify(contents)})`);
    assert.ok(!contents.includes('two'),
      `cursor honored: 'two' should not replay (saw ${JSON.stringify(contents)})`);
    assert.ok(contents.includes('three'),
      `expected 'three' to replay (saw ${JSON.stringify(contents)})`);
  } finally {
    await rig.stop();
  }
});
