/**
 * @fileoverview Where a dictation's text goes — the ONE rule, in one place.
 *
 * Jonathan, 2026-09-06, after the mis-send in UX_DETERMINISM_PLAN §1:
 *
 *   "The Send button always sends what is in the current composer to the
 *    session on screen. A dictation is bound to the chat where recording
 *    STARTED. The checkmark dumps the transcript into the composer DRAFT
 *    of that origin chat. If you switched sessions mid-dictation the
 *    visible composer is untouched; the draft is waiting in the origin
 *    chat, where you can switch, edit and send."
 *
 * Note what this is NOT: it does not redirect a send, and it does not
 * put a "sending to <other chat>" chip on the composer (the Phase 0 #4
 * sketch in UX_DETERMINISM_PLAN proposed exactly that; he replaced it
 * with this). Send addressing is untouched — the composer's contents go
 * to the chat on screen, always. This module only decides where a
 * transcript LANDS, and the answer is never "a chat the user isn't in,
 * as a send".
 *
 * ── The bug this closes ───────────────────────────────────────────────
 *
 * Every dictation delivery path ended at `composer.appendText(text)`,
 * which writes the VISIBLE textarea. That is "pointed, not addressed"
 * (UX_DETERMINISM_PLAN §6 rule 3) and it is unobservable in the no-switch
 * case, which is why it survived: a transcript arriving after a chat
 * switch — the checkmark pressed in another chat, a chunked retry, the
 * durable outbox draining minutes later on a bad link — landed in
 * whatever composer happened to be on screen. composerDrafts' own header
 * even documented it as intended ("STT output arriving AFTER the switch
 * lands in the newly bound chat, same as typing would"). It is not: the
 * user aimed those words at a conversation, and the app moved the target.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 *
 * Capture `originChatId` when RECORDING STARTS (captureOrigin), carry it
 * on whatever survives the wait (the durable queue row, the dictate
 * session), and at delivery time ask routeDictation exactly once:
 *
 *   focused === origin  → 'composer'  — behave exactly as before: insert
 *                                       at the anchored caret, visible.
 *   otherwise           → 'draft'     — append to the ORIGIN chat's
 *                                       persisted draft; do not touch the
 *                                       visible textarea.
 *
 * A null origin means "we never knew" (a legacy outbox row from before
 * this shipped, or a dictation started before any view committed) and
 * routes to the composer — the pre-existing behaviour, which is the only
 * non-destructive answer when there is no chat to address.
 *
 * Durability comes free on the draft side: composerDrafts.appendDraft
 * flushes to the `parley-drafts` IDB store immediately and appends
 * without clobbering whatever the user had already typed there. A draft
 * written this way restores into the composer through the ordinary
 * view-commit seam (composerDrafts.switchTo reads the same cache), so
 * "switch back to the origin chat and it is in the box" needs no new
 * restore path.
 *
 * Leaf-ish by construction: switchController, composer, composerDrafts
 * and toast only. The two things that would drag the adapter and the
 * sidebar into this graph — the pre-view chat-id fallback and the chat
 * title for the toast — are INJECTED by main.ts instead (init below).
 */

import * as switchCtl from './switchController.ts';
import * as composer from './composer.ts';
import * as composerDrafts from './composerDrafts.ts';
import { toast } from './toast.ts';
import { log } from './util/log.ts';

/** 'composer' = the visible textarea (unchanged, pre-existing behaviour).
 *  'draft'    = the origin chat's persisted draft, out of sight. */
export type DictationRoute = 'composer' | 'draft';

/** THE rule, as a pure function of the two ids so it is testable without
 *  a DOM, a queue or a browser, and so there is exactly one place to read
 *  when asking "why did my dictation go there?". */
export function routeDictation(state: {
  focusedId: string | null;
  originChatId: string | null;
}): DictationRoute {
  // Unbound dictation (legacy queue row, or recording started before any
  // view committed): there is no chat to address it to, so the visible
  // composer is the only answer that doesn't hide the text.
  if (!state.originChatId) return 'composer';
  return state.focusedId === state.originChatId ? 'composer' : 'draft';
}

