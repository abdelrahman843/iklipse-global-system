// The brain: started by systemd (deploy/iklipse-brain.service) as its own
// non-root user. The secrets are read and taken out of the environment
// first (config.ts); the Anthropic key stays behind the local proxy.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { carryOut } from "./approvals.js";
import { botClient } from "./bot.js";
import { loadConfig } from "./config.js";
import { updateResult, type GitHub } from "./github.js";
import { keyProxy } from "./proxy.js";
import { Runner } from "./run.js";
import { brainServer } from "./server.js";
import { Sessions } from "./sessions.js";

const cfg = loadConfig();
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

for (const d of [cfg.stateDir, cfg.emptyDir, cfg.deployDir, join(cfg.stateDir, "home"), join(cfg.stateDir, "claude")]) mkdirSync(d, { recursive: true, mode: 0o700 });

const proxy = await keyProxy({ key: cfg.anthropicKey });
const bot = botClient({ url: cfg.botUrl, secret: cfg.secret });
const github: GitHub | null = cfg.githubToken
  ? { token: cfg.githubToken, repo: cfg.repo, workdir: cfg.workdir, deployDir: cfg.deployDir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(cfg.stateDir, "home"), LANG: "C.UTF-8" } }
  : null;
const runner = new Runner({ cfg, bot, sessions: new Sessions(join(cfg.stateDir, "sessions.json")), github, proxy, log });

// The kill switch as it is now (the function keeps it).
try {
  runner.setStopped((await bot.call<{ stopped: boolean }>("_state", {})).stopped);
} catch (e) {
  log({ ev: "brain.state_unknown", why: (e as Error).message });
}

/** After updating itself (deploy/update.sh): what came of it, told once it's up. */
async function tellUpdate() {
  const updated = updateResult(cfg.deployDir);
  if (!updated) return;
  const result = updated.message || (updated.ok ? `The brain runs ${version} now.` : "The update failed; it went back.");
  await bot.call("_approval_done", { approval_id: updated.approval_id, ok: updated.ok, result }).catch((e) => log({ ev: "brain.update_untold", why: (e as Error).message }));
}

const server = brainServer({
  secret: cfg.secret,
  version,
  message: (m) => runner.accept(m),
  approval: (id) => void carryOut({ bot, github, approvalId: id, log }),
  control: (stopped) => {
    runner.setStopped(stopped);
    log({ ev: "brain.control", stopped });
  },
  state: () => ({ busy: runner.busy, stopped: runner.stopped }),
});
server.listen(cfg.port, cfg.host, () => {
  log({ ev: "brain.up", port: cfg.port, version });
  void tellUpdate();
});

const down = () => {
  log({ ev: "brain.down" });
  runner.setStopped(true);
  server.close();
  proxy.close();
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", down);
process.on("SIGINT", down);
