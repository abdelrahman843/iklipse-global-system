import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Unit tests (npm test). Same "@" alias as vite.config.ts. Tests run in node;
// a test file that needs a DOM (DOMParser for SVG import) opts into jsdom
// with a `// @vitest-environment jsdom` comment at its top.
// -----------------------------------------------------------------------------

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(dirname, "src") },
  },
  define: { __BUILD_ID__: JSON.stringify("test") },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
