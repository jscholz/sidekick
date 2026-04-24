/**
 * @fileoverview Treats the composer textarea as a dictation target.
 *
 * When `autoSend` is off, STT finals land here (at the cursor position,
 * like mainstream chat apps) instead of into a separate draft block in
 * the transcript. The user mixes typed + dictated text freely and sends
 * via the same send button they'd use for typed messages.
 *
 * Interim text (non-final STT output) shows as a small ghost line just
 * below the composer — feedback that the mic is alive without polluting
 * the committed text.
 *
 * Why a shell module (not draft.ts): draft.ts owns a distinct DOM surface
 * in the transcript area and has its own segment-tracking for gap
 * backfill splice. The composer is a plain <textarea> — different affordance,
 * different lifecycle (cleared on send, not flushed via onFlush). Keeping
 * them separate avoids forcing one to grow the other's complexity.
 */

import { diag } from './util/log.ts';

let inputEl: HTMLTextAreaElement | null = null;
let interimEl: HTMLElement | null = null;
let onChange = () => {};
let onSubmit = () => {};

export function init(opts: {
  input: HTMLTextAreaElement | null,
  interim?: HTMLElement | null,
  onChange?: () => void,
  onSubmit?: () => void,
}) {
  inputEl = opts.input;
  interimEl = opts.interim ?? null;
  if (opts.onChange) onChange = opts.onChange;
  if (opts.onSubmit) onSubmit = opts.onSubmit;
}

/** Submit the composer's current content (same path as clicking send /
 *  pressing Enter). Wired by main.ts to sendTypedMessage so the voice
 *  pipeline's auto-submit-on-silence loop fires the single send codepath. */
export function submit() { onSubmit(); }

/** Append dictation final at the cursor position. Adds a leading space if
 *  the cursor is right after a non-whitespace character, so words don't
 *  concatenate ("hellohow" → "hello how"). Dispatches 'input' so the
 *  auto-resize + send-button-state listeners fire as if the user typed. */
export function appendText(text: string) {
  if (!inputEl) return;
  const t = text.trim();
  if (!t) return;

  const val = inputEl.value;
  const start = inputEl.selectionStart ?? val.length;
  const end = inputEl.selectionEnd ?? val.length;
  const before = val.slice(0, start);
  const after = val.slice(end);

  // Smart spacing: leading space if the char before cursor is non-whitespace;
  // trailing space so the next dictation or typed char is naturally separated.
  const needLead = before.length > 0 && !/\s$/.test(before);
  const needTrail = after.length > 0 && !/^\s/.test(after);
  const insert = (needLead ? ' ' : '') + t + (needTrail ? ' ' : ' ');

  inputEl.value = before + insert + after;
  const newPos = before.length + insert.length;
  inputEl.setSelectionRange(newPos, newPos);
  // Fire input event so autoResize + updateSendButtonState react.
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  clearInterim();
  onChange();
  diag('composer append:', JSON.stringify({ len: t.length, text: t.slice(0, 60) }));
}

/** Show an interim (non-final) STT preview just below the composer. No-op
 *  if the interim element isn't wired (inline preview is optional). */
export function setInterim(text: string) {
  if (!interimEl) return;
  const t = text.trim();
  if (!t) { clearInterim(); return; }
  interimEl.textContent = t;
  interimEl.classList.add('active');
}

export function clearInterim() {
  if (!interimEl) return;
  interimEl.textContent = '';
  interimEl.classList.remove('active');
}

/** True if the composer has any user-visible content. Used by voice.ts to
 *  skip speaker prefixes + paragraph breaks on an empty composer. */
export function hasContent(): boolean {
  return !!(inputEl && inputEl.value.length > 0);
}
