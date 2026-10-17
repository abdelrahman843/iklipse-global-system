// Zoom meetings from WhatsApp (0079): the bot as an assistant the admins talk
// to in a group. A conversation starts only when an admin mentions the bot
// ("@iklipse book a call with them Sunday at 3, an hour, about the new
// campaign"); after that, admins carry it on by replying to the bot's
// messages. It books on that admin's own Zoom (Connections page: the account
// they picked for the bot, when they have more than one) and answers
// as a reply, always in English (whatever language it's asked in), short, the
// way a person texts: the link, the date (25-12-2019) and the time (3:00 PM,
// Cairo). No greetings, no apologies, no offers of more help.
// When the time is taken on that Zoom it answers with the free times that day,
// and a reply picks one, or asks for another day, the nearest free day, the
// earliest time, the weekend... A reply about a booked meeting moves or
// cancels it. Besides a meeting at a time (0080): a link right now (with a
// length or none), a link with no set time that always works, and a series
// (every day, every Sunday, every month...). Emails in the message are
// invited: Zoom keeps them on the meeting and they get the invitation by
// email from the admin's Gmail (_shared/invite.ts).
//
// Only admins (by the number iklipse has for them) get anything: anyone else
// mentioning the bot or replying to it gets nothing at all. Everything the bot
// has to say, a problem too (no Zoom, Zoom says no, something missing), is a
// reply in the group to that admin's message, so they can answer it there.

import { accessToken, botAccount, createMeeting, deleteMeeting, getMeeting, updateMeeting, upcomingMeetings, type MeetingKind, type Recurrence } from "../_shared/zoom.ts";
import { emailsOf, invitedFrom, inviteesOn, repeatWords, sendInvites, senderFor, type Invited } from "../_shared/invite.ts";
import { cairoOffset, claude, iso, MIN, str, TZ, type Db } from "./kit.ts";

/** Sends the bot's words in the group as a reply to a message; the id of what it sent. */
export type Reply = (chatId: string, text: string, quotedId: string) => Promise<string | null>;

/** The settings the bot books with (watch_settings). */
export interface BookSettings {
  model: string;
  book_from: string;
  book_to: string;
}

/** What a conversation is arranging, between messages. */
interface State {
  topic?: string;
  agenda?: string;
  minutes?: number;
  /** Who to invite, and how it repeats (a series being booked). */
  emails?: string[];
  repeat?: Repeat;
  /** The day free times were last shown for. */
  day?: string;
  /** Moving this meeting (its Zoom id). */
  move?: string;
}

/** How a series repeats, as Claude says it. */
interface Repeat {
  type: "" | "daily" | "weekly" | "monthly";
  every: number;
  days: string[];
  times: number;
  until: string;
}

interface Turn {
  id: string;
  thread_id: string;
  chat_id: string;
  from_bot: boolean;
  user_id: string | null;
  text: string;
  quoted: string | null;
  created_at: string;
}

interface Meeting {
  zoom_id: string;
  owner: string;
  /** The Zoom account it's on (null: that account was disconnected). */
  account: string | null;
  kind: MeetingKind;
  topic: string;
  /** When it starts (now for a link with no set time). */
  start_at: string;
  minutes: number;
  join_url: string;
  password: string | null;
}

const DAY = 24 * 60 * MIN;
const STEP = 30 * MIN;
const tagsIn = (text: string) => [...text.matchAll(/@(\d{8,15})\b/g)].map((m) => m[1]);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// -------------------------------------------------------------- listening --

/** The ids a mention of the bot can carry: its number, and its WhatsApp lid in the groups. */
async function botIds(db: Db, bot: string) {
  const { data } = await db.from("wa_participant").select("lid").eq("phone", bot).not("lid", "is", null).limit(20);
  return new Set([bot, ...(data ?? []).map((p) => str(p.lid).split("@")[0]).filter(Boolean)]);
}

/**
 * The active admin with this WhatsApp number (a link in Alerts > Groups wins
 * over a member card), or, when WhatsApp hides the number, with this
 * WhatsApp id linked in Alerts > Groups (0080).
 */
async function adminOf(db: Db, phone: string | null, sender: string): Promise<string | null> {
  let id: string | undefined;
  if (phone) {
    const [link, card] = await Promise.all([
      db.from("wa_member").select("user_id").eq("phone", phone).maybeSingle(),
      db.from("profile_contact").select("user_id").eq("whatsapp", phone).limit(1).maybeSingle(),
    ]);
    id = link.data ? link.data.user_id : card.data?.user_id;
  } else if (sender.endsWith("@lid")) {
    const { data } = await db.from("wa_member_lid").select("user_id").eq("lid", sender).maybeSingle();
    id = data?.user_id;
  }
  if (!id) return null;
  const { data: p } = await db.from("profile").select("role, is_active").eq("id", id).maybeSingle();
  return p?.is_active && p.role === "admin" ? id : null;
}

