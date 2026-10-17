// Zoom meetings from WhatsApp (0079): the bot as an assistant the admins talk
// to in a group. A conversation starts only when an admin mentions the bot
// ("@iklipse book a call with them Sunday at 3, an hour, about the new
// campaign"); after that, admins carry it on by replying to the bot's
// messages. It books on that admin's own Zoom (Connections page: the account
// they picked for the bot, when they have more than one) and answers
// as a reply, always in English (whatever language it's asked in): the link,
// the date (25-12-2019) and the time (3:00 PM, Cairo).
// When the time is taken on that Zoom it answers with the free times that day,
// and a reply picks one, or asks for another day, the nearest free day, the
// earliest time, the weekend... A reply about a booked meeting moves or
// cancels it.
//
// Only admins (by the number iklipse has for them) get anything: anyone else
// mentioning the bot or replying to it gets nothing at all. Anything that goes
// wrong (no Zoom, Zoom says no, a request it can't make out) reaches only that
// admin, as an iklipse notification: the group never sees it.

import { accessToken, botAccount, createMeeting, deleteMeeting, updateMeeting, upcomingMeetings } from "../_shared/zoom.ts";
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
  /** The day free times were last shown for. */
  day?: string;
  /** Moving this meeting (its Zoom id). */
  move?: string;
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
  topic: string;
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

/** The active admin with this WhatsApp number (a link in Alerts > Groups wins over a member card). */
async function adminByPhone(db: Db, phone: string): Promise<string | null> {
  const [link, card] = await Promise.all([
    db.from("wa_member").select("user_id").eq("phone", phone).maybeSingle(),
    db.from("profile_contact").select("user_id").eq("whatsapp", phone).limit(1).maybeSingle(),
  ]);
  const id = link.data ? link.data.user_id : card.data?.user_id;
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
  o: { id: string; chatId: string; chatName: string | null; text: string; quoted: string | null; quotedId: string | null; phone: () => Promise<string | null>; botPhone: string | null },
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
  const phone = await o.phone();
  const userId = phone ? await adminByPhone(db, phone) : null;
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

/** "30 minutes", "1 hour 30 minutes" */
function length(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} minutes`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minutes` : ""}`;
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

/** The free times, as the bot says them. */
function timesText(o: { busy: Busy[]; days: string[]; search: string; minutes: number; s: BookSettings; skip?: string; taken?: number }) {
  const lines: string[] = [];
  if (o.taken) lines.push(`${time12(o.taken)} on ${dmy(o.taken)} is taken.`);
  const day = (d: string) => `${weekday(noon(d))} ${dmy(noon(d))}`;
  const list = (free: number[]) => free.map(time12).join(", ");
  const from = o.days[0] ?? dayOf(Date.now());
  let shown: string | undefined;

  if (o.search === "earliest" || o.search === "nearest_day") {
    const hit = nearestDay(o.busy, from, o.minutes, o.s, o.skip);
    if (!hit) lines.push("Nothing is free in the next 3 weeks.");
    else if (o.search === "earliest") {
      lines.push(`The earliest free time: ${weekday(hit.free[0])} ${dmy(hit.free[0])} at ${time12(hit.free[0])}.`);
      shown = hit.day;
    } else {
      lines.push(`Free times on ${day(hit.day)}:`, list(hit.free));
      shown = hit.day;
    }
  } else {
    for (const d of o.days.slice(0, 7)) {
      const free = freeTimes(o.busy, d, o.minutes, o.s, o.skip);
      if (free.length) lines.push("", `Free times on ${day(d)}:`, list(free));
      else lines.push("", `Nothing free on ${day(d)}.`);
      shown ??= d;
    }
    // The day asked for is full: the nearest one that isn't.
    if (o.days.length === 1 && !freeTimes(o.busy, o.days[0], o.minutes, o.s, o.skip).length) {
      const hit = nearestDay(o.busy, dayOf(noon(o.days[0]) + DAY), o.minutes, o.s, o.skip);
      if (hit) lines.push("", `The nearest day with free times: ${day(hit.day)}`, list(hit.free));
    }
  }
  lines.push("", `(${length(o.minutes)}, Cairo time) Reply to this message with the time you want, or ask for another day.`);
  return { text: lines.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n"), shown };
}

/** A booked or moved meeting, as the bot says it. */
function meetingText(head: "booked" | "moved", m: { topic: string; start: number; minutes: number; join_url: string; id: string; password?: string | null }) {
  const zid = m.id.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1 $2 $3");
  return [
    head === "booked" ? "Meeting booked" : "Meeting updated",
    `*${m.topic}*`,
    `Date: ${dmy(m.start)} (${weekday(m.start)})`,
    `Time: ${time12(m.start)} Cairo time`,
    `Length: ${length(m.minutes)}`,
    `Link: ${m.join_url}`,
    `Meeting ID: ${zid}`,
    ...(m.password ? [`Passcode: ${m.password}`] : []),
  ].join("\n");
}

// --------------------------------------------------------------- deciding --

interface Act {
  action: "book" | "find_times" | "move" | "cancel" | "ignore" | "none";
  topic: string;
  agenda: string;
  date: string;
  time: string;
  minutes: number;
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
      topic: { type: "string", description: "book: a short title, in English. move: a new title only when asked, else empty." },
      agenda: { type: "string", description: "book: every other detail given (who's in it, what it's about, notes, links, emails), in English. Empty if none." },
      date: { type: "string", description: "book / move: the day it starts, YYYY-MM-DD. Else empty." },
      time: { type: "string", description: "book / move: the time it starts, HH:MM 24-hour. Else empty." },
      minutes: { type: "integer", description: "How long, when said. 0 when not said." },
      meeting: { type: "string", description: "move / cancel: the meeting's id from the meetings list. Else empty." },
      days: { type: "array", items: { type: "string" }, description: "find_times: the days to show, YYYY-MM-DD, at most 7. Else empty." },
      search: { type: "string", enum: ["", "nearest_day", "earliest"], description: "find_times: nearest_day = the first day with a free time, from days[0] or today; earliest = the earliest free time from then. Empty to show the days as they are." },
      problem: { type: "string", description: "none: what's missing or unclear, one short sentence in English for the admin. Else empty." },
    },
    required: ["action", "topic", "agenda", "date", "time", "minutes", "meeting", "days", "search", "problem"],
  },
};

async function decide(s: BookSettings, ctx: Record<string, unknown>): Promise<Act | null> {
  const system = `You are iklipse, the team's assistant in a WhatsApp group, booking Zoom meetings for the iklipse admins. A conversation with you starts when an admin mentions you ("@iklipse"); admins carry it on by replying to your messages. Decide what to do for the last message in the conversation (an admin's) and call act once. Admins may write in English, Arabic, Egyptian Arabic or Franco-Arabic; everything you write (topic, agenda, problem) is in English.

