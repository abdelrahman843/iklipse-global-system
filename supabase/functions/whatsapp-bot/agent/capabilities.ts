// What the agent (runtime.ts) can use from WhatsApp, made from what the bot
// already does, nothing new: find is look.ts's lookup (the same tables and
// columns, and who may read what), message_team_member is an order from
// orders.ts (kept in bot_order, written to them, followed up until it's done,
// reported where it was given). Here is only what each one is, who may use
// it, what it takes, and how it's checked after it ran.

import { find, FIND_TOOL, Refused, TABLE_GUIDE, type Find, type Me } from "../look.ts";
import { search, SEARCH_TOOL, SearchRefused, type Search } from "../search.ts";
import { str, type Db } from "../kit.ts";
import type { Attendee } from "../meetings.ts";
import { ToolError, type Actor, type Capability } from "./runtime.ts";

const notGuest = (a: Actor) => (a.role === "guest" ? "Guests can't use the bot." : true);
/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** The database or the network failed, not what was asked. */
const passing = (m: string) => /fetch failed|network|timed? ?out|ECONNRESET|connection|50[234]|Service Unavailable/i.test(m);

// ------------------------------------------------------------------ find --

/** Reading iklipse, as the one asking may (look.ts adds who may see what to every lookup). */
export function findCapability(db: Db, me: Me, names: Map<string, string>): Capability<Find> {
  return {
    name: "find",
    description: FIND_TOOL.description,
    input_schema: FIND_TOOL.input_schema,
    effect: "read",
    guide: TABLE_GUIDE,
    allowed: notGuest,
    validate: (x) => {
      const f = (x ?? {}) as Find;
      return typeof f.table === "string" && f.table ? f : "find needs a table.";
    },
    timeoutMs: 15_000,
    retries: 1,
    run: async (f) => {
      try {
        return { data: await find(db, me, f, names) };
      } catch (e) {
        const m = (e as Error).message;
        if (!(e instanceof Refused)) throw new ToolError("transient", "That lookup failed.");
        if (/admins only|aren't on|isn't shared/.test(m)) throw new ToolError("denied", m);
        throw new ToolError(passing(m) ? "transient" : "invalid_input", m);
      }
    },
  };
}

// ---------------------------------------------------------------- search --

/** What people said, by meaning and words, as the one asking may read it (search.ts, the same rules as find). */
export function searchCapability(db: Db, me: Me): Capability<Search> {
  return {
    name: "search",
    description: SEARCH_TOOL.description,
    input_schema: SEARCH_TOOL.input_schema,
    effect: "read",
    allowed: notGuest,
    validate: (x) => {
      const q = (x ?? {}) as Search;
      return typeof q.text === "string" && q.text.trim() ? q : "search needs words to look for.";
    },
    timeoutMs: 20_000,
    retries: 1,
    run: async (q) => {
      try {
        return { data: await search(db, me, q) };
      } catch (e) {
        const m = (e as Error).message;
        if (e instanceof SearchRefused) throw new ToolError("invalid_input", m);
        throw new ToolError("transient", "That search failed.");
      }
    },
  };
}

// ----------------------------------------------------- a team member --

export interface TeamMessage {
  /** Their profile id. */
  person: string;
  kind: "tell" | "ask";
  task: string;
  message: string;
  nudge: string;
  /** false: it only passes something on, nothing to follow up. */
  wait: boolean;
}

/** A reminder as asked: the time exactly as they said it (reminders.ts works it out). */
export interface ReminderAsk {
  /** "me", or their profile id. */
  person: string;
  text: string;
  date: string;
  time: string;
  ampm: "am" | "pm" | "";
  in_minutes: number;
  any_time: boolean;
}

/**
 * A reminder, privately, at a time or after a while (reminders.ts, 0110): for
 * the one asking or someone on the team. A time that's gone or unclear comes
 * back as the question to ask them. Checked after: the reminder is read back.
 */
