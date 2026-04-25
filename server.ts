#!/usr/bin/env node
/**
 * SideKick server.
 * - GET /              → serves index.html
 * - GET /<path>        → serves static assets
 * - GET /config        → runtime config (gateway token) from env
 * - POST /tts          → Deepgram Aura TTS proxy (audio/mp3)
 * - POST /gen-image    → Gemini image generation
 * - GET  /weather      → Open-Meteo weather proxy
 * - GET  /link-preview → OG metadata for a URL
 * - GET  /spotify-check → Spotify oEmbed validation
 * - WS   /ws/deepgram  → Deepgram STT proxy (audio frames relayed, key stays server-side)
 * - POST /transcribe   → Deepgram pre-recorded STT proxy (audio blob → transcript)
 * - GET  /screenshot   → ?url= → page screenshot via persistent Chromium (fallback for sites with no OG)
 * - GET  /render       → ?url=&mode=text|html → DOM after JS (for the `browser` agent skill)
 */
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import YAML from 'yaml';
import { validators } from './src/canvas/validators.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Deployment config ────────────────────────────────────────────────
// Non-secret tuning lives in sidekick.config.yaml (gitignored). Secrets
// stay in .env. Env vars ALWAYS override the file — convenient for
// Docker/CI where mounting a file is awkward but env injection is easy.
// Missing file is fine; defaults + env vars cover the ground.
//
// SIDEKICK_CONFIG env var can point at a config path outside the repo
// (e.g. a private fork with keys and personal keyterms). Useful so the
// public repo stays generic while deployment config lives privately.
function resolveConfigPath(): string | null {
  if (process.env.SIDEKICK_CONFIG && fsSync.existsSync(process.env.SIDEKICK_CONFIG)) {
    return process.env.SIDEKICK_CONFIG;
  }
  for (const name of ['sidekick.config.yaml', 'config.yaml']) {
    const p = path.join(__dirname, name);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}
const CONFIG_PATH = resolveConfigPath();
/** Parse the deployment config. Preserves comments via YAML.Document for
 *  round-trippable edits (used by the keyterms save path). */
function loadDeployConfigDoc(): YAML.Document.Parsed | null {
  if (!CONFIG_PATH) return null;
  try {
    const raw = fsSync.readFileSync(CONFIG_PATH, 'utf8');
    console.log(`[config] loaded ${path.basename(CONFIG_PATH)}`);
    return YAML.parseDocument(raw);
  } catch (e: any) {
    console.warn(`[config] failed to load ${CONFIG_PATH}: ${e.message}`);
    return null;
  }
}
let deployDoc = loadDeployConfigDoc();
/** Plain-JS view of the config — used for reads. Re-derived when the doc
 *  is mutated (e.g. keyterms save). */
function cfgAsJS(): any {
  return deployDoc ? deployDoc.toJS() : {};
}
let DEPLOY_CFG = cfgAsJS();
/** Last-loaded mtime so reloadConfigIfChanged can skip unchanged files. */
let lastConfigMtime = CONFIG_PATH && fsSync.existsSync(CONFIG_PATH)
  ? fsSync.statSync(CONFIG_PATH).mtimeMs : 0;

/** Cheap hook — stat the config file; if newer than last load, re-parse
 *  + rebuild any derived state (preferred-model globs). Called from
 *  endpoints that get polled by the settings UI (models-catalog on a
 *  30s interval, /config on settings-panel open) so VSCode edits to
 *  sidekick.config.yaml get picked up without a service restart. */
function reloadConfigIfChanged(): boolean {
  if (!CONFIG_PATH || !fsSync.existsSync(CONFIG_PATH)) return false;
  try {
    const m = fsSync.statSync(CONFIG_PATH).mtimeMs;
    if (m <= lastConfigMtime) return false;
    lastConfigMtime = m;
    deployDoc = loadDeployConfigDoc();
    DEPLOY_CFG = cfgAsJS();
    // Re-derive any runtime state that captured config values at startup.
    const cfg = DEPLOY_CFG?.models?.preferred;
    if (Array.isArray(cfg)) {
      rebuildPreferredModels(cfg.map((s: any) => String(s).trim()).filter(Boolean));
    } else {
      rebuildPreferredModels([]);
    }
    console.log('[config] reloaded — preferred globs:', PREFERRED_MODELS_RAW);
    return true;
  } catch (e: any) {
    console.warn('[config] reload failed:', e.message);
    return false;
  }
}
/** Resolve a value by precedence: env var → config file → fallback. */
function cfgVal<T>(envName: string, cfgPath: string, fallback: T): T {
  const env = process.env[envName];
  if (env != null && env !== '') return env as unknown as T;
  const parts = cfgPath.split('.');
  let cur: any = DEPLOY_CFG;
  for (const p of parts) {
    if (cur == null) break;
    cur = cur[p];
  }
  if (cur != null && cur !== '') return cur as T;
  return fallback;
}

const PORT = Number(cfgVal('PORT', 'server.port', 3001));
const HOST = cfgVal('HOST', 'server.host', '127.0.0.1') as string;

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY || '';
if (!DEEPGRAM_KEY) {
  console.warn('DEEPGRAM_API_KEY not set — voice STT/TTS and /transcribe disabled');
}
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;  // optional — /gen-image disabled if missing

const DEFAULT_TTS_MODEL = 'aura-2-thalia-en';
const IMAGE_MODEL = 'gemini-2.5-flash-image';   // "Nano Banana"

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname;
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const full = path.join(__dirname, filePath);
  if (!full.startsWith(__dirname)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
}

async function handleTts(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid json'); return; }
    const text = (payload.text || '').toString().trim();
    const model = (payload.model || DEFAULT_TTS_MODEL).toString();
    if (!text) { res.writeHead(400); res.end('text required'); return; }
    if (text.length > 2000) { res.writeHead(400); res.end('text too long (>2000 chars)'); return; }

    const dgUrl = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`;
    try {
      const dgRes = await fetch(dgUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });
      if (!dgRes.ok) {
        const err = await dgRes.text();
        console.error(`Deepgram TTS error ${dgRes.status}: ${err.slice(0, 200)}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tts_failed', status: dgRes.status, message: err.slice(0, 300) }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      });
      // Stream the body through
      const reader = dgRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      console.error('TTS proxy error:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end('tts proxy error');
    }
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('upstream error'); });
}

