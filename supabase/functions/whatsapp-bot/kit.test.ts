// Calls to Claude (kit.ts) against a stubbed fetch: a busy moment is tried
// again, a real error isn't, and what the callers get back is as before.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { claude, claudeCall, ClaudeError, claudeStep, claudeTurn, logAiCallsTo, modelFor, type AiCall } from "./kit.ts";

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

// ------------------------------------------------------ a model per job --

const tool = { name: "act", description: "d", input_schema: { type: "object" } };
const roles = { model: "claude-sonnet-5-5", model_fast: "claude-haiku-5-5", model_main: "claude-sonnet-5-5", model_agent: "claude-opus-5-5" };
const cached = (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } });

test("each job runs on its role's model; before 0108 runs, on the one model, as before", () => {
  assert.equal(modelFor(roles, "fast"), "claude-haiku-5-5");
  assert.equal(modelFor(roles, "main"), "claude-sonnet-5-5");
  assert.equal(modelFor(roles, "agent"), "claude-opus-5-5");
  // The columns aren't there yet: everything on the one model.
  assert.equal(modelFor({ model: "claude-opus-5-5" }, "fast"), "claude-opus-5-5");
  assert.equal(modelFor({}, "fast"), "claude-haiku-5-5");
  assert.equal(modelFor({}, "agent"), "claude-sonnet-5-5");
});

test("a quick decision on Haiku forces its tool (no thinking first), with a small answer", async () => {
  const bodies = answers(ok([{ type: "tool_use", name: "act", input: { action: "ignore" } }]));
  assert.deepEqual(await claude(roles, { name: "orders.act", role: "fast" }, "sys", "hello", tool, 600), { action: "ignore" });
  assert.deepEqual(bodies[0], {
    model: "claude-haiku-5-5",
    max_tokens: 600,
    system: [cached("sys")],
    messages: [{ role: "user", content: "hello" }],
    tools: [tool],
    tool_choice: { type: "tool", name: "act" },
  });
});

test("a quick decision on Sonnet: no forced tool (Sonnet 5.5 refuses it), thinking off", async () => {
  const bodies = answers(ok([{ type: "tool_use", name: "act", input: { action: "none" } }]));
  await claude({ ...roles, model_fast: "claude-sonnet-5-5" }, { name: "dm.ok", role: "fast" }, "sys", "u", tool, 600);
  assert.deepEqual(bodies[0].tool_choice, { type: "auto" });
  assert.deepEqual(bodies[0].thinking, { type: "between_tools" });
  assert.equal(bodies[0].max_tokens, 600);
});

test("on Opus (it always thinks): least thinking, and room for it on top of the answer", async () => {
  const bodies = answers(ok([{ type: "tool_use", name: "act", input: {} }]));
  await claude({ ...roles, model_fast: "claude-opus-5-5" }, { name: "dm.ok", role: "fast" }, "sys", "u", tool, 600);
  assert.deepEqual(bodies[0].output_config, { effort: "low" });
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[0].max_tokens, 2600);
});

test("words people read (main) think as the model likes, with room for it; text without a tool", async () => {
  const bodies = answers(ok([{ type: "text", text: " plain words " }]));
  assert.equal(await claude(roles, { name: "call.words", role: "main" }, "sys", "u", undefined, 300), "plain words");
  assert.equal(bodies[0].model, "claude-sonnet-5-5");
  assert.equal(bodies[0].max_tokens, 2300);
  assert.equal(bodies[0].thinking, undefined);
  assert.equal(bodies[0].tools, undefined);
});

test("a system prompt that changes is cached up to its stable part", async () => {
  const bodies = answers(ok([{ type: "tool_use", name: "act", input: {} }]));
  await claude(roles, { name: "book.act", role: "fast" }, { stable: "rules", now: "It is Fri 18:00" }, "u", tool, 1200);
  assert.deepEqual(bodies[0].system, [cached("rules"), { type: "text", text: "It is Fri 18:00" }]);
});

