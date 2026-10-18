// Meetings from WhatsApp on Calendly (0084), in place of Zoom (book.ts): the
// same conversation (an admin mentions the bot, then replies to it), the same
// short answers, but booked on that admin's own Calendly (the account and
// event type they picked for the bot on the Connections page): a meeting with
// someone at an open time, which Calendly emails to them with the link
// (Calendly's own Zoom or Google Meet). Its length is the event type's: one of
// that length is used when asked for another one.
//
// What Calendly can't do the bot says: a series, a link right now, adding
// people to a booked meeting. Moving one is booking the new time, then
// cancelling the old one (Calendly tells them both). Booking for someone needs
// a paid Calendly plan (Standard and up). The free times are Calendly's own
// (the admin's availability there), not the hours in the settings.

import { accessToken, book, botAccount, cancelEvent, eventTypes, linkOf, nameFromEmail, openTimes, typeFor, type EventType } from "../_shared/calendly.ts";
import { emailsOf } from "../_shared/invite.ts";
import { claude, iso, MIN, str, TZ, type Db } from "./kit.ts";
import {
  at,
  calendar,
  DAY,
  dayOf,
  dmy,
  hm,
  isDay,
  length,
  noon,
  nowWords,
  sayIn,
  Stop,
  time12,
  timesWords,
  weekday,
  type BookSettings,
  type Reply,
  type Turn,
} from "./book.ts";

/** What a conversation is arranging, between messages. */
interface State {
  topic?: string;
  agenda?: string;
  minutes?: number;
  /** Who it's with. */
  name?: string;
  emails?: string[];
  /** The day free times were last shown for. */
  day?: string;
  /** Moving this meeting (its Calendly id). */
  move?: string;
}

interface Meeting {
  zoom_id: string;
  owner: string;
  calendly_account: string | null;
  topic: string;
  start_at: string;
  minutes: number;
  join_url: string | null;
  invitee_email: string | null;
  invitee_name: string | null;
}

interface Act {
  action: "book" | "find_times" | "move" | "cancel" | "link" | "ignore" | "none";
  topic: string;
  agenda: string;
  date: string;
  time: string;
  minutes: number;
  name: string;
  emails: string[];
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
      name: { type: "string", description: "book: the name of the person the meeting is with, when said. Else empty." },
      emails: {
        type: "array",
        items: { type: "string" },
        description: "book: the email addresses of the people it's with, exactly as written in the conversation (never made up); the first one is who it's with. move: emails they ask to add. Else empty.",
      },
      meeting: { type: "string", description: "move / cancel: the meeting's id from the meetings list. Else empty." },
      days: { type: "array", items: { type: "string" }, description: "find_times: the days to show, YYYY-MM-DD, at most 7. Else empty." },
      search: { type: "string", enum: ["", "nearest_day", "earliest"], description: "find_times: nearest_day = the first day with a free time, from days[0] or today; earliest = the earliest free time from then. Empty to show the days as they are." },
      problem: {
        type: "string",
        description: "none: what you'd text back, in English, like a person on WhatsApp: a few words, usually a short question (\"What time?\", \"Which day?\", \"Who's it with?\", \"What's their email?\"). No greeting, no apology, no please, no thanks, no offer of more help. Else empty.",
      },
    },
    required: ["action", "topic", "agenda", "date", "time", "minutes", "name", "emails", "meeting", "days", "search", "problem"],
  },
};

