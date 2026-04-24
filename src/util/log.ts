/**
 * @fileoverview Central logger. Writes to both the on-page debug panel
 * (if it exists) and the browser console.
 *
 * Two levels:
 *   log(...)  — always emitted. Use for user-visible state changes and
 *               rare errors.
 *   diag(...) — only emitted when the debug flag is on. Use for
 *               high-frequency diagnostics (mic peaks, lifecycle ticks,
 *               audio route dumps, draft appends).
 *
 * Enable diag:
 *   • URL ?debug=1             (one-off, any page load)
 *   • localStorage.sidekick_debug = '1'  (persistent across sessions)
 */

/** @type {HTMLElement|null} */
let debugEl = null;

const debugOn = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('debug') === '1') return true;
    return localStorage.getItem('sidekick_debug') === '1';
  } catch { return false; }
})();

/** Set the on-page element that receives log lines. */
export function setDebugElement(el) {
  debugEl = el;
}

/** True when diag output is enabled (?debug=1 or localStorage flag). */
export function isDebugEnabled() { return debugOn; }

/** Local-time HH:MM:SS so debug log timestamps match the chat bubble
 *  timestamps (which use .getHours()). Previously used toISOString()
 *  which gave UTC — off by the user's timezone offset, confusing when
 *  correlating log events with UI events. */
function hhmmss(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Log a message. Shows in debug panel + console. */
export function log(...args) {
  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `[${hhmmss()}] ${msg}\n`;
  if (debugEl) {
    debugEl.textContent += line;
    debugEl.scrollTop = debugEl.scrollHeight;
  }
  console.log('[dbg]', ...args);
}

/** High-frequency diagnostic log. No-op unless the debug flag is on. */
export function diag(...args) {
  if (debugOn) log(...args);
}
