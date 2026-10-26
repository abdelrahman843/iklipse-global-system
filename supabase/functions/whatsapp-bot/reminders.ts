// "Remind me at ..." (0110). Anyone on the team, in a group or privately:
// "فكرني الساعة 5", "فكرني بكرة 10 الصبح أكلم عباس", "remind me at 8 to send
// the invoice", "remind me in 30 minutes", "remind Rabah at 3 to send the
// files". Claude says what was said (a day, a time, am/pm when the words say
// it, or minutes from now); the time itself is worked out here, in the
// asker's time zone: a time with no AM or PM and no day is the next time that
// hour comes ("at 10" said at 11 AM is 10 PM tonight, at 11 PM it's 10 AM
// tomorrow); on a later day said, the sensible one (5 is 5 PM, 10 is 10 AM).
// The confirmation always says the day and time. A time that's gone or
// unclear gets one short question back, never a guess. The reminder always
// goes privately. Your own goes at the time you asked, even outside working
// hours; one for someone else waits for working hours unless the asker says
// otherwise. The minute's run sends what's due, each claimed by one run only
// (_bot_reminders_due); a send that fails is tried again a few times, then
// whoever set it for someone else hears (0118). "My reminders" lists them,
// and one can be cancelled. One can repeat (0121): "remind me every minute to
// drink water", "every day at 10, until Friday", "every 2 hours, 5 times";
// with no time said it starts now. It goes on until it's cancelled (its
// number), its end time, or its count; someone else's skips to working hours.

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

/** A time with no AM or PM on a later day (any day, for a pause) is taken in these hours (8 AM to 10 PM) when one of its two fits. */
const SENSIBLE_FROM = 8;
const SENSIBLE_TO = 22;
/** Further ahead than this isn't a reminder the bot keeps. */
const MAX_AHEAD_MS = 366 * 24 * 60 * MIN;
const DAY = 24 * 60 * MIN;

/**
 * The moment a day and time there ("2027-03-14", "01:00") is, with the offset
 * at that very moment, not the day's midday: right on the days the clocks
 * change. A time that comes twice (clocks back) is the first; one that's
 * skipped (clocks forward) is as far on as the clocks jumped (2:30 is 3:30).
 */
export function localAt(zone: string, date: string, time: string) {
  const c = clockIn(zone);
  const wall = Date.parse(`${date}T${time}:00Z`);
  // A day that doesn't exist ("2026-13-01"): no moment, as before.
  if (Number.isNaN(wall)) return NaN;
  const off = (ms: number) => Date.parse(`${c.dayOf(ms)}T${c.hm(ms)}:00Z`) - Math.floor(ms / MIN) * MIN;
  // The offset the day before and the day after: the same, or the change in between.
  const fits = [off(wall - DAY), off(wall + DAY)].map((o) => wall - o).filter((t) => wall - t === off(t));
  return fits.length ? Math.min(...fits) : wall - off(wall - DAY);
}

/**
 * The moment a reminder is for, in their time zone; or the one short question
 * to ask instead (a time that's gone, or none at all). nextHour false (an
 * alert's pause, pause.ts): a time with no AM or PM is the sensible one on any
 * day (10 is 10 AM), never the next time that hour comes.
 */
