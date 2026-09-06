// Per-chat composer drafts (Jonathan's ask, 2026-07-12) — WhatsApp/
// Slack/Telegram semantics: type in chat A, switch to B, A's text is
// waiting on return. Mirrors chatScrollPositions.ts: in-memory Map is
// the sync read source, IDB persists it, debounced write-through.
//
// The core invariant is the same "addressed, not pointed" rule as
// sends (hardening invariant #3): `boundChatId` records WHOSE text
// currently occupies the textarea, and every save writes to it — never
// to "whatever chat is focused when the debounce fires". A switch
// mid-debounce therefore cannot leak chat A's text into chat B's
// draft.
//
// Seams (all funnel through switchTo, called from sessionDrawer's
// applyViewChangedEffects — the same view-commit choke point the
// hardening phases built):
//   - switchTo(id): save textarea → boundChatId, load id's draft into
//     the textarea, rebind. No-op when already bound to id (view-token
//     repaints, same-chat resumes).
//   - stashAndClear(): new-chat's pre-mint step — save + blank without
//     a target chat yet (the minted chat binds via switchTo when the
//     handler's setViewed fires).
//   - clearDraft(chatId): successful send — clears the ADDRESSED
//     chat's draft, not the visible box's.
//
// v1 scope (recorded in the session-hardening doc): text only
// (attachments stay with the visible composer), per-device (no sync),
// no badges (drafts are inventory, not attention — one-number rule).
//
// Mid-dictation switches (REVISED 2026-09-06): interim text saved so far
// still stays with the chat it was bound to at switch time. What changed
// is the second half of this note, which used to read "STT output
// arriving AFTER the switch lands in the newly bound chat, same as
// typing would". It is NOT the same as typing: typing is aimed by the
// finger that is on the keyboard now, whereas a transcript was aimed
// minutes ago at a conversation the user has since left. A dictation is
// now bound to the chat where recording started and its late output
// appends to THAT chat's draft — see dictationBinding.ts for the rule
// and UX_DETERMINISM_PLAN §1/§6 for the mis-send that motivated it.

import { diag } from './util/log.ts';

const DB_NAME = 'parley-drafts';
const STORE = 'drafts';
// Second store, same DB (v2): the per-chat UNDO buffer for "clear the
// composer". See clearWithUndo() for the lifetime rules.
const CLEARED_STORE = 'cleared';
const DB_VERSION = 2;
const PERSIST_DEBOUNCE_MS = 300;

interface DraftRecord {
  chatId: string;
  text: string;
  savedAt: number;
}

const cache = new Map<string, string>();
const clearedCache = new Map<string, string>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
let hydrated = false;
/** Debounced "drafts changed" broadcast — the drawer listens and
 *  re-renders rows so the WhatsApp-style "Draft:" snippet tracks
 *  reality without a per-keystroke repaint. */
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notifyChanged(): void {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    try { window.dispatchEvent(new CustomEvent('parley:draft-changed')); } catch { /* noop */ }
  }, 250);
}
let boundChatId: string | null = null;
let textareaRef: HTMLTextAreaElement | null = null;
/** Re-run composer chrome (autoResize, send-button state) after a
 *  programmatic restore. Wired by init. */
let onRestoredCb: (() => void) | null = null;
/** Synchronous "composer content or undo buffer changed" notifier —
 *  see init({ onComposerState }). */
