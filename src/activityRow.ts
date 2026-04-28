/**
 * @fileoverview Tool-activity row renderer (Phase 3).
 *
 * Owns: per-chat "activity row" state inside the transcript, plus the
 * append/freeze/clear lifecycle. Subscribes to nothing — main.ts wires
 * adapter onToolCall / onToolResult callbacks into this module's
 * exported entrypoints.
 *
 * Render modes (settings.agentActivity, read at every event):
 *   off     — drop the event entirely; no DOM.
 *   summary — single one-line row per turn, live-updated.
 *               in progress: `<spinner-icon> N tools · running…`
 *               complete   : `<check-icon> N tools · X.Xs`
 *             Click to expand to the full per-tool breakdown inline.
 *   full    — per-tool collapsed `<details>` block. Tool call shows the
 *             name + args (expand for JSON); the matching tool_result
 *             slots in below the call once it arrives.
 *
 * Turn boundaries: `freezeOnUserMessage(chatId)` runs from the send path
 * to lock the current row in place and clear the per-chat ref so the
 * NEXT tool event creates a fresh row. The activity row stays put after
 * the agent's reply lands so the user can scroll back and review.
 *
 * Cross-chat semantics: events for a non-viewed chat are dropped (the
 * transcript only shows the active chat at a time). Switching to a
 * chat that had a tool event during background time means missing it
 * — acceptable trade-off for v1 over a per-chat detached-DOM cache.
 */

import * as settings from './settings.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import type { ToolCallEvent, ToolResultEvent } from './backends/types.ts';

interface ToolEntry {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsRepr?: string;
  startedAt: string;
  // Populated when the matching tool_result arrives.
  result?: string | null;
  resultTruncated?: boolean;
  durationMs?: number;
  // DOM nodes for incremental updates in 'full' mode. Re-rendered on
  // mode flip — see render().
  fullEl?: HTMLElement;
  resultEl?: HTMLElement;
}

interface ActivityRowState {
  chatId: string;
  /** Top-level container appended into the transcript scroller. */
  rowEl: HTMLElement;
  /** Inline "summary" view — visible in summary mode and as the header
   *  in full mode (clickable to expand). */
  summaryEl: HTMLElement;
  /** Container for per-tool entries (full mode and expanded summary). */
  fullContainerEl: HTMLElement;
  /** Whether the row is currently expanded (matters in summary mode). */
  expanded: boolean;
  /** 'in-progress' = at least one call without a result. 'complete' once
   *  all results land OR a reply_final triggers freezeOnUserMessage / a
   *  user-send freezes it. */
  state: 'in-progress' | 'complete';
  /** Frozen rows ignore further events — a freeze + new event creates
   *  a fresh row. */
  frozen: boolean;
  tools: ToolEntry[];
  /** Quick lookup by callId for tool_result merging. */
  byCallId: Map<string, ToolEntry>;
}

const rows = new Map<string, ActivityRowState>();

const TRANSCRIPT_ID = 'transcript';

function transcript(): HTMLElement | null {
  return document.getElementById(TRANSCRIPT_ID);
}

function isViewedChat(chatId: string): boolean {
  // Mirror the same guard the bubble renderers use — see main.ts'
  // handleReplyDelta etc. Off-view tool events are simply dropped.
  try {
    const viewed = sessionDrawer.getViewed?.();
    return !viewed || viewed === chatId;
  } catch {
    return true;
  }
}

const ICON_SPINNER = `<svg class="ar-icon ar-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.55"/></svg>`;
const ICON_CHECK = `<svg class="ar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>`;
const ICON_TOOL = `<svg class="ar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 1 5 5l-9 9-5 1 1-5z"/></svg>`;

function getOrCreateRow(chatId: string): ActivityRowState | null {
  // Drop events for non-viewed chats — the transcript only shows the
  // active chat. Frozen rows belong to a finished turn; new events get
  // a fresh row.
  if (!isViewedChat(chatId)) return null;
  const existing = rows.get(chatId);
  if (existing && !existing.frozen) return existing;

  const tEl = transcript();
  if (!tEl) return null;

  const rowEl = document.createElement('div');
  rowEl.className = 'activity-row';
  rowEl.dataset.chatId = chatId;
  rowEl.dataset.state = 'in-progress';

  const summaryEl = document.createElement('button');
  summaryEl.type = 'button';
  summaryEl.className = 'activity-row-summary';
  summaryEl.setAttribute('aria-expanded', 'false');

  const fullContainerEl = document.createElement('div');
  fullContainerEl.className = 'activity-row-full';
  fullContainerEl.style.display = 'none';

  rowEl.appendChild(summaryEl);
  rowEl.appendChild(fullContainerEl);
  tEl.appendChild(rowEl);

  const state: ActivityRowState = {
    chatId,
    rowEl,
    summaryEl,
    fullContainerEl,
    expanded: false,
    state: 'in-progress',
    frozen: false,
    tools: [],
    byCallId: new Map(),
  };

  summaryEl.addEventListener('click', () => {
    // In summary mode, the click toggles the full breakdown. In full
    // mode the breakdown is always shown — click is inert (still
    // updates aria-expanded so screen readers see consistent state).
    state.expanded = !state.expanded;
    applyExpansion(state);
  });

  rows.set(chatId, state);
  return state;
}

