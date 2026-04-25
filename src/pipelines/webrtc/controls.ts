/**
 * @fileoverview WebRTC button bindings — wires #btn-mic and #btn-speak
 * to the connection module.
 *
 * UX:
 *   #btn-mic   = Stream mode (mic in, transcripts via SSE, no TTS audio)
 *                Toggle: tap to open, tap to close.
 *   #btn-speak = Talk mode (mic in + TTS out — full-duplex call)
 *                Toggle: tap to open, tap to close.
 *
 * Mutual exclusion: only one mode is active at a time. Tapping the other
 * button while a session is open closes the current one and opens the
 * new one.  We don't try to "upgrade" stream→talk in place; the cost of
 * a fresh PC handshake on tailnet is tens of milliseconds.
 *
 * State surface: `setStateListener` registers a single callback that
 * fires on every CallState transition.  We use it to flip the visual
 * `.active` class on whichever button owns the current session.  The
 * status bar is owned by main.ts; we forward via a callback prop.
 */

import * as conn from './connection.ts';
import { log, diag } from '../../util/log.ts';

export interface ControlsOpts {
  getSessionId: () => string | null;
  onStatus?: (msg: string, kind?: 'ok' | 'err' | 'live' | null) => void;
}

let opts: ControlsOpts | null = null;

function btnEl(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

function setActive(mode: conn.CallMode | null, state: conn.CallState | null) {
  const mic = btnEl('btn-mic');
  const speak = btnEl('btn-speak');
  // Reset both, then mark the owning button.
  mic?.classList.remove('active', 'connecting');
  speak?.classList.remove('active', 'connecting');
  if (!mode) return;
  const owner = mode === 'stream' ? mic : speak;
  if (!owner) return;
  if (state === 'requesting-mic' || state === 'connecting') {
    owner.classList.add('connecting');
  } else if (state === 'connected') {
    owner.classList.add('active');
  } else if (state === 'closing' || state === 'failed') {
    // No class — clean state.
  }
}

export function init(o: ControlsOpts) {
  opts = o;

  conn.setStateListener((state, mode) => {
    log('[webrtc-controls] state=', state, 'mode=', mode);
    setActive(mode, state);
    if (!opts?.onStatus) return;
    if (state === 'requesting-mic') opts.onStatus('Requesting mic…');
    else if (state === 'connecting') opts.onStatus(`Connecting (${mode})…`);
    else if (state === 'connected') opts.onStatus(mode === 'talk' ? 'On call' : 'Streaming', 'ok');
    else if (state === 'closing') opts.onStatus('Closing…');
    else if (state === 'failed') opts.onStatus('Call failed', 'err');
    else if (state === 'idle') opts.onStatus('');
  });

  const mic = btnEl('btn-mic');
  if (mic) mic.onclick = () => void toggle('stream');

  const speak = btnEl('btn-speak');
  if (speak) speak.onclick = () => void toggle('talk');
}

async function toggle(mode: conn.CallMode) {
  const cur = conn.currentMode();
  // Already in this mode — close.
  if (cur === mode && conn.isOpen()) {
    log('[webrtc-controls] toggle close', mode);
    await conn.close();
    return;
  }
  // Different mode active — close it first, then open the new one.
  if (cur && cur !== mode) {
    log('[webrtc-controls] switch', cur, '→', mode);
    await conn.close();
  }
  try {
    await conn.open(mode, { sessionId: opts?.getSessionId() ?? null });
  } catch (e: any) {
    diag('[webrtc-controls] open failed', e?.message);
    if (opts?.onStatus) opts.onStatus(`Call error: ${e?.message ?? e}`, 'err');
  }
}

export async function closeIfOpen(): Promise<void> {
  if (conn.isOpen()) await conn.close();
}

export function isOpen(): boolean {
  return conn.isOpen();
}

export function currentMode(): conn.CallMode | null {
  return conn.currentMode();
}