let onComposerStateCb: (() => void) | null = null;
function notifyComposerState(): void {
  try { onComposerStateCb?.(); } catch { /* swallow — UI listener */ }
}

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Both creates are guarded, so v1→v2 adds only what's missing and
      // a fresh install gets both in one pass.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'chatId' });
      }
      if (!db.objectStoreNames.contains(CLEARED_STORE)) {
        db.createObjectStore(CLEARED_STORE, { keyPath: 'chatId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hydrateDrafts(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const db = await dbOpen();
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    await new Promise<void>((resolve) => {
      req.onsuccess = () => {
        const rows = (req.result || []) as DraftRecord[];
        for (const r of rows) {
          if (r?.chatId && typeof r.text === 'string' && r.text) cache.set(r.chatId, r.text);
        }
        diag(`[drafts] hydrate: ${rows.length} drafts from IDB`);
        resolve();
      };
      req.onerror = () => resolve();
    });
    // The undo buffers hydrate alongside the drafts: a cleared block of
    // rescued dictation must still be restorable after an app restart
    // (see clearWithUndo for why it has no expiry).
    const creq = db.transaction(CLEARED_STORE, 'readonly').objectStore(CLEARED_STORE).getAll();
    await new Promise<void>((resolve) => {
      creq.onsuccess = () => {
        const rows = (creq.result || []) as DraftRecord[];
        for (const r of rows) {
          if (r?.chatId && typeof r.text === 'string' && r.text) clearedCache.set(r.chatId, r.text);
        }
        diag(`[drafts] hydrate: ${rows.length} undo buffers from IDB`);
        resolve();
      };
      creq.onerror = () => resolve();
    });
    db.close();
  } catch (e: any) {
    diag(`[drafts] hydrate failed: ${e?.message ?? e}`);
  }
  // Boot race: the boot resume's switchTo(id) may have run before this
  // hydrate resolved and found no draft. If the bound chat's box is
  // still untouched (empty) and IDB held a draft for it, apply it now.
  if (boundChatId && textareaRef && !textareaRef.value) {
    const draft = cache.get(boundChatId);
    if (draft) {
      textareaRef.value = draft;
      onRestoredCb?.();
      diag(`[drafts] late-hydrate restore for ${boundChatId.slice(-12)}`);
    }
  }
  // A hydrated undo buffer changes which composer controls are relevant
  // even when the draft itself didn't change.
  notifyComposerState();
}

/** Wire the composer. The input listener saves keystrokes to the chat
 *  the text is BOUND to — captured here, at event time. */
export function init(opts: {
  textarea: HTMLTextAreaElement;
  onRestored?: () => void;
  /** Fired SYNCHRONOUSLY whenever the composer's content or its undo
   *  buffer changes — drives the clear/restore button gating in main.ts.
   *  Deliberately not the debounced `parley:draft-changed` broadcast:
   *  that one exists to batch sidebar repaints, and a 250 ms lag on a
   *  control that has to appear the instant you type is a different
   *  requirement wearing the same name. */
  onComposerState?: () => void;
}): void {
  textareaRef = opts.textarea;
  onRestoredCb = opts.onRestored ?? null;
  onComposerStateCb = opts.onComposerState ?? null;
  opts.textarea.addEventListener('input', () => {
    notifyComposerState();
    if (!boundChatId) return;
    saveDraft(boundChatId, opts.textarea.value);
  });
  window.addEventListener('pagehide', () => {
    if (boundChatId && textareaRef) saveDraft(boundChatId, textareaRef.value);
    for (const chatId of [...pendingWrites.keys()]) flushDraft(chatId);
  });
}

export function getDraft(chatId: string): string {
  return cache.get(chatId) ?? '';
}

/** The chat whose text currently occupies the composer (null before
 *  the first bind or after stashAndClear). Exposed for tests. */
export function boundTo(): string | null {
  return boundChatId;
}

function saveDraft(chatId: string, text: string): void {
  if (!chatId) return;
  if (text) cache.set(chatId, text);
  else cache.delete(chatId);          // emptied box = draft deliberately gone
  notifyChanged();
  const pending = pendingWrites.get(chatId);
  if (pending) clearTimeout(pending);
  pendingWrites.set(chatId, setTimeout(() => {
    pendingWrites.delete(chatId);
    void persistOne(chatId);
  }, PERSIST_DEBOUNCE_MS));
}

function flushDraft(chatId: string): void {
  const pending = pendingWrites.get(chatId);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(chatId);
  }
  void persistOne(chatId);
}

/** View-commit seam: save the outgoing chat's text, restore the
 *  incoming chat's draft. Called from sessionDrawer's view-changed
 *  effects on EVERY commit — the boundChatId guard makes same-chat
 *  repaints free. */
export function switchTo(chatId: string | null): void {
  if (!textareaRef || chatId === boundChatId) return;
  if (boundChatId) {
    saveDraft(boundChatId, textareaRef.value);
    flushDraft(boundChatId);
  }
  boundChatId = chatId;
  const incoming = chatId ? cache.get(chatId) ?? '' : '';
  if (textareaRef.value !== incoming) {
    textareaRef.value = incoming;
    onRestoredCb?.();
  }
  // Bind change flips which row hides its "Draft:" snippet (the bound
  // chat's draft lives in the composer, not its row).
  notifyChanged();
  // …and flips which composer controls are relevant: both the content
  // and the undo buffer are per-chat.
  notifyComposerState();
}

/** New-chat's pre-mint step: preserve the outgoing chat's text and
 *  blank the box, with no incoming chat bound yet. Replaces the old
 *  destructive `composerInput.value = ''` (which LOST typed text —
 *  the papercut this feature retires). The freshly minted chat binds
 *  via switchTo when the handler's setViewed lands. */
export function stashAndClear(): void {
  if (!textareaRef) return;
  if (boundChatId) {
    saveDraft(boundChatId, textareaRef.value);
    flushDraft(boundChatId);
  }
  boundChatId = null;
  textareaRef.value = '';
  notifyComposerState();
}

