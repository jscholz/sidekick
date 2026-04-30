/**
 * @fileoverview Card kind registry. One entry per card type.
 *
 * Each card kind module exports: { kind, icon, label, validate, render }.
 * Register once at startup; look up at render time.
 *
 * @typedef {import('../types.js').CardKindModule} CardKindModule
 */

/** @type {Map<string, CardKindModule>} */
const registry = new Map();

/**
 * Register a card kind module.
 * @param {CardKindModule} mod
 */
export function registerCard(mod) {
  if (!mod.kind) throw new Error('Card module missing "kind"');
  if (registry.has(mod.kind)) {
    console.warn(`Card kind "${mod.kind}" registered twice — overwriting`);
  }
  registry.set(mod.kind, mod);
}

/**
 * Look up a registered card kind.
 * @param {string} kind
 * @returns {CardKindModule|undefined}
 */
export function getCard(kind) {
  return registry.get(kind);
}

/** @returns {string[]} All registered kind names. */
export function registeredKinds() {
  return [...registry.keys()];
}
