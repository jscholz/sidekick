/**
 * @fileoverview Deepgram STT — WebSocket streaming via server proxy,
 * AudioWorklet processing, barge-in detection, auto-reconnect, keepalive.
 * Falls back to Web Speech API when the connection stalls (bufferedAmount).
 */

import { log } from '../../util/log.ts';
import { setStatus } from '../../status.ts';
import * as settings from '../../settings.ts';
import { getAudioCtx } from '../../audio/unlock.ts';
import { isSpeaking, stop as stopTts } from './tts.ts';
import { isConnected } from '../../backend.ts';
import * as bargeIn from './bargeIn.ts';
import * as sttBackfill from './sttBackfill.ts';
import { notifyMicPeak } from '../../audio/micMeter.ts';
import { webspeechProvider } from './providers/webspeech.ts';

// ── Event emitter ─────────────────────────────────────────────────────────
// Exposed so main.ts / voice.ts can track DG WS state without reaching
// into the internals. Currently emits: 'dg-open', 'dg-close', 'dg-wedge'.
// Subscribe with on(event, fn); unsubscribe with off(event, fn).
/** @type {Map<string, Set<Function>>} */
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function off(event, fn) { listeners.get(event)?.delete(fn); }
function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { log('deepgram listener err:', e.message); }
  }
}

let dgSocket = null;
let workletNode = null;
let audioSource = null;
let audioFrames = 0;
let keepaliveInterval = null;
// Track which AudioContext instance has the worklet module loaded. A boolean
// flag goes stale when unlock.ts rebuilds the context (e.g. on route change)
// — the new ctx has no module registered, causing "No ScriptProcessor" errors.
let workletLoadedCtx = null;
let connecting = false;

// Stored for reconnect
let activeStream = null;
let activeCallback = null;
let intentionallyStopped = false;

/** Timestamp of the last inbound DG message (Results / UtteranceEnd).
 *  Used with lastContentAudioAt to detect a wedged-but-open WS — when we're
 *  actively sending speech audio but DG hasn't produced any response for
 *  a while, the ASR pipeline is likely stuck and we should reconnect
 *  proactively rather than wait for DG's own 10s timeout (code 1011). */
let lastDGMessageAt = 0;
let lastContentAudioAt = 0;
let dgWedged = false;
/** Threshold: if we've been sending speech (peak > threshold) and haven't
 *  heard from DG for this many ms, treat the stream as wedged. Tuned to
 *  fire a bit before DG's own 10s timeout so our reconnect has time to
 *  come up before DG cuts us off. */
const DG_WEDGE_MS = 7000;
const DG_CONTENT_PEAK = 0.01;

// ── Local STT fallback via the webspeech provider ───────────────────────────
// The orchestrator holds the active session handle; all SpeechRecognition
// state lives inside the provider module.
/** @type {import('./providers/types.js').STTSession | null} */
let localSession = null;
let usingLocal = false;
let stallFrames = 0;

/** Bytes queued before we consider the connection stalled. ~6 audio frames. */
const STALL_BYTES = 50000;
/** Consecutive stalled frames before switching to local. Avoids false positives. */
const STALL_TRIGGER = 3;
/** Frames (≈85ms each at 48kHz / 4096) after DG open during which we skip
 *  stall detection. TCP slow-start + TLS ramp-up + iOS mic AGC warmup can
 *  briefly back up the WS outgoing buffer even on a healthy connection.
 *  Without this grace window a user who starts speaking fast on mic-open
 *  would trip a false-positive stall and get bounced to local STT for
 *  their first utterance. 24 frames ≈ 2s. */
const STALL_WARMUP_FRAMES = 24;

async function startLocalFallback() {
  if (usingLocal) return;
  if (!webspeechProvider.isAvailable()) return;
  if (!activeStream || !activeCallback) return;
  usingLocal = true;
  localSession = await webspeechProvider.start({
    stream: activeStream,
    audioCtx: getAudioCtx() || undefined,
    isTtsActive: isSpeaking,
    onResult: (r) => {
      if (!activeCallback) return;
      // Bridge normalized STTResult → the Deepgram-shaped envelope the
      // rest of the app expects. Avoids touching voice.handleResult.
      activeCallback({
        type: 'Results',
        is_final: r.isFinal,
        channel: { alternatives: [{ transcript: r.transcript, words: r.words || [] }] },
      });
    },
    onUtteranceEnd: () => {
      // Forward to voice.handleResult so it can promote any orphaned
      // interim — SR doesn't always emit a final for short phrases.
      if (activeCallback) activeCallback({ type: 'UtteranceEnd' });
    },
  });
  if (!localSession) {
    usingLocal = false;
    return;
  }
  const pending = localSession && isSpeaking();
  setStatus(pending ? 'Listening (local, deferred — TTS playing)' : 'Listening (local)', 'live');
}

