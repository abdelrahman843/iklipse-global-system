// What the team teaches the bot in chat (notes.ts, 0114), with Claude stubbed
// and the database in memory: only an admin teaches it; what it's taught is
// kept, said back in a line, and goes into every call to Claude after (kit.ts),
// the newest first and within limits; a newer note takes an older one's place;
// admins list and forget them; someone said not to be a client leaves Clients
// (so the bot stops calling them one), and back again.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { listText, MAX_NOTES, numbered, taughtBlock, taughtNotes, teachFrom } from "./notes.ts";
import { ORDER_SYSTEM, orderTool, takeOrder } from "./orders.ts";
import { claude, claudeStep, type Person, type Settings, type Team } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const omar: Person = { id: "u-omar", name: "Omar Adel", username: "omar", active: true, admin: true };
const sara: Person = { id: "u-sara", name: "Sara", username: "sara", active: true, admin: false };
const team = (): Team => ({
  people: new Map([
    [omar.id, omar],
    [sara.id, sara],
  ]),
  byPhone: new Map([
    ["15555550105", omar],
    ["15555550104", sara],
  ]),
  byLid: new Map(),
  others: new Set(),
});
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
/** A note as kept (a row of bot_note). */
const note = (id: string, text: string, min: number, by = "Omar Adel"): { id: string; text: string; by_name: string; created_at: string; forgotten_at: string | null } => ({
  id,
  text,
  by_name: by,
  created_at: ago(min),
  forgotten_at: null,
});
const where = { id: "m-1", chatId: "team@g.us" };

// ------------------------------------------------------------ the block --

