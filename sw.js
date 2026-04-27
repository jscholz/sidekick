/**
 * Service worker — caches the app shell so iOS PWA survives app switches.
 * Strategy: cache-first for app shell assets, network-first for API calls.
 */
const CACHE_NAME = 'v2.77';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles/app.css',
  '/manifest.json',
  '/assets/icon.png',
  '/assets/icon.svg',
  '/assets/icon-chevron.svg',
  '/build/main.mjs',
  '/build/config.mjs',
  '/build/status.mjs',
  '/build/chat.mjs',
  '/build/bgTrace.mjs',
  '/build/gateway.mjs',
  '/build/backend.mjs',
  '/build/backends/types.mjs',
  '/build/backends/openclaw.mjs',
  '/build/backends/openai-compat.mjs',
  '/build/settings.mjs',
  '/build/theme.mjs',
  '/build/wakeLock.mjs',
  '/build/util/log.mjs',
  '/build/util/dom.mjs',
  '/build/util/markdown.mjs',
  '/build/util/filterStore.mjs',
  '/build/sessionFilter.mjs',
  '/build/cmdkPalette.mjs',
  '/build/ios/audio-unlock.mjs',
  '/build/audio/micMeter.mjs',
  '/build/audio/session.mjs',
  '/build/audio/ios-specific.mjs',
  '/build/audio/feedback.mjs',
  '/build/audio/memo.mjs',
  '/build/audio/audio-processor.js',
  '/build/pipelines/types.mjs',
  '/build/pipelines/webrtc/connection.mjs',
  '/build/pipelines/webrtc/controls.mjs',
  '/build/pipelines/webrtc/dictation.mjs',
  '/build/pipelines/webrtc/dictate.mjs',
  '/build/pipelines/webrtc/suppress.mjs',
  '/build/pipelines/conversational/index.mjs',
  '/build/queue.mjs',
  '/build/voiceMemos.mjs',
  '/build/memoCard.mjs',
  '/build/attachments.mjs',
  '/build/draft.mjs',
  '/build/composer.mjs',
  '/build/settings/mobile-bottomsheet.mjs',
  '/build/ios/fakeLock.mjs',
  '/build/ambient.mjs',
  '/build/canvas/attach.mjs',
  '/build/canvas/registry.mjs',
  '/build/canvas/validate.mjs',
  '/build/canvas/validators.mjs',
  '/build/canvas/fallback.mjs',
  '/build/canvas/cards/image.mjs',
  '/build/canvas/cards/youtube.mjs',
  '/build/canvas/cards/spotify.mjs',
  '/build/canvas/cards/links.mjs',
  '/build/canvas/cards/markdown.mjs',
  '/build/canvas/cards/loading.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
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

  // App shell — cache-first, fall back to network (and update cache)
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
});
