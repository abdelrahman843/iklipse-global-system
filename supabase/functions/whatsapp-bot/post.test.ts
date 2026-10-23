// Posting in a group at an admin's word (post.ts, orders.ts action post): the
// group found by its name, never guessed; the people named tagged only where
// they are; a client group checked first; said back where it went. And the
// router: Claude gets the groups, and what it decides is posted right away.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { groupNamed, groupsIn, postInGroup, type Group } from "./post.ts";
import { ORDER_SYSTEM, orderTool, takeOrder } from "./orders.ts";
import { forgetClients } from "./guard.ts";
import type { Person, Settings, Team } from "./kit.ts";
import type { Attendee } from "./meetings.ts";

const GROUPS: Group[] = [
  { chat_id: "acme@g.us", name: "iklipse X Acme - Launch trailer", kind: "client" },
  { chat_id: "nile@g.us", name: "Nile Foods | Brand day", kind: "client" },
  { chat_id: "nile2@g.us", name: "Nile Foods x iklipse ads", kind: "client" },
  { chat_id: "key@g.us", name: "iklipse Key Team", kind: "team" },
];

test("the group they mean: its name in any case or spacing, else the only one with every word they said", () => {
  assert.equal(groupNamed(GROUPS, "IKLIPSE x acme  launch-trailer").group?.chat_id, "acme@g.us");
  assert.equal(groupNamed(GROUPS, "the acme group").group?.chat_id, "acme@g.us");
  assert.equal(groupNamed(GROUPS, "جروب acme").group?.chat_id, "acme@g.us");
  assert.equal(groupNamed(GROUPS, "key team").group?.chat_id, "key@g.us");
  // Two fit: none is picked, both are said.
  const two = groupNamed(GROUPS, "Nile Foods");
  assert.equal(two.group, null);
  assert.deepEqual(two.fits.map((g) => g.chat_id), ["nile@g.us", "nile2@g.us"]);
  // None fits, or nothing said: nothing.
  assert.deepEqual(groupNamed(GROUPS, "Partnership group"), { group: null, fits: [] });
  assert.deepEqual(groupNamed(GROUPS, "the group"), { group: null, fits: [] });
  assert.deepEqual(groupNamed(GROUPS, ""), { group: null, fits: [] });
});

test("the groups it's in: not the ones it left, nor ones with no name", async () => {
  const f = fakeDb({
    wa_group: [
      { chat_id: "a@g.us", name: "Acme", kind: "client", left_at: null },
      { chat_id: "b@g.us", name: "Gone", kind: "client", left_at: "2026-10-01T00:00:00Z" },
      { chat_id: "c@g.us", name: null, kind: "team", left_at: null },
      { chat_id: "d@g.us", name: " Team room ", kind: "team", left_at: null },
    ],
  });
  assert.deepEqual(await groupsIn(f.db), [
    { chat_id: "a@g.us", name: "Acme", kind: "client" },
    { chat_id: "d@g.us", name: "Team room", kind: "team" },
  ]);
});

// ------------------------------------------------------------ posting --

const sara: Attendee = { kind: "team", id: "u-sara", name: "Sara", email: null, phone: "15555550104" };
const omar: Attendee = { kind: "team", id: "u-omar", name: "Omar", email: null, phone: "15555550105" };

function sender(fail?: string) {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    if (fail) throw new Error(fail);
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}

