/**
 * @fileoverview Dictate-mode lifecycle — streaming STT to the composer
 * textarea. The 4th voice mode alongside call(talk), call(stream), and
 * memo. Targets the "I want to dictate, then edit, then send manually"
 * workflow (a la macOS dictation), distinct from call modes (auto-dispatch
 * via dictation.ts) and memo (offline-first, batch transcribe on send).
 *
 * Lifecycle:
 *   start()
 *     1. Open a `stream`-mode WebRTC connection (mic in, transcripts via
 *        data channel, no TTS out).
 *     2. Register a private data-channel listener that filters role=user
 *        transcripts and routes them to the composer textarea — append at
 *        end-of-textarea for finals; replace the trailing in-progress
 *        chunk for interims.
 *     3. Bypass dictation.ts entirely. NO commit-phrase, NO silence-timer,
 *        NO auto-dispatch. Send is user-triggered (Send button click /
 *        Esc / toggle off).
 *
 *   stop()
 *     - Close the WebRTC connection. Restore the prior data-channel
 *       listener (so call-mode dictation routing isn't broken if the
 *       caller re-opens a call afterwards).
 *
 * Offline fallback isn't this module's job — main.ts checks
 * `navigator.onLine` before calling start() and falls through to the
 * memo path when offline. This keeps dictate.ts focused on the online
 * streaming case.
 *
 * Composer routing rules:
 *   - Final segments append at end-of-textarea, with a trailing space.
 *   - Interim segments replace the trailing "in-progress chunk" — we
 *     track the buffer length at the moment the interim started so
 *     subsequent interims overwrite that segment instead of appending.
 *   - Cursor position is NOT moved if the user has placed it elsewhere.
 *     Speech inserts at end-of-textarea; the user's typing stays where
 *     they put it.
 */

import * as conn from './connection.ts';
import { log, diag } from '../../util/log.ts';

let active = false;
let composerInput: HTMLTextAreaElement | null = null;
/** Length of the textarea value at the moment the current in-progress
 *  interim chunk started. Each new interim slices the textarea to this
 *  position and appends the new interim text — so the trailing chunk
 *  is always the latest interim, not an accumulation. Reset to the
 *  current value length after each final commit. */
let interimAnchor = 0;
/** Saved data-channel listener so we can restore it on stop(). The
 *  call-mode wiring in main.ts registers a listener at boot; we replace
 *  it during dictate so call-mode handlers don't double-fire. */
let savedListener: ((ev: any) => void) | null = null;
let onStateChangeCb: ((opening: boolean, error?: string) => void) | null = null;

/** Register a single state-change handler. Fires with (true) when
 *  start() resolves successfully and (false) on stop(). Errors are
 *  surfaced via the second arg. */
export function setStateListener(cb: (opening: boolean, error?: string) => void): void {
  onStateChangeCb = cb;
}

export function isActive(): boolean {
  return active;
}

function notify(opening: boolean, error?: string): void {
  if (!onStateChangeCb) return;
  try { onStateChangeCb(opening, error); } catch { /* ignore */ }
}

/** Bind the composer textarea once on boot. Stored at module scope so
 *  start() doesn't have to re-query each time. */
export function init(input: HTMLTextAreaElement | null): void {
  composerInput = input;
}

/** Append a final transcript segment to the composer at end-of-textarea,
 *  separated by a space when needed. Fires the same 'input' event the
 *  composer's existing listeners react to (autoResize +
 *  updateSendButtonState). */
function appendFinal(text: string): void {
  if (!composerInput) return;
  const t = (text || '').trim();
  if (!t) return;
  // Slice off whatever interim was sitting past the anchor — the final
  // is the canonical version of that chunk.
  const base = composerInput.value.slice(0, interimAnchor);
  const needLead = base.length > 0 && !/\s$/.test(base);
  const next = base + (needLead ? ' ' : '') + t + ' ';
  composerInput.value = next;
  interimAnchor = next.length;
  composerInput.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Replace the trailing in-progress chunk with the latest interim text.
 *  Doesn't move the cursor — speech writes to end-of-buffer, not to the
 *  user's caret position. */
function showInterim(text: string): void {
  if (!composerInput) return;
  const t = (text || '').trim();
  // Reslice to anchor so each interim REPLACES the prior interim instead
  // of stacking. If t is empty, that's just a no-op append.
  const base = composerInput.value.slice(0, interimAnchor);
  if (!t) {
    if (composerInput.value !== base) {
      composerInput.value = base;
      composerInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  const needLead = base.length > 0 && !/\s$/.test(base);
  composerInput.value = base + (needLead ? ' ' : '') + t;
  composerInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function dataChannelHandler(ev: any): void {
  if (!ev || ev.type !== 'transcript' || typeof ev.text !== 'string') return;
  if (ev.role !== 'user') return;  // ignore assistant — stream mode shouldn't get any, but be safe
  if (ev.is_final) {
    appendFinal(ev.text);
  } else {
    showInterim(ev.text);
  }
}

/** Open a stream-mode WebRTC connection and start routing user
 *  transcripts to the composer. Throws on getUserMedia / signaling
 *  failure; caller surfaces the error. */
export async function start(opts: { sessionId?: string | null } = {}): Promise<void> {
  if (active) {
    log('[dictate] start() while already active — no-op');
    return;
  }
  if (!composerInput) {
    diag('[dictate] start() called before init() bound the composer');
    throw new Error('dictate not initialized');
  }
  // Anchor at current end-of-buffer so interim replacements don't trample
  // typed text that's already in the textarea.
  interimAnchor = composerInput.value.length;

  // Replace whatever data-channel listener was wired (call-mode routing
  // in main.ts) for the duration of this dictate session. Restored on
  // stop(). conn.setDataChannelListener takes a single callback; there's
  // no multi-listener registry — that's why we save+restore.
  savedListener = conn.getDataChannelListener();
  conn.setDataChannelListener(dataChannelHandler);

  try {
    await conn.open('stream', { sessionId: opts.sessionId ?? null });
  } catch (e: any) {
    // Roll back the listener swap on open failure so call mode isn't
    // left without its handler.
    if (savedListener) conn.setDataChannelListener(savedListener);
    savedListener = null;
    notify(false, e?.message || String(e));
    throw e;
  }
  active = true;
  notify(true);
}

/** Close the stream and restore the prior data-channel listener.
 *  Idempotent and safe to call when not active. */
export async function stop(): Promise<void> {
  if (!active) {
    // Defensive: even if !active, restore the listener if one was saved
    // (covers a failed start() where active never flipped).
    if (savedListener) {
      conn.setDataChannelListener(savedListener);
      savedListener = null;
    }
    return;
  }
  active = false;
  try {
    await conn.close();
  } catch (e: any) {
    diag('[dictate] close err', e?.message);
  }
  if (savedListener) {
    conn.setDataChannelListener(savedListener);
    savedListener = null;
  }
  // Reset anchor so re-start() picks up cleanly at the new end-of-buffer.
  interimAnchor = 0;
  notify(false);
}
