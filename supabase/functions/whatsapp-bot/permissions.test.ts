// Permissions (0137, permissions.ts): what someone may have the bot do is
// their skills now, checked on every tool call whatever the brain thought;
// the permissions tool is the super admin's alone. Names and numbers are made
// up. bot_skills_for is the database's (0137); here a stand-in reads a table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { brainApi, type Deps } from "./brain-tools.ts";
import { signature, type BrainEnv } from "./brain.ts";
import { kindOf, mayTalk, skillsFor } from "./permissions.ts";
import type { Person, Settings, Team } from "./kit.ts";

const SECRET = "k".repeat(40);
const ENV: BrainEnv = { enabled: true, url: "https://brain.example.com", secret: SECRET };
const SUPER = "201000000001";
const MEMBER_RUN = "11111111-1111-4111-8111-111111111111";
const SUPER_RUN = "22222222-2222-4222-8222-222222222222";
const ADMIN_RUN = "33333333-3333-4333-8333-333333333333";

/** Each person's skills, as bot_skills_for would answer (by account). */
type Skills = Record<string, string[]>;

function world() {
  const now = new Date().toISOString();
  return {
    brain_settings: [{ id: 1, phase: 2, stopped: false, owner_phones: [SUPER], owner_users: ["u-super"], super_admin: "u-super", model_owner: "claude-opus-5-5", model_member: "claude-sonnet-5-5", model_fast: "claude-haiku-5-5", max_turns: 40, member_turns: 12, run_minutes: 15, run_cost_usd: 5, day_cost_usd: 40 }],
    profile: [
      { id: "u-super", display_name: "Nabil", username: "nabil", role: "admin", is_active: true },
      { id: "u-admin", display_name: "Sameh", username: "sameh", role: "admin", is_active: true },
      { id: "u-member", display_name: "Rabah", username: "rabah", role: "member", is_active: true },
    ],
    wa_member: [
      { phone: SUPER, user_id: "u-super" },
      { phone: "201000000002", user_id: "u-admin" },
      { phone: "201000000003", user_id: "u-member" },
    ],
    client: [{ id: "c-acme", name: "Acme", company: null, email: null, phone: "201555000111", name_known: true }],
    bot_skill: [
      { key: "message_client", name: "Message clients" },
      { key: "post_in_group", name: "Post in groups" },
    ],
    brain_run: [
      { id: MEMBER_RUN, message_id: "m1", chat_id: "201000000003@c.us", reply_chat: "201000000003@c.us", asker: "u-member", asker_name: "Rabah", tier: "member", status: "running", request: "Tell Acme the files are ready.", created_at: now },
      { id: SUPER_RUN, message_id: "m2", chat_id: `${SUPER}@c.us`, reply_chat: `${SUPER}@c.us`, asker: "u-super", asker_name: "Nabil", tier: "owner", status: "running", request: "Give Rabah messaging clients.", created_at: now },
      { id: ADMIN_RUN, message_id: "m3", chat_id: "201000000002@c.us", reply_chat: "201000000002@c.us", asker: "u-admin", asker_name: "Sameh", tier: "admin", status: "running", request: "Tell Acme the files are ready.", created_at: now },
    ],
  };
}

function deps(skills: Skills, applied: unknown[] = []) {
  const f = fakeDb(world(), {
    rpc: {
      bot_skills_for: (a) => (a.p_user === "u-super" ? ["talk", "message_client", "post_in_group", "permissions"] : (skills[String(a.p_user)] ?? [])),
      _bot_permissions_apply: (a) => (applied.push(a.p), null),
      _directory_read: (a) => (a.p_what === "list" ? [{ ref: "card:1", kind: "vendor", name: "Acme Print", role_title: "Print vendor", status: "active", ...(a.p_full ? { notes: "secret", access: "None" } : {}) }] : a.p_what === "places" ? { projects: ["Launch"] } : []),
      _directory_do: (a) => (applied.push(a), { status: "added", ref: "card:2", record: { ref: "card:2", kind: "vendor", name: "New Co", status: "active" } }),
    },
  });
  const said: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (said.push({ chat, text }), `out-${said.length}`);
  const people = new Map<string, Person>([
    ["u-super", { id: "u-super", name: "Nabil", username: "nabil", active: true, admin: true }],
    ["u-admin", { id: "u-admin", name: "Sameh", username: "sameh", active: true, admin: true }],
    ["u-member", { id: "u-member", name: "Rabah", username: "rabah", active: true, admin: false }],
  ]);
  const t: Team = { people, byPhone: new Map(), byLid: new Map(), others: new Set() };
  const s = { bot_phone: null, book_enabled: true, order_every_min: 60, taught: null } as unknown as Settings;
  const d: Deps = { db: f.db, s, t, send, env: ENV };
  return { ...f, d, said, applied };
}

async function call(d: Deps, name: string, run: string, as: string, input: Record<string, unknown>) {
  const body = JSON.stringify({ run_id: run, acting_as: as, input });
  const req = new Request(`https://x.supabase.co/functions/v1/whatsapp-bot/brain-tools/${name}`, { method: "POST", body, headers: { "x-brain-signature": await signature(SECRET, "to-bot", body) } });
  const res = await brainApi(req, name, async () => d, ENV);
  return (await res.json()) as Record<string, any>;
}

