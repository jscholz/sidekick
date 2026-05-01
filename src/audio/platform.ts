/**
 * @fileoverview Audio platform shim — single point where the PWA touches
 * raw Web Audio + MediaStream APIs. Centralizes iOS-specific quirks
 * (gesture-bound AudioContext creation, route-stale rebuild on
 * devicechange, suspended-context resume, MediaStream exclusivity edge
 * cases) so they're handled in one file. Every audio-using module
 * (feedback, memo, fakeLock, webrtc capture) imports from here instead
 * of reaching for `new AudioContext`, `getUserMedia`,
 * `createMediaStreamSource` directly.
 *
 * Why this module exists: cross-device audio bugs (iOS pocketlock
 * waveform, missing chime on iOS, suspended-context regressions) kept
 * surfacing because each feature that touched audio handled iOS quirks
 * itself, and they drifted out of sync. A single platform layer means
 * future iOS fixes land in ONE function instead of four.
 *
 * This file is the canonical home of:
 *   - the shared AudioContext (resumed lazily; survives route changes
 *     via the audio-unlock devicechange listener)
 *   - the gesture-bound audio "primer" call (was iOS audio-unlock)
 *   - the canonical mic-stream getter (delegates to audio/capture.ts
 *     which already wraps getUserMedia + iOS AVAudioSession prep)
 *   - the canonical mic analyser builder (handles iOS suspended-context
 *     resume + WebRTC stream gotchas)
 *   - chime playback (was audio/feedback.ts; will move here in Phase 2.3)
 *
 * Phase 2.1 — initial commit creates the surface and DELEGATES to
 * existing modules so behavior is unchanged. Subsequent commits migrate
 * callers one at a time.
 *
 * Hard rule: outside this file, `grep -E 'new (window\\.)?AudioContext|
 * navigator\\.mediaDevices\\.getUserMedia|createMediaStreamSource'`
 * should return zero hits in src/. Audit lives in CONTRIBUTING.md and
 * is enforced by the grep step in Phase 2.7.
 */

import { unlock as unlockImpl, getAudioCtx as getCtxImpl, isUnlocked as isUnlockedImpl, onRouteChange as onRouteChangeImpl, reset as resetCtxImpl } from '../ios/audio-unlock.ts';
import * as captureImpl from './capture.ts';
import { playFeedback as playFeedbackImpl } from './feedback.ts';

// ── AudioContext lifecycle ─────────────────────────────────────────────

/** Prime the audio system inside a user-gesture event handler. iOS
 *  Safari refuses to create an AudioContext or play audio outside a
 *  user gesture; this call must originate from a click/touchstart
 *  handler, not from an async chain that follows one. Pass any
 *  HTMLAudioElement (typically the global remote-audio sink) — used
 *  to also "unlock" iOS's HTMLAudioElement.play() permission via a
 *  silent data-URL prime.
 *
 *  Idempotent: if already primed and the audio route hasn't changed,
 *  returns immediately. If the route went stale (devicechange fired —
 *  user plugged in BT headphones, etc.) the underlying AudioContext is
 *  rebuilt so playback binds to the new route.
 *
 *  No-op on desktop browsers — they don't enforce gesture binding.
 *  Was previously named `unlock(player)` (iOS-jargon "audio unlock");
 *  the renamed `primeAudio` avoids semantic collision with the
 *  pocket-lock / fake-lock UI overlay.
 */
export function primeAudio(player: HTMLAudioElement): void {
  unlockImpl(player);
}

/** Has primeAudio() been called successfully (i.e. the gesture-bound
 *  AudioContext exists)? */
export function isPrimed(): boolean {
  return isUnlockedImpl();
}

/** Get the shared, gesture-primed AudioContext, or null if primeAudio
 *  hasn't run yet. Callers SHOULD prefer this over constructing their
 *  own context — multiple AudioContexts can race each other for the
 *  hardware audio route on iOS. If null is returned, the caller
 *  typically can't safely create a fallback (would be suspended on
 *  iOS); they should defer their work or call primeAudio() inside the
 *  next user gesture. */
