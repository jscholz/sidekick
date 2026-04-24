/**
 * @fileoverview Barge-in detection — watches mic peaks while TTS is
 * playing and triggers `stopTts('barge-in')` when the user speaks loudly
 * enough above threshold.
 *
 * Two entry points:
 *
 * 1. `createBargeInEvaluator(onFire)` — returns a `(peak, isPlayback) => void`
 *    function that maintains its own state (warmup window, consecutive
 *    loud-frame counter) and fires `onFire` when the barge-in threshold
 *    is crossed. Used inline by server STT's worklet message handler,
 *    which is already processing mic peaks for the Deepgram send path.
 *
 * 2. `startMonitor(stream, audioCtx, opts)` — sets up a standalone
 *    AudioWorklet on the given stream purely for peak detection. Used
 *    by local STT mode since webkitSpeechRecognition doesn't expose its
 *    mic stream to us. Returns a `stop()` function.
 *
 * Both paths share the same evaluator, same thresholds, same warmup.
 */

import { log, diag } from '../../util/log.ts';
import * as settings from '../../settings.ts';
import { isSpeaking, stop as stopTts } from './tts.ts';
import { notifyMicPeak } from '../../audio/micMeter.ts';

const WARMUP_MS = 500;          // mic-into-TTS bleed window to ignore
const DIAG_EVERY_FRAMES = 25;   // debug log cadence (≈ 2s at 4096-sample frames / 48k rate)

/**
 * Sliding-window barge-in detector.
 *
 * Old approach was N consecutive frames above threshold. That fires on
 * single-burst noise like wind gusts (200-300ms above threshold is enough)
 * AND misses real speech with mid-word amplitude dips.
 *
 * New approach: keep a sliding window of the last N frames as above/below
 * booleans; fire when ≥ M of them are above threshold. Speech (sustained
 * with syllable dips) fills M. Short noise bursts can't fill M in a window
 * longer than the burst.
 *
 * Defaults (WINDOW=5, REQUIRED=4) give ~425ms detection latency and reject
 * wind/impact bursts shorter than ~340ms.
 */
const WINDOW_FRAMES = 5;
const REQUIRED_ABOVE = 4;

/**
 * Stateful evaluator — call on every mic-peak sample. Fires the callback
 * when the user has been loud enough in at least REQUIRED_ABOVE of the
 * last WINDOW_FRAMES frames during playback (with a warmup delay after
 * playback starts).
 *
 * @param {(peak: number) => void} onFire
 * @param {{ label?: string }} [opts] Label used in the log line.
 */
export function createBargeInEvaluator(onFire: (peak: number) => void, opts: { label?: string } = {}) {
  const label = opts.label ?? 'barge-in';
  /** @type {number[]} 1 = above threshold, 0 = below. */
  const window = [];
  let muteUntil = 0;
  let diagFrames = 0;
  let diagPeakMax = 0;

  return function evaluate(peak, isPlayback) {
    diagPeakMax = Math.max(diagPeakMax, peak);
    if (++diagFrames >= DIAG_EVERY_FRAMES) {
      diag(`barge-in diag: speaking=${isPlayback} peakMax=${diagPeakMax.toFixed(3)} thresh=${settings.get().bargeThreshold}`);
      diagFrames = 0;
      diagPeakMax = 0;
    }

    if (!isPlayback) {
      if (window.length) window.length = 0;
      muteUntil = 0;
      return;
    }

    if (muteUntil === 0) muteUntil = Date.now() + WARMUP_MS;

    const s = settings.get();
    const hot = s.bargeIn && Date.now() > muteUntil && peak > s.bargeThreshold;
    window.push(hot ? 1 : 0);
    if (window.length > WINDOW_FRAMES) window.shift();

    if (!s.bargeIn) return;
    if (window.length < WINDOW_FRAMES) return;
    let sum = 0;
    for (const v of window) sum += v;
    if (sum >= REQUIRED_ABOVE) {
      log(`${label}! peak=${peak.toFixed(3)} hot=${sum}/${WINDOW_FRAMES}`);
      onFire(peak);
      window.length = 0;
      muteUntil = 0;
    }
  };
}

// ── Standalone monitor (local STT mode only) ────────────────────────────────

let workletLoadedCtx = null;
let currentSource = null;
let currentWorklet = null;

/**
 * Set up a dedicated AudioWorklet on `stream` just for peak detection.
 * Local STT mode uses this because webkitSpeechRecognition has its own
 * internal mic capture and doesn't hand us a stream we can tap.
 *
 * Gated on settings.bargeIn — returns null (no-op) when disabled.
 * Graph: mic → worklet → gain(0) → destination. The gain(0) sink keeps
 * the graph reachable from destination so the worklet's process() runs;
 * direct worklet→destination was breaking TTS on iOS when SR was also
 * consuming mic.
 *
 * @param {MediaStream} stream
 * @param {AudioContext} audioCtx
 * @returns {Promise<(() => void) | null>} stop function, or null if disabled
 */
export async function startMonitor(stream, audioCtx) {
  if (!settings.get().bargeIn) return null;
  if (!audioCtx || !stream) return null;
  if (currentWorklet) return stopMonitor;  // already running

  if (workletLoadedCtx !== audioCtx) {
    try {
      await audioCtx.audioWorklet.addModule('/src/audio/audio-processor.js');
      workletLoadedCtx = audioCtx;
    } catch (e) {
      log('barge-in: AudioWorklet load failed:', e.message);
      return null;
    }
  }

  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }

  try {
    currentSource = audioCtx.createMediaStreamSource(stream);
    currentWorklet = new AudioWorkletNode(audioCtx, 'audio-processor');
    const silentSink = audioCtx.createGain();
    silentSink.gain.value = 0;
    currentSource.connect(currentWorklet);
    currentWorklet.connect(silentSink);
    silentSink.connect(audioCtx.destination);
  } catch (e) {
    log('barge-in: graph setup failed:', e.message);
    currentSource = null;
    currentWorklet = null;
    return null;
  }

  const evaluate = createBargeInEvaluator(
    () => stopTts('barge-in'),
    { label: 'barge-in (local)' },
  );

  currentWorklet.port.onmessage = (e) => {
    notifyMicPeak(e.data.peak);
    evaluate(e.data.peak, isSpeaking());
  };
  log('local mode: barge-in monitor active');
  return stopMonitor;
}

export function stopMonitor() {
  if (currentWorklet) { try { currentWorklet.disconnect(); } catch {} currentWorklet = null; }
  if (currentSource) { try { currentSource.disconnect(); } catch {} currentSource = null; }
}

/** Reset the per-context worklet-loaded flag when the AudioContext is
 *  rebuilt (e.g. after unlock's staleRoute close+recreate). */
export function onContextRebuilt() {
  workletLoadedCtx = null;
  currentSource = null;
  currentWorklet = null;
}