/** Mentions as names: "@iklipse" for the bot, the group's names for the others. */
async function named(db: Db, chatId: string, text: string, bot: Set<string>) {
  const others = [...new Set(tagsIn(text))].filter((d) => !bot.has(d));
  const names = new Map<string, string>();
  if (others.length) {
    const { data } = await db
      .from("wa_participant")
      .select("phone, lid, name")
      .eq("chat_id", chatId)
      .or(others.map((d) => `phone.eq.${d},lid.eq.${d}@lid`).join(","));
    for (const p of data ?? []) {
      if (!p.name) continue;
      if (p.phone) names.set(p.phone, p.name);
      if (p.lid) names.set(str(p.lid).split("@")[0], p.name);
    }
  }
  return text.replace(/@(\d{8,15})\b/g, (all, d: string) => (bot.has(d) ? "@iklipse" : names.has(d) ? `@${names.get(d)}` : all));
}

/**
 * A group message. An admin mentioning the bot starts a conversation; an
 * admin replying to one of the bot's messages carries that one on. The
 * message is kept (once, however often WhatsApp sends it) and true comes
 * back: answer it now. Anything else, and anyone else: false, nothing kept.
 */
export async function heard(
  db: Db,
  o: {
    id: string;
    chatId: string;
    chatName: string | null;
    text: string;
    quoted: string | null;
    quotedId: string | null;
    /** The sender's WhatsApp id ("...@c.us", or "...@lid" when the number is hidden). */
    sender: string;
    phone: () => Promise<string | null>;
    botPhone: string | null;
  },
): Promise<boolean> {
  let threadId: string | null = null;
  if (o.quotedId) {
    const { data: t } = await db.from("wa_bot_turn").select("thread_id").eq("id", o.quotedId).eq("from_bot", true).maybeSingle();
    threadId = t?.thread_id ?? null;
  }
  const tags = tagsIn(o.text);
  if (!threadId && !tags.length) return false;
  const { data: s } = await db.from("watch_settings").select("book_enabled, bot_phone").eq("id", 1).single();
  const bot = o.botPhone ?? s?.bot_phone;
  if (!s?.book_enabled || !bot) return false;
  const ids = await botIds(db, bot);
  if (!threadId && !tags.some((d) => ids.has(d))) return false;
  const userId = await adminOf(db, await o.phone(), o.sender);
  if (!userId) return false;
  const { data: seen } = await db.from("wa_bot_turn").select("id").eq("id", o.id).maybeSingle();
  if (seen) return false;

  // The message it answers, when that isn't the bot's (the details may be there).
  let quoted: string | null = null;
  if (o.quotedId && !threadId) {
    quoted = o.quoted;
    if (!quoted) {
      const { data: q } = await db.from("wa_message").select("text").eq("id", o.quotedId).maybeSingle();
      quoted = q?.text ?? null;
    }
  }
  if (!threadId) {
    const { data: g } = await db.from("wa_group").select("name").eq("chat_id", o.chatId).maybeSingle();
    const { data: t, error } = await db
      .from("wa_bot_thread")
      .insert({ chat_id: o.chatId, chat_name: g?.name ?? o.chatName, started_by: userId })
      .select("id")
      .single();
    if (error || !t) throw new Error(error?.message ?? "Couldn't start the conversation");
    threadId = t.id as string;
  }
  const { data } = await db
    .from("wa_bot_turn")
    .upsert(
      {
        id: o.id,
        thread_id: threadId,
        chat_id: o.chatId,
        user_id: userId,
        text: (await named(db, o.chatId, o.text, ids)).slice(0, 4000),
        quoted: quoted ? (await named(db, o.chatId, quoted, ids)).slice(0, 4000) : null,
        status: "new",
      },
      { onConflict: "id", ignoreDuplicates: true },
    )
    .select("id");
  return !!data?.length;
}

// ------------------------------------------------------------ Cairo time --

const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const weekdayName = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" });
const nowWords = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The moment a Cairo day and time ("2026-10-20", "15:00") starts. */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00${cairoOffset(new Date(`${date}T12:00:00Z`))}`);
/** "2026-10-20" in Cairo. */
const dayOf = (ms: number) => ymd.format(new Date(ms));
/** "25-12-2019" */
const dmy = (ms: number) => dayOf(ms).split("-").reverse().join("-");
/** "3:00 PM" */
const time12 = (ms: number) => clock.format(new Date(ms)).replace(/[\u202f\u00a0]/g, " ");
/** "Sunday" */
const weekday = (ms: number) => weekdayName.format(new Date(ms));
/** A day's noon, for its name and date. */
const noon = (date: string) => at(date, "12:00");

/** The next two weeks, so "Sunday" or "the day after tomorrow" lands on the right date. */
function calendar() {
  return Array.from({ length: 15 }, (_, i) => {
    const t = Date.now() + i * DAY;
    return `${weekday(t)} ${dayOf(t)}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`;
  }).join("\n");
}

/** "30 min", "1 hour", "1 hour 30 min" */
function length(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} min`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}

// ------------------------------------------------------------- free times --