export function getSharedAudioCtx(): AudioContext | null {
  return getCtxImpl();
}

/** Subscribe to route-change events — fired just before the shared
 *  AudioContext is closed and rebuilt to bind to a new audio route
 *  (BT headphones connected, wired plug etc.). Subscribers should
 *  drop any nodes / source references that depend on the old context.
 *  Returns an unsubscribe function. */
export function onRouteChange(fn: () => void): void {
  onRouteChangeImpl(fn);
}

/** Tear down the shared AudioContext so the next primeAudio() rebuilds
 *  fresh. Used by call-end / settings-reset paths. */
export async function resetAudioCtx(): Promise<void> {
  await resetCtxImpl();
}

// ── Mic acquisition ────────────────────────────────────────────────────

/** Acquire the shared mic MediaStream. Wraps the existing centralized
 *  capture path which handles iOS AVAudioSession category prep before
 *  getUserMedia. Idempotent: returns the active stream if already
 *  acquired (refcount semantics live inside capture.ts). */
export const getMicStream = captureImpl.acquire;

/** Release a mic-stream refcount. When the count hits zero, the
 *  underlying MediaStream tracks are stopped and the stream reference
 *  is cleared. */
export const releaseMicStream = captureImpl.release;

/** Build a Web Audio AnalyserNode against a MediaStream. Returns null
 *  if the platform/stream combo can't yield analysable frames (iOS
 *  Safari tends to bind WebRTC mic streams exclusively to the peer
 *  connection — `createMediaStreamSource` succeeds without throwing
 *  but the analyser sees zero frames; caller can fall back to a
 *  static "listening" indicator).
 *
 *  Phase 2.1 stub: delegates to a minimal implementation. Phase 2.2
 *  will fold in fakeLock's existing wiring (resume-suspended-ctx,
 *  meterCtx fallback). The eventual iOS-pocketlock-waveform fix lives
 *  inside this function.
 */
export function getMicAnalyser(stream: MediaStream, fftSize: number = 256): AnalyserNode | null {
  if (!stream || stream.getAudioTracks().length === 0) return null;
  const ctx = getSharedAudioCtx();
  if (!ctx) return null;
  // Best-effort resume — iOS suspended-context guard. Async; safe to
  // ignore the promise (createMediaStreamSource works during the
  // resume window if a prior gesture has primed audio).
  if (ctx.state !== 'running') {
    try { ctx.resume().catch(() => {}); } catch { /* ignore */ }
  }
  try {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    source.connect(analyser);
    return analyser;
  } catch {
    return null;
  }
}

// ── Chime playback ─────────────────────────────────────────────────────

/** Play a short feedback chime. Delegates to audio/feedback.ts which
 *  pulls the shared AudioContext via getAudioCtx (NOT via this shim —
 *  feedback.ts is a leaf to avoid a circular import). */
export const playChime = playFeedbackImpl;

export type ChimeName = Parameters<typeof playFeedbackImpl>[0];

// ── One-shot decode (non-realtime) ─────────────────────────────────────

/** Decode an audio blob to PCM. One-shot, non-realtime — used by
 *  voice-memo waveform extraction and similar tooling. Allocates a
 *  throwaway OfflineAudioContext so it doesn't conflict with the
 *  shared realtime context. iOS doesn't enforce gesture-binding for
 *  decodeAudioData, so this works regardless of prime state.
 *
 *  Returns the AudioBuffer; caller does whatever processing they
 *  want and lets the GC reclaim the buffer + temp ctx. */
export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  // Use a one-shot AudioContext for decodeAudioData. OfflineAudioContext
  // would be cleaner (no audio device acquired) but its decodeAudioData
  // signature is identical and creating the realtime variant doesn't
  // hurt for a one-off decode. Caller never needs to touch this ctx.
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}