test("what Claude is told: the newest first, who taught it and when; nothing with none", () => {
  assert.equal(taughtBlock([]), null);
  const block = taughtBlock([note("a", "Acme's launch moved to March.", 5), note("b", "Omar is our freelancer.", 60, "Sara")])!;
  const [head, ...lines] = block.split("\n");
  assert.match(head!, /^What the team taught you .*the newer one wins\. .*never quote them to a client\.$/);
  assert.match(lines[0]!, /^- Acme's launch moved to March\. \(Omar, \d+ \w+\)$/);
  assert.match(lines[1]!, /^- Omar is our freelancer\. \(Sara, \d+ \w+\)$/);
  assert.doesNotMatch(block, /[—–]/);
});

test("within limits: at most so many notes, and a long one is cut to a line", () => {
  const many = Array.from({ length: MAX_NOTES + 10 }, (_, i) => note(`n${i}`, `Note ${i}.`, i));
  const lines = taughtBlock(many)!.split("\n").slice(1);
  assert.equal(lines.length, MAX_NOTES);
  assert.match(lines[0]!, /^- Note 0\./);
  const long = taughtBlock([note("x", `Acme ${"very ".repeat(200)}long.`, 1)])!.split("\n")[1]!;
  assert.ok(long.length < 340, String(long.length));
  // So many characters in all: the oldest left out first.
  const big = Array.from({ length: MAX_NOTES }, (_, i) => note(`b${i}`, `${i} ${"x".repeat(250)}`, i));
  const kept = taughtBlock(big)!;
  assert.ok(kept.length < 3400, String(kept.length));
  assert.match(kept.split("\n")[1]!, /^- 0 x/);
});

test("the notes in force, the newest first; none before 0114 runs", async () => {
  const f = fakeDb({ bot_note: [note("old", "Old.", 90), { ...note("gone", "Forgotten.", 10), forgotten_at: ago(5) }, note("new", "New.", 1)] });
  assert.deepEqual((await taughtNotes(f.db)).map((n) => n.id), ["new", "old"]);
  const before = fakeDb({}, { fail: (c) => (c.table === "bot_note" ? 'relation "bot_note" does not exist' : null) });
  assert.deepEqual(await taughtNotes(before.db), []);
});

// ------------------------------------------------------------ teaching --

test("an admin teaches it: kept, said back in a line, and in what Claude is told from now on", async () => {
  const f = fakeDb({ bot_note: [] });
  const s: { taught?: string | null } = {};
  const said = await teachFrom(f.db, s, team(), omar, where, { op: "add", notes: ["Acme's launch moved to March."] }, []);
  assert.equal(said, "Got it: Acme's launch moved to March.");
  const row = f.tables.bot_note[0]!;
  assert.equal(row.text, "Acme's launch moved to March.");
  assert.equal(row.by_user, "u-omar");
  assert.equal(row.by_name, "Omar Adel");
  assert.equal(row.chat_id, "team@g.us");
  assert.equal(row.source_id, "m-1");
  assert.match(s.taught!, /\n- Acme's launch moved to March\. \(Omar, /);
  // The same thing again, however it's written: kept once.
  const again = await teachFrom(f.db, s, team(), omar, { ...where, id: "m-2" }, { op: "add", notes: ["acme's launch moved to march"] }, await taughtNotes(f.db));
  assert.equal(again, "Got it: acme's launch moved to march.");
  assert.equal(f.tables.bot_note.length, 1);
});

test("only admins teach it, or see what it was taught; nothing is kept", async () => {
  const f = fakeDb({ bot_note: [] });
  assert.equal(await teachFrom(f.db, {}, team(), sara, where, { op: "add", notes: ["Omar is our freelancer."] }, []), "Only admins can teach me.");
  assert.equal(await teachFrom(f.db, {}, team(), sara, where, { op: "list" }, []), "Only admins can see what I was taught.");
  assert.equal(await teachFrom(f.db, {}, team(), undefined, where, { op: "forget", forget: ["n1"] }, []), "Only admins can teach me.");
  assert.equal(await teachFrom(f.db, {}, team(), { ...omar, active: false }, where, { op: "add", notes: ["x"] }, []), "Only admins can teach me.");
  assert.equal(f.tables.bot_note.length, 0);
});

test("a newer note in an older one's place: the older one is forgotten, and the newer one says why", async () => {
  const old = note("note-1", "Answer Omar in English.", 60);
  const f = fakeDb({ bot_note: [old, note("note-2", "Acme pays in dollars.", 30)] });
  const taught = await taughtNotes(f.db);
  const s: { taught?: string | null } = {};
  // n1: the first note ever taught (numbered).
  assert.equal(await teachFrom(f.db, s, team(), omar, where, { op: "add", notes: ["Answer Omar in Franco-Arabic."], replaces: ["n1"] }, taught), "Got it: Answer Omar in Franco-Arabic.");
  const made = f.tables.bot_note.find((n) => n.text === "Answer Omar in Franco-Arabic.")!;
  const gone = f.tables.bot_note.find((n) => n.id === "note-1")!;
  assert.ok(gone.forgotten_at);
  assert.equal(gone.forgotten_by, "u-omar");
  assert.equal(gone.replaced_by, made.id);
  assert.equal(f.tables.bot_note.find((n) => n.id === "note-2")!.forgotten_at, null);
  assert.doesNotMatch(s.taught!, /in English/);
  assert.match(s.taught!, /Franco-Arabic/);
});

test("admins list what it was taught, each with its number for good (the nth ever taught, forgotten ones too), and forget one by it", async () => {
  const f = fakeDb({
    bot_note: [{ ...note("note-0", "Old and gone.", 90), forgotten_at: ago(70) }, note("note-1", "Acme pays in dollars.", 60), note("note-2", "Omar is our freelancer.", 30)],
  });
  const taught = await taughtNotes(f.db);
  const list = await teachFrom(f.db, {}, team(), omar, where, { op: "list" }, taught);
  assert.match(list, /^What I was taught, newest first:\n3\. Omar is our freelancer\. \(Omar, [^)]+\)\n2\. Acme pays in dollars\. \(Omar, [^)]+\)\nTo drop one: "forget 3"\.$/);
  assert.match(listText([]), /^Nothing yet\./);
  // Something taught after the list was seen: 2 is still the same note, the new one is 4.
  await teachFrom(f.db, {}, team(), omar, { ...where, id: "m-2" }, { op: "add", notes: ["Mona is our freelancer."] }, taught);
  const now = await numbered(f.db, await taughtNotes(f.db));
  assert.deepEqual(now.map((n) => [n.no, n.text]), [
    [4, "Mona is our freelancer."],
    [3, "Omar is our freelancer."],
    [2, "Acme pays in dollars."],
  ]);
  const s: { taught?: string | null } = {};
  assert.equal(await teachFrom(f.db, s, team(), omar, where, { op: "forget", forget: ["n2"] }, now), "Forgot: Acme pays in dollars.");
  assert.ok(f.tables.bot_note.find((n) => n.id === "note-1")!.forgotten_at);
  assert.doesNotMatch(s.taught!, /dollars/);
  // One forgotten doesn't move the others either.
  assert.deepEqual((await numbered(f.db, await taughtNotes(f.db))).map((n) => n.no), [4, 3]);
  assert.equal(await teachFrom(f.db, s, team(), omar, where, { op: "forget", forget: ["n9"] }, now), "Which one? Nothing I was taught matches.");
});

