/**
 * @fileoverview Draft block — the single editable transcript buffer where
 * streaming STT finals accumulate before the user sends. Appears inline in
 * the transcript (not in the composer textarea) so voice + typed flows
 * stay visually separate.
 *
 * Lifecycle:
 *   • First Deepgram final (or voice-memo transcript) calls `append()` →
 *     block is created lazily, text is inserted.
 *   • `appendParagraphBreak()` adds a `\n\n` on Deepgram UtteranceEnd.
 *   • Focus in the draft pauses auto-append (`isEditing()` returns true);
 *     cursor-position insert lets the user interject.
 *   • `flush()` sends the accumulated text via the `onFlush` callback and
 *     removes the block with a fade. `dismiss()` cancels without sending.
 *
 * The module is state-only DOM — no gateway / TTS imports. Send semantics
 * are owned by the caller via `onFlush(text)` so draft doesn't need to know
 * about gateway / chat / playFeedback.
 */

import { diag } from './util/log.ts';
import { getSharedAudioCtx } from './audio/platform.ts';

// autoScroll is wired via init(opts.onScroll) so draft doesn't depend
// on the chat module directly. Keeping the boundary clean lets tests
// stub scroll behavior without faking the entire chat module.
let autoScroll: () => void = () => {};

let transcriptEl = null;
let onFlush = (_text) => {};
let onChange = () => {};
let onFocus = () => {};

let blockEl = null;
let textEl = null;
let interimEl = null;    // faded span at the end of textEl — live STT partial
let editing = false;
let hasText = false;
let lastSpeaker = null;  // track speaker for multi-speaker labeling

/** Tracked segments in document order, used for two things:
 *   1. Positional splice of gap-backfill text — sttBackfill returns
 *      {ctxStart, text}; we find the last segment with ctxTime < ctxStart
 *      and insert immediately after its DOM node.
 *   2. Seam dedup — before inserting backfill text, we compare its
 *      leading words with the trailing words of the preceding segment
 *      and strip duplicates. See dedupWithTail() below.
 *
 *  Each entry is { kind, text, ctxTime, node }. `node` is the Text or
 *  Span that renders this segment inside textEl; we verify it's still
 *  in the DOM before splicing, because contenteditable edits may have
 *  destroyed it.
 *  @type {Array<{ kind: 'live'|'backfill', text: string, ctxTime: number, node: Node }>}
 */
let segments = [];

/** Current audio-context time, used to timestamp live segments. Falls
 *  back to 0 before mic has been unlocked — acceptable for users who
 *  only ever type (no ctxTime → segments are all stamped at 0 →
 *  backfill splice treats them all as equally-recent, appends at end). */
function nowCtxTime() {
  return getSharedAudioCtx()?.currentTime ?? 0;
}

export function init(opts) {
  transcriptEl = opts.transcriptEl;
  onFlush = opts.onFlush || onFlush;
  onChange = opts.onChange || onChange;
  onFocus = opts.onFocus || onFocus;
  if (opts.onScroll) autoScroll = opts.onScroll;
}

export function hasContent() { return hasText; }
export function isEditing() { return editing; }

export function ensureBlock() {
  if (!transcriptEl) return;
  if (blockEl && blockEl.parentNode) return;

  blockEl = document.createElement('div');
  blockEl.className = 'draft-block';

  textEl = document.createElement('div');
  textEl.className = 'draft-text';
  textEl.contentEditable = 'true';
  textEl.spellcheck = true;

  textEl.addEventListener('focus', () => {
    editing = true;
    blockEl?.classList.add('editing');
    onFocus();
  });
  textEl.addEventListener('blur', () => {
    editing = false;
    blockEl?.classList.remove('editing');
  });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); textEl.blur(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      textEl.blur();
      flush();
    }
  });

  const header = document.createElement('div');
  header.className = 'draft-header';
  // Shortcut hint shows only while the user has focus in the draft
  // (CSS-gated via .draft-block.editing). Uses ⌘ on macOS/iOS, Ctrl elsewhere.
  const sendKey = /(Mac|iPhone|iPad)/i.test(navigator.platform) ? '⌘' : 'Ctrl';
  header.innerHTML = `
    <span class="draft-label-idle">unsent · click to edit</span>
    <span class="draft-label-edit">${sendKey}+Enter to send · Esc to unfocus</span>
  `;
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'draft-dismiss';
  dismissBtn.title = 'Dismiss draft';
  dismissBtn.textContent = '×';
  dismissBtn.onclick = dismiss;
  header.appendChild(dismissBtn);

  blockEl.appendChild(header);
  blockEl.appendChild(textEl);
  transcriptEl.appendChild(blockEl);
  hasText = false;
}

