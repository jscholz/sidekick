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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { validators } from './src/canvas/validators.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';

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
        'User-Agent': 'Mozilla/5.0 (compatible; BlueberryClaw/1.0; +https://reimaginerobotics.ai)',
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
const DEFAULT_WEATHER_LAT = parseFloat(process.env.SIDEKICK_WEATHER_LAT || '51.5074');
const DEFAULT_WEATHER_LON = parseFloat(process.env.SIDEKICK_WEATHER_LON || '-0.1278');

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

const SCREENSHOT_DISABLED = process.env.SIDEKICK_DISABLE_SCREENSHOT === '1';

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
// Default Deepgram key-term hints. Empty by default — per-install terms
// live in `keyterms.txt` (gitignored) or `SIDEKICK_STT_KEYTERMS` env var.
// Both are additive to this list; the DEFAULT is intentionally minimal so
// forks don't inherit vocabulary biases from another project's agent.
const DEFAULT_KEYTERMS: string[] = ['Sidekick', 'Deepgram'];

// Optional env-var override (useful for Docker / CI where a file mount
// is awkward). Additive to the file list below.
const ENV_KEYTERMS = process.env.SIDEKICK_STT_KEYTERMS
  ? process.env.SIDEKICK_STT_KEYTERMS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

const KEYTERMS_PATH = path.join(__dirname, 'keyterms.txt');

/** Read ./keyterms.txt — one term per line, '#' starts a comment, blank
 *  lines ignored. Read synchronously on each /config request so edits
 *  take effect on the next browser refresh, no service restart. */
