// Barrel re-export for the hermes backend. server.ts pulls handlers +
// helpers from this single entry point so the dispatcher block stays
// short. Implementations live in the sibling files.
export {
  initHermesConfig,
  HERMES_STORE_DB, HERMES_STATE_DB, HERMES_CLI,
  HINDSIGHT_URL, HINDSIGHT_BANK, HINDSIGHT_API_KEY,
  HERMES_SESSION_PREFIX, HERMES_SESSION_SOURCES,
  HERMES_TOKEN, HERMES_UPSTREAM,
} from './config.ts';
export type { HermesConfigInit } from './config.ts';

export { handleHermesSessionsList, handleHermesSessionRename, lookupSessionUuid, lookupAllSessionUuids } from './sessions.ts';
export { handleHermesSearch, searchSessionsImpl, searchMessagesImpl, mergeForkRows } from './search.ts';
export { handleHermesSessionDelete, purgeHindsightSession } from './delete.ts';
export { handleHermesSessionMessages, handleHermesSessionLastResponseId } from './messages.ts';
export {
  handleHermesModelsCatalog, handleHermesModelGet, handleHermesModelSet,
  rebuildPreferredModels, isPreferredModel,
  PREFERRED_MODELS_RAW, PREFERRED_MODELS_GLOBS,
  clearOpenrouterCatalogCache,
} from './models.ts';
export { handleHermesProxy, handleDrawerEvents } from './proxy.ts';
