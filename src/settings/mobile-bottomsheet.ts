/**
 * @fileoverview Mobile-only bottom-sheet swipe-to-dismiss gesture.
 *
 * Mobile-only because desktop renders settings as a centered modal with
 * a close button — there's no bottom-sheet shape to drag. The viewport
 * guard lives at the call-site (settings.ts), so the desktop path doesn't
 * even import this module's gesture code.
 *
 * Telegraphs via a `.settings-handle` bar at the top of the sheet. Listens
 * on the handle (not the whole panel) so vertical scrolling inside the
 * settings list isn't competing with the dismiss gesture. Snaps back if
 * the drag is too short; closes with a continuation animation if past
 * threshold.
 */

const DISMISS_THRESHOLD = 80;

/** Wire swipe-to-dismiss onto a bottom-sheet panel.
 *
 *  @param handle - Drag-affordance element (the `.settings-handle` bar).
 *  @param inner  - The sheet content (`.settings-inner`) — the element
 *                  whose translateY tracks the finger.
 *  @param onDismiss - Called once the drag passes threshold and the close
 *                  animation finishes. Caller is responsible for the
 *                  actual panel-hide work (clearing classes, etc.).
 */
export function attachMobileBottomsheetDismiss(
  handle: HTMLElement,
  inner: HTMLElement,
  onDismiss: () => void,
): void {
  let startY = 0;
  let currentY = 0;
  let dragging = false;

  const onTouchStart = (e: TouchEvent) => {
    startY = e.touches[0].clientY;
    currentY = startY;
    dragging = true;
    // Disable transition during the drag so transform tracks the
    // finger directly. Restored on touchend either via inline-clear
    // (snap-back) or by setting a fresh transition for the close
    // animation (continuation).
    inner.style.transition = 'none';
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!dragging) return;
    currentY = e.touches[0].clientY;
    const delta = currentY - startY;
    // Only respond to downward drags. Upward drags do nothing
    // (the sheet is already as far up as it goes).
    if (delta > 0) {
      inner.style.transform = `translateY(${delta}px)`;
    } else {
      inner.style.transform = '';
    }
  };
  const onTouchEnd = () => {
    if (!dragging) return;
    dragging = false;
    const delta = currentY - startY;
    // Threshold: 80px past origin OR a fast flick (we'd need
    // velocity tracking for the latter — keeping it simple for v1).
    if (delta > DISMISS_THRESHOLD) {
      // Continuation animation: from the current dragged position
      // straight to fully offscreen, same easing as the open.
      inner.style.transition = 'transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)';
      inner.style.transform = 'translateY(100%)';
      // Wait for the animation to finish before flipping .on off,
      // otherwise the CSS rule for .on .settings-inner snaps it back
      // to translateY(0) mid-flight.
      const onEnd = () => {
        inner.removeEventListener('transitionend', onEnd);
        // Clear inline styles so next open uses the CSS-driven path.
        inner.style.transition = '';
        inner.style.transform = '';
        onDismiss();
      };
      inner.addEventListener('transitionend', onEnd);
    } else {
      // Snap back to the open position. Restore CSS-driven transition
      // and clear inline transform so the .on rule wins.
      inner.style.transition = '';
      inner.style.transform = '';
    }
  };

  handle.addEventListener('touchstart', onTouchStart, { passive: true });
  handle.addEventListener('touchmove', onTouchMove, { passive: true });
  handle.addEventListener('touchend', onTouchEnd, { passive: true });
  handle.addEventListener('touchcancel', onTouchEnd, { passive: true });
}
