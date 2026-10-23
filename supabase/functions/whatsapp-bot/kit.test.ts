// Calls to Claude (kit.ts) against a stubbed fetch: a busy moment is tried
// again, a real error isn't, and what the callers get back is as before.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { claude, claudeCall, ClaudeError, claudeTurn } from "./kit.ts";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** fetch answering with these, in turn (a function throws instead: no answer). */
function answers(...list: (Response | (() => never))[]) {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = list.shift();
    if (!next) throw new Error("fetch called once too often");
    if (typeof next === "function") next();
    return next as Response;
  }) as typeof fetch;
  return bodies;
}
const ok = (content: unknown[], usage = { input_tokens: 3, output_tokens: 4 }) => new Response(JSON.stringify({ content, usage }), { status: 200 });
const err = (status: number, message: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers });

test("Anthropic overloaded (529) and too many requests (429): tried again, then it works", async () => {
  const bodies = answers(err(529, "Overloaded", { "retry-after": "0" }), err(429, "Slow down", { "retry-after": "0" }), ok([{ type: "text", text: "hi" }]));
  const r = await claudeCall({ model: "m", max_tokens: 10, messages: [] });
  assert.equal(bodies.length, 3);
  assert.deepEqual(r.content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 4 });
});

test("a real error (400) fails at once, with Anthropic's message, as before", async () => {
  const bodies = answers(err(400, "messages: field required"));
  await assert.rejects(claudeCall({}), (e) => e instanceof ClaudeError && e.status === 400 && e.message === "Claude: messages: field required");
  assert.equal(bodies.length, 1);
});

test("no answer at all (the network) is tried again", async () => {
  const bodies = answers(() => {
    throw new TypeError("fetch failed");
  }, ok([{ type: "text", text: "back" }]));
  const r = await claudeCall({});
  assert.equal(bodies.length, 2);
  assert.equal(r.content[0].text, "back");
});

test("it gives up after two more tries", async () => {
  const bodies = answers(err(503, "down", { "retry-after": "0" }), err(503, "down", { "retry-after": "0" }), err(503, "still down", { "retry-after": "0" }));
  await assert.rejects(claudeCall({}), /Claude: still down/);
  assert.equal(bodies.length, 3);
});

test("claude() and claudeTurn() ask and answer as before", async () => {
  const tool = { name: "act", description: "d", input_schema: { type: "object" } };
  let bodies = answers(ok([{ type: "tool_use", name: "act", input: { action: "ignore" } }]));
  assert.deepEqual(await claude("model-x", "sys", "hello", tool, 600), { action: "ignore" });
  assert.deepEqual(bodies[0], { model: "model-x", max_tokens: 600, system: "sys", messages: [{ role: "user", content: "hello" }], tools: [tool], tool_choice: { type: "auto" } });

  answers(ok([{ type: "text", text: 'Sure: {"action":"none"}' }]));
  assert.deepEqual(await claude("m", "s", "u", tool), { action: "none" });
  answers(ok([{ type: "text", text: " plain words " }]));
  assert.equal(await claude("m", "s", "u"), "plain words");

  bodies = answers(ok([{ type: "tool_use", id: "t", name: "find", input: {} }]));
  assert.deepEqual(await claudeTurn("m", "sys", [{ role: "user", content: "q" }], [tool], 2000), [{ type: "tool_use", id: "t", name: "find", input: {} }]);
  assert.deepEqual(bodies[0].system, [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
});