/** Pre-view chat-id fallback — `backend.getCurrentSessionId()`, injected
 *  so this module stays out of the adapter's import graph. Default is
 *  "no fallback": switchController alone, which is the authority anyway
 *  (UX_DETERMINISM_PLAN §6 rule 2). */
let fallbackChatId: () => string | null = () => null;
/** Chat title for the off-screen-landing toast. Injected from main.ts
 *  (sessionDrawer.getTitleForChat) — importing the sidebar here would
 *  pull it into the audio modules' graph for one string. */
let titleResolver: (id: string) => string | null = () => null;

export function init(opts: {
  fallbackChatId?: () => string | null;
  titleFor?: (id: string) => string | null;
}): void {
  if (opts.fallbackChatId) fallbackChatId = opts.fallbackChatId;
  if (opts.titleFor) titleResolver = opts.titleFor;
}

/** The chat a dictation started RIGHT NOW belongs to. Same resolver as
 *  main.ts's currentChatId() and memoOutbox's send addressing — view
 *  state first, adapter memo only for the pre-view cases. Deliberately
 *  ONE function so capture and routing can never disagree about what
 *  "the current chat" means (a capture that read the adapter while the
 *  route read the view would send every dictation to a draft). */
export function captureOrigin(): string | null {
  return switchCtl.focusedId() ?? fallbackChatId() ?? null;
}

/** Deliver a dictation transcript. Returns the route taken so callers can
 *  narrate ('composer' — the text appearing IS the feedback; 'draft' — we
 *  say so, because nothing visible happened).
 *
 *  `anchorId` is the composer insertion anchor captured at record start.
 *  It is only meaningful for the visible composer, so the draft route
 *  releases it rather than leaking a registry entry.
 *
 *  `separator` is passed through to appendDraft: streaming finals are
 *  sentence fragments of one utterance and join with a space, whereas a
 *  whole batch dictation is its own paragraph. */
export function deliver(text: string, opts: {
  originChatId: string | null;
  anchorId?: number | null;
  separator?: string;
  /** Suppress the toast — for callers that narrate the landing
   *  themselves, or fire many small deliveries in a row. */
  quiet?: boolean;
}): DictationRoute {
  const body = (text || '').trim();
  if (!body) {
    composer.releaseAnchor(opts.anchorId);
    return 'composer';
  }
  const route = routeDictation({
    focusedId: captureOrigin(),
    originChatId: opts.originChatId,
  });
  if (route === 'composer') {
    composer.appendText(body, typeof opts.anchorId === 'number' ? opts.anchorId : null);
    return 'composer';
  }
  // Off-origin. The anchor described a position in a textarea that now
  // holds a different chat's text; using it would splice into the wrong
  // conversation at a meaningless offset.
  composer.releaseAnchor(opts.anchorId);
  // The ghost "Transcribing…" line belongs to the dictation that just
  // finished, not to the chat now on screen.
  composer.clearInterim();
  composerDrafts.appendDraft(opts.originChatId, body, { separator: opts.separator });
  log(`[dictation] ${body.length} chars → draft of ${opts.originChatId?.slice(-12)} `
    + `(focused ${captureOrigin()?.slice(-12) ?? '∅'})`);
  if (!opts.quiet) {
    // Silence here would BE the failure the user fears: they pressed the
    // checkmark and nothing appeared. Same precedent (and same wording
    // shape) as the call-end rescue's cross-chat toast in main.ts, which
    // exists for exactly this "nothing on screen to notice" case. This is
    // not the "sending to <chat>" chip he rejected — nothing is being
    // sent, and the composer is not being redirected.
    const title = opts.originChatId ? titleResolver(opts.originChatId) : null;
    toast(title
      ? `Dictation saved as a draft in ${title}`
      : 'Dictation saved as a draft in the chat you started it in');
  }
  return 'draft';
}
