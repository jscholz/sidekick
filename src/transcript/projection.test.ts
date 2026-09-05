/**
 * @fileoverview Pure-projection tests — covers the join between
 * durable, inflight, and pendingSends, the dedup rules, and the sort
 * ordering. The reconciler is exercised in a separate browser smoke;
 * here we only test the data transform.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { project } from './projection.ts';
import { miniMarkdown } from '../util/markdown.ts';
import type { ChatState, ConversationItem, ParleyEnvelope, PendingSend } from './types.ts';

function state(partial: Partial<ChatState>): ChatState {
  return {
    durable: [],
    inflight: [],
    pendingSends: [],
    pagination: { firstId: null, hasMore: false, lastId: null, hasMoreNewer: false },
    decorations: [],
    ...partial,
  };
}

const T0 = 1_747_000_000_000;
function u(id: string, text: string, ts = T0): ConversationItem {
  return { id, parley_id: id, role: 'user', content: text, timestamp: ts };
}
function a(id: string, text: string, ts = T0, toolCalls?: string): ConversationItem {
  return { id, parley_id: id, role: 'assistant', content: text, timestamp: ts, tool_calls: toolCalls };
}
function tool(id: string, callId: string, name: string, content: string, ts = T0): ConversationItem {
  return { id, role: 'tool', content, tool_call_id: callId, tool_name: name, timestamp: ts };
}

describe('project: durable only', () => {
  it('empty state → empty specs', () => {
    assert.deepEqual(project(state({})), []);
  });

  it('user → assistant pair', () => {
    const s = state({ durable: [u('umsg_1', 'hello'), a('msg_1', 'hi', T0 + 1000)] });
    const out = project(s);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'user');
    assert.equal(out[0].key, 'umsg_1');
    assert.equal(out[1].kind, 'assistant');
    assert.equal(out[1].key, 'msg_1');
  });

  it('assistant tool_calls fold into activity row keyed to the preceding user', () => {
    const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }]);
    const s = state({
      durable: [
        u('umsg_1', 'search please'),
        a('msg_1', 'searching...', T0 + 1, tc),
        tool('5', 'c1', 'web_search', '{"results":[]}', T0 + 2),
      ],
    });
    const out = project(s);
    // user (T0) → activity row (T0) → assistant (T0+1) → tool merged into activity row
    const kinds = out.map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'activityRow', 'assistant']);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.key, 'turn:umsg_1');
    assert.equal(ar.tools.length, 1);
    assert.equal(ar.tools[0].callId, 'c1');
    assert.equal(ar.tools[0].name, 'web_search');
    assert.equal(ar.tools[0].result, '{"results":[]}');
    assert.equal(ar.complete, true);
  });

  it('hermes unix-seconds timestamps get normalized to ms', () => {
    const sec = 1_747_000_000;  // < 1e12
    const s = state({ durable: [{ id: 'u1', parley_id: 'umsg_1', role: 'user', content: 'x', timestamp: sec }] });
    const out = project(s);
    assert.equal(out[0].timestamp, sec * 1000);
  });
});

describe('project: inflight', () => {
  it('user_message envelope produces a user bubble when no durable match', () => {
    const env: ParleyEnvelope = { type: 'user_message', chat_id: 'c', message_id: 'umsg_2', text: 'hello' };
    const s = state({ inflight: [env] });
    const out = project(s);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'user');
    assert.equal(out[0].key, 'umsg_2');
    assert.equal(out[0].text, 'hello');
  });

  it('user_message envelope matching durable does not duplicate', () => {
    const s = state({
      durable: [u('umsg_1', 'hi')],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'hi' }],
    });
    const out = project(s);
    assert.equal(out.filter(s => s.kind === 'user').length, 1);
  });

  it('streaming reply_delta concatenates into one assistant bubble; reply_final flips streaming off', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'hel', message_id: 'msg_x' },
        { type: 'reply_delta', chat_id: 'c', text: 'lo', message_id: 'msg_x' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_x' },
      ],
    });
    const out = project(s);
    const ag = out.find(x => x.kind === 'assistant');
    assert.ok(ag && ag.kind === 'assistant');
    assert.equal(ag.text, 'hello');
    assert.equal(ag.streaming, false);
  });

  it('tool_call + tool_result land in an activity row keyed to the in-flight turn', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'web', args: { q: 'x' } },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'web', result: 'ok', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.key, 'turn:umsg_1');
    assert.equal(ar.tools[0].callId, 'c1');
    assert.equal(ar.tools[0].result, 'ok');
    assert.equal(ar.tools[0].durationMs, 42);
    assert.equal(ar.complete, false);
  });

  it('tool_result without a prior tool_call still uses tool_name when present', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'search_files', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result without a name infers common tools from result shape', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: '', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result with placeholder name still infers common tools from result shape', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'tool', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result with placeholder name infers cronjob from scheduled skill result', () => {
    const result = JSON.stringify({
      success: true,
      job: { job_id: 'abc', name: 'R2 Pulse comms check-in', skill: 'comms-sweep' },
      skills: ['comms-sweep'],
    });
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'tool', result, duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'cronjob');
  });

  it('tool_result renames an earlier placeholder tool_call when the result carries the real name', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'tool', args: {} },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'search_files', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
    assert.equal(ar.tools[0].result, '{"total_count":1,"matches":[]}');
  });

  it('ordering: user → activity row → assistant within the same turn', () => {
    const s = state({
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'a', message_id: 'msg_1' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 't', args: {} },
      ],
    });
    const out = project(s);
    const kinds = out.map(s => s.kind);
    // Turn still open (no reply_final): the growing tool strip rides at
    // the very bottom, below the interim reply, followed by the
    // turn-status line (field 2026-09-05).
    assert.deepEqual(kinds, ['user', 'assistant', 'activityRow', 'turnStatus']);
  });

  it('ordering: once the turn is answered the activity row settles between user and reply', () => {
    const s = state({
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'a', message_id: 'msg_1' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 't', args: {} },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 't', result: 'ok' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_1' },
      ],
    });
    const kinds = project(s).map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'activityRow', 'assistant']);
  });

  it('interim final (gateway advisory) owns a bubble but does not close the turn', () => {
    const s = state({
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 't', args: {} },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 't', result: 'ok' },
        { type: 'reply_delta', chat_id: 'c', text: '⚠️ No activity for 5 min.', message_id: 'msg_w', interim: true },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_w', interim: true },
      ],
    });
    const out = project(s);
    const ar = out.find(x => x.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.complete, false);
    assert.deepEqual(out.map(x => x.kind), ['user', 'assistant', 'activityRow', 'turnStatus']);
    // …and a real final closes it.
    s.inflight.push(
      { type: 'reply_delta', chat_id: 'c', text: 'done', message_id: 'msg_1' },
      { type: 'reply_final', chat_id: 'c', message_id: 'msg_1' },
    );
    const out2 = project(s);
    assert.deepEqual(out2.map(x => x.kind), ['user', 'activityRow', 'assistant', 'assistant']);
  });

  it('turn-status line shows the parsed heartbeat while a turn is open, and clears with it', () => {
    const s = state({
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'terminal', args: {} },
      ],
      turnStatus: { text: '⏳ Working — 3 min — iteration 4/60, terminal', at: Date.now() },
    });
    const out = project(s);
    const st = out[out.length - 1];
    assert.ok(st.kind === 'turnStatus');
    assert.equal(st.key, 'turn:status');
    assert.equal(st.text, 'Working · 3 min · iteration 4/60 · terminal');
    // A stale beat (plugin died mid-turn) with no other in-flight signal
    // must not think forever.
    const stale = project(state({
      durable: [u('umsg_1', 'q'), a('msg_1', 'a', T0 + 1)],
      turnStatus: { text: '⏳ Working — 3 min', at: Date.now() - 11 * 60_000 },
    }));
    assert.deepEqual(stale.map(x => x.kind), ['user', 'assistant']);
  });
});

describe('project: pending sends', () => {
  it('pending send not yet acknowledged renders with pending=true', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, source: 'text' };
    const s = state({ pendingSends: [p] });
    const out = project(s);
    assert.equal(out.length, 1);
    const u = out[0];
    assert.ok(u.kind === 'user');
    assert.equal(u.pending, true);
    assert.equal(u.source, 'text');
  });

  it('pending send superseded by inflight user_message echo: only one bubble, source preserved', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, source: 'voice', attachments: [{ dataUrl: 'data:', mimeType: 'image/png' }] };
    const s = state({
      pendingSends: [p],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_x', text: 'hi' }],
    });
    const out = project(s);
    const users = out.filter(s => s.kind === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].kind, 'user');
    // From inflight branch, source + attachments came from pending lookup.
    if (users[0].kind === 'user') {
      assert.equal(users[0].source, 'voice');
      assert.equal(users[0].attachments?.length, 1);
    }
  });

  it('failed pending send: pending=false, failed=true', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, failed: true };
    const out = project(state({ pendingSends: [p] }));
    assert.equal(out.length, 1);
    if (out[0].kind === 'user') {
      assert.equal(out[0].pending, false);
      assert.equal(out[0].failed, true);
    }
  });

  it('inflight reply timestamp never predates the pending user message that started the turn', () => {
    // Regression: the new-user-message branch set currentTurnTs but did
    // NOT advance inflightTs past it (unlike the already-durable branch).
    // When the last durable message is from a PRIOR day, the synthetic
    // anchor (lastTimestamp+1) stays on that prior day, so the streaming
    // assistant bubble inherits a prior-day timestamp → the reconciler's
    // day-boundary calc stamps a stale date on the in-flight bubble that
    // vanishes once it lands durable with the real (today) timestamp.
    const DAY = 86_400_000;
    const TS_PREV = T0;            // last durable message: a prior day
    const TS_NOW = T0 + 2 * DAY;   // pending send: today
    const s = state({
      durable: [u('umsg_old', 'old', TS_PREV), a('msg_old', 'old reply', TS_PREV + 1000)],
      pendingSends: [{ messageId: 'umsg_new', text: 'today msg', sentAt: TS_NOW, source: 'text' }],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_new', text: 'today msg' },
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_new', text: 'streaming reply' },
      ],
    });
    const out = project(s);
    const user = out.find(x => x.kind === 'user' && x.key === 'umsg_new');
    const reply = out.find(x => x.kind === 'assistant' && x.key === 'msg_new');
    assert.ok(user && reply && user.kind === 'user' && reply.kind === 'assistant');
    assert.ok(
      reply.timestamp >= user.timestamp,
      `inflight reply ts (${reply.timestamp}) must not predate user ts (${user.timestamp})`,
    );
    const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    assert.equal(dayKey(reply.timestamp), dayKey(user.timestamp),
      'inflight reply must share the user message\'s calendar day (no stale date sub-line)');
  });
});

describe('project: dedup keys', () => {
  it('parley_id is preferred over numeric id for user key', () => {
    const s = state({ durable: [{ id: 42, parley_id: 'umsg_x', role: 'user', content: 'q', timestamp: T0 }] });
    const out = project(s);
    assert.equal(out[0].key, 'umsg_x');
  });

  it('numeric id falls back when parley_id absent', () => {
    const s = state({ durable: [{ id: 42, role: 'user', content: 'q', timestamp: T0 }] });
    const out = project(s);
    assert.equal(out[0].key, '42');
  });

  it('inflight reply_final does NOT duplicate a durable assistant row that arrived without parley_id (field bug 2026-05-19)', () => {
    // Active-chat dupe scenario: user sent a message, plugin mirrored
    // the assistant row but the link write didn't land (parley_id NULL).
    // Without content-fallback dedup, durable keyed by integer "101" and
    // inflight keyed by "msg_xyz" rendered as two separate bubbles.
    const s = state({
      durable: [
        { id: 100, parley_id: 'umsg_q', role: 'user', content: 'hey test message', timestamp: T0 },
        // Assistant row arrived without parley_id — the bug shape.
        { id: 101, role: 'assistant', content: 'Hey — received.', timestamp: T0 + 1000 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_xyz', text: 'Hey — received.' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_xyz' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1,
      `expected exactly 1 assistant bubble (durable keyed by integer id); `
      + `got ${assistantBubbles.length}: ${JSON.stringify(assistantBubbles.map(a => ({ key: a.key, text: (a as any).text })))}`);
    // The surviving bubble is the durable one (keyed by integer id), not
    // the inflight one — durable is the canonical source once both exist.
    assert.equal(assistantBubbles[0].key, '101');
  });

  it('inflight reply_final preserved when no matching durable assistant row exists (background-race contract)', () => {
    // Counterpart to the dupe test: when durable doesn't have the
    // assistant row yet (background-chat reply landed via SSE but
    // mirror hasn't caught up), the inflight envelope must render.
    const s = state({
      durable: [
        { id: 100, parley_id: 'umsg_q', role: 'user', content: 'hey', timestamp: T0 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_xyz', text: 'Hi back.' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_xyz' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1);
    assert.equal(assistantBubbles[0].key, 'msg_xyz');
    assert.equal((assistantBubbles[0] as any).text, 'Hi back.');
  });

  it('durable-vs-durable: items endpoint returning two assistant rows with same content renders ONE bubble (field bug 2026-05-19)', () => {
    // Server-side bug shape: `parley.db.msg_links` had two rows for
    // the same logical assistant message — one from envelope write-
    // through (parley_id="msg_xyz", real timestamp), one from
    // reconcile Pass 2 fallback (parley_id="legacy:101", timestamp=0
    // because... still unknown). The items endpoint returned both;
    // projection's key-based dedup saw them as different (different
    // parley_ids); both rendered. Result: one user-visible reply
    // duplicated, with one copy showing 01:00 BST (= unix 0 → UTC+1).
    const s = state({
      durable: [
        { id: 100, parley_id: 'umsg_q', role: 'user', content: 'hey test message', timestamp: T0 },
        // Bad duplicate row — timestamp=0.
        { id: 101, parley_id: 'legacy:101', role: 'assistant', content: 'Hey — received.', timestamp: 0 },
        // Good row — real timestamp.
        { id: 102, parley_id: 'msg_xyz', role: 'assistant', content: 'Hey — received.', timestamp: T0 + 1000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1,
      `expected ONE assistant bubble (dedup by content); got ${assistantBubbles.length}: `
      + `${JSON.stringify(assistantBubbles.map(b => ({ key: b.key, ts: b.timestamp, text: (b as any).text })))}`);
    // Winner is the row with the real timestamp (msg_xyz at T0+1000).
    assert.equal(assistantBubbles[0].key, 'msg_xyz');
  });

  it('durable-vs-durable: two assistant rows with same content + same valid timestamp picks the lower id deterministically', () => {
    // Defensive: if BOTH rows have real timestamps that happen to match
    // (e.g. plugin write-through + reconcile Pass 2 fired in the same
    // second), the projection must still emit one bubble — pick by
    // a stable tiebreak so future runs render identically. LOWER id
    // wins: the original row was persisted first (compaction-replay
    // twins, field 2026-07-16).
    const s = state({
      durable: [
        { id: 100, parley_id: 'msg_a', role: 'assistant', content: 'same text', timestamp: T0 + 1000 },
        { id: 101, parley_id: 'msg_b', role: 'assistant', content: 'same text', timestamp: T0 + 1000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1);
    // Lower id wins on tie ("msg_a" < "msg_b" lex order).
    assert.equal(assistantBubbles[0].key, 'msg_a');
  });

  it('durable-vs-durable dedup does NOT collapse genuinely different content', () => {
    const s = state({
      durable: [
        { id: 100, parley_id: 'msg_a', role: 'assistant', content: 'first reply', timestamp: T0 + 1000 },
        { id: 101, parley_id: 'msg_b', role: 'assistant', content: 'second reply', timestamp: T0 + 2000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 2);
  });

  it('inflight reply_final preserved when durable has DIFFERENT-content assistant row without parley_id', () => {
    // Defensive: the content match must be exact. A no-link durable row
    // with text "old reply" must not steal the inflight bubble for
    // "new reply".
    const s = state({
      durable: [
        { id: 100, parley_id: 'umsg_q', role: 'user', content: 'q', timestamp: T0 },
        { id: 101, role: 'assistant', content: 'old reply', timestamp: T0 + 1000 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_new', text: 'new reply' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_new' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 2);
    assert.deepEqual(assistantBubbles.map(b => b.key).sort(), ['101', 'msg_new']);
  });

  it('notification with matching parley_id renders once when durable and inflight both contain it', () => {
    const s = state({
      durable: [
        { id: 101, parley_id: 'notif_1', role: 'assistant', kind: 'cron', content: 'Cron done', timestamp: T0 },
      ],
      inflight: [
        { type: 'notification', chat_id: 'c', kind: 'cron', content: 'Cron done', parley_id: 'notif_1' },
      ],
    });
    const out = project(s);
    const notifications = out.filter(o => o.kind === 'notification');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].key, 'notif_1');
  });
});

describe('project: ordering across turns', () => {
  it('two turns end-to-end: u1 → ar1 → a1 → u2 → ar2 → a2', () => {
    const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }]);
    const s = state({
      durable: [
        u('umsg_1', 'q1', T0),
        a('msg_1', 'a1', T0 + 1000, tc),
        tool('5', 'c1', 't', 'ok', T0 + 2000),
        u('umsg_2', 'q2', T0 + 3000),
        a('msg_2', 'a2', T0 + 4000),
      ],
    });
    const out = project(s);
    const seq = out.map(s => `${s.kind}:${s.key}`);
    assert.deepEqual(seq, [
      'user:umsg_1',
      'activityRow:turn:umsg_1',
      'assistant:msg_1',
      'user:umsg_2',
      'assistant:msg_2',
    ]);
  });

  it('preserves durable server order when adjacent turns share the same timestamp', () => {
    const sameSecond = 1_779_298_560;
    const s = state({
      durable: [
        u('umsg_1', 'Going via a skill is a good idea', sameSecond - 60),
        tool('5', 'c1', 'skill_view', '{"name":"r2-raise-brain"}', sameSecond - 59),
        a('msg_done', 'Done. Split is live.', sameSecond),
        u('umsg_2', '> I preserved the old monolithic skill here', sameSecond),
        tool('6', 'c2', 'skill_view', '{"name":"hermes-agent"}', sameSecond),
        a('msg_good', 'Good push. You were right.', sameSecond),
      ],
    });
    const out = project(s);
    assert.deepEqual(out.map(s => `${s.kind}:${s.key}`), [
      'user:umsg_1',
      'activityRow:turn:umsg_1',
      'assistant:msg_done',
      'user:umsg_2',
      'activityRow:turn:umsg_2',
      'assistant:msg_good',
    ]);
  });
});

describe('project: causal order of the user\'s own turns (field 2026-09-01)', () => {
  // "I had a dictation early fire... when it's sent and I kept talking, I
  // thought that the session was wedged and it wasn't recording my input —
  // until I scrolled up and noticed that the input bubble was actually
  // ABOVE the bubble that had landed."
  //
  // The sort compares wall-clock, but the two sides are stamped by
  // DIFFERENT clocks: the still-optimistic bubble carries the CLIENT's
  // Date.now() at mint, the message it follows carries the SERVER's
  // created_at once its echo / durable row lands. Phone-vs-host skew (or
  // a state.db row stamped at turn-END batch write) puts the OLDER
  // message later on the number line and the bubbles flip — which reads
  // exactly like the app stopped listening.
  //
  // Ordering between two of HIS turns is causal, not chronological. These
  // pin the invariant: a bubble minted after a message was sent renders
  // BELOW it, whichever way the clocks are skewed.
  const CLIENT_NOW = T0;
  const SKEW = 5_000;                                  // server runs ahead
  const KEY_A = `umsg_${CLIENT_NOW - 2000}_aaaaaaaa`;  // sent 2s ago
  const KEY_B = `umsg_${CLIENT_NOW}_bbbbbbbb`;         // being spoken now
  const KEY_C = `umsg_${CLIENT_NOW + 900}_cccccccc`;   // and the one after
  // A prior turn so the chat isn't fresh (matches the field shape).
  const prior = (): ConversationItem[] => [
    u('umsg_prior', 'earlier q', CLIENT_NOW - 120_000),
    a('msg_prior', 'earlier a', CLIENT_NOW - 115_000),
  ];
  const userOrder = (s: ChatState): string[] =>
    project(s).filter(x => x.kind === 'user').map(x => x.key);

  it('new bubble sits BELOW the just-sent message when the server stamps it LATER than the client clock', () => {
    const s = state({
      durable: [
        ...prior(),
        // The utterance that landed — server's created_at is 5s ahead of
        // this device's clock.
        { id: 3, parley_id: KEY_A, role: 'user', content: 'first utterance', timestamp: CLIENT_NOW + SKEW },
      ],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: KEY_A, text: 'first utterance' }],
      // He kept talking: bubble minted client-side, before the skewed stamp.
      pendingSends: [{ messageId: KEY_B, text: 'second utterance', sentAt: CLIENT_NOW, source: 'voice' }],
    });
    assert.deepEqual(userOrder(s), ['umsg_prior', KEY_A, KEY_B],
      'the bubble he is still speaking must render below the one that just landed');
  });

  it('holds once the new utterance has its OWN echo (still optimistic)', () => {
    // Same shape one hop later: he committed the second utterance too, its
    // user_message echo is in the buffer, and the pendingSend hasn't
    // cleared yet — that branch reads pend.sentAt directly.
    const s = state({
      durable: [
        ...prior(),
        { id: 3, parley_id: KEY_A, role: 'user', content: 'first utterance', timestamp: CLIENT_NOW + SKEW },
      ],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: KEY_A, text: 'first utterance' },
        { type: 'user_message', chat_id: 'c', message_id: KEY_B, text: 'second utterance' },
      ],
      pendingSends: [{ messageId: KEY_B, text: 'second utterance', sentAt: CLIENT_NOW, source: 'voice' }],
    });
    assert.deepEqual(userOrder(s), ['umsg_prior', KEY_A, KEY_B]);
  });

  it('three utterances in a row with late echoes keep strict send order', () => {
    // A and B have landed durably (both stamped ahead by the server's
    // clock), C is still the live bubble. Nth must sit below (N-1)th.
    const s = state({
      durable: [
        ...prior(),
        { id: 3, parley_id: KEY_A, role: 'user', content: 'one', timestamp: CLIENT_NOW + SKEW },
        { id: 4, parley_id: KEY_B, role: 'user', content: 'two', timestamp: CLIENT_NOW + SKEW + 6 },
      ],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: KEY_A, text: 'one' },
        { type: 'user_message', chat_id: 'c', message_id: KEY_B, text: 'two' },
      ],
      pendingSends: [{ messageId: KEY_C, text: 'three', sentAt: CLIENT_NOW + 900, source: 'voice' }],
    });
    assert.deepEqual(userOrder(s), ['umsg_prior', KEY_A, KEY_B, KEY_C]);
  });

  it('two optimistic bubbles in a row stay in mint order behind a late-stamped send', () => {
    // Nothing durable for B or C yet — both are pendingSends. They must
    // fall below A AND keep their own order relative to each other.
    const s = state({
      durable: [
        ...prior(),
        { id: 3, parley_id: KEY_A, role: 'user', content: 'one', timestamp: CLIENT_NOW + SKEW },
      ],
      pendingSends: [
        { messageId: KEY_B, text: 'two', sentAt: CLIENT_NOW, source: 'voice' },
        { messageId: KEY_C, text: 'three', sentAt: CLIENT_NOW + 900, source: 'voice' },
      ],
    });
    assert.deepEqual(userOrder(s), ['umsg_prior', KEY_A, KEY_B, KEY_C]);
  });

  it('skew the OTHER way (server stamps EARLIER than the client) is still ordered', () => {
    const s = state({
      durable: [
        ...prior(),
        { id: 3, parley_id: KEY_A, role: 'user', content: 'first utterance', timestamp: CLIENT_NOW - SKEW },
      ],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: KEY_A, text: 'first utterance' }],
      pendingSends: [{ messageId: KEY_B, text: 'second utterance', sentAt: CLIENT_NOW, source: 'voice' }],
    });
    assert.deepEqual(userOrder(s), ['umsg_prior', KEY_A, KEY_B]);
  });

  it('the floor never drags a bubble below a send it PROVABLY precedes', () => {
    // Guard against over-applying the rule ("float every optimistic bubble
    // to the tail"). B was minted before C; a durable refresh delivered C
    // first while B is still optimistic. B stays above C — the client mint
    // embedded in both keys is the one clock that settles it.
    const s = state({
      durable: [
        ...prior(),
        { id: 4, parley_id: KEY_C, role: 'user', content: 'three', timestamp: CLIENT_NOW + SKEW },
      ],
      pendingSends: [{ messageId: KEY_B, text: 'two', sentAt: CLIENT_NOW, source: 'voice' }],
    });
    assert.deepEqual(userOrder(s), ['umsg_prior', KEY_B, KEY_C]);
  });

  it('the floor is ordering-only: no bubble added, dropped or re-keyed', () => {
    const s = state({
      durable: [
        ...prior(),
        { id: 3, parley_id: KEY_A, role: 'user', content: 'first utterance', timestamp: CLIENT_NOW + SKEW },
      ],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: KEY_A, text: 'first utterance' }],
      pendingSends: [{ messageId: KEY_B, text: 'second utterance', sentAt: CLIENT_NOW, source: 'voice' }],
    });
    const users = project(s).filter(x => x.kind === 'user');
    assert.equal(users.length, 3, 'the echo must still dedup against its durable row');
    const b = users[2];
    assert.ok(b.kind === 'user');
    assert.equal(b.pending, true, 'still an optimistic bubble');
    assert.equal(b.source, 'voice', 'pendingSend metadata rides through');
  });
});

describe('project: user double-write dedup (time-windowed)', () => {
  it('collapses two identical user rows written seconds apart (the backend double-write)', () => {
    // Field 2026-05-27: native write (44459) + platform-ingest twin (44461),
    // same content, ~4s apart, different ids → must render ONE bubble.
    const s = state({ durable: [
      u('44459', 'Hey. I migrated you from Cortex to FontBrain.', T0),
      u('44461', 'Hey. I migrated you from Cortex to FontBrain.', T0 + 4000),
    ]});
    const out = project(s);
    const userSpecs = out.filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length}`);
  });

  it('PRESERVES legitimate verbatim repeats far apart (voice-test phrases)', () => {
    // "1 2 3 ... 20" said again 2 minutes later is a real repeat, NOT a dup.
    const s = state({ durable: [
      u('m1', '1 2 3 4 5', T0),
      u('m2', '1 2 3 4 5', T0 + 120_000),
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `far-apart repeats must both survive, got ${userSpecs.length}`);
  });

  it('three rapid duplicates collapse to one; a later legit repeat survives', () => {
    const s = state({ durable: [
      u('d1', 'over', T0),
      u('d2', 'over', T0 + 2000),
      u('d3', 'over', T0 + 5000),
      u('later', 'over', T0 + 300_000),  // 5 min later → legit
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `expected 2 (one cluster + one legit), got ${userSpecs.length}`);
  });
});

describe('project: envelope-shadowed user twin (reconcile-lag window)', () => {
  it('drops the unannotated state.db twin of a umsg_ envelope copy (turn-length skew)', () => {
    // Field 2026-07-04: user sent at 11:47:54 (envelope-only copy with a
    // umsg_* parley_id + epoch-ms id), state.db row batch-written at
    // turn END 11:49:25 — 91s apart, far beyond the 30s double-write
    // window below. Until the background reconcile links them, the items
    // endpoint serves BOTH → two user bubbles with different timestamps.
    const sent = T0;
    const turnEnd = T0 + 91_000;
    const s = state({ durable: [
      { id: String(sent), parley_id: 'umsg_1783162074267_x', role: 'user', content: 'single hand the boat?', timestamp: sent },
      { id: '67182', role: 'user', content: 'single hand the boat?', timestamp: turnEnd },
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length}`);
    assert.equal(userSpecs[0].key, 'umsg_1783162074267_x',
      'the envelope copy must win — true send time, and its key stays stable once the link heals');
  });

  it('pairs 1:1 — a legit repeat with only ONE unlinked state twin keeps two bubbles', () => {
    // Two real sends of the same text; the second turn's state row isn't
    // reconciled yet (unannotated) while the first is already linked. The
    // shadow pass must drop only the second send's twin, not fold the
    // repeat into one bubble.
    const s = state({ durable: [
      { id: '67100', parley_id: 'umsg_first', role: 'user', content: 'ok', timestamp: T0 },
      { id: String(T0 + 120_000), parley_id: 'umsg_second', role: 'user', content: 'ok', timestamp: T0 + 120_000 },
      { id: '67200', role: 'user', content: 'ok', timestamp: T0 + 180_000 },
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `expected 2 bubbles (linked + envelope), got ${userSpecs.length}`);
  });

  it('does NOT shadow when the skew exceeds the turn-length bound', () => {
    // An ancient envelope copy must never swallow a fresh identical send —
    // beyond the bound they are independent messages.
    const s = state({ durable: [
      { id: String(T0), parley_id: 'umsg_old', role: 'user', content: 'hi', timestamp: T0 },
      { id: '67300', role: 'user', content: 'hi', timestamp: T0 + 45 * 60_000 },
    ]});
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `45-min-apart rows are independent, got ${userSpecs.length}`);
  });
});

describe('project: heal-rekeyed user twin vs live client state (field 2026-07-15)', () => {
  // Field shape (chat parley:a7d55680…, dump missing-bubble-repro-20260715):
  // the plugin's reconcile pass DOUBLE-persisted two user messages, appending
  // a second state.db row per message with a heal-minted umsg_* key whose
  // embedded mint time PREDATES the send. Same content, same timestamp,
  // higher row id → the durable dedup's id tiebreak picks the HEAL copy and
  // drops the client-minted key. But the live client's inflight echo and
  // pendingSend are keyed by its OWN mint — if that key loses, the echo
  // walk re-adds it as a ghost bubble at the transcript tail. Real ids +
  // timestamps below (unix seconds, hermes shape).
  const SENT_SEC = 1_784_148_027;                       // 20:40:27
  const CLIENT_KEY = 'umsg_1784148027542_jy4tqfcm';     // row 74399 (client mint)
  const HEAL_KEY = 'umsg_1784147961892_hfg8d15d';       // row 74532 (heal mint, predates send)
  const TEXT = 'can you delete pls?';
  const dupPair = (): ConversationItem[] => [
    { id: 74399, parley_id: CLIENT_KEY, role: 'user', content: TEXT, timestamp: SENT_SEC },
    { id: 74532, parley_id: HEAL_KEY, role: 'user', content: TEXT, timestamp: SENT_SEC },
  ];

  it('inflight echo keyed by the dropped duplicate does NOT re-add a ghost bubble', () => {
    const s = state({
      durable: dupPair(),
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: CLIENT_KEY, text: TEXT },
      ] as ParleyEnvelope[],
    });
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length} (${userSpecs.map(u => u.key).join(', ')})`);
    assert.equal(userSpecs[0].key, CLIENT_KEY,
      'the key the client already knows must win the dedup — inflight/pendingSend join off it, and the DOM node keeps its identity');
  });

  it('pendingSend keyed by the dropped duplicate does NOT re-add a pending ghost', () => {
    const s = state({
      durable: dupPair(),
      pendingSends: [{ messageId: CLIENT_KEY, text: TEXT, sentAt: SENT_SEC * 1000 + 542 }],
    });
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length}`);
    assert.equal(userSpecs[0].key, CLIENT_KEY);
    assert.ok(!userSpecs[0].pending, 'durable covers the send — the bubble must not regress to pending');
  });

  it('echo + pendingSend + full turn envelopes still land on exactly one bubble per message', () => {
    // Both field messages at once, mid-live shape: durable refresh delivered
    // the heal twins while the echoes were still in inflight and the second
    // send's optimistic row hadn't cleared.
    const s = state({
      durable: [
        { id: 74397, parley_id: 'umsg_1784147977585_8ed1ppse', role: 'user', content: 'did this turn die?', timestamp: 1_784_147_977 },
        { id: 74530, parley_id: 'umsg_1784147959469_mqcjttgj', role: 'user', content: 'did this turn die?', timestamp: 1_784_147_977 },
        ...dupPair(),
        { id: 74402, parley_id: 'msg_ab2a043662146c9ebbdf', role: 'assistant', content: 'Deleted and verified all four are gone. 🧹', timestamp: 1_784_148_044 },
      ],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1784147977585_8ed1ppse', text: 'did this turn die?' },
        { type: 'user_message', chat_id: 'c', message_id: CLIENT_KEY, text: TEXT },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_ab2a043662146c9ebbdf', text: 'Deleted and verified all four are gone. 🧹' },
      ] as ParleyEnvelope[],
      pendingSends: [{ messageId: CLIENT_KEY, text: TEXT, sentAt: SENT_SEC * 1000 + 542 }],
    });
    const out = project(s);
    for (const text of ['did this turn die?', TEXT]) {
      const bubbles = out.filter(x => x.kind === 'user' && x.text === text);
      assert.equal(bubbles.length, 1, `"${text}": expected 1 bubble, got ${bubbles.length} (${bubbles.map(b => b.key).join(', ')})`);
    }
  });

  it('replayed echo for a finalized turn whose durable copy survives ONLY under the heal key is content-shadowed', () => {
    // Bounded tail-page merge can evict the client-keyed row entirely
    // (mergeTailRefresh keeps the page's copy — the heal twin). An SSE
    // reconnect then replays the turn's envelopes with the ORIGINAL key:
    // no key match, but durable owns the bubble — the echo must not fork
    // a ghost. Gated on the turn being finalized in the same replay so a
    // genuinely new send (durable not caught up) still renders.
    const s = state({
      durable: [
        { id: 74532, parley_id: HEAL_KEY, role: 'user', content: TEXT, timestamp: SENT_SEC },
        { id: 74402, parley_id: 'msg_ab2a043662146c9ebbdf', role: 'assistant', content: 'Deleted and verified all four are gone. 🧹', timestamp: 1_784_148_044 },
      ],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: CLIENT_KEY, text: TEXT },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_replayed_final', text: '' },
      ] as ParleyEnvelope[],
    });
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 1, `expected 1 user bubble, got ${userSpecs.length} (${userSpecs.map(u => u.key).join(', ')})`);
    assert.equal(userSpecs[0].key, HEAL_KEY, 'durable owns the bubble when the client key is gone from durable');
  });

  it('content-shadow does NOT eat a genuinely new identical send (turn not finalized)', () => {
    // Same text as an already-persisted message, sent again while its turn
    // is still open — the fresh echo is the only copy of the NEW send and
    // must render alongside the durable bubble of the OLD one.
    const s = state({
      durable: [
        { id: 74532, parley_id: HEAL_KEY, role: 'user', content: TEXT, timestamp: SENT_SEC },
        { id: 74402, parley_id: 'msg_ab2a043662146c9ebbdf', role: 'assistant', content: 'ok done', timestamp: 1_784_148_044 },
      ],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1784148200000_fresh', text: TEXT },
      ] as ParleyEnvelope[],
    });
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `new send must render, got ${userSpecs.length} (${userSpecs.map(u => u.key).join(', ')})`);
  });

  it('replay with echoes for BOTH copies of a legit repeat keeps both bubbles', () => {
    // Two real sends of the same text; durable holds both, replay carries
    // both echoes + finals. Key-covered echoes must consume their own
    // durable twins so the content-shadow never collapses the repeat.
    const s = state({
      durable: [
        { id: '70001', parley_id: 'umsg_1784147000000_a', role: 'user', content: 'ok', timestamp: 1_784_147_000 },
        { id: '70002', parley_id: 'msg_r1', role: 'assistant', content: 'first', timestamp: 1_784_147_010 },
        { id: '70003', parley_id: 'umsg_1784147100000_b', role: 'user', content: 'ok', timestamp: 1_784_147_100 },
        { id: '70004', parley_id: 'msg_r2', role: 'assistant', content: 'second', timestamp: 1_784_147_110 },
      ],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1784147000000_a', text: 'ok' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_r1', text: 'first' },
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1784147100000_b', text: 'ok' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_r2', text: 'second' },
      ] as ParleyEnvelope[],
    });
    const userSpecs = project(s).filter(x => x.kind === 'user');
    assert.equal(userSpecs.length, 2, `legit repeat must keep both bubbles, got ${userSpecs.length}`);
  });
});

describe('project: compaction-replay durable twins (field 2026-07-16)', () => {
  // Field shape (chat 20249e46…, session 20260715_133109): hermes-core's
  // in-place compaction re-flushed the rebuilt context into the same
  // session — verbatim copies of every recent message, UNANNOTATED
  // (parley_id null; the plugin heal now refuses to link/insert for
  // them). The asymmetry is real and matters: replayed USER rows keep
  // their original timestamps, replayed ASSISTANT rows are re-stamped
  // with the flush time. The old "highest timestamp, then highest id"
  // winner rule therefore picked the replay copy on both sides — the
  // assistant bubble tore away from its turn to the flush-time cluster
  // at the tail (rendered as "missing user bubble" mid-conversation),
  // and the user bubble lost its umsg_* key. Real ids/timestamps below.
  const SENT = 1_784_208_102;      // user send
  const REPLIED = 1_784_208_309;   // original assistant reply
  const FLUSH = 1_784_208_910;     // compaction re-flush batch stamp
  const JOHN = 'Hey. My name is John. I’m the CEO of R2.';
  const REPEATBACK = '## Daniel’s repeatback\n\n> I understand the technical development story.';
  const replayShape = (): ConversationItem[] => [
    { id: 75950, parley_id: 'umsg_1784208100938_j9hwifw1', role: 'user', content: JOHN, timestamp: SENT },
    { id: 75967, parley_id: 'msg_852640f789b8b3c0f437', role: 'assistant', content: REPEATBACK, timestamp: REPLIED },
    { id: 76010, parley_id: null, role: 'user', content: JOHN, timestamp: SENT },
    { id: 76027, parley_id: null, role: 'assistant', content: REPEATBACK, timestamp: FLUSH },
  ];

  it('assistant winner is the annotated ORIGINAL row, not the flush-restamped replay', () => {
    const specs = project(state({ durable: replayShape() }));
    const assistants = specs.filter(x => x.kind === 'assistant');
    assert.equal(assistants.length, 1, `expected 1 assistant bubble, got ${assistants.length}`);
    assert.equal(assistants[0].key, 'msg_852640f789b8b3c0f437',
      'the annotated original must win — its key matches pins/anchors/inflight and its timestamp keeps the bubble in its turn');
    assert.equal(assistants[0].timestamp, REPLIED * 1000);
  });

  it('user winner is the annotated ORIGINAL row, not the unannotated replay', () => {
    const specs = project(state({ durable: replayShape() }));
    const users = specs.filter(x => x.kind === 'user');
    assert.equal(users.length, 1, `expected 1 user bubble, got ${users.length}`);
    assert.equal(users[0].key, 'umsg_1784208100938_j9hwifw1');
  });

  it('turn stays adjacent: user then assistant, in send order', () => {
    const specs = project(state({ durable: replayShape() }));
    assert.deepEqual(specs.map(s => s.kind), ['user', 'assistant']);
    assert.ok(specs[0].timestamp < specs[1].timestamp, 'reply must sort after its prompt');
  });

  it('epoch-zero duplicate still loses to a real-wall-clock copy (original tiebreak intent)', () => {
    const specs = project(state({
      durable: [
        { id: 100, parley_id: 'msg_orig', role: 'assistant', content: 'same text', timestamp: 0 },
        { id: 200, parley_id: null, role: 'assistant', content: 'same text', timestamp: REPLIED },
      ],
    }));
    const assistants = specs.filter(x => x.kind === 'assistant');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].key, '200', 'a row rendering at epoch time must lose to one with a real timestamp');
  });
});

describe('project: byte-identical assistant repeats (field 2026-07-23, /reasoning)', () => {
  // Field shape: the /reasoning slash command produces BYTE-IDENTICAL
  // assistant replies on every invocation (same settings → same text).
  // The old pickDurableContentWinners collapsed identical-content
  // assistant rows to ONE winner across the whole window unconditionally
  // — built for reconcile-artifact twins, never anticipating legitimate
  // repeats — and since 07-16 the winner was the EARLIEST copy, so every
  // newer identical reply vanished after the durable merge. The fix
  // windows the collapse the same way the user-side dedup does.
  const REASONING_REPLY = '**Reasoning effort:** high\n**Verbosity:** low\n\n'
    + 'Current model: gpt-5.5 · reasoning summaries on.';

  it('two byte-identical annotated replies minutes apart BOTH render (the /reasoning bug)', () => {
    const s = state({ durable: [
      u('umsg_r1', '/reasoning', T0),
      a('msg_r1', REASONING_REPLY, T0 + 1000),
      u('umsg_r2', '/reasoning', T0 + 300_000),
      a('msg_r2', REASONING_REPLY, T0 + 301_000),
    ]});
    const assistants = project(s).filter(x => x.kind === 'assistant');
    assert.equal(assistants.length, 2,
      `far-apart identical replies are legitimate repeats — both must render, got ${assistants.length}`);
    assert.deepEqual(assistants.map(b => b.key), ['msg_r1', 'msg_r2']);
    assert.equal(assistants[1].timestamp, (T0 + 301_000));
  });

  it('three identical annotated replies within 30s collapse to one (earliest / lowest id)', () => {
    const s = state({ durable: [
      a('msg_a', 'dup burst', T0),
      a('msg_b', 'dup burst', T0 + 5_000),
      a('msg_c', 'dup burst', T0 + 10_000),
    ]});
    const assistants = project(s).filter(x => x.kind === 'assistant');
    assert.equal(assistants.length, 1, `near-simultaneous twins collapse, got ${assistants.length}`);
    assert.equal(assistants[0].key, 'msg_a');
  });

  it('unannotated replay copy 10min later collapses into the annotated original (artifact drop, any distance)', () => {
    // Compaction-replay shape: the copy is re-stamped far outside the
    // 30s cluster window, so only the timestamp-blind artifact rule
    // can catch it — annotated (client-keyed) beats unannotated.
    const s = state({ durable: [
      { id: 500, parley_id: 'msg_orig9', role: 'assistant', content: 'replayed reply', timestamp: T0 + 1000 },
      { id: 900, parley_id: null, role: 'assistant', content: 'replayed reply', timestamp: T0 + 601_000 },
    ]});
    const assistants = project(s).filter(x => x.kind === 'assistant');
    assert.equal(assistants.length, 1, `replay copy must fold into the original, got ${assistants.length}`);
    assert.equal(assistants[0].key, 'msg_orig9');
    assert.equal(assistants[0].timestamp, T0 + 1000, 'original renders at its own timestamp');
  });

  it('all-legacy group with identical content 5min apart keeps BOTH (history-chat guard)', () => {
    // Pre-write-through chats are entirely legacy: rows — identical
    // far-apart repeats there are legitimate; with no client-keyed row
    // in the group the artifact rule must stand down and let the 30s
    // window decide.
    const s = state({ durable: [
      { id: 1, parley_id: 'legacy:1', role: 'assistant', content: 'ok', timestamp: T0 },
      { id: 2, parley_id: 'legacy:2', role: 'assistant', content: 'ok', timestamp: T0 + 300_000 },
    ]});
    const assistants = project(s).filter(x => x.kind === 'assistant');
    assert.equal(assistants.length, 2, `all-legacy far-apart repeats must both render, got ${assistants.length}`);
  });
});

describe('notification update path renders markdown (not plaintext)', () => {
  // Regression: updateNotification used to overwrite the bubble's .text with
  // escapeHtml(text).replace(/\n/g,'<br>') on every reconcile pass, flattening
  // the markdown-rendered bubble back to literal **bold** / `code` / - bullets.
  // The fix mirrors updateAssistant: re-render via miniMarkdown. This asserts
  // the exact HTML the update path now writes (renderNotificationHtml ===
  // miniMarkdown(text)) contains rendered markup, not the raw source tokens.
  const cronText = '**Done.** Built `widget` and:\n- item one\n- item two';

  it('produces rendered markup, not literal markdown source', () => {
    const html = miniMarkdown(cronText);
    assert.match(html, /<strong>Done\.<\/strong>/, 'bold must render to <strong>');
    assert.match(html, /<code>widget<\/code>/, 'inline code must render to <code>');
    assert.match(html, /<li>item one<\/li>/, 'bullets must render to <li>');
    assert.match(html, /<ul>/, 'bullet block must be wrapped in <ul>');
    assert.doesNotMatch(html, /\*\*Done\.\*\*/, 'must not leave literal ** bold markers');
    assert.doesNotMatch(html, /^- item|\n- item/, 'must not leave literal - bullet markers');
  });

  it('empty notification text is safe', () => {
    // updateNotification coerces undefined → '' before calling miniMarkdown,
    // which yields a harmless empty paragraph (same as the assistant path).
    const empty: string | undefined = undefined;
    assert.equal(miniMarkdown(empty || ''), '<p></p>');
  });
});

