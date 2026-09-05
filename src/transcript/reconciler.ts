/**
 * @fileoverview Crack A — DOM reconciler. Walks a BubbleSpec[] and
 * brings the transcript element's children into agreement.
 *
 * Reconciliation contract:
 *   - Each transcript child carries `data-key` (the BubbleSpec.key).
 *   - For each spec in order:
 *       - If a child with that key exists, update it in place AND
 *         move it to the right ordinal position.
 *       - Else, create a fresh node, stamp `data-key`, insert at the
 *         right position.
 *   - After the walk, remove any children whose key wasn't visited.
 *
 * Bubble creation delegates to `chat.addLine` for user/assistant
 * bubbles (so we inherit speaker labels, copy/pin/play/fold buttons,
 * attachments). Activity rows are rendered locally — the legacy
 * activityRow.ts is being deleted.
 *
 * Updates are done in place via DOM manipulation: `.text` span content,
 * `.streaming` / `.pending` classes, `data-text` mirror for replyPlayer.
 * The reconciler never recreates a bubble whose key is already in DOM,
 * so text selection / scroll position / copy-button confirmation states
 * survive.
 */

import * as chat from '../chat.ts';
import { miniMarkdown, renderUserText } from '../util/markdown.ts';
import { escapeHtml } from '../util/dom.ts';
import * as settings from '../settings.ts';
import { getAgentLabel } from '../config.ts';
import { applyBubbleState as applyReplyPlayerState } from '../audio/turn-based/replyPlayer.ts';
import { rehydrateCards, ensureHistoricalCards } from '../cards/attach.ts';
import * as memoCardMod from '../memoCard.ts';
import * as activityStore from '../notifications/activityStore.ts';
import { parseApprovalPrompt } from '../notifications/approvalText.ts';
import {
  APPROVAL_ACTION_LABELS, APPROVAL_RESOLUTION_LABELS, sendApprovalAction,
} from '../notifications/approvalActions.ts';
import type { TurnStatusSpec, ActivityRowSpec, ActivityTool, AssistantBubbleSpec, BubbleSpec, GapBubbleSpec, MemoCardSpec, NotificationBubbleSpec, SystemLineSpec, UserBubbleSpec } from './types.ts';

const KEY_ATTR = 'data-key';

/** Options for reconcile().
 *
 *  `batchBubbles`: pass true to suppress chat.addLine's per-bubble
 *  autoScroll + persist side effects. Used by the virtualizer's
 *  renderWindow callback — under virt the window shifts during
 *  touch-scroll, each new bubble's autoScroll would re-check pinned
 *  and snap the page back. Default path (reconcile called directly
 *  on #transcript from streaming/durable updates) leaves this false
 *  to preserve the per-bubble follow-along. */
export interface ReconcileOpts {
  batchBubbles?: boolean;
}

