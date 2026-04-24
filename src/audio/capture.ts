/**
 * @fileoverview Audio capture coordinator — single-owner MediaStream for the
 * whole app. Memo (MediaRecorder blob capture) and streaming (AudioWorklet +
 * Deepgram WS) both acquire through here rather than calling getUserMedia
 * directly. Centralizes:
 *
 *   - iOS AVAudioSession category prep (play-and-record before getUserMedia)
 *   - MediaStream ownership + track teardown
 *   - Screen Wake Lock, keyed on the owner tag, so any active capture
 *     (memo OR streaming) keeps the screen awake regardless of the user's
 *     "Pocket Lock / Stay Awake" setting. Layered on top of the
 *     setting-scoped hold via wakeLock.ts's ref-counted holders set.
 *   - Mutual exclusion: throws if called while active, so callers must
 *     release the prior mode before starting a new one — this forces
 *     explicit coordination (via memo.cancel() / deepgram.stop() paths)
 *     instead of letting two capture flows interleave
 *
 * The Apr 24 memo null-race bug — mediaRecorder getting nulled mid-await
 * by a concurrent cleanup path — was one symptom of capture state being
 * duplicated across modules. With this module as the single source of
 * truth for stream ownership, such races can't form: every teardown goes
 * through release(), which is idempotent and doesn't touch any other
 * module's local state.
 *
 * The AudioContext is NOT managed here — callers use the shared ctx from
 * unlock.ts (streaming) or create their own local ctx synchronously inside
 * the user gesture (memo, which needs the ctx BEFORE any await to avoid
 * losing iOS gesture state).
 */

import { log, diag } from '../util/log.ts';
import * as audioSession from './session.ts';
import * as wakeLock from '../wakeLock.ts';

let activeStream: MediaStream | null = null;
let activeOwner: string | null = null;

/**
 * Acquire the shared MediaStream. Runs AVAudioSession prep + getUserMedia.
 * Throws if another owner currently holds it — caller must release first
 * (typically via releaseCaptureIfActive in main.ts, which tears down both
 * memo and streaming cleanly).
 *
 * @param {string} owner   - Short tag for diagnostics: 'memo' | 'streaming'.
 * @param {MediaTrackConstraints} [constraints] - Override default audio
 *                          constraints (echo/noise/gain). Streaming passes
 *                          a deviceId when the user has picked a specific mic.
 */
export async function acquire(owner: string, constraints?: MediaTrackConstraints): Promise<MediaStream> {
  if (activeStream) {
    throw new Error(`capture: already held by ${activeOwner}; cannot acquire for ${owner}`);
  }
  audioSession.prepareForCapture();
  const audio = constraints || {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  };
  activeStream = await navigator.mediaDevices.getUserMedia({ audio });
  activeOwner = owner;
  // Any active capture holds a wake-lock keyed on the owner tag. The user's
  // "Pocket Lock / Stay Awake" setting lives in a separate 'setting' key,
  // so capture-scoped holds layer on top without interfering: the OS
  // sentinel stays live whenever *any* holder is registered. Fire-and-
  // forget — the sentinel request itself is async but callers don't need
  // to block on it.
  wakeLock.acquire(owner);
  log(`capture: acquired by ${owner}`);
  return activeStream;
}

/**
 * Release the stream — stops all tracks, clears ownership. Idempotent:
 * calling when nothing is held is a no-op (common during shutdown paths
 * that try both memo + streaming teardown). Callers should also reset
 * their own module-local state (MediaRecorder, AudioWorkletNode, etc.);
 * capture only owns the stream itself.
 */
export function release(owner?: string): void {
  if (!activeStream) return;
  // Ownership check: only the current owner (or an unchecked caller) can
  // release. Prevents a stale release path from tearing down a freshly
  // acquired stream if two async paths overlap.
  if (owner && activeOwner !== owner) {
    diag(`capture: release by ${owner} ignored (owner=${activeOwner})`);
    return;
  }
  try { activeStream.getTracks().forEach(t => t.stop()); } catch {}
  // Drop the wake-lock key we registered in acquire(). If other holders
  // (e.g. the user's 'setting' key) remain, the OS sentinel stays live.
  const priorOwner = activeOwner;
  if (priorOwner) wakeLock.release(priorOwner);
  log(`capture: released (was ${priorOwner})`);
  activeStream = null;
  activeOwner = null;
}

export function getActiveStream(): MediaStream | null { return activeStream; }
export function hasActive(): boolean { return activeStream !== null; }
export function currentOwner(): string | null { return activeOwner; }
