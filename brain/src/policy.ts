// What each tier may use, and what's refused before it runs (hooks.ts). The
// function checks its own tools again on every call (brain-tools.ts); these
// rules are for what runs here: the shell, the files, the web, GitHub.
//
// - owner: everything, deploys and the brain's own settings too.
// - admin: the same, except deploys, rollbacks and the brain's settings.
// - member: iklipse's tools as themselves; no shell, no files, no GitHub.
// Shell commands also run in the SDK sandbox (run.ts): writes only in the
// working copy, the network only to the hosts listed there.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type Tier = "owner" | "admin" | "member";

const ALL: Tier[] = ["owner", "admin", "member"];
const ADMINS: Tier[] = ["owner", "admin"];
const OWNER: Tier[] = ["owner"];

export interface ToolRule {
  tiers: Tier[];
  /** Only reads: allowed while the brain is stopped. */
  readOnly: boolean;
  /** Waits for the owner's OK (asked by hooks.ts, done by approvals.ts). */
  held?: boolean;
}

/** The function's tools (brain-tools.ts), as mcp__iklipse__<name>. Held ones there are held by the function itself. */
export const SERVER_TOOLS: Record<string, ToolRule> = {
  find: { tiers: ALL, readOnly: true },
  search: { tiers: ALL, readOnly: true },
  overview: { tiers: ALL, readOnly: true },
  free_times: { tiers: ALL, readOnly: true },
  reminders: { tiers: ALL, readOnly: true },
  boards_tools: { tiers: ALL, readOnly: true },
  taught: { tiers: ADMINS, readOnly: true },
  brain_log: { tiers: ADMINS, readOnly: true },
  message_team_member: { tiers: ALL, readOnly: false },
  set_reminder: { tiers: ALL, readOnly: false },
  cancel_reminders: { tiers: ALL, readOnly: false },
  close_alert: { tiers: ALL, readOnly: false },
  meeting: { tiers: ALL, readOnly: false },
  // The function lets read-only board tools through while stopped.
  boards: { tiers: ALL, readOnly: true },
  message_client: { tiers: ALL, readOnly: false },
  alert_pause: { tiers: ADMINS, readOnly: false },
  post_in_group: { tiers: ADMINS, readOnly: false },
  remember: { tiers: ADMINS, readOnly: false },
  forget: { tiers: ADMINS, readOnly: false },
  bot_settings: { tiers: ADMINS, readOnly: false },
  brain_settings: { tiers: OWNER, readOnly: false },
};

/** The brain's own tools (github.ts). */
export const OWN_TOOLS: Record<string, ToolRule> = {
  github_status: { tiers: ADMINS, readOnly: true },
  push_branch: { tiers: ADMINS, readOnly: false },
  open_pr: { tiers: ADMINS, readOnly: false },
  merge_pr: { tiers: ADMINS, readOnly: false, held: true },
  deploy: { tiers: OWNER, readOnly: false, held: true },
  rollback: { tiers: OWNER, readOnly: false, held: true },
  deploy_brain: { tiers: OWNER, readOnly: false, held: true },
};

/** Claude Code's own tools, for the owner and admins only. */
export const BUILTINS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebFetch", "TodoWrite"];
const READ_BUILTINS = new Set(["Read", "Glob", "Grep", "WebFetch", "TodoWrite"]);

export const MCP = "mcp__iklipse__";

export const builtinsFor = (tier: Tier) => (tier === "member" ? [] : [...BUILTINS]);

/** Every tool this tier may call (allowedTools; with dontAsk, anything else is refused). */
export function allowedToolsFor(tier: Tier): string[] {
  const mcp = Object.entries({ ...SERVER_TOOLS, ...OWN_TOOLS })
    .filter(([, r]) => r.tiers.includes(tier))
    .map(([n]) => `${MCP}${n}`);
  return [...builtinsFor(tier), ...mcp];
}