interface Busy {
  id: string;
  start: number;
  end: number;
}

/** What's on this Zoom from now on. */
async function busyOn(token: string): Promise<Busy[]> {
  const list = await upcomingMeetings(token);
  return list
    .filter((m) => m.start_time)
    .map((m) => {
      const start = Date.parse(m.start_time!);
      return { id: String(m.id), start, end: start + Math.max(1, m.duration ?? 30) * MIN };
    });
}

const clash = (busy: Busy[], start: number, minutes: number, skip?: string) => busy.some((b) => b.id !== skip && b.start < start + minutes * MIN && start < b.end);

/** The free start times on a day, every half hour within the hours set, from now on. */
function freeTimes(busy: Busy[], date: string, minutes: number, s: BookSettings, skip?: string) {
  const first = at(date, s.book_from.slice(0, 5));
  const last = at(date, s.book_to.slice(0, 5)) - minutes * MIN;
  const out: number[] = [];
  for (let t = first; t <= last; t += STEP) {
    if (t > Date.now() + 5 * MIN && !clash(busy, t, minutes, skip)) out.push(t);
  }
  return out;
}

/** The first day from this one (up to 3 weeks on) with a free time. */
function nearestDay(busy: Busy[], from: string, minutes: number, s: BookSettings, skip?: string) {
  for (let i = 0; i < 21; i++) {
    const d = dayOf(noon(from) + i * DAY);
    const free = freeTimes(busy, d, minutes, s, skip);
    if (free.length) return { day: d, free };
  }
  return null;
}

/** The free times, the way a person would text them. */
function timesText(o: { busy: Busy[]; days: string[]; search: string; minutes: number; s: BookSettings; skip?: string; taken?: number }) {
  const day = (d: string) => `${weekday(noon(d))} ${dmy(noon(d))}`;
  const list = (free: number[]) => free.map(time12).join(", ");
  // The length only when it isn't the usual half hour.
  const len = o.minutes === 30 ? "" : ` (${length(o.minutes)})`;
  const lines: string[] = o.taken ? [`${time12(o.taken)} is taken.`] : [];
  const from = o.days[0] ?? dayOf(Date.now());
  let shown: string | undefined;
  let ask = "Which time?";

  if (o.search === "earliest" || o.search === "nearest_day") {
    const hit = nearestDay(o.busy, from, o.minutes, o.s, o.skip);
    if (!hit) {
      lines.push("Nothing's free in the next 3 weeks.");
      ask = "";
    } else if (o.search === "earliest") {
      lines.push(`Earliest free: ${day(hit.day)}, ${time12(hit.free[0])}${len}.`);
      ask = "Book it?";
      shown = hit.day;
    } else {
      lines.push(`Free on ${day(hit.day)}${len}:`, list(hit.free));
      shown = hit.day;
    }
  } else if (o.days.length === 1) {
    const d = o.days[0];
    const free = freeTimes(o.busy, d, o.minutes, o.s, o.skip);
    shown = d;
    if (free.length) lines.push(`Free on ${day(d)}${len}:`, list(free));
    else {
      // That day is full: the nearest one that isn't.
      const hit = nearestDay(o.busy, dayOf(noon(d) + DAY), o.minutes, o.s, o.skip);
      lines.push(`Nothing free on ${day(d)}.`);
      if (hit) {
        lines.push(`Next free day, ${day(hit.day)}${len}:`, list(hit.free));
        shown = hit.day;
      } else ask = "";
    }
  } else {
    if (len) lines.push(`Free times${len}:`);
    let any = false;
    for (const d of o.days.slice(0, 7)) {
      const free = freeTimes(o.busy, d, o.minutes, o.s, o.skip);
      any ||= free.length > 0;
      lines.push(`${day(d)}: ${free.length ? list(free) : "nothing free"}`);
      shown ??= d;
    }
    if (!any) ask = "";
  }
  if (ask) lines.push(ask);
  return { text: lines.join("\n"), shown };
}

/**
 * A meeting, the way a person would text it: "Booked: *Title*", when, the
 * link, its id and passcode. Cairo time goes without saying.
 */