test("the tool not called: the JSON in the words is used, and it's logged with the call's name; nothing to read is null", async () => {
  const rows: AiCall[] = [];
  logAiCallsTo(async (r) => rows.push(r));
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    answers(ok([{ type: "text", text: 'Sure: {"action":"none"}' }]));
    assert.deepEqual(await claude(roles, { name: "dm.ok", role: "main" }, "s", "u", tool), { action: "none" });
    answers(ok([{ type: "text", text: "I'd rather not." }]));
    assert.equal(await claude(roles, { name: "chat.read", role: "main" }, "s", "u", tool), null);
  } finally {
    console.warn = warn;
    logAiCallsTo(null);
  }
  assert.deepEqual(rows.map((r) => [r.job, r.note]), [
    ["dm.ok", "no tool: JSON read from the words"],
    ["chat.read", "no tool: nothing to read"],
  ]);
  assert.match(warned[0]!, /"job":"dm.ok"/);
  assert.match(warned[1]!, /"job":"chat.read"/);
});

test("every call is logged: model, tokens with the cache's, time, tries; a failure too, without the words", async () => {
  const rows: AiCall[] = [];
  logAiCallsTo(async (r) => rows.push(r));
  try {
    answers(err(529, "Overloaded", { "retry-after": "0" }), ok([{ type: "tool_use", name: "act", input: {} }], { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } as never));
    await claude(roles, { name: "orders.act", role: "fast" }, "secret rules", "the client's private words", tool, 600);
    answers(err(400, "bad request"));
    await assert.rejects(claude(roles, { name: "orders.act", role: "fast" }, "s", "u", tool, 600));
  } finally {
    logAiCallsTo(null);
  }
  const [good, bad] = rows;
  assert.equal(good!.ok, true);
  assert.equal(good!.model, "claude-haiku-5-5");
  assert.equal(good!.role, "fast");
  assert.equal(good!.tries, 2);
  assert.deepEqual([good!.input_tokens, good!.output_tokens, good!.cache_read_tokens, good!.cache_write_tokens], [10, 5, 900, 0]);
  assert.equal(bad!.ok, false);
  assert.equal(bad!.error, "Claude: bad request");
  assert.doesNotMatch(JSON.stringify(rows), /private words|secret rules/);
});

test("a try with no answer is cut off after its time and tried again", async () => {
  let calls = 0;
  globalThis.fetch = ((_u: string, init: RequestInit) => {
    calls++;
    if (calls === 2) return Promise.resolve(ok([{ type: "text", text: "late but here" }]));
    // Never answers: only the timeout ends it.
    return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
  }) as typeof fetch;
  const t0 = Date.now();
  // Node doesn't wait for AbortSignal.timeout's timer (Deno does): this keeps the test alive meanwhile.
  const alive = setTimeout(() => {}, 10_000);
  const r = await claudeCall({ model: "m" }, { name: "t", role: "fast", timeoutMs: 1200 }).finally(() => clearTimeout(alive));
  assert.equal(r.content[0]!.text, "late but here");
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 < 5000);
});

test("no try starts past the deadline: out of time is an error, not a wait", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return ok([]);
  }) as typeof fetch;
  await assert.rejects(claudeCall({ model: "m" }, { name: "t", role: "fast" }, { deadline: Date.now() + 500 }), /out of time/);
  assert.equal(calls, 0);
});

test("a turn with tools: the system and the conversation so far are cached, and it waits only as long as it's given", async () => {
  const bodies = answers(ok([{ type: "tool_use", id: "t", name: "find", input: {} }]));
  assert.deepEqual(await claudeTurn(roles, { name: "look.answer", role: "main" }, "sys", [{ role: "user", content: "q" }], [tool], 2000), [{ type: "tool_use", id: "t", name: "find", input: {} }]);
  assert.deepEqual(bodies[0]!.system, [cached("sys")]);
  assert.deepEqual(bodies[0]!.cache_control, { type: "ephemeral" });
  assert.equal(bodies[0]!.model, "claude-sonnet-5-5");
  // The agent's turn: its own model, and no longer than the run has left.
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_u: string, init: RequestInit) => ((signal = init.signal!), ok([]))) as typeof fetch;
  await claudeStep(roles, { name: "agent.turn", role: "agent" }, "sys", [], [], 2000, { timeoutMs: 3000 });
  assert.ok(signal);
});
