import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { ToastProvider } from "./components/ui/Toast";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { Tooltips } from "./components/ui/Tooltips";
import { InstallBanner } from "./components/InstallApp";
import "./index.css";
// Catches the browser's install prompt before anything renders.
import "./lib/pwa";
import { startAutoUpdate } from "./lib/appUpdate";

// HashRouter — the app deploys to GitHub Pages, which serves static files
// only, so client-side path routes 404 on refresh. Hash routing keeps every
// URL under `#/...` and works on any static host without a server rewrite rule.

// Online only: every query and mutation goes to the network, and fails with
// an error when there is none (no pausing, nothing kept for later).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Kept half an hour after a page closes (warmup.ts loads some ahead): coming back shows it at once.
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <ConfirmProvider>
                <App />
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

// The app used to keep an offline copy on the device. Drop what an older
// version left behind: its database, its cached files (this app's only; other
// apps on the same GitHub Pages origin keep theirs) and its "changes waiting" flag.
const cachePrefix = `iklipse${import.meta.env.BASE_URL}`;
for (const drop of [
  () => indexedDB.deleteDatabase("iklipse-offline"),
  () => localStorage.removeItem("iklipse.outbox.waiting"),
  () =>
    window.caches
      ?.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(cachePrefix)).map((n) => caches.delete(n))))
      .catch(() => undefined),
]) {
  try {
    void drop();
  } catch {
    /* storage blocked */
  }
}

// New versions load by themselves (no refresh needed).
startAutoUpdate();

// Service worker (public/sw.js): push notifications, and the page always asked
// fresh from the server. Production only: it registers at Vite's base path.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const base = import.meta.env.BASE_URL;
  const register = () => void navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => undefined);
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
