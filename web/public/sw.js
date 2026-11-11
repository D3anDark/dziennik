const SHELL = 'shell-v1';
const API = 'api-v1';
const MAX_ENTRIES = { [SHELL]: 40, [API]: 120 };

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const html = await (await fetch('/', { cache: 'no-cache' })).text();
      const cache = await caches.open(SHELL);
      await cache.put('/', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
      const assets = [...new Set([...html.matchAll(/\/assets\/[^"']+/g)].map((m) => m[0]))];
      await cache.addAll([...assets, '/manifest.webmanifest', '/icon.svg']);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (!(k in MAX_ENTRIES)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// Cache.keys() is in insertion order and put() re-inserts, so the head is the oldest write.
async function trim(cache, max) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}

async function store(name, req, res) {
  const cache = await caches.open(name);
  await cache.put(req, res);
  await trim(cache, MAX_ENTRIES[name]);
}

async function networkFirst(event, name) {
  const req = event.request;
  try {
    const res = await fetch(req);
    if (res.ok) event.waitUntil(store(name, req, res.clone()));
    return res;
  } catch (err) {
    const cache = await caches.open(name);
    const hit = (await cache.match(req)) ?? (req.mode === 'navigate' ? await cache.match('/') : undefined);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(event) {
  const hit = await caches.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok) event.waitUntil(store(SHELL, event.request, res.clone()));
  return res;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The server's build warning (main.rs) is read live: a stale copy could hide it.
  if (url.pathname === '/api/warning.js') return;
  if (url.pathname.startsWith('/api/')) event.respondWith(networkFirst(event, API));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(event));
  else event.respondWith(networkFirst(event, SHELL));
});

// A push is { title, body, url, tag? }, encrypted by the server. Browsers require a visible notification for every one;
// one with the tag of a shown one replaces it, and still sounds.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    // not ours: still has to show something
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Dziennik', { body: data.body || '', icon: '/icon-192.png', tag: data.tag, renotify: Boolean(data.tag), data: { url: data.url } }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    (async () => {
      const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))[0];
      if (!open) return self.clients.openWindow(url);
      // The app is a single page: it moves to the view itself instead of being reloaded.
      open.postMessage({ url });
      return open.focus();
    })(),
  );
});
