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
 * - POST /transcribe   → batch STT (forwards to audio-bridge /v1/transcribe)
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
import { validators } from './src/cards/validators.ts';
import {
  rebuildPreferredModels,
  PREFERRED_MODELS_RAW,
} from './server-lib/preferred-models.ts';
import * as sidekick from './server-lib/sidekick/index.ts';

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
        'User-Agent': 'Mozilla/5.0 (compatible; Sidekick/1.0)',
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

// ── Batch transcription proxy: POST /transcribe → audio-bridge /v1/transcribe ──
// Forwards to audio bridge — STT abstraction lives there. Swap providers via
// bridge config, both live + memo paths follow. The bridge calls the same
// STTProvider as the WebRTC streaming path (see audio-bridge/providers/stt.py).
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
      const upstream = new URL('/v1/transcribe', AUDIO_BRIDGE_UPSTREAM);
      // Forward the PWA's query string (specifically ?keyterms=…&keyterms=…)
      // through to the bridge. Without this, per-user keyterm biasing on
      // memo / batch transcription is silently dropped — bridge sees an
      // empty query and falls back to the configured base spec.
      const incomingQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      if (incomingQuery) upstream.search = incomingQuery;
      const bridgeRes = await fetch(upstream.toString(), {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      const data = await bridgeRes.json().catch(() => ({}));
      if (!bridgeRes.ok) {
        const errMsg = (data && (data.error?.message || data.error)) || `bridge ${bridgeRes.status}`;
        console.error(`transcribe bridge error ${bridgeRes.status}: ${JSON.stringify(errMsg).slice(0, 200)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: errMsg }));
        return;
      }
      const transcript = (data && data.transcript) || '';
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
// (app name, default coords) can be set without a rebuild.
const GW_TOKEN = process.env.GW_TOKEN || '';

// Default STT keyterm seed file. Read-only at runtime: the PWA fetches
// it ONCE on first boot to seed each user's IndexedDB-backed list, then
// reads/writes only IDB thereafter. Forks editing this file affect new
// users only — existing installs keep their per-user IDB list. One term
// per line; '#' comments and blank lines are ignored. Lives next to
// server.ts so it ships with the repo.
const DEFAULT_KEYTERMS_SEED_PATH = path.join(__dirname, 'default_stt_keyterms.txt');

// Final fallback when the seed file is missing or unreadable. Minimal so
// forks don't inherit unrelated vocabulary biases.
const FALLBACK_KEYTERMS: string[] = ['Sidekick', 'Deepgram'];

/** Read + parse the keyterm seed file. Strips '#' comments, splits on
 *  newlines and commas (matches the chip-UI parser). Falls back to
 *  FALLBACK_KEYTERMS if the file is missing/unreadable. */
function readSeedKeyterms(): string[] {
  let raw = '';
  try {
    raw = fsSync.readFileSync(DEFAULT_KEYTERMS_SEED_PATH, 'utf8');
  } catch {
    return [...FALLBACK_KEYTERMS];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const nocomment = line.replace(/#.*$/, '');
    for (const part of nocomment.split(',')) {
      const t = part.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
  }
  return out.length ? out : [...FALLBACK_KEYTERMS];
}

/** Serve the seed keyterms as newline-separated text. Used by the PWA
 *  ONLY for first-boot IDB seeding — subsequent reads/writes happen
 *  entirely client-side. There is no POST companion: editing keyterms
 *  via the chip UI mutates IndexedDB, not this file. */
async function handleKeytermsGet(_req, res) {
  const terms = readSeedKeyterms();
  const body = terms.join('\n') + '\n';
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
 *  the next picker fetch partitions correctly without a server
 *  restart. */
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
    res.writeHead(204); res.end();
  } catch (e: any) {
    console.error('preferred-models write failed:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`write failed: ${e.message}`);
  }
}

function handleConfig(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({
    gwToken: GW_TOKEN,
    mapsEmbedKey: process.env.MAPS_EMBED_KEY || '',
    // Skinning — per-install overrides for app name / agent label / primary
    // theme color. Resolved via sidekick.config.yaml (app.*) then env var
    // then default. See config.example.yaml.
    appName: cfgVal('SIDEKICK_APP_NAME', 'app.name', 'SideKick'),
    appSubtitle: cfgVal('SIDEKICK_APP_SUBTITLE', 'app.subtitle', 'Agent Portal'),
    agentLabel: cfgVal('SIDEKICK_AGENT_LABEL', 'app.agent_label', 'Clawdian'),
    // Any valid CSS color (hex, rgb(), hsl()). Empty = keep stylesheet default.
    themePrimary: cfgVal('SIDEKICK_THEME_PRIMARY', 'app.theme_primary', ''),
    // Which BackendAdapter the client loads. Always 'hermes-gateway'
    // post-refactor — the legacy openclaw / openai-compat / zeroclaw
    // direct-PWA-to-LLM adapters were removed in step 7. Setting any
    // other value loads hermes-gateway anyway.
    backend: cfgVal('SIDEKICK_BACKEND', 'backend.type', 'hermes-gateway'),
  }));
}

// Sidekick audio bridge — standalone Python aiortc service for WebRTC
// signaling + STT + TTS. The proxy forwards /api/rtc/* to the bridge;
// the bridge POSTs back to /api/sidekick/messages with {chat_id, text}
// for agent dispatch (single sidekick→agent gateway). See
// ~/code/sidekick/audio-bridge/.
const AUDIO_BRIDGE_UPSTREAM = cfgVal(
  'SIDEKICK_AUDIO_BRIDGE_URL',
  'backend.audio_bridge.url',
  'http://127.0.0.1:8643',
) as string;

const HOME = os.homedir();

// ─── Sidekick agent contract ────────────────────────────────────────────
// The proxy talks to ANY upstream that speaks the abstract agent
// contract (HTTP+SSE — see docs/ABSTRACT_AGENT_PROTOCOL.md).
// hermes-plugin is the typical upstream; the stub agent under
// `agent/` is a hermes-free reference. With no token configured,
// `/api/sidekick/*` endpoints return 503.
sidekick.init({
  token: process.env.SIDEKICK_PLATFORM_TOKEN
    || (cfgVal('SIDEKICK_PLATFORM_TOKEN', 'backend.sidekick_platform.token', '') as string),
  url: cfgVal('SIDEKICK_PLATFORM_URL', 'backend.sidekick_platform.url',
    'http://127.0.0.1:8645') as string,
});

// Cold-start initialization of the preferred-models matcher. Without
// this, PREFERRED_MODELS_RAW stays at its module-default `[]` until
// the first config-mtime change picks up the yaml value via
// reloadConfigIfChanged() — which never happens on a stable deployment
// where the yaml hasn't been edited since boot.
//
// Falls back to SIDEKICK_PREFERRED_MODELS env var (comma-sep) for
// deployments that haven't switched to the yaml yet.
(() => {
  const cfg = DEPLOY_CFG?.models?.preferred;
  if (Array.isArray(cfg)) {
    rebuildPreferredModels(cfg.map((s: any) => String(s).trim()).filter(Boolean));
    return;
  }
  const env = process.env.SIDEKICK_PREFERRED_MODELS;
  if (env) {
    rebuildPreferredModels(env.split(',').map(s => s.trim()).filter(Boolean));
    return;
  }
  rebuildPreferredModels([]);
})();

// ── WebRTC voice transport proxy: /api/rtc/* → audio-bridge /v1/rtc/* ────────
// The audio bridge (~/code/sidekick/audio-bridge/) is a standalone Python
// aiortc service on :8643. The bridge owns WebRTC signaling, STT, and
// TTS; it POSTs back through this proxy at /api/sidekick/messages with
// {chat_id, text} for agent dispatch (single sidekick→agent gateway).
//
// Body sizes are tiny (an SDP offer is <4KB, ICE candidates <1KB) so no
// special streaming concerns. No auth header forwarding — the bridge is
// loopback-only and the agent token is irrelevant here.
function handleRtcProxy(req, res) {
  const suffix = req.url.replace(/^\/api\/rtc/, '') || '/';
  const upstreamPath = `/v1/rtc${suffix}`;
  const upstream = new URL(upstreamPath, AUDIO_BRIDGE_UPSTREAM);

  const headers = {};
  for (const h of ['content-type', 'content-length', 'accept']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  const lib = upstream.protocol === 'https:' ? https : http;
  const upReq = lib.request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers,
  }, (upRes) => {
    const out = { ...upRes.headers };
    delete out.connection;
    delete out['transfer-encoding'];
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
  });

  upReq.on('error', (e) => {
    console.error('rtc proxy: upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
    } else {
      res.end();
    }
  });

  if (req.method === 'POST' || req.method === 'PUT') req.pipe(upReq);
  else upReq.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  // WebRTC voice signaling proxy → /v1/rtc/* on hermes upstream.
  if (req.url && req.url.startsWith('/api/rtc')) return handleRtcProxy(req, res);
  // Sidekick agent-contract endpoints. Match before the static
  // fallback. The DELETE pattern's chat_id capture group is permissive
  // on character class to match the IDB-minted UUIDs we expect.
  if (req.url) {
    if (req.method === 'POST' && req.url === '/api/sidekick/messages') {
      return sidekick.handleSidekickMessage(req, res);
    }
    if (req.method === 'GET' && /^\/api\/sidekick\/stream(?:\?.*)?$/.test(req.url)) {
      return sidekick.handleSidekickStream(req, res);
    }
    if (req.method === 'GET' && /^\/api\/sidekick\/sessions(?:\?.*)?$/.test(req.url)) {
      return sidekick.handleSidekickSessionsList(req, res);
    }
    // Per-chat_id transcript history. Match BEFORE the generic
    // /sessions/<id> DELETE pattern so the more-specific subroute wins.
    const sidekickHistory = req.method === 'GET'
      && req.url.match(/^\/api\/sidekick\/sessions\/([^/?]+)\/messages(?:\?.*)?$/);
    if (sidekickHistory) {
      return sidekick.handleSidekickSessionMessages(req, res, decodeURIComponent(sidekickHistory[1]));
    }
    const sidekickDelete = req.method === 'DELETE'
      && req.url.match(/^\/api\/sidekick\/sessions\/([^/?]+)(?:\?.*)?$/);
    if (sidekickDelete) {
      return sidekick.handleSidekickSessionDelete(req, res, decodeURIComponent(sidekickDelete[1]));
    }
    if (req.method === 'GET' && /^\/api\/sidekick\/settings\/schema(?:\?.*)?$/.test(req.url)) {
      return sidekick.handleSidekickSettingsSchema(req, res);
    }
    const sidekickSettingsUpdate = req.method === 'POST'
      && req.url.match(/^\/api\/sidekick\/settings\/([^/?]+)(?:\?.*)?$/);
    if (sidekickSettingsUpdate) {
      return sidekick.handleSidekickSettingsUpdate(
        req, res, decodeURIComponent(sidekickSettingsUpdate[1]),
      );
    }
  }
  if (req.method === 'GET' && req.url === '/config') return handleConfig(req, res);
  if (req.method === 'GET' && req.url === '/api/keyterms') return handleKeytermsGet(req, res);
  if (req.method === 'GET' && req.url === '/api/preferred-models') return handlePreferredModelsGet(req, res);
  if (req.method === 'POST' && req.url === '/api/preferred-models') return handlePreferredModelsPost(req, res);
  if (req.method === 'POST' && req.url.startsWith('/tts')) return handleTts(req, res);
  if (req.method === 'POST' && req.url.startsWith('/gen-image')) return handleGenImage(req, res);
  if (req.method === 'POST' && req.url === '/canvas/show') return handleCanvasShow(req, res);
  if (req.method === 'POST' && (req.url === '/transcribe' || req.url.startsWith('/transcribe?'))) return handleTranscribe(req, res);
  if (req.method === 'GET' && req.url.startsWith('/weather')) return handleWeather(req, res);
  if (req.method === 'GET' && req.url.startsWith('/link-preview')) return handleLinkPreview(req, res);
  if (req.method === 'GET' && req.url.startsWith('/spotify-check')) return handleSpotifyCheck(req, res);
  if (req.method === 'GET' && req.url.startsWith('/screenshot')) return handleScreenshot(req, res);
  if (req.method === 'GET' && req.url.startsWith('/render')) return handleRender(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

// ── WebSocket servers ──────────────────────────────────────────────────────
// (Legacy /ws/deepgram STT proxy removed when classic pipeline was gut-cut;
// streaming STT now flows through the audio-bridge WebRTC path, batch STT
// through POST /transcribe → audio-bridge /v1/transcribe.)

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