/** Show the live STT partial at the end of the draft as faded/italic text.
 *  Replaces any prior interim. Non-editable — lives as a sibling span after
 *  textEl so it doesn't pollute textEl.textContent. */
export function setInterim(text, speaker) {
  ensureBlock();
  if (!blockEl) return;
  if (!interimEl) {
    interimEl = document.createElement('span');
    interimEl.className = 'draft-interim';
    // Sit right after textEl, before any trailing siblings.
    textEl.after(interimEl);
  }
  const prefix = (speaker !== null && speaker !== lastSpeaker && lastSpeaker !== null)
    ? ` [${speaker}] `
    : ' ';
  interimEl.textContent = prefix + text;
  autoScroll();
}

export function clearInterim() {
  if (interimEl) { interimEl.remove(); interimEl = null; }
}

export function append(text, speaker) {
  ensureBlock();
  if (!textEl) return;

  clearInterim();
  diag('draft-append:', JSON.stringify({ speaker, len: text.length, text: text.slice(0, 80) }));

  // Self-heal stale editing flag. Mobile Safari can miss textEl.blur
  // when the user taps hardware buttons (mic, send, lock) — focus
  // event fired earlier left editing=true even though document.
  // activeElement is no longer textEl. Before treating this as an
  // in-cursor insert, verify the user actually still has focus here.
  if (editing && document.activeElement !== textEl) {
    editing = false;
    blockEl?.classList.remove('editing');
  }

  if (editing) {
    // User has the cursor in the draft — insert at their cursor and
    // don't add to the segments list (their edit owns that region).
    // If the cursor insert fails (selection moved outside textEl while
    // editing flag was still true), fall through to the normal append
    // path so the final text still lands somewhere visible.
    if (insertAtCursor(text)) {
      hasText = true;
      onChange();
      return;
    }
  }

  // Build the prefix (speaker-change newline + label, or plain space
  // between runs). Keep the prefix in its own Text node so the live
  // segment we push into `segments[]` maps cleanly to just `text` and
  // dedup math stays honest.
  let prefix = '';
  if (speaker !== lastSpeaker && lastSpeaker !== null) {
    prefix = `\n[${speaker}] `;
  } else if (segments.length > 0) {
    const tail = textEl.textContent;
    if (tail && !tail.endsWith('\n') && !tail.endsWith(' ')) prefix = ' ';
  }
  lastSpeaker = speaker;

  if (prefix) textEl.appendChild(document.createTextNode(prefix));
  const node = document.createTextNode(text);
  textEl.appendChild(node);
  segments.push({ kind: 'live', text, ctxTime: nowCtxTime(), node });
  hasText = true;
  onChange();

  autoScroll();
}

/** Minimum content (in chars) between paragraph breaks. DG fires
 *  UtteranceEnd on every brief pause — default endpointing = 1.5s — so
 *  without this gate a normal-paced monologue sprouts blank lines every
 *  few words. 80 chars ≈ a short sentence; breaks feel meaningful. */
const MIN_CHARS_BETWEEN_BREAKS = 80;

export function appendParagraphBreak() {
  if (!textEl || editing) return;
  const t = textEl.textContent;
  if (!t || t.endsWith('\n\n')) return;
  // Only paragraph-break if enough content has accrued since the last break.
  // lastIndexOf('\n\n') gives the char position of the last paragraph break;
  // if none, treat as "start of text."
  const lastBreak = t.lastIndexOf('\n\n');
  const charsSinceBreak = t.length - (lastBreak === -1 ? 0 : lastBreak + 2);
  if (charsSinceBreak < MIN_CHARS_BETWEEN_BREAKS) return;
  textEl.appendChild(document.createTextNode('\n\n'));
}

