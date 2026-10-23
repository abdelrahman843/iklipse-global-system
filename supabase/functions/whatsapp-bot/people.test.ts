// Who's who (people.ts, 0115), with the database in memory: the team as it is
// now (people who left are kept in iklipse, only counted, never listed or
// written to), freelancers and partner companies as their own kinds, listed
// apart; a group with a partner has its people noted as theirs, never as
// clients; and an order to a freelancer or a partner's person goes to them
// privately, like one to a client.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { learnPeople, partnerPeople, partners, WHO_IS_WHO, whoIsWho } from "./people.ts";
import { ANSWER_SYSTEM, ORDER_SYSTEM, situation, TASK_SYSTEM, takeOrder } from "./orders.ts";
import { LOOK_SYSTEM } from "./look.ts";
import { directory } from "./meetings.ts";
import { peopleFor } from "./book.ts";
import { forgetClients } from "./guard.ts";
import type { Person, Settings, Team } from "./kit.ts";

const sara: Person = { id: "u-sara", name: "Sara", username: "sara", active: true, admin: true };
const yara: Person = { id: "u-yara", name: "Yara", username: "yara", active: false, admin: false };
const team = (): Team => ({
  people: new Map([
    [sara.id, sara],
    [yara.id, yara],
  ]),
  byPhone: new Map([
    ["15555550101", sara],
    ["15555550109", yara],
  ]),
  byLid: new Map(),
  others: new Set(),
});

/** The people and the groups: a team member who left, a freelancer with no number yet, a partner company with its people and group. */
const world = (more: Record<string, Record<string, unknown>[]> = {}) =>
  fakeDb({
    profile: [
      { id: "u-sara", display_name: "Sara", username: "sara", role: "admin", is_active: true },
      { id: "u-omar", display_name: "Omar", username: "omar", role: "member", is_active: true },
      { id: "u-gus", display_name: "Gus", username: "gus", role: "guest", is_active: true },
      { id: "u-yara", display_name: "Yara", username: "yara", role: "member", is_active: false },
    ],
    profile_contact: [
      { user_id: "u-sara", whatsapp: "15555550101" },
      { user_id: "u-yara", whatsapp: "15555550109" },
    ],
    partner: [
      { id: "p-mona", name: "Mona", kind: "freelancer", note: null, is_active: true },
      { id: "p-studio", name: "Acme Studio", kind: "company", note: "Video partner", is_active: true },
      { id: "p-old", name: "Tarek", kind: "freelancer", note: null, is_active: false },
    ],
    wa_other: [
      { id: "o-karim", phone: "15555550201", wa_lid: null, name: "Karim", note: "In Acme Studio x iklipse", partner_id: "p-studio" },
      { id: "o-anon", phone: "15555550202", wa_lid: null, name: null, note: "In Acme Studio x iklipse", partner_id: "p-studio" },
      { id: "o-free", phone: "15555550299", wa_lid: null, name: null, note: "In a team group", partner_id: null },
    ],
    wa_group: [
      { chat_id: "studio@g.us", name: "Acme Studio x iklipse", kind: "client", monitored: true, left_at: null, partner_id: "p-studio" },
      { chat_id: "gone@g.us", name: "Old Studio group", kind: "client", monitored: true, left_at: "2026-10-01T10:00:00Z", partner_id: "p-studio" },
      { chat_id: "acme@g.us", name: "Acme | iklipse", kind: "client", monitored: true, left_at: null, partner_id: null },
    ],
    ...more,
  });

// ------------------------------------------------------------ who's who --

test("who's who: the team as it is now, A to Z, who left only counted; freelancers and partner companies apart", async () => {
  const w = await whoIsWho(world().db);
  assert.deepEqual(w.team, ["Gus (guest)", "Omar", "Sara (admin)"]);
  assert.equal(w.left_the_team, 1);
  assert.ok(!JSON.stringify(w).includes("Yara"), "someone who left is never named");
  // A freelancer no longer working with us isn't listed either.
  assert.deepEqual(w.freelancers, [{ name: "Mona", whatsapp: null }]);
  assert.deepEqual(w.partner_companies, [
    {
      name: "Acme Studio",
      people: [
        { name: "Karim", whatsapp: "+15555550201" },
        { name: "+15555550202", whatsapp: "+15555550202" },
      ],
      groups: ["Acme Studio x iklipse"],
      note: "Video partner",
    },
  ]);
});

