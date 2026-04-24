/**
 * @fileoverview Image card kind.
 * @typedef {import('../../types.js').ImagePayload} ImagePayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { escapeAttr, escapeHtml } from '../../util/dom.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'image',
  icon: '⬚',
  label: 'Image',

  validate(payload) {
    const errors = [];
    if (typeof payload.url !== 'string' || !payload.url) {
      errors.push('missing or invalid url');
    }
    return errors;
  },

  render(card, container) {
    const p = /** @type {ImagePayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-image';
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = p.alt || p.caption || '';
    img.loading = 'lazy';
    div.appendChild(img);
    if (p.caption) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = p.caption;
      div.appendChild(cap);
    }
    container.appendChild(div);
  },
};
