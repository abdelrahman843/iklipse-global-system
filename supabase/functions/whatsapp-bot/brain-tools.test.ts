// The brain's tools (brain-tools.ts): signed by the brain or refused, each
// call as its run's asker and only within their tier, read-only while
// stopped, a change once per run, and anything that can't be undone held for
// the owner's OK and done only after it, exactly as asked. Names and numbers
// are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { brainApi, carryOut, redact, type Deps } from "./brain-tools.ts";
import { ownerSays, signature, type BrainEnv } from "./brain.ts";
import type { Person, Settings, Team } from "./kit.ts";

const SECRET = "k".repeat(40);
const ENV: BrainEnv = { enabled: true, url: "https://brain.example.com", secret: SECRET };
const OWNER = "201000000001";
const RUN = "11111111-1111-4111-8111-111111111111";
const OWNER_RUN = "22222222-2222-4222-8222-222222222222";

function world(o: { stopped?: boolean; phase?: number } = {}) {
  const now = new Date().toISOString();
  return {
    brain_settings: [{ id: 1, phase: o.phase ?? 2, stopped: o.stopped ?? false, owner_phones: [OWNER], model_owner: "claude-opus-5-5", model_member: "claude-sonnet-5-5", model_fast: "claude-haiku-5-5", max_turns: 40, member_turns: 12, run_minutes: 15, run_cost_usd: 5, day_cost_usd: 40 }],
    profile: [
      { id: "u-owner", display_name: "Sameh", username: "sameh", role: "admin", is_active: true },
      { id: "u-member", display_name: "Rabah", username: "rabah", role: "member", is_active: true },
    ],
    wa_member: [
      { phone: OWNER, user_id: "u-owner" },
      { phone: "201000000003", user_id: "u-member" },
    ],
    profile_contact: [{ user_id: "u-member", whatsapp: "201000000003" }],
    client: [{ id: "c-acme", name: "Acme", company: null, email: null, phone: "201555000111", name_known: true }],
    brain_run: [
      { id: RUN, message_id: "m1", chat_id: "201000000003@c.us", reply_chat: "201000000003@c.us", asker: "u-member", asker_name: "Rabah", tier: "member", status: "running", request: "Summarize the last email from Acme.", created_at: now },
      { id: OWNER_RUN, message_id: "m2", chat_id: `${OWNER}@c.us`, reply_chat: `${OWNER}@c.us`, asker: "u-owner", asker_name: "Sameh", tier: "owner", status: "running", request: "Deploy the bot.", created_at: now },
    ],
  };
}

function deps(tables: Record<string, Record<string, unknown>[]>) {
  const f = fakeDb(tables);
  const said: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (said.push({ chat, text }), `out-${said.length}`);
  const people = new Map<string, Person>([
    ["u-owner", { id: "u-owner", name: "Sameh", username: "sameh", active: true, admin: true }],
    ["u-member", { id: "u-member", name: "Rabah", username: "rabah", active: true, admin: false }],
  ]);
  const t: Team = { people, byPhone: new Map(), byLid: new Map(), others: new Set() };
  const s = { bot_phone: null, book_enabled: true, order_every_min: 60, taught: null } as unknown as Settings;
  const d: Deps = { db: f.db, s, t, send, env: ENV };
  return { ...f, d, said };
}