test("nobody left: no count; before 0115 runs (no partner table): the team alone, nothing breaks", async () => {
  const f = fakeDb(
    { profile: [{ id: "u-sara", display_name: "Sara", role: "admin", is_active: true }] },
    { fail: (c) => (c.table === "partner" ? 'relation "public.partner" does not exist' : null) },
  );
  const w = await whoIsWho(f.db);
  assert.deepEqual(w, { team: ["Sara (admin)"], freelancers: [], partner_companies: [] });
  assert.deepEqual(await partners(f.db), []);
});

test("the people the bot can write to: a freelancer with no number yet, each partner company's people by name and company", async () => {
  const people = partnerPeople(await partners(world().db));
  assert.deepEqual([...people.keys()], ["o-karim", "o-anon", "p-mona"]);
  assert.deepEqual(people.get("o-karim"), { kind: "partner", id: "o-karim", name: "Karim (Acme Studio)", email: null, phone: "15555550201", who: "partner", groups: ["Acme Studio x iklipse"], lid: null });
  assert.equal(people.get("o-anon")!.name, "+15555550202 (Acme Studio)");
  assert.deepEqual(people.get("p-mona"), { kind: "partner", id: "p-mona", name: "Mona", email: null, phone: null, who: "freelancer", groups: [], lid: null });
  // Not anyone's: no kind, not offered as a freelancer or a partner.
  assert.equal(people.has("o-free"), false);
});

