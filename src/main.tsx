import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { ToastProvider } from "./components/ui/Toast";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { SyncStatus } from "./components/SyncStatus";
import { Tooltips } from "./components/ui/Tooltips";
import { InstallBanner } from "./components/InstallApp";
import { restorePersistedCache, setupOnlineManager, startCachePersistence } from "./lib/offlineCache";
import { startOfflinePrefetch } from "./lib/offline/prefetch";
import "./index.css";
// Catches the browser's install prompt before anything renders.
import { isStandalone } from "./lib/pwa";

// HashRouter — the app deploys to GitHub Pages, which serves static files
// only, so client-side path routes 404 on refresh. Hash routing keeps every
// URL under `#/...` and works on any static host without a server rewrite rule.

// Seed TanStack's online state before any query runs. Queries keep the
// default networkMode ("online"): offline they pause and show the saved copy
// instead of failing. Mutations always run: offline their writes go to the
// outbox (lib/offline/outbox.ts) and the screen keeps the change.
setupOnlineManager();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: { networkMode: "always" },
  },
});

function render() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <ThemeProvider>
            <AuthProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <App />
                  <SyncStatus />
                  <Tooltips />
                  <InstallBanner />
                </ConfirmProvider>
              </ToastProvider>
            </AuthProvider>
          </ThemeProvider>
        </HashRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

// Put the last-seen boards back before the first paint, so they show even
// with no network. Restoring is capped at ~1.5 s and never throws.
void restorePersistedCache(queryClient).finally(() => {
  startCachePersistence(queryClient);
  startOfflinePrefetch(queryClient);
  render();
});

// Installed app: ask the browser to keep this site's storage under disk
// pressure, so changes waiting in the outbox are never evicted. Installed
// apps get it without a prompt (a plain tab in Firefox would ask, so only here).
if (isStandalone()) void navigator.storage?.persisted?.().then((kept) => kept || navigator.storage.persist()).catch(() => undefined);

// Service worker (public/sw.js) caches the app shell so the app opens offline.
// Production only: in dev it would cache Vite's unhashed modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const base = import.meta.env.BASE_URL;
  const register = () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Hand over the files this page already loaded (before the worker was
        // in control), so even the first offline visit has every chunk.
        const assets = new URL(`${base}assets/`, location.href).href;
        const urls = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => u.startsWith(assets));
        reg.active?.postMessage({ type: "cache-urls", urls });
      })
      .catch(() => undefined);
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
