/**
 * @fileoverview YouTube embed card kind.
 * @typedef {import('../../types.js').YouTubePayload} YouTubePayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { escapeAttr } from '../../util/dom.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'youtube',
  icon: '▶',
  label: 'Video',

  validate(payload) {
    const errors = [];
    if (typeof payload.video_id !== 'string' || !/^[A-Za-z0-9_-]{6,}$/.test(payload.video_id)) {
      errors.push('missing or invalid video_id');
    }
    if (typeof payload.url !== 'string') errors.push('missing url');
    return errors;
  },

  render(card, container) {
    const p = /** @type {YouTubePayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-embed youtube';
    div.innerHTML = `
      <div class="embed-wrap">
        <iframe src="https://www.youtube.com/embed/${escapeAttr(p.video_id)}"
          title="YouTube" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      </div>
      <a class="open-ext" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">open on youtube ↗</a>`;
    container.appendChild(div);
  },
};