export function resolveWhen(w: When, zone: string, now = Date.now(), o: { nextHour?: boolean } = {}): { at: number } | { ask: string } {
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
  // The hours it can be: as said, or both halves of the day when it doesn't say which: today
  // (or no day said) the next time that hour comes; on a later day, the sensible one.
  const today = c.dayOf(now);
  let hours: number[];
  if (w.ampm === "am") hours = [h % 12];
  else if (w.ampm === "pm") hours = [(h % 12) + 12];
  else if (h === 0 || h > 12) hours = [h];
  else {
    const both = [h % 12, (h % 12) + 12];
    const sensible = both.filter((x) => x >= SENSIBLE_FROM && x < SENSIBLE_TO);
    hours = (o.nextHour !== false && (!date || date === today)) || !sensible.length ? both : sensible;
  }
  // Tomorrow from today's noon: a day the clocks change on is 23 or 25 hours long.
  const days = date ? [date] : [today, c.dayOf(c.noon(today) + DAY)];
  const hm = (x: number) => `${String(x).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const ahead = days.flatMap((d) => hours.map((x) => localAt(zone, d, hm(x)))).filter((t) => t > now + 30_000).sort((a, b) => a - b);
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

/**
 * That moment, or when work starts next after it: the end of the quiet hours on
 * the next working day (8 AM when no working hours are set, never midnight).
 */
export function nextWorkTime(s: Hours, ms: number) {
  if (!offAt(s, ms)) return ms;
  const c = clockIn(TZ);
  const [f, t] = [str(s.quiet_from).slice(0, 5), str(s.quiet_to).slice(0, 5)];
  const start = f && t && f !== t ? t : `${String(SENSIBLE_FROM).padStart(2, "0")}:00`;
  const noon = c.noon(c.dayOf(ms));
  for (let i = 0; i <= 14; i++) {
    const at = localAt(TZ, c.dayOf(noon + i * DAY), start);
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
  /** Repeats this often (0121); none: once. */
  every_minutes?: number | null;
  /** None sent after this. */
  until_at?: string | null;
  /** Sends still to go, this one included; none: no count. */
  times_left?: number | null;
  sent_count?: number | null;
  any_time?: boolean | null;
}
// All of them: the repeat's columns are there only once 0121 has run.
const COLS = "*";

/** How often, at most: once a year. */
const MAX_EVERY = 366 * 24 * 60;

/** "every minute", "every 15 minutes", "every 2 hours", "every day", "every 3 days", "every week". */
export function sayEvery(min: number) {
  const n = (k: number, one: string) => (k === 1 ? `every ${one}` : `every ${k} ${one}s`);
  if (min % (7 * 24 * 60) === 0) return n(min / (7 * 24 * 60), "week");
  if (min % (24 * 60) === 0) return n(min / (24 * 60), "day");
  if (min % 60 === 0) return n(min / 60, "hour");
  return n(min, "minute");
}

/** ", every minute, until today at 10:00 PM", ", every day, 3 times left": a repeating one's words (none for one that goes once). */
function repeatText(x: Pick<Reminder, "every_minutes" | "until_at" | "times_left">, zone: string, now: number) {
  if (!x.every_minutes) return "";
  const until = x.until_at ? `, until ${sayWhen(Date.parse(x.until_at), zone, now)}` : "";
  const left = x.times_left != null ? `, ${x.times_left} ${x.times_left === 1 ? "time" : "times"} left` : "";
  return `, ${sayEvery(x.every_minutes)}${until}${left}`;
}

/**
 * When a repeating reminder goes next, after the one due at due_at: the first
 * of its steps still ahead (a run that fell behind skips the ones missed); a
 * day or more apart, at the same clock time there (right on the days the
 * clocks change). Someone else's, unless any time: when work starts. Null:
 * it doesn't repeat, its count is done, or that's past its end.
 */
export function nextDue(
  x: Pick<Reminder, "due_at" | "tz" | "every_minutes" | "until_at" | "times_left" | "any_time">,
  now: number,
  hours?: Hours,
) {
  const every = Number(x.every_minutes);
  if (!Number.isFinite(every) || every < 1) return null;
  if (x.times_left != null && x.times_left <= 1) return null;
  const due = Date.parse(x.due_at);
  let t: number;
  if (every % (24 * 60) === 0) {
    const zone = x.tz || TZ;
    const c = clockIn(zone);
    const [hm, days] = [c.hm(due), every / (24 * 60)];
    let day = c.dayOf(due);
    do {
      for (let i = 0; i < days; i++) day = c.dayOf(c.noon(day) + DAY);
      t = localAt(zone, day, hm);
    } while (t <= now);
  } else {
    const step = every * MIN;
    t = due + step;
    if (t <= now) t += (Math.floor((now - t) / step) + 1) * step;
  }
  if (!x.any_time && hours) t = nextWorkTime(hours, t);
  if (x.until_at && t > Date.parse(x.until_at)) return null;
  return t;
}

/**
 * A reminder kept. who: the person it's for (the asker, or someone on the
 * team). The reply is the confirmation (day and time stated) or the question
 * back. Once per message per person (source_id).
 */
export async function setReminder(
  db: Db,
  s: Settings,
  o: {
    by: { id: string; name: string; zone?: string | null };
    who: Attendee;
    text: string;
    when: When;
    anyTime?: boolean;
    /** Repeats (0121): how often in minutes, and when it stops (a time said, or how many times); neither: until it's cancelled. */
    repeat?: { everyMinutes?: number; times?: number; until?: When };
    sourceId: string;
    chatId: string | null;
    now?: number;
  },
): Promise<{ text: string; reminder?: Reminder }> {
  const now = o.now ?? Date.now();
  const zone = o.by.zone || TZ;
  const self = o.who.id === o.by.id;
  if (!self && !o.who.phone) return { text: `I don't have ${first(o.who.name)}'s WhatsApp number. Add it on the Users page, then ask again.` };
  const every = Math.floor(Number(o.repeat?.everyMinutes) || 0);
  if (every < 0 || every > MAX_EVERY) return { text: "How often should it repeat? Every minute up to once a year." };
  const said = (w?: When) => !!w && (!!str(w.date) || !!str(w.time) || Number(w.in_minutes) > 0);
  // A repeating one with no time said starts now.
  const startNow = every > 0 && !said(o.when);
  const r = startNow ? { at: now } : resolveWhen(o.when, zone, now);
  if ("ask" in r) return { text: r.ask };
  // Yours goes when you said; someone else's waits for working hours, unless you said any time.
  const at = self || o.anyTime ? r.at : nextWorkTime(s, r.at);
  let until: number | null = null;
  if (every && said(o.repeat?.until)) {
    const u = resolveWhen(o.repeat!.until!, zone, now);
    if ("ask" in u) return { text: "Until when should it repeat?" };
    if (u.at <= at) return { text: "That ends before the first one. Until when should it repeat?" };
    until = u.at;
  }
  const times = every ? Math.floor(Number(o.repeat?.times) || 0) : 0;
  if (times < 0) return { text: "How many times?" };
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
      ...(every ? { every_minutes: every, until_at: until === null ? null : iso(until), times_left: times || null } : {}),
    })
    .select(COLS)
    .single();
  if (error || !data) {
    // The same message again (WhatsApp sent it twice): it's kept already.
    if (error?.code === "23505") return { text: "That reminder's already set." };
    return { text: "Couldn't keep the reminder. Send it again in a minute?" };
  }
  const moved = at !== r.at ? ", when work starts" : "";
  if (every) {
    const from = startNow ? "starting now" : `from ${sayWhen(at, zone, now)}${moved}`;
    const stop = until !== null ? `, until ${sayWhen(until, zone, now)}` : times ? `, ${times} ${times === 1 ? "time" : "times"}` : ", until you say stop";
    return {
      text: `OK, I'll remind ${self ? "you" : first(o.who.name)} ${sayEvery(every)}, ${from}${stop}${what ? `: ${what}.` : "."}`,
      reminder: data as Reminder,
    };
  }
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
      return `${i + 1}. ${who}${when[0]!.toUpperCase()}${when.slice(1)}${repeatText(x, zone, now)}${x.text ? `: ${x.text}` : ""}`;
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
  return `Cancelled: ${gone.map((x) => `${sayWhen(Date.parse(x.due_at), me.zone || TZ, now)}${x.every_minutes ? `, ${sayEvery(x.every_minutes)}` : ""}${x.text ? ` (${x.text})` : ""}`).join("; ")}.`;
}

