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
 *   2. Cursor advances with the dictated text, just like typing. Each
 *      interim REPLACES the previous interim's text in place, and after
 *      every splice the caret is moved to the END of what's been written
 *      so far. The user's mental model: "the cursor follows what I'm
 *      saying" — exactly as if they were typing the words themselves.
 *      If they STOP dictating, the cursor is at the end of what they
 *      just said. If they then click elsewhere, the next utterance
 *      starts at that new caret position.
 *
 * ── Deepgram quirks the state machine has to absorb ───────────────────
 *
 * Deepgram emits MULTIPLE `is_final: true` Results per utterance — one
 * per endpoint (sentence/pause boundary inside a single breath). It
 * also emits an empty-text final for `UtteranceEnd` (true end-of-turn).
 * If we treated every is_final as "utterance done, capture cursor
 * fresh next time", we'd:
 *   - re-capture anchor between sentence-final and the next-sentence
 *     interim, leaking previously-committed text into new splice
 *     ranges and producing duplicates / fragments;
 *   - lose the per-utterance invariant that the cursor stays pinned
 *     while the user dictates a multi-sentence block.
 *
 * So this module distinguishes two levels of finality:
 *   - CONTENT FINAL  (text non-empty, is_final=true): a sentence segment
 *     is locked in; we BAKE it into committed[anchor, anchor+committedLen]
 *     and keep the same anchor for the next interim/final.
 *   - UTTERANCE END  (text empty, is_final=true — bridge yields one of
 *     these on Deepgram's UtteranceEnd event): the user stopped
 *     speaking; we close out the utterance, advance the cursor, and
 *     null the anchor so the NEXT speech captures fresh.
 *
 * Defensive measures (should rarely trigger but kill regressions):
 *   - duplicate / stale finals are dropped if their text matches the
 *     most recent committed segment;
 *   - interims that start with text we've already committed in this
 *     utterance have that prefix stripped before splicing.
 *
 * ── Per-utterance state ──────────────────────────────────────────────
 *
 *   anchor: number | null
 *     null = idle (no in-flight utterance). When a number, it's the
 *     textarea index of the start of the current utterance.
 *
 *   committedLen: number
 *     Length of the text already locked-in by content-finals for this
 *     utterance. Lives at [anchor, anchor + committedLen].
 *
 *   interimLen: number
 *     Length of the in-flight interim past committed end. Lives at
 *     [anchor + committedLen, anchor + committedLen + interimLen]. New
 *     interims REPLACE this range.
 *
 *   lastFinalText: string
 *     The text of the most-recent content-final in this utterance —
 *     used to drop duplicate / stale finals.
 *
 *   updating: boolean
 *     Re-entrancy guard. Set while WE'RE writing to the textarea so the
 *     `input` and `selectionchange` listeners don't treat our own
 *     writes as user actions and bail out.
 *
 * Events:
 *   • Interim transcript arrives:
 *     - if anchor is null (new utterance): use the cursor position
 *       captured at start() time (initialCursor) — set BEFORE the user's
 *       gesture moved focus off the textarea. If absent, fall back to
 *       reading composerInput.selectionStart. If there's a selection
 *       range (start ≠ end), delete the selected text first (replaces
 *       user's selection with voice).
 *     - strip any prefix that overlaps with already-committed text in
 *       this utterance (defensive — Deepgram normally doesn't do this).
 *     - splice the new text into [anchor+committedLen,
 *       anchor+committedLen+interimLen]; update interimLen. Cursor
 *       moves to anchor + committedLen + interimLen (the end of the
 *       in-flight text).
 *
 *   • Content final arrives (text non-empty):
 *     - drop if it matches lastFinalText (duplicate / stale).
 *     - same splice as interim, then advance committedLen by the baked
 *       length, reset interimLen=0, remember lastFinalText. anchor
 *       STAYS — we're still in the same utterance. Cursor is moved to
 *       the new end of committed text.
 *
 *   • Utterance end arrives (text empty, is_final=true):
 *     - if there's still an in-flight interim, leave it where it sits
 *       (it'll be overwritten by the next utterance's first splice if
 *       the user keeps talking, or stays as live caption if not).
 *     - add a trailing space if the committed text doesn't already end
 *       in whitespace, so the next utterance / typed char isn't glued
 *       to the previous word.
 *     - advance cursor to anchor + committedLen (post-trailing-space).
 *     - reset: anchor=null, committedLen=0, interimLen=0, lastFinalText=''.
 *
 *   • User input event (typing/paste, NOT our own writes):
 *     - reset state machine (anchor → null) so the next utterance
 *       captures fresh wherever the user's cursor lands.
 *
 *   • User selectionchange (caret move that wasn't ours):
 *     - if the new caret falls outside the utterance range
 *       [anchor, anchor+committedLen+interimLen], reset state machine.
 *       Caret moves WITHIN the range are tolerated.
 *
 * On call close: stop() clears state and restores the prior data-channel
 * listener (call-mode wiring registers one at boot; we replaced it).
 *
 * ── Diagnostic logging ───────────────────────────────────────────────
 *
 * Heavy per-event logging is gated behind `?dictate-debug=1` (URL) or
 * `localStorage.dictate_debug='1'`. When enabled, every interim, final,
 * splice, and reset prints with timestamps, anchor, committedLen,
 * interimLen, and a short snapshot of the current span. Tail in the
 * console (or the on-page debug panel via ?debug=1) to verify
 * post-fix behavior.
 */

import * as conn from './connection.ts';
import { log, diag } from '../../util/log.ts';

// ── Diagnostic flag ────────────────────────────────────────────────────

const dictateDebugOn = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('dictate-debug') === '1') return true;
    if (qs.get('debug') === '1') return true;
    if (localStorage.getItem('dictate_debug') === '1') return true;
    if (localStorage.getItem('sidekick_debug') === '1') return true;
  } catch { /* ignore */ }
  return false;
})();

