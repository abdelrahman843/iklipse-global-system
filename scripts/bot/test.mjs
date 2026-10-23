// Runs the WhatsApp bot's tests (supabase/functions/whatsapp-bot/**/*.test.ts)
// on Node, without Deno: each test file is bundled by esbuild (it comes with
// Vite) and run with node --test. Deno.env is stubbed: no real key or secret
// is ever read, and nothing reaches the network (the tests stub fetch).
//   npm run test:bot

import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const bot = join(root, "supabase", "functions", "whatsapp-bot");
const out = join(tmpdir(), "iklipse-bot-tests");

const tests = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".test.ts")) tests.push(p);
  }
};
walk(bot);
if (!tests.length) {
  console.error("No tests found.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: tests,
  outdir: out,
  outbase: bot,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  // Before any module runs: what the bot reads with Deno.env.get.
  banner: { js: 'globalThis.Deno ??= { env: { get: (k) => ({ ANTHROPIC_API_KEY: "test-key" })[k] } };' },
  // supabase-js from node_modules in place of esm.sh, as in tsconfig.json (files.ts reaches _shared/oauth.ts).
  plugins: [
    {
      name: "esm-sh",
      setup(b) {
        b.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\/supabase-js@/ }, async () => ({
          path: (await b.resolve("@supabase/supabase-js", { kind: "import-statement", resolveDir: root })).path,
        }));
      },
    },
  ],
});

const files = tests.map((t) => join(out, relative(bot, t)).replace(/\.ts$/, ".mjs"));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