function meetingText(head: string, m: Invited) {
  const lines = [`${head} *${m.topic}*`];
  const timed = (m.kind === "once" || m.kind === "repeat") && m.start !== undefined;
  if (timed) lines.push([`${weekday(m.start!)} ${dmy(m.start!)}`, time12(m.start!), m.minutes ? length(m.minutes) : ""].filter(Boolean).join(", "));
  else if (m.kind === "instant" && m.minutes) lines.push(length(m.minutes));
  if (m.kind === "repeat" && m.recurrence) lines.push(repeatWords(m.recurrence, m.timezone));
  lines.push(m.join_url, `ID ${m.id.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1 $2 $3")}${m.password ? `, passcode ${m.password}` : ""}`);
  return lines.join("\n");
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Zoom's recurrence for a series starting then (null: it doesn't repeat). */
function recurrenceOf(r: Repeat | undefined, start: number): Recurrence | null {
  const type = r?.type === "daily" ? 1 : r?.type === "weekly" ? 2 : r?.type === "monthly" ? 3 : 0;
  if (!r || !type) return null;
  // Zoom's limits: every 99 days, 50 weeks or 10 months at most; 50 meetings.
  const max = type === 1 ? 99 : type === 2 ? 50 : 10;
  const out: Recurrence = { type, repeat_interval: Math.max(1, Math.min(max, Math.round(Number(r.every)) || 1)) };
  if (type === 2) {
    const days = [...new Set((r.days ?? []).map((d) => WEEKDAYS.indexOf(str(d).toLowerCase()) + 1).filter((d) => d > 0))];
    if (!days.length) days.push(WEEKDAYS.indexOf(weekday(start).toLowerCase()) + 1);
    out.weekly_days = days.sort().join(",");
  }
  if (type === 3) out.monthly_day = Number(dayOf(start).slice(8));
  const until = str(r.until);
  if (isDay(until) && until > dayOf(start)) out.end_date_time = new Date(at(until, "23:59")).toISOString().replace(/\.\d{3}Z$/, "Z");
  else out.end_times = Math.max(1, Math.min(50, Math.round(Number(r.times)) || (type === 1 ? 30 : type === 2 ? 26 : 12)));
  return out;
}

// --------------------------------------------------------------- deciding --

interface Act {
  action: "book" | "find_times" | "move" | "cancel" | "ignore" | "none";
  kind: "" | "once" | "now" | "no_time" | "repeat";
  topic: string;
  agenda: string;
  date: string;
  time: string;
  minutes: number;
  emails: string[];
  repeat: Repeat;
  meeting: string;
  days: string[];
  search: "" | "nearest_day" | "earliest";
  problem: string;
}

const TOOL = {
  name: "act",
  description: "What to do for the admin's latest message.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["book", "find_times", "move", "cancel", "ignore", "none"] },
      kind: {
        type: "string",
        enum: ["", "once", "now", "no_time", "repeat"],
        description:
          "book: once = at a day and a time. now = a link right now (\"لينك دلوقتي\", \"instant\", \"quick call now\"); minutes is its length when one is said, else 0 (no set length). no_time = a link with no set time that always works (\"لينك ثابت\", \"مالوش معاد\", \"permanent link\"). repeat = a series (every day, every Sunday, weekly, monthly): date and time are its first meeting. Else empty.",
      },
      topic: { type: "string", description: "book: a short title, in English. move: a new title only when asked, else empty." },
      agenda: { type: "string", description: "book: every other detail given (who's in it, what it's about, notes, links), in English. Empty if none." },
      date: { type: "string", description: "book (once, repeat) / move: the day it starts, YYYY-MM-DD. Else empty." },
      time: { type: "string", description: "book (once, repeat) / move: the time it starts, HH:MM 24-hour. Else empty." },
      minutes: { type: "integer", description: "How long, when said. 0 when not said." },
      emails: {
        type: "array",
        items: { type: "string" },
        description: "book: the email addresses of the people to invite, exactly as written in the conversation (never made up). move: email addresses to add to the meeting. Else empty.",
      },
      repeat: {
        type: "object",
        description: "book with kind repeat: how it repeats. Else type empty.",
        properties: {
          type: { type: "string", enum: ["", "daily", "weekly", "monthly"] },
          every: { type: "integer", description: "1 = every day / week / month, 2 = every other one..." },
          days: { type: "array", items: { type: "string", enum: WEEKDAYS }, description: "weekly: the days. Empty = the first meeting's day." },
          times: { type: "integer", description: "How many meetings in all, when said. 0 when not said." },
          until: { type: "string", description: "The last day, YYYY-MM-DD, when said. Else empty." },
        },
        required: ["type", "every", "days", "times", "until"],
      },
      meeting: { type: "string", description: "move / cancel: the meeting's id from the meetings list. Else empty." },
      days: { type: "array", items: { type: "string" }, description: "find_times: the days to show, YYYY-MM-DD, at most 7. Else empty." },
      search: { type: "string", enum: ["", "nearest_day", "earliest"], description: "find_times: nearest_day = the first day with a free time, from days[0] or today; earliest = the earliest free time from then. Empty to show the days as they are." },
      problem: {
        type: "string",
        description: "none: what you'd text back, in English, like a person on WhatsApp: a few words, usually a short question (\"What time?\", \"Which day?\", \"Which meeting?\", \"For how long?\"). No greeting, no apology, no please, no thanks, no offer of more help. Else empty.",
      },
    },
    required: ["action", "kind", "topic", "agenda", "date", "time", "minutes", "emails", "repeat", "meeting", "days", "search", "problem"],
  },
};