test("the directory: the team reads, a member never sees notes or access, only admins change it", async () => {
  const skills = { "u-member": ["talk", "directory"], "u-admin": ["talk", "directory", "directory_change"] };
  const member = deps(skills);
  const read = await call(member.d, "directory", MEMBER_RUN, "u-member", { action: "search", q: "print" });
  assert.equal(read.ok, true);
  assert.match(JSON.stringify(read), /Acme Print/);
  assert.doesNotMatch(JSON.stringify(read), /secret/);
  const show = await call(member.d, "directory", MEMBER_RUN, "u-member", { action: "show", ref: "card:1" });
  assert.doesNotMatch(JSON.stringify(show), /Launch/);
  const change = await call(member.d, "directory_change", MEMBER_RUN, "u-member", { action: "add", fields: { kind: "vendor", name: "New Co" } });
  assert.doesNotMatch(JSON.stringify(change), /Added/);
  assert.equal(member.applied.length, 0);

  const admin = deps(skills);
  const added = await call(admin.d, "directory_change", ADMIN_RUN, "u-admin", { action: "add", fields: { kind: "vendor", name: "New Co", access: "admin" } });
  assert.match(JSON.stringify(added), /Added: New Co/);
  // Who did it goes with it, and a field that isn't one doesn't get through.
  const sent = admin.applied[0] as { p_actor: string; p: { fields: Record<string, unknown> } };
  assert.equal(sent.p_actor, "u-admin");
  assert.deepEqual(sent.p.fields, { kind: "vendor", name: "New Co" });
  assert.match(JSON.stringify(await call(admin.d, "directory_change", ADMIN_RUN, "u-admin", { action: "update", ref: "Sara" })), /Find them first/);
});

test("the directory stays out of client groups, and a group never gets the whole list", async () => {
  const room = (kind: string) => {
    const x = deps({ "u-admin": ["talk", "directory", "directory_change"] });
    const run = x.tables.brain_run!.find((r) => r.id === ADMIN_RUN)!;
    run.chat_id = "9@g.us";
    run.reply_chat = "9@g.us";
    x.tables.wa_group = [{ chat_id: "9@g.us", name: "Acme", kind, left_at: null }];
    x.tables.wa_participant = [];
    return x;
  };
  const client = room("client");
  const read = await call(client.d, "directory", ADMIN_RUN, "u-admin", { action: "search", q: "print" });
  assert.match(JSON.stringify(read), /Not in a client group/);
  assert.doesNotMatch(JSON.stringify(read), /Acme Print/);

  const team = room("team");
  const out = await call(team.d, "directory_change", ADMIN_RUN, "u-admin", { action: "export" });
  assert.doesNotMatch(JSON.stringify(out), /Acme Print/);
  assert.equal(team.said.length, 0);
});

test("a member given 'message clients' has it done; without it, refused and nothing sent", async () => {
  const given = deps({ "u-member": ["talk", "message_client"] });
  const ok = await call(given.d, "message_client", MEMBER_RUN, "u-member", { client: "c-acme", text: "Your files are ready." });
  assert.equal(ok.ok, true);
  assert.deepEqual(given.said.map((m) => m.chat), ["201555000111@c.us"]);

  const not = deps({ "u-member": ["talk", "find"] });
  const no = await call(not.d, "message_client", MEMBER_RUN, "u-member", { client: "c-acme", text: "Your files are ready." });
  assert.equal(no.ok, false);
  assert.match(no.error, /don't have permission for that \(Message clients\)\. Only the super admin can give it/);
  assert.equal(not.said.length, 0);
});

test("an admin with 'message clients' taken away is refused, though admins have it by default", async () => {
  const { d, said } = deps({ "u-admin": ["talk", "find", "search"] });
  const r = await call(d, "message_client", ADMIN_RUN, "u-admin", { client: "c-acme", text: "Your files are ready." });
  assert.equal(r.ok, false);
  assert.match(r.error, /permission/);
  assert.equal(said.length, 0);
});

test("permissions: the super admin's alone; an admin given everything still can't", async () => {
  const applied: unknown[] = [];
  const { d } = deps({ "u-admin": ["talk", "permissions"] }, applied);
  const admin = await call(d, "permissions", ADMIN_RUN, "u-admin", { action: "give", member: "u-member", skills: ["message_client"] });
  assert.equal(admin.ok, false);
  assert.equal(applied.length, 0);
  const sup = await call(d, "permissions", SUPER_RUN, "u-super", { action: "give", member: "u-member", skills: ["message_client"], only_in: ["private"] });
  assert.equal(sup.ok, true);
  assert.match(sup.data.said, /Given: message_client \(only in private\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [{ op: "grant", user_id: "u-member", skill: "message_client", allowed: true, chats: ["private"] }]);
});

test("the super admin blocks a number outside the team, and unblocks it", async () => {
  const applied: unknown[] = [];
  const { d } = deps({}, applied);
  assert.equal((await call(d, "permissions", SUPER_RUN, "u-super", { action: "block", phone: "+20 155 500 0222" })).ok, true);
  assert.equal((await call(d, "permissions", SUPER_RUN, "u-super", { action: "unblock", phone: "201555000222" })).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [
    { op: "grant", phone: "201555000222", skill: "talk", allowed: false },
    { op: "reset", phone: "201555000222", skill: "talk" },
  ]);
});

test("skillsFor: before 0137 (no list from the database) it's null, and everyone may talk", async () => {
  const { db } = fakeDb({});
  assert.equal(await skillsFor(db, { user: "u1", phone: null, tier: "member", chat: "x@c.us" }), null);
  assert.equal(await mayTalk(db, { user: "u1", phone: null, tier: "member", chat: "x@c.us" }), true);
  const blocked = fakeDb({}, { rpc: { bot_skills_for: () => [] } });
  assert.equal(await mayTalk(blocked.db, { user: null, phone: "201555000222", tier: "client", chat: "201555000222@c.us" }), false);
});

test("kinds: the super admin and admins by admin defaults, members by member, everyone else by client", () => {
  assert.equal(kindOf("owner"), "admin");
  assert.equal(kindOf("admin"), "admin");
  assert.equal(kindOf("member"), "member");
  assert.equal(kindOf("client"), "client");
});
