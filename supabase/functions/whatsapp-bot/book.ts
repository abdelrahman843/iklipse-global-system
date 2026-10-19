// Meetings from WhatsApp (0079, on Calendly since 0084, private since 0088):
// the bot as an assistant the admins talk to. A conversation starts only when
// an admin mentions the bot in a group ("@iklipse book a call with @Sara
// Sunday at 3 about the new campaign"). It books on that admin's own Calendly
// (the account and event type they picked for the bot on the Connections
// page): a meeting with the people named (by mention or by name: the group's
// people, the team), at an open time; Calendly emails them the invite and the
// link. Its length is the event type's: one of that length is used when asked
// for another one. Always English (whatever language it's asked in), short,
// the way a person texts: the date (25-12-2019), the time (3:00 PM, Cairo),
// the link. No greetings, no apologies, no offers of more help.
//
// In the group the bot only says what was done: booked (with the link),
// moved, cancelled, or the booking link sent. Everything else (a question, a
// time that isn't free, a full day, Calendly saying no) it tells the admin
// privately (in the group when iklipse has no number for them), and the
// conversation carries on there, or by replying to its messages in the group.
// A client with no email: it's asked where the bot asks (Settings), and the
// meeting is booked once it's in. Once booked, everyone on it iklipse knows
// gets the details privately, and a reminder an hour before (meetings.ts).
// A reply about a booked meeting moves it (the new time booked, then the old
// one cancelled: Calendly tells them both) or cancels it. What Calendly can't
// do it says: a series, a link right now, adding people to a booked meeting.
// Booking for someone needs a paid Calendly plan (Standard and up).
//
// Only admins (by the number iklipse has for them) get anything: anyone else
// mentioning the bot or replying to it gets nothing at all. In a team group
// (0090) everyone on the team can: a mention there is an order (orders.ts),
// which hands meetings over here, and a reply to the bot carries it on. Someone
// with no Calendly of their own books on the one picked for clients' booking link.

import { accessToken, book, botAccount, cancelEvent, emailsOf, eventTypes, linkOf, missingScopes, nameFromEmail, openTimes, typeFor, type EventType } from "../_shared/calendly.ts";
import { cairoOffset, claude, iso, MIN, str, TZ, type Db, type Settings } from "./kit.ts";
import { askPlace, phoneKey, type Send } from "./people.ts";
import { directory, tellMeeting, type Attendee } from "./meetings.ts";

/** What a conversation is arranging, between messages. */
interface State {
  topic?: string;
  agenda?: string;
  minutes?: number;
  /** Who it's with (the admin who asked is the host). */
  who?: Attendee[];
  /** The day free times were last shown for. */
  day?: string;
  /** Moving this meeting (its Calendly id). */
  move?: string;
  /** Waiting for clients' emails, then booked at this time, for this admin. */
  waiting?: { date: string; time: string; by: string };
}

interface Meeting {
  event_id: string;
  owner: string;
  account: string | null;
  topic: string;
  start_at: string;
  minutes: number;
  join_url: string | null;
  invitee_email: string | null;
  invitee_name: string | null;
  attendees: Attendee[] | null;
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

interface Thread {
  id: string;
  /** The group it started in. */
  chat_id: string;
  chat_name: string | null;
  state: State;
}

const DAY = 24 * 60 * MIN;
const tagsIn = (text: string) => [...text.matchAll(/@(\d{8,15})\b/g)].map((m) => m[1]);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// -------------------------------------------------------------- listening --

/** The ids a mention of the bot can carry: its number, and its WhatsApp lid in the groups. */
export async function botIds(db: Db, bot: string) {
  const { data } = await db.from("wa_participant").select("lid").eq("phone", bot).not("lid", "is", null).limit(20);
  return new Set([bot, ...(data ?? []).map((p) => str(p.lid).split("@")[0]).filter(Boolean)]);
}

/** The message mentions the bot. */
export async function mentionsBot(db: Db, text: string, bot: string | null) {
  const tags = tagsIn(text);
  if (!tags.length || !bot) return false;
  const ids = await botIds(db, bot);
  return tags.some((d) => ids.has(d));
}

/**
 * The active admin with this WhatsApp number (a link in Alerts > Groups wins
 * over a member card), or, when WhatsApp hides the number, with this
 * WhatsApp id linked in Alerts > Groups (0080). anyone: anyone active on the
 * team (a team group, 0090).
 */
async function adminOf(db: Db, phone: string | null, sender: string, anyone = false): Promise<string | null> {
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
  return p?.is_active && (anyone || p.role === "admin") ? id : null;
}

/** Mentions as names: "@iklipse" for the bot, the group's names for the others. */
export async function named(db: Db, chatId: string, text: string, bot: Set<string>) {
  const others = [...new Set(tagsIn(text))].filter((d) => !bot.has(d));
  const names = new Map<string, string>();
  if (others.length) {
    const { data } = await db
      .from("wa_participant")
      .select("phone, lid, name")
      .eq("chat_id", chatId)
      .or(others.map((d) => `phone.eq.${d},lid.eq.${d}@lid`).join(","));
    const dir = await directory(db);
    for (const p of data ?? []) {
      // Who iklipse knows them as, else their WhatsApp name.
      const team = [...dir.team.values()].find((a) => a.phone && a.phone === p.phone);
      const client = [...dir.clients.values()].find((a) => a.phone && a.phone === p.phone);
      const nm = team?.name ?? client?.name ?? p.name;
      if (!nm) continue;
      if (p.phone) names.set(p.phone, nm);
      if (p.lid) names.set(str(p.lid).split("@")[0], nm);
    }
  }
  return text.replace(/@(\d{8,15})\b/g, (all, d: string) => (bot.has(d) ? "@iklipse" : names.has(d) ? `@${names.get(d)}` : all));
}

/**
 * A group message. An admin mentioning the bot starts a conversation; an
 * admin replying to one of the bot's messages carries that one on. The
 * message is kept (once, however often WhatsApp sends it) and true comes
 * back: answer it now. Anything else, and anyone else: false, nothing kept.
 * team (a team group taking orders, 0090): anyone on the team carries one on;
 * a mention is an order (orders.ts), so it starts nothing here.
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
    team?: boolean;
  },
): Promise<boolean> {
  let threadId: string | null = null;
  if (o.quotedId) {
    const { data: t } = await db.from("wa_bot_turn").select("thread_id").eq("id", o.quotedId).eq("from_bot", true).maybeSingle();
    threadId = t?.thread_id ?? null;
  }
  const tags = tagsIn(o.text);
  if (!threadId && (!tags.length || o.team)) return false;
  const { data: s } = await db.from("watch_settings").select("book_enabled, bot_phone").eq("id", 1).single();
  const bot = o.botPhone ?? s?.bot_phone;
  if (!s?.book_enabled || !bot) return false;
  const ids = await botIds(db, bot);
  if (!threadId && !tags.some((d) => ids.has(d))) return false;
  const userId = await adminOf(db, await o.phone(), o.sender, !!o.team);
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

/** When the bot last wrote to this private chat about a meeting (null: not in the last day), or wrote the message replied to. */
export async function bookTurnAt(db: Db, chatId: string, quotedId: string | null): Promise<string | null> {
  if (quotedId) {
    const { data } = await db.from("wa_bot_turn").select("created_at").eq("id", quotedId).eq("from_bot", true).maybeSingle();
    return (data?.created_at as string | undefined) ?? null;
  }
  const { data } = await db
    .from("wa_bot_turn")
    .select("created_at")
    .eq("chat_id", chatId)
    .eq("from_bot", true)
    .gt("created_at", iso(Date.now() - DAY))
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0]?.created_at as string | undefined) ?? null;
}

