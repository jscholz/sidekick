// Hermes model selector: GET/POST /api/hermes/model and the
// openrouter-backed /api/hermes/models-catalog. Preferred-model glob
// state (RAW + GLOBS + rebuild) lives here too because the catalog
// route is the only consumer that uses it for partitioning; server.ts
// imports rebuildPreferredModels + PREFERRED_MODELS_RAW for the
// /api/preferred-models endpoints (live `let` exports — ESM bindings
// stay in sync).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HERMES_CLI } from './config.ts';

const execFileP = promisify(execFile);

// In-memory cache for the openrouter catalog — it's a ~100KB payload that
// rarely changes. Avoid hammering the API on every settings-panel open.
let openrouterCatalogCache: { at: number; entries: any[] } | null = null;
const OPENROUTER_CATALOG_TTL_MS = 10 * 60 * 1000;

/** Invalidate the cached openrouter catalog. Called by the
 *  preferred-models POST handler so the next catalog GET re-partitions
 *  with the new globs. */
export function clearOpenrouterCatalogCache(): void {
  openrouterCatalogCache = null;
}

// Preferred-model filter. Glob list resolved from SIDEKICK_PREFERRED_MODELS
// (comma-sep) or models.preferred in sidekick.config.yaml (YAML list). When
// set, the models-catalog route partitions the openrouter response into
// `preferred` (any glob matches) and `other` (none). UI shows only the
// preferred set when non-empty. Empty = full catalog.
/** Live-mutable so the POST /api/preferred-models handler can refresh
 *  the matcher without a server restart. */
export let PREFERRED_MODELS_RAW: string[] = [];
export let PREFERRED_MODELS_GLOBS: RegExp[] = [];
export function rebuildPreferredModels(globs: string[]): void {
  PREFERRED_MODELS_RAW = globs.filter(Boolean);
  PREFERRED_MODELS_GLOBS = PREFERRED_MODELS_RAW.map((glob) => {
    // Escape regex metachars, then turn `*` into `.*`. Anchored at both ends
    // so "anthropic/*" matches "anthropic/claude-haiku-4.5" but not
    // "fooanthropic/whatever".
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });
}

export function isPreferredModel(id: string): boolean {
  if (PREFERRED_MODELS_GLOBS.length === 0) return false;
  return PREFERRED_MODELS_GLOBS.some((re) => re.test(id));
}

export async function handleHermesModelsCatalog(req, res) {
  // Hermes's own /v1/models only returns the 'hermes-agent' placeholder —
  // the actual inference catalog is whatever the configured provider
  // exposes. We assume OpenRouter here (common hermes setup), so fetch
  // its catalog directly and return it in the ModelEntry shape the
  // settings picker expects. OPENROUTER_API_KEY is read server-side so
  // the client never sees it; catalog listing doesn't strictly require
  // an API key but providing one gets better availability.
  // (Note: server.ts calls reloadConfigIfChanged() before invoking this
  // handler, so the picker sees yaml edits to models.preferred within
  // one settings-panel poll tick without a restart.)
  const now = Date.now();
  const havePrefs = PREFERRED_MODELS_GLOBS.length > 0;
  const sendCatalog = (entries: any[], cached: boolean) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (havePrefs) {
      const preferred = entries.filter((e) => isPreferredModel(e.id));
      const other = entries.filter((e) => !isPreferredModel(e.id));
      res.end(JSON.stringify({ data: entries, preferred, other, cached }));
    } else {
      res.end(JSON.stringify({ data: entries, cached }));
    }
  };
  if (openrouterCatalogCache && now - openrouterCatalogCache.at < OPENROUTER_CATALOG_TTL_MS) {
    sendCatalog(openrouterCatalogCache.entries, true);
    return;
  }
  const key = process.env.OPENROUTER_API_KEY || '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: key ? { 'Authorization': `Bearer ${key}` } : {},
    });
    if (!r.ok) {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `openrouter ${r.status}` }));
      return;
    }
    const d: any = await r.json();
    // Project to the sidekick ModelEntry shape + filter out models we can't
    // actually use (hermes enforces a 64K context minimum at startup).
    // Forward `input`/`output` modality arrays so the composer can gate
    // image-attach buttons (attachments.ts:updateModelGate). OpenRouter
    // exposes these as architecture.input_modalities / output_modalities.
    const entries = (d.data || [])
      .filter((m: any) => (m.context_length || 0) >= 64000)
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        input: m.architecture?.input_modalities,
        output: m.architecture?.output_modalities,
      }));
    entries.sort((a: any, b: any) => a.name.localeCompare(b.name));
    openrouterCatalogCache = { at: now, entries };
    sendCatalog(entries, false);
  } catch (e: any) {
    console.error('openrouter catalog fetch failed:', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function handleHermesModelGet(req, res) {
  try {
    const { stdout } = await execFileP(HERMES_CLI, ['config', 'show'], {
      env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
    });
    // Output has a "◆ Model" section containing a "  Model:        <ref>" line.
    // Match the first such line after the Model section heading.
    const m = stdout.match(/◆ Model[\s\S]*?Model:\s*(\S+)/);
    const model = m ? m[1] : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model }));
  } catch (e: any) {
    console.error('hermes config show failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function handleHermesModelSet(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let payload: any;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end('invalid json'); return; }
    const model = (payload?.model || '').toString().trim();
    // Strict allow-list — value goes into a shelled-out command. Accept only
    // chars that appear in real model refs (vendor/name.variant-size).
    if (!model || model.length > 128 || !/^[a-zA-Z0-9._/\-]+$/.test(model)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid model ref (letters, digits, -, /, ., max 128 chars)' }));
      return;
    }
    try {
      await execFileP(HERMES_CLI, ['config', 'set', 'model', model], {
        env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
      });
      // Restart hermes-gateway so the new model takes effect for subsequent
      // /v1/responses calls. Brief downtime; client reconnects via onStatus.
      await execFileP('systemctl', ['--user', 'restart', 'hermes-gateway']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model }));
    } catch (e: any) {
      console.error('hermes model set failed:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}
