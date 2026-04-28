// Hermes-gateway backend — proxy-side WS client + /api/sidekick/*
// HTTP endpoints. Talks to the in-process hermes platform adapter
// shipped at hermes-plugin/sidekick_platform.py.
//
// This module is the proxy half of the Phase-2 sidekick platform
// adapter refactor (memo: project_sidekick_platform_adapter_plan.md).
// It coexists with the existing /api/hermes/* /v1/responses path —
// the latter stays untouched until Phase-3 PWA work lands.
//
// Usage from server.ts:
//   import * as hermesGateway from './server-lib/backends/hermes-gateway/index.ts';
//   hermesGateway.init({ token: SIDEKICK_PLATFORM_TOKEN, url: SIDEKICK_PLATFORM_URL });
//   // route handlers:
//   if (req.method === 'POST' && url === '/api/sidekick/messages')
//     return hermesGateway.handleSidekickMessage(req, res);
//   if (req.method === 'GET' && url === '/api/sidekick/sessions')
//     return hermesGateway.handleSidekickSessionsList(req, res);
//   if (req.method === 'DELETE' && url.match(/^\/api\/sidekick\/sessions\/.+/))
//     return hermesGateway.handleSidekickSessionDelete(req, res, chatId);

import { client } from './client.ts';

export { handleSidekickMessage } from './messages.ts';
export {
  handleSidekickSessionsList,
  handleSidekickSessionDelete,
} from './sessions.ts';

/** Wire env-derived config and start the persistent WS client.
 *
 *  Called once from server.ts at startup. If the token is empty, the
 *  client logs a warning and the /api/sidekick/* endpoints fail-fast
 *  with 503 — there's no point silently proxying nothing. */
export function init(opts: { token: string; url: string }): void {
  client.init(opts);
}

/** Status helper — used by health-check tooling. */
export function isReady(): boolean {
  return client.isConnected();
}