/**
 * An admin answering the bot privately about a meeting: kept as a turn of
 * that conversation (the one the message replies to, else the last one the
 * bot wrote about there). true: answer it now.
 */
export async function heardPrivate(db: Db, o: { id: string; chatId: string; text: string; quotedId: string | null; phone: string }): Promise<boolean> {
  // Anyone on the team: the bot only wrote to them about a conversation they're in.
  const userId = await adminOf(db, o.phone, o.chatId, true);
  if (!userId) return false;
  const q = o.quotedId
    ? db.from("wa_bot_turn").select("thread_id").eq("id", o.quotedId).eq("from_bot", true).limit(1)
    : db.from("wa_bot_turn").select("thread_id").eq("chat_id", o.chatId).eq("from_bot", true).gt("created_at", iso(Date.now() - DAY)).order("created_at", { ascending: false }).limit(1);
  const { data: hit } = await q;
  const threadId = hit?.[0]?.thread_id as string | undefined;
  if (!threadId) return false;
  const { data } = await db
    .from("wa_bot_turn")
    .upsert({ id: o.id, thread_id: threadId, chat_id: o.chatId, user_id: userId, text: o.text.slice(0, 4000), status: "new" }, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  return !!data?.length;
}

/**
 * A meeting ordered in a team group (orders.ts, 0090): a conversation started
 * for the one who asked, like a mention. true: answer it now.
 */
export async function orderedMeeting(db: Db, o: { id: string; chatId: string; text: string; quoted: string | null; userId: string }): Promise<boolean> {
  const { data: g } = await db.from("wa_group").select("name").eq("chat_id", o.chatId).maybeSingle();
  const { data: t, error } = await db.from("wa_bot_thread").insert({ chat_id: o.chatId, chat_name: g?.name ?? null, started_by: o.userId }).select("id").single();
  if (error || !t) throw new Error(error?.message ?? "Couldn't start the conversation");
  const { data } = await db
    .from("wa_bot_turn")
    .upsert(
      { id: o.id, thread_id: t.id, chat_id: o.chatId, user_id: o.userId, text: o.text.slice(0, 4000), quoted: o.quoted?.slice(0, 4000) ?? null, status: "new" },
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
const time12 = (ms: number) => clock.format(new Date(ms)).replace(/[  ]/g, " ");
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

/** "Sara, Rabah and Omar" */
const namesOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ------------------------------------------------------------- free times --

/** The first day from this one (up to 3 weeks on) with a free time. */
function nearestDay(freeOn: (date: string) => number[], from: string) {
  for (let i = 0; i < 21; i++) {
    const d = dayOf(noon(from) + i * DAY);
    const free = freeOn(d);
    if (free.length) return { day: d, free };
  }
  return null;
}

/** Free times (freeOn: a day's free start times), the way a person would text them. */
function timesText(freeOn: (date: string) => number[], o: { days: string[]; search: string; minutes: number; taken?: number }) {
  const day = (d: string) => `${weekday(noon(d))} ${dmy(noon(d))}`;
  const list = (free: number[]) => free.map(time12).join(", ");
  // The length only when it isn't the usual half hour.
  const len = o.minutes === 30 ? "" : ` (${length(o.minutes)})`;
  const lines: string[] = o.taken ? [`${time12(o.taken)} isn't free.`] : [];
  const from = o.days[0] ?? dayOf(Date.now());
  let shown: string | undefined;
  let ask = "Which time?";

  if (o.search === "earliest" || o.search === "nearest_day") {
    const hit = nearestDay(freeOn, from);
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
    const free = freeOn(d);
    shown = d;
    if (free.length) lines.push(`Free on ${day(d)}${len}:`, list(free));
    else {
      // That day is full: the nearest one that isn't.
      const hit = nearestDay(freeOn, dayOf(noon(d) + DAY));
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
      const free = freeOn(d);
      any ||= free.length > 0;
      lines.push(`${day(d)}: ${free.length ? list(free) : "nothing free"}`);
      shown ??= d;
    }
    if (!any) ask = "";
  }
  if (ask) lines.push(ask);
  return { text: lines.join("\n"), shown };
}

// ------------------------------------------------------------------ people --

interface Person extends Attendee {
  ref: string;
  in_group: boolean;
}

/**
 * Who a meeting can be with: the group's people (the team, clients) and the
 * rest of the team, each with a ref Claude names them by. The admin asking
 * isn't in it (they're always on it).
 */
async function peopleFor(db: Db, chatId: string, me: string, bot: string | null) {
  const dir = await directory(db);
  const { data: parts } = await db.from("wa_participant").select("wa_id, phone, lid, name").eq("chat_id", chatId);
  const [{ data: lids }, { data: links }] = await Promise.all([db.from("wa_member_lid").select("lid, user_id"), db.from("wa_member").select("phone, user_id")]);
  const lidUser = new Map((lids ?? []).map((l) => [l.lid as string, l.user_id as string]));
  const phoneUser = new Map((links ?? []).map((l) => [l.phone as string, l.user_id as string]));
  const { data: cl } = await db.from("client").select("id, phone, wa_lid");
  const out = new Map<string, Person>();
  const add = (p: Person) => out.has(p.ref) || out.set(p.ref, p);
  for (const p of parts ?? []) {
    const phone = (p.phone as string | null) || null;
    const lid = str(p.lid) || (str(p.wa_id).endsWith("@lid") ? str(p.wa_id) : "") || null;
    if (phone && phone === bot) continue;
    const user =
      (phone && phoneUser.has(phone) ? dir.team.get(phoneUser.get(phone)!) : undefined) ??
      [...dir.team.values()].find((a) => a.phone && a.phone === phone) ??
      (lid && lidUser.has(lid) ? dir.team.get(lidUser.get(lid)!) : undefined);
    if (user) {
      if (user.id !== me) add({ ...user, ref: `t:${user.id}`, in_group: true });
      continue;
    }
    const c = (cl ?? []).find((x) => (phone && phoneKey(x.phone) === phone) || (lid && x.wa_lid === lid));
    const client = c ? dir.clients.get(c.id) : undefined;
    if (client) add({ ...client, ref: `c:${client.id}`, in_group: true });
    else add({ kind: "guest", id: null, name: str(p.name) || (phone ? `+${phone}` : "Someone"), email: null, phone, ref: `w:${phone ?? lid}`, in_group: true });
  }
  for (const a of dir.team.values()) if (a.id !== me) add({ ...a, ref: `t:${a.id}`, in_group: false });
  // From a team group (0090): any client, by name.
  const { data: g } = await db.from("wa_group").select("kind").eq("chat_id", chatId).maybeSingle();
  if (g?.kind === "team") for (const a of dir.clients.values()) add({ ...a, ref: `c:${a.id}`, in_group: false });
  return { people: [...out.values()], dir };
}

// --------------------------------------------------------------- deciding --

interface Act {
  action: "book" | "find_times" | "move" | "cancel" | "link" | "ignore" | "none";
  topic: string;
  agenda: string;
  date: string;
  time: string;
  minutes: number;
  who: { ref?: string; name?: string; email?: string }[];
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
      action: { type: "string", enum: ["book", "find_times", "move", "cancel", "link", "ignore", "none"] },
      topic: { type: "string", description: "book: a short title, in English. move: a new title only when asked, else empty." },
      agenda: { type: "string", description: "book: every other detail given (what it's about, notes, links), in English. Empty if none." },
      date: { type: "string", description: "book / move: the day, YYYY-MM-DD. Else empty." },
      time: { type: "string", description: "book / move: the time it starts, HH:MM 24-hour. Else empty." },
      minutes: { type: "integer", description: "How long, when said. 0 when not said." },
      who: {
        type: "array",
        description:
          "book: everyone it's with, besides the admin who asked (always on it). ref: their ref from people, when they're there (a mention shows as @Name). Someone not there: their name and email as written. email: only an address written in the conversation (for someone in people too, when they give it). Empty when nobody new is named (pending has who). move: people they ask to add. Else empty.",
        items: {
          type: "object",
          properties: { ref: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
        },
      },
      meeting: { type: "string", description: "move / cancel: the meeting's id from the meetings list. Else empty." },
      days: { type: "array", items: { type: "string" }, description: "find_times: the days to show, YYYY-MM-DD, at most 7. Else empty." },
      search: { type: "string", enum: ["", "nearest_day", "earliest"], description: "find_times: nearest_day = the first day with a free time, from days[0] or today; earliest = the earliest free time from then. Empty to show the days as they are." },
      problem: {
        type: "string",
        description: "none: what you'd text back, in English, like a person on WhatsApp: a few words, usually a short question (\"What time?\", \"Which day?\", \"Who's it with?\"). No greeting, no apology, no please, no thanks, no offer of more help. Else empty.",
      },
    },
    required: ["action", "topic", "agenda", "date", "time", "minutes", "who", "meeting", "days", "search", "problem"],
  },
};

async function decide(s: Settings, ctx: Record<string, unknown>): Promise<Act | null> {
  const system = `You are iklipse, the team's assistant on WhatsApp, booking meetings on the iklipse admins' Calendly. A conversation with you starts when an admin mentions you ("@iklipse") in a group; it carries on in the group, by replying to your messages, or privately with you. Decide what to do for the last message in the conversation (an admin's) and call act once. Admins may write in English, Arabic, Egyptian Arabic or Franco-Arabic; everything you write (topic, agenda, problem) is in English.

It is ${nowWords.format(new Date())} in Cairo now. Every day and time is Cairo time. The next days:
${calendar()}
The weekend is Friday and Saturday. "lengths": the meeting lengths the admin's Calendly has, in minutes. "people": who a meeting can be with (the group's people, then the rest of the team), by ref; "has_email" says if iklipse has their email (it finds the rest itself).

- book: a meeting at a day and a time with the people named. It needs the day, the time and who it's with. In a reply, take what isn't said again (title, details, length, the day, the time, who it's with) from the conversation and from "pending": after you offered free times, "4" or "خليها 4 ونص" books that time on that day; after you said a day is full, a new day or time books that. After you offered one time ("Earliest free: ... Book it?"), a yes ("ok", "تمام", "احجزه", "yes") books that time. "بيني وبين" / "between me and" means the admin and those people.
- find_times: they ask what's free: a day ("خلينا يوم الحد"), the nearest free day ("أقرب يوم فاضي"), the earliest time ("أبدر معاد"), the weekend (its two days), this week. A day with no time means the free times that day.
- move: change the day, time, length or title of a meeting from the meetings list (a reply to your message about a meeting is about that one). "pending" with move: a reply picking a time moves that meeting.
- cancel: cancel a meeting from the meetings list.
- link: they want a link people book a time on themselves ("ابعتلهم لينك يحجزوا", "send my calendly link", "لينك الحجز").
- ignore: nothing asked (thanks, ok after a booking, a remark to someone else).
- none: anything else, or the day, the time or who it's with is missing and the conversation doesn't give it. Say what's missing in problem. Calendly books one meeting at a time: for a series (every week...) or a link right now, say in problem that Calendly books one meeting at a time, so give a day and time. Never invent a day, a time, a person or an email address.

Times: with no AM or PM, the sensible working-hours one (3 is 15:00, 10 is 10:00, 7 is 19:00) unless the words say otherwise (الصبح، الضهر، العصر، المغرب، بالليل). "3 ونص" is 15:30, "3 وربع" 15:15. Only a time and no day: today if that time is still ahead, else none. Weekdays mean the next one coming.`;
  const r = await claude(s.model, system, JSON.stringify(ctx), TOOL, 1200);
  return r && typeof r === "object" && typeof r.action === "string" ? (r as Act) : null;
}

/** Calendly's no, in words an admin can act on. */
function said(e: unknown) {
  const msg = (e as Error).message;
  if (/only available on paid Calendly plans/i.test(msg)) return new Stop("Booking from here needs a paid Calendly plan (Standard or higher).");
  if (missingScopes(e)) return new Stop("Your Calendly needs connecting again on iklipse.");
  return new Stop(`Calendly didn't take it: ${msg}`);
}

// ----------------------------------------------------------------- talking --

/** Something the admin has to hear (privately). */
class Stop extends Error {}

/** The admin's private chat with the bot, when iklipse has their number. */
async function privateChat(db: Db, userId: string): Promise<string | null> {
  const [card, link] = await Promise.all([
    db.from("profile_contact").select("whatsapp").eq("user_id", userId).maybeSingle(),
    db.from("wa_member").select("phone").eq("user_id", userId).order("created_at").limit(1),
  ]);
  const phone = card.data?.whatsapp ?? link.data?.[0]?.phone;
  return phone ? `${phone}@c.us` : null;
}

/**
 * Where the bot speaks in a conversation: post (in the group: only what was
 * done) and tell (privately to the admin; in the group when iklipse has no
 * number for them). Both are kept as the bot's turns, so a reply carries on.
 */
function talk(db: Db, send: Send, th: Thread, userId: string, turn: Turn | null) {
  let dm: string | null | undefined;
  const keep = async (id: string | null, chat: string, text: string) => {
    if (id) await db.from("wa_bot_turn").upsert({ id, thread_id: th.id, chat_id: chat, from_bot: true, text, status: "done" }, { onConflict: "id", ignoreDuplicates: true });
  };
  const post = async (text: string) => {
    let quote = turn && turn.chat_id === th.chat_id ? turn.id : null;
    if (!quote) {
      const { data } = await db.from("wa_bot_turn").select("id").eq("thread_id", th.id).eq("chat_id", th.chat_id).eq("from_bot", false).order("created_at", { ascending: false }).limit(1);
      quote = (data?.[0]?.id as string | undefined) ?? null;
    }
    await keep(await send(th.chat_id, text, quote), th.chat_id, text);
  };
  const tell = async (text: string) => {
    if (dm === undefined) dm = await privateChat(db, userId);
    if (!dm) return await post(text);
    await keep(await send(dm, text, turn && turn.chat_id === dm ? turn.id : null), dm, text);
  };
  return { post, tell };
}

// ---------------------------------------------------------------- Calendly --

interface Cal {
  id: string;
  token: string;
  picked: string | null;
  types: EventType[];
}

/** An admin's Calendly for the bot: the account, a token, its event types. With none of their own, the clients' booking link's (0090). */
async function calendlyOf(db: Db, userId: string): Promise<Cal> {
  let account = await botAccount(db, userId);
  if (!account) {
    const { data: st } = await db.from("watch_settings").select("book_link_account").eq("id", 1).single();
    account = (st?.book_link_account as string | null) ?? null;
  }
  if (!account) throw new Stop("Your Calendly isn't connected on iklipse yet. Connect it, then ask again.");
  const { data: a } = await db.from("calendly_account").select("id, calendly_user, event_type").eq("id", account).single();
  const token = await accessToken(db, account);
  if (!token || !a) throw new Stop("Your Calendly needs connecting again on iklipse.");
  let types: EventType[];
  try {
    types = await eventTypes(token, a.calendly_user as string);
  } catch (e) {
    throw new Stop(`Couldn't read your Calendly: ${(e as Error).message}`);
  }
  if (!types.length) throw new Stop("Your Calendly has no event type to book with. Make one on Calendly, then ask again.");
  return { id: account, token, picked: (a.event_type as string | null) ?? null, types };
}

/** The Calendly a booked meeting is on. */
async function calendlyOfMeeting(db: Db, m: Meeting, whose: string): Promise<Cal> {
  if (!m.account) throw new Stop("The Calendly this meeting is on was disconnected, so I can't change it from here.");
  const token = await accessToken(db, m.account);
  if (!token) throw new Stop(`${whose} Calendly needs connecting again on iklipse.`);
  const { data: a } = await db.from("calendly_account").select("calendly_user, event_type").eq("id", m.account).single();
  let types: EventType[];
  try {
    types = await eventTypes(token, a!.calendly_user as string);
  } catch (e) {
    throw new Stop(`Couldn't read the Calendly: ${(e as Error).message}`);
  }
  return { id: m.account, token, types, picked: (a?.event_type as string | null) ?? null };
}

function typeOf(types: EventType[], picked: string | null, minutes?: number) {
  const et = typeFor(types, picked, minutes);
  if (!et) {
    const have = [...new Set(types.map((x) => x.duration))].sort((a, b) => a - b).map(length).join(", ");
    throw new Stop(`Calendly has no ${length(minutes!)} meeting. It has: ${have}.`);
  }
  return et;
}

/** The free start times by day, from this day for 3 weeks (Calendly's open times on that event type). */
async function freeFrom(token: string, et: EventType, from: string) {
  let times: number[];
  try {
    times = await openTimes(token, et.uri, noon(from) - 12 * 60 * MIN, noon(from) + 21 * DAY);
  } catch (e) {
    throw new Stop(`Couldn't check the Calendly times: ${(e as Error).message}`);
  }
  const byDay = new Map<string, number[]>();
  for (const x of times) byDay.set(dayOf(x), [...(byDay.get(dayOf(x)) ?? []), x]);
  return (d: string) => byDay.get(d) ?? [];
}

function startOf(date: string, time: string, problem?: string) {
  const tm = str(time).replace(/^(\d):/, "0$1:");
  if (!isDay(date) || !/^\d{2}:\d{2}$/.test(tm)) throw new Stop(str(problem) || "What day and time?");
  const start = at(date, tm);
  if (Number.isNaN(start)) throw new Stop("Didn't get the time. What time?");
  if (start < Date.now()) throw new Stop(`${time12(start)} on ${dmy(start)} has passed. What time?`);
  if (start > Date.now() + 365 * DAY) throw new Stop("That's over a year away. What date?");
  return start;
}

const when = (start: number, minutes: number) => `${weekday(start)} ${dmy(start)}, ${time12(start)}, ${length(minutes)}`;

// ----------------------------------------------------------------- booking --

/**
 * Books it once everyone outside the team has an email: missing ones are
 * asked where the bot asks (the admin hears it, and it books once they're in),
 * else the admin is asked. A time that isn't free: the free times that day, or
 * that the day is full, privately. Booked: everyone on it iklipse knows hears
 * privately, the group sees it with the link. The state left after.
 */
async function bookFor(
  db: Db,
  s: Settings,
  send: Send,
  th: Thread,
  userId: string,
  turn: Turn | null,
  p: { topic: string; agenda: string; minutes?: number; who: Attendee[]; date: string; time: string },
): Promise<State> {
  const { post, tell } = talk(db, send, th, userId, turn);
  const c = await calendlyOf(db, userId);
  const et = typeOf(c.types, c.picked, p.minutes || undefined);
  const start = startOf(p.date, p.time);
  const others = p.who.filter((a) => !a.host);
  if (!others.length) throw new Stop("Who's it with?");
  const next: State = { topic: p.topic, agenda: p.agenda, minutes: et.duration, who: p.who };

  // Clients with no email: asked where the bot asks; it books once they're in.
  const noEmail = others.filter((a) => !a.email && a.kind !== "team");
  if (noEmail.length) {
    const askable = noEmail.filter((a) => a.kind === "client" && a.id);
    if (askable.length === noEmail.length && (await askPlace(db, s))) {
      // Asked even about someone the bot was told to skip: the meeting needs it.
      await db.from("client").update({ ask_skip: false }).in("id", askable.map((a) => a.id!));
      const { data: cs } = await db.from("client").select("id, from_chat").in("id", askable.map((a) => a.id!));
      await db.from("bot_ask").upsert(
        (cs ?? []).map((x) => ({ client_id: x.id, chat_id: x.from_chat ?? th.chat_id, meeting: th.id, next_at: iso() })),
        { onConflict: "client_id" },
      );
      await tell(`I asked the team for ${namesOf(noEmail.map((a) => a.name))}'s email. I'll book it as soon as I have it.`);
      return { ...next, waiting: { date: p.date, time: p.time, by: userId } };
    }
    throw new Stop(`What's ${noEmail[0].name}'s email?`);
  }

  const freeOn = await freeFrom(c.token, et, dayOf(start));
  if (!freeOn(dayOf(start)).includes(start)) {
    if (!freeOn(dayOf(start)).length) {
      await tell(`${weekday(start)} ${dmy(start)} is fully booked.`);
      return { ...next, day: dayOf(start) };
    }
    const r = timesText(freeOn, { days: [dayOf(start)], search: "", minutes: et.duration, taken: start });
    await tell(r.text);
    return { ...next, day: r.shown ?? dayOf(start) };
  }

  // Calendly's invitee: a client first; everyone else with an email is a guest.
  const invitee = others.find((a) => a.kind !== "team" && a.email) ?? others.find((a) => a.email);
  if (!invitee) throw new Stop(`${namesOf(others.map((a) => a.name))} ${others.length === 1 ? "has" : "have"} no email in iklipse. Add it on the Users page, then ask again.`);
  const guests = others.filter((a) => a !== invitee && a.email).map((a) => a.email!);
  let b;
  try {
    b = await book(c.token, { eventType: et, start, name: invitee.name, email: invitee.email!, guests, note: [p.topic, p.agenda].filter(Boolean).join("\n"), timezone: TZ });
  } catch (e) {
    throw said(e);
  }
  // Kept at once (Calendly's own notice of it then finds it here), the link once Calendly has made it.
  await db.from("wa_bot_meeting").upsert(
    {
      event_id: b.event,
      account: c.id,
      thread_id: th.id,
      chat_id: th.chat_id,
      owner: userId,
      source: "bot",
      topic: p.topic,
      start_at: iso(start),
      minutes: et.duration,
      invitee_email: invitee.email,
      invitee_name: invitee.name,
      attendees: p.who,
      status: "booked",
      // With telling people off, nothing is told or reminded about it later either.
      ...(s.meet_tell ? { told_at: null, reminded_at: null } : { told_at: iso(), reminded_at: iso() }),
    },
    { onConflict: "event_id" },
  );
  const ev = await linkOf(c.token, b.event).catch(() => null);
  const link = ev?.location?.join_url ?? null;
  if (link) await db.from("wa_bot_meeting").update({ join_url: link }).eq("event_id", b.event);
  const { data: st } = await db.from("watch_settings").select("bot_phone").eq("id", 1).single();
  const told = s.meet_tell ? await tellMeeting(db, send, b.event, st?.bot_phone ?? null) : 0;
  await post(
    [
      `Booked: *${p.topic}*`,
      when(start, et.duration),
      link ?? "The link is in Calendly's email.",
      told ? "The details went to everyone privately." : `Calendly emailed ${[invitee.email, ...guests].join(", ")}.`,
    ].join("\n"),
  );
  return {};
}

// --------------------------------------------------------------- answering --

/** Answers one admin message (once: only the run that picks it up does). */
export async function answer(db: Db, s: Settings, id: string, send: Send) {
  const { data: turn } = await db
    .from("wa_bot_turn")
    .update({ status: "working", started_at: iso() })
    .eq("id", id)
    .eq("status", "new")
    .select("id, thread_id, chat_id, from_bot, user_id, text, quoted, created_at")
    .maybeSingle();
  if (!turn) return;
  const t = turn as Turn;
  const { data: thr } = await db.from("wa_bot_thread").select("id, chat_id, chat_name, state").eq("id", t.thread_id).single();
  if (!thr) return;
  const th = thr as Thread;
  let state = ((th.state ?? {}) as State) || {};
  const userId = t.user_id!;
  const { post, tell } = talk(db, send, th, userId, t);
  const done = async (status: "done" | "failed", error?: string) => {
    await db.from("wa_bot_turn").update({ status, error: error?.slice(0, 500) ?? null }).eq("id", id);
    await db.from("wa_bot_thread").update({ state, updated_at: iso() }).eq("id", t.thread_id);
  };

  try {
    // The conversation so far (the group and privately), the meetings booked from this group, and who's who.
    const { data: turns } = await db
      .from("wa_bot_turn")
      .select("id, chat_id, from_bot, user_id, text, quoted, created_at")
      .eq("thread_id", t.thread_id)
      .lte("created_at", t.created_at)
      .order("created_at", { ascending: false })
      .limit(20);
    const { data: ms } = await db
      .from("wa_bot_meeting")
      .select("event_id, owner, account, topic, start_at, minutes, join_url, invitee_email, invitee_name, attendees")
      .eq("chat_id", th.chat_id)
      .eq("status", "booked")
      .gt("start_at", iso(Date.now() - 60 * MIN))
      .order("start_at")
      .limit(30);
    const meetings = (ms ?? []) as Meeting[];
    const { data: st } = await db.from("watch_settings").select("bot_phone").eq("id", 1).single();
    const { people, dir } = await peopleFor(db, th.chat_id, userId, st?.bot_phone ?? null);
    const nameOf = (u: string | null) => (u ? dir.team.get(u)?.name : null) || "An admin";
    const history = (turns ?? []).reverse();

    // The lengths Claude may book (best effort: not connected yet is said when booking).
    const lengths = await calendlyOf(db, userId)
      .then((c) => [...new Set(c.types.map((x) => x.duration))].sort((a, b) => a - b))
      .catch(() => [] as number[]);

    const act = await decide(s, {
      group: th.chat_name,
      pending: { ...state, who: state.who?.filter((a) => !a.host).map((a) => a.name) },
      lengths,
      people: people.map((p) => ({ ref: p.ref, name: p.name, who: p.kind === "team" ? "team" : "client", in_group: p.in_group, has_email: !!p.email })),
      meetings: meetings.map((m) => ({
        id: m.event_id,
        topic: m.topic,
        date: dayOf(Date.parse(m.start_at)),
        time: hm.format(new Date(m.start_at)),
        minutes: m.minutes,
        with: (m.attendees ?? []).filter((a) => !a.host).map((a) => a.name).join(", ") || m.invitee_name || m.invitee_email,
        booked_by: nameOf(m.owner),
      })),
      conversation: history.map((x) => ({
        from: x.from_bot ? "iklipse" : `${nameOf(x.user_id)} (admin)`,
        where: x.chat_id === th.chat_id ? "group" : "privately",
        at: `${dayOf(Date.parse(x.created_at))} ${hm.format(new Date(x.created_at))}`,
        text: x.text,
        ...(x.quoted ? { replying_to: x.quoted } : {}),
      })),
    });
    if (!act) throw new Stop("Didn't get that. What day and time?");
    if (act.action === "ignore") return await done("done");
    if (act.action === "none") throw new Stop(str(act.problem) || "Didn't get that. What day and time?");
    const asked = Math.round(Number(act.minutes)) || 0;

    // Who it names: someone from people (an email given for them is saved to Clients), or a name and an email.
    const named: Attendee[] = [];
    for (const w of act.who ?? []) {
      const email = emailsOf([str(w.email)]).good[0] ?? null;
      let p: Attendee | undefined = people.find((x) => x.ref === str(w.ref));
      if (!p && email) p = dir.byEmail.get(email) ?? people.find((x) => x.email === email);
      if (!p && str(w.name)) p = people.find((x) => x.name.toLowerCase() === str(w.name).toLowerCase());
      if (p) {
        const a: Attendee = { kind: p.kind, id: p.id, name: p.name, email: p.email, phone: p.phone };
        if (!a.email && email) {
          a.email = email;
          if (a.kind === "client" && a.id) await db.from("client").update({ email, updated_at: iso() }).eq("id", a.id);
        }
        if (!named.some((x) => x.kind === a.kind && x.id === a.id && x.name === a.name)) named.push(a);
      } else if (email) {
        if (!named.some((x) => x.email === email)) named.push({ kind: "guest", id: null, name: str(w.name) || nameFromEmail(email), email, phone: null });
      } else if (str(w.name)) {
        throw new Stop(`Who's ${str(w.name)}? I need their email.`);
      }
    }

    if (act.action === "link") {
      const c = await calendlyOf(db, userId);
      const et = typeOf(c.types, c.picked, asked || undefined);
      await post(`Book a time (${length(et.duration)}):\n${et.scheduling_url}`);
      return await done("done");
    }

    if (act.action === "book") {
      const host = dir.team.get(userId);
      const others = named.length ? named : (state.who ?? []).filter((a) => !a.host);
      // Emails given now for people already on it.
      for (const a of others) if (!a.email) a.email = named.find((x) => x.kind === a.kind && x.id === a.id)?.email ?? null;
      const who = [...(host ? [{ ...host, host: true }] : []), ...others];
      state = { topic: str(act.topic) || state.topic, agenda: str(act.agenda) || state.agenda, minutes: asked || state.minutes, who };
      state = await bookFor(db, s, send, th, userId, t, {
        topic: state.topic || `Meeting${th.chat_name ? `: ${th.chat_name}` : ""}`,
        agenda: state.agenda ?? "",
        minutes: state.minutes,
        who,
        date: act.date,
        time: act.time,
      });
      return await done("done");
    }

    if (act.action === "find_times") {
      const moving = state.move ? meetings.find((x) => x.event_id === state.move) : undefined;
      const c = moving ? await calendlyOfMeeting(db, moving, moving.owner === userId ? "Your" : `${nameOf(moving.owner)}'s`) : await calendlyOf(db, userId);
      const et = typeOf(c.types, c.picked, asked || state.minutes || moving?.minutes || undefined);
      const today = dayOf(Date.now());
      const days = (act.days ?? []).map(str).filter((d) => isDay(d) && d >= today && noon(d) < Date.now() + 120 * DAY);
      const search = act.search === "earliest" || act.search === "nearest_day" ? act.search : "";
      if (!days.length && !search) {
        if (!state.day) throw new Stop(str(act.problem) || "Which day?");
        days.push(state.day);
      }
      const freeOn = await freeFrom(c.token, et, days[0] ?? today);
      const r = timesText(freeOn, { days, search, minutes: et.duration });
      state = {
        ...state,
        topic: str(act.topic) || state.topic,
        agenda: str(act.agenda) || state.agenda,
        who: named.length ? [...(state.who ?? []).filter((a) => a.host), ...named] : state.who,
        minutes: et.duration,
        day: r.shown ?? state.day,
      };
      await tell(r.text);
      return await done("done");
    }

    const findMeeting = () => {
      const m = meetings.find((x) => x.event_id === str(act.meeting)) ?? meetings.find((x) => x.event_id === state.move);
      if (!m) throw new Stop("Which meeting?");
      return m;
    };

    if (act.action === "move") {
      const m = findMeeting();
      if (named.length && !str(act.date) && !str(act.time)) {
        throw new Stop("Calendly can't add people to a booked meeting. Book them their own, or send them the link.");
      }
      const was = Date.parse(m.start_at);
      const topic = str(act.topic) || m.topic;
      const start = str(act.date) || str(act.time) ? startOf(isDay(str(act.date)) ? str(act.date) : dayOf(was), str(act.time) || hm.format(new Date(was)), act.problem) : was;
      const minutes = asked || m.minutes;
      if (start === was && minutes === m.minutes) {
        if (topic === m.topic) throw new Stop("What should I change?");
        // Only the title: Calendly keeps its own name for the meeting.
        await db.from("wa_bot_meeting").update({ topic, updated_at: iso() }).eq("event_id", m.event_id);
        state = {};
        await post(`Updated: *${topic}*\n${when(was, m.minutes)}`);
        return await done("done");
      }
      if (!m.invitee_email) throw new Stop("I don't know who this one is with, so I can't book it again. Cancel it and book a new one.");
      const c = await calendlyOfMeeting(db, m, m.owner === userId ? "Your" : `${nameOf(m.owner)}'s`);
      const et = typeOf(c.types, c.picked, minutes);
      const freeOn = await freeFrom(c.token, et, dayOf(start));
      if (!freeOn(dayOf(start)).includes(start)) {
        state = { move: m.event_id, minutes: et.duration, day: dayOf(start) };
        if (!freeOn(dayOf(start)).length) {
          await tell(`${weekday(start)} ${dmy(start)} is fully booked.`);
          return await done("done");
        }
        const r = timesText(freeOn, { days: [dayOf(start)], search: "", minutes: et.duration, taken: start });
        state.day = r.shown ?? dayOf(start);
        await tell(r.text);
        return await done("done");
      }
      // The new time first; then the old one goes (Calendly tells them both).
      const guests = (m.attendees ?? []).filter((a) => !a.host && a.email && a.email !== m.invitee_email).map((a) => a.email!);
      let b;
      try {
        b = await book(c.token, { eventType: et, start, name: m.invitee_name || nameFromEmail(m.invitee_email), email: m.invitee_email, guests, note: topic, timezone: TZ });
      } catch (e) {
        throw said(e);
      }
      await db.from("wa_bot_meeting").upsert(
        {
          event_id: b.event,
          account: c.id,
          thread_id: t.thread_id,
          chat_id: th.chat_id,
          owner: m.owner,
          source: "bot",
          topic,
          start_at: iso(start),
          minutes: et.duration,
          invitee_email: m.invitee_email,
          invitee_name: m.invitee_name,
          attendees: m.attendees,
          status: "booked",
          ...(s.meet_tell ? { told_at: null, reminded_at: null } : { told_at: iso(), reminded_at: iso() }),
        },
        { onConflict: "event_id" },
      );
      const ev = await linkOf(c.token, b.event).catch(() => null);
      const link = ev?.location?.join_url ?? null;
      if (link) await db.from("wa_bot_meeting").update({ join_url: link }).eq("event_id", b.event);
      let oldGone = true;
      try {
        await cancelEvent(c.token, m.event_id, `Moved to ${weekday(start)} ${dmy(start)}, ${time12(start)}`);
      } catch (e) {
        console.error("calendly move cancel", (e as Error).message);
        oldGone = false;
      }
      await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).eq("event_id", m.event_id);
      const told = s.meet_tell ? await tellMeeting(db, send, b.event, st?.bot_phone ?? null) : 0;
      state = {};
      await post(
        [
          `Moved: *${topic}*`,
          when(start, et.duration),
          link ?? "The link is in Calendly's email.",
          told ? "The new time went to everyone privately." : `Calendly told ${m.invitee_email}.`,
        ].join("\n"),
      );
      if (!oldGone) await tell(`Couldn't cancel the old time (${time12(was)}) on Calendly. Cancel it there.`);
      return await done("done");
    }

    if (act.action === "cancel") {
      const m = findMeeting();
      const c = await calendlyOfMeeting(db, m, m.owner === userId ? "Your" : `${nameOf(m.owner)}'s`);
      try {
        await cancelEvent(c.token, m.event_id, `Cancelled by ${nameOf(userId)}`);
      } catch (e) {
        throw said(e);
      }
      await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).eq("event_id", m.event_id);
      state = {};
      const at0 = Date.parse(m.start_at);
      await post(`Cancelled *${m.topic}* (${weekday(at0)} ${dmy(at0)}, ${time12(at0)}).${m.invitee_email ? ` Calendly told ${m.invitee_email}.` : ""}`);
      return await done("done");
    }
    throw new Stop("Didn't get that. What day and time?");
  } catch (e) {
    const stop = e instanceof Stop;
    if (!stop) console.error("book calendly", (e as Error).message);
    await done("failed", stop ? e.message : `Something went wrong: ${(e as Error).message}`);
    // The admin hears it privately, as something they can answer.
    try {
      await tell(stop ? e.message : "That didn't go through. Try again in a minute.");
    } catch (e2) {
      console.error("book reply", (e2 as Error).message);
    }
  }
}