/** Per-event diagnostic log. Tag every line with [dictate] + a phase
 *  label so Jonathan can grep one stream out of the console. No-op
 *  unless the dictate-debug flag is on. */
function dlog(phase: string, info: Record<string, unknown> = {}): void {
  if (!dictateDebugOn) return;
  const snapshot = composerInput
    ? composerInput.value.slice(
        Math.max(0, (anchor ?? 0)),
        Math.max(0, (anchor ?? 0)) + committedLen + interimLen,
      )
    : '';
  log(
    `[dictate] ${phase}`,
    JSON.stringify({
      anchor,
      committedLen,
      interimLen,
      lastFinalText: lastFinalText.slice(0, 40),
      span: snapshot.slice(0, 80),
      ...info,
    }),
  );
}

// ── State ──────────────────────────────────────────────────────────────

let active = false;
let composerInput: HTMLTextAreaElement | null = null;

/** Index of the start of the current utterance. null = idle. */
let anchor: number | null = null;
/** Length of finalized text from this utterance baked at [anchor, anchor+committedLen]. */
let committedLen = 0;
/** Length of in-flight interim past anchor+committedLen. */
let interimLen = 0;
/** Most recent content-final text — used to drop duplicates. */
let lastFinalText = '';
/** Re-entrancy guard for our own writes. */
let updating = false;

/** Saved data-channel listener so we can restore it on stop(). */
let savedListener: ((ev: any) => void) | null = null;
let onStateChangeCb: ((opening: boolean, error?: string) => void) | null = null;

/** Cursor position captured at the GESTURE site (e.g. mic-button
 *  pointerdown, hotkey handler) BEFORE focus shifts off the textarea.
 *  Consumed by the first ensureAnchor() of a session and then nulled.
 *  Without this, by the time the first interim arrives the textarea is
 *  blurred and reading selectionStart can return 0 / value.length /
 *  stale values, dropping voice text at the wrong location. */
let initialCursor: number | null = null;

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
  if (dictateDebugOn) log('[dictate] debug logging enabled');
}

/** Open a stream-mode WebRTC connection and start routing user
 *  transcripts to the composer with cursor-aware injection.
 *
 *  `initialCursor` should be the textarea selectionStart captured at the
 *  user's gesture site (mic-button pointerdown, hotkey handler) BEFORE
 *  focus shifted off the textarea. The first interim/final of the
 *  session uses this as the anchor. Pass null if the gesture site
 *  couldn't reasonably know the cursor position; we'll fall back to
 *  reading selectionStart at first-interim time (correct on browsers
 *  that preserve selection across blur, wrong on ones that don't). */
export async function start(opts: {
  sessionId?: string | null;
  initialCursor?: number | null;
} = {}): Promise<void> {
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
  resetUtterance('start');
  initialCursor = (typeof opts.initialCursor === 'number') ? opts.initialCursor : null;
  if (dictateDebugOn) log('[dictate] start initialCursor=', initialCursor);

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
  resetUtterance('stop');
  initialCursor = null;
  notify(false);
}

// ── Data-channel routing ───────────────────────────────────────────────

function dataChannelHandler(ev: any): void {
  if (!ev || ev.type !== 'transcript' || typeof ev.text !== 'string') return;
  if (ev.role !== 'user') return;
  const trimmed = ev.text.trim();
  if (ev.is_final) {
    if (trimmed) handleContentFinal(trimmed);
    else handleUtteranceEnd();
  } else {
    if (trimmed) handleInterim(trimmed);
  }
}