test("the words: team lists are who's on the team now, nobody is deleted, freelancers and partners apart, never clients", () => {
  assert.match(WHO_IS_WHO, /never list, offer or write to them as the team/);
  // "List me our whole team" is the team now: who left isn't even counted then.
  assert.match(WHO_IS_WHO, /"the team", "the whole team" and "everyone on the team" mean them/);
  assert.match(WHO_IS_WHO, /"left_the_team" is only how many, said in one short line only when they ask about people who left or everyone who ever worked here/);
  assert.match(WHO_IS_WHO, /turns them off on the Users page rather than deleting them/);
  assert.match(WHO_IS_WHO, /list them apart, each kind under its own heading, and never call them clients/);
  // There's no page for them: one is added by telling the bot (teach, notes.ts).
  assert.match(WHO_IS_WHO, /One the admins taught you about is one too, even with no number yet/);
  assert.doesNotMatch(WHO_IS_WHO, /[—–]/);
  for (const [name, p] of Object.entries({ ANSWER_SYSTEM, TASK_SYSTEM, LOOK_SYSTEM })) assert.ok(p.includes(WHO_IS_WHO), `${name} has no who's who`);
  assert.match(ORDER_SYSTEM, /who's on the team, our freelancers or partners/);
  assert.match(ORDER_SYSTEM, /telling you someone is our freelancer or a partner, or to add one \("add Mona to our freelancers", "Acme Studio is a partner company"\), is teach/);
  assert.match(ORDER_SYSTEM, /To a freelancer or a partner company's person \(who "freelancer" or "partner"\)/);
});

test("a question or a task gets who's who with what's going on", async () => {
  const f = world();
  const going = await situation(f.db, team(), await directory(f.db), []);
  assert.deepEqual(going.who_is_who.team, ["Gus (guest)", "Omar", "Sara (admin)"]);
  assert.equal(going.who_is_who.freelancers[0]!.name, "Mona");
});

test("a group's people (book.ts peopleFor): someone who left the team is never offered, as the team or as a guest", async () => {
  const f = world({
    wa_member: [{ phone: "15555550101", user_id: "u-sara" }],
    wa_member_lid: [{ lid: "100000000009@lid", user_id: "u-yara" }],
    wa_participant: [
      { chat_id: "studio@g.us", wa_id: "15555550101@c.us", phone: "15555550101", lid: null, name: "Sara" },
      // Who left: by the number on her member card, and by a hidden id linked to her.
      { chat_id: "studio@g.us", wa_id: "15555550109@c.us", phone: "15555550109", lid: null, name: "Yara" },
      { chat_id: "studio@g.us", wa_id: "100000000009@lid", phone: null, lid: "100000000009@lid", name: "Yara" },
      { chat_id: "studio@g.us", wa_id: "15555550201@c.us", phone: "15555550201", lid: null, name: "Karim" },
    ],
    client: [],
  });
  const { people } = await peopleFor(f.db, "studio@g.us", "u-omar", null);
  const here = people.filter((p) => p.in_group).map((p) => p.name);
  assert.deepEqual(here, ["Sara", "Karim"]);
  assert.ok(!people.some((p) => /yara/i.test(p.name)));
});

// ----------------------------------------------------- a partner's group --

test("a partner's group: who isn't on the team is the partner's, not a client; a client someone added, from elsewhere or on a project stays", async () => {
  const f = world({
    client: [
      // The bot made it from this group, on no project: it moves.
      { id: "c-layla", name: "Layla", name_known: true, phone: "+15555550203", wa_lid: null, email: null, ask_skip: false, created_by: null, from_chat: "studio@g.us" },
      // Someone on the team added this one: a client.
      { id: "c-hand", name: "Nour", name_known: true, phone: "+15555550204", wa_lid: null, email: null, ask_skip: false, created_by: "u-sara", from_chat: "studio@g.us" },
      // A client of another group, in this one too: a client.
      { id: "c-acme", name: "Hany", name_known: true, phone: "+15555550205", wa_lid: null, email: null, ask_skip: false, created_by: null, from_chat: "acme@g.us" },
      // On a project: a client.
      { id: "c-work", name: "Rana", name_known: true, phone: "+15555550206", wa_lid: null, email: null, ask_skip: false, created_by: null, from_chat: "studio@g.us" },
    ],
    project: [{ id: "pr-1", client_id: "c-work", title: "Launch video", status: "active" }],
    wa_other: [],
    wa_participant: [
      { chat_id: "studio@g.us", wa_id: "15555550101@c.us", phone: "15555550101", lid: null, name: "Sara" },
      { chat_id: "studio@g.us", wa_id: "15555550109@c.us", phone: "15555550109", lid: null, name: "Yara" },
      { chat_id: "studio@g.us", wa_id: "15555550201@c.us", phone: "15555550201", lid: null, name: "Karim" },
      { chat_id: "studio@g.us", wa_id: "100000000001@lid", phone: null, lid: null, name: null },
      { chat_id: "studio@g.us", wa_id: "15555550203@c.us", phone: "15555550203", lid: null, name: "Layla A." },
      { chat_id: "studio@g.us", wa_id: "15555550204@c.us", phone: "15555550204", lid: null, name: "Nour" },
      { chat_id: "studio@g.us", wa_id: "15555550205@c.us", phone: "15555550205", lid: null, name: "Hany" },
      { chat_id: "studio@g.us", wa_id: "15555550206@c.us", phone: "15555550206", lid: null, name: "Rana" },
      { chat_id: "acme@g.us", wa_id: "15555550301@c.us", phone: "15555550301", lid: null, name: "Dina" },
    ],
    bot_ask: [],
  });
  const t = team();
  const added = await learnPeople(f.db, t, null, Date.now() + 60_000);

  const others = f.tables.wa_other.map((o) => ({ phone: o.phone, wa_lid: o.wa_lid, name: o.name, partner_id: o.partner_id, note: o.note }));
  assert.deepEqual(others, [
    { phone: "15555550201", wa_lid: null, name: "Karim", partner_id: "p-studio", note: "In Acme Studio x iklipse" },
    { phone: null, wa_lid: "100000000001@lid", name: null, partner_id: "p-studio", note: "In Acme Studio x iklipse" },
    { phone: "15555550203", wa_lid: null, name: "Layla", partner_id: "p-studio", note: "In Acme Studio x iklipse" },
  ]);
  // The one the bot made moved; the rest are clients still, and the team (even who left) is never anyone's.
  assert.deepEqual(f.tables.client.map((c) => c.id).sort(), ["c-acme", "c-hand", "c-work", f.tables.client.find((c) => c.phone === "+15555550301")!.id].sort());
  assert.ok(!f.tables.client.some((c) => c.phone === "+15555550201" || c.phone === "+15555550109"));
  // The group with no partner: a new person there is a client, as before.
  assert.equal(added, 1);
  assert.equal(f.tables.client.find((c) => c.phone === "+15555550301")!.from_chat, "acme@g.us");
  // Known now, so not taken again on the next look.
  assert.ok(t.others.has("15555550201") && t.others.has("100000000001@lid"));
  assert.ok(f.tables.wa_group.filter((g) => g.chat_id !== "gone@g.us").every((g) => g.people_at));
});

test("before 0115 runs (no partner_id on groups): every client group is learned as before", async () => {
  const f = fakeDb(
    {
      wa_group: [{ chat_id: "acme@g.us", name: "Acme | iklipse", kind: "client", monitored: true, left_at: null }],
      wa_participant: [{ chat_id: "acme@g.us", wa_id: "15555550301@c.us", phone: "15555550301", lid: null, name: "Dina" }],
      client: [],
      bot_ask: [],
    },
    { fail: (c) => (c.table === "wa_group" && c.op === "select" && JSON.stringify(c.ops).includes("partner_id") ? "column wa_group.partner_id does not exist" : null) },
  );
  assert.equal(await learnPeople(f.db, team(), null, Date.now() + 60_000), 1);
  assert.equal(f.tables.client[0]!.name, "Dina");
  assert.equal(f.tables.wa_other, undefined);
});

// --------------------------------------------------------------- orders --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  forgetClients();
});
/** Claude, deciding what the message is: the act tool's input. What it was given is read back. */
function claudeSays(act: Record<string, unknown>) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push(JSON.parse(String(b.messages[0].content)));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
const on = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, order_client_max: 3, bot_phone: null } as unknown as Settings;