It is ${nowWords.format(new Date())} in Cairo now. Every day and time is Cairo time. The next days:
${calendar()}
The weekend is Friday and Saturday. Free times are offered between ${s.book_from.slice(0, 5)} and ${s.book_to.slice(0, 5)}.

- book: book a new meeting; it needs the day and the time. In a reply, take what isn't said again (title, details, length, the day) from the conversation and from "pending": after you offered free times, "4" or "خليها 4 ونص" books that time on that day with the same title.
- find_times: they ask what's free: a day ("خلينا يوم الحد"), the nearest free day ("أقرب يوم فاضي"), the earliest time ("أبدر معاد"), the weekend (its two days), this week. A day with no time means the free times that day.
- move: change the day, time, length or title of a meeting from the meetings list (a reply to your confirmation of a meeting is about that one). "pending" with move: a reply picking a time moves that meeting.
- cancel: cancel a meeting from the meetings list.
- ignore: nothing asked (thanks, ok, a remark to someone else).
- none: anything else, or the day or time is missing or unclear and the conversation doesn't give it. Say what's missing in problem. Never invent a day or a time.

Times: with no AM or PM, the sensible working-hours one (3 is 15:00, 10 is 10:00, 7 is 19:00) unless the words say otherwise (الصبح، الضهر، العصر، المغرب، بالليل). "3 ونص" is 15:30, "3 وربع" 15:15. Only a time and no day: today if that time is still ahead, else none. Weekdays mean the next one coming.`;
  const r = await claude(s.model, system, JSON.stringify(ctx), TOOL, 900);
  return r && typeof r === "object" && typeof r.action === "string" ? (r as Act) : null;
}

// --------------------------------------------------------------- answering --

/** The admin hears about it inside iklipse (and on their phone); the group never does. */
async function tell(db: Db, o: { user_id: string | null; group: string | null; text: string }, error: string, extra: { path?: string; join_url?: string } = {}) {
  if (!o.user_id) return;
  await db.from("notification").insert({
    user_id: o.user_id,
    kind: "meeting_book_failed",
    data: { error, group: o.group, excerpt: o.text.slice(0, 200), ...extra },
  });
}

class Stop extends Error {
  constructor(message: string, public extra: { path?: string; join_url?: string } = {}) {
    super(message);
  }
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

  try {
    // The conversation so far, the meetings booked from this group, and who's who.
    const { data: turns } = await db
      .from("wa_bot_turn")
      .select("id, from_bot, user_id, text, quoted, created_at")
      .eq("thread_id", t.thread_id)
      .lte("created_at", t.created_at)
      .order("created_at", { ascending: false })
      .limit(20);
    const { data: ms } = await db
      .from("wa_bot_meeting")
      .select("zoom_id, owner, account, topic, start_at, minutes, join_url, password")
      .eq("chat_id", t.chat_id)
      .eq("status", "booked")
      .gt("start_at", iso(Date.now() - 60 * MIN))
      .order("start_at")
      .limit(30);
    const meetings = (ms ?? []) as Meeting[];
    const ids = [...new Set([...(turns ?? []).map((x) => x.user_id), ...meetings.map((m) => m.owner)].filter(Boolean))] as string[];
    const { data: ps } = ids.length ? await db.from("profile").select("id, display_name").in("id", ids) : { data: [] };
    const nameOf = (u: string | null) => (ps ?? []).find((p) => p.id === u)?.display_name || "An admin";
    const history = (turns ?? []).reverse();

    const act = await decide(s, {
      group,
      pending: state,
      meetings: meetings.map((m) => ({ id: m.zoom_id, topic: m.topic, date: dayOf(Date.parse(m.start_at)), time: hm.format(new Date(m.start_at)), minutes: m.minutes, booked_by: nameOf(m.owner) })),
      conversation: history.map((x) => ({
        from: x.from_bot ? "iklipse" : `${nameOf(x.user_id)} (admin)`,
        at: `${dayOf(Date.parse(x.created_at))} ${hm.format(new Date(x.created_at))}`,
        text: x.text,
        ...(x.quoted ? { replying_to: x.quoted } : {}),
      })),
    });
    if (!act) throw new Stop("Couldn't read the message. Try again, with the day, the time and what it's about.");
    if (act.action === "ignore") return await done("done");
    if (act.action === "none") throw new Stop(str(act.problem) || "Couldn't tell what to do. Say the day, the time and what it's about.");

    const say = async (text: string, extra: { join_url?: string } = {}) => {
      let sent: string | null;
      try {
        sent = await reply(t.chat_id, text, t.id);
      } catch (e) {
        throw new Stop(`Couldn't post the answer in the group: ${(e as Error).message}`, extra);
      }
      if (sent) await db.from("wa_bot_turn").upsert({ id: sent, thread_id: t.thread_id, chat_id: t.chat_id, from_bot: true, text, status: "done" }, { onConflict: "id", ignoreDuplicates: true });
    };
    // New meetings go on the asking admin's bot account; a booked one stays on its own account.
    const mineToBook = async () => {
      const account = await botAccount(db, t.user_id!);
      if (!account) throw new Stop("Connect your Zoom account first, on the Connections page. Then ask again.", { path: "/connections" });
      return account;
    };
    const tokenOf = async (account: string | null, owner: string) => {
      const token = account ? await accessToken(db, account) : null;
      if (token) return token;
      if (!account) throw new Stop(`The Zoom account this meeting is on was disconnected${owner === t.user_id ? "" : ` by ${nameOf(owner)}`}, so it can't be changed from here.`);
      throw owner === t.user_id
        ? new Stop("Your Zoom account needs connecting again, on the Connections page.", { path: "/connections" })
        : new Stop(`${nameOf(owner)}'s Zoom needs connecting again, so their meeting can't be changed from here.`);
    };
    const busyOf = async (token: string) => {
      try {
        return await busyOn(token);
      } catch (e) {
        throw new Stop(`Zoom wouldn't list the meetings, so free times can't be checked: ${(e as Error).message}`);
      }
    };
    const startOf = (date: string, time: string) => {
      const tm = str(time).replace(/^(\d):/, "0$1:");
      if (!isDay(date) || !/^\d{2}:\d{2}$/.test(tm)) throw new Stop(str(act.problem) || "The day or the time is missing. Reply with both.");
      const start = at(date, tm);
      if (Number.isNaN(start)) throw new Stop(`Couldn't make sense of the time (${date} ${time}).`);
      if (start < Date.now() - 5 * MIN) throw new Stop(`That time has passed (${dmy(start)} ${time12(start)}). Reply with a time ahead.`);
      if (start > Date.now() + 400 * DAY) throw new Stop("That's more than a year away. Reply with the right date.");
      return start;
    };
    const findMeeting = () => {
      const m = meetings.find((x) => x.zoom_id === str(act.meeting)) ?? meetings.find((x) => x.zoom_id === state.move);
      if (!m) throw new Stop("Couldn't tell which meeting. Reply to the bot's message about that meeting, or say its day and time.");
      return m;
    };

    if (act.action === "book") {
      const minutes = Math.max(5, Math.min(24 * 60, Math.round(Number(act.minutes)) || state.minutes || 30));
      const topic = str(act.topic) || state.topic || `Meeting${group ? `: ${group}` : ""}`;
      const agenda = str(act.agenda) || state.agenda || "";
      const start = startOf(act.date, act.time);
      const account = await mineToBook();
      const token = await tokenOf(account, t.user_id!);
      const busy = await busyOf(token);
      if (clash(busy, start, minutes)) {
        const day = dayOf(start);
        const r = timesText({ busy, days: [day], search: "", minutes, s, taken: start });
        state = { topic, agenda, minutes, day: r.shown ?? day };
        await say(r.text);
        return await done("done");
      }
      let m;
      try {
        m = await createMeeting(token, { topic, start_time: `${dayOf(start)}T${hm.format(new Date(start))}:00`, timezone: TZ, minutes, agenda: agenda || undefined });
      } catch (e) {
        throw new Stop(`Zoom said no: ${(e as Error).message}`);
      }
      await db.from("wa_bot_meeting").insert({
        zoom_id: String(m.id),
        thread_id: t.thread_id,
        chat_id: t.chat_id,
        owner: t.user_id,
        account,
        topic,
        start_at: iso(start),
        minutes,
        join_url: m.join_url,
        password: m.password ?? null,
      });
      state = {};
      await say(meetingText("booked", { topic, start, minutes, join_url: m.join_url, id: String(m.id), password: m.password }), { join_url: m.join_url });
      return await done("done");
    }

    if (act.action === "find_times") {
      const moving = state.move ? meetings.find((x) => x.zoom_id === state.move) : undefined;
      const minutes = Math.max(5, Math.min(24 * 60, Math.round(Number(act.minutes)) || state.minutes || moving?.minutes || 30));
      const today = dayOf(Date.now());
      const days = (act.days ?? []).map(str).filter((d) => isDay(d) && d >= today && noon(d) < Date.now() + 120 * DAY);
      const search = act.search === "earliest" || act.search === "nearest_day" ? act.search : "";
      if (!days.length && !search) {
        if (!state.day) throw new Stop(str(act.problem) || "Which day? Reply with the day.");
        days.push(state.day);
      }
      const token = moving ? await tokenOf(moving.account, moving.owner) : await tokenOf(await mineToBook(), t.user_id!);
      const busy = await busyOf(token);
      const r = timesText({ busy, days, search, minutes, s, skip: moving?.zoom_id });
      state = { ...state, topic: str(act.topic) || state.topic, agenda: str(act.agenda) || state.agenda, minutes, day: r.shown ?? state.day };
      await say(r.text);
      return await done("done");
    }

    if (act.action === "move") {
      const m = findMeeting();
      const was = Date.parse(m.start_at);
      const date = isDay(str(act.date)) ? str(act.date) : dayOf(was);
      const time = str(act.time) || hm.format(new Date(was));
      const start = str(act.date) || str(act.time) ? startOf(date, time) : was;
      const minutes = Math.max(5, Math.min(24 * 60, Math.round(Number(act.minutes)) || m.minutes));
      const topic = str(act.topic) || m.topic;
      const token = await tokenOf(m.account, m.owner);
      if (start !== was || minutes !== m.minutes) {
        const busy = await busyOf(token);
        if (clash(busy, start, minutes, m.zoom_id)) {
          const r = timesText({ busy, days: [dayOf(start)], search: "", minutes, s, skip: m.zoom_id, taken: start });
          state = { move: m.zoom_id, minutes, day: r.shown ?? dayOf(start) };
          await say(r.text);
          return await done("done");
        }
      }
      try {
        await updateMeeting(token, m.zoom_id, {
          topic: topic !== m.topic ? topic : undefined,
          start_time: start !== was ? `${dayOf(start)}T${hm.format(new Date(start))}:00` : undefined,
          timezone: TZ,
          minutes: minutes !== m.minutes ? minutes : undefined,
        });
      } catch (e) {
        throw new Stop(`Zoom said no: ${(e as Error).message}`);
      }
      await db.from("wa_bot_meeting").update({ topic, start_at: iso(start), minutes, updated_at: iso() }).eq("zoom_id", m.zoom_id);
      state = {};
      await say(meetingText("moved", { topic, start, minutes, join_url: m.join_url, id: m.zoom_id, password: m.password }));
      return await done("done");
    }

    if (act.action === "cancel") {
      const m = findMeeting();
      const token = await tokenOf(m.account, m.owner);
      try {
        await deleteMeeting(token, m.zoom_id);
      } catch (e) {
        throw new Stop(`Zoom said no: ${(e as Error).message}`);
      }
      await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).eq("zoom_id", m.zoom_id);
      state = {};
      const st = Date.parse(m.start_at);
      await say(`Meeting cancelled\n*${m.topic}*\nIt was on ${dmy(st)} at ${time12(st)}`);
      return await done("done");
    }
    throw new Stop("Couldn't tell what to do. Say the day, the time and what it's about.");
  } catch (e) {
    const stop = e instanceof Stop;
    if (!stop) console.error("book", (e as Error).message);
    const error = stop ? e.message : `Something went wrong: ${(e as Error).message}`;
    await done("failed", error);
    await tell(db, { user_id: t.user_id, group, text: t.text }, error, stop ? e.extra : {});
  }
}