/** Append a block of text to the draft without speaker labels or
 *  per-final segmenting — used by the voice-memo paste path. */
export function appendRaw(text) {
  ensureBlock();
  if (!textEl) return;
  const existing = textEl.textContent.trim();
  textEl.textContent = !existing ? text : existing + '\n\n' + text;
  hasText = true;
  onChange();
  autoScroll();
}

/** Append text recovered from a network-gap via the STT backfill path
 *  (sttBackfill.flushGaps). Splice at the chronologically correct
 *  position — immediately after the last live segment whose ctxTime
 *  precedes the gap — so the transcript reads in speaking order rather
 *  than dumping all recovered text at the end.
 *
 *  Before inserting, run seam-dedup: if the backfill's leading words
 *  overlap with the trailing words of the segment we'd insert after
 *  (common when DG transcribed the last few seconds before the WS
 *  wedged AND our backfill re-transcribed the same audio), strip the
 *  duplicate from the backfill side.
 *
 *  Falls back to append-at-end if:
 *   - user is currently editing (`editing === true`)
 *   - any tracked segment's DOM node was removed by a user edit
 *   - no segments exist (draft started with backfill text, unusual)
 *
 *  @param {string} text
 *  @param {number} [gapCtxTime] Audio-context time at gap start. If
 *      omitted, treated as end-of-stream (falls back to append-at-end).
 */
export function appendBackfill(text, gapCtxTime) {
  ensureBlock();
  if (!textEl || !text) return;
  clearInterim();

  // Fall back to plain append-at-end when we can't splice safely.
  const canSplice = !editing
    && segments.length > 0
    && segments.every(s => textEl.contains(s.node));
  if (!canSplice || typeof gapCtxTime !== 'number') {
    appendBackfillAtEnd(text);
    return;
  }

  // Find the last live segment whose ctxTime < gapCtxTime. That's where
  // the gap "began" in the draft — insert immediately after it.
  let insertAfterIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].ctxTime < gapCtxTime) insertAfterIdx = i;
    else break;
  }
  if (insertAfterIdx < 0) {
    // Gap started before any live segment — prepend. Rare.
    insertAfterIdx = -1;
  }

  // Seam dedup: strip the leading words of `text` that duplicate the
  // trailing words of the preceding live segment. Skip dedup when the
  // preceding segment is itself backfill (seam already cleaned).
  let spliced = text;
  if (insertAfterIdx >= 0 && segments[insertAfterIdx].kind === 'live') {
    spliced = dedupWithTail(segments[insertAfterIdx].text, text);
  }
  if (!spliced) {
    diag('draft.appendBackfill: entire segment was duplicate, skipped');
    return;
  }

  // Build the backfill span (leading space so it doesn't run into prev text).
  const span = document.createElement('span');
  span.className = 'draft-backfill';
  span.textContent = ' ' + spliced;

  // Insert into the DOM after the reference node (or at the front).
  if (insertAfterIdx >= 0) {
    const refNode = segments[insertAfterIdx].node;
    if (refNode.nextSibling) refNode.parentNode.insertBefore(span, refNode.nextSibling);
    else refNode.parentNode.appendChild(span);
  } else {
    textEl.insertBefore(span, textEl.firstChild);
  }

  // Track the new segment at the corresponding index.
  segments.splice(insertAfterIdx + 1, 0, {
    kind: 'backfill',
    text: spliced,
    ctxTime: gapCtxTime,
    node: span,
  });
  hasText = true;
  onChange();
  autoScroll();
}

/** Fallback used when positional splice isn't safe — just slap the
 *  backfill text at the end of the draft, same as pre-positional
 *  behavior. */