export function reminderCapability(o: {
  team: Map<string, Attendee>;
  /** The one asking (their profile id). */
  me: string;
  set: (who: Attendee, x: ReminderAsk) => Promise<{ text: string; reminder?: { id: string } }>;
  check: (id: string) => Promise<{ status: string } | null>;
}): Capability<ReminderAsk & { who: Attendee }> {
  return {
    name: "set_reminder",
    description:
      "Remind someone privately on WhatsApp at a time or after a while: the one asking (person \"me\") or someone on the team. Give the time exactly as they said it; the bot works out the day and time, and says it back.",
    input_schema: {
      type: "object",
      properties: {
        person: { type: "string", description: "\"me\", or their profile.id (someone on the team, is_active true)." },
        text: { type: "string", description: "What to remind them of, short, in English (\"send the invoice\")." },
        date: { type: "string", description: "The day, YYYY-MM-DD, only when a day was said. Else empty." },
        time: { type: "string", description: "The time exactly as said, HH:MM (5 is 05:00). Else empty." },
        ampm: { type: "string", enum: ["", "am", "pm"], description: "Only when the words say it. Else empty." },
        in_minutes: { type: "integer", description: "\"in 30 minutes\": 30. Else 0." },
        any_time: { type: "boolean", description: "Someone else's reminder may go outside working hours: only when they said so." },
      },
      required: ["person", "text"],
    },
    effect: "write",
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<ReminderAsk>;
      const who = o.team.get(str(i.person) === "me" ? o.me : str(i.person));
      if (!who?.id) return "No one active on the team has that id: use \"me\", or find them in profile (is_active true).";
      const text = str(i.text);
      if (text.length > 500) return "The text is too long (under 500 characters).";
      const n = Number(i.in_minutes);
      return { person: who.id, text, date: str(i.date), time: str(i.time), ampm: i.ampm === "am" || i.ampm === "pm" ? i.ampm : "", in_minutes: Number.isFinite(n) ? n : 0, any_time: i.any_time === true, who };
    },
    key: (x) => `remind:${x.person}:${x.date}:${x.time}:${x.ampm}:${x.in_minutes}`,
    describe: (x) => `remind ${x.person === o.me ? "you" : first(x.who.name)}${x.text ? ` (${x.text})` : ""}`,
    timeoutMs: 15_000,
    retries: 1,
    run: async (x) => {
      const r = await o.set(x.who, x);
      // The time can't be worked out: what to ask them comes back as the problem.
      if (!r.reminder) throw new ToolError("invalid_input", r.text);
      const now = await o.check(r.reminder.id).catch(() => null);
      const data = { person: x.who.name, said: r.text };
      if (now?.status !== "open") return { data, verified: { status: "unknown" as const, detail: "the reminder couldn't be read back" } };
      return { data, verified: { status: "verified" as const, detail: "kept, to be sent at its time" }, receipt: r.text };
    },
  };
}

/** What giving the order did (orders.ts giveOrder). stage: where it stopped (checking them, keeping it, sending it). */
export interface Given {
  order?: { id: string };
  told?: boolean;
  problem?: string;
  stage?: "check" | "keep" | "send";
}

/**
 * Writing to someone on the team, as an order the bot follows up (orders.ts).
 * Anyone on the team may: the team gives the bot orders without an OK (0090).
 * Once per person per request. Checked after: the order is read back, and
 * WhatsApp has to have taken the message (submitted; WhatsApp tells later
 * whether it reached their phone).
 */
