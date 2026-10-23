// "Remind me at ..." (0110). Anyone on the team, in a group or privately:
// "فكرني الساعة 5", "فكرني بكرة 10 الصبح أكلم عباس", "remind me at 8 to send
// the invoice", "remind me in 30 minutes", "remind Rabah at 3 to send the
// files". Claude says what was said (a day, a time, am/pm when the words say
// it, or minutes from now); the time itself is worked out here, in the
// asker's time zone: no day means the next time that makes sense, and a time
// with no AM or PM the sensible one (5 is 5 PM, 10 is 10 AM). A time that's
// gone or unclear gets one short question back, never a guess. The reminder
// always goes privately. Your own goes at the time you asked, even outside
// working hours; one for someone else waits for working hours unless the
// asker says otherwise. The minute's run sends what's due, each claimed by
// one run only (_bot_reminders_due). "My reminders" lists them, and one can
// be cancelled.

import { iso, MIN, str, TZ, type Db, type Settings } from "./kit.ts";
import type { Send } from "./people.ts";
import type { Attendee } from "./meetings.ts";
import { clockIn } from "./zones.ts";

/** A time as they said it (Claude fills it in; nothing is worked out yet). */
export interface When {
  /** "2026-10-24", when a day was said ("بكرة" is tomorrow). */
  date?: string;
  /** "17:00", "5:00", "8:30": the time as said. */
  time?: string;
  /** When the words say it: الصبح، الفجر, am; الضهر، العصر، المغرب، بالليل، المسا, pm. */
  ampm?: "am" | "pm" | "";
  /** "in 30 minutes", "بعد ساعة" (60). */
  in_minutes?: number;
}

/** A time with no AM or PM is taken in these hours (8 AM to 10 PM) when one of its two fits. */
const SENSIBLE_FROM = 8;
const SENSIBLE_TO = 22;
/** Further ahead than this isn't a reminder the bot keeps. */
const MAX_AHEAD_MS = 366 * 24 * 60 * MIN;

/**
 * The moment a reminder is for, in their time zone; or the one short question
 * to ask instead (a time that's gone, or none at all).
 */
