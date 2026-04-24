/**
 * @fileoverview Header status indicator. Two surfaces:
 *
 *  1. Primary line: human-visible, always shown. Callers use setStatus(msg, kind)
 *     to push a specific label (e.g. "Listening", "Speaking", "Reconnecting…").
 *     setState(state, ctx) is a higher-level helper that maps a known network
 *     state to a consistent text + kind, so multiple call sites stay aligned
 *     ("Weak signal" always renders the same way).
 *
 *  2. Debug line: only rendered when `?debug=1` or `localStorage.sidekick_debug=1`.
 *     Callers use setDebugStatus(msg) to push a raw diagnostic hint — last WS
 *     event, last fetch result, etc. Keeps the primary line clean for the
 *     curated user-visible narrative while still surfacing detail during dev.
 */

import { isDebugEnabled } from './util/log.ts';

let statusEl = null;
let textEl = null;
let debugEl = null;

/** Human-readable network states surfaced by setState(). Feature code
 *  (mic listening, TTS speaking) continues to use setStatus() directly;
 *  setState covers the connectivity narrative the user needs to reason
 *  about weak-signal / queue state. */
export type NetworkState =
  | 'notConnected'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'reconnecting'
  | 'weakSignal'
  | 'stalled'
  | 'offline';

export interface StateContext {
  /** Seconds remaining before next reconnect attempt. */
  retryIn?: number;
  /** Number of outbox items waiting to send. */
  queuedCount?: number;
  /** Total audio duration queued (ms). */
  queuedAudioMs?: number;
  /** Seconds of dictation buffered locally (sttBackfill ring). */
  bufferedSeconds?: number;
}

export function init(els) {
  statusEl = els.status;
  textEl = els.statusText;
  // Debug line gets created lazily under the primary status so it only
  // costs a DOM node when the flag is on.
  if (isDebugEnabled() && statusEl?.parentElement) {
    debugEl = document.createElement('span');
    debugEl.className = 'status-debug';
    debugEl.style.cssText = 'display:block;font-size:10px;color:var(--muted);font-family:var(--font-mono);margin-top:2px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    statusEl.parentElement.appendChild(debugEl);
  }
}

function fmtMmSs(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * @param {string} msg
 * @param {'ok'|'live'|'err'|undefined} [kind]
 */
export function setStatus(msg, kind?: 'ok' | 'live' | 'err') {
  if (textEl) textEl.textContent = msg;
  if (statusEl) {
    statusEl.classList.remove('ok', 'live', 'err');
    if (kind) statusEl.classList.add(kind);
  }
}

/** Map a network state to its canonical label + visual kind. Used by
 *  main.ts / backend adapters so the same state always renders the same
 *  way — easier to reason about at a glance. */
export function setState(state: NetworkState, ctx: StateContext = {}) {
  switch (state) {
    case 'notConnected': setStatus('Not connected'); return;
    case 'connecting': setStatus('Connecting…', 'live'); return;
    case 'connected': {
      // If there's a queue or a buffer, the user wants to see that —
      // "Connected" alone would miss a signal about pending work.
      const parts: string[] = ['Connected'];
      if (ctx.queuedCount && ctx.queuedCount > 0) {
        const dur = ctx.queuedAudioMs ? ` (${fmtMmSs(ctx.queuedAudioMs)} audio)` : '';
        parts.push(`— ${ctx.queuedCount} queued${dur}`);
      }
      if (ctx.bufferedSeconds && ctx.bufferedSeconds > 1) {
        parts.push(`— ${ctx.bufferedSeconds.toFixed(0)}s buffered`);
      }
      setStatus(parts.join(' '), 'ok');
      return;
    }
    case 'syncing': setStatus('Syncing…', 'live'); return;
    case 'reconnecting': {
      const txt = ctx.retryIn != null ? `Reconnecting in ${ctx.retryIn}s` : 'Reconnecting…';
      setStatus(txt, 'live');
      return;
    }
    case 'weakSignal': setStatus('Weak signal', 'err'); return;
    case 'stalled': {
      const dur = ctx.queuedAudioMs ? ` (${fmtMmSs(ctx.queuedAudioMs)})` : '';
      setStatus(`Stalled — ${ctx.queuedCount ?? '?'} queued${dur}`, 'err');
      return;
    }
    case 'offline': setStatus('Offline', 'err'); return;
  }
}

/** Secondary diagnostic line. No-op unless debug flag is on. Caller
 *  should include source + short summary (e.g. "ws: res ok",
 *  "tts: synth 412ms", "dg: msg Results is_final"). Line truncates
 *  via CSS ellipsis if it overflows. */
export function setDebugStatus(msg: string) {
  if (debugEl) debugEl.textContent = msg;
}