export function reconcile(transcriptEl: HTMLElement, specs: BubbleSpec[], opts: ReconcileOpts = {}): void {
  const batchBubbles = !!opts.batchBubbles;
  // Snapshot existing keyed children up-front so the move/insert pass
  // can find them in O(1). Children WITHOUT `data-key` are stale —
  // they come from a pre-Crack-A `chat.restoreSnapshot()` DOM-string
  // restore (old wire shape, no data-key attribute) or from any
  // legacy code path that bypassed the reconciler. The reconciler
  // is now the sole owner of transcript content; wipe them so they
  // don't ghost alongside the projection output.
  //
  // ── TRANSCRIPT OWNERSHIP CONTRACT (hardening phase 4/5) ───────────
  // Every child of #transcript is one of exactly three things:
  //   1. MODEL-OWNED (has data-key): created/updated/removed by this
  //      reconciler from BubbleSpecs — bubbles, activity rows, gaps,
  //      notifications, and (since phase 4) system-line decorations.
  //   2. OWNER-SCOPED:
  //      2a. ISLANDS (`data-island` attribute): surfaces whose interior
  //          state cannot round-trip through spec-driven re-render —
  //          the draft block's contentEditable cursor/IME state. The
  //          reconciler PRESERVES them by declaration (position kept
  //          relative to the timeline, like system markers). This is
  //          the uncontrolled-component pattern: declare the boundary,
  //          don't own the interior. Pinned by smoke
  //          draft-island-survives-reconcile.
  //      2b. Self-healing keyless leftovers: the boot HTML-snapshot
  //          restore. Wiped as stale by the next reconcile BY DESIGN —
  //          it's a pre-pipeline boot paint replaced by the first real
  //          render.
  //   3. LEGACY keyless `.line.system` rows — preserved by the
  //      exception below. Post-phase-4 these can only come from a boot
  //      HTML-snapshot restore (addSystemLine now writes keyed
  //      decorations); the new-chat handler sweeps them
  //      (`.line.system:not([data-key])`) so they can't stack over a
  //      fresh chat.
  // Anything else appended to #transcript will be wiped on the next
  // reconcile — that's the contract, not a bug.
  //
  // EXCEPTION (case 3 above): keyless `.line.system` rows are orthogonal
  // markers — appended directly to #transcript by the boot-snapshot
  // restore and lack a data-key, but shouldn't be removed when
  // a sibling bubble reconciles. chat.clear() still wipes them on chat
  // switch via innerHTML='', so they don't leak between chats. NOTE:
  // notification bubbles ALSO carry class `system` (plus `notification`)
  // but ARE owned by the projection — they have a data-key — so they
  // continue through the normal existing/stale path. Field bug
  // 2026-05-24: smoke `slash-commands` flagged the regression where a
  // keyless system line landed in DOM and was immediately stripped by
  // the next reconcile triggered by an optimistic pending-send upsert.
  const existing = new Map<string, HTMLElement>();
  const stale: HTMLElement[] = [];
  for (const child of Array.from(transcriptEl.children) as HTMLElement[]) {
    const key = child.getAttribute(KEY_ATTR);
    if (key) {
      existing.set(key, child);
    } else if (!child.classList.contains('system') && !child.hasAttribute('data-island')) {
      stale.push(child);
    }
    // Keyless `.line.system` rows and declared islands fall through —
    // neither tracked nor removed (contract case 2a/3 above).
  }
  for (const el of stale) el.remove();

  const visited = new Set<string>();

  // Keyless `.line.system` rows ("New chat started", context-reset /
  // model-switch delimiters) are timeline markers the projection doesn't
  // own — they have no data-key and aren't in `specs`. They must keep
  // their DOM position relative to the surrounding messages.
  const isKeylessSystemRow = (n: ChildNode | null): boolean =>
    !!n && n instanceof HTMLElement
    && !n.getAttribute(KEY_ATTR)
    && (n.classList.contains('system') || n.hasAttribute('data-island'));

  // Position spec elements in spec order using a DOM cursor that SKIPS
  // keyless system rows. The previous implementation positioned spec[i]
  // at `children[i]`, which counted a system marker as occupying a slot —
  // so each appended message did insertBefore(msg, marker) and the marker
  // sank one row per message ("New chat started"
  // started at the top of a fresh chat and got pushed to the bottom as
  // the conversation grew). Anchoring to the spec subsequence instead
  // leaves markers pinned to their place in the timeline.
  let cursor: ChildNode | null = transcriptEl.firstChild;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    visited.add(spec.key);

    let el = existing.get(spec.key);
    if (!el) {
      el = createForSpec(spec, batchBubbles);
      if (!el) continue;
      el.setAttribute(KEY_ATTR, spec.key);
    } else {
      updateForSpec(el, spec);
    }

    // Date stamping: show the short date sub-line under the time on EVERY
    // bubble. chat.addLine's create path stamps `.line-ts` with a plain
    // HH:MM string; updateTimestamp rebuilds it into the time/date sub-span
    // stack. The reconcile loop only runs updateForSpec on EXISTING
    // elements, so re-stamp freshly created bubbles here to guarantee the
    // date sub-line exists before we make it visible.
    const ts = bubbleTimestamp(spec);
    if (ts != null) {
      updateTimestamp(el, ts);
      setTimestampDateVisible(el, true);
    }

    // Advance the cursor past any marker rows so a message is placed
    // around (not on top of) them.
    while (cursor && isKeylessSystemRow(cursor)) cursor = cursor.nextSibling;
    if (cursor === el) {
      // Already in the right place; step over it.
      cursor = el.nextSibling;
    } else {
      transcriptEl.insertBefore(el, cursor);
      // el now sits immediately before `cursor`; the next spec belongs
      // after el, i.e. still before `cursor` — leave cursor as-is.
    }
  }

  // Remove anything that didn't appear in specs.
  for (const [key, el] of existing) {
    if (!visited.has(key)) el.remove();
  }
}

// ── create ─────────────────────────────────────────────────────────────

function createForSpec(spec: BubbleSpec, batch: boolean): HTMLElement | null {
  switch (spec.kind) {
    case 'user':       return createUser(spec, batch);
    case 'assistant':  return createAssistant(spec, batch);
    case 'notification': return createNotification(spec, batch);
    case 'activityRow': return createActivityRow(spec);
    case 'gap':        return createGap(spec);
    case 'systemLine': return createSystemLine(spec);
    case 'memoCard':   return createMemoCard(spec);
    case 'turnStatus': return createTurnStatus(spec);
  }
}

/** Bottom-pinned "agent is working" line: three pulsing dots + a label
 *  ("Thinking", or the parsed heartbeat). A `.line.system` row so it's
 *  never mistaken for an agent bubble by caret/pin/first-reply logic. */
function createTurnStatus(spec: TurnStatusSpec): HTMLElement {
  const el = document.createElement('div');
  el.className = 'line system turn-status';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  const text = document.createElement('span');
  text.className = 'turn-status-text';
  el.appendChild(dots);
  el.appendChild(text);
  updateTurnStatus(el, spec);
  return el;
}

function updateTurnStatus(el: HTMLElement, spec: TurnStatusSpec): void {
  const text = el.querySelector('.turn-status-text');
  if (text && text.textContent !== spec.text) text.textContent = spec.text;
}

/** Reconciler-owned memo card (writer migration 2026-07-13). The
 *  decoration declares existence + timeline position; the card's data
 *  comes synchronously from memoCard's rec registry (IDB-mirrored).
 *  Registry miss (e.g. a stale decoration surviving a registry drop)
 *  renders nothing — returning null skips the spec cleanly. Playback
 *  state lives in the node; updateForSpec is deliberately a no-op so
 *  the node (and its playing <audio>) is never rebuilt. */
function createMemoCard(spec: MemoCardSpec): HTMLElement | null {
  const entry = memoCardMod.getRegistered(spec.memoId);
  if (!entry) return null;
  return memoCardMod.createCard(entry.rec);
}

/** Reconciler-owned system line (hardening phase 4). Same DOM shape as
 *  the legacy keyless chat.addSystemLine rows — `.line.system`,
 *  plain text — but keyed, so replays dedupe instead of stacking and
 *  the keyless-preservation exception below is no longer load-bearing
 *  for these (it stays for the boot HTML-snapshot rows until that
 *  writer migrates). */