async function handleGenImage(req, res) {
  if (!GOOGLE_KEY) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'GOOGLE_API_KEY not set' })); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid json'); return; }
    const prompt = (payload.prompt || '').toString().trim();
    if (!prompt) { res.writeHead(400); res.end('prompt required'); return; }
    if (prompt.length > 1500) { res.writeHead(400); res.end('prompt too long'); return; }

    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${encodeURIComponent(GOOGLE_KEY)}`;
    try {
      const gRes = await fetch(gUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      });
      const data = await gRes.json();
      if (!gRes.ok) {
        console.error(`Gemini image error ${gRes.status}:`, JSON.stringify(data).slice(0, 500));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'gen_failed', status: gRes.status, detail: data?.error?.message || 'unknown' }));
        return;
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData?.data);
      if (!imgPart) {
        const text = parts.find(p => p.text)?.text || '';
        console.error('Gemini image: no inlineData', text.slice(0, 200));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_image_returned', text }));
        return;
      }
      const mime = imgPart.inlineData.mimeType || 'image/png';
      const dataUri = `data:${mime};base64,${imgPart.inlineData.data}`;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ image: dataUri, prompt, mime }));
    } catch (e) {
      console.error('gen-image proxy error:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end('gen proxy error');
    }
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('upstream error'); });
}

// Naive in-process cache for link previews (URL → { at, data })
const linkPreviewCache = new Map();
const LINK_PREVIEW_TTL_MS = 60 * 60 * 1000;

/**
 * SSRF guard — block requests to private / internal hosts. Used on
 * /link-preview and /screenshot since both fetch arbitrary client-supplied
 * URLs from the server, and are exposed to the public internet whenever
 * Tailscale Funnel is active.
 * Returns null if safe, otherwise a string reason.
 */
function ssrfReject(target) {
  let parsed;
  try { parsed = new URL(target); } catch { return 'bad url'; }
  if (!/^https?:$/i.test(parsed.protocol)) return 'non-http protocol';
  const host = parsed.hostname.toLowerCase();
  // Localhost
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return 'loopback';
  // Metadata services (AWS, GCP, Azure)
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return 'cloud metadata';
  // RFC1918 private ranges
  if (/^10\./.test(host)) return 'private 10/8';
  if (/^192\.168\./.test(host)) return 'private 192.168/16';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'private 172.16/12';
  // Link-local + CG-NAT
  if (/^169\.254\./.test(host)) return 'link-local';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'CG-NAT (tailscale range)';
  // IPv6 loopback / ULA / link-local
  if (host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80')) return 'ipv6 private';
  return null;
}

function parseOg(html) {
  const get = (names) => {
    for (const n of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i');
      const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, 'i'));
      if (m) return m[1];
    }
    return null;
  };
  const decodeEntities = (s) => !s ? s : s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x?([0-9a-f]+);/gi,
      (_, c) => String.fromCharCode(parseInt(c, c.length === 1 ? 10 : 16)));
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return {
    title: decodeEntities(get(['og:title', 'twitter:title']) || (titleTag ? titleTag[1] : null)),
    description: decodeEntities(get(['og:description', 'twitter:description', 'description'])),
    image: decodeEntities(get(['og:image', 'twitter:image', 'twitter:image:src'])),
    siteName: decodeEntities(get(['og:site_name', 'application-name'])),
  };
}

async function handleLinkPreview(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); res.end('bad url'); return; }
  const reject = ssrfReject(target);
  if (reject) { res.writeHead(403); res.end(`blocked: ${reject}`); return; }

  // Cache hit
  const cached = linkPreviewCache.get(target);
  if (cached && (Date.now() - cached.at) < LINK_PREVIEW_TTL_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(cached.data));
    return;
  }

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Sidekick/1.0; +https://github.com/jscholz/sidekick)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);
    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) {
      const data = { url: target, title: null, description: null, image: null, siteName: null };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    // Read up to ~256KB of HTML — enough for <head>
    const reader = r.body.getReader();
    const parts = []; let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); total += value.length;
      if (total > 256 * 1024) { try { reader.cancel(); } catch {} break; }
    }
    const html = Buffer.concat(parts).toString('utf-8');
    const og = parseOg(html);
    // Resolve relative image URLs
    if (og.image && !/^https?:\/\//i.test(og.image)) {
      try { og.image = new URL(og.image, r.url || target).toString(); } catch {}
    }
    // Check if the site allows iframe embedding
    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    const frameable = !xfo && !csp.includes('frame-ancestors');
    const data = { url: target, ...og, frameable };
    linkPreviewCache.set(target, { at: Date.now(), data });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(data));
  } catch (e) {
    console.error('link-preview err:', e.message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: target, title: null, description: null, image: null, siteName: null, error: e.message }));
  }
}

// Weather fallback coords. Override via SIDEKICK_WEATHER_LAT / _LON env
// vars. London is a safe fallback — users see a real city's weather
// until they set their own rather than a broken card on Null Island.
const DEFAULT_WEATHER_LAT = parseFloat(String(cfgVal('SIDEKICK_WEATHER_LAT', 'weather.lat', '51.5074')));
const DEFAULT_WEATHER_LON = parseFloat(String(cfgVal('SIDEKICK_WEATHER_LON', 'weather.lon', '-0.1278')));

async function handleWeather(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const lat = parseFloat(url.searchParams.get('lat') || String(DEFAULT_WEATHER_LAT));
  const lon = parseFloat(url.searchParams.get('lon') || String(DEFAULT_WEATHER_LON));
  const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,is_day&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=4`;
  try {
    const r = await fetch(omUrl);
    const data = await r.json();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502); res.end('weather fetch failed');
  }
}

// Spotify oEmbed validation — check if a Spotify URL resolves before embedding.
async function handleSpotifyCheck(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const spotifyUrl = url.searchParams.get('url');
  if (!spotifyUrl || !spotifyUrl.includes('spotify.com')) {
    res.writeHead(400); res.end('bad url'); return;
  }
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify({ ok: true, title: data.title, thumbnail_url: data.thumbnail_url }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: r.status }));
    }
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// ── Chromium screenshot service ────────────────────────────────────────────
// Persistent browser instance — launched once, reused for all screenshots.
// Each request: new tab → navigate → screenshot → close tab.
// Disabled when SIDEKICK_DISABLE_SCREENSHOT=1 (Pi 3 and other low-RAM
// targets that can't afford a Chromium process).
import { chromium } from 'playwright-core';

const SCREENSHOT_DISABLED = !!cfgVal('SIDEKICK_DISABLE_SCREENSHOT', 'server.disable_screenshot', false);

let browser = null;
const screenshotCache = new Map(); // url → { at, buffer }
const SCREENSHOT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('launching persistent Chromium...');
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  console.log('Chromium ready');
  return browser;
}

