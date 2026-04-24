/**
 * @fileoverview iOS audio unlock — must run synchronously inside a user gesture.
 * Creates the AudioContext and primes the <audio> element.
 */

import { log } from '../util/log.ts';

let audioCtx = null;
let unlocked = false;
let staleRoute = false;

export function isUnlocked() { return unlocked; }
export function getAudioCtx() { return audioCtx; }

/** Subscribers fired just before the AudioContext is torn down for a
 *  route rebuild. Consumers (tts.ts) must use this to drop any source
 *  nodes / in-flight state bound to the old context, otherwise
 *  activeReply.source becomes a dangling reference to a closed context
 *  and the state machine keeps reporting "playing" while the new
 *  context produces silence. Tear-down runs synchronously; subscribers
 *  can still use getAudioCtx() to fade out before the close. */
const routeChangeListeners = new Set<() => void>();
export function onRouteChange(fn: () => void) { routeChangeListeners.add(fn); }

/**
 * Call synchronously in a click handler. Creates AudioContext + primes <audio>.
 * If the audio route is flagged stale (a device change happened after
 * unlock — e.g. user connected BT headphones after opening the PWA),
 * rebuild the context so iOS binds playback to the new route.
 * @param {HTMLAudioElement} player
 */
export function unlock(player) {
  if (unlocked && !staleRoute) return;
  if (unlocked && staleRoute) {
    // Notify subscribers BEFORE closing the ctx so they can use the old
    // ctx for cleanup (gain fade-out, source.stop calls that would throw
    // on a closed ctx otherwise).
    for (const fn of routeChangeListeners) {
      try { fn(); } catch (e) { log('routeChange listener error:', e.message); }
    }
    try { audioCtx?.close(); } catch {}
    audioCtx = null;
    unlocked = false;
    staleRoute = false;
    log('audio: rebuilding context (route was stale)');
  }

  // Play a silent data URL to unlock the <audio> element on iOS.
  player.src = 'data:audio/mpeg;base64,/+MYxAAAAANIAAAAAExBTUUzLjk4LjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const p = player.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
  setTimeout(() => { try { player.pause(); } catch {} }, 50);

  // Create AudioContext inside the gesture — iOS requirement.
  try {
    const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    audioCtx = new Ctx();
    log('audioCtx created, state=', audioCtx.state, 'rate=', audioCtx.sampleRate);
    const r = audioCtx.resume();
    if (r && r.then) r.then(() => log('audioCtx resumed, state=', audioCtx.state));
  } catch (e) {
    log('audioCtx create error:', e.message);
  }

  unlocked = true;
}

/** Close the AudioContext so the next unlock() rebuilds fresh (and thereby
 *  picks up the current OS audio route). Callers should also stop any
 *  in-flight streaming and reset the <audio> element before this. */
export async function reset() {
  if (!unlocked) return;
  try { await audioCtx?.close(); } catch {}
  audioCtx = null;
  unlocked = false;
  staleRoute = false;
  log('audio: context closed (reset)');
}

// When the OS audio device set changes (BT headphones connect/disconnect,
// wired plugged, etc.) the existing iOS AudioContext keeps its old route.
// Flag stale so the next unlock() — which runs in a user gesture — can
// rebuild the context with the current route.
if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (unlocked) {
      staleRoute = true;
      log('audio: devicechange — route marked stale, will rebuild on next Stream');
    }
  });
}

// iOS PWA: when the app returns from background, AudioContext can be stuck
// in a suspended/interrupted state until the next user interaction. Try to
// resume it on visibility change — this is allowed without a gesture once
// the context has been initially unlocked.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
      audioCtx.resume().then(
        () => log('audioCtx resumed on visibilitychange, state=', audioCtx.state),
        () => { /* silent */ },
      );
    }
  });
}