function createSystemLine(spec: SystemLineSpec): HTMLElement {
  const div = document.createElement('div');
  div.className = 'line system';
  div.textContent = spec.text;
  return div;
}

function createUser(spec: UserBubbleSpec, batch: boolean): HTMLElement | null {
  const cls = ['line', 's0'];
  if (spec.pending) cls.push('pending');
  if (spec.failed) cls.push('failed');
  const el = chat.addLine('You', spec.text, cls.slice(1).join(' '), {
    markdown: false,
    timestamp: spec.timestamp,
    attachments: spec.attachments,
    messageId: spec.key,
    source: spec.source,
    pending: spec.pending,
    batch,
  });
  return el || null;
}

function createAssistant(spec: AssistantBubbleSpec, batch: boolean): HTMLElement | null {
  const cls = ['agent'];
  if (spec.streaming) cls.push('streaming');
  const el = chat.addLine(getAgentSpeaker(), spec.text, cls.join(' '), {
    markdown: true,
    timestamp: spec.timestamp,
    messageId: spec.key,
    replyId: spec.key,
    batch,
  });
  if (!el) return null;
  if (spec.streaming) ensureThinkingDots(el);
  // Under virtualization the bubble's DOM is destroyed when it scrolls
  // outside the window. Reapply any persisted tts playback state (loaded
  // bar, played bar, .tts-* classes) AND replay attached cards so a
  // remounted bubble paints the user's last view instead of zeroed-out
  // bars + empty card slot.
  applyReplyPlayerState(el, spec.key);
  rehydrateCards(el, spec.key);
  // Reload / session-switch persistence: re-derive media cards from the
  // finalized body when the in-memory card store has nothing for this
  // reply (fresh page load, or a historical bubble backfilled during
  // resume). Streaming bubbles are skipped — their text is still growing
  // and the live handleReplyFinal lane owns their cards; a partial parse
  // could classify an incomplete markdown link. Parses once per replyId
  // (see ensureHistoricalCards) so this stays cheap under virt remounts.
  if (!spec.streaming) ensureHistoricalCards(el, spec.key, spec.text);
  return el;
}

function notificationEmoji(kind: string): string {
  if (kind === 'cron') return '⏰';
  if (kind === 'approval') return '⚠️';
  return '🔔';
}

function applyNotificationKindClass(el: HTMLElement, kind: string): void {
  for (const cls of Array.from(el.classList)) {
    if (cls.startsWith('notification-')) el.classList.remove(cls);
  }
  if (kind) el.classList.add(`notification-${kind}`);
}

function createNotification(spec: NotificationBubbleSpec, batch: boolean): HTMLElement | null {
  const emoji = notificationEmoji(spec.notificationKind);
  // Match the legacy handleNotification rendering verbatim: speaker
  // is the raw `kind` string (lowercase as the agent emits it) when
  // present, else "Notification". Smokes pattern-match on lowercase
  // 'cron' / 'reminder' substrings.
  const label = spec.notificationKind && spec.notificationKind !== 'notification'
    ? spec.notificationKind
    : 'Notification';
  const el = chat.addLine(`${emoji} ${label}`, spec.text, 'system notification', {
    markdown: true,
    timestamp: spec.timestamp,
    messageId: spec.key,
    batch,
  }) || null;
  if (el) {
    applyNotificationKindClass(el, spec.notificationKind || 'notification');
    if (spec.notificationKind === 'approval') renderApprovalCard(el, spec);
  }
  return el;
}

// ── Approval card ──────────────────────────────────────────
// The hermes approval prompt used to render as a plain markdown
// notification: a "⚠️ approval" speaker line, then the body's own
// "⚠️ Dangerous command requires approval:" header, the full command,
// the reason, and the "Reply /approve …" instructions — two stacked
// triangles, lots of dead space, nothing clickable, and no way to tell
// it had been approved from the Activity tray (field 2026-09-05). Now:
// ONE warning line (the speaker), the reason, the command collapsed by
// default, and a footer that is either Approve / Approve session / Deny
// or the outcome pill. State comes from the Activity store (the same
// record the tray renders), so approving anywhere flips the card.

const APPROVAL_SPEAKER = '⚠️ Dangerous command requires approval';
const APPROVAL_PEEK_MAX = 72;

function approvalItemFor(key: string): activityStore.ActivityItem | null {
  if (!key) return null;
  for (const item of activityStore.listActivity()) {
    if (item.kind !== 'approval') continue;
    if (item.id === key || item.messageId === key) return item;
  }
  return null;
}

