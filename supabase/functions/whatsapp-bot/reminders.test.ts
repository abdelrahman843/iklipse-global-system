// "Remind me at ..." (reminders.ts): the time worked out from what was said
// (Claude only says what was said: a day, a time, am/pm, minutes), working
// hours for someone else's, the words back, sending once, and the whole way
// through a team member's message (orders.ts takeOrder, Claude stubbed).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { cancelReminders, listText, localAt, nextWorkTime, offAt, resolveWhen, sendReminders, setReminder, type Reminder } from "./reminders.ts";
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

test('Egyptian Arabic: "فكرني الساعة 5" is the next time 5 o\'clock comes; "5 الفجر" is 5 AM', () => {
  assert.equal(atOf(resolveWhen({ time: "05:00" }, TZ, NOW)), at("2026-10-22", "17:00"));
  assert.equal(atOf(resolveWhen({ time: "05:00" }, TZ, at("2026-10-22", "18:00"))), at("2026-10-23", "05:00"));
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

test("24-hour times, and 12 with no AM or PM is the next noon or midnight", () => {
  assert.equal(atOf(resolveWhen({ time: "17:30" }, TZ, NOW)), at("2026-10-22", "17:30"));
  assert.equal(atOf(resolveWhen({ time: "12:00" }, TZ, NOW)), at("2026-10-23", "00:00"));
  assert.equal(atOf(resolveWhen({ time: "12:00" }, TZ, at("2026-10-22", "09:00"))), at("2026-10-22", "12:00"));
});

test('no AM or PM: the next time that hour comes, for every hour ("remind me at 10" at 11 AM is 10 PM tonight)', () => {
  const each = (now: number, want: string[]) =>
    want.forEach((w, h) => {
      const [d, t] = w.split(" ") as [string, string];
      assert.equal(atOf(resolveWhen({ time: `${String(h).padStart(2, "0")}:00` }, TZ, now)), at(d, t), `${h} o'clock`);
    });
  // At 11 AM: 1 to 11 this afternoon or tonight, 12 noon today; 0 midnight; 13 to 23 as said.
  each(at("2026-10-22", "11:00"), [
    "2026-10-23 00:00", "2026-10-22 13:00", "2026-10-22 14:00", "2026-10-22 15:00", "2026-10-22 16:00", "2026-10-22 17:00",
    "2026-10-22 18:00", "2026-10-22 19:00", "2026-10-22 20:00", "2026-10-22 21:00", "2026-10-22 22:00", "2026-10-22 23:00",
    "2026-10-22 12:00", "2026-10-22 13:00", "2026-10-22 14:00", "2026-10-22 15:00", "2026-10-22 16:00", "2026-10-22 17:00",
    "2026-10-22 18:00", "2026-10-22 19:00", "2026-10-22 20:00", "2026-10-22 21:00", "2026-10-22 22:00", "2026-10-22 23:00",
  ]);
  // At 11 PM: 1 to 11 tomorrow morning, 12 midnight; 13 to 23 tomorrow.
  each(at("2026-10-22", "23:00"), [
    "2026-10-23 00:00", "2026-10-23 01:00", "2026-10-23 02:00", "2026-10-23 03:00", "2026-10-23 04:00", "2026-10-23 05:00",
    "2026-10-23 06:00", "2026-10-23 07:00", "2026-10-23 08:00", "2026-10-23 09:00", "2026-10-23 10:00", "2026-10-23 11:00",
    "2026-10-23 00:00", "2026-10-23 13:00", "2026-10-23 14:00", "2026-10-23 15:00", "2026-10-23 16:00", "2026-10-23 17:00",
    "2026-10-23 18:00", "2026-10-23 19:00", "2026-10-23 20:00", "2026-10-23 21:00", "2026-10-23 22:00", "2026-10-23 23:00",
  ]);
  // At 7 AM: 1 to 6 this afternoon, 7 tonight, 8 to 11 this morning, 12 noon.
  each(at("2026-10-22", "07:00"), [
    "2026-10-23 00:00", "2026-10-22 13:00", "2026-10-22 14:00", "2026-10-22 15:00", "2026-10-22 16:00", "2026-10-22 17:00",
    "2026-10-22 18:00", "2026-10-22 19:00", "2026-10-22 08:00", "2026-10-22 09:00", "2026-10-22 10:00", "2026-10-22 11:00",
    "2026-10-22 12:00",
  ]);
  // "Today at 10" at 11 AM is tonight too; on a later day said, the sensible half ("tomorrow at 5" is 5 PM).
  assert.equal(atOf(resolveWhen({ date: "2026-10-22", time: "10" }, TZ, at("2026-10-22", "11:00"))), at("2026-10-22", "22:00"));
  assert.equal(atOf(resolveWhen({ date: "2026-10-23", time: "05:00" }, TZ, at("2026-10-22", "11:00"))), at("2026-10-23", "17:00"));
  assert.equal(atOf(resolveWhen({ date: "2026-10-23", time: "10:00" }, TZ, at("2026-10-22", "11:00"))), at("2026-10-23", "10:00"));
});

test("DST: a time on the day the clocks change has that moment's offset (New York, 14 Mar 2027)", () => {
  const ny = "America/New_York";
  const day = Date.parse("2027-03-13T12:00:00-05:00");
  // 1 AM is still EST, 9 AM is EDT; 2:30 AM never comes that day: 3:30 AM EDT.
  assert.equal(atOf(resolveWhen({ date: "2027-03-14", time: "01:00", ampm: "am" }, ny, day)), Date.parse("2027-03-14T01:00:00-05:00"));
  assert.equal(atOf(resolveWhen({ date: "2027-03-14", time: "09:00", ampm: "am" }, ny, day)), Date.parse("2027-03-14T09:00:00-04:00"));
  assert.equal(atOf(resolveWhen({ date: "2027-03-14", time: "02:30", ampm: "am" }, ny, day)), Date.parse("2027-03-14T03:30:00-04:00"));
  // The night before, "at 8" is 8 AM on the 14th (that day is 23 hours long).
  assert.equal(atOf(resolveWhen({ time: "08:00" }, ny, Date.parse("2027-03-13T23:30:00-05:00"))), Date.parse("2027-03-14T08:00:00-04:00"));
  // When the clocks go back (7 Nov 2027), 1:30 AM comes twice: the first.
  assert.equal(atOf(resolveWhen({ date: "2027-11-07", time: "01:30", ampm: "am" }, ny, day)), Date.parse("2027-11-07T01:30:00-04:00"));
  assert.equal(localAt(ny, "2027-11-07", "09:00"), Date.parse("2027-11-07T09:00:00-05:00"));
  // A day that doesn't exist is still a question back, not an error.
  assert.match(atOf(resolveWhen({ date: "2026-13-01", time: "09:00" }, TZ, NOW)) as string, /already gone/);
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
  // A day off, in the afternoon: when work starts on the next working day.
  assert.equal(nextWorkTime(hours, at("2026-10-23", "15:00")), at("2026-10-25", "10:00"));
});

test("working hours: a day off with no working hours set waits for 8 AM on the next working day, never midnight", () => {
  const any = { ...hours, quiet_from: null, quiet_to: null };
  assert.equal(nextWorkTime(any, at("2026-10-24", "15:00")), at("2026-10-25", "08:00"));
  assert.equal(nextWorkTime(any, at("2026-10-23", "23:30")), at("2026-10-25", "08:00"));
  // The same start and end is no working hours either.
  assert.equal(nextWorkTime({ ...hours, quiet_from: "00:00", quiet_to: "00:00" }, at("2026-10-24", "15:00")), at("2026-10-25", "08:00"));
  // A working day with no working hours set: at the time asked, as before.
  assert.equal(nextWorkTime(any, at("2026-10-22", "03:00")), at("2026-10-22", "03:00"));
});

test("working hours: the day after, on a night the clocks go forward (Cairo, 30 Apr 2027)", () => {
  // Thursday 11:30 PM: Friday is 23 hours long, and it's a working day here.
  assert.equal(nextWorkTime({ ...hours, off_days: [] }, at("2027-04-29", "23:30")), Date.parse("2027-04-30T10:00:00+03:00"));
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
  // On a day off with no working hours set: the next working day at 8 AM, not midnight.
  const any = { ...s, quiet_from: null, quiet_to: null } as Settings;
  const off = await setReminder(f.db, any, { by, who: rabah, text: "send the logo", when: { date: "2026-10-23", time: "03:00", ampm: "pm" }, sourceId: "m3b", chatId: "team@g.us", now: NOW });
  assert.equal(off.text, "OK, I'll remind Rabah Sunday at 8:00 AM, when work starts: send the logo.");
});

test('no AM or PM: "remind me at 10" said at 11 AM is 10 PM tonight, and it says the day and time', async () => {
  const f = fakeDb({ bot_reminder: [] });
  const tonight = await setReminder(f.db, s, { by, who: sameh, text: "call Sara Test", when: { time: "10" }, sourceId: "m-10a", chatId: null, now: at("2026-10-22", "11:00") });
  assert.equal(tonight.text, "OK, I'll remind you today at 10:00 PM: call Sara Test.");
  const morning = await setReminder(f.db, s, { by, who: sameh, text: "call Sara Test", when: { time: "10" }, sourceId: "m-10b", chatId: null, now: at("2026-10-22", "23:00") });
  assert.equal(morning.text, "OK, I'll remind you tomorrow at 10:00 AM: call Sara Test.");
});

test("DST: the confirmation says the day and time it'll really go at", async () => {
  const f = fakeDb({ bot_reminder: [] });
  const ny = { ...by, zone: "America/New_York" };
  const r = await setReminder(f.db, s, { by: ny, who: sameh, text: "call the bank", when: { date: "2027-03-14", time: "01:00", ampm: "am" }, sourceId: "m-dst", chatId: null, now: Date.parse("2027-03-13T12:00:00-05:00") });
  assert.equal(r.text, "OK, I'll remind you tomorrow at 1:00 AM New York time: call the bank.");
  assert.equal(f.tables.bot_reminder[0]!.due_at, "2027-03-14T06:00:00.000Z");
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

/** As 0118 does it: the open, due ones past their next try, claimed. */
const dueNow = {
  _bot_reminders_due: (_a: Record<string, unknown>, t: Record<string, Record<string, unknown>[]>) =>
    t.bot_reminder!.filter((r) => r.status === "open" && String(r.due_at) <= new Date().toISOString() && (!r.retry_at || String(r.retry_at) <= new Date().toISOString())).map((r) =>
      Object.assign(r, { status: "sending" }),
    ),
};

test("sending fails: tried again after 1, 5 and 15 minutes, then whoever set it for someone else hears", async () => {
  const due = new Date(Date.now() - MIN).toISOString();
  const f = fakeDb(
    {
      bot_reminder: [
        { id: "b", for_user: "u-rabah", set_by: "u-sameh", text: "send the files", due_at: due, status: "open", tries: 0 },
        // Rabah's own: there's nobody else to tell.
        { id: "d", for_user: "u-rabah", set_by: "u-rabah", text: "call Sara Test", due_at: due, status: "open", tries: 0 },
      ],
    },
    { rpc: dueNow },
  );
  const sent: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => {
    if (chat === "15555550101@c.us") throw new Error("Green API: 502");
    return (sent.push({ chat, text }), "w");
  };
  const people = new Map([
    ["u-sameh", sameh],
    ["u-rabah", rabah],
  ]);
  const rows = f.tables.bot_reminder;
  for (const [tries, wait] of [[1, 1], [2, 5], [3, 15]] as [number, number][]) {
    const t0 = Date.now();
    assert.equal(await sendReminders(f.db, send, people, Date.now() + 60_000), 0);
    for (const row of rows) {
      assert.equal(row.status, "open");
      assert.equal(row.tries, tries);
      assert.equal(row.error, "Green API: 502");
      const next = Date.parse(String(row.retry_at)) - t0;
      assert.ok(next >= wait * MIN - 1000 && next <= wait * MIN + 5000, `try ${tries}: again in ${wait} minutes`);
    }
    // Not again before then.
    assert.equal(await sendReminders(f.db, send, people, Date.now() + 60_000), 0);
    assert.deepEqual(rows.map((r) => r.tries), [tries, tries]);
    for (const row of rows) row.retry_at = new Date(Date.now() - 1000).toISOString();
  }
  assert.equal(sent.length, 0);
  await sendReminders(f.db, send, people, Date.now() + 60_000);
  assert.deepEqual(rows.map((r) => r.status), ["failed", "failed"]);
  assert.deepEqual(sent, [{ chat: "15555550102@c.us", text: "Sameh, I couldn't send Rabah your reminder: send the files. WhatsApp didn't take it." }]);
});

test("sending fails once: the next try sends it, and nobody's told anything", async () => {
  const due = new Date(Date.now() - MIN).toISOString();
  const f = fakeDb({ bot_reminder: [{ id: "a", for_user: "u-sameh", set_by: "u-sameh", text: "send the invoice", due_at: due, status: "open", tries: 0 }] }, { rpc: dueNow });
  let calls = 0;
  const sent: string[] = [];
  const send = async (_c: string, text: string) => {
    if (++calls === 1) throw new Error("timeout");
    return (sent.push(text), "w");
  };
  const people = new Map([["u-sameh", sameh]]);
  await sendReminders(f.db, send, people, Date.now() + 60_000);
  f.tables.bot_reminder[0]!.retry_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await sendReminders(f.db, send, people, Date.now() + 60_000), 1);
  assert.equal(f.tables.bot_reminder[0]!.status, "sent");
  assert.deepEqual(sent, ["Reminder: send the invoice."]);
});

test("sending: a team that couldn't be read (nobody's number) fails none; the next run sends them", async () => {
  const due = new Date(Date.now() - MIN).toISOString();
  const f = fakeDb({ bot_reminder: [{ id: "b", for_user: "u-rabah", set_by: "u-sameh", text: "send the files", due_at: due, status: "open", tries: 0 }] }, { rpc: dueNow });
  const sent: string[] = [];
  const send = async (_c: string, text: string) => (sent.push(text), "w");
  assert.equal(await sendReminders(f.db, send, new Map(), Date.now() + 60_000), 0);
  assert.equal(await sendReminders(f.db, send, new Map([["u-sameh", { ...sameh, phone: null }]]), Date.now() + 60_000), 0);
  assert.deepEqual([f.tables.bot_reminder[0]!.status, sent], ["open", []]);
  const people = new Map([
    ["u-sameh", sameh],
    ["u-rabah", rabah],
  ]);
  assert.equal(await sendReminders(f.db, send, people, Date.now() + 60_000), 1);
  assert.deepEqual(sent, ["Hi Rabah, a reminder from Sameh: send the files."]);
});

test("sending fails: no number for them, they left the team, or before 0118 runs, it's failed at once and the one who set it hears", async () => {
  const due = new Date(Date.now() - MIN).toISOString();
  const people = new Map([
    ["u-sameh", sameh],
    ["u-rabah", { ...rabah, phone: null }],
    ["u-omar", { ...rabah, id: "u-omar", name: "Omar Test", phone: "15555550103" }],
  ]);
  const sent: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => {
    if (chat === "15555550103@c.us") throw new Error("not on WhatsApp");
    return (sent.push({ chat, text }), "w");
  };
  // No tries or retry_at columns yet: the update that keeps it for later is refused.
  const f = fakeDb(
    {
      bot_reminder: [
        { id: "b", for_user: "u-rabah", set_by: "u-sameh", text: "send the files", due_at: due, status: "open" },
        { id: "c", for_user: "u-omar", set_by: "u-sameh", text: "", due_at: due, status: "open" },
        // Not on the team anymore (the team read has the active ones only).
        { id: "e", for_user: "u-left", set_by: "u-sameh", text: "send the deck", due_at: due, status: "open" },
      ],
    },
    { rpc: dueNow, fail: (c) => (c.op === "update" && "tries" in (c.values as object) ? "Could not find the 'retry_at' column of 'bot_reminder' in the schema cache" : null) },
  );
  await sendReminders(f.db, send, people, Date.now() + 60_000);
  assert.deepEqual(f.tables.bot_reminder.map((r) => r.status), ["failed", "failed", "failed"]);
  assert.deepEqual(sent, [
    { chat: "15555550102@c.us", text: "Sameh, I couldn't send Rabah your reminder: send the files. I don't have their WhatsApp number." },
    { chat: "15555550102@c.us", text: "Sameh, I couldn't send Omar your reminder. WhatsApp didn't take it." },
    { chat: "15555550102@c.us", text: "Sameh, I couldn't send them your reminder: send the deck. They're not on the team anymore." },
  ]);
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