test("before 0114 runs: it says it can't keep it yet", async () => {
  const f = fakeDb({}, { fail: (c) => (c.table === "bot_note" && c.op === "insert" ? 'relation "bot_note" does not exist' : null) });
  assert.equal(await teachFrom(f.db, {}, team(), omar, where, { op: "add", notes: ["Acme pays in dollars."] }, []), "Couldn't keep that: teaching me isn't set up yet.");
});

// --------------------------------------------------- client or not one --

function clients() {
  return fakeDb({
    bot_note: [],
    client: [
      // Put in Clients by the bot from a group: nobody added them, no projects.
      { id: "c-sara", name: "Sara Ahmed", name_known: true, phone: "+15550003001", wa_lid: null, created_by: null },
      { id: "c-mona", name: "Mona Fathy", name_known: true, phone: "+15550003002", wa_lid: "155500030021@lid", created_by: null },
      { id: "c-acme", name: "Acme Ltd", name_known: true, phone: "+15550003003", wa_lid: null, created_by: null },
      { id: "c-nile", name: "Nile Foods", name_known: true, phone: "+15550003004", wa_lid: null, created_by: "u-omar" },
    ],
    project: [{ id: "p-1", client_id: "c-acme", title: "Acme launch" }],
    wa_other: [],
  });
}

test("someone said not to be a client leaves Clients, into not clients, so they're never called a client again", async () => {
  const f = clients();
  const t = team();
  const said = await teachFrom(f.db, {}, t, omar, where, { op: "add", notes: ["Sara Ahmed is not a client."], people: [{ ref: "c:c-sara", name: "Sara Ahmed", is: "not_client" }] }, []);
  assert.equal(said, "Got it: Sara Ahmed is not a client. Took Sara Ahmed out of Clients.");
  assert.deepEqual(f.tables.wa_other.map(({ phone, wa_lid, name, note, created_by }) => ({ phone, wa_lid, name, note, created_by })), [
    { phone: "15550003001", wa_lid: null, name: "Sara Ahmed", note: "Not a client, said Omar Adel on WhatsApp", created_by: "u-omar" },
  ]);
  assert.equal(f.tables.client.some((c) => c.id === "c-sara"), false);
  assert.ok(t.others.has("15550003001"));

  // A freelancer, known by a hidden number too.
  const mona = await teachFrom(f.db, {}, t, omar, { ...where, id: "m-2" }, { op: "add", notes: ["Mona Fathy is our freelancer."], people: [{ ref: "c:c-mona", name: "Mona", is: "freelancer" }] }, []);
  assert.equal(mona, "Got it: Mona Fathy is our freelancer. Took Mona Fathy out of Clients.");
  assert.equal(f.tables.wa_other[1]!.wa_lid, "155500030021@lid");
  assert.equal(f.tables.wa_other[1]!.note, "Freelancer, said Omar Adel on WhatsApp");
  assert.ok(t.others.has("155500030021@lid"));
});

test("someone with projects, or added by someone on the team, stays in Clients (taking them out deletes them): changed by hand", async () => {
  const f = clients();
  const acme = await teachFrom(f.db, {}, team(), omar, where, { op: "add", notes: ["Acme Ltd is a partner."], people: [{ ref: "c:c-acme", name: "Acme", is: "partner" }] }, []);
  assert.equal(acme, "Got it: Acme Ltd is a partner. Acme Ltd stays in Clients, as they have projects: change it in Alerts > Groups.");
  const nile = await teachFrom(f.db, {}, team(), omar, { ...where, id: "m-2" }, { op: "add", notes: ["Nile Foods is not a client."], people: [{ ref: "c:c-nile", name: "Nile Foods", is: "not_client" }] }, []);
  assert.match(nile, /Nile Foods stays in Clients, as someone on the team added them/);
  assert.equal(f.tables.client.length, 4);
  assert.deepEqual(f.tables.wa_other, []);
  // The note is kept all the same.
  assert.equal(f.tables.bot_note.length, 2);
  // Someone on the team, or not in Clients at all: nothing to move.
  assert.equal(await teachFrom(f.db, {}, team(), omar, { ...where, id: "m-3" }, { op: "add", notes: ["Sara is on the team."], people: [{ ref: "t:u-sara", name: "Sara", is: "not_client" }] }, []), "Got it: Sara is on the team.");
});