function renderApprovalCard(el: HTMLElement, spec: NotificationBubbleSpec): void {
  const speaker = el.querySelector('.speaker') as HTMLElement | null;
  if (speaker && speaker.textContent !== APPROVAL_SPEAKER) speaker.textContent = APPROVAL_SPEAKER;
  const text = el.querySelector('.text') as HTMLElement | null;
  if (!text) return;
  el.dataset.approvalKey = spec.key;
  if (text.dataset.approvalRendered !== spec.key) {
    text.dataset.approvalRendered = spec.key;
    text.innerHTML = '';
    const { command, reason } = parseApprovalPrompt(spec.text);
    const card = document.createElement('div');
    card.className = 'approval-card';
    if (reason) {
      const r = document.createElement('div');
      r.className = 'approval-reason';
      r.textContent = reason;
      card.appendChild(r);
    }
    if (command) {
      const det = document.createElement('details');
      det.className = 'approval-command';
      const sum = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'approval-command-label';
      label.textContent = 'Command';
      const peek = document.createElement('code');
      peek.className = 'approval-command-peek';
      const lines = command.split('\n').filter(l => l.trim());
      let first = lines[0] || '';
      if (first.length > APPROVAL_PEEK_MAX) first = first.slice(0, APPROVAL_PEEK_MAX - 1) + '…';
      peek.textContent = lines.length > 1 ? `${first}  +${lines.length - 1} more` : first;
      sum.appendChild(label);
      sum.appendChild(peek);
      const full = document.createElement('pre');
      full.className = 'approval-command-full';
      full.textContent = command;
      det.appendChild(sum);
      det.appendChild(full);
      // Clicks inside the card must not bubble to bubble-level handlers
      // (caret / select-on-click) — the summary toggle is the intent.
      det.addEventListener('click', (e) => e.stopPropagation());
      card.appendChild(det);
    } else if (!reason) {
      // Unrecognised shape — keep the body readable rather than blank.
      const body = document.createElement('div');
      body.className = 'approval-body';
      body.innerHTML = renderNotificationHtml(spec.text);
      card.appendChild(body);
    }
    const foot = document.createElement('div');
    foot.className = 'approval-foot';
    card.appendChild(foot);
    text.appendChild(card);
  }
  applyApprovalState(el);
}

function applyApprovalState(el: HTMLElement): void {
  const key = el.dataset.approvalKey || el.getAttribute(KEY_ATTR) || '';
  const item = approvalItemFor(key);
  // 'unknown' = no tray record (historical card from before the tray
  // existed, or evicted): render neither buttons nor an outcome.
  const state = item ? (item.resolved || 'pending') : 'unknown';
  if (el.dataset.approvalState !== state) el.dataset.approvalState = state;
  const foot = el.querySelector('.approval-foot') as HTMLElement | null;
  if (!foot) return;
  if (state === 'pending') {
    if (foot.querySelector('.approval-actions')) return;
    foot.innerHTML = '';
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    actions.setAttribute('aria-label', 'Approval actions');
    for (const [label, action] of APPROVAL_ACTION_LABELS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `approval-btn approval-btn-${action}`;
      btn.dataset.approvalAction = action;
      btn.textContent = label;
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        // Optimistic: disable until the /approve echo resolves the
        // record (backendEvents.handleUserMessage → activity-changed →
        // refreshApprovalCards flips the footer to the outcome pill).
        actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
        actions.classList.add('is-sending');
        sendApprovalAction(item?.chatId ?? null, action, item?.messageId || key || null);
      };
      actions.appendChild(btn);
    }
    foot.appendChild(actions);
    return;
  }
  if (state === 'unknown') {
    if (foot.childElementCount) foot.innerHTML = '';
    return;
  }
  const label = APPROVAL_RESOLUTION_LABELS[state] || state.replace('_', ' ');
  let pill = foot.querySelector('.approval-state') as HTMLElement | null;
  if (!pill) {
    foot.innerHTML = '';
    pill = document.createElement('span');
    pill.className = 'approval-state';
    foot.appendChild(pill);
  }
  if (pill.dataset.resolution !== state) pill.dataset.resolution = state;
  if (pill.textContent !== label) pill.textContent = label;
}

/** Re-derive every rendered approval card's state from the Activity
 *  store. Cheap DOM patch (no re-projection) — wired to the store's
 *  change events below so approving in the tray, on another device, or
 *  by typing /approve flips the in-chat card too. */
export function refreshApprovalCards(root: ParentNode | null = null): void {
  const scope = root ?? (typeof document !== 'undefined' ? document : null);
  if (!scope) return;
  scope.querySelectorAll<HTMLElement>('.line.notification-approval').forEach(applyApprovalState);
}

if (typeof window !== 'undefined') {
  window.addEventListener('parley:activity-changed', () => refreshApprovalCards());
  window.addEventListener('parley:server-activity-changed', () => refreshApprovalCards());
}

/** Per-activity-row user expand choice, keyed by spec.key. Lives OUTSIDE
 *  the DOM so it survives the virtualizer unmount/remount — the row's
 *  element (and any dataset.expanded on it) is destroyed when it scrolls
 *  out of the window, so DOM-stored state was lost on scroll-away-and-back
 *  (field 2026-05-27 nit 3: collapse a tool list, scroll away + back, it
 *  re-expanded). Reset on session switch (resetActivityExpandState) so a
 *  session's tool lists default collapsed when you switch back to it. */
const activityExpandByKey = new Map<string, boolean>();
export function resetActivityExpandState(): void { activityExpandByKey.clear(); }

function createActivityRow(spec: ActivityRowSpec): HTMLElement {
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.dataset.state = spec.complete ? 'complete' : 'in-progress';
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'activity-row-summary';
  summary.setAttribute('aria-expanded', 'false');
  const full = document.createElement('div');
  full.className = 'activity-row-full';
  full.style.display = 'none';
  row.appendChild(summary);
  row.appendChild(full);

  // One-click toggle on the summary line. Previously this read
  // dataset.expanded (unset by default) and flipped it, so the FIRST click
  // just re-asserted the already-shown state → it took TWO clicks to
  // collapse (field 2026-05-27 nit 1). Flip the CURRENT effective state
  // instead, and persist per-key so the choice survives virt remount/scroll.
  summary.addEventListener('click', () => {
    const current = activityExpandByKey.has(spec.key)
      ? activityExpandByKey.get(spec.key)!
      : false;   // matches the collapsed-by-default in applyActivityRowView
    activityExpandByKey.set(spec.key, !current);
    applyActivityRowView(row, spec);
  });

  renderActivityRowBody(row, spec);
  return row;
}