function appendBackfillAtEnd(text) {
  const existing = textEl.textContent;
  if (existing && !existing.endsWith('\n')) {
    textEl.appendChild(document.createTextNode('\n'));
  }
  const span = document.createElement('span');
  span.className = 'draft-backfill';
  span.textContent = text;
  textEl.appendChild(span);
  segments.push({ kind: 'backfill', text, ctxTime: nowCtxTime(), node: span });
  hasText = true;
  onChange();
  autoScroll();
}

/** Strip leading words of `newText` that duplicate the trailing words
 *  of `prevText`. Returns the deduped newText. Case- and punctuation-
 *  insensitive match. Requires at least 2 overlapping words to trigger
 *  — keeps false positives from common single-word tails (e.g. "the",
 *  "and") from eating real content.
 *
 *  The typical seam overlap: DG transcribed "...over to Oleg this week"
 *  just before wedging; our backfill re-transcribed "this week. Also
 *  Misha mentioned...". After dedup → "Also Misha mentioned...".
 *  @param {string} prevText — trailing text of the preceding segment
 *  @param {string} newText — the incoming backfill text
 *  @returns {string} newText with the leading duplicate stripped
 */
function dedupWithTail(prevText, newText) {
  const K = 10; // max overlap window (words)
  const MIN_MATCH = 2; // below this, treat as coincidence, not overlap
  const prevWords = prevText.trim().split(/\s+/).slice(-K);
  const newWords = newText.trim().split(/\s+/);
  const norm = (w) => w.toLowerCase().replace(/[.,!?;:'"\-()[\]]/g, '');

  // Try progressively shorter prev-tails; longest match wins.
  for (let len = Math.min(prevWords.length, newWords.length); len >= MIN_MATCH; len--) {
    const tail = prevWords.slice(-len).map(norm).filter(Boolean).join(' ');
    const head = newWords.slice(0, len).map(norm).filter(Boolean).join(' ');
    if (tail && tail === head) {
      diag(`dedupWithTail: dropped ${len} overlapping words from backfill head`);
      return newWords.slice(len).join(' ');
    }
  }
  return newText;
}

/** Mark the block as queued (used for offline memo cards). */
export function clearQueuedMark() { blockEl?.classList.remove('queued'); }

export function dismiss() {
  hasText = false;
  editing = false;
  lastSpeaker = null;
  interimEl = null;
  segments = [];
  if (blockEl) {
    blockEl.remove();
    blockEl = null;
    textEl = null;
  }
  onChange();
}

export function flush() {
  if (!textEl || !hasText) return;

  const text = textEl.textContent.trim();
  if (!text) { dismiss(); return; }

  // Tear down any orphaned interim span BEFORE we drop our textEl ref
  // — without this, a stale `interimEl` pointing at a node still inside
  // the about-to-fade blockEl could be reused by the next setInterim()
  // (which checks `if (!interimEl)`), wedging the new draft because
  // its writes go to a soon-to-be-removed DOM subtree. Symptom: app
  // appears inert after auto-send mid-sentence.
  if (interimEl) {
    try { interimEl.remove(); } catch {}
  }
  interimEl = null;

  if (blockEl) {
    blockEl.classList.add('flushing');
    const el = blockEl;
    setTimeout(() => el.remove(), 500);
    blockEl = null;
    textEl = null;
  }
  hasText = false;
  editing = false;
  lastSpeaker = null;
  segments = [];

  onFlush(text);
  onChange();
}

/** Insert text at the current caret position if and only if the caret
 *  is inside the draft textEl. Returns true on success. Returns false
 *  (without mutating anything) when:
 *   - no selection at all (common after the user taps elsewhere on mobile)
 *   - selection is in a different element (composer, another textarea)
 *
 *  Caller should fall back to the normal append-at-end path on false —
 *  silent-drop used to happen here on mobile when textEl.blur was missed
 *  (touch interactions don't always fire blur reliably); finals vanished
 *  because insertAtCursor had no valid range to work with. */
function insertAtCursor(text) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!textEl || !textEl.contains(range.commonAncestorContainer)) return false;
  range.deleteContents();
  const node = document.createTextNode(' ' + text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
