// What the brain needs to run. Settings come from the environment (the
// systemd unit); the secrets come from the file systemd hands the service
// ($CREDENTIALS_DIRECTORY/brain.env, from a root-only file), read once into
// memory and taken out of process.env, so nothing the brain starts (Claude
// Code, a shell command) inherits them. Without that file (a developer's
// machine) they're read from the environment and taken out the same way.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  /** The whatsapp-bot function: https://<project>.supabase.co/functions/v1/whatsapp-bot */
  botUrl: string;
  secret: string;
  anthropicKey: string;
  githubToken: string;
  /** owner/name */
  repo: string;
  /** The brain's working copy of the repo: the owner's and admins' files and shell. */
  workdir: string;
  /** Where members' runs start: an empty folder (they have no files or shell). */
  emptyDir: string;
  /** Sessions, Claude Code's own config and home. */
  stateDir: string;
  /** Where a self-update is asked for and answered (deploy/update.sh). */
  deployDir: string;
  /** Runs at once, all chats together. */
  maxRuns: number;
  /** Hosts a shell command may reach besides GitHub, npm, Anthropic and the docs. */
  wahaHost: string | null;
  supabaseHost: string;
}

/** Secrets: never left in process.env. */
export const SECRET_KEYS = ["BRAIN_SECRET", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"] as const;

/** KEY=value lines (a value may be quoted); # comments and blank lines skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

const need = (v: string | undefined, name: string) => {
  if (!v) throw new Error(`${name} isn't set`);
  return v;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, "brain.env") : "";
  const secrets = file && existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const take = (k: (typeof SECRET_KEYS)[number]) => {
    const v = secrets[k] ?? env[k];
    delete env[k];
    return v;
  };
  const secret = need(take("BRAIN_SECRET"), "BRAIN_SECRET");
  if (secret.length < 32) throw new Error("BRAIN_SECRET must be at least 32 characters");
  const botUrl = need(env.BOT_URL, "BOT_URL").replace(/\/+$/, "");
  if (!/^https:\/\//.test(botUrl)) throw new Error("BOT_URL must be https");
  const state = env.BRAIN_STATE ?? "/var/lib/iklipse-brain";
  return {
    port: Number(env.BRAIN_PORT ?? 8787),
    host: env.BRAIN_HOST ?? "127.0.0.1",
    botUrl,
    secret,
    anthropicKey: need(take("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY"),
    githubToken: take("GITHUB_TOKEN") ?? "",
    repo: env.GITHUB_REPO ?? "abdelrahman843/iklipse-global-system",
    workdir: env.BRAIN_WORKDIR ?? "/srv/iklipse-brain/work",
    emptyDir: env.BRAIN_EMPTY ?? join(state, "empty"),
    stateDir: state,
    deployDir: env.BRAIN_DEPLOY ?? join(state, "deploy"),
    maxRuns: Math.max(1, Math.min(10, Number(env.BRAIN_MAX_RUNS ?? 3))),
    wahaHost: env.WAHA_HOST || null,
    supabaseHost: new URL(botUrl).host,
  };
}