async function decide(s: BookSettings, ctx: Record<string, unknown>): Promise<Act | null> {
  const system = `You are iklipse, the team's assistant in a WhatsApp group, booking meetings on the iklipse admins' Calendly. A conversation with you starts when an admin mentions you ("@iklipse"); admins carry it on by replying to your messages. Decide what to do for the last message in the conversation (an admin's) and call act once. Admins may write in English, Arabic, Egyptian Arabic or Franco-Arabic; everything you write (topic, agenda, problem) is in English.

It is ${nowWords.format(new Date())} in Cairo now. Every day and time is Cairo time. The next days:
${calendar()}
The weekend is Friday and Saturday. "lengths": the meeting lengths the admin's Calendly has, in minutes.

- book: a meeting with someone at a day and a time. It needs the day, the time and the email of the person it's with (Calendly sends them the invite and the link). Other emails in the message are more people on it. In a reply, take what isn't said again (title, details, length, the day, the time, who it's with, the emails) from the conversation and from "pending": after you offered free times, "4" or "خليها 4 ونص" books that time on that day; after you asked for the email, an email books what was asked before. After you offered one time ("Earliest free: ... Book it?"), a yes ("ok", "تمام", "احجزه", "yes") books that time.
- find_times: they ask what's free: a day ("خلينا يوم الحد"), the nearest free day ("أقرب يوم فاضي"), the earliest time ("أبدر معاد"), the weekend (its two days), this week. A day with no time means the free times that day.
- move: change the day, time, length or title of a meeting from the meetings list (a reply to your message about a meeting is about that one). "pending" with move: a reply picking a time moves that meeting.
- cancel: cancel a meeting from the meetings list.
- link: they want a link people book a time on themselves ("ابعتلهم لينك يحجزوا", "send my calendly link", "لينك الحجز").
- ignore: nothing asked (thanks, ok after a booking, a remark to someone else).
- none: anything else, or the day, the time or the email of who it's with is missing and the conversation doesn't give it. Say what's missing in problem ("What's their email?"). Calendly books one meeting at a time: for a series (every week...) or a link right now, say in problem that Calendly books one meeting at a time, so give a day and time. Never invent a day, a time or an email address.

Times: with no AM or PM, the sensible working-hours one (3 is 15:00, 10 is 10:00, 7 is 19:00) unless the words say otherwise (الصبح، الضهر، العصر، المغرب، بالليل). "3 ونص" is 15:30, "3 وربع" 15:15. Only a time and no day: today if that time is still ahead, else none. Weekdays mean the next one coming.`;
  const r = await claude(s.model, system, JSON.stringify(ctx), TOOL, 1200);
  return r && typeof r === "object" && typeof r.action === "string" ? (r as Act) : null;
}

/** Calendly's no, in words an admin can act on. */
function said(e: unknown) {
  const msg = (e as Error).message;
  if (/only available on paid Calendly plans/i.test(msg)) return new Stop("Booking from here needs a paid Calendly plan (Standard or higher).");
  if (/Insufficient scope|required_scopes/i.test(msg)) return new Stop("Your Calendly needs connecting again on iklipse.");
  return new Stop(`Calendly didn't take it: ${msg}`);
}