export function messageTeamCapability(o: {
  /** The active team (meetings.ts directory). */
  team: Map<string, Attendee>;
  botPhone: string | null;
  /** Where the answer is brought: "here" (the group), or "to you" (privately). */
  answerTo: string;
  give: (to: Attendee, x: TeamMessage) => Promise<Given>;
  /** The order as it is now. */
  check: (orderId: string) => Promise<{ status: string; sent: number } | null>;
}): Capability<TeamMessage & { to: Attendee }> {
  return {
    name: "message_team_member",
    description:
      "Write privately on WhatsApp to someone on the team: tell them to do something (or pass something on), or ask them something and bring the answer back. The bot follows up until it's done or answered, and says what they answer where this request was made. Once per person per request: put everything for them in one message.",
    input_schema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Their id: profile.id (find it in profile, is_active true)." },
        kind: { type: "string", enum: ["tell", "ask"], description: "tell: they're to do something, or be told something; ask: a question whose answer is brought back." },
        task: { type: "string", description: "What they're to do, or what they're asked, short, in English (\"send the final logo files to Acme\")." },
        message: {
          type: "string",
          description:
            "The first message to them, in English: \"Hi <first name>, <first name of who asked> asks you to <task>.\" with what they need to know. For tell with wait true, end with \"Reply here when it's done, or tell me what's in the way.\" Never invent a date, a file, a price or a promise.",
        },
        nudge: { type: "string", description: "The reminder if they don't answer, short (\"Rabah, a reminder: Sameh asked you to send the logo files to Acme. Is it done?\")." },
        wait: { type: "boolean", description: "false when it only passes something on and nothing is needed back (no follow-up); else true." },
      },
      required: ["person", "kind", "task", "message", "nudge", "wait"],
    },
    effect: "write",
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<TeamMessage>;
      const to = o.team.get(str(i.person));
      if (!to?.id) return "No one active on the team has that id: find them in profile (is_active true) first.";
      if (o.botPhone && to.phone === o.botPhone) return "That's the bot's own number.";
      const task = str(i.task);
      const message = str(i.message);
      if (!task || !message) return "It needs the task and the message.";
      if (task.length > 500 || message.length > 2000) return "Too long: the task under 500 characters, the message under 2000.";
      return { person: to.id, kind: i.kind === "ask" ? "ask" : "tell", task, message: message.replace(/\s*[—–]\s*/g, ", "), nudge: str(i.nudge).slice(0, 1000), wait: i.wait !== false, to };
    },
    key: (x) => `team:${x.person}`,
    describe: (x) => `${x.kind === "ask" ? "ask" : "write to"} ${first(x.to.name)} (${x.task})`,
    timeoutMs: 20_000,
    retries: 1,
    run: async (x) => {
      const r = await o.give(x.to, x);
      if (r.problem) throw new ToolError(r.stage === "check" ? "not_found" : r.stage === "keep" ? "transient" : "permanent", r.problem);
      const name = first(x.to.name);
      const data = { person: x.to.name, kind: x.kind, follow_up: !r.told };
      const now = r.order ? await o.check(r.order.id).catch(() => null) : null;
      if (!now) return { data, keep: r, verified: { status: "unknown" as const, detail: "the order couldn't be read back" } };
      if (now.status === "failed") return { data, keep: r, verified: { status: "failed" as const, detail: "WhatsApp didn't take the message" } };
      // Sent, but WhatsApp gave no id back: it may not have gone out.
      if (!now.sent) return { data, keep: r, verified: { status: "unknown" as const, detail: "WhatsApp didn't confirm it took the message" } };
      return {
        data,
        keep: r,
        verified: { status: "submitted" as const, detail: "WhatsApp took the message" },
        receipt: r.told ? `Told ${name}.` : x.kind === "ask" ? `Asked ${name}. I'll bring the answer ${o.answerTo}.` : `Sent to ${name}. I'll follow up until it's done.`,
      };
    },
  };
}

// --------------------------------------------------------------- an alert --

export interface CloseAsk {
  alert: string;
  note: string;
}

/** An alert as closing it needs: whom it rings (recipients), and whose mailbox an email one is from. */
export interface AlertSeen {
  id: string;
  title: string;
  status: string;
  source: string;
  mail_account: string | null;
  recipients: string[];
}

/**
 * Who may close an alert, by the Alerts page's rule: admins any, members the
 * ones that ring them; an email alert only with its mailbox. true, or why not.
 * The same for close_alert and for "handled" in a chat (orders.ts).
 */
export function mayClose(me: Pick<Me, "id" | "admin" | "mail">, a: Pick<AlertSeen, "source" | "mail_account" | "recipients">): true | string {
  if (a.source === "email" && !me.mail.includes(str(a.mail_account))) return "That's an email alert whose mailbox isn't shared with them.";
  if (!me.admin && !a.recipients.includes(me.id)) return "Only admins, or the people it rings, close an alert.";
  return true;
}

/**
 * Closing an open alert as handled (kit.ts closeAlert), by the Alerts page's
 * rule (mayClose). Checked after: read back closed.
 */