describe('project: gap (discontinuity placeholder)', () => {
  // A `role:'gap'` durable row marks a KNOWN discontinuity between two
  // non-contiguous runs (e.g. a pin window spliced alongside the tail).
  // The projection must emit a 'gap' spec carrying the boundary ids so
  // the reconciler can render an inline "…" the user can load — making
  // the missing range VISIBLE instead of a silent hole (the #223 /
  // missing-user-bubble class). Failing-first: before the projection
  // learned about role:'gap', the marker fell through the durable walk
  // and produced NO spec, so two non-adjacent turns rendered as if
  // adjacent — exactly the lost-user-bubble symptom.
  function gap(ts: number): ConversationItem {
    return { id: `gapmark_${ts}`, role: 'gap', content: '', timestamp: ts };
  }

  it('emits a gap spec between two segments, carrying both boundary ids', () => {
    const s = state({
      durable: [
        u('umsg_1', 'older q', T0),
        a('msg_1', 'older a', T0 + 1),
        gap(T0 + 2),
        u('umsg_9', 'newer q', T0 + 3),
        a('msg_9', 'newer a', T0 + 4),
      ],
    });
    const out = project(s);
    const kinds = out.map(x => x.kind);
    assert.deepEqual(kinds, ['user', 'assistant', 'gap', 'user', 'assistant']);
    const g = out.find(x => x.kind === 'gap');
    assert.ok(g && g.kind === 'gap', 'a gap spec must be emitted');
    assert.equal(g.olderId, 'msg_1', 'olderId = id of the run above the gap');
    assert.equal(g.newerId, 'umsg_9', 'newerId = id of the run below the gap');
    assert.equal(g.key, 'gap:msg_1:umsg_9');
  });

  it('gap at the head carries null olderId', () => {
    const s = state({ durable: [gap(T0 - 1), u('umsg_1', 'q', T0), a('msg_1', 'a', T0 + 1)] });
    const g = project(s).find(x => x.kind === 'gap');
    assert.ok(g && g.kind === 'gap');
    assert.equal(g.olderId, null);
    assert.equal(g.newerId, 'umsg_1');
  });

  it('gap at the tail carries null newerId', () => {
    const s = state({ durable: [u('umsg_1', 'q', T0), a('msg_1', 'a', T0 + 1), gap(T0 + 2)] });
    const g = project(s).find(x => x.kind === 'gap');
    assert.ok(g && g.kind === 'gap');
    assert.equal(g.olderId, 'msg_1');
    assert.equal(g.newerId, null);
  });

  it('no gap row → no gap spec (inert for the normal contiguous transcript)', () => {
    const s = state({ durable: [u('umsg_1', 'q', T0), a('msg_1', 'a', T0 + 1)] });
    assert.equal(project(s).some(x => x.kind === 'gap'), false);
  });
});