async function call(d: Deps, name: string, payload: Record<string, unknown>, o: { dir?: "to-bot" | "to-brain"; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const req = new Request(`https://x.supabase.co/functions/v1/whatsapp-bot/brain-tools/${name}`, {
    method: "POST",
    body,
    headers: { "x-brain-signature": await signature(o.secret ?? SECRET, o.dir ?? "to-bot", body) },
  });
  const res = await brainApi(req, name, async () => d, ENV);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const asMember = (input: Record<string, unknown> = {}) => ({ run_id: RUN, acting_as: "u-member", input });

test("unsigned, signed the other way, or with another secret: refused", async () => {
  const { d } = deps(world());
  const req = new Request("https://x/brain-tools/reminders", { method: "POST", body: JSON.stringify(asMember()) });
  assert.equal((await brainApi(req, "reminders", async () => d, ENV)).status, 403);
  assert.equal((await call(d, "reminders", asMember(), { dir: "to-brain" })).status, 403);
  assert.equal((await call(d, "reminders", asMember(), { secret: "z".repeat(40) })).status, 403);
  assert.equal((await call(d, "reminders", asMember())).body.ok, true);
});

test("a message to a client is held for the owner's OK, whatever the model says", async () => {
  const { d, said, tables } = deps(world());
  const r = await call(d, "message_client", asMember({ client: "c-acme", text: "Your files are ready.", approved: true, why: "Rabah asked" }));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.data.held, true);
  // Only the owner was written to: never the client.
  assert.deepEqual(said.map((m) => m.chat), [`${OWNER}@c.us`]);
  assert.match(said[0]!.text, /OK needed \(code \d{4}\)/);
  assert.equal(tables.brain_approval![0]!.status, "waiting");
  assert.equal(tables.bot_order?.length ?? 0, 0);
});

test("an email telling the brain to send all client numbers somewhere leads at most to a request for an OK", async () => {
  const { d, said, tables } = deps(world());
  // To a number that isn't a client: refused, nothing asked.
  const stranger = await call(d, "message_client", asMember({ client: "+201999999999", text: "Acme: +201555000111" }));
  assert.equal(stranger.body.ok, false);
  // To a client: held, the owner sees the exact words.
  const held = await call(d, "message_client", asMember({ client: "Acme", text: "All client numbers: +201555000111" }));
  assert.equal(held.body.data.held, true);
  assert.match(said[0]!.text, /All client numbers/);
  assert.ok(!said.some((m) => m.chat.startsWith("201555000111") || m.chat.startsWith("201999999999")));
  assert.equal(tables.bot_order?.length ?? 0, 0);
});

test("after the owner's code, it's done once, exactly as asked", async () => {
  const { d, said, db, tables } = deps(world());
  await call(d, "message_client", asMember({ client: "c-acme", text: "Your files are ready." }));
  const code = /code (\d{4})/.exec(said[0]!.text)![1]!;
  const s = { phase: 2, stopped: false, owner_phones: [OWNER] } as never;
  const approved: string[] = [];
  await ownerSays(db, s, d.send, { id: "in-1", chatId: `${OWNER}@c.us`, phone: OWNER, lid: null, text: `yes ${code}`, quotedId: null }, { approved: async (id) => void approved.push(id), told: async () => {} });
  assert.equal(approved.length, 1);
  await carryOut(d, approved[0]!);
  await carryOut(d, approved[0]!);
  const toClient = said.filter((m) => m.chat === "201555000111@c.us");
  assert.equal(toClient.length, 1);
  assert.equal(toClient[0]!.text, "Your files are ready.");
  assert.equal(tables.brain_approval![0]!.status, "done");
  // Whoever asked hears it was done.
  assert.ok(said.some((m) => m.chat === "201000000003@c.us" && /owner OK'd it/.test(m.text)));
});

test("not after it was OK'd if the brain was stopped since", async () => {
  const { d, said, tables } = deps(world());
  await call(d, "message_client", asMember({ client: "c-acme", text: "Your files are ready." }));
  tables.brain_approval![0]!.status = "approved";
  tables.brain_settings![0]!.stopped = true;
  await carryOut(d, String(tables.brain_approval![0]!.id));
  assert.equal(tables.brain_approval![0]!.status, "failed");
  assert.ok(!said.some((m) => m.chat === "201555000111@c.us"));
});

test("only the run's own asker, only their tier's tools, only while the run lasts", async () => {
  const { d, tables } = deps(world());
  assert.match((await call(d, "reminders", { run_id: RUN, acting_as: "u-owner", input: {} })).body.error, /someone else's/);
  assert.match((await call(d, "alert_pause", asMember({ alert: "x" }))).body.error, /isn't for members/);
  assert.match((await call(d, "brain_settings", asMember({ patch: { phase: 2 } }))).body.error, /isn't for members/);
  tables.brain_run![0]!.status = "done";
  assert.match((await call(d, "reminders", asMember())).body.error, /over/);
});

test("a member out of the phase is refused", async () => {
  const { d } = deps(world({ phase: 0 }));
  assert.match((await call(d, "reminders", asMember())).body.error, /isn't on for them/);
});

test("stopped: reading works, changing doesn't", async () => {
  const { d } = deps(world({ stopped: true }));
  assert.equal((await call(d, "reminders", asMember())).body.ok, true);
  const r = await call(d, "cancel_reminders", asMember({ which: ["all"] }));
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /stopped/);
});

test("a change is done once per run", async () => {
  const { d } = deps(world());
  const first = await call(d, "cancel_reminders", asMember({ which: ["1"] }));
  assert.equal(first.body.ok, true);
  const again = await call(d, "cancel_reminders", asMember({ which: ["1"] }));
  assert.equal(again.body.data.already, true);
});

test("the brain's own actions: deploys for the owner and admins only, claimed once after the OK", async () => {
  const { d, said, tables } = deps(world());
  const byMember = await call(d, "_approval", { run_id: RUN, tool: "deploy", input: { target: "functions" }, what: "deploy the functions" });
  assert.match(byMember.body.error, /owner and admins only/);
  const byOwner = await call(d, "_approval", { run_id: OWNER_RUN, tool: "deploy", input: { target: "functions", ref: "abc123" }, what: "deploy the functions at abc123", why: "the fix is merged" });
  assert.equal(byOwner.body.ok, true);
  assert.match(said.at(-1)!.text, /deploy the functions at abc123/);
  const id = byOwner.body.approval_id as string;
  // Not before the OK.
  assert.equal((await call(d, "_approval_claim", { approval_id: id })).body.ok, false);
  tables.brain_approval!.find((a) => a.id === id)!.status = "approved";
  const claim = await call(d, "_approval_claim", { approval_id: id });
  assert.equal(claim.body.ok, true);
  assert.deepEqual(claim.body.input, { target: "functions", ref: "abc123" });
  assert.equal((await call(d, "_approval_claim", { approval_id: id })).body.ok, false, "once");
  assert.equal((await call(d, "_approval_done", { approval_id: id, ok: true, result: "Deployed abc123." })).body.ok, true);
  assert.ok(said.some((m) => m.chat === `${OWNER}@c.us` && /Deployed abc123/.test(m.text)));
});

test("a reply goes only to the run's chat", async () => {
  const { d, said } = deps(world());
  await call(d, "_reply", { run_id: RUN, text: "Two cards are late.", chat_id: "someone-else@c.us" });
  assert.deepEqual(said.map((m) => m.chat), ["201000000003@c.us"]);
});

test("the start of a run: who asked, their limits, and the day's spend", async () => {
  const { d, tables } = deps(world());
  tables.brain_run!.push({ id: "old", cost_usd: 39.5, created_at: new Date().toISOString(), status: "done" });
  const r = await call(d, "_start", { run_id: RUN });
  assert.equal(r.body.asker.tier, "member");
  assert.equal(r.body.model, "claude-sonnet-5-5");
  assert.equal(r.body.max_turns, 12);
  assert.equal(r.body.over_cap, false);
  tables.brain_run!.push({ id: "old2", cost_usd: 1, created_at: new Date().toISOString(), status: "done" });
  assert.equal((await call(d, "_start", { run_id: RUN })).body.over_cap, true);
});

test("secrets never go into the log of what the brain did", () => {
  // Made-up values, put together here so no scanner mistakes this file for one holding a key.
  const key = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");
  const gh = ["gh", "p_abcdefghijklmnopqrstu"].join("");
  const jwt = ["e", "yJhbGciOiJub25lIn0", ".e", "yJzdWIiOiIxIn0.sig"].join("");
  const t = redact(`key ${key} token ${gh} jwt ${jwt}`);
  assert.doesNotMatch(t, /abcdefghijklmnop|abcdefghijklmnopqrstu|zdWIi/);
});

test("an edit opens the run it corrects again, for a while; the table guide comes with the start", async () => {
  const { d, tables } = deps(world());
  tables.brain_run![0]!.status = "done";
  assert.match((await call(d, "_start", { run_id: RUN })).body.error, /over/);
  const r = await call(d, "_start", { run_id: RUN, edit: true });
  assert.equal(r.body.ok, true);
  assert.equal(tables.brain_run![0]!.status, "running");
  assert.match(String(r.body.guide), /How things connect/);
  tables.brain_run![0]!.created_at = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  assert.match((await call(d, "_start", { run_id: RUN, edit: true })).body.error, /over/);
});

// ------------------------------------------------- everything to the brain (0120) --

const ORDER = "33333333-3333-4333-8333-333333333333";
const CLIENT_RUN = "44444444-4444-4444-8444-444444444444";
const ADMIN_RUN = "55555555-5555-4555-8555-555555555555";
const GROUP_RUN = "66666666-6666-4666-8666-666666666666";
const ADMIN = "201000000002";

/** The world, with an order the owner gave Rabah through the bot, a client's run, and an admin's runs (private and in a group). */
function busy(o: { phase?: number } = {}) {
  const w = world({ phase: o.phase ?? 3 }) as Record<string, Record<string, unknown>[]>;
  const now = new Date().toISOString();
  w.profile!.push({ id: "u-admin", display_name: "Omar", username: "omar", role: "admin", is_active: true });
  w.wa_member!.push({ phone: ADMIN, user_id: "u-admin" });
  w.bot_order = [
    {
      id: ORDER,
      chat_id: `${OWNER}@c.us`,
      message_id: "m-order",
      by_user: "u-owner",
      by_name: "Sameh",
      order_text: "Ask Rabah to send the Acme logo files",
      kind: "tell",
      to_kind: "team",
      to_id: "u-member",
      to_name: "Rabah",
      to_chat: "201000000003@c.us",
      task: "send the Acme logo files",
      nudge: "Rabah, a reminder: the Acme logo files.",
      status: "open",
      times: 1,
      next_at: now,
      sent_ids: ["sent-1"],
      report_ids: [],
      outcome: null,
      book_url: null,
      created_at: now,
      updated_at: now,
    },
  ];
  w.brain_run!.push(
    { id: CLIENT_RUN, message_id: "m3", chat_id: "201555000111@c.us", reply_chat: "201555000111@c.us", asker: null, asker_name: "Acme", tier: "client", status: "running", request: "When is my video ready?", created_at: now },
    { id: ADMIN_RUN, message_id: "m4", chat_id: `${ADMIN}@c.us`, reply_chat: `${ADMIN}@c.us`, asker: "u-admin", asker_name: "Omar", tier: "admin", status: "running", request: "Deploy the fix.", created_at: now },
    { id: GROUP_RUN, message_id: "m5", chat_id: "120363000000000001@g.us", reply_chat: "120363000000000001@g.us", asker: "u-admin", asker_name: "Omar", tier: "admin", status: "running", request: "Deploy the fix.", created_at: now },
  );
  return w;
}

test("their answer about an order to them goes to whoever gave it; someone else can't answer it", async () => {
  const { d, said, tables } = deps(busy());
  const r = await call(d, "order_update", asMember({ order: ORDER, result: "done", text: "Sent them on Drive" }));
  assert.equal(r.body.ok, true);
  assert.equal(tables.bot_order![0]!.status, "done");
  // Where it was given: the owner's chat, as a reply to the order.
  assert.ok(said.some((m) => m.chat === `${OWNER}@c.us` && /Rabah says it's done: "Sent them on Drive"/.test(m.text)));
  // Not the owner's to answer: it isn't to them.
  const { d: d2 } = deps(busy());
  const o = await call(d2, "order_update", { run_id: OWNER_RUN, acting_as: "u-owner", input: { order: ORDER, result: "done" } });
  assert.equal(o.body.ok, false);
  assert.match(o.body.error, /isn't to them/);
});

test("the team carries an order on: a reminder now, then stopped", async () => {
  const { d, said, tables } = deps(busy());
  const again = await call(d, "order_follow", { run_id: OWNER_RUN, acting_as: "u-owner", input: { order: ORDER, action: "again" } });
  assert.match(again.body.data.said, /Reminded Rabah/);
  assert.ok(said.some((m) => m.chat === "201000000003@c.us" && /a reminder/.test(m.text)));
  const stop = await call(d, "order_follow", { run_id: OWNER_RUN, acting_as: "u-owner", input: { order: ORDER, action: "stop" } });
  assert.match(stop.body.data.said, /stopped/);
  assert.equal(tables.bot_order![0]!.status, "stopped");
  // The open orders they gave: listed with their ids.
  tables.bot_order![0]!.status = "open";
  const listed = await call(d, "orders", { run_id: OWNER_RUN, acting_as: "u-owner", input: {} });
  assert.equal(listed.body.data.given[0].id, ORDER);
});

test("a client: only their own tools, and only as themselves", async () => {
  const { d, tables } = deps(busy());
  const as = (input: Record<string, unknown>) => ({ run_id: CLIENT_RUN, acting_as: "client:201555000111@c.us", input });
  for (const t of ["find", "search", "overview", "message_team_member", "message_client", "order_follow"]) {
    const r = await call(d, t, as({ table: "client" }));
    assert.equal(r.body.ok, false, t);
    assert.match(r.body.error, /isn't for clients/, t);
  }
  // Someone else's id for the same run: refused.
  assert.match((await call(d, "find", { run_id: CLIENT_RUN, acting_as: "u-member", input: {} })).body.error, /someone else's/);
  // Before phase 3: not on for clients.
  const { d: d2 } = deps(busy({ phase: 2 }));
  assert.match((await call(d2, "ask_team", as({ question: "?" }))).body.error, /isn't on for clients/);
  // Their start: no taught notes, no tables.
  const s = await call(d, "_start", { run_id: CLIENT_RUN });
  assert.equal(s.body.asker.tier, "client");
  assert.equal(s.body.guide, null);
  assert.equal(s.body.taught, null);
  assert.equal(s.body.model, "claude-sonnet-5-5");
  assert.equal(tables.brain_run!.find((r) => r.id === CLIENT_RUN)!.status, "running");
});

test("an admin's change to the system: asked for privately only, OK'd by their own code; the owner hears of it", async () => {
  const { d, said, db, tables } = deps(busy());
  const deploy = { target: "functions", sha: "a".repeat(40), functions: ["whatsapp-bot"] };
  // In a group: refused before anyone is asked.
  const g = await call(d, "_approval", { run_id: GROUP_RUN, tool: "deploy", input: deploy, what: "deploy whatsapp-bot" });
  assert.equal(g.body.ok, false);
  assert.match(g.body.error, /privately/);
  assert.equal(said.length, 0);
  // Privately: the code goes to the admin; the owner gets a note without it.
  const p = await call(d, "_approval", { run_id: ADMIN_RUN, tool: "deploy", input: deploy, what: "deploy whatsapp-bot" });
  assert.equal(p.body.ok, true);
  const toAdmin = said.find((m) => m.chat === `${ADMIN}@c.us`)!;
  const code = /code (\d{4})/.exec(toAdmin.text)![1]!;
  const toOwner = said.find((m) => m.chat === `${OWNER}@c.us`)!;
  assert.doesNotMatch(toOwner.text, new RegExp(code));
  assert.match(toOwner.text, /Omar asked me to deploy whatsapp-bot/);
  assert.deepEqual(tables.brain_approval![0]!.approver_phones, [ADMIN]);
  const s = { phase: 3, stopped: false, owner_phones: [OWNER] } as never;
  const hooks = (approved: string[]) => ({ approved: async (id: string) => void approved.push(id), told: async () => {} });
  // Another member's "yes <code>": not theirs, nothing happens.
  const none: string[] = [];
  assert.equal(await ownerSays(db, s, d.send, { id: "in-x", chatId: "201000000003@c.us", phone: "201000000003", lid: null, text: `yes ${code}`, quotedId: null }, hooks(none)), false);
  assert.equal(none.length, 0);
  // The admin's own: approved.
  const ok: string[] = [];
  assert.equal(await ownerSays(db, s, d.send, { id: "in-y", chatId: `${ADMIN}@c.us`, phone: ADMIN, lid: null, text: `نعم ${code}`, quotedId: null }, hooks(ok)), true);
  assert.equal(ok.length, 1);
  assert.equal(tables.brain_approval![0]!.status, "approved");
  // The admin can't stop the brain: that's the owner's.
  assert.equal(await ownerSays(db, s, d.send, { id: "in-z", chatId: `${ADMIN}@c.us`, phone: ADMIN, lid: null, text: "stop", quotedId: null }, hooks([])), false);
});