test("said to be our freelancer, with a freelancer by that name in iklipse (0115): their number becomes the freelancer's", async () => {
  const f = clients();
  f.tables.partner = [
    { id: "f-mona", name: "Mona", kind: "freelancer", is_active: true },
    { id: "f-acme", name: "Acme Studio", kind: "company", is_active: true },
  ];
  const said = await teachFrom(f.db, {}, team(), omar, where, { op: "add", notes: ["Mona Fathy is our freelancer."], people: [{ ref: "c:c-mona", name: "Mona", is: "freelancer" }] }, []);
  assert.equal(said, "Got it: Mona Fathy is our freelancer. Took Mona Fathy out of Clients, as our freelancer Mona.");
  assert.equal(f.tables.wa_other[0]!.partner_id, "f-mona");
  // Not a freelancer by that name: not linked (the bot never adds one itself).
  const g = clients();
  g.tables.partner = [{ id: "f-omar", name: "Omar", kind: "freelancer", is_active: true }];
  await teachFrom(g.db, {}, team(), omar, where, { op: "add", notes: ["Sara Ahmed is our freelancer."], people: [{ ref: "c:c-sara", name: "Sara Ahmed", is: "freelancer" }] }, []);
  assert.equal("partner_id" in g.tables.wa_other[0]!, false);
});

test("someone in not clients said to be a client: out of it, and their groups looked at again (which adds them to Clients)", async () => {
  const f = fakeDb({
    bot_note: [],
    wa_other: [{ id: "o-1", phone: "15550003005", wa_lid: null, name: "Hana Said", note: "In a team group" }],
    wa_participant: [
      { chat_id: "acme@g.us", phone: "15550003005", lid: null, wa_id: "15550003005@c.us" },
      { chat_id: "other@g.us", phone: "15550009999", lid: null, wa_id: "15550009999@c.us" },
    ],
    wa_group: [
      { chat_id: "acme@g.us", people_at: ago(10) },
      { chat_id: "other@g.us", people_at: ago(10) },
    ],
  });
  const t = team();
  t.others.add("15550003005");
  const said = await teachFrom(f.db, {}, t, omar, where, { op: "add", notes: ["Hana Said is a client."], people: [{ ref: "", name: "Hana", is: "client" }] }, []);
  assert.equal(said, "Got it: Hana Said is a client. Hana Said goes back in Clients the next time I look at their groups.");
  assert.deepEqual(f.tables.wa_other, []);
  assert.equal(f.tables.wa_group.find((g) => g.chat_id === "acme@g.us")!.people_at, null);
  assert.notEqual(f.tables.wa_group.find((g) => g.chat_id === "other@g.us")!.people_at, null);
  assert.equal(t.others.has("15550003005"), false);
});

// ----------------------------------------------- from a message (orders.ts) --