describe('decorations (owner-scoped system lines, hardening phase 4)', () => {
  it('projects decorations as keyed systemLine specs interleaved by timestamp', () => {
    const s = state({
      durable: [u('umsg_1', 'question', T0), a('msg_1', 'answer', T0 + 2000)],
      decorations: [{ key: 'deco_1', kind: 'system', text: 'Model: gpt-5.5', timestamp: T0 + 1000 }],
    });
    const specs = project(s);
    const kinds = specs.map(x => x.kind);
    assert.deepEqual(kinds, ['user', 'systemLine', 'assistant'], 'system line slots between the rows by timestamp');
    const line = specs[1];
    assert.equal(line.kind, 'systemLine');
    assert.equal(line.key, 'deco_1', 'stable reconcile key rides through');
    assert.equal((line as any).text, 'Model: gpt-5.5');
  });

  it('same-ms ties render the system line AFTER the row it annotates', () => {
    const s = state({
      durable: [u('umsg_1', 'q', T0)],
      decorations: [{ key: 'deco_2', kind: 'system', text: 'New chat started', timestamp: T0 }],
    });
    const kinds = project(s).map(x => x.kind);
    assert.deepEqual(kinds, ['user', 'systemLine']);
  });

  it('decorations survive a durable replace (setDurable-shape input)', () => {
    // The bucket is orthogonal: projecting with fresh durable rows and
    // the SAME decorations still yields the line exactly once.
    const deco = [{ key: 'deco_3', kind: 'system' as const, text: 'note', timestamp: T0 + 10 }];
    const before = project(state({ durable: [u('umsg_1', 'q', T0)], decorations: deco }));
    const after = project(state({ durable: [u('umsg_1', 'q', T0), a('msg_2', 'a', T0 + 5000)], decorations: deco }));
    assert.equal(before.filter(x => x.kind === 'systemLine').length, 1);
    assert.equal(after.filter(x => x.kind === 'systemLine').length, 1);
  });
});