async function decide(s: BookSettings, ctx: Record<string, unknown>): Promise<Act | null> {
  const system = `You are iklipse, the team's assistant in a WhatsApp group, booking Zoom meetings for the iklipse admins. A conversation with you starts when an admin mentions you ("@iklipse"); admins carry it on by replying to your messages. Decide what to do for the last message in the conversation (an admin's) and call act once. Admins may write in English, Arabic, Egyptian Arabic or Franco-Arabic; everything you write (topic, agenda, problem) is in English.

It is ${nowWords.format(new Date())} in Cairo now. Every day and time is Cairo time. The next days:
${calendar()}
The weekend is Friday and Saturday. Free times are offered between ${s.book_from.slice(0, 5)} and ${s.book_to.slice(0, 5)}.

- book: a new meeting. kind once needs the day and the time; kind repeat needs the first meeting's day and time and how it repeats; kind now (a link right now) and kind no_time (a link that always works) need neither. Email addresses in the message are people to invite. In a reply, take what isn't said again (title, details, length, the day, the emails, how it repeats) from the conversation and from "pending": after you offered free times, "4" or "خليها 4 ونص" books that time on that day with the same title, and a series stays a series. After you offered one time ("Earliest free: ... Book it?"), a yes ("ok", "تمام", "احجزه", "yes") books that time.
- find_times: they ask what's free: a day ("خلينا يوم الحد"), the nearest free day ("أقرب يوم فاضي"), the earliest time ("أبدر معاد"), the weekend (its two days), this week. A day with no time means the free times that day.
- move: change the day, time, length or title of a meeting from the meetings list, or add people to it by email (a reply to your message about a meeting is about that one). "pending" with move: a reply picking a time moves that meeting.
- cancel: cancel a meeting from the meetings list.
- ignore: nothing asked (thanks, ok after a booking, a remark to someone else).
- none: anything else, or the day or time of a meeting at a time is missing or unclear and the conversation doesn't give it. Say what's missing in problem. Never invent a day, a time or an email address.

Times: with no AM or PM, the sensible working-hours one (3 is 15:00, 10 is 10:00, 7 is 19:00) unless the words say otherwise (الصبح، الضهر، العصر، المغرب، بالليل). "3 ونص" is 15:30, "3 وربع" 15:15. Only a time and no day: today if that time is still ahead, else none. Weekdays mean the next one coming.`;
  const r = await claude(s.model, system, JSON.stringify(ctx), TOOL, 1200);
  return r && typeof r === "object" && typeof r.action === "string" ? (r as Act) : null;
}

// --------------------------------------------------------------- answering --

/** Something the admin has to hear: the bot says it in the group, as a reply to their message. */
class Stop extends Error {}

/** Says it in the group as a reply to that message, and keeps it as the bot's turn (so a reply to it carries on). */
async function sayIn(db: Db, reply: Reply, turn: { id: string; thread_id: string; chat_id: string }, text: string) {
  const sent = await reply(turn.chat_id, text, turn.id);
  if (sent) await db.from("wa_bot_turn").upsert({ id: sent, thread_id: turn.thread_id, chat_id: turn.chat_id, from_bot: true, text, status: "done" }, { onConflict: "id", ignoreDuplicates: true });
}

