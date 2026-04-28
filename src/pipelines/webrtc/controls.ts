/**
 * @fileoverview WebRTC speaker bindings + call lifecycle helpers.
 *
 * The toolbar #btn-mic that used to live here is gone — the unified
 * composer mic now drives all four voice modes (memo/call × auto/manual)
 * and invokes `toggleCall` / `closeIfOpen` directly through this module's
 * exports.  What remains:
 *
 *   #btn-speak = TTS-reply preference. Tap to mute / unmute. Persists
 *                via settings.tts (default false = muted = stream
 *                mode at call open). Mid-call clicks update the
 *                preference for the NEXT call only — we don't cycle
 *                the connection (the old wiring did, and it killed
 *                in-progress utterances on every flip).
 *
 *   toggleCall / closeIfOpen / isOpen / currentMode = exports the
 *   composer-mic dispatch in main.ts uses to open/close a stream-mode
 *   or talk-mode call. Mode (stream vs talk) derives from
 *   settings.tts AT THE TIME OF CALL OPEN.
 */

import * as conn from './connection.ts';
import * as dictation from './dictation.ts';
import * as suppress from './suppress.ts';
import * as settings from '../../settings.ts';
import * as backend from '../../backend.ts';
import { log, diag } from '../../util/log.ts';

/** Resolve the (sessionId, chatId) pair to ship in the offer payload.
 *  hermes-gateway uses chat_ids; everything else uses the legacy
 *  conv_name/sessionId. The bridge picks the dispatch route based on
 *  which one is set — see audio-bridge/stt_bridge.py:_dispatch_to_agent. */
function resolveCallSession(): { sessionId: string | null; chatId: string | null } {
  const id = opts?.getSessionId() ?? null;
  if (backend.name() === 'hermes-gateway') {
    return { sessionId: null, chatId: id };
  }
  return { sessionId: id, chatId: null };
}

export interface ControlsOpts {
  getSessionId: () => string | null;
  onStatus?: (msg: string, kind?: 'ok' | 'err' | 'live' | null) => void;
}

let opts: ControlsOpts | null = null;

function btnEl(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

export function init(o: ControlsOpts) {
  opts = o;

  conn.setStateListener((state, mode) => {
    log('[webrtc-controls] state=', state, 'mode=', mode);
    // Reflect call-open state on the unified composer mic so the user
    // sees a visual cue that voice is live. Memo + dictate paths flip
    // the same class via their own listeners — only one of the three
    // is ever active at a time.
    const mic = btnEl('btn-mic');
    if (mic) {
      mic.classList.toggle('active', conn.isOpen());
      mic.classList.toggle(
        'connecting',
        state === 'requesting-mic' || state === 'connecting',
      );
      // Clear the "actually listening" pulse when the call closes.
      // The bridge's {type:'listening'} envelope adds it; we clear here
      // so the visual reflects state immediately on close instead of
      // lingering until next paint.
      if (!conn.isOpen()) mic.classList.remove('listening');
    }
    // Reset the dictation state machine whenever a call ends so a
    // pending utterance buffer or silence timer doesn't leak across
    // calls. requesting-mic / connecting on a fresh open is also a
    // safe place to clear (idempotent).
    if (state === 'idle' || state === 'closing' || state === 'failed' || state === 'requesting-mic') {
      dictation.reset();
      suppress.reset();
    }
    if (!opts?.onStatus) return;
    if (state === 'requesting-mic') opts.onStatus('Requesting mic…');
    else if (state === 'connecting') opts.onStatus(`Connecting (${mode})…`);
    else if (state === 'connected') opts.onStatus(mode === 'talk' ? 'On call' : 'Streaming', 'ok');
    else if (state === 'closing') opts.onStatus('Closing…');
    else if (state === 'failed') opts.onStatus('Call failed', 'err');
    else if (state === 'idle') opts.onStatus('');
  });

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

/** Open a call (or close if one is open). Mode derives from
 *  settings.tts at the time of open: tts=true → talk (TTS audio),
 *  tts=false → stream (STT only, no TTS). Surfaces errors via the
 *  onStatus callback. */
export async function toggleCall(): Promise<void> {
  if (conn.isOpen()) {
    log('[webrtc-controls] toggleCall close (currentMode=', conn.currentMode(), ')');
    await conn.close();
    return;
  }
  const mode: conn.CallMode = settings.get().tts ? 'talk' : 'stream';
  log('[webrtc-controls] toggleCall open mode=', mode);
  try {
    await conn.open(mode, resolveCallSession());
  } catch (e: any) {
    diag('[webrtc-controls] open failed', e?.message);
    if (opts?.onStatus) opts.onStatus(`Call error: ${e?.message ?? e}`, 'err');
  }
}

/** Open a call in a specific mode without consulting settings.tts.
 *  Used by the composer mic when call-mode is requested — auto-send=true
 *  needs the talk/stream choice driven by btn-speak preference (which is
 *  stored in settings.tts), but the COMPOSER mic might want to force
 *  stream regardless (e.g. for cursor-aware dictation, where TTS makes
 *  no sense). Idempotent if a matching call is already open. */
export async function openCall(mode: conn.CallMode): Promise<void> {
  if (conn.isOpen()) {
    if (conn.currentMode() === mode) return;  // already in the right mode
    await conn.close();
  }
  log('[webrtc-controls] openCall mode=', mode);
  try {
    await conn.open(mode, resolveCallSession());
  } catch (e: any) {
    diag('[webrtc-controls] openCall failed', e?.message);
    if (opts?.onStatus) opts.onStatus(`Call error: ${e?.message ?? e}`, 'err');
    throw e;
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
