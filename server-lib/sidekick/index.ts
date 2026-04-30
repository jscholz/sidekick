// Sidekick proxy module — server-side half of the sidekick agent
// contract (the OpenAI-Responses-shaped HTTP+SSE talk-to-an-agent
// surface).
//
// Wraps an UpstreamAgent (HTTPAgentUpstream by default) and exposes
// the /api/sidekick/* HTTP routes the PWA + audio-bridge consume.
//
// Usage from server.ts:
//   import * as sidekick from './server-lib/sidekick/index.ts';
//   sidekick.init({ token: SIDEKICK_PLATFORM_TOKEN, url: SIDEKICK_PLATFORM_URL });
//   // route handlers:
//   if (req.method === 'POST' && url === '/api/sidekick/messages')
//     return sidekick.handleSidekickMessage(req, res);
//   if (req.method === 'GET' && url === '/api/sidekick/stream')
//     return sidekick.handleSidekickStream(req, res);
//   if (req.method === 'GET' && url === '/api/sidekick/sessions')
//     return sidekick.handleSidekickSessionsList(req, res);
//   if (req.method === 'DELETE' && url.match(/^\/api\/sidekick\/sessions\/.+/))
//     return sidekick.handleSidekickSessionDelete(req, res, chatId);

import { init as initStream } from './stream.ts';
import { HTTPAgentUpstream, type UpstreamAgent } from './upstream.ts';

export { handleSidekickMessage } from './messages.ts';
export {
  handleSidekickSessionsList,
  handleSidekickSessionDelete,
} from './sessions.ts';
export { handleSidekickSessionMessages } from './history.ts';
export { handleSidekickStream } from './stream.ts';

let upstream: UpstreamAgent | null = null;

/** Wire env-derived config and construct the upstream singleton.
 *  Called once from server.ts at startup. If the token is empty, the
 *  /api/sidekick/* endpoints fail-fast with 503 — there's no point
 *  silently proxying nothing. */
export function init(opts: { token: string; url: string }): void {
  if (!opts.token) {
    console.warn(
      '[sidekick] SIDEKICK_PLATFORM_TOKEN unset — /api/sidekick/* '
      + 'endpoints will return 503 until configured.',
    );
  } else {
    // Tolerate legacy SIDEKICK_PLATFORM_URL values that include the
    // ws://…/ws form (the WS path is gone but old configs may still
    // carry it). Normalize to the HTTP root.
    const httpUrl = opts.url
      .replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
      .replace(/\/ws\/?$/, '');
    upstream = new HTTPAgentUpstream({ url: httpUrl, token: opts.token });
    console.log(`[sidekick] upstream ready (${httpUrl})`);
  }
  // Wire the stream fan-out so the /v1/events subscription is in place
  // BEFORE the first PWA tab attaches — we'd otherwise miss any
  // envelope that arrives during the startup window.
  initStream();
}

/** Returns the upstream singleton, or null if SIDEKICK_PLATFORM_TOKEN
 *  was unset. Handlers gate on this for the configured-vs-not 503. */
export function getUpstream(): UpstreamAgent | null {
  return upstream;
}

/** Status helper — used by health-check tooling. */
export function isReady(): boolean {
  return upstream !== null;
}
