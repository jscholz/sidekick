/**
 * @fileoverview Per-call dictation state machine — owns the utterance
 * buffer, silence timer, and commit-phrase regex that used to live in
 * the audio bridge. The bridge is now a thin transcript pass-through;
 * the PWA decides when an utterance is "done" and tells the bridge to
 * dispatch it via the data channel.
 *
 * Inputs (every is_final user transcript from the bridge):
 *   handleUserFinal(text)
 *
 * Triggers that fire a dispatch:
 *   1. Silence timeout — `settings.silenceSec` seconds without a new
 *      is_final.  silenceSec=0 disables (waits forever for a commit
 *      phrase).
 *   2. Commit-phrase match — utterance ends in the configured phrase
 *      (e.g. "over"); the phrase is stripped and the rest is sent.
 *
 * On dispatch:
 *   - Clear the buffer.
 *   - connection.dispatch(text) — bridge POSTs to /api/hermes/responses.
 *   - onUserBubble(text) — caller renders the user bubble locally
 *     (one utterance = one bubble = one dispatch).
 *
 * On call close, callers must invoke reset() so a stale buffer doesn't
 * survive into the next call.
 */

import * as conn from './connection.ts';
import * as settings from '../../settings.ts';
import { playFeedback } from '../../audio/feedback.ts';
import { log, diag } from '../../util/log.ts';

let buffer: string[] = [];
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
let onUserBubble: ((text: string) => void) | null = null;
let onReset: (() => void) | null = null;

/** Caller registers a handler that renders the user bubble (and any
 *  other "utterance committed" UI) at dispatch time. */
export function setUserBubbleHandler(cb: (text: string) => void): void {
  onUserBubble = cb;
}

/** Caller registers a handler that fires from inside reset() so any
 *  out-of-tree state mirroring the dictation buffer (e.g. main.ts's
 *  streaming user bubble id) can clear in lockstep. Lets us keep
 *  controls.ts as the single owner of when-to-reset (state listener)
 *  while still notifying everyone who cares. */
export function setOnResetHandler(cb: () => void): void {
  onReset = cb;
}

/** Clear all per-call dictation state. Call on call open AND close. */
export function reset(): void {
  buffer = [];
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (onReset) {
    try { onReset(); } catch { /* swallow — out-of-tree listener */ }
  }
}

/** Build the commit-phrase matcher for the current settings. Empty
 *  phrase disables commit-phrase dispatch. */
function makeCommitRegex(): RegExp | null {
  const phrase = (settings.get().commitPhrase || '').trim().toLowerCase();
  if (!phrase) return null;
  // Escape regex metacharacters in the phrase.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(.*)\\s*\\b${escaped}\\b[\\s.,!?]*$`, 'i');
}

function checkCommitPhrase(text: string): string | null {
  const re = makeCommitRegex();
  if (!re) return null;
  const m = text.match(re);
  if (!m) return null;
  return (m[1] || '').trim();
}

function dispatchNow(): void {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  const utterance = buffer.join(' ').trim();
  buffer = [];
  if (!utterance) return;
  log('[dictation] dispatch:', utterance.slice(0, 120));
  if (onUserBubble) {
    try { onUserBubble(utterance); } catch (e: any) { diag('[dictation] bubble handler err', e?.message); }
  }
  const ok = conn.dispatch(utterance);
  if (!ok) {
    diag('[dictation] dispatch send failed (channel not open?)');
    return;
  }
  try { playFeedback('send'); } catch { /* feedback is best-effort */ }
}

function armSilenceTimer(): void {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  const sec = Number(settings.get().silenceSec) || 0;
  if (sec <= 0) return;  // 0 = disabled (commit-phrase only).
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    dispatchNow();
  }, sec * 1000);
}

/**
 * Feed an is_final user transcript into the dictation state machine.
 *
 * Behavior:
 *   - If the joined buffer + this segment matches the commit phrase,
 *     strip it and dispatch immediately.
 *   - Otherwise append to buffer and arm the silence timer.
 *
 * Interim transcripts should NOT be passed here — they're for live
 * caption rendering and don't move the state machine.
 */
export function handleUserFinal(text: string): void {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  const joined = (buffer.join(' ') + ' ' + trimmed).trim();
  const cleaned = checkCommitPhrase(joined);
  if (cleaned !== null) {
    // Match: replace whatever's buffered with the cleaned prefix and
    // dispatch immediately. The 'commit' chime fires the moment the
    // send-word lands so the user gets feedback BEFORE the dispatch
    // round-trips — pairs with the 'send' chime in dispatchNow().
    try { playFeedback('commit'); } catch { /* feedback is best-effort */ }
    buffer = cleaned ? [cleaned] : [];
    dispatchNow();
    return;
  }
  buffer.push(trimmed);
  armSilenceTimer();
}
