// Free times from the calendar inside Calendly, checked against what Calendly
// takes (book.ts freeFrom, timesText; blocked.ts whyNot), with Calendly's API
// stubbed: free on both is offered and booked, busy on the calendar isn't
// offered, and free on the calendar but refused by Calendly says why.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { blockedLine, whyNot, type Seen } from "./blocked.ts";
import { freeFrom, timesText } from "./book.ts";
import { clockIn } from "./zones.ts";
import { TZ } from "./kit.ts";
import type { EventType, Hours } from "../_shared/calendly.ts";

const cairo = clockIn(TZ);
const MIN = 60_000;
const at = (d: string, t: string) => cairo.at(d, t);
/** Thursday 22 Oct 2026, 3 PM in Cairo. */
const NOW = at("2026-10-22", "15:00");
const hours = (rules: Hours["rules"]): Hours => ({ zone: TZ, rules });
const thursday = (from: string, to: string) => ({ type: "wday", wday: "thursday", intervals: [{ from, to }] });
const seen = (o: Partial<Seen>): Seen => ({ span: 30 * MIN, hours: null, busy: [], offered: [at("2026-10-22", "16:00")], readUntil: at("2026-11-13", "00:00"), now: NOW, ...o });

// ---------------------------------------------------------------- why --

test("Calendly's hours for the meeting: end, start, a day it doesn't take, a date blocked, two spans", () => {
  assert.equal(whyNot(at("2026-10-22", "21:00"), seen({ hours: hours([thursday("10:00", "21:00")]) }), cairo), "this meeting's hours end at 9:00 PM");
  assert.equal(whyNot(at("2026-10-22", "20:45"), seen({ hours: hours([thursday("10:00", "21:00")]) }), cairo), "this meeting's hours end at 9:00 PM");
  assert.equal(whyNot(at("2026-10-22", "12:00"), seen({ hours: hours([thursday("14:00", "21:00")]) }), cairo), "this meeting's hours start at 2:00 PM");
  assert.equal(whyNot(at("2026-10-23", "16:00"), seen({ hours: hours([{ type: "wday", wday: "friday", intervals: [] }]) }), cairo), "it doesn't take this meeting on Fridays");
  assert.equal(
    whyNot(at("2026-10-22", "16:00"), seen({ hours: hours([thursday("10:00", "21:00"), { type: "date", date: "2026-10-22", intervals: [] }]) }), cairo),
    "it's blocked that day for this meeting",
  );
  assert.equal(
    whyNot(at("2026-10-22", "14:30"), seen({ hours: hours([{ type: "wday", wday: "thursday", intervals: [{ from: "12:00", to: "14:00" }, { from: "16:00", to: "21:00" }] }]) }), cairo),
    "it only takes this meeting 12:00 PM to 2:00 PM and 4:00 PM to 9:00 PM",
  );
});

test("a buffer around one of Calendly's meetings", () => {
  const call = { start: at("2026-10-22", "19:00"), end: at("2026-10-22", "19:30"), kind: "calendly", bufferedStart: at("2026-10-22", "18:50"), bufferedEnd: at("2026-10-22", "19:45") };
  assert.equal(whyNot(at("2026-10-22", "19:30"), seen({ busy: [call] }), cairo), "there's a 15-min buffer after your 7:00 PM call");
  assert.equal(whyNot(at("2026-10-22", "18:30"), seen({ busy: [call] }), cairo), "there's a 10-min buffer before your 7:00 PM call");
});

test("seen in what Calendly offers: notice, how far ahead, a full day", () => {
  assert.equal(whyNot(at("2026-10-22", "15:30"), seen({ offered: [at("2026-10-22", "19:00")] }), cairo), "it needs more notice (the earliest it takes is today at 7:00 PM)");
  assert.equal(whyNot(at("2026-11-05", "15:00"), seen({ offered: [at("2026-10-23", "15:00"), at("2026-11-01", "15:00")] }), cairo), "it only books up to Sunday 01-11-2026");
  const booked = [1, 2, 3].map((h) => ({ start: at("2026-10-24", `1${h}:00`), end: at("2026-10-24", `1${h}:30`), kind: "calendly" }));
  assert.equal(whyNot(at("2026-10-24", "18:00"), seen({ offered: [at("2026-10-23", "15:00"), at("2026-10-25", "15:00")], busy: booked }), cairo), "the day's limit looks reached (3 meetings that day)");
  assert.equal(whyNot(at("2026-10-24", "18:00"), seen({ offered: [at("2026-10-23", "15:00"), at("2026-10-25", "15:00")] }), cairo), null);
});