const world = () =>
  fakeDb({
    wa_group: [
      { chat_id: "acme@g.us", name: "iklipse X Acme - Launch trailer", kind: "client", left_at: null },
      { chat_id: "nile@g.us", name: "Nile Foods | Brand day", kind: "client", left_at: null },
      { chat_id: "nile2@g.us", name: "Nile Foods x iklipse ads", kind: "client", left_at: null },
      { chat_id: "key@g.us", name: "iklipse Key Team", kind: "team", left_at: null },
    ],
    // Sara is in the Acme group and the Key Team; Omar only in the Key Team.
    wa_participant: [
      { chat_id: "acme@g.us", phone: "15555550104" },
      { chat_id: "acme@g.us", phone: "15555550909" },
      { chat_id: "key@g.us", phone: "15555550104" },
      { chat_id: "key@g.us", phone: "15555550105" },
    ],
    wa_message: [{ chat_id: "acme@g.us", text: "Lina: can someone confirm the launch on 28 October?", sent_at: "2026-10-23T11:00:00Z" }],
    client: [
      { id: "c-lina", name: "Lina Hassan", company: "Acme", name_known: true, from_chat: "acme@g.us" },
      { id: "c-mona", name: "Mona Fathy", company: "Nile Foods", name_known: true, from_chat: "nile@g.us" },
    ],
    bot_guard_block: [],
  });

test("only an admin has it post: anyone else hears so, and nothing goes", async () => {
  const f = world();
  const { send, sent } = sender();
  const said = await postInGroup(f.db, send, { admin: false }, { group: "key team", text: "Standup in 5.", tag: [], said: [] });
  assert.equal(said, "Only admins can have me post in other groups.");
  assert.deepEqual(sent, []);
});

test("posted right away in a team group: the tag where @Name was, said back where it went", async () => {
  const f = world();
  const { send, sent } = sender();
  const said = await postInGroup(f.db, send, { admin: true }, { group: "the key team group", text: "@Sara a reminder: the Acme launch post is due today.", tag: [sara], said: [] });
  assert.deepEqual(sent, [{ chat: "key@g.us", text: "@15555550104 a reminder: the Acme launch post is due today.", quoted: null }]);
  assert.equal(said, "Posted in iklipse Key Team, tagging Sara.");
});