export function resolveWhen(w: When, zone: string, now = Date.now()): { at: number } | { ask: string } {
  const c = clockIn(zone);
  const mins = Number(w.in_minutes);
  if (Number.isFinite(mins) && mins > 0) {
    const at = Math.ceil((now + mins * MIN) / MIN) * MIN;
    return at - now > MAX_AHEAD_MS ? { ask: "That's too far ahead. Pick a time within a year." } : { at };
  }
  const date = str(w.date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ask: "Which day?" };
  const tm = /^(\d{1,2})(?::(\d{2}))?$/.exec(str(w.time));
  if (!tm) return { ask: date ? `What time on ${c.weekday(c.noon(date))}?` : "When should I remind you?" };
  const [h, m] = [Number(tm[1]), Number(tm[2] ?? 0)];
  if (h > 23 || m > 59) return { ask: "What time exactly?" };
  // The hours it can be: as said, or both halves of the day when it doesn't say which.
  let hours: number[];
  if (w.ampm === "am") hours = [h % 12];
  else if (w.ampm === "pm") hours = [(h % 12) + 12];
  else if (h === 0 || h > 12) hours = [h];
  else {
    const both = [h % 12, (h % 12) + 12];
    const sensible = both.filter((x) => x >= SENSIBLE_FROM && x < SENSIBLE_TO);
    hours = sensible.length ? sensible : both;
  }
  const days = date ? [date] : [c.dayOf(now), c.dayOf(now + 24 * 60 * MIN)];
  const hm = (x: number) => `${String(x).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const ahead = days.flatMap((d) => hours.map((x) => c.at(d, hm(x)))).filter((t) => t > now + 30_000).sort((a, b) => a - b);
  if (!ahead.length) return { ask: date ? "That time's already gone. When should I remind you?" : "When should I remind you?" };
  if (ahead[0]! - now > MAX_AHEAD_MS) return { ask: "That's too far ahead. Pick a time within a year." };
  return { at: ahead[0]! };
}

// ----------------------------------------------------------- working hours --

const cairoHm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const cairoWeekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
type Hours = Pick<Settings, "quiet_from" | "quiet_to" | "off_days" | "off_dates">;

/** Outside working hours at that moment (Cairo): the quiet hours, a weekday off or a date off. */
export function offAt(s: Hours, ms: number) {
  const d = new Date(ms);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(cairoWeekday.format(d));
  if ((s.off_days ?? []).includes(wd) || (s.off_dates ?? []).includes(clockIn(TZ).dayOf(ms))) return true;
  if (!s.quiet_from || !s.quiet_to) return false;
  const [f, t, hm] = [s.quiet_from.slice(0, 5), s.quiet_to.slice(0, 5), cairoHm.format(d)];
  if (f === t) return false;
  return f < t ? hm >= f && hm < t : hm >= f || hm < t;
}

/** That moment, or when work starts next after it (the end of the quiet hours on the next working day). */
export function nextWorkTime(s: Hours, ms: number) {
  if (!offAt(s, ms)) return ms;
  const c = clockIn(TZ);
  const start = (s.quiet_to ?? "00:00").slice(0, 5);
  for (let i = 0; i <= 14; i++) {
    const at = c.at(c.dayOf(ms + i * 24 * 60 * MIN), start);
    if (at > ms && !offAt(s, at)) return at;
  }
  return ms;
}

// ---------------------------------------------------------------- words --

/** "today at 8:00 PM", "tomorrow at 10:00 AM", "Sunday at 3:00 PM", "Sunday 01-11-2026 at 3:00 PM" (+ the zone when it isn't Cairo). */
export function sayWhen(ms: number, zone: string, now = Date.now()) {
  const c = clockIn(zone);
  const days = Math.round((c.noon(c.dayOf(ms)) - c.noon(c.dayOf(now))) / (24 * 60 * MIN));
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? c.weekday(ms) : `${c.weekday(ms)} ${c.dmy(ms)}`;
  return `${day} at ${c.time12(ms)}${zone === TZ ? "" : ` ${c.label}`}`;
}

const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
const clean = (t: string) => str(t).replace(/\s*[—–]\s*/g, ", ").replace(/[.!\s]+$/, "");

// ------------------------------------------------------------- keeping --

export interface Reminder {
  id: string;
  for_user: string;
  set_by: string | null;
  chat_id: string | null;
  text: string;
  due_at: string;
  tz: string;
  status: string;
}
const COLS = "id, for_user, set_by, chat_id, text, due_at, tz, status";

/**
 * A reminder kept. who: the person it's for (the asker, or someone on the
 * team). The reply is the confirmation (day and time stated) or the question
 * back. Once per message per person (source_id).
 */
export async function setReminder(
  db: Db,
  s: Settings,
  o: { by: { id: string; name: string; zone?: string | null }; who: Attendee; text: string; when: When; anyTime?: boolean; sourceId: string; chatId: string | null; now?: number },
): Promise<{ text: string; reminder?: Reminder }> {
  const now = o.now ?? Date.now();
  const zone = o.by.zone || TZ;
  const self = o.who.id === o.by.id;
  if (!self && !o.who.phone) return { text: `I don't have ${first(o.who.name)}'s WhatsApp number. Add it on the Users page, then ask again.` };
  const r = resolveWhen(o.when, zone, now);
  if ("ask" in r) return { text: r.ask };
  // Yours goes when you said; someone else's waits for working hours, unless you said any time.
  const at = self || o.anyTime ? r.at : nextWorkTime(s, r.at);
  const what = clean(o.text);
  const { data, error } = await db
    .from("bot_reminder")
    .insert({
      for_user: o.who.id,
      set_by: o.by.id,
      chat_id: o.chatId,
      source_id: o.sourceId,
      text: what.slice(0, 500),
      due_at: iso(at),
      tz: zone,
      any_time: self || !!o.anyTime,
    })
    .select(COLS)
    .single();
  if (error || !data) {
    // The same message again (WhatsApp sent it twice): it's kept already.
    if (error?.code === "23505") return { text: "That reminder's already set." };
    return { text: "Couldn't keep the reminder. Send it again in a minute?" };
  }
  const moved = at !== r.at ? ", when work starts" : "";
  return {
    text: `OK, I'll remind ${self ? "you" : first(o.who.name)} ${sayWhen(at, zone, now)}${moved}${what ? `: ${what}.` : "."}`,
    reminder: data as Reminder,
  };
}