test("the line they hear", () => {
  assert.equal(blockedLine(at("2026-10-22", "22:00"), "this meeting's hours end at 9:00 PM", cairo), "10:00 PM is free on your calendar, but Calendly won't book it: this meeting's hours end at 9:00 PM.");
  assert.equal(blockedLine(at("2026-10-22", "22:00"), null, cairo), "10:00 PM is free on your calendar, but Calendly won't take it and doesn't say why.");
});

// ------------------------------------------- the free times, the whole way --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A day three days from now, on Cairo's clock, and its weekday. */
const day = cairo.dayOf(Date.now() + 3 * 24 * 60 * MIN);
const wday = cairo.weekday(cairo.noon(day)).toLowerCase();
const et: EventType = { uri: "https://api.calendly.com/event_types/ET", name: "Call", active: true, duration: 30, kind: "solo", pooling_type: null, scheduling_url: "https://calendly.com/x/call", locations: null, custom_questions: [] };

/** Calendly: busy 5 to 6 PM on the calendar; the meeting's hours noon to 9 PM, and it offers every half hour in them. */
function calendly(o: { openTimes?: "fail" } = {}) {
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname === "/user_busy_times") {
      return ok({ collection: [{ type: "external", start_time: new Date(at(day, "17:00")).toISOString(), end_time: new Date(at(day, "18:00")).toISOString() }] });
    }
    if (u.pathname === "/event_type_availability_schedules") {
      return ok({ collection: [{ availability_rule: { timezone: TZ, rules: [{ type: "wday", wday, intervals: [{ from: "12:00", to: "21:00" }] }] } }] });
    }
    if (u.pathname === "/event_type_available_times") {
      if (o.openTimes === "fail") return new Response(JSON.stringify({ message: "Permission denied" }), { status: 403 });
      const [from, to] = [Date.parse(u.searchParams.get("start_time")!), Date.parse(u.searchParams.get("end_time")!)];
      const slots = [];
      for (let t = at(day, "12:00"); t + 30 * MIN <= at(day, "21:00"); t += 30 * MIN) {
        const busy = t < at(day, "18:00") && t + 30 * MIN > at(day, "17:00");
        if (!busy && t >= from && t <= to) slots.push({ status: "available", start_time: new Date(t).toISOString(), invitees_remaining: 1, scheduling_url: "x" });
      }
      return ok({ collection: slots });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

test("free on the calendar and on Calendly: offered and taken; busy on the calendar: not offered", async () => {
  calendly();
  const free = await freeFrom("tok", "https://api.calendly.com/users/U", et, day);
  assert.equal(free.open(at(day, "15:00")), true);
  assert.equal(free.open(at(day, "17:00")), false);
  assert.equal(free.blocked(at(day, "17:00")), false);
  const times = free(day);
  assert.ok(times.includes(at(day, "15:00")));
  assert.ok(!times.includes(at(day, "17:00")));
  assert.ok(!times.includes(at(day, "21:00")));
});

test("free on the calendar but past Calendly's hours: not offered, and asked for, the reason", async () => {
  calendly();
  const free = await freeFrom("tok", "https://api.calendly.com/users/U", et, day);
  const late = at(day, "22:00");
  assert.equal(free.open(late), false);
  assert.equal(free.blocked(late), true);
  const r = timesText(free, { days: [day], search: "", minutes: 30, taken: late, asked: late }, cairo);
  const lines = r.text.split("\n");
  assert.equal(lines[0], "10:00 PM is free on your calendar, but Calendly won't book it: this meeting's hours end at 9:00 PM.");
  assert.match(lines[1]!, /^Free on /);
  // A client asking hears only that it isn't free.
  assert.equal(timesText(free, { days: [day], search: "", minutes: 30, taken: late, explain: false }, cairo).text.split("\n")[0], "10:00 PM isn't free.");
});

test("Calendly's open times can't be read: the calendar alone, as before", async () => {
  calendly({ openTimes: "fail" });
  const free = await freeFrom("tok", "https://api.calendly.com/users/U", et, day);
  assert.equal(free.open(at(day, "22:00")), true);
  assert.equal(free.blocked(at(day, "22:00")), false);
});
