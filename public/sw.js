// Service worker: κάνει την εφαρμογή εγκαταστάσιμη και φορτώνει γρήγορα.
// Οι κλήσεις /api/ πάνε πάντα στον server (η παρουσία χρειάζεται internet).
const CACHE = 'parousies-v2';
const ASSETS = ['./', 'index.html', 'style.css', 'vendor/jsQR.js', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Πρώτα δίκτυο, αλλιώς cache.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
