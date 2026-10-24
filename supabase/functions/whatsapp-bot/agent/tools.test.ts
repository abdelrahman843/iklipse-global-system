// The agent's new tools (capabilities.ts): closing an alert by the Alerts
// page's rule, free times, booking a meeting (a client's needs an OK, the
// team's doesn't), writing to a client (always an OK first, what it would
// send kept for the team); and a client's stuck chat looked into (stuck.ts)
// without anything reaching them. Against a scripted Claude, made-up names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, ToolError, type Model, type ModelBlock } from "./runtime.ts";
import { bookMeetingCapability, closeAlertCapability, freeTimesCapability, messageClientCapability, type AlertSeen, type MeetingAsk } from "./capabilities.ts";
import { agentForClients, lookIntoIt } from "../stuck.ts";
import { fakeDb } from "../test/fake-db.ts";
import type { Me } from "../look.ts";
import type { Attendee } from "../meetings.ts";
import type { Settings } from "../kit.ts";

const ctx = { actor: { id: "u1", name: "Sameh", role: "member" as const }, runKey: "m1", attempt: 0 };
const me = (o: Partial<Me> = {}): Me => ({ id: "u1", admin: false, boards: [], mail: ["box-mine"], dms: [], ffAccounts: [], ffMeetings: [], ...o });
const A = "11111111-2222-4333-8444-555555555555";

/** Claude, scripted: each turn gives its blocks. */
function script(...turns: ModelBlock[][]): Model {
  let i = 0;
  return async () => ({ content: turns[i++] ?? [], usage: { input_tokens: 10, output_tokens: 10 } });
}
const use = (id: string, name: string, input: unknown): ModelBlock => ({ type: "tool_use", id, name, input });
const finish = (id: string, text: string) => use(id, "finish", { status: "done", text });

// ---------------------------------------------------------- close_alert --

function alerts(a: Partial<AlertSeen>) {
  const row: AlertSeen = { id: A, title: "Abbas is waiting for a reply", status: "open", source: "whatsapp", mail_account: null, recipients: ["u2"], ...a };
  const closed: string[] = [];
  return {
    closed,
    read: async (id: string) => (id === row.id ? { ...row } : null),
    close: async (id: string) => (closed.push(id), (row.status = "handled"), true),
  };
}

test("close_alert: admins any, members the ones that ring them; an email one only with its mailbox", async () => {
  const run = async (who: Me, a: Partial<AlertSeen>) => {
    const w = alerts(a);
    const cap = closeAlertCapability({ me: who, read: w.read, close: w.close });
    const x = cap.validate({ alert: A, note: "Rabah replied" });
    assert.notEqual(typeof x, "string");
    try {
      return { done: await cap.run(x as Exclude<typeof x, string>, ctx), closed: w.closed };
    } catch (e) {
      return { error: (e as ToolError).kind, closed: w.closed };
    }
  };
  const byAdmin = await run(me({ admin: true }), {});
  assert.deepEqual(byAdmin.closed, [A]);
  assert.equal(byAdmin.done?.verified?.status, "verified");
  assert.equal(byAdmin.done?.receipt, "Closed: Abbas is waiting for a reply.");
  assert.deepEqual(await run(me(), {}), { error: "denied", closed: [] });
  assert.deepEqual((await run(me(), { recipients: ["u1"] })).closed, [A]);
  assert.deepEqual(await run(me({ admin: true }), { source: "email", mail_account: "box-other" }), { error: "denied", closed: [] });
  assert.deepEqual(await run(me({ admin: true }), { status: "handled" }), { error: "conflict", closed: [] });
  assert.equal(closeAlertCapability({ me: me(), ...alerts({}) }).validate({ alert: "A1b2c3" }), "It needs the alert's id (watch_alert.id): find it first.");
});

// ----------------------------------------------------------- free_times --