/** Answers one admin message (once: only the run that picks it up does). */
export async function answer(db: Db, s: BookSettings, id: string, reply: Reply) {
  const { data: turn } = await db
    .from("wa_bot_turn")
    .update({ status: "working", started_at: iso() })
    .eq("id", id)
    .eq("status", "new")
    .select("id, thread_id, chat_id, from_bot, user_id, text, quoted, created_at")
    .maybeSingle();
  if (!turn) return;
  const t = turn as Turn;
  const { data: th } = await db.from("wa_bot_thread").select("chat_name, state").eq("id", t.thread_id).single();
  const group = (th?.chat_name as string | null) ?? null;
  let state = ((th?.state ?? {}) as State) || {};
  const done = async (status: "done" | "failed", error?: string) => {
    await db.from("wa_bot_turn").update({ status, error: error?.slice(0, 500) ?? null }).eq("id", id);
    await db.from("wa_bot_thread").update({ state, updated_at: iso() }).eq("id", t.thread_id);
  };
  const say = async (text: string) => {
    try {
      await sayIn(db, reply, t, text);
    } catch (e) {
      throw new Error(`Couldn't post the answer in the group: ${(e as Error).message}`);
    }
  };

  try {
    // The conversation so far, the meetings booked from this group, and who's who.
    const { data: turns } = await db
      .from("wa_bot_turn")
      .select("id, from_bot, user_id, text, quoted, created_at")
      .eq("thread_id", t.thread_id)
      .lte("created_at", t.created_at)
      .order("created_at", { ascending: false })
      .limit(20);
    // Coming ones, and series and links with no set time (they go on).
    const { data: ms } = await db
      .from("wa_bot_meeting")
      .select("zoom_id, owner, account, kind, topic, start_at, minutes, join_url, password")
      .eq("chat_id", t.chat_id)
      .eq("status", "booked")
      .or(`start_at.gt.${iso(Date.now() - 60 * MIN)},kind.in.(repeat,no_time)`)
      .order("start_at")
      .limit(30);
    const meetings = (ms ?? []) as Meeting[];
    const ids = [...new Set([...(turns ?? []).map((x) => x.user_id), ...meetings.map((m) => m.owner)].filter(Boolean))] as string[];
    const { data: ps } = ids.length ? await db.from("profile").select("id, display_name").in("id", ids) : { data: [] };
    const nameOf = (u: string | null) => (ps ?? []).find((p) => p.id === u)?.display_name || "An admin";
    const history = (turns ?? []).reverse();
    const timedKind = (k: MeetingKind) => k === "once" || k === "repeat";

    const act = await decide(s, {
      group,
      pending: state,
      meetings: meetings.map((m) => ({
        id: m.zoom_id,
        topic: m.topic,
        kind: m.kind === "instant" ? "now" : m.kind,
        ...(timedKind(m.kind) ? { date: dayOf(Date.parse(m.start_at)), time: hm.format(new Date(m.start_at)), minutes: m.minutes } : {}),
        booked_by: nameOf(m.owner),
      })),
      conversation: history.map((x) => ({
        from: x.from_bot ? "iklipse" : `${nameOf(x.user_id)} (admin)`,
        at: `${dayOf(Date.parse(x.created_at))} ${hm.format(new Date(x.created_at))}`,
        text: x.text,
        ...(x.quoted ? { replying_to: x.quoted } : {}),
      })),
    });
    if (!act) throw new Stop("Didn't get that. What day and time?");
    if (act.action === "ignore") return await done("done");
    if (act.action === "none") throw new Stop(str(act.problem) || "Didn't get that. What day and time?");

    // New meetings go on the asking admin's bot account; a booked one stays on its own account.
    const mineToBook = async () => {
      const account = await botAccount(db, t.user_id!);
      if (!account) throw new Stop("Your Zoom isn't connected on iklipse yet. Connect it, then ask again.");
      return account;
    };
    const tokenOf = async (account: string | null, owner: string) => {
      const token = account ? await accessToken(db, account) : null;
      if (token) return token;
      if (!account) throw new Stop("The Zoom this meeting is on was disconnected, so I can't change it from here.");
      throw new Stop(`${owner === t.user_id ? "Your" : `${nameOf(owner)}'s`} Zoom needs reconnecting on iklipse.`);
    };
    const busyOf = async (token: string) => {
      try {
        return await busyOn(token);
      } catch (e) {
        throw new Stop(`Couldn't check the Zoom calendar: ${(e as Error).message}`);
      }
    };
    const startOf = (date: string, time: string) => {
      const tm = str(time).replace(/^(\d):/, "0$1:");
      if (!isDay(date) || !/^\d{2}:\d{2}$/.test(tm)) throw new Stop(str(act.problem) || "What day and time?");
      const start = at(date, tm);
      if (Number.isNaN(start)) throw new Stop("Didn't get the time. What time?");
      if (start < Date.now() - 5 * MIN) throw new Stop(`${time12(start)} on ${dmy(start)} has passed. What time?`);
      if (start > Date.now() + 400 * DAY) throw new Stop("That's over a year away. What date?");
      return start;
    };
    const findMeeting = () => {
      const m = meetings.find((x) => x.zoom_id === str(act.meeting)) ?? meetings.find((x) => x.zoom_id === state.move);
      if (!m) throw new Stop("Which meeting?");
      return m;
    };
    const zoomSaid = (e: unknown) => new Stop(`Zoom didn't take it: ${(e as Error).message}`);
    /** Emails the invitation (or the change, or the cancellation) from the meeting owner's Gmail: the line saying so. */
    const invite = async (account: string | null, owner: string, to: string[], m: Invited, how: "new" | "update" | "cancel") => {
      if (!to.length) return null;
      const { data: z } = account ? await db.from("zoom_account").select("zoom_email").eq("id", account).maybeSingle() : { data: null };
      const from = await senderFor(db, owner, { email: (z?.zoom_email as string | null) ?? null });
      if (!from) return `Didn't email ${to.length === 1 ? "the invite" : "the invites"}: ${owner === t.user_id ? "you have" : `${nameOf(owner)} has`} no Gmail on iklipse.`;
      try {
        await sendInvites({ from, host: nameOf(owner), to, m, how });
      } catch (e) {
        console.error("invite", (e as Error).message);
        return "Gmail didn't send the email.";
      }
      return `${how === "cancel" ? "Told" : how === "update" ? "Sent the change to" : "Invite sent to"} ${to.join(", ")}.`;
    };
    const full = async (token: string, zoomId: string) => {
      try {
        return await getMeeting(token, zoomId);
      } catch (e) {
        throw zoomSaid(e);
      }
    };

    if (act.action === "book") {
      const repeat = act.repeat?.type ? act.repeat : state.repeat;
      const kind: MeetingKind = act.kind === "now" ? "instant" : act.kind === "no_time" ? "no_time" : repeat?.type ? "repeat" : "once";
      const said = Math.round(Number(act.minutes)) || 0;
      const topic = str(act.topic) || state.topic || `Meeting${group ? `: ${group}` : ""}`;
      const agenda = str(act.agenda) || state.agenda || "";
      const fresh = emailsOf(act.emails ?? []).good;
      const emails = fresh.length ? fresh : state.emails ?? [];
      const account = await mineToBook();
      const token = await tokenOf(account, t.user_id!);
      let start: number | undefined;
      let minutes: number | undefined;
      let recurrence: Recurrence | null = null;
      if (timedKind(kind)) {
        minutes = Math.max(5, Math.min(24 * 60, said || state.minutes || 30));
        start = startOf(act.date, act.time);
        recurrence = kind === "repeat" ? recurrenceOf(repeat, start) : null;
        // A series: its first meeting must be free.
        const busy = await busyOf(token);
        if (clash(busy, start, minutes)) {
          const day = dayOf(start);
          const r = timesText({ busy, days: [day], search: "", minutes, s, taken: start });
          state = { topic, agenda, minutes, emails, repeat: kind === "repeat" ? repeat : undefined, day: r.shown ?? day };
          await say(r.text);
          return await done("done");
        }
      } else if (said && kind === "instant") {
        minutes = Math.max(5, Math.min(24 * 60, said));
      }
      let m;
      try {
        m = await createMeeting(token, {
          topic,
          kind,
          start_time: start !== undefined ? `${dayOf(start)}T${hm.format(new Date(start))}:00` : undefined,
          timezone: TZ,
          minutes,
          agenda: agenda || undefined,
          recurrence: recurrence ?? undefined,
          settings: emails.length ? { meeting_invitees: emails.map((email) => ({ email })) } : undefined,
        });
      } catch (e) {
        throw zoomSaid(e);
      }
      await db.from("wa_bot_meeting").insert({
        zoom_id: String(m.id),
        thread_id: t.thread_id,
        chat_id: t.chat_id,
        owner: t.user_id,
        account,
        kind,
        topic,
        start_at: iso(start ?? Date.now()),
        minutes: minutes ?? null,
        join_url: m.join_url,
        password: m.password ?? null,
      });
      const info: Invited = { id: String(m.id), topic, kind, start, minutes: minutes ?? null, timezone: TZ, join_url: m.join_url, password: m.password ?? null, agenda, recurrence };
      const line = await invite(account, t.user_id!, emails, info, "new");
      state = {};
      const head = kind === "instant" ? "Start now:" : kind === "no_time" ? "Works any time:" : "Booked:";
      await say([meetingText(head, info), ...(line ? [line] : [])].join("\n"));
      return await done("done");
    }

    if (act.action === "find_times") {
      const moving = state.move ? meetings.find((x) => x.zoom_id === state.move) : undefined;
      const minutes = Math.max(5, Math.min(24 * 60, Math.round(Number(act.minutes)) || state.minutes || moving?.minutes || 30));
      const today = dayOf(Date.now());
      const days = (act.days ?? []).map(str).filter((d) => isDay(d) && d >= today && noon(d) < Date.now() + 120 * DAY);
      const search = act.search === "earliest" || act.search === "nearest_day" ? act.search : "";
      if (!days.length && !search) {
        if (!state.day) throw new Stop(str(act.problem) || "Which day?");
        days.push(state.day);
      }
      const token = moving ? await tokenOf(moving.account, moving.owner) : await tokenOf(await mineToBook(), t.user_id!);
      const busy = await busyOf(token);
      const r = timesText({ busy, days, search, minutes, s, skip: moving?.zoom_id });
      const fresh = emailsOf(act.emails ?? []).good;
      state = {
        ...state,
        topic: str(act.topic) || state.topic,
        agenda: str(act.agenda) || state.agenda,
        emails: fresh.length ? fresh : state.emails,
        repeat: act.repeat?.type ? act.repeat : state.repeat,
        minutes,
        day: r.shown ?? state.day,
      };
      await say(r.text);
      return await done("done");
    }

    if (act.action === "move") {
      const m = findMeeting();
      const timed = timedKind(m.kind);
      const was = Date.parse(m.start_at);
      const date = isDay(str(act.date)) ? str(act.date) : dayOf(was);
      const time = str(act.time) || hm.format(new Date(was));
      const start = timed && (str(act.date) || str(act.time)) ? startOf(date, time) : was;
      const minutes = Math.max(5, Math.min(24 * 60, Math.round(Number(act.minutes)) || m.minutes || 30));
      const topic = str(act.topic) || m.topic;
      const add = [...new Set([...emailsOf(act.emails ?? []).good, ...(state.move === m.zoom_id ? state.emails ?? [] : [])])];
      const token = await tokenOf(m.account, m.owner);
      if (timed && (start !== was || minutes !== m.minutes)) {
        const busy = await busyOf(token);
        if (clash(busy, start, minutes, m.zoom_id)) {
          const r = timesText({ busy, days: [dayOf(start)], search: "", minutes, s, skip: m.zoom_id, taken: start });
          state = { move: m.zoom_id, minutes, emails: add, day: r.shown ?? dayOf(start) };
          await say(r.text);
          return await done("done");
        }
      }
      const before = await full(token, m.zoom_id);
      const had = inviteesOn(before);
      const added = add.filter((e) => !had.includes(e));
      const changed = (timed && (start !== was || minutes !== m.minutes)) || topic !== m.topic;
      if (!changed && !added.length) throw new Stop("What should I change?");
      try {
        await updateMeeting(token, m.zoom_id, {
          topic: topic !== m.topic ? topic : undefined,
          start_time: timed && start !== was ? `${dayOf(start)}T${hm.format(new Date(start))}:00` : undefined,
          timezone: TZ,
          minutes: timed && minutes !== m.minutes ? minutes : undefined,
          settings: added.length ? { meeting_invitees: [...had, ...added].map((email) => ({ email })) } : undefined,
        });
      } catch (e) {
        throw zoomSaid(e);
      }
      await db
        .from("wa_bot_meeting")
        .update({ topic, start_at: iso(start), ...(timed ? { minutes } : {}), updated_at: iso() })
        .eq("zoom_id", m.zoom_id);
      const after = await getMeeting(token, m.zoom_id).catch(() => before);
      const info = { ...invitedFrom(after), topic };
      const lines = [changed ? await invite(m.account, m.owner, had, info, "update") : null, await invite(m.account, m.owner, added, info, "new")].filter(Boolean);
      state = {};
      await say([meetingText("Updated:", info), ...lines].join("\n"));
      return await done("done");
    }

    if (act.action === "cancel") {
      const m = findMeeting();
      const token = await tokenOf(m.account, m.owner);
      const before = await getMeeting(token, m.zoom_id).catch(() => null);
      try {
        await deleteMeeting(token, m.zoom_id);
      } catch (e) {
        throw zoomSaid(e);
      }
      await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).eq("zoom_id", m.zoom_id);
      const line = before ? await invite(m.account, m.owner, inviteesOn(before), invitedFrom(before), "cancel") : null;
      state = {};
      const st = Date.parse(m.start_at);
      const when = m.kind === "repeat" ? ", all of it" : m.kind === "once" ? ` (${weekday(st)} ${dmy(st)}, ${time12(st)})` : ". The link won't work anymore";
      await say([`Cancelled *${m.topic}*${when}.`, ...(line ? [line] : [])].join("\n"));
      return await done("done");
    }
    throw new Stop("Didn't get that. What day and time?");
  } catch (e) {
    const stop = e instanceof Stop;
    if (!stop) console.error("book", (e as Error).message);
    await done("failed", stop ? e.message : `Something went wrong: ${(e as Error).message}`);
    // The admin hears it where they asked, as a reply they can answer.
    try {
      await sayIn(db, reply, t, stop ? e.message : "That didn't go through. Try again in a minute.");
    } catch (e2) {
      console.error("book reply", (e2 as Error).message);
    }
  }
}

