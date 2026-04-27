/**
 * @fileoverview Smart half-duplex controller for talk mode.
 *
 * Problem: on iOS Safari, the WebRTC AEC pipeline doesn't include the
 * remote audio playback in its echo-cancellation reference signal —
 * neither via <audio> element nor Web Audio routing — so the mic
 * faithfully re-captures the agent's TTS output and Deepgram
 * transcribes it as user input. Naive fix (mute the mic during
 * reply) kills barge-in.
 *
 * This controller threads the needle:
 *
 *   - When the agent starts replying (first assistant delta on the
 *     data channel), set `suppressing = true`. main.ts's data-channel
 *     listener checks `isSuppressing()` and drops user transcripts
 *     while it is on. The mic STREAM stays live so the user's actual
 *     voice still reaches the bridge — we just ignore those
 *     transcripts because we can't distinguish "user spoke" from
 *     "speakerphone played our TTS into the mic."
 *
 *   - While suppressing, poll the local mic for volume spikes. If
 *     peak crosses `settings.bargeThreshold` for >= BARGE_HOLD_MS,
 *     treat it as the user trying to interrupt: cancel TTS playback
 *     locally (`conn.cancelRemotePlayback()`), clear suppression,
 *     and let the next user transcript flow normally. The lost
 *     window is roughly `BARGE_HOLD_MS` of speech — the user has to
 *     restart the utterance after the cut, which is acceptable for
 *     the "stop talking, please" use case.
 *
 *   - Suppression also clears on assistant `is_final` + a grace
 *     period. TTS playback continues briefly after text-final, so
 *     un-gating immediately would let the tail leak back as
 *     transcripts.
 *
 *   - On call close, everything tears down so a stale poll doesn't
 *     survive into the next call.
 *
 * Threshold sourcing: reads `settings.bargeThreshold` (existing
 * setting, originally for the classic-pipeline barge-in detector,
 * default 0.20 = "moderate sensitivity"). Tunable from the settings
 * panel — semantics are the same.
 */

import * as conn from './connection.ts';
import * as settings from '../../settings.ts';
import { log, diag } from '../../util/log.ts';

/** Tail extension after `is_final` — TTS audio playback continues a
 *  bit after text-final on most TTS providers (sentence-end pause,
 *  buffered audio). Re-enabling transcripts immediately would let the
 *  tail leak back as user transcripts. 1.2s covers Aura's typical
 *  buffer plus a small margin. */
const SUPPRESS_GRACE_MS = 1200;

/** Mic-poll cadence while suppressing. 50ms ≈ 20Hz, fine-grained
 *  enough for human-perceptible barge-in latency without burning
 *  cycles. */
const BARGE_POLL_MS = 50;

/** Minimum sustained-above-threshold duration to call a barge. Filters
 *  out single-frame mic spikes (cough, room thump) that aren't
 *  intentional speech. Browser AEC + AGC chop voice into 100-150ms
 *  bursts during TTS, so a 200ms hold-time misses real barge-ins —
 *  100ms (= 2 polls) trades stricter false-positive immunity for the
 *  ability to fire on AEC'd speech. */
const BARGE_HOLD_MS = 100;

/** Minimum local-mic peak (0..1, deviation-from-128 in s8) below which
 *  we never fire barge regardless of remote level. Sits just above the
 *  silence/echo-bleed floor (~0.008 = 1/128 = single-bit DC offset on a
 *  suspended-context analyser or AEC'd mic during TTS). 0.02 captures
 *  AEC-suppressed user voice (peaks of 0.03-0.06 in real desktop+headset
 *  testing) without firing on pure-silence ticks. */
const BARGE_MIN_LOCAL = 0.02;

/** Smart-barge ratio: local peak must exceed remote peak times this
 *  factor. Calibrated against real desktop+headset AEC behavior:
 *  during pure TTS the analyser reads local≈0.008 / remote≈0.18 (ratio
 *  ≈0.04); when the user speaks the AEC ducks the user voice but it
 *  still lands at ratios of 0.3-0.8 of the simultaneous TTS level.
 *  0.2 splits these cases cleanly. (The original 1.8x assumption that
 *  user voice would dominate TTS doesn't hold once browser AEC is in
 *  the path — AEC inverts the relationship.) */
const BARGE_RATIO_DEFAULT = 0.2;

/** Verbose poll logging cadence while suppressing — prints local +
 *  remote peak + ratio every N polls (~1s at 50ms cadence). Useful
 *  for tuning thresholds during a real-world session. */
const BARGE_DIAG_EVERY_N_POLLS = 20;