function readKeytermsFile() {
  try {
    const raw = fsSync.readFileSync(KEYTERMS_PATH, 'utf8');
    return raw.split('\n')
      .map(l => l.replace(/#.*$/, '').trim())  // strip comments
      .filter(Boolean);
  } catch { return []; }
}

/** Serve the raw keyterms.txt file contents for browser-side editing.
 *  If the file is missing OR empty (trimmed), seed the response with
 *  DEFAULT_KEYTERMS so the textarea shows the active vocabulary rather
 *  than appearing empty. The first Save from the UI overwrites the file
 *  with whatever the user has at that point — after that the file is
 *  authoritative and defaults are no longer auto-merged in (see
 *  handleConfig below). */
async function handleKeytermsGet(_req, res) {
  let raw = '';
  try {
    raw = await fs.readFile(KEYTERMS_PATH, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('keyterms read failed:', e.message);
      res.writeHead(500); res.end();
      return;
    }
  }
  const body = raw.trim() ? raw : DEFAULT_KEYTERMS.join('\n') + '\n';
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(body);
}

/** Write the request body to keyterms.txt. No validation — the file is
 *  user-editable text, we trust the poster. Local-network-only trust
 *  model (same as /config returning the gw token in clear). */
async function handleKeytermsPost(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    await fs.writeFile(KEYTERMS_PATH, body, 'utf8');
    res.writeHead(204); res.end();
  } catch (e) {
    console.error('keyterms write failed:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`write failed: ${e.message}`);
  }
}

function handleConfig(_req, res) {
  // If keyterms.txt has content, it's authoritative — the user has edited
  // the list and may have removed defaults on purpose. Otherwise seed with
  // DEFAULT_KEYTERMS. ENV_KEYTERMS is always additive on top (Docker/CI
  // override that shouldn't depend on whether a file has been saved).
  const fileKeyterms = readKeytermsFile();
  const base = fileKeyterms.length > 0 ? fileKeyterms : DEFAULT_KEYTERMS;
  const merged = [...new Set([...base, ...ENV_KEYTERMS])];
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({
    gwToken: GW_TOKEN,
    mapsEmbedKey: process.env.MAPS_EMBED_KEY || '',
    sttKeyterms: merged,
    // Skinning — per-install overrides for app name / agent label / primary
    // theme color. Defaults to SideKick branding; set SIDEKICK_* env vars
    // in the systemd unit to customize per downstream user.
    appName: process.env.SIDEKICK_APP_NAME || 'SideKick',
    appSubtitle: process.env.SIDEKICK_APP_SUBTITLE || 'Agent Portal',
    agentLabel: process.env.SIDEKICK_AGENT_LABEL || 'Clawdian',
    // Any valid CSS color (hex, rgb(), hsl()). Empty = keep stylesheet default.
    themePrimary: process.env.SIDEKICK_THEME_PRIMARY || '',
    // Which BackendAdapter the client loads. Default 'openclaw' for
    // back-compat; other values: 'openai-compat' (streaming chat against
    // any /chat/completions-compatible endpoint — OpenAI, Ollama, LMStudio,
    // Groq, vLLM, etc.). See src/backends/.
    backend: process.env.SIDEKICK_BACKEND || 'hermes',
    openaiCompatModel: process.env.SIDEKICK_OPENAI_COMPAT_MODEL || '',
  }));
}

// OpenAI-compatible chat proxy. Only active when SIDEKICK_BACKEND=openai-compat.
// Keeps the upstream URL + API key server-side (off the browser) and streams
// the SSE response through unchanged. Works with OpenAI, Ollama, LMStudio,
// Groq, vLLM, Together — anything that speaks POST /v1/chat/completions.
const OPENAI_COMPAT_URL = process.env.SIDEKICK_OPENAI_COMPAT_URL
  || 'http://localhost:11434/v1/chat/completions';  // Ollama default
const OPENAI_COMPAT_KEY = process.env.SIDEKICK_OPENAI_COMPAT_KEY || '';

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
const HERMES_UPSTREAM = process.env.SIDEKICK_HERMES_URL || 'http://127.0.0.1:8642';
const HERMES_TOKEN = process.env.SIDEKICK_HERMES_TOKEN || '';

// ─── Hermes session browser (direct sqlite read of response_store.db) ────────
// Hermes chains conversation turns server-side via previous_response_id,
// keyed by a `conversation:` name we send on each /v1/responses POST. The
// response_store.db holds (a) a conversations table mapping name → latest
// response_id, and (b) a responses table whose JSON payload includes the
// full conversation_history. We read both directly — fast, stable, no
// dependency on the auth-gated dashboard API.

const execFileP = promisify(execFile);
const HERMES_STORE_DB = process.env.SIDEKICK_HERMES_STORE_DB
  || '/home/jscholz/.hermes/response_store.db';
const HERMES_STATE_DB = process.env.SIDEKICK_HERMES_STATE_DB
  || '/home/jscholz/.hermes/state.db';
const HERMES_CLI = process.env.SIDEKICK_HERMES_CLI
  || '/home/jscholz/.local/bin/hermes';
// Filter so random test names / non-sidekick conversations don't clutter the UI.
// hermes adapter generates names as 'sidekick-main' or 'sidekick-<timestamp>'.
const HERMES_SESSION_PREFIX = process.env.SIDEKICK_HERMES_SESSION_PREFIX || 'sidekick-';
// Source filter for state.db/sessions — hermes tags each session with where
// it came from ('api_server' = sidekick webchat; 'telegram' = telegram bot;
// 'cli' = terminal sessions). Sidekick drawer shows the channels the user
// actually talks through; 'cli' is excluded by default since those are
// ad-hoc debug sessions. Override via SIDEKICK_HERMES_SESSION_SOURCES.
const HERMES_SESSION_SOURCES = (process.env.SIDEKICK_HERMES_SESSION_SOURCES
  || 'api_server,telegram').split(',').map(s => s.trim()).filter(Boolean);

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
  // Prefix filter: accept a user-supplied glob (e.g. 'sidekick-*,work-*'),
  // convert '*' → SQL LIKE '%', fall back to the env/default prefix. Only
  // applied to webchat (api_server) rows; telegram always shows because
  // it uses the UUID as id and naming doesn't follow the sidekick
  // convention. Strictly strip to the chars our adapter actually
  // produces so the value can be string-concat into SQL safely.
  const rawPrefix = url.searchParams.get('prefix') || HERMES_SESSION_PREFIX;
  const prefixes = rawPrefix.split(',')
    .map(p => p.trim().replace(/[^a-zA-Z0-9_\-*]/g, ''))
    .filter(Boolean)
    .map(p => p.replace(/\*/g, '%'));
  const prefixClause = prefixes.length
    ? '(' + prefixes.map(p => `c.name LIKE '${p}'`).join(' OR ') + ')'
    : '1=0';
  const prefix = prefixes[0]?.replace(/%$/, '') || 'sidekick-';
  // Authoritative source is state.db/sessions — every channel (api_server /
  // telegram / cli) writes here. Previously we queried response_store.db/
  // conversations by 'sidekick-' name prefix, which hid telegram sessions
  // entirely (telegram goes straight to state.db without a response_store
  // conversations row). New approach:
  //   - For api_server (sidekick webchat), join to conversations to get the
  //     stable `sidekick-*` id the hermes adapter uses for resume.
  //   - For telegram (and any other non-webchat source), use the session
  //     UUID directly as the id — drawer renders these as read-only
  //     transcripts (send path still routes through the active sidekick
  //     conversation).
  const sources = HERMES_SESSION_SOURCES
    .map(s => s.replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(Boolean);
  if (!sources.length) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }
  const sourceList = sources.map(s => `'${s}'`).join(',');
  // Resolve the conversation name lazily via scalar subquery so we don't
  // fan out into N rows when a session has N turns (each turn is a
  // response row in response_store.db). Returns exactly one row per
  // state.db session.
  const sql = `
    ATTACH '${HERMES_STORE_DB.replace(/'/g, "''")}' AS store;
    SELECT
      CASE WHEN s.source = 'api_server'
        THEN COALESCE(
          (SELECT c.name FROM store.responses r
             JOIN store.conversations c ON c.response_id = r.response_id
             WHERE json_extract(r.data, '$.session_id') = s.id
               AND ${prefixClause}
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
    WHERE s.source IN (${sourceList})
    ORDER BY lastMessageAt DESC NULLS LAST
    LIMIT ${limit}
  `;
  // Note: the prefix filter only restricts the NAME returned for api_server
  // sessions — the scalar subquery above picks a matching conversation name
  // or falls back to s.id. Orphan api_server sessions (no conversation row
  // at all) always show by UUID. Intentional: users can still see their
  // full chat history regardless of which conversation names happen to
  // match their filter.
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
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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

// SIDEKICK_PREFERRED_MODELS — comma-separated list of globs, e.g.
// "anthropic/*,google/gemini-*,openai/gpt-5*". When set, the models-catalog
// route partitions the openrouter response into `preferred` (any glob matches)
// and `other` (none match) so the UI can surface the curated list first. When
// unset, the route returns one flat `data` list (backward compatible).
const PREFERRED_MODELS_GLOBS: RegExp[] = (process.env.SIDEKICK_PREFERRED_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((glob) => {
    // Escape regex metachars, then turn `*` into `.*`. Anchored at both ends so
    // "anthropic/*" matches "anthropic/claude-haiku-4.5" but not
    // "fooanthropic/whatever".
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });

function isPreferredModel(id: string): boolean {
  if (PREFERRED_MODELS_GLOBS.length === 0) return false;
  return PREFERRED_MODELS_GLOBS.some((re) => re.test(id));
}

async function handleHermesModelsCatalog(req, res) {
  // Hermes's own /v1/models only returns the 'hermes-agent' placeholder —
  // the actual inference catalog is whatever the configured provider
  // exposes. Jonathan uses openrouter, so fetch openrouter's catalog
  // directly and return it in the ModelEntry shape the settings picker
  // expects. OPENROUTER_API_KEY is read server-side so the client never
  // sees it; catalog listing doesn't strictly require an API key but
  // providing one gets better availability.
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
  // AUTHORITATIVE read path: state.db/messages keyed by the session UUID.
  // Earlier implementation read from responses.data.conversation_history
  // but that payload compounds across turns (each response embeds its
  // full input-context, which includes prior turns' contexts, growing
  // recursively) — rendering it produced wildly duplicated bubbles in
  // the chat. state.db/messages is the per-turn log hermes updates
  // exactly once per user/assistant entry.
  try {
    // Resolve the UUID: sidekick names go through conversations lookup;
    // anything else is assumed to already be a state.db session id.
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
    const msgSql = `SELECT role, content, tool_name, timestamp FROM messages
      WHERE session_id='${uuid}' ORDER BY id`;
    const rows = await sqlQuery(HERMES_STATE_DB, msgSql);
    const messages = rows.map((m: any) => ({
      role: m.role,
      content: m.content || '',
      timestamp: m.timestamp,
      toolName: m.tool_name || undefined,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages }));
  } catch (e: any) {
    console.error('hermes session messages failed:', e.message);
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
const ZC_UPSTREAM = process.env.SIDEKICK_ZEROCLAW_WS || 'ws://127.0.0.1:42617/ws/chat';
const ZC_TOKEN = process.env.SIDEKICK_ZEROCLAW_TOKEN || '';

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