async function handleScreenshot(req, res) {
  if (SCREENSHOT_DISABLED) {
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('screenshot disabled (SIDEKICK_DISABLE_SCREENSHOT=1)');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400); res.end('bad url'); return;
  }
  const reject = ssrfReject(target);
  if (reject) { res.writeHead(403); res.end(`blocked: ${reject}`); return; }

  // Cache check
  const cached = screenshotCache.get(target);
  if (cached && (Date.now() - cached.at) < SCREENSHOT_CACHE_TTL) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    res.end(cached.buffer);
    return;
  }

  try {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 });
      // Brief wait for lazy-loaded images/fonts
      await page.waitForTimeout(1500);
      const buffer = await page.screenshot({ type: 'png' });
      screenshotCache.set(target, { at: Date.now(), buffer });
      // Prune old cache entries
      if (screenshotCache.size > 50) {
        for (const [k, v] of screenshotCache) {
          if (Date.now() - v.at > SCREENSHOT_CACHE_TTL) screenshotCache.delete(k);
        }
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(buffer);
    } finally {
      await page.close();
    }
  } catch (e) {
    console.error('screenshot error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── DOM-rendered page fetch (for the `browser` agent skill) ────────────────
// Reuses the same persistent Chromium as /screenshot. Useful when a page
// is React/Vue/Angular-rendered and `curl <url>` returns the empty shell.
//
// Wait strategy: page.goto waits for 'load'; we then soft-wait for
// `networkidle` (up to `wait` ms, default 5000, cap 10000) so post-
// hydration fetches settle before we snapshot. Catches the fail-silent
// case where a live-polling page never goes idle.
//
// Query params:
//   url       — required, http(s) only, passes ssrfReject
//   mode      — 'text' (default) | 'html'
//   wait      — max ms to wait for network idle after load (default 5000, cap 10000)
//   maxlen    — cap on output length (default 30_000, cap 2_000_000).
//               Deliberately small so exploration doesn't blow out context.
//               Raise explicitly when you know you need more.
//   selector  — CSS selector; if present, return innerText/outerHTML of
//               just that subtree instead of the whole document. Huge
//               context saver for structured-data extraction.
const renderCache = new Map();
const RENDER_CACHE_TTL_MS = 60 * 60 * 1000;

async function handleRender(req, res) {
  if (SCREENSHOT_DISABLED) {
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('render disabled (SIDEKICK_DISABLE_SCREENSHOT=1)');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400); res.end('bad url'); return;
  }
  const reject = ssrfReject(target);
  if (reject) { res.writeHead(403); res.end(`blocked: ${reject}`); return; }
  const mode = url.searchParams.get('mode') === 'html' ? 'html' : 'text';
  const wait = Math.min(parseInt(url.searchParams.get('wait') || '5000', 10) || 5000, 10000);
  const maxlen = Math.min(parseInt(url.searchParams.get('maxlen') || '30000', 10) || 30000, 2_000_000);
  const selector = url.searchParams.get('selector') || '';

  const cacheKey = `${mode}|${selector}|${target}`;
  const cached = renderCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < RENDER_CACHE_TTL_MS) {
    res.writeHead(200, {
      'Content-Type': mode === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(cached.body.slice(0, maxlen));
    return;
  }

  try {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: 1280, height: 2000 } });
    try {
      await page.goto(target, { waitUntil: 'load', timeout: 15000 });
      // Soft-wait for network idle. If the page keeps polling (live
      // dashboards), we don't want to hang — catch the timeout and
      // snapshot what we have.
      await page.waitForLoadState('networkidle', { timeout: wait }).catch(() => {});
      let body;
      if (selector) {
        // Extract just the requested subtree. Error cleanly if missing.
        body = await page.evaluate(
          ({ sel, asHtml }) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            return asHtml ? el.outerHTML : (el.innerText || '');
          },
          { sel: selector, asHtml: mode === 'html' },
        );
        if (body === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `selector not found: ${selector}` }));
          return;
        }
      } else {
        body = mode === 'html'
          ? await page.content()
          : await page.evaluate(() => document.body?.innerText ?? '');
      }
      renderCache.set(cacheKey, { at: Date.now(), body });
      if (renderCache.size > 50) {
        for (const [k, v] of renderCache) {
          if (Date.now() - v.at > RENDER_CACHE_TTL_MS) renderCache.delete(k);
        }
      }
      const truncated = body.length > maxlen;
      res.writeHead(200, {
        'Content-Type': mode === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...(truncated ? { 'X-Render-Truncated': `${body.length}` } : {}),
      });
      res.end(body.slice(0, maxlen));
    } finally {
      await page.close();
    }
  } catch (e) {
    console.error('render error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Deepgram pre-recorded transcription proxy ─────────────────────────────
async function handleTranscribe(req, res) {
  const contentType = req.headers['content-type'] || 'audio/webm';
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    if (!body.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'empty body' }));
      return;
    }
    try {
      const dgUrl = 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en-US';
      const dgRes = await fetch(dgUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_KEY}`,
          'Content-Type': contentType,
        },
        body,
      });
      if (!dgRes.ok) {
        const err = await dgRes.text();
        console.error(`Deepgram transcribe error ${dgRes.status}: ${err.slice(0, 200)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `deepgram ${dgRes.status}` }));
        return;
      }
      const data = await dgRes.json();
      const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transcript }));
    } catch (e) {
      console.error('transcribe proxy error:', e);
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  req.on('error', () => {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'upstream error' }));
  });
}

// Client config endpoint — serves runtime config from env vars so
// secrets are not hardcoded in the HTML, and so per-deployment tuning
// (keyterms, app name, default coords) can be set without a rebuild.
const GW_TOKEN = process.env.GW_TOKEN || '';
// Default Deepgram key-term hints. Empty-fallback when config lists none
// AND no env override — per-install terms live in sidekick.config.yaml's
// `stt.keyterms:` section (managed via Settings UI) or the
// SIDEKICK_STT_KEYTERMS env var. Defaults are intentionally minimal so
// forks don't inherit vocabulary biases from another project's agent.
const DEFAULT_KEYTERMS: string[] = ['Sidekick', 'Deepgram'];

// Optional env-var override (useful for Docker / CI where a file mount
// is awkward). Additive to whatever's in the config file.
const ENV_KEYTERMS = process.env.SIDEKICK_STT_KEYTERMS
  ? process.env.SIDEKICK_STT_KEYTERMS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

// One-time migration from the legacy keyterms.txt into sidekick.config.yaml.
// If keyterms.txt still exists on disk and the config's stt.keyterms is
// empty, import its contents into the yaml (comments dropped since they
// weren't expressible in the list structure anyway). Leaves the txt file
// in place so the user can delete it after verifying.
const LEGACY_KEYTERMS_PATH = path.join(__dirname, 'keyterms.txt');
function migrateLegacyKeyterms() {
  if (!fsSync.existsSync(LEGACY_KEYTERMS_PATH)) return;
  const current = DEPLOY_CFG?.stt?.keyterms;
  if (Array.isArray(current) && current.length > 0) return;  // already migrated
  let terms: string[] = [];
  try {
    const raw = fsSync.readFileSync(LEGACY_KEYTERMS_PATH, 'utf8');
    terms = raw.split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
  } catch { return; }
  if (!terms.length) return;
  // Target a writable config file — existing one, or create a new
  // sidekick.config.yaml next to server.ts so the user's keyterms
  // survive the txt → yaml transition.
  const target = CONFIG_PATH || path.join(__dirname, 'sidekick.config.yaml');
  try {
    if (!deployDoc) {
      deployDoc = YAML.parseDocument('# sidekick deployment config — see example.config.yaml\nstt:\n  keyterms: []\n');
    }
    deployDoc.setIn(['stt', 'keyterms'], terms);
    fsSync.writeFileSync(target, deployDoc.toString(), 'utf8');
    DEPLOY_CFG = cfgAsJS();
    console.log(`[config] migrated ${terms.length} keyterms from keyterms.txt → ${path.basename(target)} (txt file kept; delete when verified)`);
  } catch (e: any) {
    console.warn(`[config] keyterms migration failed: ${e.message}`);
  }
}
migrateLegacyKeyterms();

/** Current keyterms list from the config file (or defaults if the section
 *  is empty/missing). Read on each request so edits take effect without
 *  service restart. */
function readConfigKeyterms(): string[] {
  const list = DEPLOY_CFG?.stt?.keyterms;
  if (Array.isArray(list) && list.length > 0) {
    return list.map((v: any) => String(v).trim()).filter(Boolean);
  }
  return [];
}

/** Serve the current keyterms as newline-separated text for the chip UI.
 *  When the config's stt.keyterms is empty/missing, seed with
 *  DEFAULT_KEYTERMS so the UI shows the active vocabulary rather than
 *  appearing blank. The first Save overwrites the config file. */
async function handleKeytermsGet(_req, res) {
  const terms = readConfigKeyterms();
  const body = (terms.length ? terms : DEFAULT_KEYTERMS).join('\n') + '\n';
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(body);
}

/** Serve the current preferred-model globs. Newline-separated for the
 *  chip-input UI. Sourced from models.preferred in the yaml, falling
 *  through to the SIDEKICK_PREFERRED_MODELS env var (comma-sep) for
 *  deployments that haven't switched to the yaml yet. */
async function handlePreferredModelsGet(_req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(PREFERRED_MODELS_RAW.join('\n') + (PREFERRED_MODELS_RAW.length ? '\n' : ''));
}

/** Write the request body (newline- or comma-separated globs) to the
 *  yaml's models.preferred list and re-derive the runtime matcher so
 *  the next /api/hermes/models-catalog call partitions correctly
 *  without a server restart. */