describe('local thinking placeholder (latency B1a, 2026-07-13)', () => {
  const pending = (id: string, sentAt: number, failed = false): PendingSend =>
    ({ messageId: id, text: 'q', source: 'text', sentAt, failed });
  // Prior turn giving the chat agent presence (first-turn gate). Durable
  // rows use UNIX SECONDS like the live items endpoint — the placeholder
  // math must survive the seconds→ms normalization boundary.
  const nowSec = () => Math.floor(Date.now() / 1000);
  const priorTurn = () => [
    u('umsg_q1', 'q1', nowSec() - 60),
    a('msg_e1', 'echo1', nowSec() - 55),
  ];

  it('live send in an ongoing chat → streaming placeholder right after its user bubble', () => {
    const now = Date.now();
    const out = project(state({
      durable: priorTurn(),
      pendingSends: [pending('umsg_p1', now - 500)],
    }));
    assert.deepEqual(out.map(x => x.kind), ['user', 'assistant', 'user', 'assistant']);
    const ph = out[3];
    assert.equal(ph.key, 'pending:turn:umsg_p1');
    assert.equal((ph as any).streaming, true);
    assert.equal(ph.timestamp, now - 500 + 1);
  });

  it('first-turn gate: no placeholder before the agent has any row in the chat', () => {
    // The placeholder is DOM-indistinguishable from a real agent reply;
    // in a fresh chat every "first agent reply" consumer would bind to
    // it (mark-unread wrote pending:turn:* activity rows in the field).
    const now = Date.now();
    const out = project(state({ pendingSends: [pending('umsg_p0', now - 500)] }));
    // The bottom turn-status line (a .line.system row, NOT an agent
    // bubble) is the turn-1 feedback instead — no pending:turn:* spec.
    assert.deepEqual(out.map(x => x.kind), ['user', 'turnStatus']);
    assert.ok(!out.some(x => x.key.startsWith('pending:turn:')));
    assert.equal((out[1] as any).text, 'Thinking');
  });

  it('persists across the user_message echo (pendingSend cleared, no reply yet)', () => {
    // handleUserMessage clears the optimistic send when the echo lands —
    // well BEFORE the model streams. The dots must ride the echo, or
    // B1a only covers the POST→echo hop instead of the dead-air window.
    const s = state({
      durable: priorTurn(),
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_p2', text: 'q' }],
    });
    const out = project(s);
    const ph = out[out.length - 1];
    assert.equal(ph.key, 'pending:turn:umsg_p2');
    assert.equal((ph as any).streaming, true);
  });

  it('suppressed once the agent is visibly active (real streaming bubble)', () => {
    const s = state({
      durable: priorTurn(),
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_p3', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'thinking about it', message_id: 'msg_r' },
      ],
    });
    const out = project(s);
    assert.equal(out.some(x => x.key === 'pending:turn:umsg_p3'), false, 'placeholder must yield to the real bubble');
    assert.equal(out.some(x => x.kind === 'assistant' && (x as any).streaming), true);
  });

  it('suppressed by an in-flight activity row (tool-using turn)', () => {
    const s = state({
      durable: priorTurn(),
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_p4', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'web', args: {} },
      ],
    });
    assert.equal(project(s).some(x => x.key === 'pending:turn:umsg_p4'), false);
  });

  it('no ghost dots after reply_final while the pendingSend lingers (multi-turn regression)', () => {
    // Exact failing sequence from the two-send smoke race: turn 1 is
    // durable; turn 2's send is still in pendingSends when its echo AND
    // full reply have already streamed in (handleUserMessage notifies
    // between appendInflight and clearPendingSend). The parked B1a
    // patch re-emitted dots AFTER the finalized reply here.
    const now = Date.now();
    const s = state({
      durable: priorTurn(),
      pendingSends: [pending('umsg_p5', now - 500)],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_p5', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'echo2', message_id: 'msg_e2' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_e2' },
      ],
    });
    const out = project(s);
    assert.equal(out.some(x => x.key.startsWith('pending:turn:')), false, 'turn is answered — no dots');
    const last = out[out.length - 1];
    assert.equal(last.key, 'msg_e2');
    assert.equal((last as any).streaming, false);
  });

  it('blank reply_final (tool-only turn) retires the dots even with the echo still inflight', () => {
    const s = state({
      durable: priorTurn(),
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_p6', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c2', tool_name: 'web', args: {} },
        { type: 'tool_result', chat_id: 'c', call_id: 'c2', tool_name: 'web', result: 'ok' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_e3' },
      ],
    });
    assert.equal(project(s).some(x => x.key.startsWith('pending:turn:')), false);
  });

  it('post-final durable state renders all four bubbles in order, no placeholder', () => {
    const t = nowSec();
    const s = state({
      durable: [
        u('umsg_q1', 'q1', t - 60), a('msg_e1', 'echo1', t - 55),
        u('umsg_q2', 'q2', t - 10), a('msg_e2', 'echo2', t - 5),
      ],
    });
    assert.deepEqual(project(s).map(x => x.key), ['umsg_q1', 'msg_e1', 'umsg_q2', 'msg_e2']);
  });

  it('no placeholder for failed or stale sends', () => {
    const now = Date.now();
    assert.equal(
      project(state({ durable: priorTurn(), pendingSends: [pending('umsg_f', now - 500, true)] }))
        .some(x => x.key.startsWith('pending:turn:')), false, 'failed send');
    assert.equal(
      project(state({ durable: priorTurn(), pendingSends: [pending('umsg_old', now - 300_000)] }))
        .some(x => x.key.startsWith('pending:turn:')), false, 'stale send past the cap');
  });

  it('rapid double-send: dots only under the NEWEST live send', () => {
    const now = Date.now();
    const out = project(state({
      durable: priorTurn(),
      pendingSends: [pending('umsg_a', now - 400), pending('umsg_b', now - 200)],
    }));
    const phs = out.filter(x => x.key.startsWith('pending:turn:'));
    assert.equal(phs.length, 1);
    assert.equal(phs[0].key, 'pending:turn:umsg_b');
    assert.equal(out[out.length - 1], phs[0]);
  });
});
