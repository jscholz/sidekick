/**
 * @fileoverview Cursor-aware live dictation — streams STT into the
 * composer textarea while respecting the user's caret and edits.
 *
 * Used when the unified composer mic is in (call=true, autoSend=false):
 * a live WebRTC stream that lands transcripts inline so the user can
 * review, edit, and manually send. Distinct from the auto-send path
 * (dictation.ts — silence/commit-phrase auto-dispatch as chat bubbles).
 *
 * ── State machine ─────────────────────────────────────────────────────
 *
 * The textarea is shared between human (typing/paste/cursor moves) and
 * voice (interim → final transcripts arriving asynchronously). Two
 * principles drive the state machine:
 *
 *   1. Human edits are sacrosanct. If the user types or moves the cursor
 *      mid-utterance, voice respects that: commit the in-flight interim
 *      as if it were final at its current position, then start a fresh
 *      anchor on the next utterance.
 *   2. Cursor stays put during a single utterance. Each interim REPLACES
 *      the previous interim's text in place; the caret doesn't migrate
 *      with growing speech. Otherwise the user couldn't keep typing in
 *      front of dictated text — the cursor would chase the tail.
 *
 * Per-utterance state:
 *   anchor: number | null
 *     null = idle (no in-flight utterance). When a number, it's the
 *     textarea index of the start of the current interim.
 *   interimLen: number
 *     Length of the in-flight interim text past the anchor. Each new
 *     interim replaces [anchor, anchor+interimLen] with the new text,
 *     so the most-recent partial transcript is always what's visible.
 *   updating: boolean
 *     Re-entrancy guard. Set while WE'RE writing to the textarea so the
 *     `input` and `selectionchange` listeners don't treat our own writes
 *     as user actions and bail out of the utterance.
 *
 * Events:
 *   • Interim transcript arrives:
 *     - if anchor is null (new utterance): capture selectionStart as the
 *       anchor; if there's a selection range (start ≠ end), delete the
 *       selected text first (replaces user's selection with voice).
 *     - splice the new text into [anchor, anchor + interimLen]; update
 *       interimLen. Cursor goes back to anchor (i.e. we don't move it).
 *
 *   • Final transcript arrives:
 *     - same splice, then advance anchor past the final text and reset
 *       interimLen = 0. Cursor advances to the new anchor (so the next
 *       utterance, if it captures cursor again, will chain naturally
 *       rightward — this deviates from "cursor stays" only at the moment
 *       a final commits, because otherwise chained utterances would all
 *       insert at the same point and stack on top of each other).
 *     - clear anchor → null so the NEXT utterance captures fresh.
 *
 *   • User input event (typing/paste, NOT our own writes):
 *     - if interimLen > 0: commit the current interim as if it were a
 *       final at its current position (don't lose what we have), then
 *       reset (anchor → null) so the next utterance captures fresh at
 *       wherever the user's cursor lands after their edit.
 *
 *   • User selectionchange (caret move that wasn't ours):
 *     - if interimLen > 0 AND the new caret falls outside the interim
 *       range, commit the interim and reset. Caret moves WITHIN the
 *       interim are tolerated (user might be highlighting a word to
 *       replace mid-dictation; rare, but cheap to allow).
 *
 * On call close: stop() clears state and restores the prior data-channel
 * listener (call-mode wiring registers one at boot; we replaced it).
 */

import * as conn from './connection.ts';
import { log, diag } from '../../util/log.ts';

// ── State ──────────────────────────────────────────────────────────────

let active = false;
let composerInput: HTMLTextAreaElement | null = null;

/** Index of the start of the current in-flight interim. null = idle. */
let anchor: number | null = null;
/** Length of in-flight interim past the anchor. */
let interimLen = 0;
/** Re-entrancy guard for our own writes. */
let updating = false;

/** Saved data-channel listener so we can restore it on stop(). */
let savedListener: ((ev: any) => void) | null = null;
let onStateChangeCb: ((opening: boolean, error?: string) => void) | null = null;