export function closeAlertCapability(o: { me: Me; read: (id: string) => Promise<AlertSeen | null>; close: (id: string, note: string) => Promise<boolean> }): Capability<CloseAsk> {
  return {
    name: "close_alert",
    description: "Close an open alert as handled, when what it's about was dealt with. Find it first in watch_alert (status open): its id.",
    input_schema: {
      type: "object",
      properties: {
        alert: { type: "string", description: "The alert's id (watch_alert.id)." },
        note: { type: "string", description: "How it was dealt with, short (\"Rabah replied to Abbas\"). Else empty." },
      },
      required: ["alert"],
    },
    effect: "write",
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<CloseAsk>;
      const alert = str(i.alert).trim();
      if (!/^[0-9a-f-]{36}$/i.test(alert)) return "It needs the alert's id (watch_alert.id): find it first.";
      return { alert, note: str(i.note).slice(0, 300) };
    },
    key: (x) => `close:${x.alert}`,
    describe: (x) => `close the alert ${x.alert.slice(0, 8)}`,
    timeoutMs: 15_000,
    retries: 1,
    run: async (x) => {
      const a = await o.read(x.alert);
      if (!a) throw new ToolError("not_found", "No alert has that id.");
      const may = mayClose(o.me, a);
      if (may !== true) throw new ToolError("denied", may);
      if (a.status !== "open") throw new ToolError("conflict", `It's already closed (${a.status}).`);
      await o.close(a.id, x.note);
      const now = await o.read(a.id).catch(() => null);
      if (now?.status === "open") return { data: { closed: false }, verified: { status: "failed" as const, detail: "still open after closing it" } };
      return { data: { closed: true, title: a.title }, verified: { status: "verified" as const, detail: "read back closed" }, receipt: `Closed: ${a.title}.` };
    },
  };
}

// ------------------------------------------------------------- meetings --

export interface FreeAsk {
  days: string[];
  minutes: number;
  search: "" | "earliest" | "nearest_day";
}

/**
 * The free times on the asker's calendar inside Calendly (book.ts
 * freeTimesOf): the same reading as asking the bot, only read.
 */
export function freeTimesCapability(o: { free: (x: FreeAsk) => Promise<string> }): Capability<FreeAsk> {
  return {
    name: "free_times",
    description: "The free times on their calendar inside Calendly, on the days given, or the earliest free time. Only reads; book_meeting books.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "array", items: { type: "string" }, description: "The days, YYYY-MM-DD (at most 7). Empty: the earliest free time." },
        minutes: { type: "integer", description: "How long the meeting is, in minutes. Else 0." },
        search: { type: "string", enum: ["", "earliest", "nearest_day"], description: "earliest: the first free time; nearest_day: the nearest day with free times. Else empty." },
      },
    },
    effect: "read",
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<FreeAsk>;
      const days = (Array.isArray(i.days) ? i.days : []).map(str).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 7);
      const search = i.search === "earliest" || i.search === "nearest_day" ? i.search : "";
      return { days, minutes: Math.max(0, Math.round(Number(i.minutes) || 0)), search };
    },
    timeoutMs: 30_000,
    retries: 1,
    run: async (x) => {
      try {
        return { data: { free: await o.free(x) } };
      } catch (e) {
        const m = (e as Error).message;
        throw new ToolError(passing(m) ? "transient" : "not_found", m);
      }
    },
  };
}

export interface MeetingAsk {
  with: string[];
  date: string;
  time: string;
  minutes: number;
  topic: string;
}

/**
 * Booking a meeting on the asker's Calendly, the way the bot books when asked
 * (book.ts: it says what happened where the request was made). With anyone
 * who isn't on the team (a client), a person OKs it first: never on Claude's
 * word alone. Someone on the team only by their id: a name can be a client's
 * too ("Sara"), so a name needs the OK. Checked after: what the booking said.
 */
