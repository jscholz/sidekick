/**
 * @fileoverview Background-audio persistence for streaming interaction.
 *
 * Three mechanisms working together so conversation survives backgrounding
 * and screen lock on iOS (installed PWA):
 *
 * 1. Media Session API — declares SideKick as an active audio app so iOS
 *    shows it on the lock screen and defers tab suspension. Also routes
 *    BT headset button presses (play/pause) into our handlers, which is
 *    how a Pixel Buds tap interacts with the app in-pocket.
 *
 * 2. Silent audio keepalive — a muted AudioBufferSourceNode looping
 *    through audioCtx.destination. When the audio graph is actively
 *    producing output (even silent), iOS is far less eager to suspend the
 *    page's audio session. Pairs with Media Session's "playing" state.
 *
 * 3. Lifecycle logging — records visibilitychange / pagehide / freeze /
 *    resume so we can tell, after the fact, what iOS did to us.
 */

import { log, diag } from '../util/log.ts';
import { getAudioCtx } from './unlock.ts';

/** <audio> element playing a silent loop — iOS Safari's lockscreen /
 *  Apple Watch / background-audio heuristics look for `<audio>` playback,
 *  not Web Audio nodes. Having one hot keeps the PWA recognized as a
 *  media player while TTS / streaming is active. */
let keepaliveEl = null;
let keepaliveUrl = null;
let mediaSessionInit = false;

// State tracked so the visibilitychange handler knows when to engage the
// silent-audio keepalive. Foreground listening runs without keepalive so
// the barge-in worklet can read mic peaks (iOS's AEC silences the worklet
// mic path when any <audio> element is playing, even one with zero samples).
let listeningActive = false;

type SessionHandlers = {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onForeground?: () => void;
  onNextTrack?: () => void;
  onPreviousTrack?: () => void;
  onSeekTo?: (time: number) => void;
};
let handlers: SessionHandlers = {};

/** Call once on app load. Sets up Media Session metadata + lifecycle log.
 *  Does NOT pin audioSession.type — callers (main.ts, tts.ts) set that
 *  just-in-time before getUserMedia / TTS playback. Pinning at boot made
 *  the hint sticky and prevented iOS from transitioning BT from HFP to
 *  A2DP for TTS, silencing mobile audio output. */
export function init(opts: SessionHandlers = {}) {
  handlers = opts;
  initMediaSession();
  initLifecycleLogging();
  log('audio session: init (standalone=', isStandalone(), ')');
}

/** Set the WebKit `navigator.audioSession.type` hint. iOS 17+ uses this
 *  to decide AVAudioSession category — which in turn affects whether BT
 *  A2DP output is available, whether new mic capture is allowed, etc.
 *  This is the single seam for session-type changes — no other module
 *  should touch navigator.audioSession.type directly. */
function setSessionType(type: string) {
  const as = (navigator as any).audioSession;
  if (!as) return;
  try { as.type = type; } catch {}
}

/** Ensure the AudioSession category is capture-compatible. Call right
 *  before getUserMedia so any prior 'playback' hint (from TTS) is cleared. */
export function prepareForCapture() { setSessionType('play-and-record'); }

/** Hint 'playback' category — enables BT A2DP routing for TTS while
 *  keeping mic capture working (iOS permits both as long as the session
 *  started in play-and-record). Call at the start of TTS playback. */
export function prepareForPlayback() { setSessionType('playback'); }

/** True if the PWA is running as a standalone app (home-screen install).
 *  Safari-tab PWAs do NOT get background audio latitude. */
export function isStandalone() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    // iOS Safari legacy flag
    if ((window.navigator as any).standalone === true) return true;
  } catch {}
  return false;
}