/** Heavy-instrumentation mode for live debugging. Enable by appending
 *  `?duplex-debug=1` to the sidekick URL. Effects:
 *
 *    - Floating overlay (top-right corner) showing live local-peak,
 *      remote-peak, and the computed ratio + threshold + would-fire
 *      flag at 20 Hz while suppressing.
 *    - Per-poll log line (every 50ms — noisier than the every-1s
 *      summary, but useful for second-by-second tuning).
 *    - "Near-miss" log line when localPeak crosses MIN_LOCAL but the
 *      ratio falls short — pinpoints why a barge attempt didn't fire.
 *
 *  Off by default so production users don't see a debug HUD. */
const DUPLEX_DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).get('duplex-debug') === '1';
  } catch {
    return false;
  }
})();

let suppressing = false;
let suppressEndTimer: ReturnType<typeof setTimeout> | null = null;
let bargePollHandle: number | null = null;
let micAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
let micCtx: AudioContext | null = null;
let bargePollBuf: Uint8Array | null = null;
let bargeAboveSinceMs = 0;
let debugOverlay: HTMLDivElement | null = null;

export function isSuppressing(): boolean {
  return suppressing;
}

/** Called by main.ts on every assistant transcript delta from the
 *  data channel. First call of a reply turn flips suppression on and
 *  starts the smart-barge poll; subsequent calls within the same
 *  reply cancel any pending end-timer (each delta extends the tail). */
export function onAssistantDelta(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (!suppressing) {
    suppressing = true;
    bargeAboveSinceMs = 0;
    const bargeInPref = settings.get().bargeIn;
    log(
      '[duplex] agent speaking — suppressing user transcripts',
      ' (bargeIn=', bargeInPref, ')',
    );
    if (bargeInPref !== false) {
      startBargePoll();
    } else {
      log('[duplex] bargeIn disabled in settings — no barge poll this turn');
    }
  }
}

/** Called by main.ts on assistant `is_final: true`. Schedules
 *  suppression-clear after the grace period, unless a delta arrives
 *  in the meantime (extends the tail). */
export function onAssistantFinal(): void {
  if (!suppressing) return;
  if (suppressEndTimer) clearTimeout(suppressEndTimer);
  suppressEndTimer = setTimeout(() => {
    suppressEndTimer = null;
    stopSuppressing('final+grace');
  }, SUPPRESS_GRACE_MS);
}

/** Called when the call closes (controls.ts state listener fires
 *  closing/idle). Tears down the poll + analyser so the next call
 *  starts clean. */
export function onCallClose(): void {
  if (suppressing) stopSuppressing('call-close');
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  // Mic + remote streams change per call — drop the analysers so the
  // next start binds to the fresh streams. Keep micCtx alive (iOS
  // limits live AudioContexts; one shared one across calls is the
  // cheap strategy that matches connection.ts).
  micAnalyser = null;
  remoteAnalyser = null;
  bargePollBuf = null;
  removeDebugOverlay();
}

/** Mount the debug overlay at call-open time (when ?duplex-debug=1)
 *  so the HUD is visible across the entire call, not just during TTS
 *  bursts. Called by main.ts on connection state -> 'connected'. */
export function onCallOpen(): void {
  if (DUPLEX_DEBUG) ensureDebugOverlay();
}

function stopSuppressing(reason: string): void {
  log('[duplex] resume user transcripts (', reason, ')');
  suppressing = false;
  stopBargePoll();
}

function buildAnalyser(stream: MediaStream): AnalyserNode | null {
  try {
    // Use the SHARED AudioContext that connection.ts created + resumed
    // synchronously at click time. Creating our own here (called from
    // inside setInterval) lands outside the user-gesture window, so
    // resume() silently no-ops and the analyser reads pure silence
    // (peakOf returns 1/128 ≈ 0.008 from the DC offset). Sharing the
    // resumed ctx is the canonical fix.
    const ctx = conn.getSharedAudioContext();
    if (!ctx) {
      diag('[duplex] no shared AudioContext — open() must run first');
      return null;
    }
    micCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    // Note: NOT connected to ctx.destination — the <audio> element
    // owns playback. We're only tapping for level analysis.
    return an;
  } catch (e: any) {
    diag('[duplex] analyser setup failed:', e?.message);
    return null;
  }
}

function peakOf(an: AnalyserNode | null, buf: Uint8Array): number {
  if (!an) return 0;
  an.getByteTimeDomainData(buf);
  let p = 0;
  for (const v of buf) {
    const dev = Math.abs(v - 128) / 128;
    if (dev > p) p = dev;
  }
  return p;
}

