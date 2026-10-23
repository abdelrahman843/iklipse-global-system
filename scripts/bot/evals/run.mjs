// Replays the bot's eval set (scripts/bot/evals/cases) against the real Claude
// API and prints each case's pass or fail and the cost (replay.ts). Opt-in:
// it costs money, so it runs only with --real and ANTHROPIC_API_KEY set in
// the environment (never printed). Not part of CI.
//   npm run eval:bot -- --real
//   npm run eval:bot -- --real --only=route        (route, alerts, reply, booking)
//   npm run eval:bot -- --real --case=remind-03
// EVAL_MODEL_FAST / EVAL_MODEL_MAIN try other models for the fast and main jobs.

import { build } from "esbuild";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const here = join(root, "scripts", "bot", "evals");
const args = process.argv.slice(2);
const count = readdirSync(join(here, "cases"))
  .filter((f) => f.endsWith(".json"))
  .reduce((n, f) => n + JSON.parse(readFileSync(join(here, "cases", f), "utf8")).length, 0);

if (!args.includes("--real")) {
  console.log(`${count} cases. They run against the real Claude API and cost money (a few cents for all of them).`);
  console.log("Run them with: npm run eval:bot -- --real   (ANTHROPIC_API_KEY set in the environment)");
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in the environment first.");
  process.exit(1);
}

const out = join(tmpdir(), "iklipse-bot-evals");
rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [join(here, "replay.ts")],
  outfile: join(out, "replay.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
  // What the bot reads with Deno.env.get: the environment.
  banner: { js: "globalThis.Deno ??= { env: { get: (k) => process.env[k] } };" },
});
const r = spawnSync(process.execPath, [join(out, "replay.mjs"), ...args], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