/** Every minute: messages left waiting are answered, ones that stopped halfway are reported (never done twice). */
export async function leftovers(db: Db, s: BookSettings, reply: Reply, deadline: number) {
  const report = async (rows: { user_id: string | null; text: string; wa_bot_thread: unknown }[] | null, error: string) => {
    for (const r of rows ?? []) await tell(db, { user_id: r.user_id, group: (r.wa_bot_thread as { chat_name: string | null } | null)?.chat_name ?? null, text: r.text }, error);
  };
  const { data: stuck } = await db
    .from("wa_bot_turn")
    .update({ status: "failed", error: "Stopped halfway" })
    .eq("status", "working")
    .lt("started_at", iso(Date.now() - 5 * MIN))
    .select("user_id, text, wa_bot_thread(chat_name)");
  await report(stuck, "iklipse stopped halfway through this. Check your Zoom before asking again.");
  const { data: late } = await db
    .from("wa_bot_turn")
    .update({ status: "failed", error: "Too late" })
    .eq("status", "new")
    .lt("created_at", iso(Date.now() - 60 * MIN))
    .select("user_id, text, wa_bot_thread(chat_name)");
  await report(late, "iklipse couldn't get to this in time. Ask again in the group.");
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
  // Conversations are kept 30 days; the meetings until a month after they happen.
  await db.from("wa_bot_thread").delete().lt("updated_at", iso(Date.now() - 30 * DAY));
  await db.from("wa_bot_meeting").delete().lt("start_at", iso(Date.now() - 30 * DAY));
  return answered;
}
