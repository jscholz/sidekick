/**
 * @fileoverview Inline card attach — the replacement surface for the
 * old side-pane canvas. Agent-emitted cards (via the canvas WS or the
 * fallback text parser) render into an attachments container on the
 * agent bubble that produced them.
 *
 * Per-bubble dedup lives in a WeakMap so the same URL being parsed
 * from a streaming delta + emitted explicitly by the agent doesn't
 * render twice.
 *
 * @typedef {import('../types.js').CanvasCard} CanvasCard
 */

import { validateAndLog } from './validate.ts';
import { getCard } from './registry.ts';
import { log } from '../util/log.ts';

/** @type {WeakMap<HTMLElement, Set<string>>} */
const bubbleHashes = new WeakMap();

function cardHash(card) {
  return `${card.kind}:${JSON.stringify(card.payload)}`;
}

function ensureContainer(bubble) {
  let container = /** @type {HTMLElement|null} */ (bubble.querySelector(':scope > .line-cards'));
  if (!container) {
    container = document.createElement('div');
    container.className = 'line-cards';
    bubble.appendChild(container);
  }
  return container;
}

/**
 * Validate + render a card into the given agent bubble. Dedup is
 * per-bubble — the same card payload won't render twice even if both
 * the fallback parser and the agent's explicit canvas.show fire it.
 *
 * @param {HTMLElement} bubble - The `.line.agent` DOM node.
 * @param {unknown} raw - Card candidate (validated before render).
 * @returns {boolean} true if the card was attached.
 */
export function attachCard(bubble, raw) {
  if (!bubble) return false;
  const card = validateAndLog(raw);
  if (!card) return false;

  let seen = bubbleHashes.get(bubble);
  if (!seen) { seen = new Set(); bubbleHashes.set(bubble, seen); }
  const h = cardHash(card);
  if (seen.has(h)) return false;
  seen.add(h);

  const mod = getCard(card.kind);
  if (!mod) { log('attachCard: unknown kind', card.kind); return false; }

  const container = ensureContainer(bubble);
  const slot = document.createElement('div');
  slot.className = `card-slot card-slot-${card.kind}`;
  container.appendChild(slot);
  try {
    mod.render(card, slot);
  } catch (err) {
    log('card render error:', card.kind, err.message);
    slot.textContent = `Render error: ${err.message}`;
  }
  return true;
}