async function initMediaSession() {
  if (mediaSessionInit) return;
  if (!('mediaSession' in navigator)) { log('mediaSession API not available'); return; }
  mediaSessionInit = true;

  try {
    // Pulled from /config so the community build + personal rebrands
    // (R2 "Sidekick", etc.) each get their own lockscreen/BT label.
    const { getAgentLabel, getAppName } = await import('../config.ts');
    /** @type {any} */ (navigator).mediaSession.metadata = new MediaMetadata({
      title: getAgentLabel(),
      artist: getAppName(),
      // artwork: [{ src: '/assets/icon.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch (e) { log('mediaSession metadata error:', e.message); }

  const set = (action, fn) => {
    try { /** @type {any} */ (navigator).mediaSession.setActionHandler(action, fn); }
    catch (e) { log(`mediaSession ${action} handler error:`, e.message); }
  };
  set('play',  () => { log('mediaSession: play');  handlers.onPlay?.(); });
  set('pause', () => { log('mediaSession: pause'); handlers.onPause?.(); });
  set('stop',  () => { log('mediaSession: stop');  handlers.onStop?.(); });
  // Track nav — used by BT double-tap (via AVRCP → 'nexttrack') and by
  // the iOS Control Center / Android media-notification skip buttons.
  // 'nexttrack' on the latest reply is semantically "skip the current
  // thing" — i.e. barge-in. previoustrack replays the prior reply.
  set('nexttrack',     () => { log('mediaSession: nexttrack');     handlers.onNextTrack?.(); });
  set('previoustrack', () => { log('mediaSession: previoustrack'); handlers.onPreviousTrack?.(); });
  set('seekto', (details) => {
    const t = (details && typeof details.seekTime === 'number') ? details.seekTime : 0;
    log('mediaSession: seekto', t);
    handlers.onSeekTo?.(t);
  });
  log('mediaSession handlers installed');
}

/** Update the Media Session "now playing" position hint. iOS/Android use
 *  this to draw the scrub bar on the lock screen and control center.
 *  duration/position in seconds; rate usually 1.0. */
export function setPositionState(duration, position, rate = 1.0) {
  if (!('mediaSession' in navigator)) return;
  try {
    /** @type {any} */ (navigator).mediaSession.setPositionState({
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      position: Number.isFinite(position) && position >= 0 ? position : 0,
      playbackRate: rate,
    });
  } catch {}
}

/** Set Media Session playback state — drives lock-screen UI + suspension
 *  heuristics. 'playing' while streaming or TTS is active; 'paused' when
 *  idle but still ready; 'none' when not listening at all. */
export function setPlaybackState(state) {
  if (!('mediaSession' in navigator)) return;
  try { /** @type {any} */ (navigator).mediaSession.playbackState = state; }
  catch {}
}

/** Generate a near-silent 1-second WAV blob at runtime. Samples carry a
 *  tiny non-zero white-noise floor (amplitude ~3 of 32767, ≈ -80 dB) —
 *  inaudible on any speaker but loud enough that iOS treats the element
 *  as "actually playing audio" and doesn't suspend the tab / audio
 *  session once TTS stops. Pure-zero PCM was being detected as silent
 *  and iOS suspended after TTS end even with keepalive running. */
function makeSilentWav(durationSec = 1, sampleRate = 8000) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;  // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);         // 16-bit
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // Fill with ±3 white noise — -80 dBFS, inaudible, but iOS sees "real" audio.
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor((Math.random() - 0.5) * 6);  // -3..+3
    view.setInt16(44 + i * 2, sample, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function ensureKeepaliveEl() {
  if (keepaliveEl) return keepaliveEl;
  keepaliveUrl = URL.createObjectURL(makeSilentWav(1));
  keepaliveEl = document.createElement('audio');
  keepaliveEl.id = 'audio-keepalive';
  keepaliveEl.src = keepaliveUrl;
  keepaliveEl.loop = true;
  keepaliveEl.preload = 'auto';
  keepaliveEl.setAttribute('playsinline', '');
  // Keep volume at 1.0 — iOS silences suspiciously quiet elements. The
  // WAV itself is all zero samples, so output is actually silent.
  keepaliveEl.volume = 1.0;
  document.body.appendChild(keepaliveEl);
  return keepaliveEl;
}

/** Start silent <audio> keepalive + set playback state. Used via
 *  setListening() + visibilitychange automation; callers shouldn't normally
 *  invoke directly. */
function startKeepalive() {
  const el = ensureKeepaliveEl();
  const p = el.play();
  if (p && typeof p.catch === 'function') p.catch((e) => log('keepalive play failed:', e.message));
  setPlaybackState('playing');
  diag('audio session: keepalive playing');
}

function stopKeepalive() {
  if (!keepaliveEl) return;
  try { keepaliveEl.pause(); } catch {}
  setPlaybackState('none');
  diag('audio session: keepalive paused');
}

/** Called from main.ts when streaming listening toggles on/off.
 *  Keepalive runs only while listening AND the tab is hidden — foreground
 *  listening keeps barge-in viable; background listening trades barge-in
 *  for lockscreen persistence. On listen-start, we prime the element with
 *  play+pause inside the click gesture so later background play() calls
 *  don't get blocked by iOS's "no audio outside user gesture" rule.
 *
 *  Skipped entirely when not running as installed PWA — there's no
 *  background audio to persist (browser tabs don't qualify for lockscreen
 *  treatment), and on Chrome desktop the idle keepalive element seems to
 *  interfere with SpeechSynthesis output. */
export function setListening(on) {
  listeningActive = !!on;
  if (!isStandalone()) return;  // no keepalive in browser tabs
  if (on) primeKeepalive();
  reconcileKeepalive();
}

/** Unlock the <audio> element for later background playback by playing it
 *  briefly inside the current user gesture, then pausing. iOS tracks
 *  "element has been played by a gesture" and subsequent play() calls
 *  from visibilitychange handlers are allowed. */
function primeKeepalive() {
  const el = ensureKeepaliveEl();
  const p = el.play();
  if (p && typeof p.then === 'function') {
    p.then(() => {
      // Don't pause if reconcileKeepalive already wants it running (e.g.
      // started foreground via a rare race with visibilitychange).
      if (!(listeningActive && document.visibilityState === 'hidden')) {
        try { el.pause(); el.currentTime = 0; } catch {}
      }
      diag('audio session: keepalive primed');
    }).catch((e) => log('keepalive prime failed:', e.message));
  }
}

function reconcileKeepalive() {
  if (!isStandalone()) return;
  const shouldRun = listeningActive && document.visibilityState === 'hidden';
  const isRunning = keepaliveEl && !keepaliveEl.paused;
  if (shouldRun && !isRunning) startKeepalive();
  else if (!shouldRun && isRunning) stopKeepalive();
}

/** Listener reinstalled in initLifecycleLogging — it also reconciles keepalive. */

function initLifecycleLogging() {
  document.addEventListener('visibilitychange', () => {
    diag('lifecycle: visibility=', document.visibilityState);
    reconcileKeepalive();
    if (document.visibilityState === 'visible' && handlers.onForeground) {
      handlers.onForeground();
    }
  });
  window.addEventListener('pagehide', (e) => diag('lifecycle: pagehide persisted=', /** @type {any} */ (e)?.persisted));
  document.addEventListener('freeze', () => diag('lifecycle: freeze'));
  document.addEventListener('resume', () => diag('lifecycle: resume'));
  window.addEventListener('focus', () => diag('lifecycle: focus'));
  window.addEventListener('blur', () => diag('lifecycle: blur'));
}
