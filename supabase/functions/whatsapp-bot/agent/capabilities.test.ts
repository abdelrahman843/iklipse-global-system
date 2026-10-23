// The agent's capabilities on the bot's real code (look.ts's find and who may
// read what, orders.ts's orders), on a database in memory (test/fake-db.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "../test/fake-db.ts";
import { whoAsks, type Me } from "../look.ts";
import type { Attendee } from "../meetings.ts";
import { findCapability, messageTeamCapability, type Given } from "./capabilities.ts";
import { ToolError, type Actor } from "./runtime.ts";

const member: Actor = { id: "u-mem", name: "Mona", role: "member" };
const ctx = { actor: member, runKey: "m1", attempt: 0 };

const tables = () => ({
  profile: [
    { id: "u-adm", role: "admin", is_active: true, display_name: "Omar" },
    { id: "u-mem", role: "member", is_active: true, display_name: "Mona" },
    { id: "u-gst", role: "guest", is_active: true, display_name: "Gus" },
    { id: "u-old", role: "member", is_active: false, display_name: "Old" },
  ],
  board: [
    { id: "b-mine", kind: "kanban", visibility: "private" },
    { id: "b-open", kind: "kanban", visibility: "workspace" },
    { id: "b-secret", kind: "kanban", visibility: "private" },
  ],
  board_member: [{ board_id: "b-mine", user_id: "u-mem" }],
  card: [
    { id: "c1", board_id: "b-mine", title: "Logo" },
    { id: "c2", board_id: "b-open", title: "Video" },
    { id: "c3", board_id: "b-secret", title: "Merger" },
  ],
  gmail_account: [
    { id: "g-mem", user_id: "u-mem" },
    { id: "g-adm", user_id: "u-adm" },
  ],
  gmail_share: [],
  fireflies_account: [],
  fireflies_share: [],
  mail_message: [
    { id: "e1", account_id: "g-mem", subject: "Mine" },
    { id: "e2", account_id: "g-adm", subject: "The admin's" },
  ],
  work_session: [
    { id: "w1", user_id: "u-mem" },
    { id: "w2", user_id: "u-adm" },
  ],
  invoice: [{ id: "i1", amount: 100 }],
});

async function asWho(id: string) {
  const f = fakeDb(tables());
  const me = (await whoAsks(f.db, id)) as Me;
  return { f, me, find: findCapability(f.db, me, new Map([["u-adm", "Omar"]])) };
}
const rows = (data: unknown) => (JSON.parse(String(data)) as { rows: Record<string, unknown>[] }).rows;

// -------------------------------------------------------------- who reads --

test("who may look things up: guests and people no longer active can't", async () => {
  const f = fakeDb(tables());
  assert.equal(await whoAsks(f.db, "u-gst"), null);
  assert.equal(await whoAsks(f.db, "u-old"), null);
  assert.equal(await whoAsks(f.db, "nobody"), null);
  const m = await whoAsks(f.db, "u-mem");
  assert.deepEqual(m?.boards.sort(), ["b-mine", "b-open"]);
  assert.deepEqual(m?.mail, ["g-mem"]);
  assert.equal((await whoAsks(f.db, "u-adm"))?.admin, true);
});

test("a member reads only the boards they can see, whatever they ask for", async () => {
  const { find } = await asWho("u-mem");
  const got = rows((await find.run({ table: "card" }, ctx)).data).map((r) => r.id);
  assert.deepEqual(got.sort(), ["c1", "c2"]);
  // Asking for the secret board's card by id doesn't get round it.
  const direct = rows((await find.run({ table: "card", where: [{ column: "board_id", op: "eq", value: "b-secret" }] }, ctx)).data);
  assert.deepEqual(direct, []);
});

test("nobody reads anyone else's mail, admins included", async () => {
  const mem = await asWho("u-mem");
  assert.deepEqual(rows((await mem.find.run({ table: "mail_message" }, ctx)).data).map((r) => r.id), ["e1"]);
  const adm = await asWho("u-adm");
  assert.deepEqual(rows((await adm.find.run({ table: "mail_message" }, { ...ctx, actor: { ...member, role: "admin" } })).data).map((r) => r.id), ["e2"]);
});

test("attendance: a member sees only their own, an admin everyone's", async () => {
  const mem = await asWho("u-mem");
  assert.deepEqual(rows((await mem.find.run({ table: "work_session" }, ctx)).data).map((r) => r.id), ["w1"]);
  const adm = await asWho("u-adm");
  assert.deepEqual(rows((await adm.find.run({ table: "work_session" }, ctx)).data).map((r) => r.id).sort(), ["w1", "w2"]);
});

test("money is for admins: a member is refused (denied), an admin reads it", async () => {
  const mem = await asWho("u-mem");
  await assert.rejects(mem.find.run({ table: "invoice" }, ctx), (e) => e instanceof ToolError && e.kind === "denied" && /admins only/.test(e.message));
  const adm = await asWho("u-adm");
  assert.equal(rows((await adm.find.run({ table: "invoice" }, ctx)).data).length, 1);
});