// ── update ─────────────────────────────────────────────────────────────

function updateForSpec(el: HTMLElement, spec: BubbleSpec): void {
  switch (spec.kind) {
    case 'user':       return updateUser(el, spec);
    case 'assistant':  return updateAssistant(el, spec);
    case 'notification': return updateNotification(el, spec);
    case 'activityRow': return updateActivityRow(el, spec);
    case 'gap':        return updateGap(el, spec);
    case 'systemLine':
      if (el.textContent !== spec.text) el.textContent = spec.text;
      return;
    case 'turnStatus': return updateTurnStatus(el, spec);
    case 'memoCard':
      // No-op by design: waveform/status/transcript updates flow
      // through the card's own DOM hooks (memoCard.update / find), and
      // rebuilding would kill in-progress playback.
      return;
  }
}

// ── gap (discontinuity placeholder) ─────────────────────────────────────

/** Inline "…" marker at a discontinuity between two non-contiguous runs
 *  of loaded messages. Tapping it (or scrolling into it — wired in the
 *  pagination layer) loads the missing range. Renders the visible gap
 *  that replaces a SILENT hole, so a missing message is always
 *  recoverable rather than lost (#223 / missing-user-bubble class). */
function createGap(spec: GapBubbleSpec): HTMLElement {
  const row = document.createElement('div');
  row.className = 'transcript-gap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'transcript-gap-btn';
  btn.innerHTML = '<span class="transcript-gap-dots">···</span><span class="transcript-gap-label">load messages</span>';
  btn.addEventListener('click', () => {
    if (row.classList.contains('loading')) return;
    row.classList.add('loading');
    // Read boundary/cursor from the dataset (kept current by updateGap)
    // rather than the create-time closure, so a re-rendered gap dispatches
    // its latest fill cursor.
    const afterRaw = row.dataset.afterId;
    row.dispatchEvent(new CustomEvent('parley:load-gap', {
      bubbles: true,
      detail: {
        key: row.dataset.key || spec.key,
        olderId: row.dataset.olderId || null,
        newerId: row.dataset.newerId || null,
        afterId: afterRaw ? Number(afterRaw) : null,
      },
    }));
  });
  row.appendChild(btn);
  applyGapBoundary(row, spec);
  return row;
}

function updateGap(el: HTMLElement, spec: GapBubbleSpec): void {
  applyGapBoundary(el, spec);
}

function applyGapBoundary(el: HTMLElement, spec: GapBubbleSpec): void {
  el.dataset.olderId = spec.olderId ?? '';
  el.dataset.newerId = spec.newerId ?? '';
  el.dataset.afterId = spec.afterId != null ? String(spec.afterId) : '';
}

function updateUser(el: HTMLElement, spec: UserBubbleSpec): void {
  // Pending → finalized class flip.
  if (spec.pending) el.classList.add('pending');
  else el.classList.remove('pending');
  if (spec.failed) {
    el.classList.add('failed');
    ensureRetryRow(el, spec);
  } else {
    el.classList.remove('failed');
    el.querySelector('.send-failed-row')?.remove();
  }
  // Text: only update if changed. User bubbles are usually immutable
  // but the optimistic→echo round-trip can rewrite the text.
  const span = el.querySelector('.text') as HTMLElement | null;
  if (span) {
    // renderUserText matches chat.addLine's create path: escape + <br> for
    // newlines AND `> ` quote blocks → <blockquote>. Must mirror addLine or
    // the optimistic→echo round-trip would wipe a select-to-quote reply's
    // blockquote rendering.
    const want = renderUserText(spec.text || '');
    if (span.innerHTML !== want) span.innerHTML = want;
  }
  updateTimestamp(el, spec.timestamp);
}

function ensureRetryRow(el: HTMLElement, spec: UserBubbleSpec): void {
  if (el.querySelector('.send-failed-row')) return;
  const row = document.createElement('div');
  row.className = 'send-failed-row';
  const label = document.createElement('span');
  label.textContent = 'Send failed.';
  row.appendChild(label);
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.onclick = (e) => {
    e.preventDefault();
    el.dispatchEvent(new CustomEvent('parley:retry-send', {
      bubbles: true,
      detail: { messageId: spec.key, text: spec.text },
    }));
  };
  row.appendChild(retry);
  el.appendChild(row);
}

function updateAssistant(el: HTMLElement, spec: AssistantBubbleSpec): void {
  // Text — re-render markdown only when the SOURCE changed. The
  // `data-text` mirror (stamped by chat.addLine on create and re-stamped
  // below) records the markdown this bubble last rendered; when it
  // matches the spec, skip miniMarkdown entirely. Two reasons:
  //   1. Cost: the old innerHTML comparison still PARSED the markdown on
  //      every reconcile of every assistant row — under the time-sliced
  //      backfill (one reconcile per batch over the whole window) that
  //      made update passes O(window × batches) in markdown parses.
  //   2. Correctness of the compare: the target/rel stamping below
  //      mutates the DOM AFTER innerHTML is set, so for any bubble with
  //      links `span.innerHTML !== rendered` was ALWAYS true and the
  //      bubble re-rendered (wiping selection/hydrated card state) on
  //      every reconcile.
  // Streaming rows still re-render per delta: each delta changes
  // spec.text, so the mirror mismatches until the next stamp.
  const span = el.querySelector('.text') as HTMLElement | null;
  if (span && (el.dataset.text ?? '') !== (spec.text || '')) {
    const rendered = miniMarkdown(spec.text || '');
    if (span.innerHTML !== rendered) {
      span.innerHTML = rendered;
      // Re-stamp anchor target/rel — miniMarkdown emits raw <a>.
      span.querySelectorAll('a').forEach(a => {
        a.target = '_blank';
        (a as HTMLAnchorElement).rel = 'noopener';
      });
    }
  }
  el.dataset.text = spec.text || '';

  // Streaming class.
  if (spec.streaming) {
    el.classList.add('streaming');
    ensureThinkingDots(el);
  } else {
    el.classList.remove('streaming');
    el.querySelector('.thinking-dots')?.remove();
  }
  updateTimestamp(el, spec.timestamp);
}