function startBargePoll(): void {
  if (bargePollHandle != null) {
    log('[duplex] startBargePoll: poll already running, skipping');
    return;
  }
  if (!micAnalyser) {
    // Use the RAW mic stream (no AEC / NS / AGC). Reading the AEC'd
    // mic puts the analyser downstream of Chrome's echo cancellation,
    // which actively ducks the user's voice during TTS — local pegs
    // at the silence floor (1/128 = 0.008) and barge-in becomes
    // physically impossible regardless of threshold tuning. Raw stream
    // is opened by connection.ts as a second getUserMedia call.
    const mic = conn.getRawMicStream();
    if (!mic) {
      diag('[duplex] no mic stream; barge detection disabled this turn');
      return;
    }
    micAnalyser = buildAnalyser(mic);
    if (!micAnalyser) {
      diag('[duplex] mic analyser build failed; barge detection disabled');
      return;
    }
    bargePollBuf = new Uint8Array(micAnalyser.fftSize);
  }
  log('[duplex] startBargePoll: poll active (cadence=', BARGE_POLL_MS, 'ms)');
  // Remote analyser is built by connection.ts on ontrack (so the
  // playback graph and the analysis tap share one Web Audio source).
  // We just consume it here. Returns null until ontrack fires —
  // re-checked every tick so a late-arriving remote track still gets
  // monitored once it appears.
  if (!remoteAnalyser) {
    remoteAnalyser = conn.getRemoteAnalyser();
  }

  if (DUPLEX_DEBUG) ensureDebugOverlay();
  const ratio = BARGE_RATIO_DEFAULT;
  let pollCount = 0;
  let maxLocalThisInterval = 0;
  let maxRemoteThisInterval = 0;
  bargePollHandle = window.setInterval(() => {
    if (!micAnalyser || !bargePollBuf) return;
    // Late-bind remote analyser if it wasn't ready at start.
    // connection.ts builds the analyser at ontrack time on the same
    // Web Audio graph as playback, so reads always reflect actual TTS
    // levels (vs the createMediaStreamSource-on-srcObject path which
    // returned 0.000 because the audio element captured the stream).
    if (!remoteAnalyser) {
      remoteAnalyser = conn.getRemoteAnalyser();
    }
    const localPeak = peakOf(micAnalyser, bargePollBuf);
    const remotePeak = remoteAnalyser ? peakOf(remoteAnalyser, bargePollBuf) : 0;
    const now = performance.now();
    const computedRatio = remotePeak > 0 ? localPeak / remotePeak : Infinity;
    const meetsFloor = localPeak >= BARGE_MIN_LOCAL;
    const meetsRatio = localPeak > remotePeak * ratio;
    const isUserVoice = meetsFloor && meetsRatio;

    // Track maxima between diag prints so we see actual range, not
    // just the instant when the diag tick happened to fire.
    if (localPeak > maxLocalThisInterval) maxLocalThisInterval = localPeak;
    if (remotePeak > maxRemoteThisInterval) maxRemoteThisInterval = remotePeak;
    pollCount++;
    if (pollCount >= BARGE_DIAG_EVERY_N_POLLS) {
      log(
        '[duplex] poll local-max=', maxLocalThisInterval.toFixed(2),
        ' remote-max=', maxRemoteThisInterval.toFixed(2),
        ' ratio=', (maxRemoteThisInterval > 0
                     ? maxLocalThisInterval / maxRemoteThisInterval
                     : Infinity).toFixed(1),
        ' (need >', ratio, ', local floor=', BARGE_MIN_LOCAL, ')',
      );
      pollCount = 0;
      maxLocalThisInterval = 0;
      maxRemoteThisInterval = 0;
    }

    if (DUPLEX_DEBUG) {
      // Per-poll log + overlay update. Noisier than the every-1s
      // summary above, but valuable for second-by-second tuning.
      log(
        '[duplex.poll] local=', localPeak.toFixed(3),
        ' remote=', remotePeak.toFixed(3),
        ' ratio=', isFinite(computedRatio) ? computedRatio.toFixed(2) : 'inf',
        ' floor:', meetsFloor, ' ratio-pass:', meetsRatio,
      );
      // Near-miss diagnosis: localPeak above floor, but ratio short.
      // Most common cause of "barge not firing when user spoke."
      if (meetsFloor && !meetsRatio) {
        log(
          '[duplex.NEAR-MISS] localPeak ',
          localPeak.toFixed(3),
          ' cleared floor but ratio ',
          isFinite(computedRatio) ? computedRatio.toFixed(2) : 'inf',
          ' < ', ratio,
          ' (remote=', remotePeak.toFixed(3), ')',
        );
      }
      updateDebugOverlay({ localPeak, remotePeak, computedRatio, isUserVoice, meetsFloor, meetsRatio });
    }

    // Smart-barge logic:
    //   - Local must clear an absolute floor (no triggering on silence).
    //   - Local must exceed remote × ratio (kills correlated TTS echo).
    //   If both, accumulate the above-since timer and fire on hold-time.
    if (isUserVoice) {
      if (bargeAboveSinceMs === 0) bargeAboveSinceMs = now;
      if (now - bargeAboveSinceMs >= BARGE_HOLD_MS) {
        fireBarge(localPeak, remotePeak);
        bargeAboveSinceMs = 0;
      }
    } else {
      bargeAboveSinceMs = 0;
    }
  }, BARGE_POLL_MS);
}

