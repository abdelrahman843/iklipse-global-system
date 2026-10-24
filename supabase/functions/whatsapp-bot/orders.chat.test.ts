// Chatting with the bot like a normal assistant (orders.ts, the chat action):
// in a team group (what gate.ts lets through) or privately, someone on the team
// asks for a caption, a translation, ideas or an opinion, and Claude answers
// for real, in their language, knowing who they are, the team and what the
// admins taught it, with what was said just before, looking things up in
// iklipse when that helps (look.ts). Never from a client group. What they
// replied to in a group is what iklipse kept of it (a photo with what it
// shows). Claude is stubbed, the database is in memory.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { CHAT_LOOK_SYSTEM, CHAT_SYSTEM, forWhatsApp, ORDER_SYSTEM, orderSystem, orderTool, quotedText, takeOrder, YOU_CAN } from "./orders.ts";
import { LOOK_SYSTEM } from "./look.ts";
import { logAiCallsTo, type ClaudeTool, type Person, type Settings, type Team } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  logAiCallsTo(null);
});

type Prop = { description?: string; enum?: string[] };
type Body = {
  system: { type: string; text: string }[];
  tools?: { name: string; input_schema: { properties: Record<string, Prop> } }[];
  messages: { role: string; content: unknown }[];
};
const ok = (content: unknown[]) => new Response(JSON.stringify({ content, usage: {} }), { status: 200 });
const reply = (text: string) => [{ type: "tool_use", id: "r1", name: "reply", input: { text } }];

/** Claude: the act tool's input for the router, in turn; then each turn of the answer. What each was given is read back. */
function claudeWith(acts: Record<string, unknown>[], turns: unknown[][]) {
  const routed: { input: Record<string, unknown>; body: Body }[] = [];
  const answered: Body[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    if (b.tools?.[0]?.name === "act") {
      routed.push({ input: JSON.parse(String(b.messages[0]!.content)), body: b });
      const act = acts.shift();
      if (!act) throw new Error("Routed once too often");
      return ok([{ type: "tool_use", id: "t0", name: "act", input: act }]);
    }
    answered.push(b);
    const turn = turns.shift();
    if (!turn) throw new Error("Claude was asked once too often");
    return ok(turn);
  }) as typeof fetch;
  return { routed, answered };
}
/** The jobs Claude was called for, in order (bot_ai_call). */
function jobs() {
  const list: string[] = [];
  logAiCallsTo(async (r) => void list.push(r.job));
  return list;
}
function sender() {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}
const known = (b: Body) => JSON.parse(String(b.messages[0]!.content)) as Record<string, unknown>;
const enumOf = (tool: ClaudeTool) => (tool.input_schema.properties as Record<string, Prop>).action!.enum!;

const on = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const P = (id: string, name: string, admin = false): Person => ({ id, name, username: name.toLowerCase(), active: true, admin });
const sara = P("u-sara", "Sara", true);
const omar = P("u-omar", "Omar");
const team: Team = {
  people: new Map([sara, omar].map((p) => [p.id, p])),
  byPhone: new Map([
    ["15555550104", sara],
    ["15555550105", omar],
  ]),
  byLid: new Map(),
  others: new Set(),
};
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const world = () =>
  fakeDb({
    profile: [
      { id: "u-sara", display_name: "Sara", username: "sara", role: "admin", is_active: true },
      { id: "u-omar", display_name: "Omar", username: "omar", role: "member", is_active: true },
      { id: "u-mona", display_name: "Mona", username: "mona", role: "member", is_active: false },
    ],
    profile_contact: [
      { user_id: "u-sara", whatsapp: "15555550104" },
      { user_id: "u-omar", whatsapp: "15555550105" },
    ],
    client: [{ id: "c-acme", name: "Lina Saleh", company: "Acme", name_known: true, phone: "+15550003001", email: "lina@acme.test", wa_lid: null, notes: null }],
    project: [{ id: "p-1", client_id: "c-acme", title: "Acme Ramadan campaign", description: "Three reels, warm and family first.", status: "active" }],
    bot_order: [],
    wa_message: [],
    wa_group: [],
    wa_dm: [],
  });