/** Every minute: messages left waiting are answered, ones that stopped halfway are said so (never done twice). */
export async function leftovers(db: Db, s: BookSettings, reply: Reply, deadline: number) {
  const report = async (rows: { id: string; thread_id: string; chat_id: string }[] | null, words: string) => {
    for (const r of rows ?? []) {
      try {
        await sayIn(db, reply, r, words);
      } catch (e) {
        console.error("book reply", (e as Error).message);
      }
    }
  };
  const { data: stuck } = await db
    .from("wa_bot_turn")
    .update({ status: "failed", error: "Stopped halfway" })
    .eq("status", "working")
    .lt("started_at", iso(Date.now() - 5 * MIN))
    .select("id, thread_id, chat_id");
  await report(stuck, "This one got stuck halfway. Check Zoom before asking again.");
  const { data: late } = await db
    .from("wa_bot_turn")
    .update({ status: "failed", error: "Too late" })
    .eq("status", "new")
    .lt("created_at", iso(Date.now() - 60 * MIN))
    .select("id, thread_id, chat_id");
  await report(late, "Missed this one. Ask again?");
  const { data: waiting } = await db
    .from("wa_bot_turn")
    .select("id")
    .eq("status", "new")
    .lt("created_at", iso(Date.now() - 2 * MIN))
    .order("created_at")
    .limit(3);
  let answered = 0;
  for (const w of waiting ?? []) {
    if (Date.now() > deadline) break;
    await answer(db, s, w.id, reply);
    answered++;
  }
  // Conversations are kept 30 days; the meetings until a month after they happen
  // (series and links with no set time while they last), cancelled ones a month.
  await db.from("wa_bot_thread").delete().lt("updated_at", iso(Date.now() - 30 * DAY));
  await db.from("wa_bot_meeting").delete().lt("start_at", iso(Date.now() - 30 * DAY)).not("kind", "in", "(repeat,no_time)");
  await db.from("wa_bot_meeting").delete().eq("status", "deleted").lt("updated_at", iso(Date.now() - 30 * DAY));
  return answered;
}
