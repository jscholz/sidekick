/**
 * @fileoverview Bulk-action panel for the sidebar's multi-select mode.
 *
 * When the user shift-clicks 2+ rows in the drawer, the chat surface
 * is hidden and a stats + delete panel takes its place. The panel
 * shows aggregate stats over the selected chats (count, total
 * messages, oldest/newest, source breakdown) and a Delete button
 * that — after a confirm — fires `backend.deleteSession` over each.
 *
 * Wiring: `main.ts` initializes this module with a `getCachedSessions`
 * accessor (so the panel can read row metadata without a network
 * round-trip) and a `deleteOne(id)` callback. `sessionDrawer.ts`
 * pushes selection-change events through the `onMultiSelectChange`
 * hook, and `update(selectedIds)` (re-)renders the panel.
 *
 * Threshold: a single-row selection acts like a normal active-row
 * click — no panel — because the drawer's resume() path is the
 * better UX for that case. The panel mounts only when 2+ rows are
 * selected.
 */

let getSessionsCb: (() => Array<{ id: string; messageCount?: number; lastMessageAt?: number; source?: string }>) | null = null;
let deleteOneCb: ((id: string) => Promise<void> | void) | null = null;
let onClearCb: (() => void) | null = null;

const PANEL_ID = 'multi-select-panel';

export function init(opts: {
  getSessions: () => Array<{ id: string; messageCount?: number; lastMessageAt?: number; source?: string }>;
  deleteOne: (id: string) => Promise<void> | void;
  onClear: () => void;
}): void {
  getSessionsCb = opts.getSessions;
  deleteOneCb = opts.deleteOne;
  onClearCb = opts.onClear;
}

export function update(selectedIds: string[]): void {
  if (selectedIds.length < 2) {
    unmount();
    return;
  }
  mount(selectedIds);
}

function mount(selectedIds: string[]): void {
  let panel = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    // Sit above the chat / composer so it visually replaces them. The
    // chat-area container is `#chat-container` (or similar) on the
    // existing layout; we mount as a sibling that absolute-positions
    // over the same region. Falling back to body keeps the panel
    // visible if the host markup shifts; CSS handles the layout.
    document.body.appendChild(panel);
  }
  const sessions = getSessionsCb?.() ?? [];
  const selected = selectedIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);
  // If some ids couldn't be resolved (rare — drawer cache out of date),
  // fall back to the count of ids the caller gave us so the panel
  // still reflects the user's intent.
  const count = Math.max(selected.length, selectedIds.length);
  const totalMsgs = selected.reduce((a, s) => a + (s.messageCount || 0), 0);
  const oldest = selected.reduce<number | null>(
    (m, s) => (s.lastMessageAt ? (m == null ? s.lastMessageAt : Math.min(m, s.lastMessageAt)) : m),
    null,
  );
  const newest = selected.reduce<number | null>(
    (m, s) => (s.lastMessageAt ? (m == null ? s.lastMessageAt : Math.max(m, s.lastMessageAt)) : m),
    null,
  );
  const sources: Record<string, number> = {};
  for (const s of selected) {
    const src = s.source || 'sidekick';
    sources[src] = (sources[src] || 0) + 1;
  }
  panel.innerHTML = `
    <div class="multi-select-card" role="dialog" aria-label="Selected sessions">
      <div class="ms-title">${escapeHtml(String(count))} sessions selected</div>
      <dl class="ms-stats">
        <dt>Total messages</dt><dd>${totalMsgs}</dd>
        ${oldest != null ? `<dt>Oldest</dt><dd>${fmtTs(oldest)}</dd>` : ''}
        ${newest != null ? `<dt>Newest</dt><dd>${fmtTs(newest)}</dd>` : ''}
        <dt>Sources</dt><dd>${formatSources(sources)}</dd>
      </dl>
      <div class="ms-actions">
        <button id="ms-cancel" class="ms-btn">Cancel</button>
        <button id="ms-delete" class="ms-btn ms-btn-danger">Delete ${count} sessions…</button>
      </div>
    </div>`;
  panel.querySelector('#ms-cancel')?.addEventListener('click', () => onClearCb?.());
  panel.querySelector('#ms-delete')?.addEventListener('click', () => {
    void runBulkDelete(selectedIds);
  });
}

function unmount(): void {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();
}

async function runBulkDelete(ids: string[]): Promise<void> {
  const ok = window.confirm(`Delete ${ids.length} sessions? This can't be undone.`);
  if (!ok) return;
  const fn = deleteOneCb;
  if (!fn) return;
  // Serial delete — keeps server load predictable and gives the
  // drawer an opportunity to refresh between calls so the user
  // sees rows drain rather than disappear in one frame.
  for (const id of ids) {
    try { await fn(id); }
    catch (e: any) { console.warn('[multiSelect] delete failed for', id, e?.message); }
  }
  // Clear the selection + dismiss the panel; main.ts's onClear fires
  // sessionDrawer.clearMultiSelect() which triggers update([]).
  onClearCb?.();
}

function fmtTs(unixSec: number): string {
  // last_active_at on the cached session shape is ISO sometimes,
  // unix-seconds other times depending on which path filled it.
  // Tolerate both: if the value smells like seconds (< 1e12), treat
  // as such; otherwise pass through to Date directly.
  const ms = unixSec < 1e12 ? unixSec * 1000 : unixSec;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function formatSources(sources: Record<string, number>): string {
  const entries = Object.entries(sources).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '—';
  return entries.map(([k, n]) => `${escapeHtml(k)}: ${n}`).join(', ');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
