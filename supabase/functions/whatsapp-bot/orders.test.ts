// Orders from the team (orders.ts): with the agent off, Claude is asked
// exactly what it was asked before; an order to one person (giveOrder, now
// shared with the agent) does what it did before. In a group, Claude is told
// how the message came (gate.ts), and talk that only carries on a conversation
// is never asked back.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fakeDb } from "./test/fake-db.ts";
import { agentFor, cameBy, giveOrder, ORDER_SYSTEM, orderSystem, orderTool, takeOrder } from "./orders.ts";
import { VOICE } from "./voice.ts";
import type { Via } from "./gate.ts";
import type { Person, Settings, Team } from "./kit.ts";
import type { Attendee } from "./meetings.ts";

// remind: reminders at a time (0110); post: in another group (post.ts); alert: pause or remind about one (pause.ts); teach: notes (notes.ts); chat: like a normal assistant.
const ACTIONS = ["orders", "meeting", "my_order", "question", "answer", "handled", "stop", "status", "write_out", "remind", "post", "alert", "teach", "chat", "ignore", "none"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type ActionProp = { enum: string[] };
const actions = (agent: boolean) => ((orderTool(agent).input_schema.properties as Record<string, ActionProp>).action.enum);

test("agent off: the act tool has no task, and its words don't mention one", () => {
  assert.deepEqual(actions(false), ACTIONS);
  assert.doesNotMatch(orderSystem(false), /- task:/);
});

test("agent on: only task is added, and the words around it don't change", () => {
  assert.deepEqual(actions(true), [...ACTIONS, "task"]);
  const on = orderSystem(true);
  assert.match(on, /\n- task: [^\n]+\n- ignore: /);
  assert.equal(sha(on.replace(/\n- task: [^\n]+/, "")), sha(orderSystem(false)));
  // The tool everyone else gets is untouched.
  assert.deepEqual(actions(false), ACTIONS);
});

test("who gets the agent: BOT_AGENT on (the team), admins (admins only), anything else nobody", () => {
  const admin: Person = { id: "a", name: "Omar", username: "omar", active: true, admin: true };
  const member: Person = { ...admin, id: "m", admin: false };
  const gone: Person = { ...admin, active: false };
  assert.equal(agentFor(admin, ""), false);
  assert.equal(agentFor(admin, "yes"), false);
  assert.equal(agentFor(admin, "admins"), true);
  assert.equal(agentFor(member, "admins"), false);
  assert.equal(agentFor(member, "on"), true);
  assert.equal(agentFor(gone, "on"), false);
  assert.equal(agentFor(undefined, "on"), false);
});

// --------------------------------------------------------------- giveOrder --

const s = { order_every_min: 60 } as Settings;
const at = { chat_id: "team@g.us", message_id: "m1" };
const by = { id: "u-sameh", name: "Sameh" };
const rabah: Attendee = { kind: "team", id: "u-rabah", name: "Rabah", email: null, phone: "15555550101" };
const x = { kind: "tell" as const, task: "send the logo files", message: "Hi Rabah – Sameh asks you to send the logo files.", nudge: "Rabah, a reminder.", wait: true };

function sender(fail?: string) {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    if (fail) throw new Error(fail);
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}

test("an order is kept, written to them, and stays open to follow up", async () => {
  const f = fakeDb({ bot_order: [] });
  const { send, sent } = sender();
  const g = await giveOrder(f.db, s, send, at, by, "@iklipse tell Rabah to send the logo files", rabah, x);
  assert.equal(g.problem, undefined);
  assert.equal(g.told, undefined);
  const row = f.tables.bot_order[0];
  assert.equal(row.status, "open");
  assert.equal(row.to_chat, "15555550101@c.us");
  assert.equal(row.by_user, "u-sameh");
  assert.deepEqual(row.sent_ids, ["wamid-1"]);
  assert.equal(sent[0].chat, "15555550101@c.us");
  assert.equal(sent[0].text, "Hi Rabah ,  Sameh asks you to send the logo files.");
});

test("passing something on: said once, and done", async () => {
  const f = fakeDb({ bot_order: [] });
  const g = await giveOrder(f.db, s, sender().send, at, by, "tell Rabah I'm late", rabah, { ...x, wait: false });
  assert.equal(g.told, true);
  assert.equal(f.tables.bot_order[0].status, "done");
  assert.equal(f.tables.bot_order[0].outcome, "Told");
});

test("what goes wrong is said, and where it stopped", async () => {
  const noPhone = await giveOrder(fakeDb({ bot_order: [] }).db, s, sender().send, at, by, "t", { ...rabah, phone: null }, x);
  assert.equal(noPhone.stage, "check");
  assert.match(noPhone.problem!, /I don't have Rabah's WhatsApp number/);

  const f = fakeDb({ bot_order: [] });
  const failed = await giveOrder(f.db, s, sender("WhatsApp (Green API): not authorized").send, at, by, "t", rabah, x);
  assert.equal(failed.stage, "send");
  assert.match(failed.problem!, /Couldn't send it to Rabah: WhatsApp \(Green API\): not authorized/);
  assert.equal(f.tables.bot_order[0].status, "failed");

  const down = fakeDb({ bot_order: [] }, { fail: (c) => (c.op === "insert" ? "db down" : null) });
  const kept = await giveOrder(down.db, s, sender().send, at, by, "t", rabah, x);
  assert.equal(kept.stage, "keep");
  assert.equal(kept.problem, "Couldn't keep the order for Rabah.");
});

test("to a client: what the order and their chat don't say doesn't go (guard.ts); what they say does", async () => {
  const sara: Attendee = { kind: "client", id: "c-sara", name: "Sara Ahmed", email: "sara@acme.test", phone: "15555550202" };
  const world = () =>
    fakeDb({
      bot_order: [],
      wa_dm: [{ chat_id: "15555550202@c.us", text: "Any news on the price?", sent_at: "2026-10-22T10:00:00Z" }],
      client: [
        { id: "c-sara", name: "Sara Ahmed", company: "Acme", name_known: true, email: "sara@acme.test", phone: "15555550202" },
        { id: "c-mona", name: "Mona Fathy", company: "Nile Foods", name_known: true, email: null, phone: "15555550303" },
      ],
      bot_guard_block: [],
    });
  const tell = { kind: "tell" as const, task: "tell her the price", wait: false, nudge: "" };

  const f = world();
  const { send, sent } = sender();
  const g = await giveOrder(f.db, s, send, at, by, "tell Sara the price is 500$", sara, { ...tell, message: "Hi Sara, the logo package is $500, same as Nile Foods paid." });
  assert.equal(g.stage, "check");
  assert.equal(g.problem, "I didn't send it to Sara Ahmed: the message had another client's name (Nile Foods), which isn't in your order or their chat. Tell me exactly what to send.");
  assert.deepEqual(sent, []);
  assert.equal(f.tables.bot_order.length, 0);
  assert.equal(f.tables.bot_guard_block[0].where_from, "orders.message");

  const ok = world();
  const fine = sender();
  const g2 = await giveOrder(ok.db, s, fine.send, at, by, "tell Sara the price is 500$", sara, { ...tell, message: "Hi Sara, the logo package is $500." });
  assert.equal(g2.problem, undefined);
  assert.deepEqual(fine.sent.map((m) => m.text), ["Hi Sara, the logo package is $500."]);
});

// ------------------------------------------- how it came into the group --

const VIAS: Via[] = ["mention", "reply", "name", "conversation"];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude, deciding what each message is: the act tool's input, in turn (null: Claude refuses the call). What it was given is read back. */
function claudeSays(...acts: (Record<string, unknown> | null)[]) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push(JSON.parse(String(b.messages[0].content)));
    if (!acts.length) throw new Error("Claude was asked once too often");
    const act = acts.shift();
    if (!act) return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
const on = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const saraT: Person = { id: "u-sara", name: "Sara", username: "sara", active: true, admin: false };
const omarT: Person = { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false };
const team: Team = {
  people: new Map([
    [saraT.id, saraT],
    [omarT.id, omarT],
  ]),
  byPhone: new Map([
    ["15555550104", saraT],
    ["15555550105", omarT],
  ]),
  byLid: new Map(),
  others: new Set(),
};
const world = () =>
  fakeDb({
    profile: [
      { id: "u-sara", display_name: "Sara", role: "member", is_active: true },
      { id: "u-omar", display_name: "Omar", role: "member", is_active: true },
    ],
    profile_contact: [
      { user_id: "u-sara", whatsapp: "15555550104" },
      { user_id: "u-omar", whatsapp: "15555550105" },
    ],
    bot_order: [],
    wa_message: [],
  });
const said = { id: "g-1", chatId: "team@g.us", where: "team" as const, text: "iklipse who's late today?", quoted: null, phone: "15555550104", lid: null, name: "Sara" };

test("came_by: the words Claude gets for each way into the group", () => {
  assert.deepEqual(VIAS.map(cameBy), ["a mention", "a reply to you", "called you by name", "carrying on your conversation with them"]);
  assert.equal(cameBy(undefined), undefined);
});

test("Claude is told how it came (came_by) for each way in; privately, or with no way given, nothing", async () => {
  for (const via of VIAS) {
    const asked = claudeSays({ action: "ignore" });
    const { send, sent } = sender();
    await takeOrder(world().db, on, team, send, { ...said, id: `g-${via}`, via }, async () => {});
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.came_by, cameBy(via));
    assert.equal(asked[0]!.where, "the team group");
    // Not for the bot: nothing said.
    assert.deepEqual(sent, []);
  }
  const dm = claudeSays({ action: "ignore" });
  await takeOrder(world().db, on, team, sender().send, { ...said, id: "d-1", chatId: "15555550104@c.us", where: "private" }, async () => {});
  assert.equal("came_by" in dm[0]!, false);
  // An order the team gave by replying to a report (followOrder): no way given.
  const followed = claudeSays({ action: "ignore" });
  await takeOrder(world().db, on, team, sender().send, { ...said, id: "g-2" }, async () => {});
  assert.equal("came_by" in followed[0]!, false);
});

test("the words: each came_by is explained, talk that isn't for the bot is ignore, never a question back", () => {
  for (const via of VIAS) assert.ok(ORDER_SYSTEM.includes(`${cameBy(via)} (`), `${via} isn't explained`);
  assert.match(ORDER_SYSTEM, /When came_by is "called you by name" or "carrying on your conversation with them", it may not be: /);
  for (const x of ["@Rabah send it", "حد شاف الفايل؟", "تمام يا شباب"]) assert.ok(ORDER_SYSTEM.includes(`"${x}"`), x);
  assert.match(ORDER_SYSTEM, /When you're not sure it's for you, ignore\./);
  assert.match(ORDER_SYSTEM, /Never answer talk that wasn't for you with a question \(none\)\./);
  // The voice block is still last, and the agent's task still goes in before ignore.
  assert.ok(ORDER_SYSTEM.endsWith(`\n${VOICE}`));
  assert.ok(orderSystem(true).endsWith(`\n${VOICE}`));
  assert.match(orderSystem(true), /\n- task: [^\n]+\n- ignore: /);
});

test("carrying on a conversation: an order it can't place (none) gets no question back; a mention, a reply or a name still does", async () => {
  const quiet = sender();
  const asked = claudeSays({ action: "none", reply: "Who's Ahmed?" });
  await takeOrder(world().db, on, team, quiet.send, { ...said, id: "c-1", text: "tell Ahmed to send it", via: "conversation" }, async () => {});
  assert.equal(asked.length, 1);
  assert.deepEqual(quiet.sent, []);

  for (const via of ["mention", "reply", "name"] as const) {
    const back = sender();
    claudeSays({ action: "none", reply: "Who's Ahmed?" });
    await takeOrder(world().db, on, team, back.send, { ...said, id: `c-${via}`, text: "iklipse tell Ahmed to send it", via }, async () => {});
    assert.deepEqual(back.sent, [{ chat: "team@g.us", text: "Who's Ahmed?", quoted: `c-${via}` }]);
  }
});

test("carrying on a conversation, or only starting with its name: no \"didn't get that\" and no \"send it again\"; a mention or a reply gets them as before", async () => {
  // "بوت الواتساب واقع تاني" starts with its name, but is about a bot, not to it.
  for (const [via, text] of [
    ["conversation", "ok send it"],
    ["name", "بوت الواتساب واقع تاني"],
  ] as const) {
    const quiet = sender();
    claudeSays({ action: "orders", orders: [] }, null);
    await takeOrder(world().db, on, team, quiet.send, { ...said, id: `e-${via}-1`, text, via }, async () => {});
    await takeOrder(world().db, on, team, quiet.send, { ...said, id: `e-${via}-2`, text, via }, async () => {});
    assert.deepEqual(quiet.sent, [], via);
  }

  for (const via of ["mention", "reply"] as const) {
    const back = sender();
    claudeSays({ action: "orders", orders: [] }, null);
    await takeOrder(world().db, on, team, back.send, { ...said, id: `e-${via}-3`, text: "@iklipse ok send it", via }, async () => {});
    await takeOrder(world().db, on, team, back.send, { ...said, id: `e-${via}-4`, text: "@iklipse ok send it", via }, async () => {});
    assert.deepEqual(back.sent.map((m) => m.text), [
      "Didn't get that. Who's it for, and what should I tell them?",
      "Something went wrong on my side and I couldn't read that. Send it again in a minute?",
    ], via);
  }
});

test("the words: a remark about a bot, even one starting with its name, is ignore", () => {
  assert.ok(ORDER_SYSTEM.includes(`"بوت الواتساب واقع تاني"`));
  assert.ok(ORDER_SYSTEM.includes(`"اكليبس", "بوت" or "يا بوت"`));
});

test("carrying on a conversation: Claude sees what the bot asked them there (you_asked_them), not what it asked someone else", async () => {
  const f = world();
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  // Newest first, as the database gives them.
  f.tables.wa_message = [
    { id: "b-2", chat_id: "team@g.us", from_bot: true, text: "What should I remind you of?", quoted_id: "o-1", sent_at: ago(1) },
    { id: "o-1", chat_id: "team@g.us", sender_id: "15555550105@c.us", phone: "15555550105", from_bot: false, text: "iklipse remind me at 5", sent_at: ago(1.5) },
    { id: "b-1", chat_id: "team@g.us", from_bot: true, text: "Who's Ahmed?", quoted_id: "s-1", sent_at: ago(2) },
    { id: "s-1", chat_id: "team@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse tell Ahmed to send the files", sent_at: ago(3) },
    // Rabah was asked long ago: past the 5 minutes.
    { id: "b-0", chat_id: "team@g.us", from_bot: true, text: "Which project?", quoted_id: "r-1", sent_at: ago(19) },
    { id: "r-1", chat_id: "team@g.us", sender_id: "15555550101@c.us", phone: "15555550101", from_bot: false, text: "iklipse how's the project", sent_at: ago(20) },
  ];
  const asked = claudeSays({ action: "ignore" }, { action: "ignore" }, { action: "ignore" }, { action: "ignore" });
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "s-2", text: "Ahmed from Acme", via: "conversation" }, async () => {});
  assert.equal(asked[0]!.you_asked_them, "Who's Ahmed?");
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "o-2", text: "send the invoice", phone: "15555550105", name: "Omar", via: "conversation" }, async () => {});
  assert.equal(asked[1]!.you_asked_them, "What should I remind you of?");
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "r-2", text: "the Acme one", phone: "15555550101", name: "Rabah", via: "conversation" }, async () => {});
  assert.equal("you_asked_them" in asked[2]!, false);
  // Only when carrying on a conversation with no quote.
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "s-3", text: "@iklipse Ahmed from Acme", via: "mention" }, async () => {});
  assert.equal("you_asked_them" in asked[3]!, false);
});