/** Markdown→HTML for a notification bubble's body. Exported so the
 *  update-path rendering can be unit-tested without a DOM. Notifications
 *  (incl. cron) carry real markdown, so this mirrors the assistant path
 *  rather than emitting escaped plaintext. */
export function renderNotificationHtml(text: string | undefined): string {
  return miniMarkdown(text || '');
}

function updateNotification(el: HTMLElement, spec: NotificationBubbleSpec): void {
  applyNotificationKindClass(el, spec.notificationKind || 'notification');
  if (spec.notificationKind === 'approval') {
    // Structured card owns .speaker/.text — never overwrite it with the
    // markdown body (that would resurrect the two-triangle layout).
    renderApprovalCard(el, spec);
    updateTimestamp(el, spec.timestamp);
    return;
  }
  const speaker = el.querySelector('.speaker') as HTMLElement | null;
  const label = spec.notificationKind && spec.notificationKind !== 'notification'
    ? spec.notificationKind
    : 'Notification';
  if (speaker) speaker.textContent = `${notificationEmoji(spec.notificationKind)} ${label}`;
  const span = el.querySelector('.text') as HTMLElement | null;
  if (span) {
    const rendered = renderNotificationHtml(spec.text);
    if (span.innerHTML !== rendered) {
      span.innerHTML = rendered;
      // Re-stamp anchor target/rel — miniMarkdown emits raw <a>.
      span.querySelectorAll('a').forEach(a => {
        a.target = '_blank';
        (a as HTMLAnchorElement).rel = 'noopener';
      });
    }
  }
  updateTimestamp(el, spec.timestamp);
}

function updateActivityRow(el: HTMLElement, spec: ActivityRowSpec): void {
  el.dataset.state = spec.complete ? 'complete' : 'in-progress';
  renderActivityRowBody(el, spec);
}

/** Timestamp for the day-boundary calc — only the bubble kinds that
 *  actually render a `.line-ts` (user / assistant / notification) carry a
 *  date sub-line. Gap + activity rows return null so they neither reset
 *  the day cursor nor get a (nonexistent) date stamped on them. */
function bubbleTimestamp(spec: BubbleSpec): number | null {
  switch (spec.kind) {
    case 'user':
    case 'assistant':
    case 'notification':
      return spec.timestamp;
    default:
      return null;
  }
}

/** Short, human date for the sub-line (e.g. "Mon, Jun 15"). Year is
 *  appended only when the message isn't from the current year, so the
 *  common case stays compact. */
function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

/** Render the timestamp element as a two-line stack: a `.line-ts-time`
 *  span (HH:MM, always shown) above a `.line-ts-date` span (the date,
 *  whose visibility the reconcile walk toggles per day boundary). The
 *  date span is always populated so toggling `.has-date` is a pure CSS
 *  show/hide — no text churn. Keeps the legacy `.line-ts` element + its
 *  title (full date-time on hover) intact for everything that reads it
 *  (mark-unread, smokes). */
function updateTimestamp(el: HTMLElement, timestamp: number): void {
  const tsEl = el.querySelector('.line-ts') as HTMLElement | null;
  if (!tsEl) return;
  const d = new Date(timestamp);
  const timeText = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  const dateText = formatDate(timestamp);

  let timeSpan = tsEl.querySelector('.line-ts-time') as HTMLElement | null;
  let dateSpan = tsEl.querySelector('.line-ts-date') as HTMLElement | null;
  if (!timeSpan || !dateSpan) {
    // First stamp on this element: build the time/date sub-spans. Clear
    // any legacy plain-text content chat.addLine seeded so we don't double
    // up the time.
    tsEl.textContent = '';
    timeSpan = document.createElement('span');
    timeSpan.className = 'line-ts-time';
    dateSpan = document.createElement('span');
    dateSpan.className = 'line-ts-date';
    tsEl.appendChild(timeSpan);
    tsEl.appendChild(dateSpan);
  }
  if (timeSpan.textContent !== timeText) timeSpan.textContent = timeText;
  if (dateSpan.textContent !== dateText) dateSpan.textContent = dateText;

  const title = d.toLocaleString();
  if (tsEl.title !== title) tsEl.title = title;
}

/** Toggle whether the date sub-line shows for this bubble. The reconcile
 *  walk turns it on for every dated row so each bubble carries its short
 *  date under the time. */
function setTimestampDateVisible(el: HTMLElement, visible: boolean): void {
  const tsEl = el.querySelector('.line-ts') as HTMLElement | null;
  if (!tsEl) return;
  tsEl.classList.toggle('has-date', visible);
}

// ── activity row helpers ───────────────────────────────────────────────

