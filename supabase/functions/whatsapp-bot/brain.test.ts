// The brain's side of this function (brain.ts): who reaches it (only through
// links an admin made), the signatures both ways, handing a message over
// (once, and back to the order router when the brain is down), the owner's
// kill switch, and OKs that only a new message from an owner number with the
// right code gives. Names and numbers are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import {
  askOwner,
  brainOn,
  canonical,
  forward,
  forwardEdit,
  fromOwner,
  ownerSays,
  ownerWord,
  reaches,
  signature,
  signedBy,
  tierNow,
  tierOf,
  type BrainSettings,
} from "./brain.ts";

const OWNER = "201000000001";
const ADMIN = "201000000002";
const MEMBER = "201000000003";
const SECRET = "s".repeat(40);

const settings = (o: Partial<BrainSettings> = {}): BrainSettings => ({
  phase: 2,
  stopped: false,
  owner_phones: [OWNER],
  fallback_old: false,
  model_owner: "claude-opus-5-5",
  model_member: "claude-sonnet-5-5",
  model_fast: "claude-haiku-5-5",
  max_turns: 40,
  member_turns: 12,
  run_minutes: 15,
  run_cost_usd: 5,
  day_cost_usd: 40,
  ...o,
});

function team() {
  return {
    profile: [
      { id: "u-owner", display_name: "Sameh", username: "sameh", role: "admin", is_active: true },
      { id: "u-admin", display_name: "Mona", username: "mona", role: "admin", is_active: true },
      { id: "u-member", display_name: "Rabah", username: "rabah", role: "member", is_active: true },
      { id: "u-guest", display_name: "Guest", username: "guest", role: "guest", is_active: true },
      { id: "u-left", display_name: "Left", username: "left", role: "member", is_active: false },
    ],
    wa_member: [
      { phone: OWNER, user_id: "u-owner" },
      { phone: ADMIN, user_id: "u-admin" },
      { phone: MEMBER, user_id: "u-member" },
      { phone: "201000000004", user_id: "u-guest" },
      { phone: "201000000005", user_id: "u-left" },
    ],
    wa_member_lid: [
      { lid: "111@lid", user_id: "u-owner" },
      { lid: "333@lid", user_id: "u-member" },
    ],
    // What a member typed on their own card: never read for the tier.
    profile_contact: [{ user_id: "u-member", whatsapp: OWNER }],
  };
}

// ------------------------------------------------------------------ tiers --

test("the tier comes from the admin's links: owner, admin, member", async () => {
  const { db } = fakeDb(team());
  const s = settings();
  assert.equal((await tierOf(db, s, { phone: OWNER, lid: null }))?.tier, "owner");
  assert.equal((await tierOf(db, s, { phone: ADMIN, lid: null }))?.tier, "admin");
  assert.equal((await tierOf(db, s, { phone: MEMBER, lid: null }))?.tier, "member");
});

test("a super admin is a person: any number linked to their account, with no owner number set", async () => {
  const { db } = fakeDb(team());
  const s = settings({ owner_phones: [], owner_users: ["u-admin"] });
  assert.equal((await tierOf(db, s, { phone: ADMIN, lid: null }))?.tier, "owner");
  assert.equal((await tierNow(db, s, "u-admin"))?.tier, "owner");
  assert.equal((await tierOf(db, s, { phone: OWNER, lid: null }))?.tier, "admin");
});

test("a member who put the owner's number on their own card is still a member", async () => {
  const { db, calls } = fakeDb(team());
  const a = await tierOf(db, settings(), { phone: MEMBER, lid: null });
  assert.equal(a?.tier, "member");
  assert.equal(a?.id, "u-member");
  assert.ok(!calls.some((c) => c.table === "profile_contact"), "the member card is never read");
});

test("a hidden number: by its link, and the owner when the account's linked numbers include an owner number", async () => {
  const { db } = fakeDb(team());
  assert.equal((await tierOf(db, settings(), { phone: null, lid: "111@lid" }))?.tier, "owner");
  assert.equal((await tierOf(db, settings(), { phone: null, lid: "333@lid" }))?.tier, "member");
  assert.equal(await tierOf(db, settings(), { phone: null, lid: "999@lid" }), null);
});