test("an order to a partner's person goes to them privately, like a client's; a freelancer with no number is said so; who left isn't offered", async () => {
  const f = world({ bot_order: [], wa_message: [], wa_dm: [], client: [], bot_guard_block: [] });
  const sent: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (sent.push({ chat, text }), `wamid-${sent.length}`);
  const asked = claudeSays({
    action: "orders",
    orders: [
      { kind: "ask", to: "o:o-karim", task: "when the cut is ready", message: "Hi Karim, Sara asks when the cut will be ready.", nudge: "Karim, a reminder: when will the cut be ready?", wait: true },
      { kind: "tell", to: "o:p-mona", task: "send the storyboard", message: "Hi Mona, Sara asks you to send the storyboard.", nudge: "Mona, a reminder.", wait: true },
    ],
  });
  await takeOrder(f.db, on, team(), send, { id: "m-1", chatId: "team@g.us", where: "team", text: "@iklipse ask Karim when the cut is ready and tell Mona to send the storyboard", quoted: null, phone: "15555550101", lid: null, name: "Sara", via: "mention" }, async () => {});

  // What Claude was given: the partner's person and the freelancer, by kind; nobody who left.
  const people = asked[0]!.people as { ref: string; name: string; who: string; group?: string; whatsapp: string | null }[];
  assert.deepEqual(people.find((p) => p.ref === "o:o-karim"), { ref: "o:o-karim", name: "Karim (Acme Studio)", who: "partner", group: "Acme Studio x iklipse", whatsapp: "+15555550201" });
  assert.deepEqual(people.find((p) => p.ref === "o:p-mona"), { ref: "o:p-mona", name: "Mona", who: "freelancer", whatsapp: null });
  assert.ok(!people.some((p) => p.name === "Yara"));

  assert.deepEqual(sent[0], { chat: "15555550201@c.us", text: "Hi Karim, Sara asks when the cut will be ready." });
  const row = f.tables.bot_order[0]!;
  assert.equal(row.to_kind, "client");
  assert.equal(row.to_id, "o-karim");
  assert.equal(row.status, "open");
  assert.equal(f.tables.bot_order.length, 1);
  assert.deepEqual(sent[1], { chat: "team@g.us", text: "Asked Karim. I'll bring the answer here.\nI don't have Mona's WhatsApp number yet, so I can't write to them." });
});

test("a question about a partner's person: who they are, their number, their groups and what they said", async () => {
  const f = world({
    wa_message: [
      { id: "w-1", chat_id: "studio@g.us", phone: "15555550201", sender_id: "15555550201@c.us", from_bot: false, text: "The cut is ready Thursday.", sent_at: "2026-10-20T10:00:00Z", wa_group: { name: "Acme Studio x iklipse" } },
    ],
    bot_order: [],
  });
  const given: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    given.push(String(b.messages[0].content));
    const tool = String(b.tools?.[0]?.name);
    const input = tool === "act" ? { action: "question", about: ["o:o-karim"] } : { text: "Karim said the cut is ready Thursday." };
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: tool === "act" ? "act" : "reply", input }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  const sent: string[] = [];
  await takeOrder(f.db, on, team(), async (_c, text) => (sent.push(text), "wamid-1"), { id: "q-1", chatId: "team@g.us", where: "team", text: "@iklipse what did Karim say about the cut?", quoted: null, phone: "15555550101", lid: null, name: "Sara", via: "mention" }, async () => {});
  const known = JSON.parse(given[1]!);
  assert.equal(known.about.length, 1);
  assert.equal(known.about[0].partner_person, "Karim (Acme Studio)");
  assert.equal(known.about[0].whatsapp, "+15555550201");
  assert.deepEqual(known.about[0].groups, ["Acme Studio x iklipse"]);
  assert.match(known.about[0].said[0], /in Acme Studio x iklipse: The cut is ready Thursday\./);
  assert.deepEqual(sent, ["Karim said the cut is ready Thursday."]);
});
