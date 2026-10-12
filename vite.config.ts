import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// GitHub Pages hosts the built site at
//   https://<user>.github.io/<repo>/
// so every JS/CSS URL Vite generates must be prefixed with `/<repo>/`. We read
// the value from an env var so the prefix stays right whether we build for
// Pages, for a custom domain, or for local preview.
// -----------------------------------------------------------------------------
const REPO_BASE = "/iklipse-global-system/";

// Each build has an id: baked into the app (__BUILD_ID__) and written to
// version.json, which the running app checks to update itself
// (src/lib/appUpdate.ts) without anyone pressing refresh.
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const versionFile = (): Plugin => ({
  name: "iklipse-version-file",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ id: BUILD_ID }) });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, dirname, "");
  const base = env.VITE_BASE_PATH ?? (mode === "production" ? REPO_BASE : "/");

  return {
    base,
    plugins: [react(), versionFile()],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    resolve: {
      alias: { "@": path.resolve(dirname, "src") },
    },
    server: {
      port: 5173,
      host: true,
      allowedHosts: true,
      hmr: {
        // The HMR client needs to reach us via the same hostname the tester
        // typed into the browser; 443 is the tunnel's public HTTPS port.
        clientPort: 443,
      },
    },
    preview: { port: 4173, host: true },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