test("nobody unlinked, no guest and nobody who left reaches the brain", async () => {
  const { db } = fakeDb(team());
  assert.equal(await tierOf(db, settings(), { phone: "209999999999", lid: null }), null);
  assert.equal(await tierOf(db, settings(), { phone: "201000000004", lid: null }), null);
  assert.equal(await tierOf(db, settings(), { phone: "201000000005", lid: null }), null);
});

test("the phase lets the owner in, then admins, then members", () => {
  assert.deepEqual([0, 1, 2].map((phase) => ["owner", "admin", "member"].map((t) => reaches({ phase }, t as "owner"))), [
    [true, false, false],
    [true, true, false],
    [true, true, true],
  ]);
});

test("the owner: an owner number as WhatsApp gives it, or a hidden number linked to the owner's account", async () => {
  const { db } = fakeDb(team());
  assert.equal(await fromOwner(db, settings(), { phone: OWNER, lid: null }), true);
  assert.equal(await fromOwner(db, settings(), { phone: null, lid: "111@lid" }), true);
  assert.equal(await fromOwner(db, settings(), { phone: MEMBER, lid: null }), false);
  assert.equal(await fromOwner(db, settings(), { phone: null, lid: "333@lid" }), false);
});

test("switched on only with an https address and a long secret", () => {
  assert.equal(brainOn({ enabled: true, url: "https://brain.example.com", secret: SECRET }), true);
  assert.equal(brainOn({ enabled: false, url: "https://brain.example.com", secret: SECRET }), false);
  assert.equal(brainOn({ enabled: true, url: "http://brain.example.com", secret: SECRET }), false);
  assert.equal(brainOn({ enabled: true, url: "https://brain.example.com", secret: "short" }), false);
});

// ---------------------------------------------------------------- signing --

test("signatures: the right secret, direction, body and time only", async () => {
  const body = JSON.stringify({ run_id: "r1", text: "hi" });
  const now = Date.now();
  const sig = await signature(SECRET, "to-bot", body, now);
  assert.equal(await signedBy(SECRET, "to-bot", body, sig, now), true);
  assert.equal(await signedBy(SECRET, "to-brain", body, sig, now), false, "not the other way");
  assert.equal(await signedBy(SECRET, "to-bot", `${body} `, sig, now), false, "not another body");
  assert.equal(await signedBy("x".repeat(40), "to-bot", body, sig, now), false, "not another secret");
  assert.equal(await signedBy(SECRET, "to-bot", body, sig, now + 6 * 60_000), false, "not after five minutes");
  assert.equal(await signedBy(SECRET, "to-bot", body, null, now), false);
});

test("canonical JSON: the same input whatever the key order", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

// ------------------------------------------------------------- a message --

const asker = { id: "u-member", name: "Rabah", tier: "member" as const, admin: false };
const env = { enabled: true, url: "https://brain.example.com", secret: SECRET };

test("a message goes to the brain once, signed, with its files read out", async () => {
  const { db, tables } = fakeDb({ wa_file: [{ id: "m1", kind: "document", name: "brief.pdf", text: "the brief" }] });
  const sent: { url: string; body: string; sig: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body), sig: new Headers(init.headers).get("x-brain-signature") });
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;
  const o = { id: "m1", chatId: `${MEMBER}@c.us`, where: "private" as const, text: "what's late?", quoted: null, asker, replyChat: `${MEMBER}@c.us` };
  assert.equal(await forward(db, env, o, f), "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://brain.example.com/message");
  assert.equal(await signedBy(SECRET, "to-brain", sent[0]!.body, sent[0]!.sig), true);
  const body = JSON.parse(sent[0]!.body);
  assert.equal(body.sender.tier, "member");
  assert.deepEqual(body.files, [{ kind: "document", name: "brief.pdf", text: "the brief" }]);
  assert.equal(tables.brain_run!.length, 1);
  assert.equal(tables.brain_run![0]!.status, "queued");
});