// ------------------------------------------------------------- sending --

/** A send that fails is tried again after these many minutes, one after the other (0118); then it's failed. */
const RETRY_MIN = [1, 5, 15];

/**
 * Reminders that are due, sent privately: each claimed by one run only (two
 * runs at once never send one twice). Yours: "Reminder: send the invoice.";
 * someone else's: "Hi Rabah, a reminder from Sameh: send the files." One that
 * doesn't go is tried again a few times; then whoever set it for someone else
 * hears it didn't go ("Sameh, I couldn't send Rabah your reminder: ...").
 * One that repeats (0121) is open again for its next time once it went (or
 * once its tries ran out), until its end. hours: the working hours someone
 * else's next one waits for.
 */
export async function sendReminders(db: Db, send: Send, people: Map<string, Attendee>, deadline: number, hours?: Hours) {
  const { data, error } = await db.rpc("_bot_reminders_due", { p_limit: 10 });
  if (error) {
    // Before 0110 runs there's nothing to send.
    if (!/_bot_reminders_due|does not exist|schema cache/i.test(error.message)) console.error("reminders", error.message);
    return 0;
  }
  let n = 0;
  // A team that couldn't be read (nobody's number) fails none: each is left for the next run.
  const read = [...people.values()].some((p) => !!p.phone);
  for (const x of (data ?? []) as (Reminder & { set_by: string | null; tries?: number | null })[]) {
    const next = () => nextDue(x, Date.now(), hours);
    if (Date.now() > deadline || !read) {
      await db.from("bot_reminder").update({ status: "open", claimed_at: null }).eq("id", x.id).eq("status", "sending");
      continue;
    }
    const to = people.get(x.for_user);
    const by = x.set_by && x.set_by !== x.for_user ? people.get(x.set_by) : undefined;
    const what = x.text ? `: ${x.text}.` : ".";
    // Theirs, privately (yours: there's nobody else to tell).
    const tellSetter = async (why: string) => {
      if (!by?.phone) return;
      await send(`${by.phone}@c.us`, `${first(by.name)}, I couldn't send ${to ? first(to.name) : "them"} your reminder${what} ${why}`).catch((e) =>
        console.error("reminders", (e as Error).message),
      );
    };
    if (!to?.phone) {
      await db.from("bot_reminder").update({ status: "failed", error: "No WhatsApp number for them" }).eq("id", x.id);
      // Not in the team read (it has the active ones only): they left.
      await tellSetter(to ? "I don't have their WhatsApp number." : "They're not on the team anymore.");
      continue;
    }
    const text = by ? `Hi ${first(to.name)}, a reminder from ${first(by.name)}${what}` : `Reminder${what}`;
    try {
      const id = await send(`${to.phone}@c.us`, text);
      const went = { sent_at: iso(), sent_message_id: id };
      const again = next();
      const count = { sent_count: (x.sent_count ?? 0) + 1, times_left: x.times_left == null ? null : Math.max(0, x.times_left - 1) };
      if (again !== null) {
        await db.from("bot_reminder").update({ ...went, ...count, status: "open", claimed_at: null, due_at: iso(again), tries: 0, retry_at: null, error: null }).eq("id", x.id);
      } else if (x.every_minutes) await db.from("bot_reminder").update({ ...went, ...count, status: "sent" }).eq("id", x.id);
      else await db.from("bot_reminder").update({ ...went, status: "sent" }).eq("id", x.id);
      n++;
    } catch (e) {
      const why = (e as Error).message.slice(0, 300);
      const tries = (x.tries ?? 0) + 1;
      const wait = RETRY_MIN[tries - 1];
      // Tried again a little later (before 0118 runs it can't be: failed, as before).
      if (wait !== undefined) {
        const { error: refused } = await db.from("bot_reminder").update({ status: "open", claimed_at: null, tries, retry_at: iso(Date.now() + wait * MIN), error: why }).eq("id", x.id);
        if (!refused) continue;
      }
      // One that repeats goes on from its next time; whoever set it for someone else hears this one didn't go.
      const again = next();
      if (again !== null) {
        await db.from("bot_reminder").update({ status: "open", claimed_at: null, due_at: iso(again), tries: 0, retry_at: null, error: why }).eq("id", x.id);
        await tellSetter("WhatsApp didn't take it.");
        continue;
      }
      await db.from("bot_reminder").update({ status: "failed", error: why }).eq("id", x.id);
      await tellSetter("WhatsApp didn't take it.");
    }
  }
  return n;
}

