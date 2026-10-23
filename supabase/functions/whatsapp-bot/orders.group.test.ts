// Orders from the team, two more things (orders.ts): an order to everyone on
// the team goes to each one active (never the one asking, never someone
// inactive), right away, written to each by name; and in a group, Claude sees
// what the sender asked there in the last hour and what the bot answered, and
// the bot's own post just before (earlier), so "right now" carries their last
// request on instead of asking what they mean.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { everyone, ORDER_SYSTEM, takeOrder, toEach, YOU_CAN } from "./orders.ts";
import type { Person, Settings, Team } from "./kit.ts";
import type { Attendee } from "./meetings.ts";

// ------------------------------------------------------------ everyone --

const a = (id: string, name: string, phone: string | null): Attendee => ({ kind: "team", id, name, email: null, phone });

test("everyone: the team but the one asking (by profile or by number) and the bot; a shared number once; no number stays in", () => {
  const team = new Map(
    [
      a("u-sara", "Sara", "15555550104"),
      a("u-omar", "Omar", "15555550105"),
      a("u-shared", "Front desk", "15555550104"),
      a("u-karim", "Karim", null),
      a("u-bot", "Bot", "15555550999"),
      a("u-lina", "Lina", "15555550106"),
      a("u-lina2", "Lina B", "15555550106"),
    ].map((x) => [x.id!, x]),
  );
  // Sara asks: not her, nor the profile with her number; the bot's number never.
  assert.deepEqual(everyone(team, { id: "u-sara", phone: "15555550104" }, "15555550999").map((x) => x.id), ["u-karim", "u-lina", "u-omar"]);
  // Asked from a number iklipse doesn't link to a profile: still not them.
  assert.deepEqual(everyone(team, { id: null, phone: "15555550105" }, "15555550999").map((x) => x.id), ["u-karim", "u-lina", "u-sara"]);
});

