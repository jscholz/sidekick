/**
 * @fileoverview Tiny pub/sub for mic-peak values. Both DG and local-mode
 * worklet handlers call `notifyMicPeak(peak)` on every frame; main.ts
 * subscribes once to drive the live mic-button pulse UI.
 *
 * One-slot registry because there's only one consumer (the button).
 * No buffering, no throttling — the caller emits at worklet cadence
 * (~12Hz at 4096 samples / 48kHz) which is fine for CSS updates.
 */

/** @type {((peak: number) => void) | null} */
let listener = null;

export function setMicPeakListener(fn) { listener = fn; }

export function notifyMicPeak(peak) {
  if (listener) {
    try { listener(peak); } catch {}
  }
}
