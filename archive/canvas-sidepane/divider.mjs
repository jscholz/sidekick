/**
 * @fileoverview Draggable divider between chat and canvas columns.
 */

import * as settings from './settings.mjs';

export function init() {
  const divider = document.getElementById('divider');
  const canvasCol = document.getElementById('canvas-column');
  if (!divider || !canvasCol) return;

  let dragging = false, startX = 0, startWidth = 0;
  const MIN_W = 260, MAX_MARGIN = 320;

  const onMove = (e) => {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const dx = startX - x;
    const maxW = window.innerWidth - MAX_MARGIN;
    const newW = Math.min(Math.max(startWidth + dx, MIN_W), maxW);
    canvasCol.style.width = newW + 'px';
    settings.set('canvasWidth', Math.round(newW));
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    settings.save();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };

  const onDown = (e) => {
    dragging = true;
    divider.classList.add('dragging');
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    startWidth = canvasCol.getBoundingClientRect().width;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    e.preventDefault();
  };

  divider.addEventListener('mousedown', onDown);
  divider.addEventListener('touchstart', onDown, { passive: false });
}