test("toEach: {name} is theirs; a greeting to someone else becomes theirs; else they're greeted", () => {
  const names = new Set(["sara", "omar"]);
  assert.equal(toEach("Hi {name}, Sara asks you to test the bot.", "Omar", names), "Hi Omar, Sara asks you to test the bot.");
  assert.equal(toEach("Hi team, Sara asks you to test the bot.", "Omar", names), "Hi Omar, Sara asks you to test the bot.");
  assert.equal(toEach("Hello everyone! Sara asks you to test the bot.", "Omar", names), "Hi Omar, Sara asks you to test the bot.");
  assert.equal(toEach("Sara, a reminder: reply to the bot.", "Omar", names), "Omar, a reminder: reply to the bot.");
  assert.equal(toEach("A reminder: reply to the bot.", "Omar", names), "Hi Omar, a reminder: reply to the bot.");
  assert.equal(toEach("Sara asks you to test the bot.", "Omar", names), "Hi Omar, Sara asks you to test the bot.");
  assert.equal(toEach("", "Omar", names), "");
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude: the act tool's input, in turn; what it was given is read back. */
function claudeSays(...acts: Record<string, unknown>[]) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push(JSON.parse(String(b.messages[0].content)));
    const act = acts.shift();
    if (!act) throw new Error("Claude was asked once too often");
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
function sender() {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}
const on = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const P = (id: string, name: string, admin = false): Person => ({ id, name, username: name.toLowerCase(), active: true, admin });
const sara = P("u-sara", "Sara", true);
const omar = P("u-omar", "Omar");
const lina = P("u-lina", "Lina");
const team: Team = {
  people: new Map([sara, omar, lina].map((p) => [p.id, p])),
  byPhone: new Map([
    ["15555550104", sara],
    ["15555550105", omar],
    ["15555550106", lina],
  ]),
  byLid: new Map(),
  others: new Set(),
};
const world = () =>
  fakeDb({
    profile: [
      { id: "u-sara", display_name: "Sara", role: "admin", is_active: true },
      { id: "u-omar", display_name: "Omar", role: "member", is_active: true },
      { id: "u-lina", display_name: "Lina", role: "member", is_active: true },
      { id: "u-mona", display_name: "Mona", role: "member", is_active: false },
      { id: "u-karim", display_name: "Karim", role: "member", is_active: true },
    ],
    profile_contact: [
      { user_id: "u-sara", whatsapp: "15555550104" },
      { user_id: "u-omar", whatsapp: "15555550105" },
      { user_id: "u-lina", whatsapp: "15555550106" },
      { user_id: "u-mona", whatsapp: "15555550107" },
    ],
    bot_order: [],
    wa_message: [],
    wa_group: [],
  });
const said = { id: "g-1", chatId: "alerts@g.us", where: "team" as const, text: "@iklipse message everyone on the team to test you", quoted: null, phone: "15555550104", lid: null, name: "Sara", via: "mention" as const };

test("an order to everyone: each one active but the one asking, right away, by name; who can't be reached is said", async () => {
  const f = world();
  const { send, sent } = sender();
  claudeSays({
    action: "orders",
    orders: [
      {
        kind: "tell",
        to: "everyone",
        task: "message the bot back to test it, then tell Sara in the alerts group",
        message: "Hi {name}, Sara asks you to reply to this message to test the bot, then tell her in the alerts group that you did. Reply here when it's done, or tell me what's in the way.",
        nudge: "{name}, a reminder: Sara asked you to reply to the bot to test it.",
        wait: true,
      },
    ],
  });
  await takeOrder(f.db, on, team, send, said, async () => {});
  // Lina and Omar by number; Karim has none; Mona is inactive; Sara asked.
  assert.deepEqual(
    sent.slice(0, 2).map((m) => [m.chat, m.text]),
    [
      ["15555550106@c.us", "Hi Lina, Sara asks you to reply to this message to test the bot, then tell her in the alerts group that you did. Reply here when it's done, or tell me what's in the way."],
      ["15555550105@c.us", "Hi Omar, Sara asks you to reply to this message to test the bot, then tell her in the alerts group that you did. Reply here when it's done, or tell me what's in the way."],
    ],
  );
  assert.deepEqual(sent[2], {
    chat: "alerts@g.us",
    text: "Sent to Lina and Omar. I'll follow up until it's done.\nI don't have Karim's WhatsApp number. Add it on the Users page, then ask again.",
    quoted: "g-1",
  });
  assert.equal(sent.length, 3);
  // Each one kept, to follow up, with their own reminder.
  assert.deepEqual(
    f.tables.bot_order.map((o) => [o.to_name, o.status, o.nudge]),
    [
      ["Lina", "open", "Lina, a reminder: Sara asked you to reply to the bot to test it."],
      ["Omar", "open", "Omar, a reminder: Sara asked you to reply to the bot to test it."],
    ],
  );
});

test("the words: everyone is one order with to \"everyone\" and {name}", () => {
  assert.match(ORDER_SYSTEM, /one order with to "everyone", \{name\} in its message and nudge/);
});

// ------------------------------------------------------------ earlier --

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("earlier: what they asked in this group in the last hour and what the bot answered, oldest first; nobody else's, nothing after", async () => {
  const f = world();
  f.tables.wa_message = [
    { id: "s-old", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse who's late?", quoted_id: null, sent_at: ago(70) },
    // Over half an hour before "right now": still what it pushes.
    { id: "s-0", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse send Omar a reminder in the Acme group about the last open alert", quoted_id: null, sent_at: ago(37) },
    { id: "s-1", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse if you can't, tell Karim to add it", quoted_id: null, sent_at: ago(3) },
    { id: "o-1", chat_id: "alerts@g.us", sender_id: "15555550105@c.us", phone: "15555550105", from_bot: false, text: "lunch?", quoted_id: null, sent_at: ago(2.8) },
    { id: "b-1", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "What should I be able to do?", quoted_id: "s-1", sent_at: ago(2.5) },
    { id: "b-2", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "Sure, Omar.", quoted_id: "o-1", sent_at: ago(2.4) },
    { id: "s-2", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "right now", quoted_id: null, sent_at: ago(2) },
    { id: "s-3", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "thanks", quoted_id: null, sent_at: ago(1) },
  ];
  const asked = claudeSays({ action: "ignore" });
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "s-2", text: "right now", via: "conversation" }, async () => {});
  const lines = asked[0]!.earlier as string[];
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^\[.+\] THEM: iklipse send Omar a reminder in the Acme group about the last open alert$/);
  assert.match(lines[1]!, /^\[.+\] THEM: iklipse if you can't, tell Karim to add it$/);
  assert.match(lines[2]!, /^\[.+\] YOU: What should I be able to do\?$/);
});

test("earlier: the bot's own last post to the group just before (the open alerts list) is in it; one from longer ago isn't", async () => {
  const f = world();
  f.tables.wa_message = [
    { id: "b-0", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "Open alerts: 1\nNile Foods\nMona asked for the invoice.", quoted_id: null, sent_at: ago(45) },
    { id: "s-0", chat_id: "alerts@g.us", sender_id: "15555550104@c.us", phone: "15555550104", from_bot: false, text: "iklipse send Omar a reminder in the Partnership group about this last open alert", quoted_id: null, sent_at: ago(37) },
    { id: "b-9", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "Open alerts: 1\nAcme\nLina is waiting for a reply about the launch.", quoted_id: null, sent_at: ago(1) },
  ];
  const asked = claudeSays({ action: "ignore" });
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "s-2", text: "@iklipse right now" }, async () => {});
  const lines = asked[0]!.earlier as string[];
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\[.+\] THEM: iklipse send Omar a reminder in the Partnership group about this last open alert$/);
  assert.match(lines[1]!, /^\[.+\] YOU, to the group: Open alerts: 1 Acme Lina is waiting for a reply about the launch\.$/);
});