/** Open reminders someone set or gets, soonest first: for Claude (ids r1...) and for "my reminders". */
export async function openReminders(db: Db, userId: string): Promise<Reminder[]> {
  const { data } = await db.from("bot_reminder").select(COLS).eq("status", "open").or(`for_user.eq.${userId},set_by.eq.${userId}`).order("due_at").limit(20);
  return (data ?? []) as Reminder[];
}

/** "Your reminders: 1. Today at 8:00 PM: send the invoice ..." */
export function listText(list: Reminder[], me: { id: string; zone?: string | null }, names: (id: string) => string, now = Date.now()) {
  if (!list.length) return "No reminders set.";
  const zone = me.zone || TZ;
  return [
    "Your reminders:",
    ...list.map((x, i) => {
      const who = x.for_user === me.id ? "" : `${first(names(x.for_user))}, `;
      const when = sayWhen(Date.parse(x.due_at), zone, now);
      return `${i + 1}. ${who}${when[0]!.toUpperCase()}${when.slice(1)}${x.text ? `: ${x.text}` : ""}`;
    }),
  ].join("\n");
}

/** Cancels the ones named (from openReminders); what was cancelled, said. */
export async function cancelReminders(db: Db, list: Reminder[], ids: string[], me: { zone?: string | null }, now = Date.now()) {
  const hit = ids.map((id) => list[Number(str(id).replace(/\D/g, "")) - 1]).filter((x): x is Reminder => !!x);
  if (!hit.length) return list.length ? "Which one? Say its time, or \"all\"." : "No reminders set.";
  const { data } = await db.from("bot_reminder").update({ status: "cancelled", cancelled_at: iso() }).in("id", hit.map((x) => x.id)).eq("status", "open").select("id");
  const done = new Set(((data ?? []) as { id: string }[]).map((x) => x.id));
  const gone = hit.filter((x) => done.has(x.id));
  if (!gone.length) return "Already gone.";
  return `Cancelled: ${gone.map((x) => `${sayWhen(Date.parse(x.due_at), me.zone || TZ, now)}${x.text ? ` (${x.text})` : ""}`).join("; ")}.`;
}

// ------------------------------------------------------------- sending --

/**
 * Reminders that are due, sent privately: each claimed by one run only (two
 * runs at once never send one twice). Yours: "Reminder: send the invoice.";
 * someone else's: "Hi Rabah, a reminder from Sameh: send the files."
 */
export async function sendReminders(db: Db, send: Send, people: Map<string, Attendee>, deadline: number) {
  const { data, error } = await db.rpc("_bot_reminders_due", { p_limit: 10 });
  if (error) {
    // Before 0110 runs there's nothing to send.
    if (!/_bot_reminders_due|does not exist|schema cache/i.test(error.message)) console.error("reminders", error.message);
    return 0;
  }
  let n = 0;
  for (const x of (data ?? []) as (Reminder & { set_by: string | null })[]) {
    if (Date.now() > deadline) {
      await db.from("bot_reminder").update({ status: "open", claimed_at: null }).eq("id", x.id).eq("status", "sending");
      continue;
    }
    const to = people.get(x.for_user);
    const by = x.set_by && x.set_by !== x.for_user ? people.get(x.set_by) : undefined;
    if (!to?.phone) {
      await db.from("bot_reminder").update({ status: "failed", error: "No WhatsApp number for them" }).eq("id", x.id);
      continue;
    }
    const what = x.text ? `: ${x.text}.` : ".";
    const text = by ? `Hi ${first(to.name)}, a reminder from ${first(by.name)}${what}` : `Reminder${what}`;
    try {
      const id = await send(`${to.phone}@c.us`, text);
      await db.from("bot_reminder").update({ status: "sent", sent_at: iso(), sent_message_id: id }).eq("id", x.id);
      n++;
    } catch (e) {
      await db.from("bot_reminder").update({ status: "failed", error: (e as Error).message.slice(0, 300) }).eq("id", x.id);
    }
  }
  return n;
}
