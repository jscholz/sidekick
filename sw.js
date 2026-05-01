/**
 * Service worker — caches the app shell so iOS PWA survives app switches.
 * Strategy: cache-first for app shell assets, network-first for /build/*.
 *
 * Install resilience (2026-05-01): switched cache-add from `addAll` (atomic
 * — ANY 404 fails the entire install, leaves the new SW redundant, leaves
 * the OLD SW in control indefinitely) to `Promise.allSettled` over
 * individual `cache.add` calls. A drifted APP_SHELL list (e.g. a refactor
 * renames a module) no longer locks PWAs on the old version. The cost is
 * we may pre-cache fewer modules than intended — but `/build/*` is
 * network-first, so first-load pulls anything missed and caches on the
 * way through.
 */
const CACHE_NAME = 'v0.335';

// Minimum viable shell for offline boot. Bundle JS modules used to be
// listed here too — that was the source of the 2026-05-01 cache.addAll
// failure (refactor renamed /build/canvas → /build/cards, removed
// /build/backends/*, removed /build/gateway.mjs; addAll on the stale
// list 404'd every install). With network-first on /build/*, listing
// JS here is redundant: a first online load primes the cache for every
// module the page actually imports. Keep this list narrow + load-bearing.
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles/app.css',
  '/manifest.json',
  '/assets/icon.png',
  '/assets/icon.svg',
  '/assets/icon-chevron.svg',
  // Audio worklet — loaded out-of-band by the AudioContext, not via
  // import; pre-cache so the talk-mode pipeline boots offline.
  '/build/audio/audio-processor.js',
];

self.addEventListener('install', (e) => {
  // Per-entry add with Promise.allSettled so a single 404 doesn't fail
  // the whole install. Any rejection is logged but does not block
  // skipWaiting → activate → controllerchange → page reload. The
  // network-first /build/* handler will fill in any module misses on
  // first request.
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        const results = await Promise.allSettled(
          APP_SHELL.map(url => cache.add(url)),
        );
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'rejected') {
            console.warn(`[sw] install: skipping ${APP_SHELL[i]}: ${r.reason}`);
          }
        }
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls, WebSocket upgrades, and external URLs — always network
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/ws/')) return;
  // /api/* covers hermes proxy routes (models-catalog, model, sessions, …)
  // and keyterms. Caching these silently stales dynamic server state —
  // e.g. the model picker would read a cached model ref after a /set.
  if (url.pathname.startsWith('/api/')) return;
  if (['/config', '/tts', '/gen-image', '/weather', '/link-preview',
       '/spotify-check', '/screenshot', '/canvas/show', '/transcribe'].includes(url.pathname)) return;
  if (url.origin !== self.location.origin) return;

  // /build/* — NETWORK-FIRST. Compiled JS bundle modules. Every code
  // change rebuilds these; cache-first served stale modules across SW
  // updates (new SW activates, page header shows new CACHE_NAME, but
  // the in-memory JS is from the OLD cached bundle until a SECOND
  // reload). Network-first guarantees fresh code on reload while
  // still falling back to cache when offline.
  if (url.pathname.startsWith('/build/')) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell (HTML, CSS, icons, manifest) — cache-first, fall back to
  // network. These rarely change relative to JS modules so the offline
  // benefit outweighs staleness risk.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// Allow the page to query the active cache version (shown in the header).
self.addEventListener('message', (e) => {
  if (e.data?.type === 'get-version') {
    e.source?.postMessage({ type: 'version', version: CACHE_NAME });
  }
  // Refresh button on the page postMessages us after reg.update() if a
  // new SW is sitting in 'waiting' state. install() already calls
  // skipWaiting() defensively, but if a previous SW shipped without it,
  // honour the message so users can unstick a stale install.
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