const said = { id: "g-1", chatId: "alerts@g.us", where: "team" as const, text: "", quoted: null, phone: "15555550104", lid: null, name: "Sara", via: "mention" as const };

// ------------------------------------------------------------- the router --

test("the router: chat is offered in a team group and privately, with what it's for; never from a client group", () => {
  assert.ok(enumOf(orderTool(false)).includes("chat"));
  assert.ok(enumOf(orderTool(true)).includes("chat"));
  assert.equal(enumOf(orderTool(false, false)).includes("chat"), false);
  assert.deepEqual(enumOf(orderTool(true, false)), [...enumOf(orderTool(false)).filter((a) => a !== "chat"), "task"]);
  assert.match(ORDER_SYSTEM, /\n- chat: [^\n]+\n- ignore: /);
  for (const x of ["write me a caption for this", "translate this to English", "5 names for the new brand", "what do you think about this idea?", "e3mely caption lel reel da", "اكتبلي بوست عن العرض", "خليها أقصر"]) {
    assert.ok(ORDER_SYSTEM.includes(`"${x}"`), x);
  }
  // A fact from iklipse stays a question; something to send or post stays an order or a post.
  assert.match(ORDER_SYSTEM, /A fact from iklipse \(who, what, when, where it stands\) is question; something to send to someone is orders; something to post in a group is post\./);
  assert.doesNotMatch(ORDER_SYSTEM.match(/\n- chat: [^\n]+/)![0], /[—–]/);
  // From a client group: only its line is gone; with the agent, a task's words don't mention it either.
  assert.equal(orderSystem(false, false), ORDER_SYSTEM.replace(/\n- chat: [^\n]+/, ""));
  assert.doesNotMatch(orderSystem(true, false), /- chat:|still chat/);
  assert.match(orderSystem(true), /\n- task: [^\n]+ Your own writing or thinking for them is still chat\.\n- ignore: /);
});

test("asked what it can do, it says it chats like a normal assistant", () => {
  assert.ok(YOU_CAN.some((x) => /^chat with anyone on the team like a normal assistant .*in a team group when they talk to you, or privately: write and rewrite .*translate, explain, brainstorm, give an honest opinion/.test(x)));
  assert.doesNotMatch(YOU_CAN.join("\n"), /[—–]/);
});

test("the words for a chat: for real, in their language and tone, short in a group, WhatsApp's bold, nothing invented; the same rules with and without lookups", () => {
  for (const words of [CHAT_SYSTEM, CHAT_LOOK_SYSTEM]) {
    assert.match(words, /never say it isn't your job or that you can't switch into it/);
    assert.match(words, /Write in the language and the way they wrote: Egyptian Arabic in Arabic letters, Franco-Arabic in Franco, English in English/);
    assert.match(words, /In a group, keep it short/);
    assert.match(words, /Privately, as long as it needs and no longer\./);
    assert.match(words, /\*bold\* with one star on each side/);
    assert.match(words, /Never invent anything about iklipse/);
    assert.match(words, /"conversation" is what they and you said just before/);
    assert.doesNotMatch(words, /Always English/);
    assert.doesNotMatch(words, /[—–]/);
  }
  assert.match(CHAT_LOOK_SYSTEM, /look it up with find, or search what people said/);
  assert.doesNotMatch(CHAT_SYSTEM, /with find/);
});

test("what WhatsApp shows: **bold** and headings as *bold*, no dashes", () => {
  assert.equal(forWhatsApp("## Hooks\n**One** — family first\n- *Two*"), "*Hooks*\n*One*, family first\n- *Two*");
  assert.equal(forWhatsApp("  plain  "), "plain");
});

// ------------------------------------------------------------- answering --