/** APPEND text to a chat's draft, whether or not that chat is the one
 *  currently in the composer. Returns true when the text landed in the
 *  visible textarea (so the caller can toast "in the composer" rather
 *  than "as a draft").
 *
 *  Built for voice rescue (Jonathan field bug 2026-08-30 — dropped call
 *  ate several minutes of dictation). Two properties matter:
 *
 *   - ADDRESSED, not pointed. The call's chat may not be the one on
 *     screen when the network finally gives up, so the write is keyed
 *     by chatId — same rule as sends (invariant #3) and the same
 *     precedent as the cross-chat listen-turn recovery, which routes a
 *     late transcript to the composer for review instead of sending it.
 *   - NON-CLOBBERING. Whatever he was typing stays; the rescued speech
 *     is appended after it with a blank line, so nothing he authored is
 *     overwritten by a background event he didn't ask for.
 *
 *  Durability comes free: this funnels through saveDraft, so the text is
 *  in the `parley-drafts` IDB store and survives an app restart (a
 *  rescue that only lived in a DOM node would be lost to the very same
 *  reload the dropped call often triggers). flushDraft skips the
 *  300 ms debounce — a rescue must not race a backgrounding tab.
 *
 *  `separator` defaults to a blank line: a rescued block, or a whole
 *  batch dictation, is its own paragraph. Streaming callers appending
 *  successive fragments of ONE utterance pass ' ' so the sentence doesn't
 *  come back cut into paragraphs. An option rather than something guessed
 *  from the text, because only the caller knows whether what it holds is
 *  a fragment or a block. */
export function appendDraft(
  chatId: string | null,
  text: string,
  opts?: { separator?: string },
): boolean {
  const addition = (text || '').trim();
  if (!chatId || !addition) return false;
  const sep = opts?.separator ?? '\n\n';
  const join = (existing: string) =>
    (existing.trim() ? `${existing.replace(/\s+$/, '')}${sep}${addition}` : addition);
  if (chatId === boundChatId && textareaRef) {
    textareaRef.value = join(textareaRef.value);
    saveDraft(chatId, textareaRef.value);
    flushDraft(chatId);
    onRestoredCb?.();
    notifyComposerState();
    return true;
  }
  saveDraft(chatId, join(cache.get(chatId) ?? ''));
  flushDraft(chatId);
  return false;
}

// ── Clear-with-undo ────────────────────────────────────────────────────
//
// Jonathan's ask, 2026-08-30: "a very subtle x" in the composer's bottom
// row that appears only when there's content, and a restore icon that
// appears only while there's something to put back. This is the DISCARD
// gesture for text the call-end rescue parked here — which is why it has
// to be genuinely undoable rather than a toast with a countdown.
//
// BUFFER LIFETIME (he left this to us; the rule and its reasoning):
//   Kept:    across chat switches, across call end, across reload. The
//            buffer is per-chat and persisted in the same IDB database
//            as the draft, so it has the draft's durability. Rescued
//            dictation is the single most expensive content in the app
//            to lose — minutes of speech that exists nowhere else — and
//            a reload is exactly what a flaky-network session tends to
//            produce.
//   Dropped: (a) on a successful SEND from that chat's composer (the
//            turn moved on; the cleared text is stale relative to a
//            conversation that has advanced), and (b) when another
//            clear in the same chat replaces it.
//   Explicitly NOT time-based. A 5-second (or 5-minute) expiry is a
//   trap for the exact user this feature exists for: on a bike or in a
//   car, unable to look at the screen, discovering the mistake later.
//   An undo that has quietly expired is worse than no undo, because he
//   will have stopped worrying about the text.

/** True iff `chatId` has text that a clear stashed and nothing has
 *  spent yet — i.e. the restore control should exist. */
export function hasClearedText(chatId: string | null): boolean {
  if (!chatId) return !!unboundCleared;
  return !!(chatId && clearedCache.get(chatId));
}

/** The stashed text for `chatId` ('' if none). Exposed for tests and
 *  for callers that want to preview the undo. */
export function getClearedText(chatId: string | null): string {
  return (chatId && clearedCache.get(chatId)) || '';
}

function saveCleared(chatId: string, text: string): void {
  if (text) clearedCache.set(chatId, text);
  else clearedCache.delete(chatId);
  void persistCleared(chatId);
  notifyComposerState();
}

/** Write `next` into the textarea, preserving the browser's native undo
 *  stack when we can.
 *
 *  Assigning `.value` destroys that stack outright, so ⌘Z / iOS
 *  shake-to-undo silently stop working on the composer. execCommand
 *  ('insertText') keeps it — but it requires focus, and stealing focus
 *  would pop the on-screen keyboard on a phone, which is precisely the
 *  wrong thing to do to someone clearing a block of rescued dictation
 *  while cycling. So: use the undoable path ONLY when the textarea is
 *  already focused (the typing case, where reaching for ⌘Z is the
 *  reflex), and fall back to the plain assignment otherwise. The
 *  explicit restore button is the primary mechanism either way; native
 *  undo is a bonus we take when it is free. */
