/**
 * @fileoverview Validates CanvasCard payloads against the protocol spec.
 *
 * Validation is the single gate between "something wants to show a card"
 * and "the card actually renders". Invalid cards are dropped and logged.
 *
 * Two layers:
 *   1. Envelope check (v, kind, payload exists).
 *   2. Kind-specific payload check (delegated to the card module's validate()).
 *
 * @typedef {import('../types.js').CanvasCard} CanvasCard
 */

import { getCard } from './registry.ts';
import { log } from '../util/log.ts';

/**
 * Validate a CanvasCard. Returns { ok, errors }.
 * @param {unknown} raw - The candidate card object.
 * @returns {{ ok: boolean, errors: string[], card: CanvasCard|null }}
 */
export function validateCard(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['not an object'], card: null };
  }

  const card = /** @type {CanvasCard} */ (raw);

  // Envelope
  if (card.v !== 1) errors.push(`unsupported version: ${card.v}`);
  if (typeof card.kind !== 'string' || !card.kind) errors.push('missing kind');
  if (!card.payload || typeof card.payload !== 'object') errors.push('missing payload');

  if (errors.length > 0) {
    return { ok: false, errors, card: null };
  }

  // Kind-specific
  const mod = getCard(card.kind);
  if (!mod) {
    errors.push(`unknown kind: "${card.kind}"`);
    return { ok: false, errors, card: null };
  }

  const kindErrors = mod.validate(card.payload);
  if (kindErrors.length > 0) {
    return { ok: false, errors: kindErrors.map(e => `${card.kind}: ${e}`), card: null };
  }

  return { ok: true, errors: [], card };
}

/**
 * Validate + log. Convenience wrapper used by the canvas controller.
 * @param {unknown} raw
 * @returns {CanvasCard|null}
 */
export function validateAndLog(raw) {
  const { ok, errors, card } = validateCard(raw);
  if (!ok) {
    log('card validation failed:', errors.join('; '), JSON.stringify(raw)?.slice(0, 200));
    return null;
  }
  return card;
}