/** Answers one admin message, on Calendly (once: only the run that picks it up does). */
export async function answerCalendly(db: Db, s: BookSettings, id: string, reply: Reply) {
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
    // The conversation so far, the Calendly meetings booked from this group, and who's who.
    const { data: turns } = await db
      .from("wa_bot_turn")
      .select("id, from_bot, user_id, text, quoted, created_at")
      .eq("thread_id", t.thread_id)
      .lte("created_at", t.created_at)
      .order("created_at", { ascending: false })
      .limit(20);
    const { data: ms } = await db
      .from("wa_bot_meeting")
      .select("zoom_id, owner, calendly_account, topic, start_at, minutes, join_url, invitee_email, invitee_name")
      .eq("chat_id", t.chat_id)
      .eq("provider", "calendly")
      .eq("status", "booked")
      .gt("start_at", iso(Date.now() - 60 * MIN))
      .order("start_at")
      .limit(30);
    const meetings = (ms ?? []) as Meeting[];
    const ids = [...new Set([...(turns ?? []).map((x) => x.user_id), ...meetings.map((m) => m.owner)].filter(Boolean))] as string[];
    const { data: ps } = ids.length ? await db.from("profile").select("id, display_name").in("id", ids) : { data: [] };
    const nameOf = (u: string | null) => (ps ?? []).find((p) => p.id === u)?.display_name || "An admin";
    const history = (turns ?? []).reverse();

    // The asking admin's Calendly: the account, a token, its event types (read once).
    let mine: { id: string; user: string; picked: string | null; token: string; types: EventType[] } | null = null;
    const myCalendly = async () => {
      if (mine) return mine;
      const account = await botAccount(db, t.user_id!);
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
      mine = { id: account, user: a.calendly_user as string, picked: (a.event_type as string | null) ?? null, token, types };
      return mine;
    };
    // A meeting already booked stays on its own account.
    const theirs = async (m: Meeting) => {
      if (!m.calendly_account) throw new Stop("The Calendly this meeting is on was disconnected, so I can't change it from here.");
      const token = await accessToken(db, m.calendly_account);
      if (!token) throw new Stop(`${m.owner === t.user_id ? "Your" : `${nameOf(m.owner)}'s`} Calendly needs connecting again on iklipse.`);
      const { data: a } = await db.from("calendly_account").select("calendly_user, event_type").eq("id", m.calendly_account).single();
      let types: EventType[];
      try {
        types = await eventTypes(token, a!.calendly_user as string);
      } catch (e) {
        throw new Stop(`Couldn't read the Calendly: ${(e as Error).message}`);
      }
      return { id: m.calendly_account, token, types, picked: (a?.event_type as string | null) ?? null };
    };
    const typeOf = (types: EventType[], picked: string | null, minutes?: number) => {
      const et = typeFor(types, picked, minutes);
      if (!et) {
        const have = [...new Set(types.map((x) => x.duration))].sort((a, b) => a - b).map(length).join(", ");
        throw new Stop(`Calendly has no ${length(minutes!)} meeting. It has: ${have}.`);
      }
      return et;
    };
    /** The free start times by day, from this day for 3 weeks (Calendly's open times on that event type). */
    const freeFrom = async (token: string, et: EventType, from: string) => {
      let times: number[];
      try {
        times = await openTimes(token, et.uri, noon(from) - 12 * 60 * MIN, noon(from) + 21 * DAY);
      } catch (e) {
        throw new Stop(`Couldn't check the Calendly times: ${(e as Error).message}`);
      }
      const byDay = new Map<string, number[]>();
      for (const x of times) byDay.set(dayOf(x), [...(byDay.get(dayOf(x)) ?? []), x]);
      return (d: string) => byDay.get(d) ?? [];
    };
    const startOf = (date: string, time: string, act: Act) => {
      const tm = str(time).replace(/^(\d):/, "0$1:");
      if (!isDay(date) || !/^\d{2}:\d{2}$/.test(tm)) throw new Stop(str(act.problem) || "What day and time?");
      const start = at(date, tm);
      if (Number.isNaN(start)) throw new Stop("Didn't get the time. What time?");
      if (start < Date.now()) throw new Stop(`${time12(start)} on ${dmy(start)} has passed. What time?`);
      if (start > Date.now() + 365 * DAY) throw new Stop("That's over a year away. What date?");
      return start;
    };
    const when = (start: number, minutes: number) => `${weekday(start)} ${dmy(start)}, ${time12(start)}, ${length(minutes)}`;

    // The lengths Claude may book (best effort: not connected yet is said when booking).
    const lengths = await myCalendly()
      .then((c) => [...new Set(c.types.map((x) => x.duration))].sort((a, b) => a - b))
      .catch(() => [] as number[]);

    const act = await decide(s, {
      group,
      pending: state,
      lengths,
      meetings: meetings.map((m) => ({
        id: m.zoom_id,
        topic: m.topic,
        date: dayOf(Date.parse(m.start_at)),
        time: hm.format(new Date(m.start_at)),
        minutes: m.minutes,
        with: m.invitee_name || m.invitee_email,
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
    const asked = Math.round(Number(act.minutes)) || 0;

    if (act.action === "link") {
      const c = await myCalendly();
      const et = typeOf(c.types, c.picked, asked || undefined);
      await say(`Book a time (${length(et.duration)}):\n${et.scheduling_url}`);
      return await done("done");
    }

    if (act.action === "book") {
      const topic = str(act.topic) || state.topic || `Meeting${group ? `: ${group}` : ""}`;
      const agenda = str(act.agenda) || state.agenda || "";
      const fresh = emailsOf(act.emails ?? []).good;
      const emails = fresh.length ? fresh : state.emails ?? [];
      const name = str(act.name) || state.name || "";
      const c = await myCalendly();
      const et = typeOf(c.types, c.picked, asked || state.minutes || undefined);
      const start = startOf(act.date, act.time, act);
      state = { topic, agenda, minutes: et.duration, name, emails };
      if (!emails.length) throw new Stop("What's their email?");
      const freeOn = await freeFrom(c.token, et, dayOf(start));
      if (!freeOn(dayOf(start)).includes(start)) {
        const r = timesWords(freeOn, { days: [dayOf(start)], search: "", minutes: et.duration, taken: start });
        state.day = r.shown ?? dayOf(start);
        await say(r.text);
        return await done("done");
      }
      const who = name || nameFromEmail(emails[0]);
      let b;
      try {
        b = await book(c.token, { eventType: et, start, name: who, email: emails[0], guests: emails.slice(1), note: [topic, agenda].filter(Boolean).join("\n"), timezone: TZ });
      } catch (e) {
        throw said(e);
      }
      const ev = await linkOf(c.token, b.event).catch(() => null);
      const link = ev?.location?.join_url ?? null;
      await db.from("wa_bot_meeting").insert({
        zoom_id: b.event,
        provider: "calendly",
        calendly_account: c.id,
        thread_id: t.thread_id,
        chat_id: t.chat_id,
        owner: t.user_id,
        kind: "once",
        topic,
        start_at: iso(start),
        minutes: et.duration,
        join_url: link,
        invitee_email: emails[0],
        invitee_name: who,
      });
      state = {};
      await say(
        [`Booked: *${topic}*`, when(start, et.duration), `With ${who}`, link ?? "The link is in Calendly's email.", `Calendly emailed ${emails.join(", ")}.`].join("\n"),
      );
      return await done("done");
    }

    if (act.action === "find_times") {
      const moving = state.move ? meetings.find((x) => x.zoom_id === state.move) : undefined;
      const c = moving ? await theirs(moving) : await myCalendly();
      const et = typeOf(c.types, c.picked, asked || state.minutes || moving?.minutes || undefined);
      const today = dayOf(Date.now());
      const days = (act.days ?? []).map(str).filter((d) => isDay(d) && d >= today && noon(d) < Date.now() + 120 * DAY);
      const search = act.search === "earliest" || act.search === "nearest_day" ? act.search : "";
      if (!days.length && !search) {
        if (!state.day) throw new Stop(str(act.problem) || "Which day?");
        days.push(state.day);
      }
      const freeOn = await freeFrom(c.token, et, days[0] ?? today);
      const r = timesWords(freeOn, { days, search, minutes: et.duration });
      const fresh = emailsOf(act.emails ?? []).good;
      state = {
        ...state,
        topic: str(act.topic) || state.topic,
        agenda: str(act.agenda) || state.agenda,
        name: str(act.name) || state.name,
        emails: fresh.length ? fresh : state.emails,
        minutes: et.duration,
        day: r.shown ?? state.day,
      };
      await say(r.text);
      return await done("done");
    }

    const findMeeting = () => {
      const m = meetings.find((x) => x.zoom_id === str(act.meeting)) ?? meetings.find((x) => x.zoom_id === state.move);
      if (!m) throw new Stop("Which meeting?");
      return m;
    };

    if (act.action === "move") {
      const m = findMeeting();
      if (emailsOf(act.emails ?? []).good.length && !str(act.date) && !str(act.time)) {
        throw new Stop("Calendly can't add people to a booked meeting. Book them their own, or send them the link.");
      }
      const was = Date.parse(m.start_at);
      const topic = str(act.topic) || m.topic;
      const start = str(act.date) || str(act.time) ? startOf(isDay(str(act.date)) ? str(act.date) : dayOf(was), str(act.time) || hm.format(new Date(was)), act) : was;
      const minutes = asked || m.minutes;
      if (start === was && minutes === m.minutes) {
        if (topic === m.topic) throw new Stop("What should I change?");
        // Only the title: Calendly keeps its own name for the meeting.
        await db.from("wa_bot_meeting").update({ topic, updated_at: iso() }).eq("zoom_id", m.zoom_id);
        state = {};
        await say(`Updated: *${topic}*\n${when(was, m.minutes)}`);
        return await done("done");
      }
      if (!m.invitee_email) throw new Stop("I don't know who this one is with, so I can't book it again. Cancel it and book a new one.");
      const c = await theirs(m);
      const et = typeOf(c.types, c.picked, minutes);
      const freeOn = await freeFrom(c.token, et, dayOf(start));
      if (!freeOn(dayOf(start)).includes(start)) {
        const r = timesWords(freeOn, { days: [dayOf(start)], search: "", minutes: et.duration, taken: start });
        state = { move: m.zoom_id, minutes: et.duration, day: r.shown ?? dayOf(start) };
        await say(r.text);
        return await done("done");
      }
      // The new time first; then the old one goes (Calendly tells them both).
      let b;
      try {
        b = await book(c.token, {
          eventType: et,
          start,
          name: m.invitee_name || nameFromEmail(m.invitee_email),
          email: m.invitee_email,
          note: topic,
          timezone: TZ,
        });
      } catch (e) {
        throw said(e);
      }
      const ev = await linkOf(c.token, b.event).catch(() => null);
      const link = ev?.location?.join_url ?? null;
      let oldGone = true;
      try {
        await cancelEvent(c.token, m.zoom_id, `Moved to ${weekday(start)} ${dmy(start)}, ${time12(start)}`);
      } catch (e) {
        console.error("calendly move cancel", (e as Error).message);
        oldGone = false;
      }
      await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).eq("zoom_id", m.zoom_id);
      await db.from("wa_bot_meeting").insert({
        zoom_id: b.event,
        provider: "calendly",
        calendly_account: c.id,
        thread_id: t.thread_id,
        chat_id: t.chat_id,
        owner: m.owner,
        kind: "once",
        topic,
        start_at: iso(start),
        minutes: et.duration,
        join_url: link,
        invitee_email: m.invitee_email,
        invitee_name: m.invitee_name,
      });
      state = {};
      await say(
        [
          `Moved: *${topic}*`,
          when(start, et.duration),
          link ?? "The link is in Calendly's email.",
          oldGone ? `Calendly told ${m.invitee_email}.` : `Couldn't cancel the old time (${time12(was)}) on Calendly. Cancel it there.`,
        ].join("\n"),
      );
      return await done("done");
    }

    if (act.action === "cancel") {
      const m = findMeeting();
      const c = await theirs(m);
      try {
        await cancelEvent(c.token, m.zoom_id, `Cancelled by ${nameOf(t.user_id)}`);
      } catch (e) {
        throw said(e);
      }
      await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).eq("zoom_id", m.zoom_id);
      state = {};
      const st = Date.parse(m.start_at);
      await say(`Cancelled *${m.topic}* (${weekday(st)} ${dmy(st)}, ${time12(st)}).${m.invitee_email ? ` Calendly told ${m.invitee_email}.` : ""}`);
      return await done("done");
    }
    throw new Stop("Didn't get that. What day and time?");
  } catch (e) {
    const stop = e instanceof Stop;
    if (!stop) console.error("book calendly", (e as Error).message);
    await done("failed", stop ? e.message : `Something went wrong: ${(e as Error).message}`);
    // The admin hears it where they asked, as a reply they can answer.
    try {
      await sayIn(db, reply, t, stop ? e.message : "That didn't go through. Try again in a minute.");
    } catch (e2) {
      console.error("book reply", (e2 as Error).message);
    }
  }
}
