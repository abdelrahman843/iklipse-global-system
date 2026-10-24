// The brain's GitHub tools (github.ts): never main, never forced, the token
// only for github.com and never in what's said back; what the owner OK'd is
// done exactly (a merge pinned to the head they saw).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOk, execute, pushBranch, updateResult, type GitHub } from "../src/github.js";

const TOKEN = ["gh", "s_", "x".repeat(20)].join("");

function gh(o: Partial<GitHub> = {}) {
  const runs: { args: string[]; env: Record<string, string> }[] = [];
  const g: GitHub = {
    token: TOKEN,
    repo: "abdelrahman843/iklipse-global-system",
    workdir: "/w",
    deployDir: mkdtempSync(join(tmpdir(), "brain-d-")),
    env: { PATH: "/usr/bin" },
    git: async (args, env) => {
      runs.push({ args, env });
      if (args[0] === "remote") return { code: 0, out: "https://github.com/abdelrahman843/iklipse-global-system.git\n", err: "" };
      return { code: 0, out: "", err: `To https://github.com/x\n * [new branch] HEAD -> fix/a ${env.GIT_CONFIG_VALUE_1 ?? ""}` };
    },
    ...o,
  };
  return { g, runs };
}

test("branch names: never main, nothing that reads as an option", () => {
  for (const b of ["fix/reminders", "feat/brain-2", "a"]) assert.equal(branchOk(b), true, b);
  for (const b of ["main", "MAIN", "master", "HEAD", "-f", "--force", "a..b", "x.lock", ""]) assert.equal(branchOk(b), false, b);
});

test("a push: its own branch, the token in a header for github.com only, never said back", async () => {
  const { g, runs } = gh();
  const r = await pushBranch(g, { branch: "fix/a" });
  const push = runs.find((x) => x.args[0] === "push")!;
  assert.deepEqual(push.args, ["push", "origin", "HEAD:refs/heads/fix/a"]);
  assert.equal(push.env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
  assert.equal(push.env.GIT_CONFIG_VALUE_0, "");
  assert.ok(!push.args.some((a) => /force|-f/.test(a)));
  assert.ok(!r.said.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64")));
  await assert.rejects(pushBranch(g, { branch: "main" }));
});

test("a push refuses a working copy whose origin was changed", async () => {
  const { g } = gh({ git: async (args) => ({ code: 0, out: args[0] === "remote" ? "https://evil.example.com/x.git" : "", err: "" }) });
  await assert.rejects(pushBranch(g, { branch: "fix/a" }), /origin/);
});

test("a merge after the OK is pinned to the head the owner saw", async () => {
  const sent: { url: string; body: unknown }[] = [];
  const { g } = gh({
    fetch: (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ merged: true, sha: "b".repeat(40) });
    }) as typeof fetch,
  });
  const r = await execute(g, "merge_pr", { number: 7, head_sha: "a".repeat(40) }, { approvalId: "a1", report: async () => {} });
  assert.deepEqual(r, { later: false, ok: true, result: "Merged PR #7 (bbbbbbb)." });
  assert.match(sent[0]!.url, /\/pulls\/7\/merge$/);
  assert.deepEqual(sent[0]!.body, { sha: "a".repeat(40), merge_method: "merge" });
});

test("the brain's own update: asked of the server, told after the restart, once", async () => {
  const { g } = gh();
  const r = await execute(g, "deploy_brain", { sha: "c".repeat(40) }, { approvalId: "a9", report: async () => {} });
  assert.deepEqual(r, { later: true });
  assert.equal(JSON.parse(readFileSync(join(g.deployDir, "request.json"), "utf8")).approval_id, "a9");
  writeFileSync(join(g.deployDir, "result.json"), JSON.stringify({ approval_id: "a9", ok: true, message: "Now at ccccccc." }));
  assert.deepEqual(updateResult(g.deployDir), { approval_id: "a9", ok: true, message: "Now at ccccccc." });
  assert.equal(updateResult(g.deployDir), null);
  assert.ok(existsSync(join(g.deployDir, "result.json.told")));
});

test("a deploy must be a commit and plain function names", async () => {
  const { g } = gh({ fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
  await assert.rejects(execute(g, "deploy", { target: "functions", sha: "main", functions: ["whatsapp-bot"] }, { approvalId: "a1", report: async () => {} }));
  await assert.rejects(execute(g, "deploy", { target: "functions", sha: "d".repeat(40), functions: ["x; rm -rf /"] }, { approvalId: "a1", report: async () => {} }));
});