test("in a team group, a chat request gets a real answer from Claude, as a reply: who they are, the team, what it was taught, what was said just before", async () => {
  const f = world();
  f.tables.wa_message = [
    { id: "s-0", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse 3ayza caption lel reel bta3 Acme", quoted_id: null, sent_at: ago(4) },
    { id: "b-0", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "Ramadan nights, family first.", quoted_id: "s-0", sent_at: ago(3) },
  ];
  const s = { ...on, taught: "What the team taught you...\n- Answer Sara in Franco-Arabic." } as Settings;
  const called = jobs();
  const { answered } = claudeWith([{ action: "chat", about: [] }], [reply("**Caption:** Layali Ramadan ma3 el 3eila 🌙")]);
  const { send, sent } = sender();
  await takeOrder(f.db, s, team, send, { ...said, text: "iklipse 5aleeha a2sar w funny shwaya", via: "name" }, async () => {});

  // Routed to chat, then answered as an assistant, with find and search at hand.
  assert.deepEqual(called, ["orders.act", "look.chat"]);
  const b = answered[0]!;
  assert.equal(b.system[0]!.text, CHAT_LOOK_SYSTEM);
  // What the admins taught it, in the call too (kit.ts).
  assert.equal(b.system[1]!.text, s.taught);
  assert.deepEqual(b.tools!.map((x) => x.name), ["find", "search", "reply"]);
  assert.match(b.tools![2]!.input_schema.properties.text!.description!, /in their language and tone/);
  const k = known(b);
  assert.equal(k.where, "a team group");
  assert.deepEqual(k.asked_by, { name: "Sara", admin: true });
  assert.equal(k.request, "iklipse 5aleeha a2sar w funny shwaya");
  const talk = k.conversation as string[];
  assert.equal(talk.length, 2);
  assert.match(talk[0]!, /THEM: iklipse 3ayza caption lel reel bta3 Acme$/);
  assert.match(talk[1]!, /YOU: Ramadan nights, family first\.$/);
  assert.deepEqual(k.you_can, YOU_CAN);
  // The team as it is now; who left isn't in it.
  assert.deepEqual((k.who_is_who as { team: string[] }).team, ["Omar", "Sara (admin)"]);
  // As a reply to them in the group, bold the way WhatsApp shows it.
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "*Caption:* Layali Ramadan ma3 el 3eila 🌙", quoted: "g-1" }]);
});

test("privately: answered in their chat, with the chat so far; it looks things up in iklipse when that helps, as the one asking may read", async () => {
  const f = world();
  // Newest first, as the database gives them.
  f.tables.wa_dm = [
    { id: "d-2", chat_id: "15555550105@c.us", from_bot: false, text: "e3mely 3 hooks lel Ramadan campaign bta3 Acme", sent_at: ago(0.2) },
    { id: "d-1b", chat_id: "15555550105@c.us", from_bot: true, text: "Tamam el7amdulillah, 3ayez eh?", sent_at: ago(4) },
    { id: "d-1", chat_id: "15555550105@c.us", from_bot: false, text: "ezayak ya bot", sent_at: ago(5) },
  ];
  const called = jobs();
  const { answered } = claudeWith(
    [{ action: "chat", about: ["c:c-acme"] }],
    [
      [{ type: "tool_use", id: "f1", name: "find", input: { table: "project", columns: ["title", "description", "status"], where: [{ column: "client_id", op: "eq", value: "c-acme" }] } }],
      reply("1. Iftar starts here\n2. Same table, new story\n3. The 3eila edit"),
    ],
  );
  const { send, sent } = sender();
  await takeOrder(f.db, on, team, send, { id: "d-2", chatId: "15555550105@c.us", where: "private", text: "e3mely 3 hooks lel Ramadan campaign bta3 Acme", quoted: null, phone: "15555550105", lid: null, name: "Omar" }, async () => {});

  assert.deepEqual(called, ["orders.act", "look.chat", "look.chat"]);
  const k = known(answered[0]!);
  assert.equal(k.where, "privately");
  assert.deepEqual(k.asked_by, { name: "Omar", admin: false });
  const talk = k.conversation as string[];
  assert.match(talk[0]!, /THEM: ezayak ya bot$/);
  assert.match(talk[1]!, /YOU: Tamam el7amdulillah, 3ayez eh\?$/);
  // The client it names, as for a question.
  const about = k.about as { client: string; projects: { title: string }[] }[];
  assert.equal(about[0]!.client, "Lina Saleh (Acme)");
  assert.deepEqual(about[0]!.projects.map((p) => p.title), ["Acme Ramadan campaign"]);
  // What it found came back to it before it wrote.
  const result = (answered[1]!.messages.at(-1)!.content as { type: string; content: string }[])[0]!;
  assert.equal(result.type, "tool_result");
  assert.match(result.content, /Acme Ramadan campaign/);
  assert.deepEqual(sent, [{ chat: "15555550105@c.us", text: "1. Iftar starts here\n2. Same table, new story\n3. The 3eila edit", quoted: "d-2" }]);
});