function applyExpansion(state: ActivityRowState): void {
  const mode = settings.get().agentActivity;
  // In 'full' mode the breakdown is always visible. In 'summary' mode
  // it's visible only when expanded by click. Frozen rows respect the
  // last user-set expansion state.
  const showFull = mode === 'full' || state.expanded;
  state.fullContainerEl.style.display = showFull ? '' : 'none';
  state.summaryEl.setAttribute('aria-expanded', showFull ? 'true' : 'false');
  state.rowEl.classList.toggle('is-expanded', showFull);
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function totalDurationMs(state: ActivityRowState): number {
  return state.tools.reduce((acc, t) => acc + (t.durationMs || 0), 0);
}

function pendingCount(state: ActivityRowState): number {
  return state.tools.reduce((acc, t) => acc + (t.result === undefined ? 1 : 0), 0);
}

function renderSummary(state: ActivityRowState): void {
  const n = state.tools.length;
  const inProgress = state.state === 'in-progress' && pendingCount(state) > 0;
  const icon = inProgress ? ICON_SPINNER : ICON_CHECK;
  const label = `${n} tool${n === 1 ? '' : 's'}`;
  const tail = inProgress
    ? 'running…'
    : fmtDurationMs(totalDurationMs(state)) || 'done';
  state.summaryEl.innerHTML = `${icon}<span class="ar-summary-label">${escapeHtml(label)} · ${escapeHtml(tail)}</span>`;
}

function renderToolEntry(entry: ToolEntry): HTMLElement {
  // <details> handles its own collapse — keeps the JS minimal and
  // gives keyboard users the native disclosure pattern for free.
  const wrap = document.createElement('div');
  wrap.className = 'tool-row';
  wrap.dataset.callId = entry.callId;

  const details = document.createElement('details');
  details.className = 'tool-row-details';

  const summary = document.createElement('summary');
  summary.className = 'tool-row-summary';
  // ICON_TOOL + tool name; duration tail appears once the result lands.
  summary.innerHTML = `${ICON_TOOL}<span class="tool-name">${escapeHtml(entry.toolName)}</span><span class="tool-row-meta"></span>`;

  details.appendChild(summary);

  const argsBlock = document.createElement('div');
  argsBlock.className = 'tool-args-block';
  let argsText: string;
  if (entry.argsRepr) {
    argsText = entry.argsRepr;
  } else {
    try {
      argsText = JSON.stringify(entry.args, null, 2);
    } catch {
      argsText = String(entry.args);
    }
  }
  argsBlock.innerHTML = `<pre>${escapeHtml(argsText)}</pre>`;
  details.appendChild(argsBlock);

  // Result slot — populated lazily once tool_result arrives.
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-result-block';
  resultEl.style.display = 'none';
  details.appendChild(resultEl);

  wrap.appendChild(details);
  entry.fullEl = wrap;
  entry.resultEl = resultEl;
  return wrap;
}

function updateToolEntryResult(entry: ToolEntry): void {
  if (!entry.resultEl || !entry.fullEl) return;
  const meta = entry.fullEl.querySelector('.tool-row-meta') as HTMLElement | null;
  if (meta) {
    const duration = fmtDurationMs(entry.durationMs || 0);
    meta.textContent = duration ? ` · ${duration}` : '';
  }
  if (entry.result === null) {
    entry.resultEl.style.display = '';
    entry.resultEl.innerHTML = `<div class="tool-result-empty">no result</div>`;
    return;
  }
  // Truncate to 500 chars for the inline view; expanded shows the full
  // (already 50KB-capped on the wire) string. Adapter sets truncated
  // when ITS 50KB cap fired; render that as a hint either way.
  const full = entry.result || '';
  const SHOW_LIMIT = 500;
  const isLong = full.length > SHOW_LIMIT;
  const shortText = isLong ? full.slice(0, SHOW_LIMIT) + '…' : full;
  const truncatedHint = entry.resultTruncated
    ? `<span class="tool-result-truncated-hint">(server-truncated)</span>`
    : '';

  entry.resultEl.style.display = '';
  entry.resultEl.innerHTML = `
    <div class="tool-result-arrow" aria-hidden="true">→</div>
    <pre class="tool-result-text" data-mode="short">${escapeHtml(shortText)}</pre>
    ${truncatedHint}
  `.trim();

  if (isLong) {
    const pre = entry.resultEl.querySelector('.tool-result-text') as HTMLElement | null;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'tool-result-more';
    more.textContent = 'show more';
    more.onclick = () => {
      if (!pre) return;
      const expanded = pre.dataset.mode === 'full';
      pre.dataset.mode = expanded ? 'short' : 'full';
      pre.textContent = expanded ? shortText : full;
      more.textContent = expanded ? 'show more' : 'show less';
      // Add copy when expanded; remove when collapsed (keep DOM tidy).
      const existing = entry.resultEl?.querySelector('.tool-result-copy');
      if (!expanded && !existing) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'tool-result-copy';
        copy.textContent = 'copy';
        copy.onclick = () => {
          try { navigator.clipboard?.writeText(full); } catch {}
        };
        entry.resultEl?.appendChild(copy);
      } else if (expanded && existing) {
        existing.remove();
      }
    };
    entry.resultEl.appendChild(more);
  }
}

