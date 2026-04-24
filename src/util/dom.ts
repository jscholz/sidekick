/**
 * @fileoverview Tiny DOM helpers. No framework, no magic.
 */

const ESC = /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/** Shorthand: getElementById with type parameter for less casting noise.
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
export function $(id) {
  return /** @type {T} */ (document.getElementById(id));
}

/** Escape HTML-special characters in a string. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ESC[c]);
}

/** Alias — same thing, used in attribute contexts for readability. */
export const escapeAttr = escapeHtml;

/**
 * Minimal hyperscript: h('div', { class: 'foo' }, 'hello', childEl)
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...(string|Node)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children) {
    if (child == null) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}