test("someone in a team group iklipse doesn't know: no chat, only \"I can't help you here.\"", async () => {
  const f = world();
  const called = jobs();
  claudeWith([{ action: "chat" }], [reply("بنشحن يوم الأحد.")]);
  const { send, sent } = sender();
  await takeOrder(f.db, on, team, send, { ...said, id: "x-1", phone: "15555550999", name: "Karim", text: "@iklipse translate this to Arabic", quoted: "We ship on Sunday." }, async () => {});
  assert.deepEqual(called, []);
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "I can't help you here.", quoted: "x-1" }]);
});

test("from a client group: chat isn't offered; if Claude says chat anyway, it's a question as before, answered privately, never in the group", async () => {
  const f = world();
  const { routed, answered } = claudeWith([{ action: "chat", about: [] }], [reply("Acme's Ramadan campaign is active.")]);
  const { send, sent } = sender();
  await takeOrder(f.db, on, team, send, { ...said, id: "c-1", chatId: "acme@g.us", where: "client", text: "@iklipse write a caption for this" }, async () => {});
  assert.equal(enumOf(routed[0]!.body.tools![0]! as unknown as ClaudeTool).includes("chat"), false);
  assert.doesNotMatch(routed[0]!.body.system[0]!.text, /\n- chat: /);
  assert.equal(answered[0]!.system[0]!.text, LOOK_SYSTEM);
  assert.deepEqual(sent, [{ chat: "15555550104@c.us", text: "Acme's Ramadan campaign is active.", quoted: null }]);
});

test("Claude failing while it answers: they hear it, rather than nothing", async () => {
  const f = world();
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    if (b.tools?.[0]?.name === "act") return ok([{ type: "tool_use", id: "t0", name: "act", input: { action: "chat" } }]);
    return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
  }) as typeof fetch;
  const { send, sent } = sender();
  await takeOrder(f.db, on, team, send, { ...said, id: "e-1", text: "@iklipse explain what CPM means" }, async () => {});
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "I couldn't answer that just now. Ask me again in a minute?", quoted: "e-1" }]);
});

