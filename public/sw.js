// -----------------------------------------------------------------------------
// Iklipse service worker (hand written, no build step).
//
// The app works online only: nothing is cached here. The worker
//   * delivers push notifications (below)
//   * asks the server for the page itself on every visit (cache: no-cache, a
//     quick "not modified" when nothing changed): GitHub Pages lets browsers
//     keep it 10 minutes, which kept an installed app on the old version
//     that long (src/lib/appUpdate.ts reloads into new versions)
//   * deletes the caches older versions made for offline use
// Every other request goes straight to the network, untouched.
//
// Registered from src/main.tsx in production with scope = Vite's base path.
// -----------------------------------------------------------------------------

const SCOPE = new URL(self.registration.scope); // e.g. https://x.github.io/iklipse-global-system/
const BASE = SCOPE.pathname;

// Cache names older versions used carry the base path: other apps on the same
// origin (GitHub Pages project sites share one) have their own caches, which
// we must never delete.
const OLD_CACHES = "iklipse" + BASE;

const isShellPath = (url) => url.pathname === BASE || url.pathname === BASE + "index.html";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(OLD_CACHES)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !isShellPath(url)) return;
  event.respondWith(fetch(url.href, { cache: "no-cache", credentials: "same-origin" }));
});

// ------------------------------------------------------------------ push --
// Notifications sent by the push-send edge function. Payload:
// { title, body, url, tag, product }. Tapping one focuses an open iklipse
// window and moves it to the card / board, or opens the app there.
self.addEventListener("push", (event) => {
  let n = {};
  try {
    n = event.data ? event.data.json() : {};
  } catch (e) {
    n = { title: "iklipse", body: event.data ? event.data.text() : "" };
  }
  const icon = new URL("icons/icon-192.png", SCOPE).href;
  event.waitUntil(
    self.registration.showNotification(n.title || "iklipse", {
      body: n.body || "",
      icon,
      badge: new URL("icons/badge-96.png", SCOPE).href,
      tag: n.tag || undefined,
      data: { url: n.url || SCOPE.href },
      timestamp: Date.now(),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || SCOPE.href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = wins.find((w) => w.url.startsWith(SCOPE.href));
      if (mine) {
        await mine.focus();
        // Same app: let the page route there without a reload.
        mine.postMessage({ type: "open-url", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The browser replaced this device's push subscription: the page re-registers
// it with the server on its next start (src/lib/push.ts).
self.addEventListener("pushsubscriptionchange", () => {});