test("free_times: only reads; what's wrong (no Calendly) is said", async () => {
  const asked: unknown[] = [];
  const cap = freeTimesCapability({ free: async (x) => (asked.push(x), "Free Thursday 22-10-2026: 2:00 PM to 6:00 PM (Cairo time).") });
  assert.equal(cap.effect, "read");
  const x = cap.validate({ days: ["2026-10-22", "Thursday"], minutes: "30", search: "x" }) as Exclude<ReturnType<typeof cap.validate>, string>;
  assert.deepEqual(x, { days: ["2026-10-22"], minutes: 30, search: "" });
  assert.deepEqual((await cap.run(x, ctx)).data, { free: "Free Thursday 22-10-2026: 2:00 PM to 6:00 PM (Cairo time)." });
  const none = freeTimesCapability({ free: async () => { throw new Error("Your Calendly isn't connected on iklipse yet. Connect it, then ask again."); } });
  await assert.rejects(none.run(x, ctx), (e) => e instanceof ToolError && e.kind === "not_found");
});

// --------------------------------------------------------- book_meeting --

const member = (id: string, name: string): Attendee => ({ kind: "team", id, name, email: null, phone: null });
const theTeam = new Map([member("u-rabah", "Rabah"), member("u-omar", "Omar"), member("u-sara", "Sara Test")].map((a) => [a.id!, a]));

test("book_meeting: with the team it's booked; with a client it waits for an OK, and nothing is booked", async () => {
  const booked: MeetingAsk[] = [];
  const cap = bookMeetingCapability({
    team: theTeam,
    book: async (x) => (booked.push(x), { status: "done", said: "Booked: call with Rabah, Sunday 25-10-2026 at 4:00 PM (Cairo time)." }),
  });
  const team = await runAgent({
    request: "book a call with Rabah Sunday at 4",
    from: "Sameh (admin)",
    context: "{}",
    actor: { id: "u1", name: "Sameh", role: "admin" },
    capabilities: [cap],
    model: script([use("t1", "book_meeting", { with: ["u-rabah"], date: "2026-10-25", time: "16:00" })], [finish("t2", "Booked.")]),
    runKey: "m1",
  });
  assert.equal(booked.length, 1);
  // Booked by their name, as iklipse has it.
  assert.deepEqual(booked[0]!.with, ["Rabah"]);
  assert.deepEqual(team.receipts, ["Booked: call with Rabah, Sunday 25-10-2026 at 4:00 PM (Cairo time)."]);

  const client = await runAgent({
    request: "book a call with Abbas Hamdy Sunday at 4",
    from: "Sameh (admin)",
    context: "{}",
    actor: { id: "u1", name: "Sameh", role: "admin" },
    capabilities: [cap],
    model: script([use("t1", "book_meeting", { with: ["Abbas Hamdy"], date: "2026-10-25", time: "16:00" })], [finish("t2", "I'd book it once you OK it.")]),
    runKey: "m2",
  });
  assert.equal(booked.length, 1);
  assert.deepEqual(client.receipts, ["Needs an OK first, not done: book a call with Abbas Hamdy on 2026-10-25 at 16:00."]);
  assert.equal(client.steps[0]!.outcome, "needs_ok");
});

test("book_meeting: someone on the team only by their id; a name (\"Sara\", a client's too) needs the OK", () => {
  const cap = bookMeetingCapability({ team: theTeam, book: async () => ({ status: "done", said: null }) });
  const ask = (w: string[]) => cap.validate({ with: w, date: "2026-10-25", time: "16:00" }) as Exclude<ReturnType<typeof cap.validate>, string>;
  const needsOk = (w: string[]) => (cap.confirm as (x: ReturnType<typeof ask>) => boolean)(ask(w));
  // A first name, or even a team member's full name: it could be a client of the same name.
  assert.equal(needsOk(["Sara"]), true);
  assert.equal(needsOk(["Sara Test"]), true);
  assert.equal(needsOk(["u-rabah", "Sara"]), true);
  // By id (as find gives it, or a ref): the team, no OK; booked by their names.
  assert.equal(needsOk(["u-sara"]), false);
  assert.equal(needsOk(["t:u-sara", "u-omar"]), false);
  assert.deepEqual(ask(["t:u-sara", "u-omar"]).with, ["Sara Test", "Omar"]);
  assert.match(String((cap.input_schema.properties as Record<string, { description: string }>).with.description), /someone on the team by their profile\.id/);
});

