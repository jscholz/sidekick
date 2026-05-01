// Sidekick proxy — agent-settings extension.
//
// Two routes:
//
//   GET  /api/sidekick/settings/schema      → list of SettingDef
//   POST /api/sidekick/settings/{id}        → update one setting
//
// Both forward to the upstream's /v1/settings/* contract documented
// in docs/ABSTRACT_AGENT_PROTOCOL.md "Optional settings extension".
// The proxy is intentionally thin: it doesn't know what settings
// exist, only that the agent declares some. Validation is the
// agent's job.
//
// 404 from the upstream propagates as 404 to the PWA (so opt-out
// agents make the "Agent" settings group disappear).

import { getUpstream } from './index.ts';
import { UpstreamHTTPError } from './upstream.ts';

/** Setting ids appear in the URL path. Restrict to a conservative
 *  alphabet so an id can never escape its slot or carry surprising
 *  characters into the upstream URL. The contract documents this
 *  charset for agents to follow. */
const SETTING_ID_RE = /^[a-z0-9_]{1,64}$/;

/** GET /api/sidekick/settings/schema */
export async function handleSidekickSettingsSchema(_req, res) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  let schema;
  try {
    schema = await upstream.getSettingsSchema();
  } catch (e: any) {
    console.warn('[sidekick] settings schema fetch failed:', e?.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'upstream error' }));
    return;
  }
  if (schema === null) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'agent does not implement /v1/settings/*' },
    }));
    return;
  }
  // No proxy-side filtering — the agent owns the catalog AND the
  // filter (e.g. hermes-plugin reads its `sidekick.preferred_models`
  // config and pre-filters before returning). Sidekick is a thin
  // forward.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: schema }));
}

/** POST /api/sidekick/settings/{id} */
export async function handleSidekickSettingsUpdate(req, res, id: string) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  if (!SETTING_ID_RE.test(id)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'invalid setting id (a-z, 0-9, _; max 64)' },
    }));
    return;
  }
  let body: any;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'body too large' } }));
        return;
      }
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    return;
  }
  try {
    const def = await upstream.updateSetting(id, body?.value);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(def));
  } catch (e: any) {
    if (e instanceof UpstreamHTTPError) {
      // Pass status + body through verbatim so the PWA gets the
      // upstream's validation message intact.
      res.writeHead(e.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(e.body ?? { error: { message: e.message } }));
      return;
    }
    console.warn(`[sidekick] settings update failed for ${id}:`, e?.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e?.message || 'upstream error' } }));
  }
}
