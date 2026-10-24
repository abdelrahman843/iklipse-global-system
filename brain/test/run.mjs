// Runs the brain's tests (test/*.test.ts) with node --test and tsx, on any
// system: the shell isn't trusted to expand the pattern.
//   npm test
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => `${dir}${f}`);
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
