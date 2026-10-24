// Who may read what through find (look.ts), on a database in memory: private
// chats with the bot, email alerts and their events, files, and the "what's
// going on" and history a question is answered with (orders.ts, history.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { find, Refused, whoAsks, type Me } from "./look.ts";
import { search } from "./search.ts";
import { situation } from "./orders.ts";
import { historyOf } from "./history.ts";
import { mayPickForBot } from "../_shared/calendly.ts";
import type { Team } from "./kit.ts";

const world = () =>
  fakeDb({
    profile: [
      { id: "u-adm", role: "admin", is_active: true, display_name: "Omar" },
      { id: "u-mem", role: "member", is_active: true, display_name: "Mona" },
      { id: "u-two", role: "member", is_active: true, display_name: "Tarek" },
      { id: "u-was", role: "admin", is_active: false, display_name: "Gone" },
    ],
    profile_contact: [
      { user_id: "u-mem", whatsapp: "15555550001" },
      { user_id: "u-two", whatsapp: "15555550002" },
    ],
    wa_member: [
      { phone: "15555550001", user_id: "u-mem" },
      { phone: "15555550009", user_id: "u-mem" },
    ],
    wa_member_lid: [{ lid: "777@lid", user_id: "u-mem" }],
    board: [],
    board_member: [],
    gmail_account: [
      { id: "g-mem", user_id: "u-mem" },
      { id: "g-adm", user_id: "u-adm" },
      { id: "g-two", user_id: "u-two" },
    ],
    gmail_share: [{ account_id: "g-two", grantee_id: "u-mem", access: "read" }],
    fireflies_account: [],
    fireflies_share: [],
    wa_dm_chat: [
      { chat_id: "15555550001@c.us" },
      { chat_id: "15555550009@c.us" },
      { chat_id: "777@lid" },
      { chat_id: "15555550002@c.us" },
      { chat_id: "15555559999@c.us" },
    ],
    wa_dm: [
      { id: "d-own", chat_id: "15555550001@c.us", text: "my question" },
      { id: "d-own2", chat_id: "15555550009@c.us", text: "from my other number" },
      { id: "d-lid", chat_id: "777@lid", text: "hidden number" },
      { id: "d-two", chat_id: "15555550002@c.us", text: "Tarek asks about his salary" },
      { id: "d-client", chat_id: "15555559999@c.us", text: "a client's private chat" },
    ],
    wa_file: [
      { id: "f-group", chat_id: "team@g.us", name: "brief.pdf" },
      { id: "f-own", chat_id: "15555550001@c.us", name: "mine.ogg" },
      { id: "f-two", chat_id: "15555550002@c.us", name: "tarek.ogg" },
    ],
    watch_alert: [
      { id: "a-wa", status: "open", source: "whatsapp", mail_account: null, title: "Sara is waiting", created_at: "2026-10-23T10:00:00Z" },
      { id: "a-mine", status: "open", source: "email", mail_account: "g-mem", title: "Reply to Acme", mail_subject: "Acme logo", created_at: "2026-10-23T10:01:00Z" },
      { id: "a-two", status: "open", source: "email", mail_account: "g-two", title: "Tarek's email", mail_subject: "Shared with Mona", created_at: "2026-10-23T10:02:00Z" },
      { id: "a-adm", status: "open", source: "email", mail_account: "g-adm", title: "Invoice dispute", mail_subject: "Owed money", mail_from: "bank@x.com", created_at: "2026-10-23T10:03:00Z" },
    ],
    watch_event: [
      { id: 1, alert_id: "a-wa", what: "opened" },
      { id: 2, alert_id: "a-adm", what: "opened", detail: "Owed money" },
      { id: 3, alert_id: "a-mine", what: "opened" },
    ],
    watch_recipient: [{ alert_id: "a-adm", user_id: "u-adm" }],
    mail_message: [
      { id: "m-mem", account_id: "g-mem", subject: "From Mona's mailbox", body: "hi", sent_at: "2026-10-20T10:00:00Z", from_addr: "sara@acme.com", addrs: ["sara@acme.com"] },
      { id: "m-adm", account_id: "g-adm", subject: "From Omar's mailbox", body: "the price", sent_at: "2026-10-21T10:00:00Z", from_addr: "sara@acme.com", addrs: ["sara@acme.com"] },
    ],
  });

async function as(id: string) {
  const f = world();
  const me = (await whoAsks(f.db, id)) as Me;
  const ids = async (q: Parameters<typeof find>[2]) => (JSON.parse(await find(f.db, me, q, new Map())) as { rows: { id?: string; chat_id?: string }[] }).rows.map((r) => r.id ?? r.chat_id);
  return { f, me, ids };
}

// ----------------------------------------------------------- private chats --