const ICON_SPINNER = `<svg class="ar-icon ar-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.55"/></svg>`;
const ICON_CHECK = `<svg class="ar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>`;
const ICON_TOOL = `<svg class="ar-icon ar-icon-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;

function renderActivityRowBody(row: HTMLElement, spec: ActivityRowSpec): void {
  const summary = row.querySelector('.activity-row-summary') as HTMLElement | null;
  const full = row.querySelector('.activity-row-full') as HTMLElement | null;
  if (!summary || !full) return;

  const n = spec.tools.length;
  const totalMs = spec.tools.reduce((acc, t) => acc + (t.durationMs || 0), 0);
  const inProgress = !spec.complete && spec.tools.some(t => t.result === undefined);
  const icon = inProgress ? ICON_SPINNER : ICON_CHECK;
  const tail = inProgress ? 'running…' : fmtDurationMs(totalMs) || 'done';
  summary.innerHTML = `${icon}<span class="ar-summary-label">${escapeHtml(`${n} tool${n === 1 ? '' : 's'}`)} · ${escapeHtml(tail)}</span>`;

  // Reconcile tool entries by callId.
  const existing = new Map<string, HTMLElement>();
  for (const c of Array.from(full.children) as HTMLElement[]) {
    const id = c.dataset.callId;
    if (id) existing.set(id, c);
  }
  const visited = new Set<string>();
  for (let i = 0; i < spec.tools.length; i++) {
    const t = spec.tools[i];
    visited.add(t.callId);
    let entry = existing.get(t.callId);
    if (!entry) {
      entry = renderToolEntry(t);
      full.appendChild(entry);
    } else {
      updateToolEntry(entry, t);
    }
    if (full.children[i] !== entry) full.insertBefore(entry, full.children[i] || null);
  }
  for (const [id, el] of existing) if (!visited.has(id)) el.remove();

  applyActivityRowView(row, spec);
}

function applyActivityRowView(row: HTMLElement, spec: ActivityRowSpec): void {
  const full = row.querySelector('.activity-row-full') as HTMLElement | null;
  const summary = row.querySelector('.activity-row-summary') as HTMLElement | null;
  if (!full || !summary) return;
  const mode = settings.get().agentActivity;
  if (mode === 'off') { row.style.display = 'none'; return; }
  row.style.display = '';
  // Default COLLAPSED, ALWAYS — including while the turn is actively
  // streaming. Only an explicit user toggle (activityExpandByKey,
  // per-key, reset on session switch) expands. Field 2026-08-11
  // (Jonathan, reaffirming a long-standing preference): during a long
  // tool-heavy turn the row used to auto-expand on stream-start and
  // collapse on completion — a distracting self-expanding/collapsing
  // flicker while waiting. The collapsed summary already shows the
  // live tool name + running count, so "agent is working" feedback
  // survives without the churn. (Previously the default was
  // isActivityStreaming(spec); 'full' vs 'summary' still never
  // force-expand historical rows, 'off' still hides.)
  const userChoice = activityExpandByKey.get(spec.key);
  const showFull = userChoice !== undefined ? userChoice : false;
  full.style.display = showFull ? '' : 'none';
  summary.setAttribute('aria-expanded', showFull ? 'true' : 'false');
  row.classList.toggle('is-expanded', showFull);
}

function renderToolEntry(t: ActivityTool): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tool-row';
  wrap.dataset.callId = t.callId;
  const details = document.createElement('details');
  details.className = 'tool-row-details';
  const summary = document.createElement('summary');
  summary.className = 'tool-row-summary';
  summary.innerHTML = `${ICON_TOOL}${toolTitleHtml(t)}<span class="tool-row-meta"></span>`;
  details.appendChild(summary);
  // #229 field fix: the args/result <pre> blocks are the bulk of the render
  // cost and DOM bytes in tool-heavy histories (~88% of history rows are
  // tool rows), yet stay hidden until the user opens this specific row. The
  // collapsed summary (name + detail + duration) is enough to scan the turn;
  // build the body containers EMPTY and hydrate them lazily on first expand.
  const argsBlock = document.createElement('div');
  argsBlock.className = 'tool-args-block';
  details.appendChild(argsBlock);
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-result-block';
  resultEl.style.display = 'none';
  details.appendChild(resultEl);
  wrap.appendChild(details);
  (wrap as any)._tool = t;
  // Duration is part of the collapsed summary line, so set it eagerly.
  updateToolMeta(wrap, t);
  details.addEventListener('toggle', () => {
    if (details.open) hydrateToolBody(wrap);
  });
  return wrap;
}

function updateToolEntry(wrap: HTMLElement, t: ActivityTool): void {
  (wrap as any)._tool = t;
  // Tool name (rarely changes, but tool_result can rename '(unknown)'
  // to a real name when call envelope was missed).
  const titleEl = wrap.querySelector('.tool-title') as HTMLElement | null;
  const nextTitle = toolTitleHtml(t);
  if (titleEl && titleEl.outerHTML !== nextTitle) titleEl.outerHTML = nextTitle;
  updateToolMeta(wrap, t);
  // Only re-render the (expensive) body if this row is currently expanded;
  // a collapsed row re-hydrates fresh the next time it's opened.
  const details = wrap.querySelector('.tool-row-details') as HTMLDetailsElement | null;
  if (details?.open) hydrateToolBody(wrap);
}

/** Set the duration shown in the collapsed tool-row summary. Cheap, so it
 *  always runs eagerly (unlike the body, which is deferred to #229). */
function updateToolMeta(wrap: HTMLElement, t: ActivityTool): void {
  const meta = wrap.querySelector('.tool-row-meta') as HTMLElement | null;
  if (!meta) return;
  const dur = fmtDurationMs(t.durationMs || 0);
  meta.textContent = dur ? ` · ${dur}` : '';
}

/** Build the args + result <pre> body for a tool row on demand (#229).
 *  Called from the details `toggle` handler (open) and from updateToolEntry
 *  for rows that are already open. Reads the latest spec stashed on `_tool`. */
function hydrateToolBody(wrap: HTMLElement): void {
  const t = (wrap as any)._tool as ActivityTool | undefined;
  if (!t) return;
  const argsBlock = wrap.querySelector('.tool-args-block') as HTMLElement | null;
  if (argsBlock) argsBlock.innerHTML = `<pre>${escapeHtml(formatArgs(t.args))}</pre>`;
  writeToolResultBody(wrap, t);
}

function writeToolResultBody(wrap: HTMLElement, t: ActivityTool): void {
  const resultEl = wrap.querySelector('.tool-result-block') as HTMLElement | null;
  if (!resultEl) return;
  if (t.result === undefined) return; // result not in yet — leave hidden
  if (t.result === null) {
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="tool-result-empty">no result</div>`;
    return;
  }
  const raw = typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
  const pretty = prettifyMaybeJson(raw);
  resultEl.style.display = '';
  resultEl.innerHTML = `
    <div class="tool-result-arrow" aria-hidden="true">→</div>
    <pre class="tool-result-text">${escapeHtml(pretty)}</pre>
  `.trim();
}

function formatArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

function toolTitleHtml(t: ActivityTool): string {
  const title = toolDisplayTitle(t);
  const detailHtml = title.detail
    ? `<span class="tool-detail" title="${escapeHtml(title.detail)}">: ${escapeHtml(title.detail)}</span>`
    : '';
  return `<span class="tool-title"><span class="tool-name">${escapeHtml(title.name)}</span>${detailHtml}</span>`;
}

function toolDisplayTitle(t: ActivityTool): { name: string; detail: string } {
  const args = normalizeToolArgs(t.args);
  const result = normalizeToolResult(t.result);
  const rawName = typeof t.name === 'string' ? t.name.trim() : '';
  const lowerName = rawName.toLowerCase();
  const name = rawName && lowerName !== 'tool' && lowerName !== 'undefined' && lowerName !== '(unknown)'
    ? rawName
    : firstStringRaw(result, ['name', 'tool_name', 'skill', 'skill_name']) || inferToolName(args, result);
  return { name, detail: toolSummaryDetail(name, args, result) };
}


function inferToolName(
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): string {
  const raw = firstStringRaw(args, ['type', 'kind']) || firstStringRaw(result, ['type', 'kind']);
  if (raw && raw !== 'function_call_output') return raw;
  if (Array.isArray(result?.matches)) return 'search_files';
  if (Array.isArray(result?.results)) return 'search';
  if (recordValue(result, 'job')) return 'cronjob';
  if (result?.success === true && typeof result?.description === 'string' && typeof result?.content === 'string') return 'skill_view';
  return 'tool';
}

function toolSummaryDetail(
  name: string,
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): string {
  if (name === 'skill_view' || name === 'skill_edit' || name === 'skill_create') {
    return firstString(args, ['name', 'skill', 'skill_name', 'path'])
      || firstString(result, ['name', 'skill', 'skill_name', 'path']);
  }

  if (name === 'gog') {
    return firstString(args, ['description', 'title'])
      || firstString(result, ['description', 'title']);
  }

  if (name === 'cronjob' || recordValue(result, 'job')) {
    return nestedFirstString(result, [
      ['job', 'skill'],
      ['job', 'name'],
      ['skills', 0],
    ]) || firstString(result, ['skill', 'skill_name', 'name', 'title']);
  }

  return firstString(args, [
    'name',
    'path',
    'file',
    'command',
    'query',
    'q',
    'url',
    'title',
  ]) || firstString(result, [
    'description',
    'title',
    'name',
    'path',
    'file',
    'command',
    'query',
    'q',
    'url',
  ]);
}

function normalizeToolArgs(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args !== 'string') return null;
  const trimmed = args.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeToolResult(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  if (typeof result !== 'string') return null;
  const trimmed = result.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string {
  return compactToolDetail(firstStringRaw(obj, keys));
}

function nestedFirstString(obj: Record<string, unknown> | null, paths: Array<Array<string | number>>): string {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path) {
      if (cur && typeof cur === 'object') {
        cur = Array.isArray(cur)
          ? (typeof part === 'number' ? cur[part] : undefined)
          : (cur as Record<string, unknown>)[String(part)];
      } else {
        cur = undefined;
      }
    }
    if (typeof cur === 'string' && cur.trim()) return compactToolDetail(cur.trim());
  }
  return '';
}

function recordValue(obj: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = obj?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstStringRaw(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function compactToolDetail(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

function prettifyMaybeJson(raw: string): string {
  if (!raw || (raw[0] !== '{' && raw[0] !== '[')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as any).result === 'string') {
      const inner = (parsed as any).result.trim();
      if (inner && (inner[0] === '{' || inner[0] === '[')) {
        try { (parsed as any).result = JSON.parse(inner); } catch { /* leave */ }
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ensureThinkingDots(el: HTMLElement): void {
  if (el.querySelector('.thinking-dots')) return;
  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.innerHTML = `<span></span><span></span><span></span>`;
  const text = el.querySelector('.text');
  if (text) text.appendChild(dots);
  else el.appendChild(dots);
}

function getAgentSpeaker(): string {
  try {
    return getAgentLabel() || 'Agent';
  } catch {
    return 'Agent';
  }
}
