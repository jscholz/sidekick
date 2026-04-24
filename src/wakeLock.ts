/**
 * @fileoverview Screen Wake Lock — keeps phone awake while listening.
 */

import { log } from './util/log.ts';

let sentinel = null;

export async function acquire() {
  if (!('wakeLock' in navigator)) { log('wakeLock API not supported'); return; }
  try {
    sentinel = await navigator.wakeLock.request('screen');
    log('wakeLock acquired');
    sentinel.addEventListener('release', () => log('wakeLock released'));
  } catch (e) {
    log('wakeLock error:', e.message);
  }
}

export async function release() {
  if (sentinel) {
    try { await sentinel.release(); } catch {}
    sentinel = null;
  }
}

export function isHeld() { return !!sentinel; }

/** Re-acquire on visibility change. iOS releases the wake lock when the
 *  page is hidden; we need to re-request every time the tab comes back
 *  if the user's intent (via `shouldHold`) is still to hold. Also
 *  re-check after the `resume` event (iOS "freeze/resume" lifecycle —
 *  fires when the page was suspended mid-foreground, a pattern that
 *  happens when the phone is pulled out of a pocket quickly). */
export function watchVisibility(shouldHold) {
  const tryHold = () => {
    if (document.visibilityState !== 'visible') return;
    if (!shouldHold()) return;
    if (sentinel) return;  // already held
    acquire();
  };
  document.addEventListener('visibilitychange', tryHold);
  window.addEventListener('focus', tryHold);
  // `resume` is dispatched by Safari after a `freeze` (bfcache-style
  // mid-foreground suspension). Standard visibilitychange doesn't
  // always fire here.
  document.addEventListener('resume', tryHold);
}