test("a member's own private chats with the bot are found by their numbers and hidden-number id", async () => {
  const { me } = await as("u-mem");
  assert.deepEqual(me.dms.sort(), ["15555550001@c.us", "15555550009@c.us", "777@lid"]);
});

test("a member reads only their own private chat with the bot, not a teammate's or a client's", async () => {
  const { ids } = await as("u-mem");
  assert.deepEqual((await ids({ table: "wa_dm" })).sort(), ["d-lid", "d-own", "d-own2"]);
  assert.deepEqual((await ids({ table: "wa_dm_chat" })).sort(), ["15555550001@c.us", "15555550009@c.us", "777@lid"]);
  // Asking for someone else's chat by its id doesn't get round it.
  assert.deepEqual(await ids({ table: "wa_dm", where: [{ column: "chat_id", op: "eq", value: "15555550002@c.us" }] }), []);
  assert.deepEqual(await ids({ table: "wa_dm", search: { columns: ["text"], text: "salary" } }), []);
});

test("an admin reads every private chat with the bot", async () => {
  const { ids } = await as("u-adm");
  assert.deepEqual((await ids({ table: "wa_dm" })).sort(), ["d-client", "d-lid", "d-own", "d-own2", "d-two"]);
});

test("a member with no number on iklipse reads no private chat at all", async () => {
  const f = world();
  f.tables.profile_contact = [];
  f.tables.wa_member = [];
  f.tables.wa_member_lid = [];
  const me = (await whoAsks(f.db, "u-mem")) as Me;
  assert.deepEqual(me.dms, []);
  assert.equal((JSON.parse(await find(f.db, me, { table: "wa_dm" }, new Map())) as { rows: unknown[] }).rows.length, 0);
});

test("a member who puts an admin's number on their own card reads nothing of the admin's private chat", async () => {
  const w = world();
  w.tables.wa_member!.push({ phone: "15555550005", user_id: "u-adm" });
  w.tables.profile_contact = [{ user_id: "u-two", whatsapp: "15555550005" }];
  w.tables.wa_dm_chat!.push({ chat_id: "15555550005@c.us" });
  w.tables.wa_dm!.push({ id: "d-adm", chat_id: "15555550005@c.us", text: "the admin's salary talk" });
  w.tables.wa_file!.push({ id: "f-adm", chat_id: "15555550005@c.us", name: "salary.pdf" });
  // bot_search gives back everything it has, as if it didn't filter: what the asker may read is checked again.
  const asked: Record<string, unknown>[] = [];
  const pieces = [{ id: 1, source: "wa_dm", source_id: "d-adm", part: 0, chat_id: "15555550005@c.us", account_id: null, meeting_id: null, place: "a private chat with the bot", who: "Omar", at: null, text: "the admin's salary talk", score: 1 }];
  const f = fakeDb(w.tables, { rpc: { bot_search: (args) => (asked.push(args), pieces) } });
  const me = (await whoAsks(f.db, "u-two")) as Me;
  assert.deepEqual(me.dms, []);
  const ids = async (q: Parameters<typeof find>[2]) => (JSON.parse(await find(f.db, me, q, new Map())) as { rows: { id?: string; chat_id?: string }[] }).rows.map((r) => r.id ?? r.chat_id);
  assert.deepEqual(await ids({ table: "wa_dm" }), []);
  assert.deepEqual(await ids({ table: "wa_dm_chat" }), []);
  assert.deepEqual(await ids({ table: "wa_file" }), ["f-group"]);
  const found = (JSON.parse(await search(f.db, me, { text: "salary", in: ["private", "files"] }, null)) as { found: unknown[] }).found;
  assert.deepEqual(found, []);
  assert.deepEqual((asked[0]!.p_scope as { dms: string[] }).dms, []);
});

test("files: a member gets the groups' and their own private chat's, not a teammate's", async () => {
  const { ids } = await as("u-mem");
  assert.deepEqual((await ids({ table: "wa_file" })).sort(), ["f-group", "f-own"]);
  const adm = await as("u-adm");
  assert.deepEqual((await adm.ids({ table: "wa_file" })).sort(), ["f-group", "f-own", "f-two"]);
});

// ------------------------------------------------------------------- Slack --