test("the same message twice is one run", async () => {
  const { db } = fakeDb({}, { fail: (c) => (c.table === "brain_run" && c.op === "insert" ? { message: "duplicate key", code: "23505" } : null) });
  let calls = 0;
  const f = (async () => (calls++, new Response("{}"))) as unknown as typeof fetch;
  const o = { id: "m1", chatId: `${MEMBER}@c.us`, where: "private" as const, text: "hi", quoted: null, asker, replyChat: `${MEMBER}@c.us` };
  assert.equal(await forward(db, env, o, f), "duplicate");
  assert.equal(calls, 0);
});

test("brain down or slow: the order router takes it, and the run says why", async () => {
  for (const f of [
    (async () => new Response("no", { status: 502 })) as unknown as typeof fetch,
    (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch,
  ]) {
    const { db, tables } = fakeDb();
    const o = { id: "m1", chatId: "g1@g.us", where: "team" as const, via: "mention" as const, text: "hi", quoted: null, asker, replyChat: "g1@g.us" };
    assert.equal(await forward(db, env, o, f), "fallback");
    assert.equal(tables.brain_run![0]!.status, "fallback");
    assert.ok(String(tables.brain_run![0]!.error).length > 0);
  }
});

test("before 0119 runs: the order router, as before", async () => {
  const { db } = fakeDb({}, { fail: (c) => (c.table === "brain_run" ? 'relation "public.brain_run" does not exist' : null) });
  const f = (async () => new Response("{}")) as unknown as typeof fetch;
  const o = { id: "m1", chatId: "g1@g.us", where: "team" as const, text: "hi", quoted: null, asker, replyChat: "g1@g.us" };
  assert.equal(await forward(db, env, o, f), "fallback");
});

test("an edit of a message the brain had goes to it as a correction of that run", async () => {
  const { db, tables } = fakeDb({ brain_run: [{ id: "r1", message_id: "m1", chat_id: "g1@g.us", reply_chat: "g1@g.us", asker: "u-member", asker_name: "Rabah", tier: "member", status: "done", edits: 0 }] });
  const bodies: string[] = [];
  const f = (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response("{}"))) as unknown as typeof fetch;
  assert.equal(await forwardEdit(db, env, { id: "m1", text: "what's late this week? (edited)" }, f), true);
  assert.equal(JSON.parse(bodies[0]!).run_id, "r1");
  assert.equal(JSON.parse(bodies[0]!).edit, 1);
  assert.equal(tables.brain_run![0]!.edits, 1);
  assert.equal(await forwardEdit(db, env, { id: "m-other", text: "x" }, f), false);
});

// ------------------------------------------------------- the owner's words --

test("the owner's words: the whole message, any digits, any way of writing them", () => {
  assert.deepEqual(ownerWord("وقف"), { kind: "stop" });
  assert.deepEqual(ownerWord(" STOP! "), { kind: "stop" });
  assert.deepEqual(ownerWord("شغّل"), { kind: "start" });
  assert.deepEqual(ownerWord("start"), { kind: "start" });
  assert.deepEqual(ownerWord("نعم ٤٨٢١"), { kind: "yes", code: "4821" });
  assert.deepEqual(ownerWord("yes 4821"), { kind: "yes", code: "4821" });
  assert.deepEqual(ownerWord("ok4821"), { kind: "yes", code: "4821" });
  assert.deepEqual(ownerWord("لا"), { kind: "no", code: null });
  assert.deepEqual(ownerWord("no 4821"), { kind: "no", code: "4821" });
  for (const t of ["stop following up with Rabah", "وقف التذكير", "yes", "نعم", "yes 482", "approved", "yes 4821 and send it"]) assert.equal(ownerWord(t), null, t);
});

/** A run waiting on an OK, the code the owner was sent, and what was said. */
async function asked(db: ReturnType<typeof fakeDb>["db"], s = settings()) {
  const said: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (said.push({ chat, text }), `out-${said.length}`);
  const r = await askOwner(db, s, send, {
    run: { id: "r1", reply_chat: "g1@g.us", message_id: "m1", asker_name: "Rabah", tier: "member" },
    tool: "message_client",
    input: { client: "c1", text: "Your files are ready." },
    what: 'send Acme on WhatsApp: "Your files are ready."',
    why: "Rabah asked",
  });
  assert.ok("id" in r);
  const code = /code (\d{4})/.exec(said[0]!.text)![1]!;
  return { id: (r as { id: string }).id, code, said, send };
}

