/**
 * @fileoverview Model catalog + primary-model management via the openclaw
 * gateway. Reads effective model via `sessions.list` (so session overrides
 * are reflected), writes via `/model <ref>` slash command (session-scoped).
 */

import { request, sendChat } from './gateway.ts';
import { log } from './util/log.ts';

/**
 * @typedef {Object} ModelEntry
 * @property {string} provider
 * @property {string} id
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {boolean} [reasoning]
 * @property {string[]} [input]
 */

/** Fetch the allowed model catalog from the gateway. */
export async function listModels() {
  const res = await request('models.list', {});
  const models = Array.isArray(res?.models) ? res.models : [];
  return /** @type {ModelEntry[]} */ (models);
}

/** Get the currently-active model for the main chat session, accounting
 *  for session-level overrides (e.g. set via /model slash command). Falls
 *  back to the config default when the session entry is missing or carries
 *  no info. Returns null if neither is reachable. */
export async function getCurrentModel() {
  // Primary: session row's resolved model
  const res = await request('sessions.list', { agentId: 'main', includeGlobal: false, limit: 20 });
  const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
  const main = sessions.find(s => s.key === 'agent:main:main') || sessions[0];
  if (main) {
    // Prefer explicit override if set, else resolved identity.
    const override = main.modelOverride?.trim();
    if (override) return override;
    if (main.model) {
      // Some rows split provider + model; catalog ids include provider prefix
      // (e.g. "openrouter/google/..."), so the full model string is usually
      // what we want. If the row's model lacks a provider prefix AND a
      // separate provider field is present, compose.
      if (main.model.includes('/')) return main.model;
      if (main.modelProvider) return `${main.modelProvider}/${main.model}`;
      return main.model;
    }
  }
  // Fallback: config default
  const snap = await request('config.get', {});
  return snap?.config?.agents?.defaults?.model?.primary || null;
}

/** Set the session model by sending the /model slash command. This is the
 *  same mechanism the CLI uses — writes to sessionEntry.modelOverride. */
export function setSessionModel(modelRef) {
  if (!modelRef) return false;
  sendChat(`/model ${modelRef}`);
  return true;
}

/** True if the model entry supports image input. */
export function supportsImages(entry) {
  return Array.isArray(entry?.input) && entry.input.includes('image');
}

/** Find a catalog entry by id. */
export function findEntry(catalog, modelRef) {
  if (!catalog || !modelRef) return null;
  return catalog.find(e => e.id === modelRef) || null;
}
