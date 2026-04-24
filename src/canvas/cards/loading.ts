/**
 * @fileoverview Loading/spinner card kind. Shown while async work completes.
 * @typedef {import('../../types.js').LoadingPayload} LoadingPayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'loading',
  icon: '◌',
  label: 'Loading',

  validate(_payload) {
    return []; // everything optional
  },

  render(card, container) {
    const p = /** @type {LoadingPayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-loading';
    div.textContent = p.message || 'loading…';
    container.appendChild(div);
  },
};