test("an OK: the owner is told what, why, who asked and the code; the code is kept hashed", async () => {
  const { db, tables } = fakeDb(team());
  const { code, said } = await asked(db);
  assert.equal(said.length, 1);
  assert.equal(said[0]!.chat, `${OWNER}@c.us`);
  assert.match(said[0]!.text, /What: send Acme/);
  assert.match(said[0]!.text, /Why: Rabah asked/);
  assert.match(said[0]!.text, new RegExp(`"yes ${code}" to approve`));
  const row = tables.brain_approval![0]!;
  assert.equal(row.status, "waiting");
  assert.ok(!JSON.stringify(row).includes(`"${code}"`), "the code itself isn't kept");
});

test("only a new message from an owner number with the right code approves", async () => {
  const { db, tables } = fakeDb(team());
  const { id, code, send } = await asked(db);
  const approved: string[] = [];
  const hooks = { approved: async (x: string) => void approved.push(x), told: async () => {} };
  const says = (phone: string, text: string, n: number) => ownerSays(db, settings(), send, { id: `in-${n}`, chatId: `${phone}@c.us`, phone, lid: null, text, quotedId: null }, hooks);
  // Someone else with the right code: not an owner word at all.
  assert.equal(await says(MEMBER, `yes ${code}`, 1), false);
  // The owner with a wrong code.
  const wrong = code === "0000" ? "0001" : "0000";
  assert.equal(await says(OWNER, `yes ${wrong}`, 2), true);
  assert.equal(tables.brain_approval![0]!.status, "waiting");
  // Words that only say it's approved.
  assert.equal(await says(OWNER, "approved, go ahead", 3), false);
  assert.equal(tables.brain_approval![0]!.status, "waiting");
  assert.deepEqual(approved, []);
  // The owner, the right code.
  assert.equal(await says(OWNER, `نعم ${code}`, 4), true);
  assert.equal(tables.brain_approval![0]!.status, "approved");
  assert.deepEqual(approved, [id]);
  // Again: nothing more.
  assert.equal(await says(OWNER, `yes ${code}`, 5), true);
  assert.deepEqual(approved, [id]);
});

