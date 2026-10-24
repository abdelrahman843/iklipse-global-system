// Where the keys stay: the secrets out of the environment once read
// (config.ts), the Anthropic key behind the local proxy (proxy.ts), and an
// OK done only on the very input the owner saw (approvals.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryOut } from "../src/approvals.js";
import type { BotClient } from "../src/bot.js";
import { loadConfig, parseEnvFile } from "../src/config.js";
import { keyProxy } from "../src/proxy.js";
import { canonical, sha256 } from "../src/sign.js";

test("the secrets come from systemd's file and leave the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-c-"));
  writeFileSync(join(dir, "brain.env"), `# brain\nBRAIN_SECRET="${"s".repeat(40)}"\nANTHROPIC_API_KEY=test-key\nGITHUB_TOKEN=test-token\n`);
  const env: NodeJS.ProcessEnv = { CREDENTIALS_DIRECTORY: dir, BOT_URL: "https://x.supabase.co/functions/v1/whatsapp-bot", ANTHROPIC_API_KEY: "from-env" };
  const c = loadConfig(env);
  assert.equal(c.secret, "s".repeat(40));
  assert.equal(c.anthropicKey, "test-key");
  assert.equal(c.githubToken, "test-token");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(c.supabaseHost, "x.supabase.co");
  assert.deepEqual(parseEnvFile("A=1\n#B=2\n export C='3'"), { A: "1", C: "3" });
  assert.throws(() => loadConfig({ BOT_URL: "https://x", BRAIN_SECRET: "short", ANTHROPIC_API_KEY: "k" }));
});

test("the proxy answers only its own token, and only the API", async () => {
  const p = await keyProxy({ key: "real-key", host: "127.0.0.1" });
  try {
    assert.equal((await fetch(`${p.url}/v1/messages`, { method: "POST", headers: { "x-api-key": "wrong" } })).status, 401);
    assert.equal((await fetch(`${p.url}/v1/messages`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${p.url}/other`, { headers: { "x-api-key": p.token } })).status, 404);
  } finally {
    p.close();
  }
});

test("an OK is done only on the input the owner saw", async () => {
  const calls: { name: string; payload: Record<string, unknown> }[] = [];
  const input = { number: 7, head_sha: "a".repeat(40) };
  const bot: BotClient = {
    async call<T>(name: string, payload: Record<string, unknown>) {
      calls.push({ name, payload });
      if (name === "_approval_claim") return { tool: "merge_pr", input: { ...input, number: 8 }, input_hash: sha256(canonical(input)) } as T;
      return { ok: true } as T;
    },
  };
  let merged = false;
  const github = { token: "t", repo: "o/r", workdir: "/w", deployDir: "/d", env: {}, fetch: (async () => ((merged = true), Response.json({ merged: true }))) as unknown as typeof fetch };
  await carryOut({ bot, github, approvalId: "a1", log: () => {} });
  assert.equal(merged, false);
  const done = calls.find((c) => c.name === "_approval_done")!;
  assert.equal(done.payload.ok, false);
});
