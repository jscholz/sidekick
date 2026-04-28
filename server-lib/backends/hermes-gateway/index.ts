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
//   if (req.method === 'GET' && url === '/api/sidekick/stream')
//     return hermesGateway.handleSidekickStream(req, res);
//   if (req.method === 'GET' && url === '/api/sidekick/sessions')
//     return hermesGateway.handleSidekickSessionsList(req, res);
//   if (req.method === 'DELETE' && url.match(/^\/api\/sidekick\/sessions\/.+/))
//     return hermesGateway.handleSidekickSessionDelete(req, res, chatId);

import { client } from './client.ts';
import { init as initStream } from './stream.ts';

export { handleSidekickMessage } from './messages.ts';
export {
  handleSidekickSessionsList,
  handleSidekickSessionDelete,
} from './sessions.ts';
export { handleSidekickSessionMessages } from './history.ts';
export { handleSidekickStream } from './stream.ts';

/** Wire env-derived config and start the persistent WS client.
 *
 *  Called once from server.ts at startup. If the token is empty, the
 *  client logs a warning and the /api/sidekick/* endpoints fail-fast
 *  with 503 — there's no point silently proxying nothing. */
export function init(opts: { token: string; url: string }): void {
  client.init(opts);
  // Wire the stream fan-out alongside the WS client so the wildcard
  // subscription is in place BEFORE the first connect — we'd
  // otherwise miss any envelope that arrives during the initial
  // handshake window.
  initStream();
}

/** Status helper — used by health-check tooling. */
export function isReady(): boolean {
  return client.isConnected();
}
