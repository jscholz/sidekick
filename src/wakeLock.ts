/**
 * @fileoverview Screen Wake Lock — keeps phone awake while listening.
 *
 * Ref-counted, keyed API so multiple subsystems can hold the lock
 * independently without stepping on each other:
 *
 *   - 'setting'  — user's "Pocket Lock / Stay Awake" toggle (app-lifecycle)
 *   - 'memo'     — voice memo capture (held while recording)
 *   - 'streaming' — live-mic streaming (held while the mic is open)
 *
 * The underlying OS sentinel is acquired when the first key registers
 * and released when the last key departs. iOS drops the OS sentinel on
 * visibility→hidden; the holders set persists so we re-acquire on
 * visibility→visible.
 */

import { log } from './util/log.ts';

const holders = new Set<string>();
let sentinel: any = null;

async function ensureSentinel(): Promise<void> {
  if (sentinel) return;
  if (!('wakeLock' in navigator)) { log('wakeLock API not supported'); return; }
  try {
    sentinel = await (navigator as any).wakeLock.request('screen');
    log('wakeLock acquired');
    sentinel.addEventListener('release', () => {
      log('wakeLock released');
      // OS dropped the sentinel (visibility→hidden). Our holders set still
      // reflects intent; watchVisibility will re-acquire when the page
      // returns to foreground.
      sentinel = null;
    });
  } catch (e: any) {
    log('wakeLock error:', e.message);
  }
}

async function dropSentinel(): Promise<void> {
  if (!sentinel) return;
  try { await sentinel.release(); } catch {}
  sentinel = null;
}

/** Register a holder key and ensure the OS sentinel is live. Idempotent
 *  per key — calling twice with the same key is a no-op on the second call.
 *  @param {string} key - Holder identity (e.g. 'setting', 'memo', 'streaming'). */
export async function acquire(key: string = 'default'): Promise<void> {
  holders.add(key);
  await ensureSentinel();
}

/** Drop a holder key. If it was the last holder, release the OS sentinel. */
export async function release(key: string = 'default'): Promise<void> {
  holders.delete(key);
  if (holders.size === 0) await dropSentinel();
}

/** True when any holder has the lock registered (whether or not the OS
 *  sentinel is currently live — iOS drops it on hide). */
export function isHeld(): boolean { return holders.size > 0; }

/** Re-acquire on visibility change. iOS releases the wake lock when the
 *  page is hidden; we need to re-request every time the tab comes back
 *  if any holder is still registered. Also re-check after the `resume`
 *  event (iOS "freeze/resume" lifecycle — fires when the page was
 *  suspended mid-foreground, a pattern that happens when the phone is
 *  pulled out of a pocket quickly).
 *
 *  Callers used to pass a `shouldHold` predicate; the ref-counted holders
 *  set is now authoritative, so no predicate is needed. Signature kept
 *  permissive for backward compat but the argument is ignored. */
export function watchVisibility(_shouldHold?: () => boolean): void {
  const tryHold = () => {
    if (document.visibilityState !== 'visible') return;
    if (holders.size === 0) return;
    if (sentinel) return;  // already held
    ensureSentinel();
  };
  document.addEventListener('visibilitychange', tryHold);
  window.addEventListener('focus', tryHold);
  // `resume` is dispatched by Safari after a `freeze` (bfcache-style
  // mid-foreground suspension). Standard visibilitychange doesn't
  // always fire here.
  document.addEventListener('resume', tryHold);
}