export function bookMeetingCapability(o: {
  /** The active team (meetings.ts directory), by profile id; only kind team counts (a guest's is guest: the OK). */
  team: Map<string, Attendee>;
  book: (x: MeetingAsk, key: string) => Promise<{ status: string; said: string | null }>;
}): Capability<MeetingAsk & { outside: boolean }> {
  return {
    name: "book_meeting",
    description:
      "Book a meeting on their Calendly at a day and time that's free (check free_times first), the way the bot books when asked. With a client it isn't booked until a person OKs it: say what you'd book.",
    input_schema: {
      type: "object",
      properties: {
        with: { type: "array", items: { type: "string" }, description: "Who it's with: someone on the team by their profile.id (find it in profile, is_active true), anyone else by full name as iklipse has them." },
        date: { type: "string", description: "The day, YYYY-MM-DD." },
        time: { type: "string", description: "The time, HH:MM (24 hours)." },
        minutes: { type: "integer", description: "How long, in minutes. Else 0 (their usual length)." },
        topic: { type: "string", description: "What it's about, short. Else empty." },
      },
      required: ["with", "date", "time"],
    },
    effect: "write",
    external: true,
    confirm: (x) => x.outside,
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<MeetingAsk>;
      const people = (Array.isArray(i.with) ? i.with : []).map((n) => str(n).trim()).filter(Boolean).slice(0, 10);
      if (!people.length) return "Who is it with?";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(i.date)) || !/^\d{2}:\d{2}$/.test(str(i.time))) return "It needs the day (YYYY-MM-DD) and the time (HH:MM).";
      // The team by id, booked by their name; anyone else (any name, a guest) is outside: the OK first.
      const team = people.map((n) => o.team.get(n.replace(/^t:/, "")));
      const names = people.map((n, k) => team[k]?.name ?? n);
      return { with: names, date: str(i.date), time: str(i.time), minutes: Math.max(0, Math.round(Number(i.minutes) || 0)), topic: str(i.topic).slice(0, 200), outside: team.some((a) => a?.kind !== "team") };
    },
    key: (x) => `meet:${x.date}:${x.time}:${[...x.with].sort().join(",")}`,
    describe: (x) => `book a call with ${x.with.join(", ")} on ${x.date} at ${x.time}${x.topic ? ` (${x.topic})` : ""}`,
    timeoutMs: 60_000,
    run: async (x) => {
      const r = await o.book(x, `meet:${x.date}:${x.time}`);
      const said = r.said ?? "";
      if (r.status === "failed") throw new ToolError("permanent", said || "The booking didn't go through.");
      const data = { status: r.status, said };
      if (r.status === "done") return { data, verified: { status: "verified" as const, detail: "the booking answered" }, receipt: said || undefined };
      return { data, verified: { status: "unknown" as const, detail: `the booking is ${r.status}` }, receipt: said || undefined };
    },
  };
}

// ------------------------------------------------------------- a client --

export interface ClientMessage {
  client: string;
  text: string;
}

/**
 * Writing to a client on WhatsApp. Always a person OKs it first: the agent
 * says what it would send, never sends it on its own (dm.ts puts it to the
 * team as the reply to OK). Once OK'd, it goes as an order would (orders.ts,
 * checked by guard.ts).
 */
export function messageClientCapability(o: { clients: Map<string, Attendee>; send: (to: Attendee, text: string) => Promise<Given> }): Capability<ClientMessage & { to: Attendee }> {
  const byName = (n: string) => [...o.clients.values()].find((c) => c.name.toLowerCase() === n.toLowerCase());
  return {
    name: "message_client",
    description:
      "Write to a client on WhatsApp. It isn't sent until a person OKs it: write the message you'd send, and say so. The message: English, short, only what's theirs (never anyone else's numbers, emails, prices or names), never a promise the team didn't make.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Their id (client.id), or their full name as iklipse has it." },
        text: { type: "string", description: "The message to them, in English." },
      },
      required: ["client", "text"],
    },
    effect: "write",
    external: true,
    confirm: true,
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<ClientMessage>;
      const to = o.clients.get(str(i.client)) ?? byName(str(i.client).trim());
      if (!to?.id) return "No client in iklipse has that id or name: find them in client first.";
      if (!to.phone) return `iklipse has no WhatsApp number for ${to.name}.`;
      const text = str(i.text).replace(/\s*[—–]\s*/g, ", ").trim();
      if (!text) return "It needs the message.";
      if (text.length > 2000) return "Too long: under 2000 characters.";
      return { client: to.id, text, to };
    },
    key: (x) => `client:${x.client}`,
    describe: (x) => `write to ${x.to.name}: "${x.text}"`,
    timeoutMs: 30_000,
    run: async (x) => {
      const r = await o.send(x.to, x.text);
      if (r.problem) throw new ToolError(r.stage === "send" ? "transient" : "invalid_input", r.problem, r.stage === "send");
      return { data: { sent: true }, verified: { status: "submitted" as const, detail: "WhatsApp took it" }, receipt: `Sent to ${first(x.to.name)}.` };
    },
  };
}