test("a tag goes first when the text has no @Name; someone not in the group is written by name, never by number", async () => {
  const f = world();
  const { send, sent } = sender();
  forgetClients();
  const said = await postInGroup(f.db, send, { admin: true }, { group: "acme", text: "please confirm the launch on 28 October.", tag: [sara, omar], said: ["remind them about the launch"] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chat, "acme@g.us");
  assert.equal(sent[0]!.text, "@15555550104 Omar please confirm the launch on 28 October.");
  assert.doesNotMatch(sent[0]!.text, /15555550105/);
  assert.equal(said, "Posted in iklipse X Acme - Launch trailer, tagging Sara.");
});

test("a name that fits no group is never guessed: the alert's own group is offered, or it asks which", async () => {
  const f = world();
  const { send, sent } = sender();
  // The alert's group is a client's: they'd read it, and that's said before the yes.
  assert.equal(
    await postInGroup(f.db, send, { admin: true }, { group: "Partnership", text: "A reminder about the launch.", tag: [sara], alertGroup: "acme@g.us", said: [] }),
    `I'm not in a group called "Partnership". Post it in iklipse X Acme - Launch trailer (the client's group, they'll see it), where that alert is?`,
  );
  // A team group's alert: just where.
  assert.equal(
    await postInGroup(f.db, send, { admin: true }, { group: "Partnership", text: "A reminder about the launch.", tag: [sara], alertGroup: "key@g.us", said: [] }),
    `I'm not in a group called "Partnership". Post it in iklipse Key Team, where that alert is?`,
  );
  assert.equal(await postInGroup(f.db, send, { admin: true }, { group: "Partnership", text: "A reminder.", tag: [], said: [] }), `I'm not in a group called "Partnership". Which group?`);
  assert.equal(await postInGroup(f.db, send, { admin: true }, { group: "", text: "A reminder.", tag: [], said: [] }), "Which group should I post it in?");
  assert.equal(
    await postInGroup(f.db, send, { admin: true }, { group: "nile foods", text: "A reminder.", tag: [], said: [] }),
    "Which group: Nile Foods | Brand day or Nile Foods x iklipse ads?",
  );
  assert.deepEqual(sent, []);
});

test("a client group: what isn't in their message, the alert or the group's talk doesn't go, and is kept for the admins", async () => {
  const f = world();
  const { send, sent } = sender();
  forgetClients();
  const said = await postInGroup(f.db, send, { admin: true }, { group: "acme", text: "Lina, Mona Fathy from Nile Foods loved the trailer.", tag: [], said: ["post that the trailer is ready"] });
  assert.match(said, /^I didn't post it in iklipse X Acme - Launch trailer: it had another client's name \(Mona Fathy\)/);
  assert.deepEqual(sent, []);
  assert.equal(f.tables.bot_guard_block[0]!.where_from, "orders.post");
  assert.equal(f.tables.bot_guard_block[0]!.chat_id, "acme@g.us");
});

test("WhatsApp refusing it is said back", async () => {
  const f = world();
  const said = await postInGroup(f.db, sender("WhatsApp (Green API): not authorized").send, { admin: true }, { group: "key team", text: "Standup in 5.", tag: [], said: [] });
  assert.equal(said, "Couldn't post in iklipse Key Team: WhatsApp (Green API): not authorized");
});

// ---------------------------------------------------------- the router --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
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
const on = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const saraP: Person = { id: "u-sara", name: "Sara", username: "sara", active: true, admin: true };
const omarP: Person = { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false };
const team: Team = {
  people: new Map([
    [saraP.id, saraP],
    [omarP.id, omarP],
  ]),
  byPhone: new Map([
    ["15555550104", saraP],
    ["15555550105", omarP],
  ]),
  byLid: new Map(),
  others: new Set(),
};
const routed = () => {
  const f = world();
  f.tables.profile = [
    { id: "u-sara", display_name: "Sara", role: "admin", is_active: true },
    { id: "u-omar", display_name: "Omar", role: "member", is_active: true },
  ];
  f.tables.profile_contact = [
    { user_id: "u-sara", whatsapp: "15555550104" },
    { user_id: "u-omar", whatsapp: "15555550105" },
  ];
  f.tables.bot_order = [];
  f.tables.watch_alert = [
    { id: "al-1", chat_id: "nile@g.us", title: "Old one", detail: "Mona asked for the invoice.", source: "whatsapp", status: "open", created_at: "2026-10-23T09:00:00Z", wa_group: { name: "Nile Foods | Brand day" } },
    { id: "al-2", chat_id: "acme@g.us", title: "Launch date", detail: "Lina asked the team to confirm the launch on 28 October.", source: "whatsapp", status: "open", created_at: "2026-10-23T11:00:00Z", wa_group: { name: "iklipse X Acme - Launch trailer" } },
  ];
  return f;
};
const msg = { id: "g-1", chatId: "alerts@g.us", where: "team" as const, text: "@iklipse send @Sara a reminder in the acme group about this last open alert, now", quoted: null, phone: "15555550104", lid: null, name: "Sara", via: "mention" as const };

test("the router: post is an action, Claude gets the groups it's in, and the words say how", () => {
  const actions = (orderTool(false).input_schema.properties as Record<string, { enum: string[] }>).action.enum;
  assert.ok(actions.includes("post"));
  assert.match(ORDER_SYSTEM, /\n- post: post a message in a group you're in, right away/);
  assert.match(ORDER_SYSTEM, /"the last open alert" is the newest, the last in open_alerts/);
  assert.match(ORDER_SYSTEM, /never your guess/);
  // A client group is written to the client; a yes to where it offered is post.
  assert.match(ORDER_SYSTEM, /In a group of kind client the client reads it: write it to them, with nothing internal/);
  assert.match(ORDER_SYSTEM, /their answer \("yes", "the first one", a group's name\) is post: what they asked for in earlier, in the group they chose\./);
});

test("an admin's post: in the group named, about the alert, tagged, right away; said back where it was asked", async () => {
  const f = routed();
  const { send, sent } = sender();
  const asked = claudeSays({ action: "post", post: { group: "iklipse X Acme - Launch trailer", alert: "a2", tag: ["t:u-sara"], text: "@Sara a reminder: Lina is waiting for the team to confirm the launch on 28 October." } });
  await takeOrder(f.db, on, team, send, msg, async () => {});
  assert.deepEqual(asked[0]!.groups, [
    { name: "iklipse X Acme - Launch trailer", kind: "client" },
    { name: "Nile Foods | Brand day", kind: "client" },
    { name: "Nile Foods x iklipse ads", kind: "client" },
    { name: "iklipse Key Team", kind: "team" },
  ]);
  // The newest open alerts, oldest first: the last one is the newest.
  assert.deepEqual((asked[0]!.open_alerts as { id: string; where: string }[]).map((a) => [a.id, a.where]), [
    ["a1", "Nile Foods | Brand day"],
    ["a2", "iklipse X Acme - Launch trailer"],
  ]);
  assert.ok(f.calls.some((c) => c.table === "watch_alert" && c.ops.some(([n, col, o]) => n === "order" && col === "created_at" && (o as { ascending?: boolean } | undefined)?.ascending === false)));
  assert.deepEqual(sent, [
    { chat: "acme@g.us", text: "@15555550104 a reminder: Lina is waiting for the team to confirm the launch on 28 October.", quoted: null },
    { chat: "alerts@g.us", text: "Posted in iklipse X Acme - Launch trailer, tagging Sara.", quoted: "g-1" },
  ]);
});

test("a group that isn't there: the alert's group is offered back, nothing is posted", async () => {
  const f = routed();
  const { send, sent } = sender();
  claudeSays({ action: "post", post: { group: "Partnership", alert: "a2", tag: ["t:u-sara"], text: "@Sara a reminder about the launch." } });
  await takeOrder(f.db, on, team, send, msg, async () => {});
  assert.deepEqual(sent, [
    { chat: "alerts@g.us", text: `I'm not in a group called "Partnership". Post it in iklipse X Acme - Launch trailer (the client's group, they'll see it), where that alert is?`, quoted: "g-1" },
  ]);
});

test("the last open alert is the newest even when the database gives the newest first", async () => {
  const f = routed();
  f.tables.watch_alert!.reverse();
  const { send, sent } = sender();
  const asked = claudeSays({ action: "post", post: { group: "Partnership", alert: "a2", tag: [], text: "A reminder about the launch." } });
  await takeOrder(f.db, on, team, send, msg, async () => {});
  assert.equal((asked[0]!.open_alerts as { id: string; where: string }[]).at(-1)!.where, "iklipse X Acme - Launch trailer");
  assert.match(sent[0]!.text, /Post it in iklipse X Acme - Launch trailer/);
});

test("someone who isn't an admin, or an admin who was turned off: nothing is posted", async () => {
  const f = routed();
  const { send, sent } = sender();
  claudeSays({ action: "post", post: { group: "key team", text: "Standup in 5." } }, { action: "post", post: { group: "key team", text: "Standup in 5." } });
  await takeOrder(f.db, on, team, send, { ...msg, id: "g-2", phone: "15555550105", name: "Omar" }, async () => {});
  const gone: Person = { ...saraP, id: "u-gone", name: "Hana", active: false };
  const withGone: Team = { ...team, people: new Map([...team.people, [gone.id, gone]]), byPhone: new Map([...team.byPhone, ["15555550108", gone]]) };
  await takeOrder(f.db, on, withGone, send, { ...msg, id: "g-3", phone: "15555550108", name: "Hana" }, async () => {});
  assert.deepEqual(sent, [
    { chat: "alerts@g.us", text: "Only admins can have me post in other groups.", quoted: "g-2" },
    { chat: "alerts@g.us", text: "Only admins can have me post in other groups.", quoted: "g-3" },
  ]);
});
