// Hermes backend configuration. Values resolve from env vars + the
// deployment config (sidekick.config.yaml) at server startup; server.ts
// computes them with its own cfgVal/expandHome helpers and calls
// initHermesConfig() once before listening. Exported `let` bindings are
// live across modules — handlers read whatever server.ts wrote.
//
// The init-pattern (rather than computing at this module's load time)
// avoids a circular dependency: server.ts owns the deploy-config state
// (DEPLOY_CFG, deployDoc, reloadConfigIfChanged) and these constants
// would otherwise need to import from server.ts before server.ts has
// finished its top-level evaluation.

export let HERMES_STORE_DB = '';
export let HERMES_STATE_DB = '';
export let HERMES_CLI = '';
export let HINDSIGHT_URL = '';
export let HINDSIGHT_BANK = '';
export let HINDSIGHT_API_KEY = '';
export let HERMES_SESSION_PREFIX = '';
export let HERMES_SESSION_SOURCES: string[] = [];
export let HERMES_TOKEN = '';
export let HERMES_UPSTREAM = '';

export interface HermesConfigInit {
  HERMES_STORE_DB: string;
  HERMES_STATE_DB: string;
  HERMES_CLI: string;
  HINDSIGHT_URL: string;
  HINDSIGHT_BANK: string;
  HINDSIGHT_API_KEY: string;
  HERMES_SESSION_PREFIX: string;
  HERMES_SESSION_SOURCES: string[];
  HERMES_TOKEN: string;
  HERMES_UPSTREAM: string;
}

export function initHermesConfig(c: HermesConfigInit): void {
  HERMES_STORE_DB = c.HERMES_STORE_DB;
  HERMES_STATE_DB = c.HERMES_STATE_DB;
  HERMES_CLI = c.HERMES_CLI;
  HINDSIGHT_URL = c.HINDSIGHT_URL;
  HINDSIGHT_BANK = c.HINDSIGHT_BANK;
  HINDSIGHT_API_KEY = c.HINDSIGHT_API_KEY;
  HERMES_SESSION_PREFIX = c.HERMES_SESSION_PREFIX;
  HERMES_SESSION_SOURCES = c.HERMES_SESSION_SOURCES;
  HERMES_TOKEN = c.HERMES_TOKEN;
  HERMES_UPSTREAM = c.HERMES_UPSTREAM;
}