/** Claude, deciding what each message is (the act tool's input, in turn); what it was given, system and all, is kept. */
function claudeSays(...acts: Record<string, unknown>[]) {
  const asked: { system: { text: string }[]; input: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push({ system: b.system, input: JSON.parse(String(b.messages[0].content)) });
    const act = acts.shift();
    if (!act) throw new Error("Claude was asked once too often");
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
function sender() {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => (sent.push({ chat, text, quoted }), `wamid-${sent.length}`);
  return { send, sent };
}
const world = () =>
  fakeDb({
    profile: [
      { id: "u-omar", display_name: "Omar Adel", role: "admin", is_active: true },
      { id: "u-sara", display_name: "Sara", role: "member", is_active: true },
    ],
    profile_contact: [
      { user_id: "u-omar", whatsapp: "15555550105" },
      { user_id: "u-sara", whatsapp: "15555550104" },
    ],
    client: [{ id: "c-sara", name: "Sara Ahmed", name_known: true, phone: "+15550003001", wa_lid: null, created_by: null }],
    bot_order: [],
    wa_message: [],
    wa_other: [],
    bot_note: [note("note-1", "Acme pays in dollars.", 60)],
  });
const msg = { id: "g-1", chatId: "team@g.us", where: "team" as const, quoted: null, lid: null };

test("in the team group, an admin corrects it: kept, Clients fixed, said back, and the next call to Claude knows it", async () => {
  const f = world();
  const s = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
  s.taught = taughtBlock(await taughtNotes(f.db));
  const asked = claudeSays(
    { action: "teach", teach: { op: "add", notes: ["Sara Ahmed is not a client."], people: [{ ref: "c:c-sara", name: "Sara Ahmed", is: "not_client" }] } },
    { action: "ignore" },
  );
  const { send, sent } = sender();
  // Carrying on the conversation after the bot called her a client.
  await takeOrder(f.db, s, team(), send, { ...msg, text: "sara ahmed is not a client", phone: "15555550105", name: "Omar", via: "conversation" }, async () => {});
  // An admin is given what it was taught, with ids to change or forget one.
  assert.deepEqual(asked[0]!.input.taught, [{ id: "n1", text: "Acme pays in dollars." }]);
  assert.match(asked[0]!.system[1]!.text, /\n- Acme pays in dollars\./);
  assert.deepEqual(sent, [{ chat: "team@g.us", text: "Got it: Sara Ahmed is not a client. Took Sara Ahmed out of Clients.", quoted: "g-1" }]);
  assert.equal(f.tables.client.length, 0);

  await takeOrder(f.db, s, team(), send, { ...msg, id: "g-2", text: "iklipse who's Sara Ahmed?", phone: "15555550105", name: "Omar", via: "name" }, async () => {});
  // Taught, newest first; and she isn't in people as a client anymore.
  assert.match(asked[1]!.system[1]!.text, /\n- Sara Ahmed is not a client\. \(Omar, [^)]+\)\n- Acme pays in dollars\./);
  assert.equal((asked[1]!.input.people as { ref: string }[]).some((p) => p.ref === "c:c-sara"), false);
});

test("in the team group, someone who isn't an admin: told only admins can (carrying on a conversation, nothing); never given the notes' ids", async () => {
  const f = world();
  const s = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
  const teach = { action: "teach", teach: { op: "add", notes: ["Sara Ahmed is not a client."] } };
  const asked = claudeSays(teach, teach);
  const { send, sent } = sender();
  await takeOrder(f.db, s, team(), send, { ...msg, text: "@iklipse sara ahmed is not a client", phone: "15555550104", name: "Sara", via: "mention" }, async () => {});
  assert.equal("taught" in asked[0]!.input, false);
  assert.deepEqual(sent.map((m) => m.text), ["Only admins can teach me."]);
  await takeOrder(f.db, s, team(), send, { ...msg, id: "g-3", text: "sara ahmed is not a client", phone: "15555550104", name: "Sara", via: "conversation" }, async () => {});
  assert.equal(sent.length, 1);
  assert.equal(f.tables.bot_note.length, 1);
  assert.equal(f.tables.client.length, 1);
});

test("the words: teach is offered and explained", () => {
  assert.ok((orderTool(false).input_schema.properties as Record<string, { enum?: string[] }>).action.enum!.includes("teach"));
  assert.match(ORDER_SYSTEM, /\n- teach: [^\n]+\n/);
  assert.match(ORDER_SYSTEM, /Correcting something you said \("she's not a client" after you called her one\) is teach too, even carrying on a conversation\./);
  assert.doesNotMatch(ORDER_SYSTEM.match(/\n- teach: [^\n]+/)![0], /[—–]/);
});

// ---------------------------------------------------- every call to Claude --

/** fetch answering once; the request's body is kept. */
function oneAnswer(content: unknown[]) {
  const bodies: { system: unknown }[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ content, usage: {} }), { status: 200 });
  }) as typeof fetch;
  return bodies;
}
const cached = (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } });
const taughtS = { model: "claude-haiku-5-5", taught: "What the team taught you...\n- Acme pays in dollars." };

test("every call to Claude gets what it was taught, cached after the stable part and before what changes", async () => {
  let bodies = oneAnswer([{ type: "text", text: "ok" }]);
  await claude(taughtS, { name: "dm.reply", role: "main" }, "rules", "u");
  assert.deepEqual(bodies[0]!.system, [cached("rules"), cached(taughtS.taught)]);

  bodies = oneAnswer([{ type: "text", text: "ok" }]);
  await claude(taughtS, { name: "book.act", role: "fast" }, { stable: "rules", now: "It is Fri 18:00" }, "u");
  assert.deepEqual(bodies[0]!.system, [cached("rules"), cached(taughtS.taught), { type: "text", text: "It is Fri 18:00" }]);

  // The agent and look.ts: each turn.
  bodies = oneAnswer([]);
  await claudeStep(taughtS, { name: "agent.turn", role: "agent" }, "sys", [], [], 2000);
  assert.deepEqual(bodies[0]!.system, [cached("sys"), cached(taughtS.taught)]);
});

test("but not reading a file, or writing a client's notes; and nothing taught, nothing added", async () => {
  for (const name of ["files.read", "memory.write"]) {
    const bodies = oneAnswer([{ type: "text", text: "ok" }]);
    await claude(taughtS, { name, role: "fast" }, "rules", "u");
    assert.deepEqual(bodies[0]!.system, [cached("rules")], name);
  }
  const bodies = oneAnswer([{ type: "text", text: "ok" }]);
  await claude({ ...taughtS, taught: null }, { name: "dm.reply", role: "main" }, "rules", "u");
  assert.deepEqual(bodies[0]!.system, [cached("rules")]);
});