test("carrying on a conversation: small talk with the others, routed as chat or a question, gets nothing; only an answer to what the bot asked them is answered", async () => {
  // A minute after the bot asked Sara something, she talks to Omar.
  const small = "عامل ايه يا عمر؟ اخبار الشغل ايه";
  for (const [act, s] of [
    [{ action: "chat" }, on],
    [{ action: "chat", answers: false }, on],
    [{ action: "question", about: [] }, on],
    // Orders off: not even that.
    [{ action: "chat" }, { ...on, orders_enabled: false }],
  ] as const) {
    const called = jobs();
    claudeWith([act], []);
    const { send, sent } = sender();
    await takeOrder(world().db, s as Settings, team, send, { ...said, id: "c-1", text: small, via: "conversation" }, async () => {});
    assert.deepEqual(called, ["orders.act"], JSON.stringify(act));
    assert.deepEqual(sent, [], JSON.stringify(act));
  }

  // Her answer to what it asked: answered, as a chat or a question.
  for (const act of [{ action: "chat", answers: true }, { action: "question", about: [], answers: true }]) {
    const f = world();
    f.tables.wa_message = [
      { id: "b-1", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "Want it shorter, or in Arabic?", quoted_id: "s-1", sent_at: ago(1) },
      { id: "s-1", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse 3ayza caption lel reel bta3 Acme", quoted_id: null, sent_at: ago(2) },
    ];
    const { routed } = claudeWith([act], [reply("ليالي رمضان مع العيلة")]);
    const { send, sent } = sender();
    await takeOrder(f.db, on, team, send, { ...said, id: "c-2", text: "in Arabic", via: "conversation" }, async () => {});
    assert.equal(routed[0]!.input.you_asked_them, "Want it shorter, or in Arabic?");
    assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "ليالي رمضان مع العيلة", quoted: "c-2" }], act.action);
  }
  // Claude is told what answers means.
  assert.match((orderTool(false).input_schema.properties as Record<string, Prop>).answers!.description!, /true only when the message answers what you asked them \(you_asked_them\)/);
  assert.match(ORDER_SYSTEM, /a question or chat only when it answers what you asked them \(answers true\), never small talk with the others\./);
});

test("orders off: a chat is told so, like a question", async () => {
  const f = world();
  claudeWith([{ action: "chat" }], []);
  const { send, sent } = sender();
  await takeOrder(f.db, { ...on, orders_enabled: false } as Settings, team, send, { ...said, id: "o-1", text: "@iklipse brainstorm 5 names for the new brand" }, async () => {});
  assert.deepEqual(sent.map((m) => m.text), ["Orders are off. Turn on Take orders from the team in Alerts > Settings."]);
});

// ----------------------------------------------------- what they replied to --

test("what they replied to in a group is what iklipse kept: a photo comes with what it shows; another chat's message, or none kept, the quote as sent", async () => {
  const f = world();
  f.tables.wa_message = [
    { id: "p-1", chat_id: "alerts@g.us", sender_id: "15555550105@c.us", phone: "15555550105", from_bot: false, text: "[photo: A red sneaker on a white floor, the Acme logo on its side.] new drop", quoted_id: null, sent_at: ago(10) },
    { id: "p-2", chat_id: "other@g.us", sender_id: "15555550105@c.us", phone: "15555550105", from_bot: false, text: "[photo: Someone else's photo.] new drop", quoted_id: null, sent_at: ago(10) },
  ];
  const { routed } = claudeWith([{ action: "ignore" }, { action: "ignore" }, { action: "ignore" }], []);
  const base = { ...said, text: "@iklipse write a caption for this", quoted: "new drop" };
  await takeOrder(f.db, on, team, sender().send, { ...base, id: "q-1", quotedId: "p-1" }, async () => {});
  await takeOrder(f.db, on, team, sender().send, { ...base, id: "q-2", quotedId: "p-2" }, async () => {});
  await takeOrder(f.db, on, team, sender().send, { ...base, id: "q-3", quotedId: "gone" }, async () => {});
  assert.deepEqual(
    routed.map((r) => r.input.replying_to),
    ["[photo: A red sneaker on a white floor, the Acme logo on its side.] new drop", "new drop", "new drop"],
  );
  // Privately, or with nothing quoted: as it came.
  assert.equal(await quotedText(f.db, "15555550105@c.us", "hi", "p-1"), "hi");
  assert.equal(await quotedText(f.db, "alerts@g.us", null, null), null);
  assert.equal(await quotedText(f.db, "alerts@g.us", null, "p-1"), "[photo: A red sneaker on a white floor, the Acme logo on its side.] new drop");
});
