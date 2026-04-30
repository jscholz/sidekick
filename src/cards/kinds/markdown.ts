/**
 * @fileoverview Markdown/text card kind.
 * @typedef {import('../../types.js').MarkdownPayload} MarkdownPayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { miniMarkdown } from '../../util/markdown.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'markdown',
  icon: '¶',
  label: 'Notes',

  validate(payload) {
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      return ['missing or empty text'];
    }
    return [];
  },

  render(card, container) {
    const p = /** @type {MarkdownPayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-text';
    div.innerHTML = miniMarkdown(p.text);
    div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    container.appendChild(div);
  },
};
