// "Remind me at ..." (reminders.ts): the time worked out from what was said
// (Claude only says what was said: a day, a time, am/pm, minutes), working
// hours for someone else's, the words back, sending once, and the whole way
// through a team member's message (orders.ts takeOrder, Claude stubbed).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { cancelReminders, listText, nextWorkTime, offAt, resolveWhen, sendReminders, setReminder, type Reminder } from "./reminders.ts";
import { takeOrder } from "./orders.ts";
import { clockIn } from "./zones.ts";
import { TZ, type Person, type Settings, type Team } from "./kit.ts";
import type { Attendee } from "./meetings.ts";

const cairo = clockIn(TZ);
const at = (d: string, t: string) => cairo.at(d, t);
/** Thursday 22 Oct 2026, 3 PM in Cairo. */
const NOW = at("2026-10-22", "15:00");
const MIN = 60_000;
const atOf = (r: ReturnType<typeof resolveWhen>) => ("at" in r ? r.at : r.ask);

// ----------------------------------------------------------- the time --

test('English: "remind me at 8" at 3 PM is 8 tonight; at 7 AM it\'s 8 this morning', () => {
  assert.equal(atOf(resolveWhen({ time: "08:00" }, TZ, NOW)), at("2026-10-22", "20:00"));
  assert.equal(atOf(resolveWhen({ time: "8" }, TZ, at("2026-10-22", "07:00"))), at("2026-10-22", "08:00"));
});

test('Egyptian Arabic: "فكرني الساعة 5" is the next 5 o\'clock that makes sense; "5 الفجر" is 5 AM', () => {
  assert.equal(atOf(resolveWhen({ time: "05:00" }, TZ, NOW)), at("2026-10-22", "17:00"));
  assert.equal(atOf(resolveWhen({ time: "05:00" }, TZ, at("2026-10-22", "18:00"))), at("2026-10-23", "17:00"));
  assert.equal(atOf(resolveWhen({ time: "05:00", ampm: "am" }, TZ, NOW)), at("2026-10-23", "05:00"));
  // "فكرني بكرة 10 الصبح أكلم عباس"
  assert.equal(atOf(resolveWhen({ date: "2026-10-23", time: "10:00", ampm: "am" }, TZ, NOW)), at("2026-10-23", "10:00"));
  // "الساعة 9 بالليل"
  assert.equal(atOf(resolveWhen({ time: "09:00", ampm: "pm" }, TZ, NOW)), at("2026-10-22", "21:00"));
});

test('Franco and after a while: "fakarny ba3d sa3a", "remind me in 30 minutes"', () => {
  assert.equal(atOf(resolveWhen({ in_minutes: 60 }, TZ, NOW)), NOW + 60 * MIN);
  assert.equal(atOf(resolveWhen({ in_minutes: 30 }, TZ, NOW + 20_000)), NOW + 31 * MIN);
});

test("24-hour times, and 12 with no AM or PM is noon", () => {
  assert.equal(atOf(resolveWhen({ time: "17:30" }, TZ, NOW)), at("2026-10-22", "17:30"));
  assert.equal(atOf(resolveWhen({ time: "12:00" }, TZ, NOW)), at("2026-10-23", "12:00"));
});

test("a time that's gone, or none at all: one question back, never a guess", () => {
  assert.match(atOf(resolveWhen({ date: "2026-10-22", time: "09:00", ampm: "am" }, TZ, NOW)) as string, /already gone/);
  assert.equal(atOf(resolveWhen({}, TZ, NOW)), "When should I remind you?");
  assert.equal(atOf(resolveWhen({ in_minutes: 0 }, TZ, NOW)), "When should I remind you?");
  assert.equal(atOf(resolveWhen({ date: "2026-10-25" }, TZ, NOW)), "What time on Sunday?");
  assert.match(atOf(resolveWhen({ time: "25:00" }, TZ, NOW)) as string, /What time/);
});

test("in their own time zone", () => {
  const dubai = clockIn("Asia/Dubai");
  assert.equal(atOf(resolveWhen({ time: "08:00", ampm: "pm" }, "Asia/Dubai", NOW)), dubai.at("2026-10-22", "20:00"));
});

// ------------------------------------------------------- working hours --

/** Work is 10 AM to 6 PM, Friday and Saturday off. */
const hours = { quiet_from: "18:00", quiet_to: "10:00", off_days: [5, 6], off_dates: [] as string[] };

test("working hours: outside them, someone else's waits for work to start", () => {
  assert.equal(offAt(hours, NOW), false);
  assert.equal(nextWorkTime(hours, NOW), NOW);
  // Thursday night: Friday and Saturday are off, so Sunday 10 AM.
  assert.equal(nextWorkTime(hours, at("2026-10-22", "21:00")), at("2026-10-25", "10:00"));
  // Early Thursday: 10 AM the same day.
  assert.equal(nextWorkTime(hours, at("2026-10-22", "07:30")), at("2026-10-22", "10:00"));
  assert.equal(nextWorkTime({ ...hours, quiet_from: null, quiet_to: null }, at("2026-10-24", "15:00")), at("2026-10-25", "00:00"));
});

