// Why Calendly won't take a time the calendar has free (book.ts). The free
// times come from the calendar connected inside Calendly; Calendly books, and
// it only takes the times its event type offers. When the two differ, the
// person hears why, in one plain line, from what Calendly shows:
//   - the event type's hours (its availability schedule: weekdays and date
//     overrides) don't cover it;
//   - the buffer Calendly keeps before or after one of its meetings;
// and, since Calendly doesn't expose them, from the times it does offer:
//   - minimum notice (the earliest time it takes is later than this one);
//   - how far ahead it books (it offers nothing after a day);
//   - a daily limit (that day it offers nothing, with meetings already on it);
// else that Calendly won't take it and doesn't say why. Nothing here reads
// Calendly: book.ts gives what it read.

import type { Busy, Hours } from "../_shared/calendly.ts";
import { clockIn, type Clock } from "./zones.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Closer than this, a time before the earliest Calendly offers is put down to notice. */
const NOTICE_SPAN = 3 * DAY;

export interface Seen {
  /** The meeting's length (ms). */
  span: number;
  /** The event type's hours, when Calendly said them. */
  hours: Hours | null;
  /** The busy times, with Calendly's buffers. */
  busy: Busy[];
  /** Every start time Calendly offers, sorted. */
  offered: number[];
  /** How far the offered times were read (ms). */
  readUntil: number;
  now: number;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The day's intervals in the hours' own time zone: a date override first, else its weekday's. */
function intervalsOn(h: Hours, start: number) {
  const c = clockIn(h.zone);
  const day = c.dayOf(start);
  const wday = c.weekday(c.noon(day)).toLowerCase();
  const date = h.rules.find((r) => r.type === "date" && r.date === day);
  const rule = date ?? h.rules.find((r) => r.type === "wday" && r.wday === wday);
  const at = (t: string) => (t === "24:00" ? c.at(c.dayOf(c.noon(day) + DAY), "00:00") : c.at(day, t));
  return { override: !!date, wday, list: (rule?.intervals ?? []).map((x) => ({ from: at(x.from), to: at(x.to) })).filter((x) => x.from < x.to) };
}

/**
 * Why Calendly won't take a start time the calendar has free, said after
 * "Calendly won't book it: ", in the speaker's clock (c); null: it doesn't
 * say why.
 */
export function whyNot(start: number, s: Seen, c: Clock): string | null {
  const end = start + s.span;
  const t12 = (ms: number) => c.time12(ms);

  // Its hours.
  if (s.hours) {
    const d = intervalsOn(s.hours, start);
    if (!d.list.length) return d.override ? "it's blocked that day for this meeting" : `it doesn't take this meeting on ${cap(d.wday)}s`;
    if (!d.list.some((x) => start >= x.from && end <= x.to)) {
      const first = d.list[0]!;
      const last = d.list.at(-1)!;
      if (start < first.from) return `this meeting's hours start at ${t12(first.from)}`;
      if (end > last.to && start >= first.from && d.list.length === 1) return `this meeting's hours end at ${t12(last.to)}`;
      return `it only takes this meeting ${d.list.map((x) => `${t12(x.from)} to ${t12(x.to)}`).join(" and ")}`;
    }
  }

  // A buffer around one of its meetings.
  for (const b of s.busy) {
    if (b.kind !== "calendly") continue;
    if (b.bufferedEnd && start >= b.end && start < b.bufferedEnd) {
      return `there's a ${Math.round((b.bufferedEnd - b.end) / MIN)}-min buffer after your ${t12(b.start)} call`;
    }
    if (b.bufferedStart && end <= b.start && end > b.bufferedStart) {
      return `there's a ${Math.round((b.start - b.bufferedStart) / MIN)}-min buffer before your ${t12(b.start)} call`;
    }
  }

  const first = s.offered[0];
  const last = s.offered.at(-1);
  // Notice: it offers nothing this soon.
  if (first !== undefined && start < first && start - s.now < NOTICE_SPAN) {
    const days = Math.round((c.noon(c.dayOf(first)) - c.noon(c.dayOf(s.now))) / DAY);
    const day = days === 0 ? "today" : days === 1 ? "tomorrow" : c.weekday(first);
    return `it needs more notice (the earliest it takes is ${day} at ${t12(first)})`;
  }
  // How far ahead: it offers nothing after a day well before what was read.
  if (last !== undefined && start > last && c.dayOf(start) !== c.dayOf(last) && s.readUntil - last > 2 * DAY) {
    return `it only books up to ${c.weekday(last)} ${c.dmy(last)}`;
  }
  // A daily limit: nothing offered that day, with its meetings already on it.
  const day = c.dayOf(start);
  if (!s.offered.some((t) => c.dayOf(t) === day)) {
    const booked = s.busy.filter((b) => b.kind === "calendly" && c.dayOf(b.start) === day).length;
    if (booked) return `the day's limit looks reached (${booked} meeting${booked === 1 ? "" : "s"} that day)`;
  }
  return null;
}

/** The line about a time the calendar has free and Calendly won't take. */
export function blockedLine(start: number, reason: string | null, c: Clock) {
  return reason ? `${c.time12(start)} is free on your calendar, but Calendly won't book it: ${reason}.` : `${c.time12(start)} is free on your calendar, but Calendly won't take it and doesn't say why.`;
}
