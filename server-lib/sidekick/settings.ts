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
import {
  PREFERRED_MODELS_GLOBS, isPreferredModel,
} from '../preferred-models.ts';

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
  // Apply the sidekick-side preferred-models filter to any enum
  // setting whose id is "model". Source of truth is models.preferred
  // in sidekick.config.yaml (also editable from Settings → Preferred
  // models chip input via /api/preferred-models). The filter is
  // additive on top of whatever the agent already returned — agents
  // can pre-filter; this gives sidekick deployments the final say
  // without round-tripping through agent config.
  if (PREFERRED_MODELS_GLOBS.length > 0) {
    schema = schema.map((def: any) => {
      if (def?.id !== 'model' || def.type !== 'enum') return def;
      const opts = Array.isArray(def.options) ? def.options : [];
      const filtered = opts.filter((o: any) => isPreferredModel(String(o?.value ?? '')));
      // Always include the current value, even if the filter excluded
      // it — otherwise the picker can't display "what's set now."
      const cur = def.value;
      if (cur && !filtered.some((o: any) => o.value === cur)) {
        const passthrough = opts.find((o: any) => o.value === cur);
        if (passthrough) filtered.unshift(passthrough);
        else filtered.unshift({ value: cur, label: String(cur) });
      }
      return { ...def, options: filtered };
    });
  }
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
