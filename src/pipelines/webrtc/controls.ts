/**
 * @fileoverview WebRTC button bindings — wires #btn-mic and #btn-speak
 * to the connection module.
 *
 * UX:
 *   #btn-mic   = master on/off for the call. Tap to open, tap to close.
 *                Mode (stream vs talk) is derived at open time from the
 *                #btn-speak preference: speak-unmuted → talk; muted →
 *                stream. Once a call is open, tapping #btn-speak changes
 *                the *next* call's mode but does NOT cycle the current
 *                connection — that was the old wiring and it killed
 *                in-progress utterances on every preference flip.
 *   #btn-speak = TTS-reply preference. Tap to mute / unmute. Persists
 *                via settings.tts (default false = muted = stream
 *                mode).
 *
 * State surface: `setStateListener` registers a single callback that
 * fires on every CallState transition. We use it to flip the visual
 * `.active` class on #btn-mic only — #btn-speak's visual is the
 * `.muted` class driven independently by user preference.
 */

import * as conn from './connection.ts';
import * as dictation from './dictation.ts';
import * as duplex from './duplex.ts';
import * as settings from '../../settings.ts';
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
  if (!mic) return;
  // .active reflects whether the call is open in EITHER mode (mic is
  // the master on/off button — the choice of stream vs talk is a
  // separate preference). .connecting is purely additive while a new
  // call is mid-handshake.
  mic.classList.toggle('active', conn.isOpen());
  mic.classList.toggle(
    'connecting',
    state === 'requesting-mic' || state === 'connecting',
  );
}

export function init(o: ControlsOpts) {
  opts = o;

  conn.setStateListener((state, mode) => {
    log('[webrtc-controls] state=', state, 'mode=', mode);
    setActive(mode, state);
    // Reset the dictation state machine whenever a call ends so a
    // pending utterance buffer or silence timer doesn't leak across
    // calls. requesting-mic / connecting on a fresh open is also a
    // safe place to clear (idempotent).
    if (state === 'idle' || state === 'closing' || state === 'failed' || state === 'requesting-mic') {
      dictation.reset();
      duplex.onCallClose();
    }
    if (state === 'connected') {
      duplex.onCallOpen();
    }
    if (!opts?.onStatus) return;
    if (state === 'requesting-mic') opts.onStatus('Requesting mic…');
    else if (state === 'connecting') opts.onStatus(`Connecting (${mode})…`);
    else if (state === 'connected') opts.onStatus(mode === 'talk' ? 'On call' : 'Streaming', 'ok');
    else if (state === 'closing') opts.onStatus('Closing…');
    else if (state === 'failed') opts.onStatus('Call failed', 'err');
    else if (state === 'idle') opts.onStatus('');
  });

  const mic = btnEl('btn-mic');
  if (mic) mic.onclick = () => void toggleCall();

  const speak = btnEl('btn-speak');
  if (speak) {
    // Apply persisted preference at boot. settings.tts === true means
    // TTS replies are unmuted; false (default) means muted.
    applySpeakMuted(speak, !settings.get().tts);
    speak.onclick = () => {
      const nowMuted = !speak.classList.contains('muted');
      applySpeakMuted(speak, nowMuted);
      settings.set('tts', !nowMuted);
      // Mid-call clicks update preference for the NEXT call only.
      // We deliberately don't cycle the connection — the old wiring
      // did, and it tore down the user's in-progress utterance every
      // time. If a call is open, hint at this so it isn't surprising.
      if (conn.isOpen() && opts?.onStatus) {
        opts.onStatus(
          nowMuted ? 'TTS muted (next call)' : 'TTS on (next call)',
        );
      }
    };
  }
}

function applySpeakMuted(el: HTMLButtonElement, muted: boolean): void {
  el.classList.toggle('muted', muted);
  el.title = muted
    ? 'TTS reply — currently muted; tap to unmute · ⌥T'
    : 'TTS reply — currently on; tap to mute · ⌥T';
}

async function toggleCall() {
  // Master on/off. If a call is open, close it. Otherwise open one,
  // choosing the mode from the persisted #btn-speak preference.
  if (conn.isOpen()) {
    log('[webrtc-controls] toggleCall close (currentMode=', conn.currentMode(), ')');
    await conn.close();
    return;
  }
  const mode: conn.CallMode = settings.get().tts ? 'talk' : 'stream';
  log('[webrtc-controls] toggleCall open mode=', mode);
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