// ── Public API ─────────────────────────────────────────────────────────

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

/** Bind the composer textarea once on boot so start() doesn't have to
 *  re-query each time. Also wires the user-action listeners that the
 *  state machine uses to detect cursor moves and edits. */
export function init(input: HTMLTextAreaElement | null): void {
  composerInput = input;
  if (!input) return;
  input.addEventListener('input', onUserInput);
  // selectionchange fires on document, not the element. We filter to the
  // composer's selection by checking activeElement at handler time.
  document.addEventListener('selectionchange', onUserSelectionChange);
}

/** Open a stream-mode WebRTC connection and start routing user
 *  transcripts to the composer with cursor-aware injection. */
export async function start(opts: { sessionId?: string | null } = {}): Promise<void> {
  if (active) {
    log('[dictate] start() while already active — no-op');
    return;
  }
  if (!composerInput) {
    diag('[dictate] start() called before init() bound the composer');
    throw new Error('dictate not initialized');
  }
  // Reset per-session state. anchor=null means the next interim/final
  // captures the cursor fresh; that's what we want at the top of every
  // dictation session.
  anchor = null;
  interimLen = 0;
  updating = false;

  // Replace whatever data-channel listener was wired (call-mode routing
  // in main.ts) for the duration of this session. Restored on stop().
  savedListener = conn.getDataChannelListener();
  conn.setDataChannelListener(dataChannelHandler);

  try {
    await conn.open('stream', { sessionId: opts.sessionId ?? null });
  } catch (e: any) {
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
  // Clear per-session state so a re-start() captures fresh.
  anchor = null;
  interimLen = 0;
  notify(false);
}

// ── Data-channel routing ───────────────────────────────────────────────

function dataChannelHandler(ev: any): void {
  if (!ev || ev.type !== 'transcript' || typeof ev.text !== 'string') return;
  if (ev.role !== 'user') return;
  if (ev.is_final) handleFinal(ev.text);
  else handleInterim(ev.text);
}

// ── State machine — voice events ───────────────────────────────────────

function handleInterim(rawText: string): void {
  if (!composerInput) return;
  const text = (rawText || '').trim();
  if (!text) return;
  ensureAnchor();
  spliceInterim(text);
}

function handleFinal(rawText: string): void {
  if (!composerInput) return;
  const text = (rawText || '').trim();
  if (!text) {
    // Final-with-empty-text shouldn't happen in practice, but if it does
    // just close out the utterance — anchor → null so the next interim
    // captures fresh.
    if (anchor !== null) {
      anchor += interimLen;
      interimLen = 0;
    }
    anchor = null;
    return;
  }
  ensureAnchor();
  spliceFinal(text);
}

/** Capture cursor at start of a new utterance. If the user has selected
 *  text, the selection is the insertion target — voice REPLACES the
 *  selection (matching native dictation behavior on macOS / iOS). */
function ensureAnchor(): void {
  if (anchor !== null) return;
  if (!composerInput) return;
  const start = composerInput.selectionStart ?? composerInput.value.length;
  const end = composerInput.selectionEnd ?? start;
  if (start !== end) {
    // Delete the selection so voice writes into the gap. We use
    // setRangeText so we get the native behavior + the input event
    // (which our own listener will see, but the `updating` flag
    // suppresses the user-input bailout).
    updating = true;
    try {
      composerInput.setRangeText('', start, end, 'start');
    } finally {
      updating = false;
    }
  }
  anchor = start;
  interimLen = 0;
}

/** Replace [anchor, anchor + interimLen] with `text`, including a leading
 *  space if needed for word separation. Does NOT advance anchor — the
 *  next interim should overwrite this one. Cursor stays at anchor (we
 *  don't migrate it with growing interim text). */
function spliceInterim(text: string): void {
  if (!composerInput || anchor === null) return;
  const insert = leadingSpace(anchor) + text;
  writeRange(anchor, anchor + interimLen, insert);
  interimLen = insert.length;
  // Pin cursor at anchor so subsequent typing inserts BEFORE the interim,
  // preserving the user's caret position. Calling setSelectionRange fires
  // selectionchange; our own listener short-circuits via `updating`.
  setCursor(anchor);
}

/** Bake the final text in place: replace the in-flight interim, advance
 *  anchor past the baked text, reset interimLen, and move the cursor
 *  to the new end so chained utterances flow rightward. anchor → null
 *  so the NEXT utterance re-captures the cursor (which by then might
 *  have moved if the user edited between utterances). */
function spliceFinal(text: string): void {
  if (!composerInput || anchor === null) return;
  // Trailing space so the next dictation / typed char isn't glued to
  // the final word — matches the long-standing memo / draft behavior.
  const insert = leadingSpace(anchor) + text + ' ';
  writeRange(anchor, anchor + interimLen, insert);
  const newEnd = anchor + insert.length;
  setCursor(newEnd);
  anchor = null;
  interimLen = 0;
}

// ── Textarea writes (with re-entrancy guard) ──────────────────────────

function leadingSpace(at: number): string {
  if (!composerInput) return '';
  if (at <= 0) return '';
  const ch = composerInput.value.charAt(at - 1);
  return /\s/.test(ch) ? '' : ' ';
}

function writeRange(start: number, end: number, text: string): void {
  if (!composerInput) return;
  updating = true;
  try {
    // setRangeText splices in place + dispatches an `input` event to the
    // textarea. Our own onUserInput sees that event but `updating` makes
    // it a no-op for the state machine; the OTHER listeners on the
    // textarea (autoResize, updateSendButtonState in main.ts) still fire.
    composerInput.setRangeText(text, start, end, 'preserve');
  } finally {
    updating = false;
  }
}

function setCursor(pos: number): void {
  if (!composerInput) return;
  updating = true;
  try {
    composerInput.setSelectionRange(pos, pos);
  } finally {
    updating = false;
  }
}

// ── User events — typing, paste, cursor moves ─────────────────────────

function onUserInput(ev: Event): void {
  if (updating) return;          // our own write — ignore
  if (!active) return;           // not dictating — irrelevant
  if (anchor === null) return;   // no in-flight interim — nothing to commit
  // The user typed (or pasted, or undo'd) DURING an in-flight interim.
  // Commit the interim where it sits — the user's edit is sacrosanct
  // and the current text in the textarea IS the truth (their input
  // already mutated the value before this handler runs). We just
  // reset the state machine so the next utterance captures fresh.
  //
  // Note: we do NOT splice the interim text in here — the textarea
  // already reflects whatever happened (typing inserted between voice,
  // delete removed something, etc.). Best we can do is bow out and
  // start over. The interim text that was "in flight" is now baked
  // wherever it ended up. If the user undid it via Ctrl-Z, fine —
  // it's gone and the cursor is at their undo position. If they
  // typed in front of it, fine — interim still there, cursor moved.
  diag('[dictate] user input mid-interim — committing in place');
  anchor = null;
  interimLen = 0;
}

function onUserSelectionChange(_ev: Event): void {
  if (updating) return;
  if (!active) return;
  if (anchor === null) return;
  if (!composerInput) return;
  // Only react to selection changes IN the composer. Cursor moves in
  // chat bubbles, settings, etc. shouldn't affect the dictation state.
  if (document.activeElement !== composerInput) return;
  const pos = composerInput.selectionStart ?? 0;
  // Tolerate caret moves WITHIN the in-flight interim range — user might
  // be highlighting a word to replace, no need to bail out yet.
  const interimEnd = anchor + interimLen;
  if (pos >= anchor && pos <= interimEnd) return;
  // User navigated outside the interim. Commit and reset.
  diag('[dictate] user moved cursor outside interim — committing in place');
  anchor = null;
  interimLen = 0;
}
