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

test("the brain's own actions: deploys for the owner only, claimed once after the OK", async () => {
  const { d, said, tables } = deps(world());
  const byMember = await call(d, "_approval", { run_id: RUN, tool: "deploy", input: { target: "functions" }, what: "deploy the functions" });
  assert.match(byMember.body.error, /owner only/);
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
