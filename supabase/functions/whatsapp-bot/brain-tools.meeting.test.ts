// The brain and meetings (brain-tools.ts meeting): nothing booked, moved or
// cancelled until the asker says yes to exactly that, in a later message; and
// asked in a client group, only what's about the people in it (never "a call
// with everyone" turning into the whole team). Names and numbers are made up.
//   npm run test:bot

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { brainApi, saysYes, type Deps } from "./brain-tools.ts";
import { signature, type BrainEnv } from "./brain.ts";
import type { Person, Settings, Team } from "./kit.ts";

const SECRET = "k".repeat(40);
const ENV: BrainEnv = { enabled: true, url: "https://brain.example.com", secret: SECRET };
const OWNER = "201000000001";
const GROUP = "120363000000000001@g.us";
const IN_GROUP = "11111111-1111-4111-8111-111111111111";
const LATER = "22222222-2222-4222-8222-222222222222";
const PRIVATE = "33333333-3333-4333-8333-333333333333";

function world(o: { later?: string } = {}) {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const run = (id: string, chat: string, request: string, ago: number) => ({
    id,
    message_id: `m-${id.slice(0, 1)}`,
    chat_id: chat,
    reply_chat: `${OWNER}@c.us`,
    asker: "u-owner",
    asker_name: "Sameh",
    tier: "owner",
    status: "running",
    request,
    created_at: at(ago),
  });
  return {
    brain_settings: [{ id: 1, phase: 2, stopped: false, owner_phones: [OWNER], model_owner: "claude-opus-5-5", model_member: "claude-sonnet-5-5", model_fast: "claude-haiku-5-5", max_turns: 40, member_turns: 12, run_minutes: 15, run_cost_usd: 5, day_cost_usd: 40 }],
    profile: [
      { id: "u-owner", display_name: "Sameh", username: "sameh", role: "admin", is_active: true },
      { id: "u-member", display_name: "Rabah", username: "rabah", role: "member", is_active: true },
    ],
    wa_member: [
      { phone: OWNER, user_id: "u-owner" },
      { phone: "201000000003", user_id: "u-member" },
    ],
    profile_contact: [{ user_id: "u-member", whatsapp: "201000000003" }],
    client: [{ id: "c-abbas", name: "Abbas Khalil", company: null, email: null, phone: "201555000111", phone_key: "201555000111", name_known: true, from_chat: GROUP }],
    wa_group: [{ chat_id: GROUP, name: "abbas", kind: "client" }],
    wa_participant: [
      { chat_id: GROUP, wa_id: "201555000111@c.us", phone: "201555000111", lid: null, name: "Abbas" },
      { chat_id: GROUP, wa_id: `${OWNER}@c.us`, phone: OWNER, lid: null, name: "Sameh" },
    ],
    brain_approval: [] as Record<string, unknown>[],
    brain_run: [
      run(IN_GROUP, GROUP, "@iklipse book a call on the next free slot with all members", 60_000),
      // Their answer, after the meeting was put to them.
      run(LATER, `${OWNER}@c.us`, o.later ?? "تمام", -5_000),
      run(PRIVATE, `${OWNER}@c.us`, "Book a call with Rabah tomorrow at 4", 30_000),
    ],
  };
}

function deps(tables: Record<string, Record<string, unknown>[]>) {
  const f = fakeDb(tables);
  const said: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (said.push({ chat, text }), `out-${said.length}`);
  const owner: Person = { id: "u-owner", name: "Sameh", username: "sameh", active: true, admin: true };
  const member: Person = { id: "u-member", name: "Rabah", username: "rabah", active: true, admin: false };
  const t: Team = {
    people: new Map([
      ["u-owner", owner],
      ["u-member", member],
    ]),
    byPhone: new Map([
      [OWNER, owner],
      ["201000000003", member],
    ]),
    byLid: new Map(),
    others: new Set(),
  };
  // Booking is off: what's done after a yes stops at the booking, which says so.
  const s = { bot_phone: null, book_enabled: false, order_every_min: 60, taught: null } as unknown as Settings;
  const d: Deps = { db: f.db, s, t, send, env: ENV };
  return { ...f, d, said };
}

async function call(d: Deps, name: string, run: string, input: Record<string, unknown>) {
  const body = JSON.stringify({ run_id: run, acting_as: "u-owner", input });
  const req = new Request(`https://x.supabase.co/functions/v1/whatsapp-bot/brain-tools/${name}`, {
    method: "POST",
    body,
    headers: { "x-brain-signature": await signature(SECRET, "to-bot", body) },
  });
  const res = await brainApi(req, name, async () => d, ENV);
  return (await res.json()) as Record<string, any>;
}

