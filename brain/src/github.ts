// The brain's own tools on GitHub and the servers, for the owner and admins.
// The GitHub token stays in this process: no shell command sees it (a push
// goes through push_branch, with the token in a header only for github.com).
//
// - github_status, push_branch (never main, never forced), open_pr: done now.
// - merge_pr, deploy, rollback, deploy_brain: never done on the model's word.
//   hooks.ts asks the owner (describe: what exactly, with the diff or the
//   commits), and approvals.ts does it once the owner answers the code
//   (execute), exactly as described. A deploy is the deploy-functions
//   workflow on GitHub Actions (a protected environment); the brain itself
//   is updated by deploy/update.sh on the server, with a health check and a
//   rollback when it fails.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitHub {
  token: string;
  /** owner/name */
  repo: string;
  workdir: string;
  deployDir: string;
  /** Where git and node live: no secrets in it. */
  env: Record<string, string>;
  fetch?: typeof fetch;
  git?: (args: string[], env: Record<string, string>) => Promise<{ code: number; out: string; err: string }>;
}

export class GitHubError extends Error {}

const DEPLOY_WORKFLOW = "deploy-functions.yml";
const FUNCTIONS = /^[a-z][a-z0-9-]{1,40}$/;
const SHA = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 7);

async function api<T = any>(g: GitHub, method: string, path: string, body?: unknown): Promise<T> {
  if (!g.token) throw new GitHubError("No GitHub token is set on the brain.");
  const f = g.fetch ?? fetch;
  const res = await f(`https://api.github.com/repos/${g.repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${g.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "iklipse-brain",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return undefined as T;
  const out = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new GitHubError(`GitHub: ${out?.message ?? res.status}`);
  return out as T;
}

function runGit(g: GitHub, args: string[], extra: Record<string, string> = {}) {
  if (g.git) return g.git(args, extra);
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile("git", ["-C", g.workdir, ...args], { env: { ...g.env, GIT_TERMINAL_PROMPT: "0", ...extra }, timeout: 120_000, maxBuffer: 4 << 20 }, (e, out, err) =>
      done({ code: e ? Number((e as { code?: number }).code ?? 1) || 1 : 0, out: String(out), err: String(err) }),
    );
  });
}

// ------------------------------------------------------------- right now --

export async function status(g: GitHub, x: { what?: string; number?: number }) {
  switch (x.what) {
    case "pr": {
      if (!x.number) throw new GitHubError("Which PR (its number)?");
      const pr = await api(g, "GET", `/pulls/${x.number}`);
      const checks = await api(g, "GET", `/commits/${pr.head.sha}/check-runs?per_page=50`);
      return {
        number: pr.number,
        title: pr.title,
        state: pr.merged ? "merged" : pr.state,
        url: pr.html_url,
        head: pr.head.ref,
        mergeable: pr.mergeable_state,
        checks: (checks.check_runs ?? []).map((c: any) => `${c.name}: ${c.conclusion ?? c.status}`),
      };
    }
    case "runs": {
      const r = await api(g, "GET", "/actions/runs?per_page=10");
      return (r.workflow_runs ?? []).map((w: any) => ({ name: w.name, title: w.display_title, status: w.status, conclusion: w.conclusion, url: w.html_url, sha: short(w.head_sha ?? "") }));
    }
    case "deploys":
      return (await deploys(g, 10)).map((d) => ({ ...d, sha: short(d.sha) }));
    default: {
      const prs = await api(g, "GET", "/pulls?state=open&per_page=30");
      return (prs ?? []).map((p: any) => ({ number: p.number, title: p.title, branch: p.head.ref, draft: p.draft, url: p.html_url }));
    }
  }
}

/** A branch name that isn't main and can't be read as an option. */
export function branchOk(b: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(b) && !/\.\.|\/\/|\.lock$|@\{/.test(b) && !/^(main|master|HEAD)$/i.test(b);
}

/** Pushes what's checked out to a branch (never main, never forced), with the token only for github.com. */
export async function pushBranch(g: GitHub, x: { branch: string }) {
  if (!branchOk(x.branch)) throw new GitHubError("Push to a branch of its own (not main), with a plain name.");
  const remote = await runGit(g, ["remote", "get-url", "origin"]);
  const want = new RegExp(`^https://github\\.com/${g.repo.replace(/[.]/g, "\\.")}(\\.git)?$`, "i");
  if (!want.test(remote.out.trim())) throw new GitHubError("The working copy's origin isn't the iklipse repo on GitHub.");
  const auth = Buffer.from(`x-access-token:${g.token}`).toString("base64");
  const r = await runGit(g, ["push", "origin", `HEAD:refs/heads/${x.branch}`], {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${auth}`,
  });
  const said = `${r.out}\n${r.err}`.replaceAll(auth, "…").trim().slice(-1500);
  if (r.code) throw new GitHubError(`The push failed: ${said}`);
  return { pushed: x.branch, said };
}

export async function openPr(g: GitHub, x: { branch: string; title: string; body: string }) {
  if (!branchOk(x.branch)) throw new GitHubError("A PR comes from a branch of its own (not main).");
  const pr = await api(g, "POST", "/pulls", {
    title: x.title.slice(0, 200),
    head: x.branch,
    base: "main",
    body: `${x.body.slice(0, 20_000)}\n\n🤖 Made by the iklipse brain`,
    maintainer_can_modify: true,
  });
  const files = await api(g, "GET", `/pulls/${pr.number}/files?per_page=100`);
  return { number: pr.number, url: pr.html_url, files: (files ?? []).map((f: any) => `${f.filename} +${f.additions} -${f.deletions}`) };
}

// ---------------------------------------------------- after the owner's OK --

interface Deploy {
  sha: string;
  target: string;
  url: string;
  at: string;
}

/** The deploys that went through, newest first (their title is "deploy <target> <sha>"). */
async function deploys(g: GitHub, n: number): Promise<Deploy[]> {
  const r = await api(g, "GET", `/actions/workflows/${DEPLOY_WORKFLOW}/runs?status=success&per_page=${n}`);
  return (r.workflow_runs ?? [])
    .map((w: any) => {
      const m = /^deploy (\w+) ([0-9a-f]{40})/.exec(String(w.display_title ?? ""));
      return m ? { target: m[1]!, sha: m[2]!, url: w.html_url, at: w.updated_at } : null;
    })
    .filter(Boolean) as Deploy[];
}

const functionsOf = (v: unknown) => {
  const list = (Array.isArray(v) ? v : ["whatsapp-bot"]).map(String);
  if (!list.length || !list.every((f) => FUNCTIONS.test(f))) throw new GitHubError("Which functions (their folder names)?");
  return [...new Set(list)];
};

/** What the owner is shown, and the exact input that will be done. */
export async function describe(g: GitHub, tool: string, x: Record<string, unknown>): Promise<{ input: Record<string, unknown>; what: string; detail: string }> {
  switch (tool) {
    case "merge_pr": {
      const n = Number(x.number);
      if (!Number.isInteger(n) || n < 1) throw new GitHubError("Which PR (its number)?");
      const pr = await api(g, "GET", `/pulls/${n}`);
      if (pr.state !== "open") throw new GitHubError(`PR #${n} isn't open.`);
      if (pr.base.ref !== "main") throw new GitHubError(`PR #${n} isn't into main.`);
      const [files, checks] = await Promise.all([api(g, "GET", `/pulls/${n}/files?per_page=100`), api(g, "GET", `/commits/${pr.head.sha}/check-runs?per_page=50`)]);
      const lines = (files ?? []).map((f: any) => `${f.filename} +${f.additions} -${f.deletions}`);
      const ci = (checks.check_runs ?? []).map((c: any) => `${c.name}: ${c.conclusion ?? c.status}`);
      return {
        input: { number: n, head_sha: pr.head.sha },
        what: `merge PR #${n} "${pr.title}" into main`,
        detail: [pr.html_url, `${lines.length} files:`, ...lines.slice(0, 40), ...(lines.length > 40 ? [`and ${lines.length - 40} more`] : []), `Checks: ${ci.join(", ") || "none yet"}`].join("\n"),
      };
    }
    case "deploy": {
      const target = String(x.target ?? "functions");
      if (!["functions", "db", "all"].includes(target)) throw new GitHubError("Deploy functions, db (the migrations) or all.");
      const functions = target === "db" ? [] : functionsOf(x.functions);
      const head = await api(g, "GET", "/commits/main");
      const sha = String(head.sha);
      const last = (await deploys(g, 20)).find((d) => d.target === target || d.target === "all");
      let since = "";
      if (last && last.sha !== sha) {
        const cmp = await api(g, "GET", `/compare/${last.sha}...${sha}`);
        const commits = (cmp.commits ?? []).map((c: any) => `${short(c.sha)} ${String(c.commit.message).split("\n")[0]}`);
        const migrations = (cmp.files ?? []).map((f: any) => String(f.filename)).filter((f: string) => f.startsWith("supabase/migrations/"));
        since = [`Since the last deploy (${short(last.sha)}): ${commits.length} commits`, ...commits.slice(-20), ...(migrations.length ? ["Migrations:", ...migrations] : [])].join("\n");
      }
      return {
        input: { target, sha, functions },
        what: `deploy ${target === "db" ? "the database migrations" : target === "all" ? `the migrations and ${functions.join(", ")}` : functions.join(", ")} at ${short(sha)} (main)`,
        detail: [`${short(sha)} ${String(head.commit.message).split("\n")[0]}`, since].filter(Boolean).join("\n"),
      };
    }
    case "rollback": {
      if (String(x.target ?? "functions") !== "functions") throw new GitHubError("Only the functions roll back: migrations only go forward.");
      const functions = functionsOf(x.functions);
      const done = (await deploys(g, 20)).filter((d) => d.target !== "db");
      const [now, before] = [done[0], done.find((d) => d.sha !== done[0]?.sha)];
      if (!now || !before) throw new GitHubError("There's no earlier deploy to go back to.");
      return {
        input: { target: "functions", sha: before.sha, functions },
        what: `roll back ${functions.join(", ")} from ${short(now.sha)} to ${short(before.sha)}`,
        detail: `Now: ${now.url}\nBack to: ${before.url}`,
      };
    }
    case "deploy_brain": {
      const head = await api(g, "GET", "/commits/main");
      const cur = existsSync(join(g.deployDir, "current")) ? readFileSync(join(g.deployDir, "current"), "utf8").trim() : "unknown";
      return {
        input: { sha: String(head.sha) },
        what: `update the brain to ${short(String(head.sha))} (main), from ${short(cur)}`,
        detail: `${short(String(head.sha))} ${String(head.commit.message).split("\n")[0]}\nIt restarts; if its health check fails it goes back to ${short(cur)} by itself.`,
      };
    }
  }
  throw new GitHubError(`${tool} isn't one of the brain's.`);
}

/**
 * Does what the owner OK'd, exactly (input as described). later: it finishes
 * on its own (a deploy running on GitHub, the brain restarting) and is told
 * then (report).
 */
export async function execute(
  g: GitHub,
  tool: string,
  input: Record<string, unknown>,
  o: { approvalId: string; report: (ok: boolean, result: string) => Promise<void>; waitMs?: number },
): Promise<{ later: true } | { later: false; ok: boolean; result: string }> {
  switch (tool) {
    case "merge_pr": {
      const r = await api(g, "PUT", `/pulls/${Number(input.number)}/merge`, { sha: String(input.head_sha), merge_method: "merge" });
      return { later: false, ok: r?.merged === true, result: r?.merged ? `Merged PR #${input.number} (${short(String(r.sha ?? ""))}).` : String(r?.message ?? "Not merged.") };
    }
    case "deploy":
    case "rollback": {
      const sha = String(input.sha);
      const functions = (input.functions as string[]) ?? [];
      if (!SHA.test(sha) || !functions.every((f) => FUNCTIONS.test(f))) throw new GitHubError("That deploy isn't valid.");
      const since = new Date(Date.now() - 5000).toISOString();
      await api(g, "POST", `/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, { ref: "main", inputs: { target: String(input.target), sha, functions: functions.join(" ") } });
      void follow(g, { sha, since, waitMs: o.waitMs }).then((r) => o.report(r.ok, r.result), (e) => o.report(false, (e as Error).message));
      return { later: true };
    }
    case "deploy_brain": {
      const sha = String(input.sha);
      if (!SHA.test(sha)) throw new GitHubError("That version isn't valid.");
      mkdirSync(g.deployDir, { recursive: true });
      // deploy/update.sh (a systemd path unit, as root) takes it from here, restarts the brain, and leaves result.json.
      writeFileSync(join(g.deployDir, "request.json"), JSON.stringify({ sha, approval_id: o.approvalId, at: new Date().toISOString() }));
      return { later: true };
    }
  }
  throw new GitHubError(`${tool} isn't one of the brain's.`);
}

/** Waits for the deploy run to end (polling GitHub), up to 25 minutes. */
async function follow(g: GitHub, o: { sha: string; since: string; waitMs?: number }) {
  const until = Date.now() + (o.waitMs ?? 25 * 60_000);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < until) {
    await pause(15_000);
    const r = await api(g, "GET", `/actions/workflows/${DEPLOY_WORKFLOW}/runs?event=workflow_dispatch&created=>=${o.since}&per_page=5`);
    const run = (r.workflow_runs ?? []).find((w: any) => String(w.display_title ?? "").includes(o.sha));
    if (run?.status === "completed") {
      return run.conclusion === "success" ? { ok: true, result: `Deployed ${short(o.sha)}: ${run.html_url}` } : { ok: false, result: `The deploy ${run.conclusion}: ${run.html_url}` };
    }
  }
  return { ok: false, result: "The deploy didn't finish in 25 minutes; check GitHub Actions." };
}

/** After a restart: what deploy/update.sh left about the brain's own update, to tell (and then forget). */
export function updateResult(deployDir: string): { approval_id: string; ok: boolean; message: string } | null {
  const file = join(deployDir, "result.json");
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as { approval_id?: string; ok?: boolean; message?: string };
    renameSync(file, `${file}.told`);
    return r.approval_id ? { approval_id: r.approval_id, ok: r.ok === true, message: String(r.message ?? "") } : null;
  } catch {
    return null;
  }
}