/** A short "got it": ok, done, thanks, تمام... (nothing else in it). */
export const isAck = (text: string) =>
  /^(ok(ay)?|k|done|got it|noted|thanks?|thank you|thx|sure|yes|yep|تمام|ماشي|حاضر|اوك|اوكي|أوكي|تم|شكرا|شكراً|خلاص|اه|أه|ايوه|أيوه|👍)[\s.!،]*$/i.test(text.trim());

/**
 * Someone answers a repeating reminder with "ok" (or any short got-it, as a
 * reply to it or as their next words after it): that is it, it stops. Only
 * their own repeating reminders that went out in the last hour, and only when
 * the bot's last words to them were that reminder. Returns how many it stopped.
 */
export async function ackReminder(db: Db, userId: string, text: string, quotedId: string | null, now = Date.now()) {
  if (!isAck(text)) return 0;
  const { data } = await db
    .from("bot_reminder")
    .select("id, sent_message_id, sent_at, every_minutes")
    .eq("for_user", userId)
    .eq("status", "open")
    .not("every_minutes", "is", null)
    .gte("sent_at", iso(now - 60 * MIN))
    .order("sent_at", { ascending: false })
    .limit(5);
  const rows = (data ?? []) as { id: string; sent_message_id: string | null; sent_at: string; every_minutes: number | null }[];
  const hit = quotedId ? rows.filter((r) => r.sent_message_id === quotedId) : rows.slice(0, 1);
  if (!hit.length) return 0;
  const { data: gone } = await db.from("bot_reminder").update({ status: "cancelled", cancelled_at: iso(now) }).in("id", hit.map((r) => r.id)).eq("status", "open").select("id");
  return gone?.length ?? 0;
}