/** Never offered at all: other agents (they'd run with their own rules), the web search, notebooks. */
export const DISALLOWED = ["Agent", "Task", "WebSearch", "NotebookEdit", "KillShell", "BashOutput"];

export type Verdict = { ok: true } | { ok: false; why: string };
const no = (why: string): Verdict => ({ ok: false, why });
const yes: Verdict = { ok: true };

/** May this tier call this tool now (while stopped: reading only). */
export function toolVerdict(tool: string, tier: Tier, stopped: boolean): Verdict {
  if (tool.startsWith(MCP)) {
    const name = tool.slice(MCP.length);
    const r = SERVER_TOOLS[name] ?? OWN_TOOLS[name];
    if (!r) return no(`There's no tool ${name}.`);
    if (!r.tiers.includes(tier)) return no(`${name} isn't for ${tier === "member" ? "members" : "admins"}.`);
    if (stopped && !r.readOnly) return no("The brain is stopped: it only reads until the owner says start.");
    return yes;
  }
  if (!builtinsFor(tier).includes(tool)) return no(`${tool} isn't for ${tier === "member" ? "members" : "this run"}.`);
  if (stopped && !READ_BUILTINS.has(tool)) return no("The brain is stopped: it only reads until the owner says start.");
  return yes;
}

export const isHeld = (tool: string) => tool.startsWith(MCP) && !!OWN_TOOLS[tool.slice(MCP.length)]?.held;

// ------------------------------------------------------------------ shell --

