const CACHE = "ski-tracker-v4-shell";
const ASSETS = ["/","/style.css","/app.js","/manifest.webmanifest","/icon.svg"];
self.addEventListener("install", (evt) => {
  evt.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (evt) => evt.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (evt) => {
  const url = new URL(evt.request.url);
  if (url.origin === location.origin) {
    evt.respondWith(caches.match(evt.request).then(hit => hit || fetch(evt.request).catch(() => caches.match("/"))));
  }
});
