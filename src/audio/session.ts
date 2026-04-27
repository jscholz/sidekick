/**
 * @fileoverview Background-audio persistence — cross-platform pieces.
 *
 * The Media Session API + DOM lifecycle events are cross-platform (Chrome,
 * Edge, Firefox, Safari all implement them). The iOS-only mechanisms —
 * AVAudioSession category management via WebKit's `navigator.audioSession`,
 * the silent-<audio> keepalive loop required for iOS PWA lockscreen
 * survival, and the standalone-PWA gating — live in ./ios-specific.ts.
 *
 * This module orchestrates both so callers don't need to think about the
 * split: init() wires up Media Session + lifecycle, and we re-export the
 * iOS hooks (prepareForCapture, getKeepaliveEl, isStandalone) so existing
 * call sites in main.ts and capture.ts don't have to switch imports.
 *
 * Mechanisms:
 *
 * 1. Media Session API — declares SideKick as an active audio app so iOS
 *    shows it on the lock screen and defers tab suspension. Also routes
 *    BT headset button presses (play/pause) into our handlers, which is
 *    how a Pixel Buds tap interacts with the app in-pocket.
 *
 * 2. Silent audio keepalive (iOS-only — see ./ios-specific.ts).
 *
 * 3. Lifecycle logging — records visibilitychange / pagehide / freeze /
 *    resume so we can tell, after the fact, what iOS did to us. Cross-
 *    platform DOM events; the iOS-keepalive reconciliation is delegated.
 */

import { log, diag } from '../util/log.ts';
import * as iosSpecific from './ios-specific.ts';

// Re-export iOS hooks so existing call-sites (capture.ts, main.ts) keep
// importing them off `audioSession.*` without churn. These are no-ops on
// non-iOS browsers via the feature-detection checks inside ios-specific.
// Using `export { ... } from` gives proper ES-module live bindings, which
// avoids the circular-import gotcha where ios-specific.ts also imports
// setPlaybackState from this module.
export {
  prepareForCapture,
  prepareForPlayback,
  isStandalone,
  getKeepaliveEl,
  setListening,
} from './ios-specific.ts';

let mediaSessionInit = false;

type SessionHandlers = {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onForeground?: () => void;
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
  log('audio session: init (standalone=', iosSpecific.isStandalone(), ')');
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
  // Track nav handlers (nexttrack / previoustrack / seekto) intentionally
  // omitted — per-turn replay machinery was gutted with the classic
  // pipeline. WebRTC's full-duplex talk-mode is a continuous call, not a
  // sequence of replayable tracks.
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

function initLifecycleLogging() {
  document.addEventListener('visibilitychange', () => {
    diag('lifecycle: visibility=', document.visibilityState);
    // iOS-only: reconcile silent-audio keepalive based on new visibility
    // state. No-op on browsers without the iOS PWA keepalive path.
    iosSpecific.reconcileKeepalive();
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