test("an OK runs out after 30 minutes", async () => {
  const { db, tables } = fakeDb(team());
  const { code, said, send } = await asked(db);
  tables.brain_approval![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
  const approved: string[] = [];
  await ownerSays(db, settings(), send, { id: "in-1", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: `yes ${code}`, quotedId: null }, { approved: async (x) => void approved.push(x), told: async () => {} });
  assert.deepEqual(approved, []);
  assert.equal(tables.brain_approval![0]!.status, "expired");
  assert.match(said.at(-1)!.text, /ran out/);
});

test("no cancels the latest request, and whoever asked hears it", async () => {
  const { db, tables } = fakeDb(team());
  const { said, send } = await asked(db);
  const approved: string[] = [];
  assert.equal(await ownerSays(db, settings(), send, { id: "in-1", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: "لا", quotedId: null }, { approved: async (x) => void approved.push(x), told: async () => {} }), true);
  assert.equal(tables.brain_approval![0]!.status, "refused");
  assert.deepEqual(approved, []);
  assert.ok(said.some((m) => m.chat === "g1@g.us" && /super admin said no/.test(m.text)));
});

test("a plain no with nothing waiting is an answer to something else", async () => {
  const { db } = fakeDb(team());
  const send = async () => "x";
  assert.equal(await ownerSays(db, settings(), send, { id: "in-1", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: "no", quotedId: null }, { approved: async () => {}, told: async () => {} }), false);
});

test("the kill switch: stop and start, from the owner only, never as a reply to something", async () => {
  const { db, tables } = fakeDb({ ...team(), brain_settings: [{ id: 1, stopped: false }] });
  const said: string[] = [];
  const send = async (_c: string, t: string) => (said.push(t), "x");
  const told: boolean[] = [];
  const hooks = { approved: async () => {}, told: async (s: boolean) => void told.push(s) };
  assert.equal(await ownerSays(db, settings(), send, { id: "1", chatId: `${MEMBER}@c.us`, phone: MEMBER, lid: null, text: "stop", quotedId: null }, hooks), false);
  assert.equal(await ownerSays(db, settings(), send, { id: "2", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: "stop", quotedId: "report-1" }, hooks), false);
  assert.equal(tables.brain_settings![0]!.stopped, false);
  assert.equal(await ownerSays(db, settings(), send, { id: "3", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: "وقف", quotedId: null }, hooks), true);
  assert.equal(tables.brain_settings![0]!.stopped, true);
  assert.match(said.at(-1)!, /until you say start/);
  assert.equal(await ownerSays(db, settings(), send, { id: "4", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: "start", quotedId: null }, hooks), true);
  assert.equal(tables.brain_settings![0]!.stopped, false);
  assert.deepEqual(told, [true, false]);
});

test("while stopped nothing is asked for an OK", async () => {
  const { db, tables } = fakeDb(team());
  const r = await askOwner(db, settings({ stopped: true }), async () => "x", { run: null, tool: "deploy", input: {}, what: "deploy" });
  assert.ok("error" in r);
  assert.equal(tables.brain_approval?.length ?? 0, 0);
});

// ------------------------------------------------------------- index.ts --
// index.ts can't be loaded here (it serves): its source is read instead.

test("index.ts: only what passed the gate, or came privately from the team, can reach the brain", async () => {
  const { readFileSync } = await import("node:fs");
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8").replace(/\r\n/g, "\n");
  // told is what lets a message go to the brain: given in four places only.
  const told = [...index.matchAll(/\btold: (phoneOf|o\.told)/g)].map((m) => m.index!);
  assert.equal(told.length, 4);
  const via = index.indexOf("} else if (via) {");
  const voice = index.indexOf("const v = await voiceToBot(");
  const team = index.indexOf("if (onTheTeam(me)) {");
  const taker = index.indexOf('if (taker === "team") {');
  assert.ok(via > 0 && voice > 0 && team > 0 && taker > 0);
  assert.ok(told.some((i) => i > via && i - via < 1200), "a group message the gate let through");
  assert.ok(told.some((i) => i > voice && i - voice < 400), "a voice note the gate let through");
  assert.ok(told.some((i) => i > team && i - team < 1200), "the team privately");
  assert.ok(told.some((i) => i > taker && i - taker < 1200), "the team privately, whatever it answers (the brain first)");
  // In a group, the bot's questions, an order's report and a meeting carried on go to the brain only through orderNow, with told.
  assert.match(index, /const toBrain = async \(text: string, via: Via\) =>\s*orderNow\(db, \{[^}]*via, told,/);
  assert.equal([...index.matchAll(/if \(await brainHas\(\)\)/g)].length, 3);
  // Orders carried on (a reply to a report, an answer to a draft) stay with the router.
  assert.match(index, /const order = \(text: string\) =>\s*orderNow\(db, \{ id: o\.id, chatId: o\.chatId, where: o\.chatId\.endsWith\("@g\.us"\) \? "team" : "private", text, quoted: null, phone: o\.phone \?\? phoneOf\(o\.chatId\), lid: o\.lid \?\? null, name: null \}\);/);
  // The brain first; when it doesn't take it, the router as before.
  assert.match(index, /if \(o\.told !== undefined && \(await brainNow\(db, o\)\)\) return;\s*const \[s, cfg, t\] = await Promise\.all\(\[settings\(db\), config\(db\), team\(db\)\]\);\s*await takeOrder\(/);
  // The owner's words: a new message only, before anything else in the private chat.
  assert.match(index, /if \(!edit && \(await ownerNow\(db, \{ id, chatId: chat, phone: told, lid, text, quotedId: m\.quoted \}\)\)\) return;\s*if \(from\) await fromPrivate\(/);
});