// ----------------------------------------------------- set, list, cancel --

const sameh: Attendee = { kind: "team", id: "u-sameh", name: "Sameh Ali", email: null, phone: "15555550102", zone: TZ };
const rabah: Attendee = { kind: "team", id: "u-rabah", name: "Rabah", email: null, phone: "15555550101", zone: TZ };
const s = { ...hours, model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const by = { id: sameh.id!, name: "Sameh", zone: TZ };

test("yours: at the time you said, even at night, and said back with the day and time", async () => {
  const f = fakeDb({ bot_reminder: [] });
  const r = await setReminder(f.db, s, { by, who: sameh, text: "send the invoice.", when: { time: "08:00", ampm: "pm" }, sourceId: "m1", chatId: "team@g.us", now: NOW });
  assert.equal(r.text, "OK, I'll remind you today at 8:00 PM: send the invoice.");
  const row = f.tables.bot_reminder[0]!;
  assert.equal(row.due_at, new Date(at("2026-10-22", "20:00")).toISOString());
  assert.equal(row.for_user, "u-sameh");
  assert.equal(row.any_time, true);
});

test("someone else's: in working hours, and it says so", async () => {
  const f = fakeDb({ bot_reminder: [] });
  const r = await setReminder(f.db, s, { by, who: rabah, text: "send the files", when: { time: "09:00", ampm: "pm" }, sourceId: "m2", chatId: "team@g.us", now: NOW });
  assert.equal(r.text, "OK, I'll remind Rabah Sunday at 10:00 AM, when work starts: send the files.");
  // "Even if it's late": at the time said.
  const late = await setReminder(f.db, s, { by, who: rabah, text: "call me", when: { time: "09:00", ampm: "pm" }, anyTime: true, sourceId: "m3", chatId: "team@g.us", now: NOW });
  assert.equal(late.text, "OK, I'll remind Rabah today at 9:00 PM: call me.");
});

test("what can't be done is said: no number, a time that's gone, the same message twice", async () => {
  const f = fakeDb({ bot_reminder: [] });
  const r = await setReminder(f.db, s, { by, who: { ...rabah, phone: null }, text: "x", when: { time: "16:00" }, sourceId: "m4", chatId: null, now: NOW });
  assert.match(r.text, /I don't have Rabah's WhatsApp number/);
  const gone = await setReminder(f.db, s, { by, who: sameh, text: "x", when: { date: "2026-10-22", time: "09:00", ampm: "am" }, sourceId: "m5", chatId: null, now: NOW });
  assert.match(gone.text, /already gone/);
  assert.equal(f.tables.bot_reminder.length, 0);
  const twice = fakeDb({ bot_reminder: [] }, { fail: (c) => (c.table === "bot_reminder" && c.op === "insert" ? { message: "duplicate key", code: "23505" } : null) });
  const again = await setReminder(twice.db, s, { by, who: sameh, text: "x", when: { in_minutes: 10 }, sourceId: "m1", chatId: null, now: NOW });
  assert.equal(again.text, "That reminder's already set.");
});

test("my reminders, and cancelling one", async () => {
  const list: Reminder[] = [
    { id: "a", for_user: "u-sameh", set_by: "u-sameh", chat_id: null, text: "send the invoice", due_at: new Date(at("2026-10-22", "20:00")).toISOString(), tz: TZ, status: "open" },
    { id: "b", for_user: "u-rabah", set_by: "u-sameh", chat_id: null, text: "send the files", due_at: new Date(at("2026-10-25", "10:00")).toISOString(), tz: TZ, status: "open" },
  ];
  assert.equal(listText(list, by, (id) => (id === "u-rabah" ? "Rabah Omar" : "Sameh"), NOW), "Your reminders:\n1. Today at 8:00 PM: send the invoice\n2. Rabah, Sunday at 10:00 AM: send the files");
  assert.equal(listText([], by, () => "", NOW), "No reminders set.");
  const f = fakeDb({ bot_reminder: list.map((x) => ({ ...x })) });
  assert.equal(await cancelReminders(f.db, list, ["r1"], by, NOW), "Cancelled: today at 8:00 PM (send the invoice).");
  assert.equal(f.tables.bot_reminder[0]!.status, "cancelled");
  assert.equal(f.tables.bot_reminder[1]!.status, "open");
  assert.equal(await cancelReminders(f.db, list, ["r1"], by, NOW), "Already gone.");
});

// ------------------------------------------------------------- sending --

test("sending: privately, in the right words, and two runs at once send each one once", async () => {
  const due = new Date(Date.now() - MIN).toISOString();
  const f = fakeDb(
    {
      bot_reminder: [
        { id: "a", for_user: "u-sameh", set_by: "u-sameh", text: "send the invoice", due_at: due, status: "open" },
        { id: "b", for_user: "u-rabah", set_by: "u-sameh", text: "send the files", due_at: due, status: "open" },
        { id: "c", for_user: "u-rabah", set_by: "u-sameh", text: "later", due_at: new Date(Date.now() + 60 * MIN).toISOString(), status: "open" },
      ],
    },
    {
      // As the database does it: the open, due ones, claimed by whoever asks first.
      rpc: {
        _bot_reminders_due: (_a, t) =>
          t.bot_reminder!.filter((r) => r.status === "open" && String(r.due_at) <= new Date().toISOString()).map((r) => Object.assign(r, { status: "sending" })),
      },
    },
  );
  const sent: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (sent.push({ chat, text }), `wamid-${sent.length}`);
  const people = new Map([
    ["u-sameh", sameh],
    ["u-rabah", rabah],
  ]);
  const [one, two] = await Promise.all([sendReminders(f.db, send, people, Date.now() + 60_000), sendReminders(f.db, send, people, Date.now() + 60_000)]);
  assert.equal(one + two, 2);
  assert.deepEqual(sent.sort((x, y) => x.chat.localeCompare(y.chat)), [
    { chat: "15555550101@c.us", text: "Hi Rabah, a reminder from Sameh: send the files." },
    { chat: "15555550102@c.us", text: "Reminder: send the invoice." },
  ]);
  assert.deepEqual(f.tables.bot_reminder.map((r) => r.status), ["sent", "sent", "open"]);
});

// ------------------------------------------------------ the whole way --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude, deciding what each message is: the act tool's input, in turn. */
function claudeSays(...acts: Record<string, unknown>[]) {
  const asked: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push(String(b.messages[0].content));
    const act = acts.shift();
    if (!act) throw new Error("Claude was asked once too often");
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
const me: Person = { id: "u-sameh", name: "Sameh", username: "sameh", active: true, admin: false };
const team: Team = { people: new Map([[me.id, me]]), byPhone: new Map([["15555550102", me]]), byLid: new Map(), others: new Set() };
const world = () =>
  fakeDb({
    profile: [
      { id: "u-sameh", display_name: "Sameh", role: "member", is_active: true },
      { id: "u-rabah", display_name: "Rabah", role: "member", is_active: true },
    ],
    profile_contact: [
      { user_id: "u-sameh", whatsapp: "15555550102" },
      { user_id: "u-rabah", whatsapp: "15555550101" },
    ],
    bot_reminder: [],
  });
const message = { id: "m-9", chatId: "team@g.us", where: "team" as const, text: "@iklipse فكرني بعد نص ساعة أكلم عباس", quoted: null, phone: "15555550102", lid: null, name: "Sameh" };

test("the whole way: an Egyptian Arabic message in the team group sets it, once, even sent twice", async () => {
  const f = world();
  const wa: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (wa.push({ chat, text }), `wamid-${wa.length}`);
  claudeSays({ action: "remind", remind: { op: "set", who: "me", text: "call Abbas", in_minutes: 30 } });
  await takeOrder(f.db, s, team, send, message, async () => {});
  assert.equal(f.tables.bot_reminder.length, 1);
  assert.match(wa[0]!.text, /^OK, I'll remind you (today|tomorrow) at \d{1,2}:\d{2} (AM|PM): call Abbas\.$/);
  // WhatsApp sends the same message again: nothing more (Claude isn't asked again).
  await takeOrder(f.db, s, team, send, message, async () => {});
  assert.equal(f.tables.bot_reminder.length, 1);
  assert.equal(wa.length, 1);
});

test("the whole way: Claude sees their reminders, and lists or cancels them", async () => {
  const f = world();
  f.tables.bot_reminder!.push({ id: "x", for_user: "u-sameh", set_by: "u-sameh", text: "send the invoice", due_at: new Date(Date.now() + 2 * 60 * MIN).toISOString(), tz: TZ, status: "open" });
  const wa: string[] = [];
  const send = async (_c: string, text: string) => (wa.push(text), "w");
  const asked = claudeSays({ action: "remind", remind: { op: "list" } }, { action: "remind", remind: { op: "cancel", cancel: ["r1"] } });
  await takeOrder(f.db, s, team, send, { ...message, id: "m-10", text: "@iklipse ايه التذكيرات" }, async () => {});
  assert.match(asked[0]!, /"your_reminders":\[\{"id":"r1","for":"you","at":"[^"]+","text":"send the invoice"\}\]/);
  assert.match(wa[0]!, /^Your reminders:\n1\. (Today|Tomorrow) at .*: send the invoice$/);
  await takeOrder(f.db, s, team, send, { ...message, id: "m-11", text: "@iklipse شيل التذكير" }, async () => {});
  assert.match(wa[1]!, /^Cancelled: /);
  assert.equal(f.tables.bot_reminder[0]!.status, "cancelled");
});

test("an order to yourself isn't kept: a reminder is offered instead", async () => {
  const f = world();
  f.tables.bot_order = [];
  const wa: string[] = [];
  claudeSays({ action: "orders", orders: [{ kind: "tell", to: "t:u-sameh", task: "check the files", message: "Hi Sameh, check the files.", nudge: "Sameh, a reminder.", wait: true }] });
  await takeOrder(f.db, s, team, async (_c, t) => (wa.push(t), "w"), { ...message, id: "m-12", text: "@iklipse remind me to check the files" }, async () => {});
  assert.equal(f.tables.bot_order.length, 0);
  assert.equal(wa[0], "That's you. Want a reminder instead? Tell me when.");
});