test("earlier: none when they said nothing before, and none privately (the chat is there)", async () => {
  const f = world();
  f.tables.wa_message = [
    { id: "o-1", chat_id: "alerts@g.us", sender_id: "15555550105@c.us", phone: "15555550105", from_bot: false, text: "lunch?", quoted_id: null, sent_at: ago(2) },
    { id: "b-9", chat_id: "alerts@g.us", sender_id: null, phone: null, from_bot: true, text: "Open alerts: 1", quoted_id: null, sent_at: ago(1) },
  ];
  const asked = claudeSays({ action: "ignore" }, { action: "ignore" });
  await takeOrder(f.db, on, team, sender().send, { ...said, id: "s-9", text: "iklipse who's late?" }, async () => {});
  assert.equal("earlier" in asked[0]!, false);
  await takeOrder(world().db, on, team, sender().send, { ...said, id: "d-1", chatId: "15555550104@c.us", where: "private", via: undefined }, async () => {});
  assert.equal("earlier" in asked[1]!, false);
});

test("the words: a push (\"right now\", \"do it\", \"yalla\") is their latest request not carried out; earlier is never done twice", () => {
  assert.match(ORDER_SYSTEM, /In a group, "earlier" has what they wrote there in the last hour and what you answered them, and what you last posted to the group just before, oldest first\./);
  for (const x of ["right now", "do it", "yalla"]) assert.ok(ORDER_SYSTEM.includes(`"${x}"`), x);
  assert.match(ORDER_SYSTEM, /never again on something earlier you already did/);
  assert.match(ORDER_SYSTEM, /never ask them what they mean/);
});

test("a question about what the bot does is answered from what it does (you_can): posting in other groups is in it", async () => {
  assert.ok(YOU_CAN.some((x) => /post in any group you're in/.test(x)));
  assert.ok(YOU_CAN.some((x) => /everyone on the team/.test(x)));
  // "If I give you new instructions, will you remember them in other chats?": yes, what an admin teaches it.
  assert.ok(YOU_CAN.some((x) => /^remember what an admin teaches you in chat .*in every chat from then on, and list it or forget one/.test(x)));
  assert.ok(YOU_CAN.some((x) => /freelancers and partners/.test(x)));
  // A voice note in a team group: how it reaches the bot is said.
  assert.ok(YOU_CAN.some((x) => /voice notes.*in a team group, they send one as a reply to a message of yours, or start it with your name/.test(x)));
  assert.doesNotMatch(YOU_CAN.join("\n"), /[—–]/);
  // "Can you post in other groups?": routed as a question, and the answer's Claude is given you_can.
  const given: unknown[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    given.push(b.messages[0].content);
    const tool = String(b.tools?.[0]?.name);
    const input = tool === "act" ? { action: "question", about: [] } : { text: "Yes. Tell me the group and what to post." };
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: tool === "act" ? "act" : "reply", input }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  const { send, sent } = sender();
  await takeOrder(world().db, on, team, send, { ...said, id: "q-1", text: "@iklipse can you send messages in other groups when I ask?" }, async () => {});
  const known = JSON.parse(String(given[1]));
  assert.deepEqual(known.you_can, YOU_CAN);
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "Yes. Tell me the group and what to post.", quoted: "q-1" }]);
});