function writeTextarea(ta: HTMLTextAreaElement, next: string): void {
  if (document.activeElement === ta) {
    try {
      ta.setSelectionRange(0, ta.value.length);
      // Deprecated but still the only cross-browser way to make a
      // programmatic edit undoable. Guarded: Safari/WebView return
      // false (or throw) in some states, and we verify the result
      // rather than trusting the return value.
      const ok = document.execCommand('insertText', false, next);
      if (ok && ta.value === next) return;
    } catch { /* fall through to the plain assignment */ }
  }
  ta.value = next;
}

/** Clear the composer, stashing its text in the bound chat's undo
 *  buffer. Returns true if anything was cleared. */
/** Undo buffer for a clear performed while NO chat is bound (fresh app,
 *  nothing selected yet — the composer still accepts text and mints a
 *  chat on send). There is no per-chat key to persist under, so this one
 *  is in-memory and dies with the page. That is a real limitation, but
 *  the alternative shipped for a day and was worse: clearWithUndo wiped
 *  the textarea and stored NOTHING, so the ✕ was silently destructive in
 *  exactly the state where the restore button also could not appear.
 *  Caught by a render with no chat selected, 2026-08-31. */
let unboundCleared: string | null = null;

export function clearWithUndo(): boolean {
  if (!textareaRef) return false;
  const text = textareaRef.value;
  if (!text) return false;
  writeTextarea(textareaRef, '');
  if (boundChatId) {
    saveDraft(boundChatId, '');
    flushDraft(boundChatId);
    saveCleared(boundChatId, text);
  } else {
    unboundCleared = text;
  }
  onRestoredCb?.();
  notifyComposerState();
  diag(`[drafts] cleared ${text.length} chars (undoable) for ${boundChatId?.slice(-12) ?? '∅'}`);
  return true;
}

/** Put the bound chat's undo buffer back in the composer. Returns true
 *  if anything was restored.
 *
 *  APPENDS rather than overwrites: between the clear and the restore he
 *  may have typed something, and a restore that ate it would need its
 *  own undo. Same non-clobbering rule as appendDraft. */
export function restoreCleared(): boolean {
  if (!textareaRef) return false;
  if (!boundChatId) {
    // Unbound-clear counterpart. Same append-not-overwrite rule.
    const pending = unboundCleared;
    if (!pending) return false;
    unboundCleared = null;
    const cur = textareaRef.value;
    writeTextarea(textareaRef, cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${pending}` : pending);
    onRestoredCb?.();
    notifyComposerState();
    return true;
  }
  const stashed = clearedCache.get(boundChatId);
  if (!stashed) return false;
  const existing = textareaRef.value;
  const next = existing.trim()
    ? `${existing.replace(/\s+$/, '')}\n\n${stashed}`
    : stashed;
  writeTextarea(textareaRef, next);
  saveDraft(boundChatId, next);
  flushDraft(boundChatId);
  saveCleared(boundChatId, '');
  onRestoredCb?.();
  notifyComposerState();
  diag(`[drafts] restored ${stashed.length} chars for ${boundChatId.slice(-12)}`);
  return true;
}

async function persistCleared(chatId: string): Promise<void> {
  try {
    const db = await dbOpen();
    const tx = db.transaction(CLEARED_STORE, 'readwrite');
    const text = clearedCache.get(chatId);
    if (text) {
      tx.objectStore(CLEARED_STORE).put({ chatId, text, savedAt: Date.now() } as DraftRecord);
    } else {
      tx.objectStore(CLEARED_STORE).delete(chatId);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e: any) {
    diag(`[drafts] undo-buffer persist failed for ${chatId}: ${e?.message ?? e}`);
  }
}

/** Successful send: the ADDRESSED chat's draft is spent. Uses the
 *  send's explicit chatId (invariant #3), not the visible box. */
export function clearDraft(chatId: string | null): void {
  if (!chatId) return;
  cache.delete(chatId);
  // The send is also what spends the undo buffer — the conversation has
  // moved on, so restoring pre-send text into the composer would be
  // offering to un-say something that was already said. This is the
  // ONLY lifetime rule besides "a newer clear replaces it".
  if (clearedCache.has(chatId)) saveCleared(chatId, '');
  notifyChanged();
  flushDraft(chatId);
}

async function persistOne(chatId: string): Promise<void> {
  try {
    const db = await dbOpen();
    const tx = db.transaction(STORE, 'readwrite');
    const text = cache.get(chatId);
    if (text) {
      tx.objectStore(STORE).put({ chatId, text, savedAt: Date.now() } as DraftRecord);
    } else {
      tx.objectStore(STORE).delete(chatId);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e: any) {
    diag(`[drafts] persist failed for ${chatId}: ${e?.message ?? e}`);
  }
}