// ── State machine — voice events ───────────────────────────────────────

function handleInterim(text: string): void {
  if (!composerInput) return;
  dlog('interim<-', { text: text.slice(0, 80) });
  ensureAnchor();
  const stripped = stripCommittedPrefix(text);
  if (!stripped) {
    dlog('interim drop (fully overlaps committed)', { text });
    return;
  }
  spliceInterim(stripped);
  dlog('interim->', { text: stripped.slice(0, 80) });
}

function handleContentFinal(text: string): void {
  if (!composerInput) return;
  dlog('final<-', { text: text.slice(0, 80) });
  // Stale / duplicate final — same text as the last segment we baked.
  // Deepgram occasionally re-emits a Results frame; don't double-write.
  if (text === lastFinalText) {
    dlog('final drop (duplicate)', { text });
    return;
  }
  ensureAnchor();
  const stripped = stripCommittedPrefix(text);
  if (!stripped) {
    dlog('final drop (fully overlaps committed)', { text });
    return;
  }
  spliceFinal(stripped);
  dlog('final->', { text: stripped.slice(0, 80) });
}

function handleUtteranceEnd(): void {
  if (!composerInput) return;
  dlog('utterance-end<-');
  if (anchor === null) {
    dlog('utterance-end drop (no anchor)');
    return;
  }
  // Add a trailing space so the next utterance / typed char isn't
  // glued to the last word — only if we actually committed something
  // and there's no whitespace there yet.
  if (committedLen > 0) {
    const endIdx = anchor + committedLen + interimLen;
    const tail = composerInput.value.charAt(endIdx - 1);
    if (!/\s/.test(tail)) {
      // Append a single space at the end of the utterance span. We
      // splice it in AFTER the interim (if any), so an in-flight
      // interim isn't disturbed.
      writeRange(endIdx, endIdx, ' ');
      committedLen += 1;
    }
    // Advance cursor to the end of committed text (NOT past interim —
    // the user's next keystroke should land between committed and
    // interim if interim is still showing; in practice handleUtterance
    // End fires after interimLen has been zeroed by the last final).
    setCursor(anchor + committedLen);
  }
  resetUtterance('utterance-end');
}

/** Capture cursor at start of a new utterance. If the user has selected
 *  text, the selection is the insertion target — voice REPLACES the
 *  selection (matching native dictation behavior on macOS / iOS).
 *
 *  Anchor source priority:
 *    1. initialCursor (captured at gesture site BEFORE focus shifted) —
 *       used once, then nulled.
 *    2. composerInput.selectionStart — fallback for mid-session
 *       re-captures (after a user-input or user-cursor-outside reset)
 *       where the textarea is presumably focused at the user's chosen
 *       caret position.
 *    3. composerInput.value.length — last-ditch fallback if both above
 *       are null (selectionStart can return null on never-focused
 *       textareas in some browsers). */
function ensureAnchor(): void {
  if (anchor !== null) return;
  if (!composerInput) return;
  // Diagnostic snapshot — Jonathan asked for this so we can verify the
  // gesture-site capture is doing its job vs. falling back to
  // selectionStart on a blurred element.
  if (dictateDebugOn) {
    const ss = composerInput.selectionStart;
    const se = composerInput.selectionEnd;
    const len = composerInput.value.length;
    const focused = document.activeElement === composerInput;
    log(
      '[dictate] ensureAnchor enter',
      JSON.stringify({ initialCursor, selectionStart: ss, selectionEnd: se, valueLen: len, focused }),
    );
  }
  let start: number;
  let end: number;
  if (typeof initialCursor === 'number') {
    // Clamp into [0, value.length] in case the textarea contents changed
    // between gesture and first interim (e.g. user typed during connect).
    const clamped = Math.max(0, Math.min(initialCursor, composerInput.value.length));
    start = clamped;
    end = clamped;
    initialCursor = null;
  } else {
    start = composerInput.selectionStart ?? composerInput.value.length;
    end = composerInput.selectionEnd ?? start;
  }
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
  committedLen = 0;
  interimLen = 0;
  lastFinalText = '';
  // Refocus the textarea so the caret is VISIBLE as text streams in.
  // Without this, the user's gesture (e.g. clicking the mic button)
  // moved focus to the button; setSelectionRange on a non-focused
  // textarea silently updates the selection but the caret doesn't
  // render. Re-focusing here brings the cursor back where we want it.
  try {
    if (document.activeElement !== composerInput) {
      // preventScroll keeps the page from jumping when refocusing
      // mid-stream (e.g. inside a long composer).
      (composerInput as any).focus({ preventScroll: true });
    }
  } catch { /* not all browsers support focus options; ignore */ }
  dlog('anchor-capture', { at: start });
}