/**
 * Meetings waiting for clients' emails: booked once they're all in (the
 * admin hears if it can't be), given up after 3 days.
 */
async function resumeWaiting(db: Db, s: Settings, send: Send, deadline: number) {
  const { data: rows } = await db.from("wa_bot_thread").select("id, chat_id, chat_name, state, updated_at").not("state->waiting", "is", null).limit(5);
  let booked = 0;
  for (const r of rows ?? []) {
    if (Date.now() > deadline) break;
    const th = r as Thread & { updated_at: string };
    const state = th.state;
    const w = state.waiting;
    if (!w) continue;
    const { tell } = talk(db, send, th, w.by, null);
    const who = state.who ?? [];
    const ids = who.filter((a) => a.kind === "client" && a.id).map((a) => a.id!);
    const { data: cs } = ids.length ? await db.from("client").select("id, email").in("id", ids) : { data: [] };
    for (const a of who) {
      const c = (cs ?? []).find((x) => x.id === a.id);
      if (a.kind === "client" && c?.email) a.email = str(c.email).toLowerCase();
    }
    const missing = who.filter((a) => !a.host && a.kind !== "team" && !a.email);
    let next: State = { ...state, who };
    if (missing.length) {
      if (Date.now() - Date.parse(th.updated_at) < 3 * DAY) {
        await db.from("wa_bot_thread").update({ state: next }).eq("id", th.id);
        continue;
      }
      next = {};
      await tell(`Still no email for ${namesOf(missing.map((a) => a.name))}, so I didn't book *${state.topic ?? "the meeting"}*.`).catch(() => null);
    } else {
      try {
        next = await bookFor(db, s, send, th, w.by, null, { topic: state.topic || "Meeting", agenda: state.agenda ?? "", minutes: state.minutes, who, date: w.date, time: w.time });
        booked++;
      } catch (e) {
        next = {};
        await tell(e instanceof Stop ? e.message : "The meeting didn't go through. Ask again?").catch(() => null);
        if (!(e instanceof Stop)) console.error("book resume", (e as Error).message);
      }
    }
    await db.from("wa_bot_thread").update({ state: next, updated_at: iso() }).eq("id", th.id);
  }
  return booked;
}

/** Every minute: messages left waiting are answered, ones that stopped halfway are said so (never done twice), and meetings waiting for emails go ahead. */
export async function leftovers(db: Db, s: Settings, send: Send, deadline: number) {
  const report = async (rows: { id: string; thread_id: string; chat_id: string; user_id: string | null }[] | null, words: string) => {
    for (const r of rows ?? []) {
      try {
        const { data: th } = await db.from("wa_bot_thread").select("id, chat_id, chat_name, state").eq("id", r.thread_id).single();
        if (th && r.user_id) await talk(db, send, th as Thread, r.user_id, r as unknown as Turn).tell(words);
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
    .select("id, thread_id, chat_id, user_id");
  await report(stuck, "This one got stuck halfway. Check the calendar before asking again.");
  const { data: late } = await db
    .from("wa_bot_turn")
    .update({ status: "failed", error: "Too late" })
    .eq("status", "new")
    .lt("created_at", iso(Date.now() - 60 * MIN))
    .select("id, thread_id, chat_id, user_id");
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
    await answer(db, s, w.id, send);
    answered++;
  }
  if (Date.now() < deadline) answered += await resumeWaiting(db, s, send, deadline);
  // Conversations and meetings are kept (0088).
  return answered;
}
