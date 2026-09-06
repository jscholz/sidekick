// The send-addressing contract (UX_DETERMINISM_PLAN §5 Phase 1.2, §6
// rule 3): proxyClientAdapter.sendMessage POSTs to the chat id its
// CALLER captured at intent time, and treats a missing one as a
// programming error rather than quietly resolving a module-level
// pointer at completion time.
//
// Why this file exists at all: for two years the resolution order was
// "opts.chatId, else the module-level activeChatId", and that pointer
// was re-aimed as a side effect of resumeSession() — which boot restore,
// cmd-K, drills and the foreground reconcile all call. Both wrong-chat
// field bugs (2026-06-12 /approve ×5, 2026-09-06 the dictated dream log)
// are that shape. The rules below are cheap to state and were expensive
// to learn, so they get assertions.
//
// The module is imported STATICALLY on purpose. util/log.ts computes its
// disk-relay flag once at load; importing before any fake `location` /
// `localStorage` exists pins relayOn=false, so no log line can fire a
// stray fetch into the request log these cases assert on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyClientAdapter } from './proxyClient.ts';
import * as switchCtl from './switchController.ts';

/** POSTs captured from the adapter, newest last. */
let posts: Array<{ url: string; body: any }> = [];

/** Install a fetch that answers every send with a 202 and records it.
 *  Returns nothing — read `posts`. */
function stubFetch(): void {
  posts = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    let body: any = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = init?.body; }
    posts.push({ url: String(url), body });
    return { ok: true, status: 202, text: async () => '', json: async () => ({}) };
  };
}

/** Dev mode is read per-call by util/devMode.isDevMode(), which needs a
 *  `location` and a `localStorage` to consult; in bare node both throw
 *  and it reports false. Fake them for the duration of `fn`. */
async function withDevMode(on: boolean, fn: () => Promise<void>): Promise<void> {
  const g = globalThis as any;
  const hadLocation = 'location' in g, prevLocation = g.location;
  const hadStorage = 'localStorage' in g, prevStorage = g.localStorage;
  g.location = { search: '', protocol: 'https:', origin: 'https://smoke.invalid' };
  g.localStorage = { getItem: (k: string) => (on && k === 'dev_mode' ? '1' : null) };
  try {
    await fn();
  } finally {
    if (hadLocation) g.location = prevLocation; else delete g.location;
    if (hadStorage) g.localStorage = prevStorage; else delete g.localStorage;
  }
}

test('addressed send: the POST carries the caller\'s chat id', async () => {
  stubFetch();
  // The view says one thing; the send was composed somewhere else. The
  // send wins — that is the whole invariant. (Field 2026-06-12: an
  // approval tapped in chat A while a switch to B was in flight.)
  switchCtl.setViewed('chat-on-screen');
  switchCtl.setOptimistic(null);

  await proxyClientAdapter.sendMessage('approve', { chatId: 'chat-composed-in' });

  const send = posts.find((p) => p.url.endsWith('/messages'));
  assert.ok(send, 'the send should have POSTed to /messages');
  assert.equal(send.body.chat_id, 'chat-composed-in',
    'sendMessage must POST to the chat the caller addressed, never the one on screen');
  assert.equal(send.body.text, 'approve');
});

test('addressed send: a chat id is never overridden by a later focus move', async () => {
  stubFetch();
  // Stands in for the offline retry queue: sendOpts were captured while
  // the user was in chat-A, the POST happens after they moved to chat-B.
  const sendOpts = { chatId: 'chat-a', userMessageId: 'umsg_queued' };
  switchCtl.setViewed('chat-b');
  switchCtl.setOptimistic(null);

  await proxyClientAdapter.sendMessage('queued while offline', sendOpts);

  const send = posts.find((p) => p.url.endsWith('/messages'));
  assert.equal(send?.body.chat_id, 'chat-a',
    'a send flushed after a switch must land in the chat it was composed in');
  assert.equal(send?.body.user_message_id, 'umsg_queued');
});

test('unaddressed send THROWS in dev mode and posts nothing', async () => {
  stubFetch();
  switchCtl.setViewed('chat-would-have-worked');
  switchCtl.setOptimistic(null);

  await withDevMode(true, async () => {
    await assert.rejects(
      () => proxyClientAdapter.sendMessage('unaddressed', {}),
      /opts\.chatId is required/,
      'a send with no chat id is a programming error and must fail loudly in dev',
    );
  });
  assert.equal(posts.length, 0, 'the throw must happen BEFORE anything is POSTed');
});

test('unaddressed send in prod falls back to the focused chat, not the pointer', async () => {
  stubFetch();
  // focusedId() prefers the in-flight click target over the committed
  // view — the same precedence the shell's currentChatId() uses, so the
  // safety net cannot disagree with the surface it is backing up.
  switchCtl.setViewed('chat-committed');
  switchCtl.setOptimistic('chat-being-clicked');

  await withDevMode(false, async () => {
    await proxyClientAdapter.sendMessage('unaddressed but survivable', {});
  });

  const send = posts.find((p) => p.url.endsWith('/messages'));
  assert.equal(send?.body.chat_id, 'chat-being-clicked',
    'the prod fallback resolves the ONE source of truth (switchController), not an adapter pointer');
  switchCtl.setOptimistic(null);
});

test('voice + attachment flags ride along with the address', async () => {
  stubFetch();
  await proxyClientAdapter.sendMessage('dictated', {
    chatId: 'chat-voice', voice: true, attachments: [{ kind: 'image', url: 'x' }],
  });
  const send = posts.find((p) => p.url.endsWith('/messages'));
  assert.equal(send?.body.chat_id, 'chat-voice');
  assert.equal(send?.body.voice, true);
  assert.equal(send?.body.attachments.length, 1);
});