/** If `text` starts with a suffix of the already-committed text, strip
 *  that overlap. Defensive against Deepgram occasionally re-sending
 *  finalized words in a subsequent interim — without this, that
 *  re-send would duplicate text in the textarea.
 *
 *  Note: we look at the LAST committed final's text (lastFinalText),
 *  not the entire committed buffer, because Deepgram's interims for a
 *  new sentence segment never re-include text from segments before
 *  the previous one. Only adjacent overlap is plausible. */
function stripCommittedPrefix(text: string): string {
  if (!lastFinalText) return text;
  // Try progressively longer prefixes of lastFinalText that match the
  // start of `text`. If we find one, strip it.
  const lower = text.toLowerCase();
  const lastLower = lastFinalText.toLowerCase();
  // Quick check: does text start with the entire last final? Then strip.
  if (lower.startsWith(lastLower)) {
    return text.slice(lastFinalText.length).replace(/^[\s.,!?]+/, '');
  }
  return text;
}

/** Replace [anchor + committedLen, anchor + committedLen + interimLen]
 *  with `text`, including a leading space if needed for word
 *  separation. Does NOT advance committedLen — the next interim should
 *  overwrite this one. Cursor moves to the END of the in-flight text
 *  so the user sees their words advancing the caret, just like typing. */
function spliceInterim(text: string): void {
  if (!composerInput || anchor === null) return;
  const at = anchor + committedLen;
  const insert = leadingSpace(at) + text;
  writeRange(at, at + interimLen, insert);
  interimLen = insert.length;
  // Move cursor to the end of the in-flight text — matches user's
  // mental model of "the cursor follows what I'm saying." If they
  // pause, the cursor is sitting right after the last word; their
  // next keystroke / mouse-click resumes from there. setSelectionRange
  // fires selectionchange; our own listener short-circuits via
  // `updating`.
  setCursor(anchor + committedLen + interimLen);
}

/** Bake a content final into committed text: replace the in-flight
 *  interim, advance committedLen by the baked length. anchor STAYS —
 *  Deepgram will keep emitting more finals (and interims for those
 *  finals) within the same utterance until UtteranceEnd. */
function spliceFinal(text: string): void {
  if (!composerInput || anchor === null) return;
  const at = anchor + committedLen;
  const insert = leadingSpace(at) + text;
  writeRange(at, at + interimLen, insert);
  committedLen += insert.length;
  interimLen = 0;
  lastFinalText = text;
  // Cursor sits at the end of committed text — same advancing-with-
  // speech invariant as the interim path. Earlier versions pinned at
  // anchor so the caret stayed put; that was the wrong mental model
  // (Jonathan: "as text comes in it should land immediately behind the
  // cursor just like if the user had typed that input").
  setCursor(anchor + committedLen);
}

// ── Reset helper ──────────────────────────────────────────────────────

function resetUtterance(reason: string): void {
  anchor = null;
  committedLen = 0;
  interimLen = 0;
  lastFinalText = '';
  if (dictateDebugOn) dlog('reset', { reason });
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
    // setRangeText splices in place + dispatches an `input` event to
    // the textarea. Our own onUserInput sees that event but `updating`
    // makes it a no-op for the state machine; the OTHER listeners on
    // the textarea (autoResize, updateSendButtonState in main.ts)
    // still fire.
    composerInput.setRangeText(text, start, end, 'preserve');
  } finally {
    updating = false;
  }
}

function setCursor(pos: number): void {
  if (!composerInput) return;
  if (dictateDebugOn) log('[dictate] setCursor', pos);
  updating = true;
  try {
    composerInput.setSelectionRange(pos, pos);
  } finally {
    updating = false;
  }
}

// ── User events — typing, paste, cursor moves ─────────────────────────

function onUserInput(_ev: Event): void {
  if (updating) return;          // our own write — ignore
  if (!active) return;           // not dictating — irrelevant
  if (anchor === null) return;   // no in-flight utterance — nothing to commit
  // The user typed (or pasted, or undo'd) DURING an in-flight utterance.
  // Bow out: the textarea already reflects whatever happened (typing
  // inserted between voice, delete removed something, etc.), and the
  // next utterance captures fresh wherever the user's cursor lands.
  diag('[dictate] user input mid-utterance — committing in place');
  resetUtterance('user-input');
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
  // Tolerate caret moves WITHIN the in-flight utterance range.
  const utteranceEnd = anchor + committedLen + interimLen;
  if (pos >= anchor && pos <= utteranceEnd) return;
  // User navigated outside the utterance. Reset.
  diag('[dictate] user moved cursor outside utterance — committing in place');
  resetUtterance('user-cursor-outside');
}