test("book_meeting: a guest by their id isn't the team: the OK first, booked by their name", () => {
  const gina: Attendee = { kind: "guest", id: "u-gina", name: "Gina Guest", email: null, phone: null };
  const cap = bookMeetingCapability({ team: new Map([...theTeam, [gina.id!, gina]]), book: async () => ({ status: "done", said: null }) });
  const ask = (w: string[]) => cap.validate({ with: w, date: "2026-10-25", time: "16:00" }) as Exclude<ReturnType<typeof cap.validate>, string>;
  assert.equal((cap.confirm as (x: ReturnType<typeof ask>) => boolean)(ask(["u-gina"])), true);
  assert.equal((cap.confirm as (x: ReturnType<typeof ask>) => boolean)(ask(["u-rabah", "t:u-gina"])), true);
  assert.deepEqual(ask(["u-rabah", "t:u-gina"]).with, ["Rabah", "Gina Guest"]);
  assert.equal((cap.confirm as (x: ReturnType<typeof ask>) => boolean)(ask(["u-rabah"])), false);
});

// ------------------------------------------------------- message_client --

const abbas: Attendee = { kind: "client", id: "c-abbas", name: "Abbas Hamdy", email: null, phone: "15550005001" };

test("message_client: never sent on Claude's word; what it would send is kept for the team", async () => {
  let sent = 0;
  const cap = messageClientCapability({ clients: new Map([[abbas.id!, abbas]]), send: async () => (sent++, {}) });
  assert.equal(cap.validate({ client: "Someone Else", text: "hi" }), "No client in iklipse has that id or name: find them in client first.");
  const r = await runAgent({
    request: "tell Abbas the video is ready",
    from: "Sameh (admin)",
    context: "{}",
    actor: { id: "u1", name: "Sameh", role: "admin" },
    capabilities: [cap],
    model: script([use("t1", "message_client", { client: "abbas hamdy", text: "Hi Abbas — the video is ready." })], [finish("t2", "Drafted it for your OK.")]),
    runKey: "m3",
  });
  assert.equal(sent, 0);
  assert.equal(r.steps[0]!.outcome, "needs_ok");
  assert.equal((r.steps[0]!.keep as { text: string }).text, "Hi Abbas, the video is ready.");
  assert.deepEqual(r.receipts, ['Needs an OK first, not done: write to Abbas Hamdy: "Hi Abbas, the video is ready.".']);
});

// --------------------------------------------- a client's stuck chat --

test("the agent helps with clients' stuck chats only when it's on for everyone", () => {
  assert.equal(agentForClients("on"), true);
  assert.equal(agentForClients("admins"), false);
  assert.equal(agentForClients(""), false);
});

test("a stuck chat looked into: what it found and the reply it'd send go to the team; it reads as a member plus this chat, never email", async () => {
  const asked: Record<string, unknown>[] = [];
  const f = fakeDb({}, { rpc: { bot_search: (a) => (asked.push(a), [{ id: 1, source: "wa_message", source_id: "w1", part: 0, at: "2026-10-22T10:00:00Z", chat_id: "hamdy@g.us", account_id: null, meeting_id: null, place: "Hamdy Motors | iklipse", who: "Rabah", text: "The ad goes live Sunday", score: 1 }]) } });
  const looked = await lookIntoIt(
    f.db,
    {} as Settings,
    { runKey: "d9", chatId: "15550005001@c.us", client: abbas, label: "Abbas Hamdy (Hamdy Motors)", known: ["A client of iklipse."], chat: ["THEM: When does the ad go live?"], stuck: "He asks when the ad goes live." },
    script(
      [use("t1", "search", { text: "ad goes live" })],
      [use("t2", "message_client", { client: "c-abbas", text: "It goes live Sunday." })],
      [finish("t3", "Rabah said in the group the ad goes live Sunday.")],
    ),
  );
  assert.equal(looked.draft, "It goes live Sunday.");
  assert.equal(looked.found, "Rabah said in the group the ad goes live Sunday.");
  assert.deepEqual(asked[0]!.p_scope, { admin: false, dms: ["15550005001@c.us"], mail: [], ff_accounts: [], ff_meetings: [] });
});
