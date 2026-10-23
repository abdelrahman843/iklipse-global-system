// A task end to end, through the bot's own code: a team member's message in
// the team group (orders.ts takeOrder), Claude (fetch stubbed) hands it over
// as a task, the agent looks up the deliveries (look.ts find), writes to the
// one who's late (an order, giveOrder), and the answer goes back to the
// group with what was done. WhatsApp and the database are in memory.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "../test/fake-db.ts";
import { takeOrder } from "../orders.ts";
import type { Person, Settings, Team } from "../kit.ts";

const env = (globalThis as unknown as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno.env;
const realGet = env.get;
const realFetch = globalThis.fetch;
afterEach(() => {
  env.get = realGet;
  globalThis.fetch = realFetch;
});
const agentMode = (mode: string) => {
  env.get = (k) => (k === "BOT_AGENT" ? mode : realGet(k));
};

type Body = { tools: { name: string; input_schema: { properties: Record<string, { enum?: string[] }> } }[]; messages: { role: string; content: unknown }[]; system: unknown };
/** Claude, scripted by turn; each turn sees the request body. */
function claudeSays(...turns: ((b: Body) => unknown[] | Response)[]) {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    bodies.push(b);
    const turn = turns.shift();
    if (!turn) throw new Error("Claude was asked once too often");
    const out = turn(b);
    return out instanceof Response ? out : new Response(JSON.stringify({ content: out, usage: { input_tokens: 50, output_tokens: 10 } }), { status: 200 });
  }) as typeof fetch;
  return bodies;
}
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const lastResults = (b: Body) => b.messages.at(-1)!.content as { content: string; is_error?: boolean }[];

const sameh: Person = { id: "u-sameh", name: "Sameh", username: "sameh", active: true, admin: false };
const team: Team = { people: new Map([[sameh.id, sameh]]), byPhone: new Map([["15555550102", sameh]]), byLid: new Map(), others: new Set() };
const s = { model: "claude-test", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const order = { id: "m-1", chatId: "team@g.us", where: "team" as const, text: "@iklipse who's late on their deliveries? remind them", quoted: null, phone: "15555550102", lid: null, name: "Sameh" };

const world = () =>
  fakeDb({
    profile: [
      { id: "u-sameh", display_name: "Sameh", role: "member", is_active: true },
      { id: "u-rabah", display_name: "Rabah", role: "member", is_active: true },
    ],
    profile_contact: [
      { user_id: "u-sameh", whatsapp: "15555550102" },
      { user_id: "u-rabah", whatsapp: "15555550101" },
    ],
    project_delivery: [{ id: "d1", project_id: "p1", title: "Acme video", due_at: "2026-10-22T10:00:00Z", assignee_id: "u-rabah", done_at: null }],
  });

function whatsapp() {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => (sent.push({ chat, text, quoted }), `wamid-${sent.length}`);
  return { sent, send };
}

test("a task: looked up, the late one written to, and the group told what was done, once", async () => {
  agentMode("on");
  const f = world();
  const wa = whatsapp();
  const bodies = claudeSays(
    (b) => {
      assert.equal(b.tools[0].name, "act");
      assert.ok(b.tools[0].input_schema.properties.action.enum!.includes("task"));
      return [use("a", "act", { action: "task" })];
    },
    (b) => {
      assert.deepEqual(b.tools.map((t) => t.name), ["find", "message_team_member", "set_reminder", "finish"]);
      return [use("t1", "find", { table: "project_delivery", where: [{ column: "done_at", op: "is", value: null }] })];
    },
    (b) => {
      assert.match(lastResults(b)[0].content, /Acme video/);
      return [
        use("t2", "message_team_member", {
          person: "u-rabah",
          kind: "tell",
          task: "finish the Acme video",
          message: "Hi Rabah, Sameh asks you to finish the Acme video. Reply here when it's done, or tell me what's in the way.",
          nudge: "Rabah, a reminder: the Acme video.",
          wait: true,
        }),
      ];
    },
    (b) => {
      assert.match(lastResults(b)[0].content, /"verified":"submitted"/);
      return [use("t3", "finish", { status: "done", text: "Only Rabah is late: the Acme video, due yesterday." })];
    },
  );
  await takeOrder(f.db, s, team, wa.send, order, async () => {});

  assert.equal(bodies.length, 4);
  assert.deepEqual(wa.sent.map((m) => m.chat), ["15555550101@c.us", "team@g.us"]);
  assert.match(wa.sent[0].text, /^Hi Rabah, Sameh asks you to finish the Acme video/);
  assert.equal(wa.sent[1].text, "Only Rabah is late: the Acme video, due yesterday.\nSent to Rabah. I'll follow up until it's done.");
  assert.equal(wa.sent[1].quoted, "m-1");
  const kept = f.tables.bot_order;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].status, "open");
  assert.equal(kept[0].by_user, "u-sameh");
  assert.deepEqual(kept[0].sent_ids, ["wamid-1"]);
  // A reply to the group's message reaches the order, like any order's report.
  assert.deepEqual(kept[0].report_ids, ["wamid-2"]);
  assert.deepEqual(f.tables.bot_heard.map((r) => r.id).sort(), ["agent:m-1:team:u-rabah", "order:m-1"]);

  // WhatsApp sends the same message again: nothing more happens.
  await takeOrder(f.db, s, team, wa.send, order, async () => {});
  assert.equal(bodies.length, 4);
  assert.equal(wa.sent.length, 2);
});

test("agent off: Claude isn't offered task, and the bot does what it did before", async () => {
  agentMode("");
  const bodies = claudeSays((b) => {
    assert.ok(!b.tools[0].input_schema.properties.action.enum!.includes("task"));
    return [use("a", "act", { action: "ignore" })];
  });
  const wa = whatsapp();
  await takeOrder(world().db, s, team, wa.send, order, async () => {});
  assert.equal(bodies.length, 1);
  assert.equal(wa.sent.length, 0);
});

test("admins only: a member's request isn't a task", async () => {
  agentMode("admins");
  const bodies = claudeSays((b) => {
    assert.ok(!b.tools[0].input_schema.properties.action.enum!.includes("task"));
    return [use("a", "act", { action: "ignore" })];
  });
  await takeOrder(world().db, s, team, whatsapp().send, order, async () => {});
  assert.equal(bodies.length, 1);
});

test("Claude down even after trying again: they're told, instead of silence", async () => {
  agentMode("");
  const down = () => new Response(JSON.stringify({ error: { message: "Overloaded" } }), { status: 529, headers: { "retry-after": "0" } });
  const bodies = claudeSays(down, down, down);
  const wa = whatsapp();
  await takeOrder(world().db, s, team, wa.send, order, async () => {});
  assert.equal(bodies.length, 3);
  assert.deepEqual(wa.sent, [{ chat: "team@g.us", text: "Something went wrong on my side and I couldn't read that. Send it again in a minute?", quoted: "m-1" }]);
});

test("someone not on the team gets nothing from a task, even with the agent on", async () => {
  agentMode("on");
  const bodies = claudeSays();
  const wa = whatsapp();
  await takeOrder(world().db, s, team, wa.send, { ...order, id: "m-2", where: "client", chatId: "client@g.us", phone: "15555550199" }, async () => {});
  assert.equal(bodies.length, 0);
  assert.equal(wa.sent.length, 0);
});
