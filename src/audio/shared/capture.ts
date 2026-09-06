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

import { log, diag } from '../../util/log.ts';
import * as audioSession from './session.ts';
import * as wakeLock from '../../wakeLock.ts';
import * as settings from '../../settings.ts';

/** Merge the user's saved mic selection (the Settings "Input" picker →
 *  `micDevice`) into a caller's DSP constraints. `exact` on purpose:
 *  `ideal` falls back to the OS default silently, which is precisely
 *  the masked-failure shape the picker exists to prevent — acquire()
 *  instead catches the constraint failure, logs it, and retries on the
 *  default device so the fallback is visible in the log. */
export function withPreferredMic(
  constraints: MediaTrackConstraints,
  preferred: string,
): MediaTrackConstraints {
  if (!preferred) return constraints;
  return { ...constraints, deviceId: { exact: preferred } };
}

/** The error shapes getUserMedia raises when an exact deviceId can't be
 *  satisfied (device unplugged, or ids re-minted after a permissions
 *  change). Anything else — NotAllowedError above all — must surface. */
export function isMissingDeviceError(e: any): boolean {
  return e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError';
}

let activeStream: MediaStream | null = null;
let activeOwner: string | null = null;
// Synchronous reservation slot so concurrent acquire() calls can't all
// pass the activeStream gate during the long await chain (prime ~1.5s +
// getUserMedia ~200ms). Without this, rapid tap sequences spawn parallel
// acquires that each create their own MediaStream — leaking mic-live
// tracks with no owner.
let pendingOwner: string | null = null;

/**
 * Acquire the shared MediaStream. Runs AVAudioSession prep + getUserMedia.
 * Throws if another owner currently holds it — caller must release first
 * (typically via releaseCaptureIfActive in main.ts, which tears down both
 * memo and streaming cleanly).
 *
 * @param {string} owner   - Short tag for diagnostics: 'memo' | 'streaming'.
 * @param {MediaTrackConstraints} constraints - Audio constraints (REQUIRED).
 *   Every caller declares its own DSP intent — no defaults. Standard policy
 *   for any mode that has both speaker output AND mic input on the SAME
 *   physical device (i.e. anywhere barge detection runs) is:
 *     { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
 *   AEC removes speaker bleed (lets Silero VAD discriminate user voice from
 *   the agent's TTS playing through the same device). NS+AGC are off because
 *   they shape the spectrum / gain in ways Silero is sensitive to and can
 *   defeat barge detection by ducking real user speech to the noise floor.
 *   See history in realtime.ts comments for the v0.387/v0.389/v0.413 saga
 *   that landed this policy.
 */
export async function acquire(owner: string, constraints: MediaTrackConstraints): Promise<MediaStream> {
  if (activeStream || pendingOwner) {
    throw new Error(`capture: already held by ${activeOwner ?? pendingOwner}; cannot acquire for ${owner}`);
  }
  // Reserve synchronously so concurrent callers hit the gate above
  // before any MediaStream is created. Cleared in finally so a thrown
  // error doesn't leave the slot stuck.
  pendingOwner = owner;
  try {
    audioSession.prepareForCapture();
    // iOS PWA cold-start: the FIRST getUserMedia call returns iPhone Mic
    // and BT inputs are hidden. Once-per-page-load throwaway prime cycle
    // exercises the audio session so the real getUserMedia below inherits
    // BT routing. No-op on non-iOS or if already primed. Cost: ~200 ms on
    // the first capture of a fresh page load.
    await audioSession.ensureIOSAudioSessionPrimed();
    // Honor the Settings "Input" picker. Every capture mode funnels
    // through here, so this is the ONE place the selection is applied
    // (it used to be applied nowhere — the picker was decorative, and
    // capture always ran on the OS default input).
    const preferred = settings.get().micDevice;
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({
        audio: withPreferredMic(constraints, preferred),
      });
    } catch (e: any) {
      if (!preferred || !isMissingDeviceError(e)) throw e;
      log(`capture: saved mic ${preferred.slice(0, 8)}… unavailable (${e?.name}); falling back to default input`);
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    }
    activeOwner = owner;
  } finally {
    pendingOwner = null;
  }
  // Any active capture holds a wake-lock keyed on the owner tag. The user's
  // "Pocket Lock / Stay Awake" setting lives in a separate 'setting' key,
  // so capture-scoped holds layer on top without interfering: the OS
  // sentinel stays live whenever *any* holder is registered. Fire-and-
  // forget — the sentinel request itself is async but callers don't need
  // to block on it.
  wakeLock.acquire(owner);
  // Name the physical device we actually bound — the single most useful
  // line when "no audio through" reports come in (default-vs-picked,
  // BT-vs-built-in are invisible without it).
  const track = activeStream.getAudioTracks()[0];
  log(`capture: acquired by ${owner} (mic="${track?.label || 'unknown'}")`);
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