async function handlePreferredModelsPost(req, res) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const seen = new Set<string>();
  const globs: string[] = [];
  for (const line of body.split('\n')) {
    const nocomment = line.replace(/#.*$/, '');
    for (const part of nocomment.split(',')) {
      const t = part.trim();
      if (t && !seen.has(t)) { seen.add(t); globs.push(t); }
    }
  }
  try {
    const target = CONFIG_PATH || path.join(__dirname, 'sidekick.config.yaml');
    if (!deployDoc) deployDoc = YAML.parseDocument('models:\n  preferred: []\n');
    deployDoc.setIn(['models', 'preferred'], globs);
    await fs.writeFile(target, deployDoc.toString(), 'utf8');
    DEPLOY_CFG = cfgAsJS();
    // Re-derive the live matcher. PREFERRED_MODELS_RAW/GLOBS are module
    // consts, so swap them via reassignment through let if needed.
    rebuildPreferredModels(globs);
    // Invalidate openrouter catalog cache so the next fetch re-partitions.
    openrouterCatalogCache = null;
    res.writeHead(204); res.end();
  } catch (e: any) {
    console.error('preferred-models write failed:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`write failed: ${e.message}`);
  }
}

/** Write the request body (newline-separated, comments/commas tolerated)
 *  to the config file's stt.keyterms list. Uses the YAML Document model
 *  so comments and formatting elsewhere in the file are preserved on
 *  round-trip. If no config file exists, creates one at the default
 *  location. */
async function handleKeytermsPost(req, res) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  // Parse the same way the UI does on load — newlines OR commas, comments stripped.
  const parsed = new Set<string>();
  const terms: string[] = [];
  for (const line of body.split('\n')) {
    const nocomment = line.replace(/#.*$/, '');
    for (const part of nocomment.split(',')) {
      const t = part.trim();
      if (t && !parsed.has(t.toLowerCase())) { parsed.add(t.toLowerCase()); terms.push(t); }
    }
  }
  try {
    // Pick a path — existing config, or create sidekick.config.yaml next to server.ts
    const target = CONFIG_PATH || path.join(__dirname, 'sidekick.config.yaml');
    if (!deployDoc) {
      deployDoc = YAML.parseDocument('stt:\n  keyterms: []\n');
    }
    deployDoc.setIn(['stt', 'keyterms'], terms);
    await fs.writeFile(target, deployDoc.toString(), 'utf8');
    DEPLOY_CFG = cfgAsJS();
    res.writeHead(204); res.end();
  } catch (e: any) {
    console.error('keyterms write failed:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`write failed: ${e.message}`);
  }
}

function handleConfig(_req, res) {
  // If the config's stt.keyterms has content, it's authoritative — user
  // has edited via UI (or hand-edited the yaml) and may have removed
  // defaults on purpose. Otherwise seed with DEFAULT_KEYTERMS. ENV_KEYTERMS
  // is always additive on top (Docker/CI override).
  const cfgKeyterms = readConfigKeyterms();
  const base = cfgKeyterms.length > 0 ? cfgKeyterms : DEFAULT_KEYTERMS;
  const merged = [...new Set([...base, ...ENV_KEYTERMS])];
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({
    gwToken: GW_TOKEN,
    mapsEmbedKey: process.env.MAPS_EMBED_KEY || '',
    sttKeyterms: merged,
    // Skinning — per-install overrides for app name / agent label / primary
    // theme color. Resolved via sidekick.config.yaml (app.*) then env var
    // then default. See config.example.yaml.
    appName: cfgVal('SIDEKICK_APP_NAME', 'app.name', 'SideKick'),
    appSubtitle: cfgVal('SIDEKICK_APP_SUBTITLE', 'app.subtitle', 'Agent Portal'),
    agentLabel: cfgVal('SIDEKICK_AGENT_LABEL', 'app.agent_label', 'Clawdian'),
    // Any valid CSS color (hex, rgb(), hsl()). Empty = keep stylesheet default.
    themePrimary: cfgVal('SIDEKICK_THEME_PRIMARY', 'app.theme_primary', ''),
    // Which BackendAdapter the client loads. 'hermes' default; other values:
    // 'openclaw', 'zeroclaw', 'openai-compat'. See src/backends/.
    backend: cfgVal('SIDEKICK_BACKEND', 'backend.type', 'hermes'),
    openaiCompatModel: cfgVal('SIDEKICK_OPENAI_COMPAT_MODEL', 'backend.openai_compat.model', ''),
  }));
}

// OpenAI-compatible chat proxy. Only active when SIDEKICK_BACKEND=openai-compat.
// Keeps the upstream URL + API key server-side (off the browser) and streams
// the SSE response through unchanged. Works with OpenAI, Ollama, LMStudio,
// Groq, vLLM, Together — anything that speaks POST /v1/chat/completions.
const OPENAI_COMPAT_URL = cfgVal('SIDEKICK_OPENAI_COMPAT_URL', 'backend.openai_compat.url',
  'http://localhost:11434/v1/chat/completions') as string;  // Ollama default
const OPENAI_COMPAT_KEY = process.env.SIDEKICK_OPENAI_COMPAT_KEY || '';  // secret — env only

async function handleOpenAICompatChat(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (OPENAI_COMPAT_KEY) headers.Authorization = `Bearer ${OPENAI_COMPAT_KEY}`;
  try {
    const upstream = await fetch(OPENAI_COMPAT_URL, { method: 'POST', headers, body });
    res.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    console.error('openai-compat proxy error:', e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream error: ${e.message}`);
  }
}

// ── Hermes API proxy: /api/hermes/* → http://127.0.0.1:8642/v1/* ────────────
// Sideclaw-facing shim for Hermes's OpenAI-compatible API server. Keeps the
// upstream loopback-bound and injects the bearer token server-side so the
// browser never handles it. Pipes responses (including SSE for
// /responses) straight through without buffering — SSE breaks if buffered.
const HERMES_UPSTREAM = cfgVal('SIDEKICK_HERMES_URL', 'backend.hermes.url', 'http://127.0.0.1:8642') as string;
const HERMES_TOKEN = process.env.SIDEKICK_HERMES_TOKEN || '';  // secret — env only

// ─── Hermes session browser (direct sqlite read of response_store.db) ────────
// Hermes chains conversation turns server-side via previous_response_id,
// keyed by a `conversation:` name we send on each /v1/responses POST. The
// response_store.db holds (a) a conversations table mapping name → latest
// response_id, and (b) a responses table whose JSON payload includes the
// full conversation_history. We read both directly — fast, stable, no
// dependency on the auth-gated dashboard API.

const execFileP = promisify(execFile);
const HOME = os.homedir();
/** Expand ~ / $HOME prefixes in config-supplied paths. */
function expandHome(p: string): string {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (p.startsWith('$HOME/')) return path.join(HOME, p.slice(6));
  return p;
}
const HERMES_STORE_DB = expandHome(cfgVal('SIDEKICK_HERMES_STORE_DB', 'backend.hermes.store_db',
  path.join(HOME, '.hermes/response_store.db')) as string);
const HERMES_STATE_DB = expandHome(cfgVal('SIDEKICK_HERMES_STATE_DB', 'backend.hermes.state_db',
  path.join(HOME, '.hermes/state.db')) as string);
const HERMES_CLI = expandHome(cfgVal('SIDEKICK_HERMES_CLI', 'backend.hermes.cli_path',
  path.join(HOME, '.local/bin/hermes')) as string);
// Hindsight long-term memory bank — used to scrub session-derived memories
// when the user deletes a session. Defaults match the local_external setup
// described in ~/.hermes/hindsight/config.json. Empty url disables the purge
// step (e.g. cloud mode where we don't have a direct delete path wired).
const HINDSIGHT_URL = (cfgVal('SIDEKICK_HINDSIGHT_URL', 'backend.hindsight.url',
  'http://127.0.0.1:8765') as string).replace(/\/+$/, '');
const HINDSIGHT_BANK = cfgVal('SIDEKICK_HINDSIGHT_BANK', 'backend.hindsight.bank_id',
  'jonathan') as string;
const HINDSIGHT_API_KEY = (process.env.HINDSIGHT_API_KEY ||
  cfgVal('SIDEKICK_HINDSIGHT_API_KEY', 'backend.hindsight.api_key', '') as string).trim();
// Filter so random test names / non-sidekick conversations don't clutter the UI.
// hermes adapter generates names as 'sidekick-main' or 'sidekick-<timestamp>'.
const HERMES_SESSION_PREFIX = cfgVal('SIDEKICK_HERMES_SESSION_PREFIX',
  'backend.hermes.session_prefix', 'sidekick-') as string;
// Source filter for state.db/sessions — hermes tags each session with where
// it came from ('api_server' = sidekick webchat; 'telegram' = telegram bot;
// 'cli' = terminal sessions). Sidekick drawer shows the channels the user
// actually talks through; 'cli' is excluded by default since those are
// ad-hoc debug sessions.
const HERMES_SESSION_SOURCES: string[] = (() => {
  const env = process.env.SIDEKICK_HERMES_SESSION_SOURCES;
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  const cfg = DEPLOY_CFG?.backend?.hermes?.session_sources;
  if (Array.isArray(cfg)) return cfg.map((s: any) => String(s).trim()).filter(Boolean);
  return ['api_server', 'telegram'];
})();

async function sqlQuery(db: string, sql: string): Promise<any[]> {
  const { stdout } = await execFileP('sqlite3', ['-json', db, sql], {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout);
}

async function handleHermesSessionsList(req, res) {
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));

  // Filter: comma-separated globs matched against any of the fields
  // exposed in the session Info panel (title, conversation name, source,
  // id). Empty filter → show all sessions. Non-empty → union of matches.
  const rawFilter = url.searchParams.get('prefix') || '';
  const globs = rawFilter
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.replace(/[^a-zA-Z0-9_\-*:@.]/g, '').replace(/\*/g, '%'))
    .filter(Boolean);

  let whereClause: string;
  if (globs.length === 0) {
    // Still hide 'tool'-source sessions (never user-facing).
    whereClause = "s.source != 'tool'";
  } else {
    const globClauses: string[] = [];
    for (const g of globs) {
      globClauses.push(`s.title LIKE '${g}'`);
      globClauses.push(`s.source LIKE '${g}'`);
      globClauses.push(`s.id LIKE '${g}'`);
      globClauses.push(`EXISTS (
        SELECT 1 FROM store.responses r
        JOIN store.conversations c ON c.response_id = r.response_id
        WHERE json_extract(r.data, '$.session_id') = s.id
          AND c.name LIKE '${g}'
      )`);
    }
    whereClause = globClauses.join(' OR ');
  }

  // For api_server rows, pick the stable 'sidekick-*' conversation name
  // if one exists (so the hermes adapter can resume). For telegram /
  // whatsapp / cli and for orphan api_server sessions without a
  // conversation name, return s.id directly. We pick whichever
  // conversation name is most recent regardless of whether it matched
  // the filter — the filter decides INCLUSION, not name resolution.
  const sql = `
    ATTACH '${HERMES_STORE_DB.replace(/'/g, "''")}' AS store;
    SELECT
      CASE WHEN s.source = 'api_server'
        THEN COALESCE(
          (SELECT c.name FROM store.responses r
             JOIN store.conversations c ON c.response_id = r.response_id
             WHERE json_extract(r.data, '$.session_id') = s.id
               -- Only accept sidekick/sideclaw conversation names. Hermes
               -- sometimes writes conversation rows keyed by an UPSTREAM
               -- session id (e.g. a whatsapp session's YYYYMMDD_... id)
               -- when the api_server replies on behalf of another source;
               -- using those as the drawer row id causes a collision with
               -- the source session that owns the same id string, and
               -- both rows end up painted .active on match.
               AND (c.name LIKE 'sidekick-%' OR c.name LIKE 'sideclaw-%')
             ORDER BY r.accessed_at DESC LIMIT 1),
          s.id)
        ELSE s.id END AS id,
      s.source,
      s.title,
      s.message_count AS messageCount,
      (SELECT MAX(timestamp) FROM messages m WHERE m.session_id = s.id) AS lastMessageAt,
      (SELECT substr(content, 1, 120) FROM messages m
         WHERE m.session_id = s.id AND m.role IN ('user','assistant') AND m.content IS NOT NULL
         ORDER BY id DESC LIMIT 1) AS snippet
    FROM sessions s
    WHERE (${whereClause})
      -- Always hide subagent/delegate spawns (parent_session_id != NULL) —
      -- agent-internal, never user-facing.
      AND s.parent_session_id IS NULL
    ORDER BY lastMessageAt DESC NULLS LAST
    LIMIT ${limit}
  `;
  try {
    const rows = await sqlQuery(HERMES_STATE_DB, sql);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: rows }));
  } catch (e: any) {
    console.error('hermes sessions list failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/** Map an id used by the drawer to the canonical state.db session UUID.
 *  Sidekick webchat rows come in as conversation names ('sidekick-*') —
 *  we look those up via response_store.db → responses.data.session_id.
 *  Telegram / cli rows come in as the UUID already (they have no
 *  response_store conversations row), so we pass them through after a
 *  sanity check that state.db/sessions has that row. Returns null if
 *  the id doesn't resolve to a known session. */
async function lookupSessionUuid(name: string): Promise<string | null> {
  if (name.startsWith('sidekick-') || name.startsWith('sideclaw-')) {
    const sql = `SELECT json_extract(r.data, '$.session_id') AS uuid
      FROM conversations c
      LEFT JOIN responses r ON r.response_id = c.response_id
      WHERE c.name='${name}'`;
    const rows = await sqlQuery(HERMES_STORE_DB, sql);
    return rows[0]?.uuid || null;
  }
  const rows = await sqlQuery(HERMES_STATE_DB,
    `SELECT id FROM sessions WHERE id='${name}' LIMIT 1`);
  return rows[0]?.id || null;
}

async function handleHermesSessionRename(req, res, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    let payload: any;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end('invalid json'); return; }
    const title = (payload?.title || '').toString().trim();
    if (!title || title.length > 200) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'title required (<=200 chars)' }));
      return;
    }
    try {
      const uuid = await lookupSessionUuid(name);
      if (!uuid) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      // `hermes sessions rename <session_id> <title...>` — CLI takes title
      // as positional args (joined by argparse internally).
      await execFileP(HERMES_CLI, ['sessions', 'rename', uuid, title], {
        env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, title }));
    } catch (e: any) {
      console.error('hermes sessions rename failed:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

/** Scrub all hindsight memories tagged with this session UUID.
 *
 * Two storage shapes need handling:
 *   1. Live retains (hermes hindsight plugin going forward) — the plugin sets
 *      `document_id = self._session_id`, so document.id == session UUID and
 *      the dedicated `DELETE /documents/{document_id}` endpoint cascades to
 *      the document, all extracted memory units, and their links.
 *   2. Backfilled docs (one document per historical message) — document.id is
 *      a random UUID; the session UUID lives only in `document_metadata.session_id`.
 *      The list-documents endpoint can't filter by metadata, so we paginate
 *      through all docs in the bank and delete those whose metadata matches.
 *
 * Best-effort: any failure is logged but does NOT fail the overall session
 * delete (sqlite cleanup is the primary guarantee — a stranded hindsight row
 * is a privacy bug, but a failed sqlite delete is a UI/state corruption bug).
 */
async function purgeHindsightSession(sessionUuid: string): Promise<{ docs: number; units: number; errors: number }> {
  if (!HINDSIGHT_URL) return { docs: 0, units: 0, errors: 0 };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (HINDSIGHT_API_KEY) headers['authorization'] = `Bearer ${HINDSIGHT_API_KEY}`;
  const bank = encodeURIComponent(HINDSIGHT_BANK);
  let docs = 0, units = 0, errors = 0;

  // (1) Direct delete by document_id == session UUID. 404 = no such doc
  // (live retain never happened or already gone), which is fine.
  try {
    const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bank}/documents/${encodeURIComponent(sessionUuid)}`,
      { method: 'DELETE', headers });
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      docs++;
      units += j.memory_units_deleted ?? 0;
    } else if (r.status !== 404) {
      console.warn(`[hindsight purge] direct delete returned ${r.status} for ${sessionUuid}`);
      errors++;
    }
  } catch (e: any) {
    console.warn(`[hindsight purge] direct delete failed for ${sessionUuid}:`, e.message);
    errors++;
    // If hindsight is unreachable, skip the metadata sweep — same root cause.
    return { docs, units, errors };
  }

  // (2) Metadata sweep: pull all documents and match on document_metadata.session_id.
  // Bank size is small (~tens of docs per active user), so a paginated full-list
  // scan is fine. If banks grow large, an indexed metadata-filter endpoint would
  // be the right server-side answer.
  const PAGE_SIZE = 200;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let items: any[] = [];
    try {
      const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bank}/documents?limit=${PAGE_SIZE}&offset=${offset}`,
        { headers });
      if (!r.ok) {
        console.warn(`[hindsight purge] list returned ${r.status} at offset ${offset}`);
        errors++;
        break;
      }
      const j: any = await r.json();
      items = Array.isArray(j.items) ? j.items : [];
    } catch (e: any) {
      console.warn(`[hindsight purge] list failed at offset ${offset}:`, e.message);
      errors++;
      break;
    }
    if (items.length === 0) break;
    for (const doc of items) {
      const docSid = doc?.document_metadata?.session_id;
      if (docSid !== sessionUuid) continue;
      // Skip if we already nuked it by id in step (1) — same id won't list anymore,
      // but be defensive against races.
      if (doc.id === sessionUuid) continue;
      try {
        const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bank}/documents/${encodeURIComponent(doc.id)}`,
          { method: 'DELETE', headers });
        if (r.ok) {
          const j: any = await r.json().catch(() => ({}));
          docs++;
          units += j.memory_units_deleted ?? 0;
        } else if (r.status !== 404) {
          console.warn(`[hindsight purge] delete ${doc.id} returned ${r.status}`);
          errors++;
        }
      } catch (e: any) {
        console.warn(`[hindsight purge] delete ${doc.id} failed:`, e.message);
        errors++;
      }
    }
    if (items.length < PAGE_SIZE) break;
  }
  return { docs, units, errors };
}

