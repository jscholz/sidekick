/**
 * @fileoverview Tests for voice.handleResult's orphan-interim promotion.
 * The real implementation lives in src/pipelines/classic/voice.ts
 * (handleResult + module-level `lastInterim`). Replicated here as a
 * pure state machine — the source has DOM side effects (chat, draft)
 * that aren't worth mocking for a unit test.
 *
 * Regression target: the "dictation dropped during bike ride" bug.
 * Deepgram sometimes ends an utterance without emitting a matching
 * isFinal=true, and Web Speech does the same on rec.onend. Without
 * promote-on-UtteranceEnd, the grey interim text vanished and the
 * user lost whole phrases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

type Event =
  | { type: 'Results'; isFinal: boolean; transcript: string }
  | { type: 'UtteranceEnd' };

type Action =
  | { kind: 'append'; text: string; source: 'final' | 'promote' }
  | { kind: 'setInterim'; text: string }
  | { kind: 'clearInterim' }
  | { kind: 'noop' };

// Replicated from voice.ts handleResult.
function step(ev: Event, state: { lastInterim: string | null }): Action[] {
  const actions: Action[] = [];
  if (ev.type === 'Results' && ev.isFinal && ev.transcript.trim()) {
    state.lastInterim = null;
    actions.push({ kind: 'append', text: ev.transcript.trim(), source: 'final' });
    return actions;
  }
  if (ev.type === 'Results' && !ev.isFinal && ev.transcript.trim()) {
    state.lastInterim = ev.transcript.trim();
    actions.push({ kind: 'setInterim', text: ev.transcript.trim() });
    return actions;
  }
  if (ev.type === 'UtteranceEnd') {
    if (state.lastInterim) {
      actions.push({ kind: 'append', text: state.lastInterim, source: 'promote' });
      state.lastInterim = null;
    }
    actions.push({ kind: 'clearInterim' });
    return actions;
  }
  actions.push({ kind: 'noop' });
  return actions;
}

function run(events: Event[]): Action[] {
  const state = { lastInterim: null as string | null };
  const log: Action[] = [];
  for (const ev of events) log.push(...step(ev, state));
  return log;
}

describe('orphan-interim promotion', () => {
  it('happy path: interim then final — final appends, no promote', () => {
    const out = run([
      { type: 'Results', isFinal: false, transcript: 'hello world' },
      { type: 'Results', isFinal: true, transcript: 'hello world' },
      { type: 'UtteranceEnd' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 1);
    assert.equal((appends[0] as any).source, 'final');
    assert.equal((appends[0] as any).text, 'hello world');
  });

  it('orphaned interim (no matching final): UtteranceEnd promotes', () => {
    const out = run([
      { type: 'Results', isFinal: false, transcript: 'are you working' },
      { type: 'UtteranceEnd' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 1);
    assert.equal((appends[0] as any).source, 'promote');
    assert.equal((appends[0] as any).text, 'are you working');
  });

  it('promoted interim uses the LATEST interim text', () => {
    const out = run([
      { type: 'Results', isFinal: false, transcript: 'hel' },
      { type: 'Results', isFinal: false, transcript: 'hello' },
      { type: 'Results', isFinal: false, transcript: 'hello wor' },
      { type: 'UtteranceEnd' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 1);
    assert.equal((appends[0] as any).text, 'hello wor');
  });

  it('UtteranceEnd after a final does NOT re-promote', () => {
    const out = run([
      { type: 'Results', isFinal: false, transcript: 'hello' },
      { type: 'Results', isFinal: true, transcript: 'hello world' },
      { type: 'UtteranceEnd' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    // Only the final should have appended; UtteranceEnd sees cleared state.
    assert.equal(appends.length, 1);
    assert.equal((appends[0] as any).source, 'final');
  });

  it('multiple utterances in a row each promote independently', () => {
    const out = run([
      { type: 'Results', isFinal: false, transcript: 'first' },
      { type: 'UtteranceEnd' },
      { type: 'Results', isFinal: false, transcript: 'second' },
      { type: 'UtteranceEnd' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 2);
    assert.equal((appends[0] as any).text, 'first');
    assert.equal((appends[1] as any).text, 'second');
  });

  it('bare UtteranceEnd with no prior interim is a clean no-op append-wise', () => {
    const out = run([{ type: 'UtteranceEnd' }]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 0);
    // Still fires clearInterim for idempotency with DG's protocol
    assert.ok(out.some(a => a.kind === 'clearInterim'));
  });

  it('whitespace-only interim is not stored, not promoted', () => {
    const out = run([
      { type: 'Results', isFinal: false, transcript: '   ' },
      { type: 'UtteranceEnd' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 0);
  });

  it('final arrives AFTER UtteranceEnd (late-final race) — both append', () => {
    // This is the edge case promote-on-UtteranceEnd exists to handle:
    // UtteranceEnd fires first, so we promote. If a late final arrives
    // with the same text, we DO double-append — but in practice DG
    // doesn't emit finals after UtteranceEnd for the same utterance.
    // Captured here as documented behavior: the state machine treats
    // each final as authoritative, trusting the protocol.
    const out = run([
      { type: 'Results', isFinal: false, transcript: 'oops' },
      { type: 'UtteranceEnd' },
      { type: 'Results', isFinal: true, transcript: 'oops' },
    ]);
    const appends = out.filter(a => a.kind === 'append');
    assert.equal(appends.length, 2, 'late-final after UtteranceEnd does duplicate by design');
  });
});
