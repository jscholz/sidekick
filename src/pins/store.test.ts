/**
 * @fileoverview Synthetic-key guard on pinMessage() — see
 * src/transcript/keys.ts. Only the REJECT path is exercised here:
 * pinMessage's accept path does `store.items.set` then awaits a real
 * `fetch()` (network + `apiUrl()`'s `location.origin` read), neither of
 * which this node:test environment has — mirrors why activityStore's
 * markUnreadForMessage (which calls store.hydrate() unconditionally,
 * kicking the same fetch-backed refresh) isn't exercised directly
 * either. The reject path returns before any of that, so it's safe and
 * cheap to assert here; the DOM-side gating (chat.ts's pin button /
 * "Mark unread" menu item never offering the affordance on a synthetic
 * key) is covered by the isolated smoke instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pinMessage, totalPinCount, isPinned } from './store.ts';

describe('pinMessage: synthetic-key guard', () => {
  it('refuses a pending-placeholder key (thinking dots)', async () => {
    await pinMessage({
      chatId: 'chat1', msgId: 'pending:turn:umsg_123_abc',
      role: 'assistant', text: 'hi', timestamp: Date.now(),
    });
    assert.equal(totalPinCount(), 0);
    assert.equal(isPinned('chat1', 'pending:turn:umsg_123_abc'), false);
  });

  it('refuses the turn-status indicator key', async () => {
    await pinMessage({
      chatId: 'chat1', msgId: 'turn:status',
      role: 'assistant', text: 'Thinking', timestamp: Date.now(),
    });
    assert.equal(totalPinCount(), 0);
  });

  it('refuses an activity-row key', async () => {
    await pinMessage({
      chatId: 'chat1', msgId: 'turn:umsg_123_abc',
      role: 'assistant', text: '', timestamp: Date.now(),
    });
    assert.equal(totalPinCount(), 0);
  });

  it('refuses a gap-marker key', async () => {
    await pinMessage({
      chatId: 'chat1', msgId: 'gap:msg_1:msg_2',
      role: 'assistant', text: '', timestamp: Date.now(),
    });
    assert.equal(totalPinCount(), 0);
  });

  it('no-ops (does not throw) on missing chatId/msgId — unchanged prior behavior', async () => {
    await pinMessage({ chatId: '', msgId: '', role: 'user', text: '', timestamp: Date.now() });
    assert.equal(totalPinCount(), 0);
  });
});
