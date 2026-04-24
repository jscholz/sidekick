/**
 * @fileoverview Background-lifecycle tracer for the mic-death bug.
 *
 * When iOS backgrounds the PWA, mic capture + audio context transitions
 * we can't catch at live-streaming rates. This module installs a set of
 * lifecycle + audio-state listeners and logs every transition to the
 * diag stream (with wall-clock ms) so we can see exactly which event
 * killed what when we resume the app.
 *
 * Enable via either:
 *   - URL ?bg_trace=1
 *   - localStorage.sidekick_bg_trace = '1'  (persists across PWA lifecycle)
 *
 * When enabled, call `install({ getStream, getAudioCtx, getKeepaliveEl })`
 * once on boot. The getters are lazy — we don't want to force eager
 * construction of any of these if the user hasn't enabled tracing.
 *
 * A ring buffer holds the last N events so the user can dump them after
 * a bench-test backgrounding round even if the debug panel wasn't open
 * when the bug fired.
 */

import { log, diag } from './util/log.ts';

const BUFFER_SIZE = 500;

type Entry = {
  t: number;          // wall-clock ms (Date.now())
  perf: number;       // performance.now() for delta math
  event: string;      // short tag (e.g. "visibilitychange")
  detail: string;     // state snapshot (stringified)
};

let enabled = false;
const ring: Entry[] = [];
let installed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let getters: Getters | null = null;

type Getters = {
  getStream: () => MediaStream | null;
  getAudioCtx: () => AudioContext | null;
  getKeepaliveEl: () => HTMLMediaElement | null;
};

function record(event: string, detail: string) {
  const entry: Entry = {
    t: Date.now(),
    perf: performance.now(),
    event,
    detail,
  };
  ring.push(entry);
  if (ring.length > BUFFER_SIZE) ring.shift();
  // Emit to diag stream too (debug panel) — each line is low-volume,
  // not a per-frame diagnostic, so OK to always surface when enabled.
  diag(`bg-trace: ${event} ${detail}`);
}

function snapshot(): string {
  if (!getters) return '';
  const parts: string[] = [];
  parts.push(`vis=${document.visibilityState}`);
  const ctx = getters.getAudioCtx();
  if (ctx) parts.push(`ctx=${ctx.state}`);
  const stream = getters.getStream();
  if (stream) {
    const tracks = stream.getAudioTracks();
    if (tracks.length) {
      const t = tracks[0];
      parts.push(`track=${t.readyState}${t.muted ? '/muted' : ''}${t.enabled ? '' : '/disabled'}`);
    } else {
      parts.push('track=<no-audio-tracks>');
    }
  } else {
    parts.push('stream=null');
  }
  const ka = getters.getKeepaliveEl();
  if (ka) {
    parts.push(`keepalive=${ka.paused ? 'paused' : 'playing'}@${ka.currentTime.toFixed(2)}`);
  }
  return parts.join(' ');
}

/** Call once on boot. Safe to call even when tracing is disabled — it
 *  reads the flag and silently noops in that case. */
export function install(g: Getters) {
  if (installed) return;
  enabled = (() => {
    try {
      const qs = new URLSearchParams(location.search);
      if (qs.get('bg_trace') === '1') return true;
      return localStorage.getItem('sidekick_bg_trace') === '1';
    } catch { return false; }
  })();
  if (!enabled) return;
  getters = g;
  installed = true;
  log('bg-trace: enabled — listening for lifecycle + audio-state events');
  // One-shot snapshot at install time to anchor subsequent deltas.
  record('install', snapshot());

  // visibility / pagehide / pageshow — iOS fires these when the user
  // home-button backgrounds the PWA. pagehide is the one that signals
  // the tab is being frozen; pageshow when restored.
  document.addEventListener('visibilitychange', () => record('visibilitychange', snapshot()));
  window.addEventListener('pagehide', (e: PageTransitionEvent) => {
    record('pagehide', `persisted=${e.persisted} ${snapshot()}`);
  });
  window.addEventListener('pageshow', (e: PageTransitionEvent) => {
    record('pageshow', `persisted=${e.persisted} ${snapshot()}`);
  });
  // Page Lifecycle API — freeze/resume. Not universally supported on
  // iOS Safari but cheap to listen for. Chrome fires these heavily.
  document.addEventListener('freeze', () => record('freeze', snapshot()));
  document.addEventListener('resume', () => record('resume', snapshot()));
  // focus/blur — browser-level input focus, orthogonal to visibility
  // but sometimes correlated on PWAs.
  window.addEventListener('focus', () => record('window.focus', snapshot()));
  window.addEventListener('blur', () => record('window.blur', snapshot()));

  // audioCtx state changes — if the AudioContext exists by install time,
  // hook its statechange event. If it comes to life later, the first
  // poll tick will catch it.
  let lastCtxState = '';
  let lastTrackState = '';
  let lastKeepalive = '';
  pollTimer = setInterval(() => {
    if (!getters) return;
    const ctx = getters.getAudioCtx();
    const ctxState = ctx?.state || 'null';
    if (ctxState !== lastCtxState) {
      record('ctx.state', `${lastCtxState} → ${ctxState}`);
      lastCtxState = ctxState;
    }
    const stream = getters.getStream();
    const track = stream?.getAudioTracks()?.[0];
    const trackState = track ? `${track.readyState}/${track.muted}/${track.enabled}` : 'null';
    if (trackState !== lastTrackState) {
      record('track.state', `${lastTrackState} → ${trackState}`);
      lastTrackState = trackState;
    }
    const ka = getters.getKeepaliveEl();
    const kaState = ka ? `${ka.paused ? 'paused' : 'playing'}@${ka.currentTime.toFixed(2)}` : 'null';
    if (kaState !== lastKeepalive) {
      record('keepalive', `${lastKeepalive} → ${kaState}`);
      lastKeepalive = kaState;
    }
  }, 1000);
}

/** Dump the ring buffer as a plain-text string, newest last. Each line is
 *  `[wallms]  +deltaMs  event  detail`. Useful for attaching to bug
 *  reports — paste into a message or save to a file. */
export function dump(): string {
  if (!ring.length) return '(bg-trace: empty)';
  const first = ring[0].perf;
  return ring.map(e => {
    const delta = (e.perf - first).toFixed(0).padStart(6);
    const wall = new Date(e.t).toISOString();
    return `[${wall}] +${delta}ms  ${e.event.padEnd(22)} ${e.detail}`;
  }).join('\n');
}

/** True when tracing is currently active. */
export function isEnabled() { return enabled; }