function renderFullList(state: ActivityRowState): void {
  // Re-render only when the underlying entry list has changed (added a
  // tool) — incremental updates for results happen via updateToolEntryResult.
  // Cheap heuristic: if our DOM has the same count as state.tools, leave
  // it alone; otherwise rebuild. Tools never reorder.
  const existingCount = state.fullContainerEl.children.length;
  if (existingCount === state.tools.length) return;
  state.fullContainerEl.innerHTML = '';
  for (const entry of state.tools) {
    state.fullContainerEl.appendChild(renderToolEntry(entry));
    if (entry.result !== undefined) updateToolEntryResult(entry);
  }
}

function render(state: ActivityRowState): void {
  renderSummary(state);
  renderFullList(state);
  applyExpansion(state);
  state.rowEl.dataset.state = state.state;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Append a tool_call event into the row (creating it if needed). */
export function appendToolCall(chatId: string, evt: ToolCallEvent): void {
  if (settings.get().agentActivity === 'off') return;
  const state = getOrCreateRow(chatId);
  if (!state) return;
  // Defensive: ignore duplicates by callId (a stream replay could
  // re-deliver an envelope a tab already saw).
  if (state.byCallId.has(evt.callId)) return;
  const entry: ToolEntry = {
    callId: evt.callId,
    toolName: evt.toolName,
    args: evt.args || {},
    argsRepr: evt.argsRepr,
    startedAt: evt.startedAt,
  };
  state.tools.push(entry);
  state.byCallId.set(evt.callId, entry);
  state.state = 'in-progress';
  render(state);
}

/** Merge a tool_result event into its matching call. */
export function appendToolResult(chatId: string, evt: ToolResultEvent): void {
  if (settings.get().agentActivity === 'off') return;
  // Don't auto-create a row from a stray result — the matching call
  // should already be on screen. If it isn't (server replayed result
  // after we cleared) we synthesize a placeholder call to keep the UX
  // coherent; spec says "create a new activity row anyway, no special
  // handling" for orphans.
  let state = rows.get(chatId);
  if (!state || state.frozen) state = getOrCreateRow(chatId) || undefined;
  if (!state) return;

  let entry = state.byCallId.get(evt.callId);
  if (!entry) {
    entry = {
      callId: evt.callId,
      toolName: '(unknown)',
      args: {},
      startedAt: '',
    };
    state.tools.push(entry);
    state.byCallId.set(evt.callId, entry);
  }
  entry.result = evt.result;
  entry.resultTruncated = evt.truncated;
  entry.durationMs = evt.durationMs;

  if (pendingCount(state) === 0) state.state = 'complete';

  // Render: ensure the entry exists in DOM, then patch its result block.
  renderFullList(state);
  if (entry.fullEl) updateToolEntryResult(entry);
  renderSummary(state);
  state.rowEl.dataset.state = state.state;
}

/** Freeze the current row so the next event creates a fresh one.
 *  Called from the send path; the row stays in the transcript visually
 *  but no longer receives mutations. */
export function freezeOnUserMessage(chatId: string): void {
  const state = rows.get(chatId);
  if (!state) return;
  state.frozen = true;
  state.state = 'complete';
  // Final render pass so the spinner doesn't sit stuck at "running…"
  // for a row that's now done by definition.
  render(state);
  rows.delete(chatId);
}

/** Drop ALL state for a chat — used on session deletion or hard reset. */
export function clear(chatId: string): void {
  const state = rows.get(chatId);
  if (state) {
    try { state.rowEl.remove(); } catch {}
    rows.delete(chatId);
  }
}

/** Drop every row (used when transcript gets cleared as a whole — e.g.
 *  resume into a different session). */
export function clearAll(): void {
  for (const state of rows.values()) {
    try { state.rowEl.remove(); } catch {}
  }
  rows.clear();
}