function stopLocalFallback() {
  if (!usingLocal) return;
  usingLocal = false;
  if (localSession) {
    localSession.stop();
    localSession = null;
  }
  setStatus(isConnected() ? 'Listening (server)' : 'Listening (server, gw offline)', 'live');
  log('switched back to Deepgram');
}

/** Called from tts.ts when TTS playback begins. Delegates to whichever
 *  STT provider is active — only the webspeech provider actually needs
 *  to pause (it has its own internal mic capture). DG mode is a no-op
 *  because the AudioWorklet handler already gates frame sends via
 *  isSpeaking(). */
export function onTtsStart() {
  localSession?.pauseForTts?.();
}

/** Complement to onTtsStart. */
export function onTtsEnd() {
  localSession?.resumeAfterTts?.();
}

// ── Audio constraints ───────────────────────────────────────────────────────

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

import { getConfig } from '../../config.ts';

/** Deepgram keyterm biasing. The server merges file + env + defaults
 *  and returns the final list via /config — we just serialize it into
 *  the DG URL params here. Keyterms bias word recognition toward
 *  specific spellings; they don't teach pronunciation. */
function getKeyterms() {
  try {
    const cfg = getConfig();
    const terms = Array.isArray(cfg?.sttKeyterms) && cfg.sttKeyterms.length
      ? cfg.sttKeyterms
      : ['OpenClaw', 'Clawdian', 'Claw', 'SideKick', 'Deepgram'];
    return terms.map(t => `keyterm=${encodeURIComponent(t)}`).join('&');
  } catch {
    return '';
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {MediaStream} stream
 * @param {(data: Object) => void} onResult
 */
export function start(stream, onResult) {
  if (!(stream instanceof MediaStream) || !stream.active) {
    log('deepgram.start: invalid/inactive stream — refusing to start');
    setStatus('Mic not ready — tap Stream again', 'err');
    return;
  }
  activeStream = stream;
  activeCallback = onResult;
  intentionallyStopped = false;
  stallFrames = 0;

  // If user forced local streaming, skip Deepgram entirely
  if (settings.get().streamingEngine === 'local' && webspeechProvider.isAvailable()) {
    log('streaming: local mode (Web Speech API) — user preference');
    startLocalFallback();
    return;
  }

  connect();
}

/** Read-only access to the active mic stream for diagnostic / visualisation
 *  consumers (TTS route check, Pocket-Lock mic meter). Null when not streaming. */
export function getActiveStream() { return activeStream; }

export function stop() {
  intentionallyStopped = true;
  clearInterval(keepaliveInterval);
  stopLocalFallback();
  if (dgSocket) { dgSocket.close(); dgSocket = null; }
  if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
  if (audioSource) { try { audioSource.disconnect(); } catch {} audioSource = null; }
  // Stop all tracks — including any re-acquired stream from BT reconnect.
  // This ensures the OS releases the mic (and exits BT HFP profile).
  if (activeStream) {
    activeStream.getTracks().forEach(t => t.stop());
    activeStream = null;
  }
  activeCallback = null;
  stallFrames = 0;
}

// ── Connection ──────────────────────────────────────────────────────────────

async function connect() {
  if (connecting) return;
  connecting = true;
  try {
    await connectInner();
  } finally {
    connecting = false;
  }
}

async function connectInner() {
  log('streaming: server mode (Deepgram)');
  const audioCtx = getAudioCtx();
  if (!audioCtx) { log('ERROR: audioCtx not created'); return; }

  // Re-acquire mic if stream died (BT disconnect/reconnect)
  if (activeStream && !activeStream.active) {
    log('stream inactive, re-acquiring mic...');
    try {
      const micDevice = settings.get().micDevice;
      const constraints = /** @type {MediaTrackConstraints} */ ({ ...AUDIO_CONSTRAINTS });
      if (micDevice) constraints.deviceId = { exact: micDevice };
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      log('mic re-acquired:', activeStream.getAudioTracks()[0]?.label);
    } catch (e) {
      log('mic re-acquire failed:', e.message);
      setStatus('Mic lost — tap Start Listening to retry');
      return;
    }
  }

  // Load AudioWorklet module once per context (re-registered on rebuild)
  if (workletLoadedCtx !== audioCtx) {
    try {
      await audioCtx.audioWorklet.addModule('/src/audio/audio-processor.js');
      workletLoadedCtx = audioCtx;
      log('AudioWorklet module loaded');
    } catch (e) {
      log('AudioWorklet load failed:', e.message);
      return;
    }
  }

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
    log('ctx resumed pre-connect');
  }

  const nativeRate = audioCtx.sampleRate;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws/deepgram?sample_rate=${nativeRate}&keyterms=${encodeURIComponent(getKeyterms())}`;
  log('DG proxy connecting, nativeRate=', nativeRate);

  dgSocket = new WebSocket(url);

  dgSocket.onopen = () => {
    // Reset wedge tracking on every fresh connection.
    lastDGMessageAt = Date.now();
    lastContentAudioAt = 0;
    dgWedged = false;
    // Notify subscribers (sttBackfill closes any open gap here).
    emit('dg-open', { ctxTime: getAudioCtx()?.currentTime ?? 0 });
    log('DG open, ctx state=', audioCtx.state);

    // Defensive: activeStream may have been nulled by a stop() racing with
    // this onopen (e.g. user toggled engine setting). If so, abort cleanly.
    if (!(activeStream instanceof MediaStream) || !activeStream.active) {
      log('DG open: activeStream missing/inactive — aborting');
      try { dgSocket.close(); } catch {}
      return;
    }

    setStatus(isConnected() ? 'Listening (server)' : 'Listening (server, gw offline)', 'live');

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => log('ctx resumed in DG open'));
    }

    // Set up audio processing (re-create nodes on each connect)
    try {
      if (workletNode) { try { workletNode.disconnect(); } catch {} }
      if (audioSource) { try { audioSource.disconnect(); } catch {} }
      audioSource = audioCtx.createMediaStreamSource(activeStream);
      workletNode = new AudioWorkletNode(audioCtx, 'audio-processor');
      log('audio nodes created (AudioWorklet)');
    } catch (e) {
      log('audio node error:', e.message);
      return;
    }

    audioFrames = 0;
    stallFrames = 0;

    // Shared barge-in detector — sliding-window peak check. Single source
    // of truth for the algorithm; the local-STT monitor uses the same one.
    const bargeEvaluate = bargeIn.createBargeInEvaluator(() => stopTts('barge-in'));

    // If we were on local fallback from a previous connection, switch back
    if (usingLocal) stopLocalFallback();

    workletNode.port.onmessage = (e) => {
      const { peak, buffer } = e.data;
      audioFrames++;

      // Surface the peak to the UI (mic-button pulse). Runs on every frame
      // regardless of DG/playback state — the goal is to reassure the user
      // that the mic is alive even when DG is wedged or TTS is playing.
      notifyMicPeak(peak);

      // Feed every audio frame to the backfill ring buffer — regardless
      // of whether DG is currently connected or not. During WS drops the
      // backfill keeps capturing raw audio so we can post-transcribe.
      // ArrayBuffer is transferable and unusable after this point (the
      // DG send below uses it), so we push a copy first. (sttBackfill
      // internally copies too, but we want a predictable contract.)
      try {
        sttBackfill.pushFrame(buffer.slice(0), audioCtx.currentTime);
      } catch (err) {
        if (audioFrames < 5) log('backfill push error:', err.message);
      }

      if (dgSocket?.readyState !== WebSocket.OPEN) return;

      const player = /** @type {HTMLAudioElement} */ (document.getElementById('player'));
      const playing = player && !player.paused && !player.ended;
      const inPlayback = isSpeaking() || playing;
      bargeEvaluate(peak, inPlayback);
      if (inPlayback) return;

      // Send audio to Deepgram
      try {
        dgSocket.send(buffer);
      } catch (err) {
        if (audioFrames < 5) log('send error:', err.message);
      }

      // ── Wedge detection ──────────────────────────────────────────────────
      // If the user is actively speaking (peak > DG_CONTENT_PEAK) but DG
      // hasn't sent us any message in DG_WEDGE_MS, treat the stream as
      // wedged and force a reconnect. DG's own timeout is 10s and
      // manifests as code 1011; by catching it earlier we skip the hang
      // and the user sees a shorter stall.
      const nowMs = Date.now();
      if (peak > DG_CONTENT_PEAK) lastContentAudioAt = nowMs;
      if (!dgWedged
          && lastContentAudioAt > 0
          && lastContentAudioAt > lastDGMessageAt
          && nowMs - lastDGMessageAt > DG_WEDGE_MS) {
        dgWedged = true;
        log(`DG wedged: ${((nowMs - lastDGMessageAt) / 1000).toFixed(1)}s since last message while sending speech — forcing reconnect`);
        // Fire before we close — gives subscribers (sttBackfill) a
        // chance to mark the gap start with the pre-close ctxTime.
        // dg-close will follow immediately via dgSocket.close() below.
        emit('dg-wedge', { ctxTime: audioCtx.currentTime });
        try { dgSocket.close(4000, 'wedge'); } catch {}
        // onclose handler schedules reconnect + flips to local fallback.
        return;
      }

      // ── Connection quality monitor ──────────────────────────────────────
      // bufferedAmount = bytes queued but not yet sent to the network.
      // If this grows, the connection can't keep up with the audio stream.
      // BUT: skip during the warmup window — TCP slow-start on a fresh WS
      // can transiently buffer even on a healthy connection, and we were
      // falsely falling back to local STT when the user started speaking
      // fast on mic-open (causing the "have to say something first to
      // warm up" feel).
      if (audioFrames >= STALL_WARMUP_FRAMES) {
        const buffered = dgSocket.bufferedAmount;
        if (buffered > STALL_BYTES) {
          stallFrames++;
          if (stallFrames === STALL_TRIGGER) {
            log(`DG stall detected: buffered=${buffered} bytes, ${stallFrames} frames`);
            if (settings.get().autoFallback) startLocalFallback();
            else setStatus('Deepgram stalled — reconnecting', 'live');
          }
        } else {
          if (stallFrames > 0 && usingLocal) {
            // Buffer drained — connection recovered. Switch back to Deepgram.
            stallFrames = 0;
            stopLocalFallback();
          }
          stallFrames = 0;
        }
      }
    };

    audioSource.connect(workletNode);
    workletNode.connect(audioCtx.destination);
    log('audio pipeline wired (AudioWorklet)');

    // Send keepalive every 5s so DG doesn't time out during TTS mute periods
    clearInterval(keepaliveInterval);
    keepaliveInterval = setInterval(() => {
      if (dgSocket?.readyState === WebSocket.OPEN) {
        try { dgSocket.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 5000);
  };

  dgSocket.onmessage = (ev) => {
    // Any message (even a Metadata/SpeechStarted ping) counts as "DG is
    // alive and responsive" — reset the wedge window.
    lastDGMessageAt = Date.now();
    dgWedged = false;
    const data = JSON.parse(ev.data);
    if (data.type === 'Results' || data.type === 'UtteranceEnd') {
      if (audioFrames < 200) log('DG msg:', data.type, data.is_final ? '(final)' : '');
      // Only forward DG results if we're not on local fallback
      // (avoids duplicate transcriptions from both engines)
      if (!usingLocal && activeCallback) activeCallback(data);
    }
  };

  dgSocket.onclose = (ev) => {
    log('DG close code=', ev.code, 'reason=', ev.reason || '(none)');
    clearInterval(keepaliveInterval);
    // Notify subscribers (sttBackfill opens a gap here).
    emit('dg-close', { code: ev.code, reason: ev.reason, ctxTime: getAudioCtx()?.currentTime ?? 0 });

    // If DG drops while listening, activate local fallback immediately —
    // but only when the user has opted in. Otherwise let the reconnect
    // loop bring Deepgram back; the user keeps the better recognizer.
    if (!intentionallyStopped && activeStream && !usingLocal && webspeechProvider.isAvailable()
        && settings.get().autoFallback) {
      startLocalFallback();
    }

    // Auto-reconnect unless we intentionally stopped
    if (!intentionallyStopped && activeStream) {
      log('DG reconnecting in 2s...');
      if (!usingLocal) setStatus('Deepgram reconnecting...', 'live');
      setTimeout(connect, 2000);
    }
  };

  dgSocket.onerror = () => { log('DG error event'); };
}