test("a wrong table or column goes back as a wrong input; the database failing is passing", async () => {
  const { find } = await asWho("u-mem");
  await assert.rejects(find.run({ table: "auth_users" }, ctx), (e) => e instanceof ToolError && e.kind === "invalid_input");
  await assert.rejects(find.run({ table: "card", columns: ["secret_token"] }, ctx), (e) => e instanceof ToolError && e.kind === "invalid_input");
  const down = fakeDb(tables(), { fail: (c) => (c.table === "card" ? "TypeError: fetch failed" : null) });
  const me = (await whoAsks(down.db, "u-adm")) as Me;
  await assert.rejects(findCapability(down.db, me, new Map()).run({ table: "card" }, ctx), (e) => e instanceof ToolError && e.kind === "transient");
  assert.equal(typeof find.validate({}), "string");
  assert.equal(find.allowed({ ...member, role: "guest" }), "Guests can't use the bot.");
});

// ------------------------------------------------- writing to the team --

const team = new Map<string, Attendee>([
  ["u-rabah", { kind: "team", id: "u-rabah", name: "Rabah Ali", email: null, phone: "15555550101" }],
  ["u-bot", { kind: "team", id: "u-bot", name: "Bot", email: null, phone: "15555550109" }],
]);

function teamCap(o: { given?: Given; check?: { status: string; sent: number } | null } = {}) {
  const gave: string[] = [];
  const cap = messageTeamCapability({
    team,
    botPhone: "15555550109",
    answerTo: "here",
    give: async (to, x) => {
      gave.push(`${to.name}: ${x.message}`);
      return o.given ?? { order: { id: "o1" } };
    },
    check: async () => (o.check === undefined ? { status: "open", sent: 1 } : o.check),
  });
  return { cap, gave };
}
const msg = { person: "u-rabah", kind: "tell", task: "send the logo files", message: "Hi Rabah — Sameh asks you to send the logo files.", nudge: "Reminder", wait: true };

test("message_team_member takes only someone active on the team, never the bot, and tidies the message", () => {
  const { cap } = teamCap();
  assert.match(String(cap.validate({ ...msg, person: "u-client" })), /No one active on the team/);
  assert.match(String(cap.validate({ ...msg, person: "u-bot" })), /bot's own number/);
  assert.match(String(cap.validate({ ...msg, message: "" })), /task and the message/);
  const ok = cap.validate(msg);
  assert.ok(typeof ok !== "string");
  assert.equal(ok.message, "Hi Rabah, Sameh asks you to send the logo files.");
  assert.equal(cap.key!(ok), "team:u-rabah");
  assert.equal(cap.describe!(ok), "write to Rabah (send the logo files)");
  assert.equal(cap.effect, "write");
  assert.equal(cap.confirm, undefined);
});

test("written and checked: the order is read back and WhatsApp took it", async () => {
  const { cap, gave } = teamCap();
  const x = cap.validate(msg);
  assert.ok(typeof x !== "string");
  const done = await cap.run(x, ctx);
  assert.equal(gave.length, 1);
  assert.deepEqual(done.verified?.status, "submitted");
  assert.equal(done.receipt, "Sent to Rabah. I'll follow up until it's done.");
  const asked = await teamCap().cap.run({ ...x, kind: "ask" }, ctx);
  assert.equal(asked.receipt, "Asked Rabah. I'll bring the answer here.");
  const told = await teamCap({ given: { order: { id: "o1" }, told: true }, check: { status: "done", sent: 1 } }).cap.run(x, ctx);
  assert.equal(told.receipt, "Told Rabah.");
});

test("not claimed as sent when the check says otherwise", async () => {
  const x = teamCap().cap.validate(msg);
  assert.ok(typeof x !== "string");
  assert.equal((await teamCap({ check: { status: "failed", sent: 0 } }).cap.run(x, ctx)).verified?.status, "failed");
  assert.equal((await teamCap({ check: { status: "open", sent: 0 } }).cap.run(x, ctx)).verified?.status, "unknown");
  assert.equal((await teamCap({ check: null }).cap.run(x, ctx)).verified?.status, "unknown");
});

test("what stopped it says where: no number (nothing to retry), keeping it (passing), sending it (failed)", async () => {
  const x = teamCap().cap.validate(msg);
  assert.ok(typeof x !== "string");
  const kind = async (stage: Given["stage"]) => {
    try {
      await teamCap({ given: { stage, problem: "no" } }).cap.run(x, ctx);
    } catch (e) {
      return (e as ToolError).kind;
    }
  };
  assert.equal(await kind("check"), "not_found");
  assert.equal(await kind("keep"), "transient");
  assert.equal(await kind("send"), "permanent");
});