const CANCEL = { action: "cancel", with: ["Abbas Khalil"], date: "2026-11-01", time: "16:00" };

test("asked in a client group: a call with the whole team, or anything not about the people there, is refused and nothing is done", async () => {
  const { d, said, tables } = deps(world());
  const team = await call(d, "meeting", IN_GROUP, { action: "book", with: ["u-owner", "u-member"], date: "2026-11-01", time: "16:00", topic: "Team call" });
  assert.equal(team.ok, false);
  assert.match(team.error, /Rabah isn't in "abbas"\. "Everyone" there is: Abbas Khalil and Sameh/);
  assert.match((await call(d, "message_team_member", IN_GROUP, { person: "everyone", task: "x", message: "x" })).error, /only things about the people in it/);
  assert.match((await call(d, "set_reminder", IN_GROUP, { text: "x", when: "2026-11-01T10:00" })).error, /only things about the people in it/);
  assert.match((await call(d, "post_in_group", IN_GROUP, { group: "team", text: "x" })).error, /only things about the people in it/);
  assert.equal(said.length, 0);
  assert.equal(tables.brain_approval!.length, 0);
});

test("a meeting with the people in the group is put to the asker first: nothing done, it waits for their yes", async () => {
  const { d, said, tables } = deps(world());
  const r = await call(d, "meeting", IN_GROUP, CANCEL);
  assert.equal(r.ok, true);
  assert.equal(r.data.needs_ok, true);
  assert.match(r.data.said, /^NOT done yet: .+"Cancel the call with Abbas Khalil on Sun 1 Nov at 16:00 \(Cairo\)\. Confirm\?"/);
  assert.equal(said.length, 0);
  assert.deepEqual(
    tables.brain_approval!.map((a) => [a.tool, a.status, a.run_id]),
    [["meeting", "waiting", IN_GROUP]],
  );
  // Asked again in the same request: not their answer, nothing more.
  assert.equal((await call(d, "meeting", IN_GROUP, CANCEL)).data.already, true);
  assert.equal(tables.brain_approval![0]!.status, "waiting");
});

test("their next message is a plain yes: exactly what they said yes to is done", async () => {
  const { d, tables } = deps(world({ later: "تمام" }));
  await call(d, "meeting", IN_GROUP, { ...CANCEL, why: "asked in abbas" });
  const r = await call(d, "meeting", LATER, CANCEL);
  // Carried out, not put to them again (booking is off here, so that's what it says).
  assert.equal(r.ok, false);
  assert.match(r.error, /Booking meetings from WhatsApp is off/);
  assert.equal(tables.brain_approval![0]!.status, "failed");
  assert.equal(tables.brain_approval![0]!.decided_by, "u-owner");
});

test("their next message isn't a yes, or the meeting changed: nothing is done", async () => {
  const no = deps(world({ later: "لا استنى" }));
  await call(no.d, "meeting", IN_GROUP, CANCEL);
  const r = await call(no.d, "meeting", LATER, CANCEL);
  assert.equal(r.data.needs_ok, true);
  assert.match(r.data.said, /haven't said a plain yes/);
  assert.equal(no.tables.brain_approval![0]!.status, "waiting");

  const other = deps(world({ later: "yes" }));
  await call(other.d, "meeting", IN_GROUP, CANCEL);
  const moved = await call(other.d, "meeting", LATER, { ...CANCEL, time: "17:00" });
  assert.equal(moved.data.needs_ok, true);
  assert.deepEqual(
    other.tables.brain_approval!.map((a) => a.status),
    ["waiting", "waiting"],
  );
});

test("privately, a meeting with anyone on the team is fine, after their yes too", async () => {
  const { d, tables } = deps(world());
  const r = await call(d, "meeting", PRIVATE, { action: "book", with: ["u-member"], date: "2026-11-02", time: "16:00" });
  assert.equal(r.data.needs_ok, true);
  assert.match(r.data.said, /"Book a call with Rabah on Mon 2 Nov at 16:00 \(Cairo\)\. Confirm\?"/);
  assert.equal(tables.brain_approval!.length, 1);
});

test("a plain yes, in English or Egyptian Arabic; anything with a but, a no or a change isn't", () => {
  for (const y of ["yes", "Yes!", "ok", "تمام", "أيوه", "ايوة احجز", "اه اعمله", "👍", "confirm"]) assert.equal(saysYes(y), true, y);
  for (const n of ["no", "لا", "تمام بس خليها الساعة 5", "ok but at 5", "wait", "مش دلوقتي", "", "book it at 5 instead please with Rabah and also Sara and everyone"]) assert.equal(saysYes(n), false, n);
});
