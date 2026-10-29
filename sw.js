/* =====================================================================
 * Mawe Tatu Dairy — sw.js (Service Worker)
 * ---------------------------------------------------------------------
 * Makes the app open and work with NO signal (offline-first app shell).
 * Registered by app.js → registerServiceWorker() as './sw.js'.
 *
 * Strategy
 *   • INSTALL: download and cache every file the app needs (the "app shell"):
 *     index.html, herd.js, app.js, manifest.json, the two icons, the
 *     Tailwind CDN script and the Dexie CDN script.
 *     If any file fails to download, the install fails and the browser
 *     retries on the next visit, so a half-cached app is never activated.
 *   • FETCH:
 *       - page loads (navigations)  → cached index.html first (instant, works offline),
 *                                     network only if the cache is somehow empty
 *       - app-shell files           → cache first, network fallback
 *       - other same-origin GETs    → network first, cache fallback
 *       - Apps Script / any POST    → never touched; always go straight to the network
 *   • ACTIVATE: delete caches from older versions.
 *   • UPDATE: a new sw.js waits until app.js sends SKIP_WAITING (the user
 *     taps "Reload" on the update banner), so nobody loses a half-typed entry.
 *
 * ►► Whenever you change ANY app file (index.html, herd.js, app.js, a CDN URL),
 *    bump CACHE_VERSION below. That is what tells phones to update.
 * ===================================================================== */

'use strict';

const CACHE_VERSION = 'v4.0.0'; // v4.0.0: herd register (herd.js) · v3.0.0: Google Sign-In
const CACHE_PREFIX = 'mawe-tatu-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;

// Must be identical to the <script src> URLs in index.html.
const TAILWIND_URL = 'https://cdn.tailwindcss.com';
const DEXIE_URL = 'https://unpkg.com/dexie@4.0.8/dist/dexie.js';

// Local files, resolved against this worker's scope (works in a sub-folder too).
const SCOPE = self.registration.scope;
const INDEX_URL = new URL('./index.html', SCOPE).href;
const LOCAL_ASSETS = [
  INDEX_URL,
  new URL('./herd.js', SCOPE).href,
  new URL('./app.js', SCOPE).href,
  new URL('./manifest.json', SCOPE).href,
  new URL('./icon-192.png', SCOPE).href,
  new URL('./icon-512.png', SCOPE).href,
];
const CDN_ASSETS = [TAILWIND_URL, DEXIE_URL];

const PRECACHE_URLS = new Set([...LOCAL_ASSETS, ...CDN_ASSETS]);

// Sync API and Google Sign-In — never cache these; always go to the network.
const BYPASS_HOSTS = ['script.google.com', 'script.googleusercontent.com', 'accounts.google.com'];

/* ------------------------------------------------------------------
 * INSTALL — pre-cache the app shell
 * ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
});

async function precacheAppShell() {
  const cache = await caches.open(SHELL_CACHE);

  // cache: 'reload' bypasses the browser's HTTP cache, so a version bump
  // really fetches fresh copies of every file.
  await cache.addAll(LOCAL_ASSETS.map((url) => new Request(url, { cache: 'reload' })));

  // CDN files are cross-origin. Try a normal CORS request first (readable,
  // small in storage). If the CDN does not send CORS headers, fall back to
  // an opaque 'no-cors' response, which <script> tags can still execute.
  await Promise.all(CDN_ASSETS.map(async (url) => {
    const response = await fetchCrossOrigin(url);
    await cache.put(url, response);
  }));
}

async function fetchCrossOrigin(url) {
  try {
    const res = await fetch(new Request(url, { mode: 'cors', cache: 'reload', credentials: 'omit' }));
    if (res.ok) return res;
    throw new Error(`HTTP ${res.status}`);
  } catch (corsErr) {
    const res = await fetch(new Request(url, { mode: 'no-cors', cache: 'reload', credentials: 'omit' }));
    // Opaque responses report status 0; anything else must be a 2xx.
    if (res.type === 'opaque' || res.ok) return res;
    throw new Error(`Could not cache ${url}: ${corsErr.message}`);
  }
}

/* ------------------------------------------------------------------
 * ACTIVATE — remove old caches and take control of open pages
 * ------------------------------------------------------------------ */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
        .map((name) => caches.delete(name)),
    );
    // Control pages that are already open (first install) without a reload.
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------
 * MESSAGES — app.js asks a waiting update to activate
 * ------------------------------------------------------------------ */

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ------------------------------------------------------------------
 * FETCH — serve from cache so the app works offline
 * ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GETs are cacheable. Sync POSTs to Apps Script pass straight through.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (BYPASS_HOSTS.some((host) => url.hostname === host)) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return; // e.g. chrome-extension://

  // 1. Page loads: always the cached app shell.
  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(serveAppShell(request));
    return;
  }

  // 2. Pre-cached files (herd.js, app.js, Tailwind, Dexie): cache first.
  //    Compare without the query string so app.js?x=1 still matches.
  const bareUrl = url.origin + url.pathname;
  if (PRECACHE_URLS.has(request.url) || PRECACHE_URLS.has(bareUrl)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 3. Any other same-origin GET (icons, manifest you may add later):
  //    network first, keep a copy, fall back to the copy offline.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
  // 4. Everything else: let the browser handle it normally.
});

async function serveAppShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(INDEX_URL);
  if (cached) return cached;

  // Cache missing (e.g. storage was cleared): try the network, then fail clearly.
  try {
    return await fetch(request);
  } catch {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Offline</title><body style="font-family:sans-serif;padding:24px">' +
      '<h1>Mawe Tatu Dairy</h1><p>The app is not saved on this phone yet. ' +
      'Open it once with an internet connection, then it will work offline.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    cache.put(request, response.clone()).catch(() => { /* quota: ignore */ });
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => { /* quota: ignore */ });
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