async function handleHermesSessionDelete(req, res, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  try {
    const uuid = await lookupSessionUuid(name);
    if (!uuid) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    // Step 1: hermes CLI removes the row from state.db/sessions + cascades
    // to its messages table. --yes skips the confirmation prompt.
    await execFileP(HERMES_CLI, ['sessions', 'delete', '--yes', uuid], {
      env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
    });
    // Step 2: hermes's CLI does NOT clean up response_store.db — conversation
    // name + response chain stay orphaned. Our list reads from conversations,
    // so without this cleanup the "deleted" row would still appear in the UI.
    // Remove the conversation entry + any response rows it referenced.
    // Strict name regex above protects against SQL injection here.
    await execFileP('sqlite3', [HERMES_STORE_DB,
      `DELETE FROM responses WHERE response_id IN (SELECT response_id FROM conversations WHERE name='${name}');`,
      `DELETE FROM conversations WHERE name='${name}';`,
    ]);
    // Step 3: scrub long-term memories the agent retained from this session.
    // Hindsight runs as a separate service and can be unreachable; treat as
    // best-effort so we don't strand the sqlite delete on a memory-service blip.
    const purged = await purgeHindsightSession(uuid);
    if (purged.docs > 0 || purged.errors > 0) {
      console.log(`[hermes delete] hindsight purge for ${uuid}: ${purged.docs} docs, ${purged.units} memory units, ${purged.errors} errors`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hindsightDocs: purged.docs, hindsightUnits: purged.units }));
  } catch (e: any) {
    console.error('hermes sessions delete failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── Hermes model selector (shells out to `hermes config`) ─────────────────
// POST /api/hermes/model triggers a `hermes config set model <ref>` followed
// by `systemctl --user restart hermes-gateway`. The gateway restart is brief
// (~1-2s) but does drop any in-flight SSE; the sidekick shell picks the
// connection back up via the existing health-check / onStatus flow in
// hermesAdapter.connect/reconnect. GET uses `hermes config show` (there is
// no `hermes config get` subcommand — config show is the supported read path).
// In-memory cache for the openrouter catalog — it's a ~100KB payload that
// rarely changes. Avoid hammering the API on every settings-panel open.
let openrouterCatalogCache: { at: number; entries: any[] } | null = null;
const OPENROUTER_CATALOG_TTL_MS = 10 * 60 * 1000;

// Preferred-model filter. Glob list resolved from SIDEKICK_PREFERRED_MODELS
// (comma-sep) or models.preferred in sidekick.config.yaml (YAML list). When
// set, the models-catalog route partitions the openrouter response into
// `preferred` (any glob matches) and `other` (none). UI shows only the
// preferred set when non-empty. Empty = full catalog.
/** Live-mutable so the POST /api/preferred-models handler can refresh
 *  the matcher without a server restart. */
let PREFERRED_MODELS_RAW: string[] = [];
let PREFERRED_MODELS_GLOBS: RegExp[] = [];
function rebuildPreferredModels(globs: string[]): void {
  PREFERRED_MODELS_RAW = globs.filter(Boolean);
  PREFERRED_MODELS_GLOBS = PREFERRED_MODELS_RAW.map((glob) => {
    // Escape regex metachars, then turn `*` into `.*`. Anchored at both ends
    // so "anthropic/*" matches "anthropic/claude-haiku-4.5" but not
    // "fooanthropic/whatever".
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });
}
rebuildPreferredModels((() => {
  const env = process.env.SIDEKICK_PREFERRED_MODELS;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const cfg = DEPLOY_CFG?.models?.preferred;
  if (Array.isArray(cfg)) return cfg.map((s: any) => String(s).trim()).filter(Boolean);
  return [];
})());

function isPreferredModel(id: string): boolean {
  if (PREFERRED_MODELS_GLOBS.length === 0) return false;
  return PREFERRED_MODELS_GLOBS.some((re) => re.test(id));
}

async function handleHermesModelsCatalog(req, res) {
  // Hermes's own /v1/models only returns the 'hermes-agent' placeholder —
  // the actual inference catalog is whatever the configured provider
  // exposes. We assume OpenRouter here (common hermes setup), so fetch
  // its catalog directly and return it in the ModelEntry shape the
  // settings picker expects. OPENROUTER_API_KEY is read server-side so
  // the client never sees it; catalog listing doesn't strictly require
  // Pick up any edits to models.preferred in sidekick.config.yaml since
  // last load (VSCode save, manual edit, etc.). mtime-gated so cost is a
  // stat syscall when nothing changed. The settings UI polls this
  // endpoint every 30s, so yaml edits land in the picker within one
  // poll tick without a service restart.
  reloadConfigIfChanged();

  // an API key but providing one gets better availability.
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
    const entries = (d.data || [])
      .filter((m: any) => (m.context_length || 0) >= 64000)
      .map((m: any) => ({ id: m.id, name: m.name || m.id }));
    entries.sort((a: any, b: any) => a.name.localeCompare(b.name));
    openrouterCatalogCache = { at: now, entries };
    sendCatalog(entries, false);
  } catch (e: any) {
    console.error('openrouter catalog fetch failed:', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleHermesModelGet(req, res) {
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

async function handleHermesModelSet(req, res) {
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

async function handleHermesSessionMessages(req, res, name: string) {
  // id is either a sidekick conversation name ('sidekick-*') we need to
  // resolve to a session UUID, or a state.db session UUID we can query
  // directly (telegram / cli / any other channel where hermes creates
  // sessions without a response_store.db conversations row).
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
  // Pagination cursor: fetch messages with id < before. Omitted = newest page.
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
  // AUTHORITATIVE read path: state.db/messages keyed by the session UUID.
  // Earlier implementation read from responses.data.conversation_history
  // but that payload compounds across turns (each response embeds its
  // full input-context, which includes prior turns' contexts, growing
  // recursively). state.db/messages is the per-turn log hermes updates
  // exactly once per user/assistant entry.
  try {
    let uuid: string | null = null;
    if (name.startsWith('sidekick-') || name.startsWith('sideclaw-')) {
      const uuidSql = `SELECT json_extract(r.data, '$.session_id') AS uuid
        FROM conversations c LEFT JOIN responses r ON r.response_id = c.response_id
        WHERE c.name='${name}'`;
      const uuidRows = await sqlQuery(HERMES_STORE_DB, uuidSql);
      uuid = uuidRows[0]?.uuid || null;
    } else {
      uuid = name;
    }
    if (!uuid) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(uuid) || uuid.length > 128) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'derived session_id failed validation' }));
      return;
    }
    // Newest-first page, reversed client-visibly below. SQLite's `id` is
    // autoincrement so lower = older. hasMore is a peek of 1 extra row.
    const whereCursor = before !== null ? `AND id < ${before}` : '';
    const msgSql = `SELECT id, role, content, tool_name, timestamp FROM messages
      WHERE session_id='${uuid}' ${whereCursor}
      ORDER BY id DESC LIMIT ${limit + 1}`;
    const rows = await sqlQuery(HERMES_STATE_DB, msgSql);
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    // Reverse to chronological (oldest → newest).
    trimmed.reverse();
    const messages = trimmed.map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content || '',
      timestamp: m.timestamp,
      toolName: m.tool_name || undefined,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages,
      firstId: messages.length ? messages[0].id : null,
      hasMore,
    }));
  } catch (e: any) {
    console.error('hermes session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/** Returns the latest response_id for a session, used by the hermes
 *  adapter to chain follow-up turns via `previous_response_id` when the
 *  session has no sidekick-prefixed conversation row (orphan-resume
 *  case — telegram/whatsapp/cli sessions, or api_server replies on
 *  behalf of another adapter). Without this, `conversation: <UUID>`
 *  misses `response_store.conversations` and api_server creates a fresh
 *  session for every turn. */
async function handleHermesSessionLastResponseId(req, res, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  try {
    const uuid = await lookupSessionUuid(name);
    if (!uuid) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    const rows = await sqlQuery(HERMES_STORE_DB,
      `SELECT response_id FROM responses
       WHERE json_extract(data, '$.session_id')='${uuid}'
       ORDER BY accessed_at DESC LIMIT 1`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ responseId: rows[0]?.response_id || null }));
  } catch (e: any) {
    console.error('hermes session last-response-id failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function handleHermesProxy(req, res) {
  // Map /api/hermes/<path> → /v1/<path> upstream.
  const suffix = req.url.replace(/^\/api\/hermes/, '') || '/';
  const upstreamPath = `/v1${suffix}`;
  const upstream = new URL(upstreamPath, HERMES_UPSTREAM);

  const headers = {};
  // Forward content headers + accept. Strip cookies/host — the upstream
  // only cares about method + body + our injected auth.
  for (const h of ['content-type', 'content-length', 'accept']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  if (HERMES_TOKEN) headers['authorization'] = `Bearer ${HERMES_TOKEN}`;

  const lib = upstream.protocol === 'https:' ? https : http;
  const upReq = lib.request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers,
  }, (upRes) => {
    // Strip hop-by-hop headers; keep SSE-critical ones.
    const out = { ...upRes.headers };
    delete out.connection;
    delete out['transfer-encoding'];
    // Preserve content-type (text/event-stream for /responses with stream=true).
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
  });

  upReq.on('error', (e) => {
    console.error('hermes proxy: upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
    } else {
      res.end();
    }
  });

  // Forward client body (POST) or just end (GET).
  if (req.method === 'POST' || req.method === 'PUT') req.pipe(upReq);
  else upReq.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  // Hermes session-browser routes (handled locally via sqlite; must match
  // before the generic /api/hermes pass-through proxy below).
  if (req.url) {
    const msgMatch = req.method === 'GET' && req.url.match(/^\/api\/hermes\/sessions\/([^/?]+)\/messages(?:\?.*)?$/);
    if (msgMatch) return handleHermesSessionMessages(req, res, decodeURIComponent(msgMatch[1]));
    const lastRespMatch = req.method === 'GET' && req.url.match(/^\/api\/hermes\/sessions\/([^/?]+)\/last-response-id(?:\?.*)?$/);
    if (lastRespMatch) return handleHermesSessionLastResponseId(req, res, decodeURIComponent(lastRespMatch[1]));
    const renameMatch = req.method === 'POST' && req.url.match(/^\/api\/hermes\/sessions\/([^/?]+)\/rename(?:\?.*)?$/);
    if (renameMatch) return handleHermesSessionRename(req, res, decodeURIComponent(renameMatch[1]));
    const deleteMatch = req.method === 'DELETE' && req.url.match(/^\/api\/hermes\/sessions\/([^/?]+)(?:\?.*)?$/);
    if (deleteMatch) return handleHermesSessionDelete(req, res, decodeURIComponent(deleteMatch[1]));
    if (req.method === 'GET' && /^\/api\/hermes\/sessions(?:\?.*)?$/.test(req.url)) return handleHermesSessionsList(req, res);
    if (req.method === 'GET' && /^\/api\/hermes\/models-catalog(?:\?.*)?$/.test(req.url)) return handleHermesModelsCatalog(req, res);
    if (req.method === 'GET' && /^\/api\/hermes\/model(?:\?.*)?$/.test(req.url)) return handleHermesModelGet(req, res);
    if (req.method === 'POST' && /^\/api\/hermes\/model(?:\?.*)?$/.test(req.url)) return handleHermesModelSet(req, res);
  }
  if (req.url && req.url.startsWith('/api/hermes')) return handleHermesProxy(req, res);
  if (req.method === 'GET' && req.url === '/config') return handleConfig(req, res);
  if (req.method === 'GET' && req.url === '/api/keyterms') return handleKeytermsGet(req, res);
  if (req.method === 'POST' && req.url === '/api/keyterms') return handleKeytermsPost(req, res);
  if (req.method === 'GET' && req.url === '/api/preferred-models') return handlePreferredModelsGet(req, res);
  if (req.method === 'POST' && req.url === '/api/preferred-models') return handlePreferredModelsPost(req, res);
  if (req.method === 'POST' && req.url === '/api/chat') return handleOpenAICompatChat(req, res);
  if (req.method === 'POST' && req.url.startsWith('/tts')) return handleTts(req, res);
  if (req.method === 'POST' && req.url.startsWith('/gen-image')) return handleGenImage(req, res);
  if (req.method === 'POST' && req.url === '/canvas/show') return handleCanvasShow(req, res);
  if (req.method === 'POST' && req.url === '/transcribe') return handleTranscribe(req, res);
  if (req.method === 'GET' && req.url.startsWith('/weather')) return handleWeather(req, res);
  if (req.method === 'GET' && req.url.startsWith('/link-preview')) return handleLinkPreview(req, res);
  if (req.method === 'GET' && req.url.startsWith('/spotify-check')) return handleSpotifyCheck(req, res);
  if (req.method === 'GET' && req.url.startsWith('/screenshot')) return handleScreenshot(req, res);
  if (req.method === 'GET' && req.url.startsWith('/render')) return handleRender(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

// ── WebSocket proxy: /ws/deepgram ──────────────────────────────────────────
// Client sends audio frames here. We open a Deepgram WS with the API key
// server-side, relay audio frames → Deepgram, relay results → client.
// The client never sees the Deepgram key.

const dgWss = new WebSocketServer({ noServer: true });
const canvasWss = new WebSocketServer({ noServer: true });
const zcWss = new WebSocketServer({ noServer: true });

// ── ZeroClaw gateway proxy config ──────────────────────────────────────────
// The zeroclaw gateway is bound to loopback on the Pi. This server proxies
// browser WS connections on /ws/zeroclaw to the upstream gateway, so the
// gateway stays unexposed and the browser only speaks to the same origin.
const ZC_UPSTREAM = cfgVal('SIDEKICK_ZEROCLAW_WS', 'backend.zeroclaw.ws_url',
  'ws://127.0.0.1:42617/ws/chat') as string;
const ZC_TOKEN = process.env.SIDEKICK_ZEROCLAW_TOKEN || '';  // secret — env only

// ── Canvas broadcast: POST /canvas/show → all connected /ws/canvas clients ──
// The canvas CLI tool POSTs a CanvasCard JSON here. We validate the envelope
// and broadcast to all connected browser clients.
const canvasClients = new Set<WebSocket>();

canvasWss.on('connection', (ws) => {
  canvasClients.add(ws);
  console.log(`canvas ws: client connected (${canvasClients.size} total)`);
  ws.on('close', () => { canvasClients.delete(ws); });
  ws.on('error', () => { canvasClients.delete(ws); });
});

function broadcastCanvas(card) {
  const msg = JSON.stringify(card);
  for (const ws of canvasClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

async function handleCanvasShow(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => {
    let card;
    try { card = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, errors: ['invalid JSON'] }));
      return;
    }

    // Envelope validation (v, kind, payload)
    const errors = [];
    if (card.v !== 1) errors.push(`unsupported version: ${card.v}`);
    if (typeof card.kind !== 'string' || !card.kind) errors.push('missing kind');
    if (!card.payload || typeof card.payload !== 'object') errors.push('missing payload');

    // Per-kind payload validation (so the agent sees specific field errors)
    if (errors.length === 0 && validators[card.kind]) {
      errors.push(...validators[card.kind](card.payload));
    }

    if (errors.length > 0) {
      console.error('canvas.show validation failed:', errors.join('; '));
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, errors }));
      return;
    }

    // Ensure meta.source is set
    if (!card.meta) card.meta = {};
    if (!card.meta.source) card.meta.source = 'agent';

    broadcastCanvas(card);
    console.log(`canvas.show: broadcast ${card.kind} to ${canvasClients.size} client(s)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kind: card.kind, clients: canvasClients.size }));
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws/canvas') {
    canvasWss.handleUpgrade(req, socket, head, (ws) => canvasWss.emit('connection', ws, req));
    return;
  }

  if (url.pathname.startsWith('/ws/deepgram')) {
    dgWss.handleUpgrade(req, socket, head, (clientWs) => {
    // Read DG params from query string (client specifies model, rate, etc.)
    const params = new URLSearchParams(url.search);
    const sampleRate = params.get('sample_rate') || '48000';
    const keyterms = params.get('keyterms') || '';

    const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true&diarize=true&filler_words=false&endpointing=300&encoding=linear16&sample_rate=${sampleRate}&channels=1&interim_results=true&utterance_end_ms=1500${keyterms ? '&' + keyterms : ''}`;

    console.log(`DG proxy: opening upstream (rate=${sampleRate})`);
    const dgWs = new WebSocket(dgUrl, ['token', DEEPGRAM_KEY]);
    dgWs.binaryType = 'arraybuffer';

    let upstreamOpen = false;

    dgWs.on('open', () => {
      upstreamOpen = true;
      console.log('DG proxy: upstream open');
    });

    // Client → Deepgram: relay audio frames
    let clientFrames = 0;
    clientWs.on('message', (data, isBinary) => {
      if (upstreamOpen && dgWs.readyState === WebSocket.OPEN) {
        clientFrames++;
        if (clientFrames <= 3 || clientFrames === 10 || clientFrames === 50) {
          console.log(`DG proxy: client frame #${clientFrames} bytes=${data.length || data.byteLength} binary=${isBinary}`);
        }
        dgWs.send(data);
      }
    });

    // Deepgram → Client: relay transcription results
    dgWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        // Deepgram sends JSON text; forward as-is
        clientWs.send(typeof data === 'string' ? data : data.toString());
      }
    });

    // Clean up on either side closing
    clientWs.on('close', () => {
      console.log('DG proxy: client disconnected');
      if (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING) {
        dgWs.close();
      }
    });

    dgWs.on('close', (code, reason) => {
      console.log(`DG proxy: upstream closed (${code} ${reason || ''})`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    });

    dgWs.on('error', (e) => {
      console.error('DG proxy: upstream error:', e.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, 'upstream error');
      }
    });

    clientWs.on('error', () => {
      if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
    });
    });
    return;
  }

  if (url.pathname === '/ws/zeroclaw') {
    // Forward an optional session id so the browser can resume across page
    // reloads by passing ?session_id=... on its own WS url.
    const params = new URLSearchParams(url.search);
    const sessionId = params.get('session_id') || '';
    const sessionName = params.get('name') || '';
    const upstreamQs = [
      sessionId && `session_id=${encodeURIComponent(sessionId)}`,
      sessionName && `name=${encodeURIComponent(sessionName)}`,
      ZC_TOKEN && `token=${encodeURIComponent(ZC_TOKEN)}`,
    ].filter(Boolean).join('&');
    const upstreamUrl = upstreamQs ? `${ZC_UPSTREAM}?${upstreamQs}` : ZC_UPSTREAM;

    zcWss.handleUpgrade(req, socket, head, (clientWs) => {
      // Forward the browser's requested subprotocol (we hard-code 'zeroclaw.v1').
      const upstream = new WebSocket(upstreamUrl, ['zeroclaw.v1']);
      let upstreamOpen = false;
      const pending: (string | Buffer)[] = [];

      upstream.on('open', () => {
        upstreamOpen = true;
        // Flush any messages the client sent while we were still connecting.
        for (const m of pending) upstream.send(m);
        pending.length = 0;
      });

      clientWs.on('message', (data, isBinary) => {
        const payload = isBinary ? data as Buffer : data.toString();
        if (!upstreamOpen) { pending.push(payload); return; }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
      });

      upstream.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(typeof data === 'string' ? data : data.toString());
        }
      });

      clientWs.on('close', () => {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          upstream.close();
        }
      });
      upstream.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
      });
      upstream.on('error', (e) => {
        console.error('zeroclaw proxy: upstream error:', e.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
      });
      clientWs.on('error', () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
      });
    });
    return;
  }

  // Unknown WS path
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`SideKick server on http://${HOST}:${PORT} (TTS: ${DEFAULT_TTS_MODEL})`);
});