test("Slack: a private channel's messages only for admins, as in search (0117); when the channels can't be read, a member gets none", async () => {
  const tables = () => ({
    slack_channel: [
      { channel_id: "C0OPEN001", name: "acme-test", is_private: false },
      { channel_id: "G0PRIV001", name: "salaries-test", is_private: true },
    ],
    slack_message: [
      { channel_id: "C0OPEN001", ts: "1.1", text: "the open channel" },
      { channel_id: "G0PRIV001", ts: "1.2", text: "the private channel" },
    ],
  });
  const me = (admin: boolean): Me => ({ id: admin ? "u-adm" : "u-mem", admin, boards: [], mail: [], dms: [], ffAccounts: [], ffMeetings: [] });
  const texts = async (f: ReturnType<typeof fakeDb>, who: Me, q: Parameters<typeof find>[2] = { table: "slack_message" }) =>
    (JSON.parse(await find(f.db, who, q, new Map())) as { rows: { text: string }[] }).rows.map((r) => r.text);
  const f = fakeDb(tables());
  assert.deepEqual(await texts(f, me(false)), ["the open channel"]);
  // Not by asking for the channel either.
  assert.deepEqual(await texts(f, me(false), { table: "slack_message", where: [{ column: "channel_id", op: "eq", value: "G0PRIV001" }] }), []);
  assert.deepEqual(await texts(f, me(true)), ["the open channel", "the private channel"]);
  const down = fakeDb(tables(), { fail: (c) => (c.table === "slack_channel" ? "timeout" : null) });
  assert.deepEqual(await texts(down, me(false)), []);
});

// ------------------------------------------------------------ email alerts --

test("email alerts: only the mailbox's owner and who it's shared with, admins included", async () => {
  const mem = await as("u-mem");
  assert.deepEqual((await mem.ids({ table: "watch_alert" })).sort(), ["a-mine", "a-two", "a-wa"]);
  const adm = await as("u-adm");
  assert.deepEqual((await adm.ids({ table: "watch_alert" })).sort(), ["a-adm", "a-wa"]);
  // Not by asking for the subject either.
  assert.deepEqual(await mem.ids({ table: "watch_alert", search: { columns: ["mail_subject", "title"], text: "Owed" } }), []);
  assert.deepEqual(await mem.ids({ table: "watch_alert", where: [{ column: "id", op: "eq", value: "a-adm" }] }), []);
});

test("an alert's events and people: only with its id, and only of alerts they can see", async () => {
  const mem = await as("u-mem");
  await assert.rejects(find(mem.f.db, mem.me, { table: "watch_event" }, new Map()), (e) => e instanceof Refused && /alert_id/.test(e.message));
  await assert.rejects(find(mem.f.db, mem.me, { table: "watch_event", where: [{ column: "alert_id", op: "eq", value: "a-adm" }] }, new Map()), Refused);
  await assert.rejects(find(mem.f.db, mem.me, { table: "watch_recipient", where: [{ column: "alert_id", op: "in", value: ["a-wa", "a-adm"] }] }, new Map()), Refused);
  assert.deepEqual(await mem.ids({ table: "watch_event", where: [{ column: "alert_id", op: "eq", value: "a-mine" }] }), [3]);
  const adm = await as("u-adm");
  await assert.rejects(find(adm.f.db, adm.me, { table: "watch_event", where: [{ column: "alert_id", op: "eq", value: "a-mine" }] }, new Map()), Refused);
  assert.deepEqual(await adm.ids({ table: "watch_event", where: [{ column: "alert_id", op: "eq", value: "a-adm" }] }), [2]);
});

test("what's going on, for a question: someone else's email alerts aren't in it", async () => {
  const f = world();
  const t: Team = { people: new Map(), byPhone: new Map(), byLid: new Map(), others: new Set() };
  const dir = { team: new Map(), clients: new Map() } as unknown as Parameters<typeof situation>[2];
  const titles = async (mail: string[]) => (await situation(f.db, t, dir, mail)).open_alerts.map((a) => a.title).sort();
  assert.deepEqual(await titles(["g-mem"]), ["Reply to Acme", "Sara is waiting"]);
  assert.deepEqual(await titles([]), ["Sara is waiting"]);
  const said = JSON.stringify(await situation(f.db, t, dir, ["g-mem"]));
  assert.doesNotMatch(said, /Owed money|Invoice dispute/);
});

test("a client's emails in an answer: only from mailboxes the one asking may read", async () => {
  const f = world();
  const mine = await historyOf(f.db, { phone: null, email: "sara@acme.com" }, 30, ["g-mem"]);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!, /From Mona's mailbox/);
  assert.deepEqual(await historyOf(f.db, { phone: null, email: "sara@acme.com" }, 30, []), []);
  // The bot talking with the client themselves: their own emails, all of them.
  assert.equal((await historyOf(f.db, { phone: null, email: "sara@acme.com" }, 30)).length, 2);
});

// ------------------------------------------------------------- Calendly --

test("only an active admin picks the Calendly account and event type the bot books with", async () => {
  const f = world();
  assert.equal(await mayPickForBot(f.db, "u-adm"), true);
  assert.equal(await mayPickForBot(f.db, "u-mem"), false);
  assert.equal(await mayPickForBot(f.db, "u-was"), false);
  assert.equal(await mayPickForBot(f.db, "nobody"), false);
});