// ── Debug overlay (DUPLEX_DEBUG=1 in URL) ──────────────────────────────
//
// Tiny floating panel in the top-right that shows live local/remote
// peaks + ratio + would-fire flag. Mounts on first turn of a call and
// persists for the lifetime of the call so you can watch values across
// multiple TTS bursts and the silences between them. Updates only
// while suppressing — between turns the bars hold their last frame so
// you can read them. Built to make tuning thresholds an interactive
// process: set `?duplex-debug=1`, hard-refresh, watch the bars while
// talking.

function ensureDebugOverlay(): void {
  if (debugOverlay) return;
  const el = document.createElement('div');
  el.className = 'duplex-debug-overlay';
  el.innerHTML = `
    <div class="ddb-header">duplex (debug)</div>
    <div class="ddb-row"><span class="ddb-label">local</span>
      <div class="ddb-bar"><div class="ddb-fill ddb-local"></div></div>
      <span class="ddb-val ddb-local-val">0.000</span></div>
    <div class="ddb-row"><span class="ddb-label">remote</span>
      <div class="ddb-bar"><div class="ddb-fill ddb-remote"></div></div>
      <span class="ddb-val ddb-remote-val">0.000</span></div>
    <div class="ddb-row ddb-summary">
      ratio: <span class="ddb-ratio">inf</span> /
      need &gt; <span class="ddb-thresh">${BARGE_RATIO_DEFAULT}</span> ·
      floor: <span class="ddb-floor">${BARGE_MIN_LOCAL}</span> ·
      <span class="ddb-fire">—</span>
    </div>
  `;
  document.body.appendChild(el);
  debugOverlay = el;
}

function updateDebugOverlay(s: {
  localPeak: number; remotePeak: number; computedRatio: number;
  isUserVoice: boolean; meetsFloor: boolean; meetsRatio: boolean;
}): void {
  if (!debugOverlay) return;
  const setBar = (cls: string, v: number) => {
    const fill = debugOverlay!.querySelector(cls) as HTMLElement | null;
    if (fill) fill.style.width = `${Math.min(100, v * 100)}%`;
  };
  const setText = (cls: string, txt: string) => {
    const t = debugOverlay!.querySelector(cls);
    if (t) t.textContent = txt;
  };
  setBar('.ddb-local', s.localPeak);
  setBar('.ddb-remote', s.remotePeak);
  setText('.ddb-local-val', s.localPeak.toFixed(3));
  setText('.ddb-remote-val', s.remotePeak.toFixed(3));
  setText('.ddb-ratio', isFinite(s.computedRatio) ? s.computedRatio.toFixed(2) : 'inf');
  const fire = debugOverlay.querySelector('.ddb-fire') as HTMLElement | null;
  if (fire) {
    if (s.isUserVoice) {
      fire.textContent = 'WOULD FIRE';
      fire.style.color = '#5af';
    } else if (s.meetsFloor) {
      fire.textContent = 'near-miss';
      fire.style.color = '#fc6';
    } else {
      fire.textContent = '—';
      fire.style.color = '';
    }
  }
}

function removeDebugOverlay(): void {
  if (debugOverlay) {
    debugOverlay.remove();
    debugOverlay = null;
  }
}

function stopBargePoll(): void {
  if (bargePollHandle != null) {
    clearInterval(bargePollHandle);
    bargePollHandle = null;
  }
  bargeAboveSinceMs = 0;
  // Don't remove the overlay here — keep it around for the whole call
  // so the user can read values between turns. Removed on onCallClose.
}

function fireBarge(localPeak: number, remotePeak: number): void {
  log(
    '[duplex] barge-in (local=', localPeak.toFixed(2),
    ' remote=', remotePeak.toFixed(2),
    ' ratio=', (remotePeak > 0 ? localPeak / remotePeak : Infinity).toFixed(1),
    ') — canceling TTS',
  );
  conn.cancelRemotePlayback();
  stopSuppressing('barge');
}
