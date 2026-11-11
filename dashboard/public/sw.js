/*
 * Comffee CCTV service worker.
 *
 * Caches the app shell only: the page, the built scripts and styles under /assets/, the fonts, the
 * icons and the manifest. Everything else goes straight to the network and is never stored, above all
 * /api (sign-in, settings, recording lists and recording files), /live (camera streams) and /bridge.
 *
 * Page loads are network first, so a new release shows as soon as the hub is reachable; the cached
 * page is only a fallback when the network is down. Built assets have content hashes in their names,
 * so they are cache first and the cache is trimmed to a fixed number of entries.
 */

const CACHE = 'comffee-cctv-shell-v1';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/fonts/72-Regular.woff2',
  '/fonts/72-SemiboldDuplex.woff2',
  '/fonts/72-Bold.woff2',
  '/fonts/72-Black.woff2',
];
const MAX_ENTRIES = 80;

/** Paths that are never served from or written to the cache. */
function isNeverCached(path) {
  return (
    path === '/api' ||
    path.startsWith('/api/') ||
    path.startsWith('/live/') ||
    path === '/bridge' ||
    path.startsWith('/bridge/') ||
    path === '/sw.js'
  );
}

/** Static shell files that may be cached. */
function isShellAsset(path) {
  return (
    path.startsWith('/assets/') ||
    path.startsWith('/fonts/') ||
    path.startsWith('/icons/') ||
    path === '/manifest.webmanifest'
  );
}

/** A response may be stored only when it is a plain, successful, same-origin answer. */
function isStorable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cacheControl = response.headers.get('Cache-Control') || '';
  return !/no-store|private/i.test(cacheControl);
}

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ENTRIES;
  for (let i = 0; i < extra; i++) {
    const path = new URL(keys[i].url).pathname;
    if (!SHELL.includes(path)) await cache.delete(keys[i]);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url.pathname)) return;
  if (request.headers.has('range')) return;

  // Page loads: the network first, the cached page when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (isStorable(response) && (response.headers.get('Content-Type') || '').includes('text/html')) {
            const cache = await caches.open(CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('/');
          return cached || Response.error();
        }),
    );
    return;
  }

  if (!isShellAsset(url.pathname)) return;

  // Built assets, fonts and icons: the cache first, then the network.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then(async (response) => {
        if (isStorable(response)) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
          await trim(cache);
        }
        return response;
      });
    }),
  );
});