/** Commands refused whatever the sandbox would do: the GitHub token, deploys and secrets go only through the brain's own tools. */
const SHELL_DENY: [RegExp, string][] = [
  [/\bgit\s+(?:-\S+\s+)*push\b/, "Push with push_branch (never main, never forced)."],
  [/(^|[\s;&|(`$])gh(\s|$)/, "Use the GitHub tools (github_status, open_pr...)."],
  // The CLI, not a path with "supabase" in it.
  [/(^|[\s;&|(`$])supabase\s+(?!--version\b)\S/, "Deploys and the database go through deploy, after the owner's OK."],
  [/(^|[\s;&|(`$])(sudo|su|doas|pkexec)(\s|$)/, "No root."],
  [/(^|[\s;&|(`$])(ssh|scp|sftp|rsync|nc|ncat|socat|telnet)(\s|$)/, "No remote shells or raw connections."],
  [/(^|[\s;&|(`$])(systemctl|service|journalctl|crontab|at|shutdown|reboot|kill|pkill|killall)(\s|$)/, "Not the server's services or processes."],
  [/(^|[\s;&|(`$])(docker|podman|nsenter|unshare|chroot|mount)(\s|$)/, "Not containers or mounts."],
  [/(^|[\s;&|(`$])(env|printenv|set|export\s+-p|declare\s+-p)(\s*($|[;&|)]))/, "The environment isn't read."],
  [/\/proc\/|\/sys\/|\/run\/credentials|\/etc\/|\/root\b|~\/\.ssh|\.ssh\/|\$HOME|~\//, "That's outside the working copy."],
  [/(^|[\s/'"])\.env(\.|\b|$)|\.git-credentials|\.netrc|\.npmrc|id_(rsa|ed25519|ecdsa)|\.pem\b|\.p12\b/, "Secrets aren't read."],
  [/\bnpm\s+(publish|login|adduser|token)\b|\bnpx\s+--yes\s+(?!tsc|tsx|vite|esbuild)/, "Not publishing or logging in."],
  [/--force\b|--force-with-lease\b|\bpush\s+-f\b/, "Nothing forced."],
  [/\b(curl|wget)\b[^|;&]*\s(-d|--data|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))\b/i, "Nothing sent out from the shell."],
];

/** Absolute paths a command may name outside the working copy: tools and scratch, never home or system config. */
const OUTSIDE_OK = ["/tmp", "/usr", "/bin", "/sbin", "/lib", "/opt/node", "/dev/null", "/dev/stdout", "/dev/stderr"];

/** A shell command, before it runs (the sandbox holds it too). workdir: the working copy (POSIX). */
export function bashVerdict(command: string, workdir: string): Verdict {
  const c = command.replace(/\\\n/g, " ");
  for (const [re, why] of SHELL_DENY) if (re.test(c)) return no(why);
  // rm -r on anything that isn't inside the working copy by a relative path.
  if (/\brm\s+(-\w*[rR]\w*|--recursive)\b/.test(c) && /\brm\s+[^;&|]*(\s\/|\s~|\s\.\.(\/|\s|$)|\s\*(\s|$))/.test(c)) return no("rm -r only inside the working copy, by a path in it.");
  for (const m of c.matchAll(/(^|[\s='"(:])(\/[\w.@+-][^\s'";&|)]*)/g)) {
    const p = m[2]!;
    if (p === workdir || p.startsWith(`${workdir}/`)) continue;
    if (OUTSIDE_OK.some((o) => p === o || p.startsWith(`${o}/`))) continue;
    return no(`${p} is outside the working copy.`);
  }
  return yes;
}

// ------------------------------------------------------------------ files --

const SECRET_FILE = /^(\.env(\..*)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|keystore))$/i;

/** The real path, following links, of a path or (not made yet) its nearest folder that exists. */
function real(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    rest.unshift(basename(cur));
    cur = up;
  }
  return resolve(realpathSync.native(cur), ...rest);
}

/** Inside the working copy, after links. */
export function inside(workdir: string, p: string): boolean {
  const root = real(resolve(workdir));
  const target = real(isAbsolute(p) ? p : resolve(workdir, p));
  const r = relative(root, target);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.startsWith(`..${sep}`));
}

/** Read, Edit, Write, Glob, Grep: only in the working copy, never a secret file. */
export function pathVerdict(tool: string, input: Record<string, unknown>, workdir: string): Verdict {
  const paths: string[] = [];
  const add = (v: unknown) => typeof v === "string" && v && paths.push(v);
  add(input.file_path);
  add(input.notebook_path);
  add(input.path);
  if (tool === "Glob" || tool === "Grep") {
    const pattern = String(input.pattern ?? input.glob ?? "");
    if (/(^|\/)\.\.(\/|$)/.test(pattern) || isAbsolute(pattern) || pattern.startsWith("~")) return no("Search only inside the working copy.");
    if (/\.env|id_rsa|\.pem|\.npmrc|\.netrc/i.test(pattern) && tool === "Glob") return no("Secrets aren't read.");
  }
  for (const p of paths) {
    if (p.startsWith("~") || /^\\\\|^\/\//.test(p)) return no(`${p} is outside the working copy.`);
    if (!inside(workdir, p)) return no(`${p} is outside the working copy.`);
    if (SECRET_FILE.test(basename(p))) return no("Secrets aren't read.");
    if (/[\\/]\.git[\\/]config$/.test(p) && tool !== "Read") return no("The repository's own config isn't changed.");
  }
  return yes;
}

// -------------------------------------------------------------------- web --

/** Pages the brain may read: docs, and the code's own homes. */
export const WEB_HOSTS = [
  "code.claude.com",
  "docs.claude.com",
  "docs.anthropic.com",
  "platform.claude.com",
  "supabase.com",
  "github.com",
  "raw.githubusercontent.com",
  "docs.github.com",
  "nodejs.org",
  "developer.mozilla.org",
  "docs.deno.com",
  "deno.land",
  "www.npmjs.com",
  "waha.devlike.pro",
  "green-api.com",
  "developer.calendly.com",
  "developers.google.com",
  "react.dev",
  "tanstack.com",
  "vitejs.dev",
  "tailwindcss.com",
];

export function fetchVerdict(url: unknown): Verdict {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return no("That isn't a web address.");
  }
  if (u.protocol !== "https:") return no("https only.");
  const host = u.hostname.toLowerCase();
  if (!WEB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return no(`${host} isn't one of the sites the brain reads (docs and GitHub).`);
  return yes;
}
