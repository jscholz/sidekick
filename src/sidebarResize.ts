/**
 * @fileoverview Drag-to-resize on the sidebar's right edge.
 *
 * Pointer-down on `#sidebar-resizer` enters drag mode; pointermove
 * updates the `--sidebar-width` CSS custom property on `<html>` so the
 * sidebar's `width: var(--sidebar-width)` rule re-flows live. Pointer-
 * up persists the chosen width to localStorage so the next boot
 * restores it. Double-click the handle to reset to the default.
 *
 * Bounds: `[MIN_WIDTH, MAX_WIDTH]`. The chat content shifts via
 * body's `padding-left` (set by main.ts on expand) so resizing
 * doesn't accidentally cover the chat — body padding follows the
 * width inline.
 *
 * No-op on the rail (collapsed sidebar) and on mobile (overlay
 * sidebar — fixed width via CSS media query). Hidden via CSS in
 * those states; this module's listeners still attach but the user
 * can't reach them.
 */

const STORAGE_KEY = 'sidekick.sidebarWidth';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 220;
const MAX_WIDTH = 600;

function readPersisted(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return clamp(n);
  } catch { return null; }
}

function writePersisted(width: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(width)); } catch {}
}

function clamp(w: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
}

function applyWidth(width: number): void {
  const w = clamp(width);
  // Single source of truth — both `#sidebar.expanded` and
  // `body.sidebar-expanded` read this custom property. The body
  // padding-left rule pushes the chat content past the panel
  // automatically when the variable changes.
  document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
}

export function init(): void {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;

  // Hydrate persisted width on boot.
  const persisted = readPersisted();
  if (persisted !== null) applyWidth(persisted);

  let dragging = false;
  let startX = 0;
  let startWidth = DEFAULT_WIDTH;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    applyWidth(startWidth + delta);
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('sidebar-resizing');
    handle.releasePointerCapture?.(e.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    // Persist the final width after the cursor is released. clamp
    // again in case applyWidth saw an out-of-range value transiently.
    const current = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-width'), 10);
    if (Number.isFinite(current)) writePersisted(clamp(current));
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    // Left mouse / touch only. Right-click / middle-click pass through.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const sidebar = document.getElementById('sidebar');
    startWidth = sidebar ? sidebar.getBoundingClientRect().width : DEFAULT_WIDTH;
    handle.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    handle.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // Double-click resets to the default. Useful when the user dragged
  // way too narrow / wide and wants a clean slate.
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    applyWidth(DEFAULT_WIDTH);
    writePersisted(DEFAULT_WIDTH);
  });
}
