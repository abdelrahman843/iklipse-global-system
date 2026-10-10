// -----------------------------------------------------------------------------
// Iklipse app-shell service worker (hand written, no build step).
//
// Lets the built app open with no network. Data never goes through here: the
// last-seen boards come from the IndexedDB query cache (src/lib/offlineCache.ts).
//
//   * navigations under the base path  -> network first, fall back to the
//                                          cached index.html
//   * <base>/assets/* (hashed, immutable) -> cache first
//   * Google Fonts (the only third-party files the shell needs, no user data)
//                                        -> cached, so text keeps its typeface
//   * pictures from Supabase storage (whiteboard images, card attachments,
//     avatars)                           -> kept by path (the link's token
//                                           changes, the file doesn't), so
//                                           boards seen before show them offline;
//                                           wiped on sign-out ("clear-media")
//   * everything else, including every other Supabase request (REST, auth,
//     realtime) and any other cross-origin URL -> not touched
//
// Registered from src/main.tsx in production with scope = Vite's base path.
// Bump VERSION to drop every cache this worker created.
// -----------------------------------------------------------------------------

const VERSION = "v1";
const SCOPE = new URL(self.registration.scope); // e.g. https://x.github.io/iklipse-global-system/
const BASE = SCOPE.pathname;
const ASSETS = BASE + "assets/";
const INDEX_URL = new URL("index.html", SCOPE).href;

// Cache names carry the base path: other apps on the same origin (GitHub Pages
// project sites share one) have their own caches, which we must never delete.
const PREFIX = "iklipse" + BASE;
const SHELL_CACHE = PREFIX + "shell-" + VERSION;
const FONT_CACHE = PREFIX + "fonts-" + VERSION;
const MEDIA_CACHE = PREFIX + "media-" + VERSION;
const MAX_MEDIA = 500;
const MAX_ASSETS = 60; // a few builds' worth; oldest are dropped first
const MAX_FONTS = 30;
const NAV_TIMEOUT_MS = 5000;
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

const isAssetUrl = (url) => url.origin === self.location.origin && url.pathname.startsWith(ASSETS);
const isShellPath = (url) => url.pathname === BASE || url.pathname === BASE + "index.html";
const MEDIA_PATH = /^\/storage\/v1\/object\/(sign|public|authenticated)\/(whiteboard|attachments|avatars)\//;
const isMediaUrl = (url) => /\.supabase\.co$/.test(url.hostname) && MEDIA_PATH.test(url.pathname);

async function trim(cache, max, keep) {
  const keys = (await cache.keys()).filter((r) => keep(new URL(r.url)));
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function cacheAsset(cache, url) {
  try {
    if (await cache.match(url, { ignoreVary: true })) return;
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok && res.type === "basic") await cache.put(url, res);
  } catch (_) {
    /* offline or gone: runtime caching will fill it in */
  }
}

// Install: cache index.html and the entry JS/CSS it references, so the app can
// open offline even if the first visit ends before any other request.
async function precacheShell() {
  const res = await fetch(SCOPE.href, { cache: "no-cache", credentials: "same-origin" });
  if (!res.ok || res.type !== "basic") return;
  const cache = await caches.open(SHELL_CACHE);
  const html = await res.clone().text();
  await cache.put(INDEX_URL, res);
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(m[1], SCOPE);
    if (isAssetUrl(url)) urls.add(url.href);
  }
  await Promise.all([...urls].map((u) => cacheAsset(cache, u)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precacheShell()
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, FONT_CACHE, MEDIA_CACHE];
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(PREFIX) && !keep.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

// The page lists the chunks it loaded before this worker took control.
self.addEventListener("message", (event) => {
  const data = event.data;
  // Signed out: pictures of that account go too.
  if (data && data.type === "clear-media") {
    event.waitUntil(caches.delete(MEDIA_CACHE));
    return;
  }
  if (!data || data.type !== "cache-urls" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = data.urls
        .slice(0, 100)
        .map((u) => {
          try {
            return new URL(String(u), SCOPE);
          } catch (_) {
            return null;
          }
        })
        .filter((u) => u && isAssetUrl(u) && !u.search)
        .map((u) => u.href);
      for (const u of urls) await cacheAsset(cache, u);
      await trim(cache, MAX_ASSETS, isAssetUrl);
    })(),
  );
});

// ---- strategies ----------------------------------------------------------------

async function cachedShell() {
  const cache = await caches.open(SHELL_CACHE);
  return cache.match(INDEX_URL);
}

function fetchShell(request, url) {
  return fetch(request).then(async (res) => {
    if (res.ok && res.type === "basic" && isShellPath(url)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(INDEX_URL, res.clone());
    }
    return res;
  });
}

async function shellResponse(network) {
  try {
    // Slow or flaky network: after a few seconds show the cached shell; the
    // network response still refreshes the cache when it lands.
    const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS, null));
    const first = await Promise.race([network, timeout]);
    if (first && first.status < 500) return first;
    const cached = await cachedShell();
    return cached || first || (await network);
  } catch (err) {
    const cached = await cachedShell();
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") {
    await cache.put(request, res.clone());
    await trim(cache, MAX_ASSETS, isAssetUrl);
  }
  return res;
}

async function fontResponse(event, url) {
  const request = event.request;
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(request);
  const refresh = () =>
    fetch(request).then(async (res) => {
      // The stylesheet is a no-cors request, so its response is opaque (status 0).
      if (res.ok || res.type === "opaque") {
        await cache.put(request, res.clone());
        await trim(cache, MAX_FONTS, () => true);
      }
      return res;
    });
  if (!hit) return refresh();
  // Font files never change: cache first. The stylesheet: serve the cached
  // copy and refresh it in the background.
  if (url.hostname === "fonts.googleapis.com") {
    try {
      event.waitUntil(refresh().catch(() => undefined));
    } catch (_) {
      /* event already settled: skip this refresh */
    }
  }
  return hit;
}

// Stored pictures: paths hold a fresh uuid per upload, so a path's file never
// changes: the kept copy answers first. Avatars can be replaced in place, so
// they show the kept copy and refresh it behind the scenes.
async function mediaResponse(event, url) {
  const key = url.origin + decodeURIComponent(url.pathname);
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(key);
  const fixed = !url.pathname.includes("/avatars/");
  if (hit && fixed) return hit;
  const network = fetch(url.href, { mode: "cors", credentials: "omit" }).then(async (res) => {
    if (res.ok && /^image\//.test(res.headers.get("content-type") || "")) {
      await cache.put(key, res.clone());
      await trim(cache, MAX_MEDIA, () => true);
    }
    return res;
  });
  if (hit) {
    try {
      event.waitUntil(network.catch(() => undefined));
    } catch (_) {
      /* event already settled */
    }
    return hit;
  }
  try {
    return await network;
  } catch (_) {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(BASE)) return;
    if (request.mode === "navigate") {
      const network = fetchShell(request, url);
      event.waitUntil(network.then(() => undefined, () => undefined));
      event.respondWith(shellResponse(network));
      return;
    }
    if (isAssetUrl(url) && !request.headers.has("range")) event.respondWith(cacheFirstAsset(request));
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(fontResponse(event, url));
    return;
  }
  if (isMediaUrl(url) && !request.headers.has("range")) {
    event.respondWith(mediaResponse(event, url));
  }
  // Any other cross-origin request (Supabase and the rest) goes straight to the network.
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
