// Orders from the team (0090, 0093). Anyone in a team group (ours: everyone
// there can do anything), and anyone on the team in a client group or
// privately, talks to the bot: "@iklipse tell Rabah to send the logo files to
// Acme", "ask Sara when she's free", "book a meeting with Sara Sunday at 3",
// "what did Acme say about the logo?". It carries orders out without asking
// anyone for an OK, toward the team or clients: it writes to the person
// privately, and keeps after them (Settings: how often) until they say it's
// done, or what's in the way. A client gets at most so many messages
// (Settings); then the bot says so. Everything about an order is said where it
// was given, as a reply to it (from a client group: privately to whoever gave
// it): sent, their answer, done, stuck, a question back (the team's reply to
// that goes to them). Questions are answered from all of iklipse (look.ts). A
// booking link sent privately (book.ts) is followed up the same way, until they
// book. Meetings go to book.ts; the details the bot asked the team for to
// people.ts. No alerts for orders. Reminders only in working hours. Always
// English, in the bot's voice (voice.ts).

import { cairoOffset, cairoStamp, claude, claudeStep, closeAlert, env, iso, MIN, stillQueued, str, TZ, type ClaudeTool, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { firstTime, takeAnswer, type Send } from "./people.ts";
import { bookedSince, directory, type Attendee } from "./meetings.ts";
import { answer as answerTurn, bookTurnAt, botIds, freeTimesOf, heardPrivate, named, orderedMeeting, peopleFor, privateChat } from "./book.ts";
import { historyOf } from "./history.ts";
import { lookUp, notOthersMail, whoAsks } from "./look.ts";
import { whenIn, zoneOf } from "./zones.ts";
import { runAgent } from "./agent/runtime.ts";
import { VOICE } from "./voice.ts";
import { guardIssues, keepBlock, otherClients, reasonsText } from "./guard.ts";
import { memoryFor, memoryOf } from "./memory.ts";
import { cancelReminders, listText, openReminders, sayWhen, setReminder } from "./reminders.ts";
import { CONVERSATION_MS, type Via } from "./gate.ts";
import {
  bookMeetingCapability,
  closeAlertCapability,
  findCapability,
  freeTimesCapability,
  messageClientCapability,
  messageTeamCapability,
  reminderCapability,
  searchCapability,
  type AlertSeen,
  type Given,
  type TeamMessage,
} from "./agent/capabilities.ts";

/** A team member's order is let go after this long without it getting done (it's said in the group). */
const TEAM_TTL_MS = 7 * 24 * 60 * MIN;

export interface Order {
  id: string;
  chat_id: string;
  message_id: string | null;
  by_user: string | null;
  by_name: string | null;
  order_text: string;
  kind: "tell" | "ask";
  to_kind: "team" | "client";
  to_id: string | null;
  to_name: string;
  to_chat: string | null;
  task: string;
  nudge: string | null;
  status: string;
  times: number;
  next_at: string | null;
  sent_ids: string[];
  report_ids: string[];
  outcome: string | null;
  book_url: string | null;
  created_at: string;
  updated_at: string;
}
const COLS = "id, chat_id, message_id, by_user, by_name, order_text, kind, to_kind, to_id, to_name, to_chat, task, nudge, status, times, next_at, sent_ids, report_ids, outcome, book_url, created_at, updated_at";

/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** "Sara, Rabah and Omar" */
const namesOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const quote = (t: string) => `"${t.replace(/\s+/g, " ").trim().slice(0, 600)}"`;

/** Says something about orders where they were given, as a reply to the order when there's one; kept so a reply to it carries on. */
async function report(db: Db, send: Send, at: { chat_id: string; message_id: string | null }, text: string, orders: Order[] = []) {
  const id = await send(at.chat_id, text, at.message_id);
  if (!id) return;
  for (const o of orders) {
    o.report_ids = [...o.report_ids, id];
    await db.from("bot_order").update({ report_ids: o.report_ids }).eq("id", o.id);
  }
}

/** Writes to the person about their order (after the first, as a reply to it); kept so their reply finds it. */
async function toThem(db: Db, send: Send, o: Order, text: string, patch: Record<string, unknown> = {}) {
  if (!o.to_chat) return null;
  const id = await send(o.to_chat, text, o.sent_ids[0] ?? null);
  o.sent_ids = id ? [...o.sent_ids, id] : o.sent_ids;
  await db.from("bot_order").update({ sent_ids: o.sent_ids, updated_at: iso(), ...patch }).eq("id", o.id);
  return id;
}

/**
 * Why a message Claude wrote to a client mustn't go (guard.ts): it may only
 * repeat what the team said (team), their private chat and their own details.
 * Caught, it's kept for the admins.
 */
async function clientCheck(db: Db, p: Attendee, team: string[], text: string, where: string): Promise<string[]> {
  const chat = `${p.phone}@c.us`;
  const [{ data: rows }, { data: c }] = await Promise.all([
    db.from("wa_dm").select("text").eq("chat_id", chat).order("sent_at", { ascending: false }).limit(30),
    p.id ? db.from("client").select("name, company, email, phone").eq("id", p.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const own = c as { name: string | null; company: string | null; email: string | null; phone: string | null } | null;
  const reasons = guardIssues(text, {
    said: [...team, ...((rows ?? []) as { text: string | null }[]).map((m) => str(m.text))],
    phone: p.phone ?? own?.phone,
    email: p.email ?? own?.email,
    own: [p.name, str(own?.name), str(own?.company)].filter(Boolean),
    others: await otherClients(db, p.kind === "client" ? p.id : null),
  });
  if (reasons.length) await keepBlock(db, { where, chat_id: chat, to_name: p.name, text, reasons });
  return reasons;
}

async function close(db: Db, o: Order, status: "done" | "blocked" | "stopped" | "no_answer", outcome: string | null) {
  const { data } = await db
    .from("bot_order")
    .update({ status, outcome: outcome?.slice(0, 2000) ?? o.outcome, closed_at: iso(), next_at: null, updated_at: iso() })
    .eq("id", o.id)
    .eq("status", "open")
    .select("id");
  return !!data?.length;
}

// ------------------------------------------------------------- an order --

const ORDER_TOOL: ClaudeTool = {
  name: "act",
  description: "What to do with the message.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["orders", "meeting", "my_order", "question", "answer", "handled", "stop", "status", "write_out", "remind", "ignore", "none"] },
      text: { type: "string", description: "write_out: the voice note's words, written out. Else empty." },
      orders: {
        type: "array",
        description: "orders: one per person.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tell", "ask"] },
            to: { type: "string", description: "Their ref from people." },
            task: { type: "string", description: "What they're to do, or what they're asked, short, in English." },
            message: { type: "string", description: "The first message to them, in English." },
            nudge: { type: "string", description: "The reminder, in English." },
            wait: { type: "boolean", description: "false when it only passes something on and nothing is needed back; true when they're to do something or answer." },
          },
          required: ["kind", "to", "task", "message", "nudge", "wait"],
        },
      },
      about: { type: "array", items: { type: "string" }, description: "question: the refs of the people and projects it's about, at most 3." },
      stop: { type: "array", items: { type: "string" }, description: "stop: the ids of the open orders to stop." },
      alerts: { type: "array", items: { type: "string" }, description: "handled: the ids of the open alerts dealt with." },
      remind: {
        type: "object",
        description: "remind: what they ask.",
        properties: {
          op: { type: "string", enum: ["set", "list", "cancel"] },
          who: { type: "string", description: "set: \"me\", or the ref from people of someone on the team." },
          text: { type: "string", description: "set: what to remind them of, short, in English (\"send the invoice\", \"call Abbas\"); empty if not said." },
          date: { type: "string", description: "set: the day, YYYY-MM-DD, only when a day is said (\"بكرة\" is tomorrow). Else empty." },
          time: { type: "string", description: "set: the time exactly as said, HH:MM (5 is 05:00, 8:30 is 08:30, 17:00 is 17:00). Never work out AM or PM. Else empty." },
          ampm: { type: "string", enum: ["", "am", "pm"], description: "set: only when the words say it (الصبح، الفجر، am: am; الضهر، العصر، المغرب، بالليل، المسا، pm: pm). Else empty." },
          in_minutes: { type: "integer", description: "set: \"in 30 minutes\", \"بعد ساعة\" (60), \"ba3d nos sa3a\" (30). Else 0." },
          any_time: { type: "boolean", description: "set: true only when they say to send it even outside working hours." },
          cancel: { type: "array", items: { type: "string" }, description: "cancel: the ids from your_reminders (all of them only when they clearly mean all)." },
        },
        required: ["op"],
      },
      reply: { type: "string", description: "none: the short question back, in English. Else empty." },
    },
    required: ["action"],
  },
};

export const ORDER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team wrote to you, in a group or privately ("where" says which). In a group, "came_by" says how it reached you: a mention ("@iklipse ..."), a reply to you (to a message of yours), called you by name (it starts with "iklipse", "ikli", "اكليبس", "بوت" or "يا بوت"), or carrying on your conversation with them (you asked them something there a few minutes ago, in "you_asked_them", and they wrote again without replying to it). Everyone on the team can ask you anything and give you orders. You carry out orders without asking anyone for an OK: you write to the person privately on WhatsApp, and keep after them until it's done. Decide what to do with the message and call act once. They write in English, Arabic, Egyptian Arabic or Franco-Arabic, or send voice notes (written out for you as "[voice note, written out] ..."): what they say in a voice note is their message to you, like text. A message can be a few they sent at once (a line asking for something, and the voice note it's about). Everything you write is in English, except a voice note written out.

- orders: tell someone to do something ("tell Rabah to send the logo files", "قول لرباح يبعت الفايلات لأكمي", "remind Sara to send the content") is kind tell; ask someone something and bring the answer back ("ask Sara when she's free this week", "اسأل عمر خلص الفيديو ولا لسه") is kind ask. Passing something on that needs nothing back ("قوله الميتنج اتأجلت لبكرة", "tell Sara the files are uploaded", "let Omar know I'm late") is kind tell with wait false: the message just says it ("Hi Omar, Sameh says he's running late."), with no "reply when it's done", and you don't follow up. Else wait is true. One order per person. to: their ref from people, never anyone else. task: what they're to do or what they're asked, short ("send the final logo files to Acme", "when she's free for a call this week"). message: the first message to them. To someone on the team: "Hi <first name>, <first name of who asked> asks you to <task>." plus anything the order gives, then for tell with wait true "Reply here when it's done, or tell me what's in the way." To a client: speak for iklipse ("Hi Sara, ..."), only what the order says to tell or ask them, never a team member's name unless the order says it, nothing internal. nudge: the reminder if they don't answer, short ("Rabah, a reminder: Sameh asked you to send the logo files to Acme. Is it done?", "Hi Sara, just following up: when are you free for a call this week?"). Never invent a date, a file, a price or a promise.
- meeting: about meetings on Calendly: book one with someone, free times, move or cancel one, send a booking link (in the group, or privately to someone). Privately, also a reply in a meeting conversation you're having with them ("meeting_talk" shows it, with what they asked for in the group, and "chat"): after you offered a time, "yes" or "4" is about the meeting; after you asked them a day and time, "check with the client", "ask him", "شوف هو فاضي امتى", "خليه يختار" is about the meeting too (the people it's with are in meeting_talk), never a question back about who they mean.
- my_order: privately, their own answer about something you asked them to do or asked them ("your_orders"): it's done, an answer, what's in the way, a question about it, when they'll do it.
- question: they ask about something or someone, anything in iklipse: a client, a project, a delivery, a Trello board or card, a Miro board, what someone said in a group, privately, on Slack or by email, someone's email or number, open alerts, meetings and what was said in them, who's working or came today, invoices, anything. You never need it in people or projects to be a question: it's looked up. about: the refs (from people and projects) it's about, at most 3; empty when it's about none in particular. A name written in a group means the one in people with in_this_group true and that name, before anyone else elsewhere; ask which one only when two people in this group fit. Someone named by their number ("who's +201...") is the one in people whose whatsapp is that number, in any format (+20 10..., 010..., 2010...).
- answer: the message gives what you asked the team about people in the client groups (an email, a number, a name, "skip", "is Rabah"); only when details_asked is true.
- handled: they say open alerts were dealt with ("done", "I replied to Abbas", "خلاص رديت عليه", "handled", a reply to the open alerts list saying which); alerts lists their ids from open_alerts (all of them only when they clearly mean all).
- stop: stop open orders ("stop asking Sara", "خلاص سيبه", "cancel the one to Rabah"); stop lists their ids from open_orders.
- status: they ask what's still open ("what's left?", "ايه اللي لسه").
- remind: a reminder at a time or after a while, for them or for someone on the team: "فكرني الساعة 5", "فكرني بكرة 10 الصبح أكلم عباس", "remind me at 8 to send the invoice", "remind me in 30 minutes", "fakarny ba3d sa3a", "remind Rabah at 3 to send the files". op set: who "me" or their ref; when exactly as said (date, time, ampm, in_minutes), never worked out; text: what to remind them of. Telling someone to do something with no time ("remind Rabah to send the files") is orders, not remind; never an order to the one asking. op list: their reminders ("my reminders", "ايه التذكيرات"). op cancel: cancel from your_reminders ("cancel the 5 o'clock reminder", "شيل التذكير").
- write_out: the message has a voice note and they ask for it as text or in another language ("transcribe it", "اكتبهولي", "translate it to English", "ترجمها عربي"), or privately they sent you a voice note that asks you for nothing (thinking out loud, a pitch, meant for someone else). text: every word of the voice note, cleanly written: no "um", "uh" or repeats, nothing added, nothing left out, nothing summed up. In the language it was said in, unless they ask for English or Arabic (then translated into it). A voice note asking you for something (an order, a question, a meeting) is that action instead, unless they also ask for it written out.
- ignore: nothing for you (thanks, ok, a remark to someone else).
- none: an order you can't carry out: who it's for isn't clear or isn't in people, or what to do isn't said. reply: a short question back ("Who's Ahmed?", "What should I tell Rabah?"). No greeting, no apology.
In a group the team mostly talks to each other. A mention or a reply to you is for you. When came_by is "called you by name" or "carrying on your conversation with them", it may not be: anything addressed to someone else or said to the group ("@Rabah send it", "Omar, did you call them?", "حد شاف الفايل؟", "تمام يا شباب"), or a remark about iklipse the agency or about a bot rather than to you ("iklipse got a new client today", "بوت الواتساب واقع تاني"), is ignore. Carrying on a conversation, only an answer to what you asked them, or something they clearly ask of you, is for you. When you're not sure it's for you, ignore. Never answer talk that wasn't for you with a question (none).
${VOICE}`;

/** How a message in a group reached the bot (gate.ts), as Claude reads it in came_by. */
const CAME_BY: Record<Via, string> = {
  mention: "a mention",
  reply: "a reply to you",
  name: "called you by name",
  conversation: "carrying on your conversation with them",
};
/** came_by for Claude; none privately, or for an order the team gave by replying to a report (followOrder). */
export const cameBy = (via: Via | undefined) => (via ? CAME_BY[via] : undefined);

// With the agent on (agent/runtime.ts), a request that's several steps, or
// fits none of the actions above, is handed over as a task instead of being
// squeezed into one of them. Off, the tool and the words are as they were.
const TASK_RULE = `- task: more than one of the above in one go, or looking something up and then acting on what's found ("see who's late on their deliveries this week and remind each of them", "find what Acme asked for yesterday and ask Rabah if it's done", "who hasn't logged in today? ask them if they're coming"), or anything else about work that fits none of the above. It's worked out step by step after this; nothing else is needed. An order whose people are all in people is still orders, a plain question is still question, a meeting is still meeting.`;

/**
 * The agent takes tasks when BOT_AGENT (a secret on the function) is "on"
 * (anyone on the team) or "admins" (admins only); anything else, it's off.
 */
export function agentFor(by: Person | undefined, mode = env("BOT_AGENT")) {
  if (!by?.active) return false;
  return mode === "on" || (mode === "admins" && by.admin);
}

/** The act tool: with the agent, it can also be a task. */
export function orderTool(agent: boolean): ClaudeTool {
  if (!agent) return ORDER_TOOL;
  const props = ORDER_TOOL.input_schema.properties as Record<string, { enum?: string[] }>;
  return {
    ...ORDER_TOOL,
    input_schema: { ...ORDER_TOOL.input_schema, properties: { ...props, action: { ...props.action, enum: [...props.action.enum!, "task"] } } },
  };
}

/** What Claude is told about the message: with the agent, tasks too. */
export function orderSystem(agent: boolean) {
  return agent ? ORDER_SYSTEM.replace("\n- ignore: ", `\n${TASK_RULE}\n- ignore: `) : ORDER_SYSTEM;
}

/** Where the bot answers about an order: the team group (as a reply to it), or the private chat of the one who gave it. */
export type At = { chat_id: string; message_id: string | null };

/**
 * Carrying on a conversation (gate.ts): what the bot asked them in this group
 * in the last few minutes (its reply to one of their messages), so an answer
 * with no quote is understood. Null when there's none.
 */
async function askedThem(db: Db, chatId: string, who: { phone: string | null; lid: string | null }): Promise<string | null> {
  const { data: ours } = await db
    .from("wa_message")
    .select("text, quoted_id")
    .eq("chat_id", chatId)
    .eq("from_bot", true)
    .gt("sent_at", iso(Date.now() - CONVERSATION_MS))
    .order("sent_at", { ascending: false })
    .limit(10);
  const said = ((ours ?? []) as { text: string | null; quoted_id: string | null }[]).filter((m) => m.quoted_id && str(m.text));
  if (!said.length) return null;
  const { data: rows } = await db.from("wa_message").select("id, sender_id, phone").in("id", said.map((m) => m.quoted_id!));
  const theirs = new Set(
    ((rows ?? []) as { id: string; sender_id: string | null; phone: string | null }[])
      .filter((m) => (!!who.phone && (m.phone === who.phone || m.sender_id === `${who.phone}@c.us`)) || (!!who.lid && m.sender_id === who.lid))
      .map((m) => m.id),
  );
  const last = said.find((m) => theirs.has(m.quoted_id!));
  return last ? str(last.text).replace(/\s+/g, " ").slice(0, 600) : null;
}

/**
 * Someone on the team talking to the bot (once per message): in a team group
 * (anyone there), a message for it (gate.ts, via: a mention, a reply to it,
 * its name first, or carrying on a conversation); in a client group by a
 * mention, or privately (0093: anyone on the team, nobody else). Done right
 * away; what came of it is said in the team group as a reply to it, else
 * privately to them (never in a client group).
 */
export async function takeOrder(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  o: { id: string; chatId: string; where: "team" | "client" | "private"; text: string; quoted: string | null; phone: string | null; lid: string | null; name: string | null; via?: Via },
  answerNow: (id: string) => Promise<void>,
) {
  if (!(await firstTime(db, `order:${o.id}`))) return;
  const by = (o.phone ? t.byPhone.get(o.phone) : undefined) ?? (o.lid ? t.byLid.get(o.lid) : undefined);
  // Outside the team groups only the team is heard: anyone else gets nothing.
  if (o.where !== "team" && !by?.active) return;
  const byName = by?.name ?? o.name ?? "Someone on the team";
  const dm = o.where === "private" ? o.chatId : o.where === "client" && by ? await privateChat(db, by.id) : null;
  const at: At = o.where === "team" ? { chat_id: o.chatId, message_id: o.id } : { chat_id: dm ?? "", message_id: o.where === "private" ? o.id : null };
  // From a client group with no number for them: nowhere to answer that the client wouldn't see.
  if (!at.chat_id) return;
  const ids = s.bot_phone ? await botIds(db, s.bot_phone) : new Set<string>();
  const text = await named(db, o.chatId, o.text, ids);
  const quoted = o.quoted ? await named(db, o.chatId, o.quoted, ids) : null;
  // Carrying on a conversation with no quote: what the bot asked them, so the answer reads right.
  const before = o.via === "conversation" && !quoted ? await askedThem(db, o.chatId, { phone: o.phone, lid: o.lid }) : null;
  // Carrying on a conversation, or only starting with its name, it may have been meant for someone else:
  // no "didn't get that" and no "send it again" (and, carrying on, no question back either: below).
  const asksBack = o.via !== "conversation" && o.via !== "name";

  const dir = await directory(db);
  const [{ data: cl }, { data: pr }, { data: openRows }, { data: asked }, { data: alertRows }] = await Promise.all([
    db.from("client").select("id, name, company, name_known, wa_group(name)").order("updated_at", { ascending: false }).limit(300),
    db.from("project").select("id, title, status, client:client_id(name, company)").in("status", ["active", "on_hold"]).order("updated_at", { ascending: false }).limit(150),
    db.from("bot_order").select(COLS).eq("status", "open").order("created_at").limit(30),
    db.from("bot_ask_message").select("id").eq("chat_id", o.chatId).gt("sent_at", iso(Date.now() - 3 * 24 * 60 * MIN)).limit(1),
    db.from("watch_alert").select("id, title, detail, source, created_at, wa_group(name), slack_channel(name)").eq("status", "open").neq("source", "email").order("created_at").limit(20),
  ]);
  const alerts = (alertRows ?? []) as unknown as { id: string; title: string; detail: string | null; source: string; created_at: string; wa_group: { name: string | null } | null; slack_channel: { name: string | null } | null }[];
  // Who's in this group: a name said here means them first.
  const here = o.chatId.endsWith("@g.us")
    ? new Set((await peopleFor(db, o.chatId, by?.id ?? "", s.bot_phone ?? null)).people.filter((p) => p.in_group).map((p) => p.ref))
    : new Set<string>();
  const people = [
    ...[...dir.team.values()].filter((a) => a.phone !== s.bot_phone).map((a) => ({ ref: `t:${a.id}`, name: a.name, who: "team", whatsapp: a.phone ? `+${a.phone}` : null })),
    ...((cl ?? []) as unknown as { id: string; company: string | null; wa_group: { name: string | null } | null }[]).map((c) => {
      const a = dir.clients.get(c.id)!;
      return { ref: `c:${c.id}`, name: a.name, who: "client", ...(c.wa_group?.name ? { group: c.wa_group.name } : {}), whatsapp: a.phone ? `+${a.phone}` : null };
    }),
  ].map((p) => (here.has(p.ref) ? { ...p, in_this_group: true } : p));
  const projects = ((pr ?? []) as unknown as { id: string; title: string; status: string; client: { name: string; company: string | null } | null }[]).map((p) => ({
    ref: `p:${p.id}`,
    title: p.title,
    status: p.status,
    ...(p.client ? { client: `${p.client.name}${p.client.company ? ` (${p.client.company})` : ""}` } : {}),
  }));
  const open = await freshNames(db, (openRows ?? []) as Order[]);
  // Their reminders (0110), to list or cancel; the time said in their own time zone.
  const me = by ? dir.team.get(by.id) : undefined;
  const reminders = by ? await openReminders(db, by.id) : [];

  // Privately: the chat so far (a meeting being arranged, what the bot asked them), and what they were asked to do.
  let chat: string[] = [];
  let mine: Order[] = [];
  if (o.where === "private") {
    const { data: rows } = await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", o.chatId).order("sent_at", { ascending: false }).limit(10);
    chat = ((rows ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[])
      .reverse()
      // A voice note whole: "write out the last one" can come after (0102).
      .map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m.from_bot ? "YOU" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, /^\[(voice note|audio)/.test(str(m.text)) ? 9000 : 500)}`);
    mine = by ? open.filter((x) => x.to_kind === "team" && x.to_id === by.id) : [];
  }
  // Privately, a meeting the bot asked them about here (asked for in a group, else here): that conversation, start to end (0104).
  let meetingTalk: { group: string | null; turns: string[] } | null = null;
  if (o.where === "private") {
    const { data: last } = await db.from("wa_bot_turn").select("thread_id").eq("chat_id", o.chatId).eq("from_bot", true).gt("created_at", iso(Date.now() - 2 * 60 * MIN)).order("created_at", { ascending: false }).limit(1);
    const thread = last?.[0]?.thread_id as string | undefined;
    if (thread) {
      const [{ data: th }, { data: turns }] = await Promise.all([
        db.from("wa_bot_thread").select("chat_id, chat_name").eq("id", thread).maybeSingle(),
        db.from("wa_bot_turn").select("chat_id, from_bot, user_id, text, created_at").eq("thread_id", thread).order("created_at", { ascending: false }).limit(12),
      ]);
      meetingTalk = {
        group: th?.chat_id === o.chatId ? null : th?.chat_name ?? "a group",
        turns: ((turns ?? []) as { chat_id: string; from_bot: boolean; user_id: string | null; text: string | null; created_at: string }[])
          .reverse()
          .map((x) => `[${cairoStamp.format(new Date(x.created_at))}] ${x.from_bot ? "YOU" : (x.user_id ? dir.team.get(x.user_id)?.name : null) ?? "THEM"} (${x.chat_id === o.chatId ? "privately" : "in the group"}): ${str(x.text).replace(/\s+/g, " ").slice(0, 500)}`),
      };
    }
  }

  const agent = agentFor(by);
  const r = (await claude(
    s,
    // A voice note written out can be long: more time than a quick decision.
    { name: "orders.act", role: "fast", timeoutMs: 50_000 },
    orderSystem(agent),
    JSON.stringify({
      now: `${cairoStamp.format(new Date())} Cairo time`,
      where: o.where === "team" ? "the team group" : o.where === "client" ? "a client group (you answer them privately, never in the group)" : "privately",
      ...(o.via ? { came_by: cameBy(o.via) } : {}),
      from: byName,
      message: text,
      ...(quoted ? { replying_to: quoted } : {}),
      ...(before ? { you_asked_them: before } : {}),
      details_asked: !!asked?.length,
      people,
      projects,
      open_orders: open.map((x, i) => ({ id: `o${i + 1}`, to: x.to_name, kind: x.kind, task: x.task, since: cairoStamp.format(new Date(x.created_at)) })),
      open_alerts: alerts.map((a, i) => ({
        id: `a${i + 1}`,
        what: a.detail || a.title,
        where: a.source === "slack" ? `#${a.slack_channel?.name ?? "channel"}` : a.wa_group?.name ?? null,
        since: cairoStamp.format(new Date(a.created_at)),
      })),
      ...(o.where === "private" ? { chat, your_orders: mine.map((x) => ({ task: x.task, kind: x.kind, from: x.by_name })) } : {}),
      ...(meetingTalk ? { meeting_talk: meetingTalk } : {}),
      ...(reminders.length
        ? {
            your_reminders: reminders.map((x, i) => ({
              id: `r${i + 1}`,
              for: x.for_user === by?.id ? "you" : dir.team.get(x.for_user)?.name ?? "someone on the team",
              at: sayWhen(Date.parse(x.due_at), me?.zone ?? TZ),
              ...(x.text ? { text: x.text } : {}),
            })),
          }
        : {}),
    }),
    orderTool(agent),
    6000,
  ).catch((e) => {
    console.error("order", (e as Error).message);
    return null;
  })) as {
    action?: string;
    text?: string;
    orders?: { kind?: string; to?: string; task?: string; message?: string; nudge?: string; wait?: boolean }[];
    about?: string[];
    stop?: string[];
    alerts?: string[];
    reply?: string;
    remind?: { op?: string; who?: string; text?: string; date?: string; time?: string; ampm?: string; in_minutes?: number; any_time?: boolean; cancel?: string[] };
  } | null;
  // Claude failed even after trying again (kit.ts): they hear it, rather than nothing at all.
  if (!r?.action) {
    if (!asksBack) return;
    return await report(db, send, at, "Something went wrong on my side and I couldn't read that. Send it again in a minute?");
  }
  const off = () => report(db, send, at, "Orders are off. Turn on Take orders from the team in Alerts > Settings.");

  switch (r.action) {
    case "ignore":
      return;
    case "task":
      if (!s.orders_enabled) return await off();
      // Not on for them (the tool only offers it when it is): a question, as before.
      if (!agent || !by) return await report(db, send, at, await answerQuestion(db, s, t, dir, { by, text, quoted, about: [] }));
      return await doTask(db, s, t, send, dir, at, by, { id: o.id, text, quoted, where: o.where, chat });
    case "write_out":
      return await report(db, send, at, str(r.text).replace(/[—–]/g, ", ") || "I couldn't make out the voice note. Send it again?");
    case "none":
      // Carrying on a conversation, it may have been for someone else: no question back, and no task.
      // Called by name, Claude judged it was for the bot: its question goes back.
      if (o.via === "conversation") return;
      // With the agent on, it tries first (who "Ahmed" is, what to tell them): it asks back when it can't.
      if (agent && by && s.orders_enabled) return await doTask(db, s, t, send, dir, at, by, { id: o.id, text, quoted, where: o.where, chat });
      return await report(db, send, at, str(r.reply) || "Didn't get that. Who's it for, and what should I tell them?");
    case "answer":
      await takeAnswer(db, s, t, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null }, send);
      return;
    case "my_order":
      if (o.where === "private" && (await fromTarget(db, s, send, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null }))) return;
      return await report(db, send, at, "Got it.");
    case "meeting": {
      if (!by) return await report(db, send, at, "I don't know who you are on iklipse, so I can't book on your Calendly. Link your number on the Users page.");
      if (!s.book_enabled) return await report(db, send, at, "Booking meetings from WhatsApp is off (Alerts > Settings).");
      // Privately, a meeting being arranged goes on; anything else starts one where they asked.
      const going = o.where === "private" ? await bookTurnAt(db, o.chatId, null) : null;
      const on =
        going && o.phone && Date.now() - Date.parse(going) < 2 * 60 * MIN
          ? await heardPrivate(db, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null, phone: o.phone })
          : await orderedMeeting(db, { id: o.id, chatId: o.chatId, text, quoted, userId: by.id });
      if (on) await answerNow(o.id);
      return;
    }
    case "question":
      if (!s.orders_enabled) return await off();
      return await report(db, send, at, await answerQuestion(db, s, t, dir, { by, text, quoted, about: (r.about ?? []).map(str).filter(Boolean).slice(0, 3) }));
    case "handled": {
      // The team dealt with them: closed as handled by whoever said so.
      const hit = (r.alerts ?? []).map((id) => alerts[Number(str(id).replace(/\D/g, "")) - 1]).filter((x): x is (typeof alerts)[number] => !!x);
      if (!hit.length) return await report(db, send, at, "Which one? No open alert matches.");
      const closed: string[] = [];
      for (const a of hit) if (await closeAlert(db, a.id, "handled", `Handled, said ${byName} on WhatsApp`, by?.id ?? null)) closed.push(a.wa_group?.name ?? a.title);
      return await report(db, send, at, closed.length ? `Closed: ${namesOf([...new Set(closed)])}.` : "Already closed.");
    }
    case "remind": {
      if (!s.orders_enabled) return await off();
      if (!by || !me) return await report(db, send, at, "I don't know who you are on iklipse, so I can't remind you. Link your number on the Users page.");
      const q = r.remind ?? {};
      if (q.op === "list") return await report(db, send, at, listText(reminders, me as { id: string; zone?: string | null }, (id) => dir.team.get(id)?.name ?? "Someone"));
      if (q.op === "cancel") return await report(db, send, at, await cancelReminders(db, reminders, (q.cancel ?? []).map(str), me));
      const ref = str(q.who);
      const who = !ref || ref === "me" ? me : ref.startsWith("t:") ? dir.team.get(ref.slice(2)) : undefined;
      if (!who?.id) return await report(db, send, at, ref.startsWith("c:") ? "I only set reminders for the team." : "Who should I remind?");
      const set = await setReminder(db, s, {
        by: { id: by.id, name: byName, zone: me.zone },
        who,
        text: str(q.text),
        when: { date: str(q.date), time: str(q.time), ampm: q.ampm === "am" || q.ampm === "pm" ? q.ampm : "", in_minutes: Number(q.in_minutes) || 0 },
        anyTime: q.any_time === true,
        sourceId: o.id,
        chatId: o.chatId,
      });
      return await report(db, send, at, set.text);
    }
    case "status": {
      if (!s.orders_enabled) return await off();
      if (!open.length) return await report(db, send, at, "Nothing open.");
      const lines = open.map(
        (x, i) => `${i + 1}. ${x.to_name}: ${x.task} (${x.kind === "ask" ? "asked" : "since"} ${cairoStamp.format(new Date(x.created_at))}${x.times > 1 ? `, ${x.times - 1} reminder${x.times === 2 ? "" : "s"}` : ""})`,
      );
      return await report(db, send, at, ["Open:", ...lines].join("\n"));
    }
    case "stop": {
      if (!s.orders_enabled) return await off();
      const hit = (r.stop ?? []).map((id) => open[Number(str(id).replace(/\D/g, "")) - 1]).filter((x): x is Order => !!x);
      if (!hit.length) return await report(db, send, at, "Which one? Nothing open matches.");
      const stopped: Order[] = [];
      for (const x of hit) {
        if (!(await close(db, x, "stopped", `Stopped by ${byName}`))) continue;
        stopped.push(x);
        // Someone on the team doesn't do it for nothing.
        if (x.kind === "tell" && x.to_kind === "team") await toThem(db, send, x, `No need to ${x.task} anymore.`).catch(() => null);
      }
      return await report(db, send, at, stopped.length ? `Stopped: ${stopped.map((x) => `${x.to_name} (${x.task})`).join("; ")}.` : "Already closed.");
    }
  }
  if (!s.orders_enabled) return await off();

  // Orders: written to each person now, then kept after.
  const made: Order[] = [];
  const told: string[] = [];
  const problems: string[] = [];
  for (const x of r.orders ?? []) {
    const ref = str(x.to);
    const kind = x.kind === "ask" ? "ask" : "tell";
    const p = ref.startsWith("t:") ? dir.team.get(ref.slice(2)) : ref.startsWith("c:") ? dir.clients.get(ref.slice(2)) : undefined;
    if (!p || !str(x.message) || !str(x.task)) {
      problems.push(`Who's ${ref.replace(/^[tc]:/, "") || "that for"}?`);
      continue;
    }
    // An order to the one asking would only nag them: a reminder is what they want.
    if (by && p.kind === "team" && p.id === by.id) {
      problems.push("That's you. Want a reminder instead? Tell me when.");
      continue;
    }
    const g = await giveOrder(db, s, send, at, { id: by?.id ?? null, name: byName }, text, p, { kind, task: str(x.task), message: str(x.message), nudge: str(x.nudge), wait: x.wait !== false });
    if (g.problem) problems.push(g.problem);
    else if (g.told) told.push(first(p.name));
    else if (g.order) made.push(g.order);
  }
  const tells = made.filter((x) => x.kind === "tell").map((x) => first(x.to_name));
  const asks = made.filter((x) => x.kind === "ask").map((x) => first(x.to_name));
  const lines = [
    ...(told.length ? [`Told ${namesOf(told)}.`] : []),
    ...(tells.length ? [`Sent to ${namesOf(tells)}. I'll follow up until it's done.`] : []),
    ...(asks.length ? [`Asked ${namesOf(asks)}. I'll bring the answer ${o.where === "team" ? "here" : "to you"}.`] : []),
    ...problems,
  ];
  if (!lines.length) {
    if (!asksBack) return;
    lines.push("Didn't get that. Who's it for, and what should I tell them?");
  }
  await report(db, send, at, lines.join("\n"), made);
}

/**
 * One order to one person (0090): kept, written to them now, then kept after
 * (unless it only passes something on: said once, and done). What came of it:
 * the order kept after, told, or what went wrong and where (checking them,
 * keeping it, sending it). An order from the team (takeOrder) or a task's
 * step (doTask).
 */
export async function giveOrder(
  db: Db,
  s: Settings,
  send: Send,
  at: At,
  by: { id: string | null; name: string },
  orderText: string,
  p: Attendee,
  x: Omit<TeamMessage, "person">,
): Promise<Given & { order?: Order }> {
  if (!p.phone) {
    return { stage: "check", problem: `I don't have ${p.name}'s WhatsApp number. Add it ${p.kind === "team" ? "on the Users page" : "in Clients (Projects)"}, then ask again.` };
  }
  // To a client, what Claude wrote is checked first (guard.ts): only what the order or their chat says.
  if (p.kind !== "team") {
    const reasons = await clientCheck(db, p, [orderText, x.task], [x.message, x.nudge].join("\n"), "orders.message");
    if (reasons.length) return { stage: "check", problem: `I didn't send it to ${p.name}: the message had ${reasonsText(reasons)}, which isn't in your order or their chat. Tell me exactly what to send.` };
  }
  const { data: row, error } = await db
    .from("bot_order")
    .insert({
      chat_id: at.chat_id,
      message_id: at.message_id,
      by_user: by.id,
      by_name: by.name,
      order_text: orderText.slice(0, 4000),
      kind: x.kind,
      to_kind: p.kind === "team" ? "team" : "client",
      to_id: p.id,
      to_name: p.name,
      to_chat: `${p.phone}@c.us`,
      task: x.task.slice(0, 500),
      nudge: x.nudge.slice(0, 1000) || null,
      times: 1,
      next_at: iso(Date.now() + s.order_every_min * MIN),
    })
    .select(COLS)
    .single();
  if (error || !row) return { stage: "keep", problem: `Couldn't keep the order for ${p.name}.` };
  const ord = row as Order;
  try {
    await toThem(db, send, ord, x.message.replace(/[—–]/g, ", ").slice(0, 2000));
    // Only passing something on: said, and nothing to keep after.
    if (x.kind === "tell" && !x.wait) {
      await close(db, ord, "done", "Told");
      return { order: ord, told: true };
    }
    return { order: ord };
  } catch (e) {
    await db.from("bot_order").update({ status: "failed", outcome: (e as Error).message.slice(0, 300), closed_at: iso(), next_at: null }).eq("id", ord.id);
    return { order: ord, stage: "send", problem: `Couldn't send it to ${p.name}: ${(e as Error).message.slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------- a task --

export const TASK_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team asked you for something that takes a few steps. They write in English, Arabic, Egyptian Arabic or Franco-Arabic, or send voice notes (written out for you). A name said in a group is someone in that group first. Times are Cairo time.
Your answer: always English. They're on the team: share what find lets you read, numbers and emails too.
${VOICE}`;

/**
 * A task (agent/runtime.ts): a request that's several steps, or fits none of
 * the actions. Worked out with find (look.ts, read as the one asking may) and
 * message_team_member (an order, like any other), within the run's limits;
 * what came of it is said where it was asked, as a reply, with a line for
 * each order given, so replies to it carry on like any order's report.
 */
async function doTask(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  dir: Awaited<ReturnType<typeof directory>>,
  at: At,
  by: Person,
  o: { id: string; text: string; quoted: string | null; where: "team" | "client" | "private"; chat: string[] },
) {
  const me = await whoAsks(db, by.id);
  if (!me) return await report(db, send, at, "I can't look things up for you on iklipse.");
  const names = new Map([...dir.team.entries()].map(([id, a]) => [id, a.name]));
  const { now, ...going } = await situation(db, t, dir, me.mail);
  const orders = (id: string) => db.from("bot_order").select("status, sent_ids").eq("id", id).maybeSingle();
  const run = await runAgent({
    request: o.text,
    from: `${by.name} (${by.admin ? "admin" : "on the team"}), ${o.where === "team" ? "in the team group" : o.where === "client" ? "in a client group (answered privately)" : "privately"}`,
    // Privately, the chat so far: an answer to what the bot asked them last time is understood.
    context: JSON.stringify({ now, ...(o.quoted ? { replying_to: o.quoted } : {}), ...(o.chat.length ? { chat: o.chat } : {}), ...going }),
    actor: { id: by.id, name: by.name, role: by.admin ? "admin" : "member" },
    capabilities: [
      findCapability(db, me, names),
      searchCapability(db, me),
      messageTeamCapability({
        team: dir.team,
        botPhone: s.bot_phone,
        answerTo: o.where === "team" ? "here" : "to you",
        give: (p, x) => giveOrder(db, s, send, at, { id: by.id, name: by.name }, o.text, p, x),
        check: async (id) => {
          const { data } = await orders(id);
          return data ? { status: String(data.status), sent: ((data.sent_ids ?? []) as string[]).length } : null;
        },
      }),
      reminderCapability({
        team: dir.team,
        me: by.id,
        set: (who, x) =>
          setReminder(db, s, {
            by: { id: by.id, name: by.name, zone: dir.team.get(by.id)?.zone },
            who,
            text: x.text,
            when: { date: x.date, time: x.time, ampm: x.ampm, in_minutes: x.in_minutes },
            anyTime: x.any_time,
            sourceId: `${o.id}:${x.date}${x.time}${x.ampm}${x.in_minutes}`,
            chatId: at.chat_id,
          }),
        check: async (id) => {
          const { data } = await db.from("bot_reminder").select("status").eq("id", id).maybeSingle();
          return data ? { status: String(data.status) } : null;
        },
      }),
      closeAlertCapability({
        me,
        read: async (id) => {
          const { data } = await db.from("watch_alert").select("id, title, status, source, mail_account, watch_recipient(user_id)").eq("id", id).maybeSingle();
          if (!data) return null;
          const a = data as unknown as AlertSeen & { watch_recipient: { user_id: string }[] | null };
          return { ...a, recipients: (a.watch_recipient ?? []).map((r) => r.user_id) };
        },
        close: (id, note) => closeAlert(db, id, "handled", note || `Handled, said ${by.name} to the bot`, by.id),
      }),
      freeTimesCapability({ free: (x) => freeTimesOf(db, by.id, x) }),
      bookMeetingCapability({
        isTeam: (n) => [...dir.team.values()].some((a) => [a.name, first(a.name)].some((x) => x.toLowerCase() === n.toLowerCase())),
        // As if they'd asked the bot themselves (book.ts): it books, and says so where they asked.
        book: async (x, key) => {
          if (!s.book_enabled) return { status: "failed", said: "Booking meetings from WhatsApp is off (Alerts > Settings)." };
          const id = `${o.id}:${key}`;
          const text = `Book a ${x.minutes ? `${x.minutes}-minute ` : ""}call with ${namesOf(x.with)} on ${x.date} at ${x.time}${x.topic ? ` about ${x.topic}` : ""}.`;
          await orderedMeeting(db, { id, chatId: at.chat_id, text, quoted: null, userId: by.id });
          await answerTurn(db, s, id, send);
          const { data: turn } = await db.from("wa_bot_turn").select("status, error, thread_id").eq("id", id).maybeSingle();
          const { data: said } = turn
            ? await db.from("wa_bot_turn").select("text").eq("thread_id", turn.thread_id).eq("from_bot", true).order("created_at", { ascending: false }).limit(1)
            : { data: [] };
          return { status: str(turn?.status) || "unknown", said: str((said ?? [])[0]?.text) || str(turn?.error) || null };
        },
      }),
      messageClientCapability({
        clients: dir.clients,
        send: (to, text) => giveOrder(db, s, send, at, { id: by.id, name: by.name }, o.text, to, { kind: "tell", task: "a message from the team", message: text, nudge: "", wait: false }),
      }),
    ],
    model: async (req) => await claudeStep(s, { name: "agent.turn", role: "agent" }, req.system, req.messages, req.tools, req.maxTokens, { timeoutMs: req.timeoutMs }),
    runKey: o.id,
    system: TASK_SYSTEM,
    claim: (key) => firstTime(db, key),
    release: async (key) => {
      await db.from("bot_heard").delete().eq("id", key);
    },
    log: (e) => console.log(JSON.stringify(e)),
  });
  // Orders the task gave and kept after: a reply to this report reaches them, like any order's.
  const made = run.steps.map((x) => (x.keep as Given & { order?: Order; told?: boolean } | undefined)).filter((g) => g?.order && !g.told && !g.problem).map((g) => g!.order!);
  await report(db, send, at, run.text.replace(/[—–]/g, ", ") || "Done.", made);
}

// ---------------------------------------------------------- a question --

const ANSWER_TOOL: ClaudeTool = {
  name: "reply",
  description: "The answer to send them.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "The answer, in English." } },
    required: ["text"],
  },
};

export const ANSWER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team asked you something. Answer from what iklipse knows, below: people, projects and deliveries, open alerts, meetings (cancelled_meetings are off), orders, who's working today, and what people said in the groups and by email (voice notes written out, files read), and what iklipse remembers about a client from their chats (remembered: what they said since is newer and wins). They're on the team, so share anything below with them, numbers and emails too. You look up the rest of iklipse only for someone whose WhatsApp number is on their member card in iklipse, and theirs isn't: when the answer isn't below, say that, in a few words; never guess or invent. Always English. Times are Cairo time. Call reply once.
${VOICE}`;

/**
 * A question from the team (0093): what's going on and the people and projects
 * named, then the rest looked up in iklipse as the one asking (look.ts).
 */
async function answerQuestion(
  db: Db,
  s: Settings,
  t: Team,
  dir: Awaited<ReturnType<typeof directory>>,
  q: { by: Person | undefined; text: string; quoted: string | null; about: string[] },
) {
  const nameOf = namer(t, dir);
  // What they may read (look.ts): their mail and email alerts only, whoever the question is about.
  const me = q.by ? await whoAsks(db, q.by.id) : null;
  const mail = me?.mail ?? [];
  const about: Record<string, unknown>[] = [];
  for (const ref of q.about) {
    const id = ref.slice(2);
    if (ref.startsWith("c:")) {
      const { data: c } = await db.from("client").select("id, name, company, email, phone, wa_lid, notes, wa_group(name)").eq("id", id).maybeSingle();
      if (!c) continue;
      const { data: ps } = await db.from("project").select("title, status, due_at").eq("client_id", id).order("created_at", { ascending: false }).limit(10);
      const a = dir.clients.get(id);
      about.push({
        client: a?.name ?? c.name,
        company: c.company,
        email: c.email,
        whatsapp: a?.phone ? `+${a.phone}` : c.phone,
        group: (c as unknown as { wa_group: { name: string | null } | null }).wa_group?.name ?? null,
        notes: str(c.notes).slice(0, 1000) || null,
        projects: (ps ?? []).map((p) => ({ title: p.title, status: p.status, due: stamp(p.due_at) })),
        // What iklipse remembers from their chats (memory.ts): their private chat's part for admins only.
        remembered: memoryFor(await memoryOf(db, id), !!me?.admin),
        said: await historyOf(db, { phone: a?.phone ?? null, lid: c.wa_lid, email: c.email }, 40, mail),
      });
    } else if (ref.startsWith("t:")) {
      const a = dir.team.get(id);
      if (!a) continue;
      const [{ data: ds }, { data: rec }] = await Promise.all([
        db.from("project_delivery").select("title, due_at, project(title)").eq("assignee_id", id).is("done_at", null).order("due_at").limit(10),
        db.from("watch_recipient").select("watch_alert!inner(title, status, created_at, source, mail_account)").eq("user_id", id).eq("watch_alert.status", "open").limit(10),
      ]);
      // Someone else's email alerts stay theirs.
      const theirAlerts = ((rec ?? []) as unknown as { watch_alert: { title: string; created_at: string; source: string; mail_account: string | null } }[]).filter(
        (r) => r.watch_alert.source !== "email" || mail.includes(r.watch_alert.mail_account ?? ""),
      );
      about.push({
        team_member: a.name,
        email: a.email,
        whatsapp: a.phone ? `+${a.phone}` : null,
        deliveries: ((ds ?? []) as unknown as { title: string; due_at: string; project: { title: string } | null }[]).map((d) => ({ title: d.title, project: d.project?.title, due: stamp(d.due_at) })),
        alerts_on_them: theirAlerts.map((r) => ({ title: r.watch_alert.title, since: stamp(r.watch_alert.created_at) })),
        said: await historyOf(db, { phone: a.phone, email: a.email }, 20, mail),
      });
    } else if (ref.startsWith("p:")) {
      const { data: p } = await db
        .from("project")
        .select("id, title, description, status, priority, start_on, due_at, delivered_at, client:client_id(name, company)")
        .eq("id", id)
        .maybeSingle();
      if (!p) continue;
      const [{ data: team }, { data: ds }, { data: notes }] = await Promise.all([
        db.from("project_member").select("user_id, role").eq("project_id", id),
        db.from("project_delivery").select("title, due_at, done_at, assignee_id").eq("project_id", id).order("due_at").limit(20),
        db.from("project_note").select("body, author_id, created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(5),
      ]);
      const cl = (p as unknown as { client: { name: string; company: string | null } | null }).client;
      about.push({
        project: p.title,
        client: cl ? `${cl.name}${cl.company ? ` (${cl.company})` : ""}` : null,
        status: p.status,
        priority: p.priority,
        about: str(p.description).slice(0, 1000) || null,
        starts: p.start_on,
        due: stamp(p.due_at),
        delivered: stamp(p.delivered_at),
        team: (team ?? []).map((m) => `${nameOf(m.user_id) ?? "Someone"}${m.role ? ` (${m.role})` : ""}`),
        deliveries: (ds ?? []).map((d) => ({ title: d.title, due: stamp(d.due_at), done: stamp(d.done_at), who: nameOf(d.assignee_id) })),
        notes: (notes ?? []).map((n) => `${stamp(n.created_at)} ${nameOf(n.author_id) ?? ""}: ${str(n.body).replace(/\s+/g, " ").slice(0, 400)}`),
      });
    }
  }

  const { now, ...going } = await situation(db, t, dir, mail);
  const known = JSON.stringify({
    now,
    asked_by: q.by?.name ?? "someone on the team",
    question: q.text,
    ...(q.quoted ? { replying_to: q.quoted } : {}),
    about,
    ...going,
  });
  if (me) {
    const names = new Map([...dir.team.entries()].map(([id, a]) => [id, a.name]));
    const found = await lookUp(db, s, me, known, names).catch((e) => {
      console.error("look up", (e as Error).message);
      return null;
    });
    if (found) return found.replace(/[—–]/g, ", ");
  }
  const r = (await claude(s, { name: "orders.answer", role: "main" }, ANSWER_SYSTEM, known, ANSWER_TOOL, 1500)) as { text?: string } | null;
  return str(r?.text).replace(/[—–]/g, ", ") || "I couldn't find that.";
}

/** A time in Cairo ("Thu 23 Oct, 14:00"), or null. */
const stamp = (x: string | null | undefined) => (x ? cairoStamp.format(new Date(x)) : null);
/** Someone on the team by their id. */
const namer = (t: Team, dir: Awaited<ReturnType<typeof directory>>) => (id: string | null | undefined) => (id ? dir.team.get(id)?.name ?? t.people.get(id)?.name ?? null : null);

/**
 * What's going on now (0093): open alerts, meetings, orders, deliveries soon,
 * who's working today. For a question, and for a task. Email alerts only of
 * the mailboxes the one asking may read (mail: whoAsks).
 */
export async function situation(db: Db, t: Team, dir: Awaited<ReturnType<typeof directory>>, mail: string[]) {
  const nameOf = namer(t, dir);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayStart = iso(Date.parse(`${today}T00:00:00${cairoOffset()}`));
  const [{ data: alerts }, { data: meetings }, { data: orders }, { data: soon }, { data: sessions }, { data: breaks }, { data: gone }] = await Promise.all([
    db.from("watch_alert").select("id, title, detail, person, source, mail_subject, created_at, wa_group(name), slack_channel(name)").eq("status", "open").or(notOthersMail(mail)).order("created_at", { ascending: false }).limit(25),
    db.from("wa_bot_meeting").select("topic, start_at, minutes, owner, invitee_name, attendees").eq("status", "booked").gte("start_at", iso(Date.now() - 60 * MIN)).order("start_at").limit(10),
    db.from("bot_order").select("to_kind, to_id, to_name, task, by_name, kind, times, created_at").eq("status", "open").order("created_at").limit(20),
    db.from("project_delivery").select("title, due_at, assignee_id, project(title)").is("done_at", null).lte("due_at", iso(Date.now() + 7 * 24 * 60 * MIN)).order("due_at").limit(20),
    db.from("work_session").select("user_id, started_at, ended_at").gte("started_at", dayStart),
    db.from("work_break").select("user_id").is("ended_at", null),
    db.from("wa_bot_meeting").select("topic, start_at, owner, invitee_name, attendees").eq("status", "deleted").gte("start_at", iso()).gt("updated_at", iso(Date.now() - 7 * 24 * 60 * MIN)).order("start_at").limit(10),
  ]);
  const { data: rec } = alerts?.length ? await db.from("watch_recipient").select("alert_id, user_id").in("alert_id", alerts.map((a) => a.id)) : { data: [] };
  const onBreak = new Set((breaks ?? []).map((b) => b.user_id as string));
  const working = new Map<string, string>();
  for (const w of sessions ?? []) {
    const name = nameOf(w.user_id);
    if (!name) continue;
    const now = !w.ended_at ? (onBreak.has(w.user_id) ? "on a break" : "working") : null;
    if (now || !working.has(name)) working.set(name, now ?? `logged out (came at ${stamp(w.started_at)})`);
  }

  return {
      now: `${cairoStamp.format(new Date())} Cairo time (${new Date(Date.now() + Number(cairoOffset().slice(0, 3)) * 60 * MIN).toISOString().slice(0, 16)}${cairoOffset()})`,
      open_alerts: ((alerts ?? []) as unknown as { id: string; title: string; detail: string | null; person: string | null; source: string; mail_subject: string | null; created_at: string; wa_group: { name: string | null } | null; slack_channel: { name: string | null } | null }[]).map((a) => ({
        title: a.title,
        detail: a.detail,
        about: a.person,
        where: a.source === "email" ? `email "${a.mail_subject ?? ""}"` : a.source === "slack" ? `Slack #${a.slack_channel?.name ?? ""}` : a.wa_group?.name,
        since: stamp(a.created_at),
        for: (rec ?? []).filter((x) => x.alert_id === a.id).map((x) => nameOf(x.user_id)).filter(Boolean),
      })),
      meetings: ((meetings ?? []) as unknown as { topic: string; start_at: string; minutes: number | null; owner: string; invitee_name: string | null; attendees: { name: string; host?: boolean }[] | null }[]).map((m) => ({
        topic: m.topic,
        at: stamp(m.start_at),
        minutes: m.minutes,
        on: nameOf(m.owner),
        with: (m.attendees ?? []).filter((a) => !a.host).map((a) => a.name).join(", ") || m.invitee_name,
      })),
      cancelled_meetings: ((gone ?? []) as unknown as { topic: string; start_at: string; owner: string; invitee_name: string | null; attendees: { name: string; host?: boolean }[] | null }[]).map((m) => ({
        topic: m.topic,
        was_at: stamp(m.start_at),
        on: nameOf(m.owner),
        with: (m.attendees ?? []).filter((a) => !a.host).map((a) => a.name).join(", ") || m.invitee_name,
      })),
      orders: (await freshNames(db, orders ?? [])).map((x) => ({ to: x.to_name, task: x.task, from: x.by_name, since: stamp(x.created_at), messages: x.times })),
      deliveries_soon: ((soon ?? []) as unknown as { title: string; due_at: string; assignee_id: string | null; project: { title: string } | null }[]).map((d) => ({
        title: d.title,
        project: d.project?.title,
        due: stamp(d.due_at),
        who: nameOf(d.assignee_id),
      })),
      working_today: Object.fromEntries(working),
    };
}

// ------------------------------------------------------- booking links --

/**
 * A booking link sent privately from a meeting conversation (book.ts, 0093):
 * to each person named, followed up like an order until they book a time on it
 * (it closes by itself once Calendly has their booking) or say what's in the
 * way. What comes of it goes privately to the one who asked (at).
 * With a slot ("Tuesday 21-10-2026, 3:00 PM"), the link is a custom one per
 * person: it opens on that time with their details filled in, so they only
 * confirm it.
 */
export async function linkOrders(
  db: Db,
  s: Settings,
  send: Send,
  at: At,
  o: { byUser: string; byName: string; text: string; url: string | ((p: Attendee) => string | Promise<string>); by: string; slot?: string; start?: number },
  people: Attendee[],
) {
  const made: Order[] = [];
  const problems: string[] = [];
  const asker = first(o.byName);
  const until = o.by ? ` by ${o.by}` : "";
  for (const p of people) {
    if (p.kind === "guest" || !p.id) {
      problems.push(`I don't know ${p.name} on iklipse, so I can't write to them.`);
      continue;
    }
    if (!p.phone) {
      problems.push(`I don't have ${p.name}'s WhatsApp number. Add it ${p.kind === "team" ? "on the Users page" : "in Clients (Projects)"}, then ask again.`);
      continue;
    }
    const name = first(p.name);
    const hi = /^[A-Za-z]/.test(name) ? `Hi ${name}` : "Hi";
    const url = typeof o.url === "function" ? await o.url(p) : o.url;
    // The time in their own time zone (0101).
    const theirs = o.start ? whenIn(o.start, zoneOf(p)) : `${o.slot} (Cairo time)`;
    const message = o.slot
      ? p.kind === "team"
        ? `${hi}, ${asker} set a call with you for ${theirs}. Your details are filled in, just tap "Schedule Event" to confirm:\n${url}`
        : `${hi}, your call with us is set for ${theirs}. Your details are filled in, just tap "Schedule Event" to confirm:\n${url}`
      : p.kind === "team"
        ? `${hi}, ${asker} asks you to book a time for a call${until}:\n${url}`
        : `${hi}, please pick a time that suits you for a call with us${until}:\n${url}`;
    const nudge = o.slot
      ? `${hi}, a reminder to confirm our call on ${theirs}:\n${url}`
      : p.kind === "team"
        ? `${/^[A-Za-z]/.test(name) ? `${name}, a` : "A"} reminder: ${asker} asked you to book a time for a call${until}:\n${url}`
        : `${hi}, just a reminder to pick a time for our call${until}:\n${url}`;
    const { data: row, error } = await db
      .from("bot_order")
      .insert({
        chat_id: at.chat_id,
        message_id: at.message_id,
        by_user: o.byUser,
        by_name: o.byName,
        order_text: o.text.slice(0, 4000),
        kind: "tell",
        to_kind: p.kind,
        to_id: p.id,
        to_name: p.name,
        to_chat: `${p.phone}@c.us`,
        task: o.slot ? `confirm the call on ${theirs} on the link` : `book a time for a call on the link${until}`,
        nudge,
        times: 1,
        next_at: iso(Date.now() + s.order_every_min * MIN),
        book_url: url,
      })
      .select(COLS)
      .single();
    if (error || !row) {
      problems.push(`Couldn't keep it for ${p.name}.`);
      continue;
    }
    const ord = row as Order;
    try {
      await toThem(db, send, ord, message);
      made.push(ord);
    } catch (e) {
      await db.from("bot_order").update({ status: "failed", outcome: (e as Error).message.slice(0, 300), closed_at: iso(), next_at: null }).eq("id", ord.id);
      problems.push(`Couldn't send it to ${p.name}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const sent = namesOf(made.map((x) => first(x.to_name)));
  const lines = [
    ...(made.length
      ? [o.slot ? `Sent ${sent} the link for ${o.slot}, with the details filled in. I'll follow up until they confirm.` : `Sent the link to ${sent}. I'll follow up until they book.`]
      : []),
    ...problems,
  ];
  await report(db, send, at, lines.join("\n") || "Nobody to send it to.", made);
}

/** Booking links followed up: closed once Calendly has their booking (found by their email), and the one who asked is told. */
export async function bookedOrders(db: Db, send: Send) {
  const { data } = await db.from("bot_order").select(COLS).eq("status", "open").not("book_url", "is", null).order("created_at").limit(20);
  const open = await freshNames(db, (data ?? []) as Order[]);
  if (!open.length) return 0;
  const booked = await bookedSince(db, iso(Date.parse(open[0].created_at) - MIN));
  let n = 0;
  for (const x of open) {
    const b = booked.find((m) => m.at >= Date.parse(x.created_at) - MIN && m.people.some((a) => a.kind === x.to_kind && a.id === x.to_id));
    if (!b) continue;
    if (await close(db, x, "done", `Booked ${b.when}`)) {
      await report(db, send, { chat_id: x.chat_id, message_id: x.message_id }, `${first(x.to_name)} booked: *${b.topic}*, ${b.when} Cairo time.`, [x]).catch(() => null);
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------ their answer --

/** The open orders to this private chat. */
async function openTo(db: Db, chatId: string) {
  const { data } = await db.from("bot_order").select(COLS).eq("to_chat", chatId).eq("status", "open").order("created_at");
  return (data ?? []) as Order[];
}

/** When the bot last wrote to them about an open order (null: none open). */
export async function orderAt(db: Db, chatId: string): Promise<string | null> {
  const { data } = await db.from("bot_order").select("updated_at").eq("to_chat", chatId).eq("status", "open").order("updated_at", { ascending: false }).limit(1);
  return (data?.[0]?.updated_at as string | undefined) ?? null;
}

/** The message replied to is the bot's, about an order (to them, or in the team group). */
export async function orderOf(db: Db, quotedId: string | null, col: "sent_ids" | "report_ids"): Promise<Order | null> {
  if (!quotedId) return null;
  const { data } = await db.from("bot_order").select(COLS).contains(col, [quotedId]).order("created_at", { ascending: false }).limit(1);
  return (await freshNames(db, (data ?? []) as Order[]))[0] ?? null;
}

/**
 * Orders keep the name the person had when they were given (a client known
 * only by their number then): they're said by the name iklipse has now.
 */
async function freshNames<T extends { to_kind: string; to_id: string | null; to_name: string }>(db: Db, list: T[]): Promise<T[]> {
  const ids = (kind: string) => [...new Set(list.filter((x) => x.to_kind === kind && x.to_id).map((x) => x.to_id!))];
  const [clients, team] = [ids("client"), ids("team")];
  const [c, t] = await Promise.all([
    clients.length ? db.from("client").select("id, name").in("id", clients) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    team.length ? db.from("profile").select("id, display_name").in("id", team) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);
  const now = new Map<string, string>();
  for (const r of c.data ?? []) if (str(r.name)) now.set(`client:${r.id}`, str(r.name));
  for (const r of t.data ?? []) if (str(r.display_name)) now.set(`team:${r.id}`, str(r.display_name));
  for (const x of list) x.to_name = now.get(`${x.to_kind}:${x.to_id}`) ?? x.to_name;
  return list;
}

const REPLY_TOOL: ClaudeTool = {
  name: "outcome",
  description: "What their message says about what they were asked.",
  input_schema: {
    type: "object",
    properties: {
      order: { type: "string", description: "The id of the order it's about (o1...)." },
      result: { type: "string", enum: ["done", "answer", "blocked", "later", "question", "other"] },
      text: { type: "string", description: "In English: done, what they said about it (empty if just done); answer, their answer, exactly what they mean; blocked, what's in the way; question, their question. Else empty." },
      until: { type: "string", description: "later: when they said they'll do it, ISO 8601 with the Cairo offset, if they said. Else empty." },
    },
    required: ["order", "result"],
  },
};

const REPLY_SYSTEM = `The iklipse bot (a creative and marketing agency's assistant on WhatsApp) wrote to someone privately because the team asked it to: to do something (tell), or to answer a question (ask). You get what it asked them (open orders), the last messages, and their new message. They write in English, Arabic, Egyptian Arabic or Franco-Arabic. Decide through the outcome tool:
- done: it's done ("done", "sent", "خلصت", "بعته", "تم").
- answer: an ask, answered ("Tuesday at 3 works", "الفيديو لسه هيخلص بكرة").
- blocked: they can't, or something is in the way ("I don't have the files", "مش هقدر", "مستني العميل").
- later: they will, not yet ("ok", "on it", "حاضر", "بعد الغدا").
- question: they ask something back about it that the team has to answer ("which files?", "أبعتها لمين؟").
- other: not about it.
Always answer by calling the outcome tool, once.`;

/**
 * Someone the bot wrote to about an order answering it privately. What it
 * says goes to the team group (done, an answer, what's in the way, a
 * question back); false: it isn't about an order (the caller carries on).
 */
export async function fromTarget(db: Db, s: Settings, send: Send, o: { id: string; chatId: string; text: string; quotedId: string | null }): Promise<boolean> {
  if (!(await firstTime(db, `target:${o.id}`))) return true;
  const quoted = await orderOf(db, o.quotedId, "sent_ids");
  const open = quoted?.status === "open" ? [quoted] : await openTo(db, o.chatId);
  if (!open.length) return false;
  const { data: rows } = await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", o.chatId).order("sent_at", { ascending: false }).limit(12);
  const r = (await claude(
    s,
    { name: "orders.outcome", role: "fast" },
    REPLY_SYSTEM,
    [
      "Open orders:",
      ...open.map((x, i) => `o${i + 1}: ${x.kind}; ${x.task} (from ${x.by_name ?? "the team"})`),
      "",
      "Last messages:",
      ...((rows ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[])
        .reverse()
        .map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m.from_bot ? "BOT" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, 500)}`),
      "",
      `Their new message: ${o.text.slice(0, 2000)}`,
    ].join("\n"),
    REPLY_TOOL,
    500,
  )) as { order?: string; result?: string; text?: string; until?: string } | null;
  const x = open[Number(str(r?.order).replace(/\D/g, "")) - 1] ?? (open.length === 1 ? open[0] : undefined);
  if (!r || !x || r.result === "other" || !r.result) return false;
  // A booking link: a time they give, or a question, is talked through in their chat (dm.ts), which books it.
  if (x.book_url && ["answer", "question"].includes(r.result)) return false;
  const said = str(r.text);
  const name = first(x.to_name);
  const at = { chat_id: x.chat_id, message_id: x.message_id };

  switch (r.result) {
    case "done":
      if (await close(db, x, "done", said || "Done")) {
        await report(db, send, at, `${name} says it's done${said ? `: ${quote(said)}` : "."}`, [x]);
        await send(o.chatId, "Got it, thanks.", o.id);
      }
      return true;
    case "answer":
      if (await close(db, x, "done", said)) {
        await report(db, send, at, `${name}: ${quote(said || o.text)}`, [x]);
        await send(o.chatId, "Thanks, I'll pass it on.", o.id);
      }
      return true;
    case "blocked":
      if (await close(db, x, "blocked", said)) {
        await report(db, send, at, `${name} is stuck${said ? `: ${quote(said)}` : "."}`, [x]);
        await send(o.chatId, "OK, I told the team.", o.id);
      }
      return true;
    case "question":
      // Not reminded while the team answers.
      await db.from("bot_order").update({ next_at: iso(Date.now() + Math.max(s.order_every_min, 120) * MIN), updated_at: iso() }).eq("id", x.id);
      await report(db, send, at, `${name} asks: ${quote(said || o.text)}\nReply to this message and I'll pass it on.`, [x]);
      await send(o.chatId, "I'll ask the team and get back to you.", o.id);
      return true;
    case "later": {
      const when = Date.parse(str(r.until));
      const next = Number.isFinite(when) && when > Date.now() && when < Date.now() + 7 * 24 * 60 * MIN ? when + 10 * MIN : Date.now() + s.order_every_min * MIN;
      await db.from("bot_order").update({ next_at: iso(next), updated_at: iso() }).eq("id", x.id);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------- the team about it --

const FOLLOW_TOOL: ClaudeTool = {
  name: "follow",
  description: "What the team's reply means for the order.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["relay", "order", "again", "done", "stop", "ignore"] },
      text: {
        type: "string",
        description: "relay: the message to send them, in English, keeping exactly what the team means. order: the instruction as it stands alone, in English, naming the person and every detail. Else empty.",
      },
    },
    required: ["action"],
  },
};

export const FOLLOW_SYSTEM = `The iklipse bot is carrying out an order from the team: it wrote privately to someone (to do something, or to answer a question) and reports in the team group. Someone on the team replied to one of those reports. They write in English, Arabic, Egyptian Arabic or Franco-Arabic. Decide through the follow tool:
- relay: something to tell the person: an answer to their question, more details, a change ("the ones in the Drive folder", "قوله يبعتها لسارة"). text: that message to them. Never say something was done (booked, sent) unless the team says it was done.
- order: the team tells the bot to do something rather than say something: book a call ("احجزله الجمعة 5", "book it"), send a booking link, ask someone else. text: the instruction as it stands alone ("Book a call with Abbas on Friday at 5 PM").
- again: remind them now ("remind him", "فكره تاني").
- done: it's done or not needed ("done", "خلاص اتعمل").
- stop: stop following it up ("stop", "سيبه", "cancel").
- ignore: nothing for the bot (thanks, ok, a remark).
Always answer by calling the follow tool, once.
${VOICE}`;

/** The team replying in the group to the bot's report on an order. */
export async function followOrder(db: Db, s: Settings, send: Send, x: Order, o: { id: string; chatId: string; text: string }, order?: (text: string) => Promise<void>) {
  if (!(await firstTime(db, `follow:${o.id}`))) return;
  const { data: rows } = x.to_chat ? await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", x.to_chat).order("sent_at", { ascending: false }).limit(8) : { data: [] };
  const r = (await claude(
    s,
    { name: "orders.follow", role: "fast" },
    FOLLOW_SYSTEM,
    [
      `The order (${x.kind}, to ${x.to_name}, ${x.status}): ${x.task}`,
      "",
      "The private chat with them:",
      ...((rows ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[])
        .reverse()
        .map((m) => `${m.from_bot ? "BOT" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, 400)}`),
      "",
      `The team's reply: ${o.text.slice(0, 2000)}`,
    ].join("\n"),
    FOLLOW_TOOL,
    600,
  )) as { action?: string; text?: string } | null;
  const at = { chat_id: o.chatId, message_id: o.id };
  const name = first(x.to_name);
  switch (r?.action) {
    case "relay": {
      const text = str(r.text).replace(/[—–]/g, ", ");
      if (!text || !x.to_chat) return;
      if (x.to_kind === "client") {
        const p = { kind: "client" as const, id: x.to_id, name: x.to_name, email: null, phone: x.to_chat.replace(/\D/g, "") };
        const reasons = await clientCheck(db, p, [o.text, x.task, x.order_text], text, "orders.relay");
        if (reasons.length) return await report(db, send, at, `I didn't send it to ${name}: it had ${reasonsText(reasons)}, which isn't in what you said. Tell me exactly what to send.`, [x]);
      }
      // Back on: they have what they asked for.
      await toThem(db, send, x, text, x.status === "open" ? { next_at: iso(Date.now() + s.order_every_min * MIN) } : {});
      if (x.status === "blocked") await db.from("bot_order").update({ status: "open", closed_at: null, next_at: iso(Date.now() + s.order_every_min * MIN) }).eq("id", x.id);
      return await report(db, send, at, `Sent to ${name}.`, [x]);
    }
    case "order":
      if (!str(r.text) || !order) return;
      return await order(str(r.text));
    case "again":
      if (x.status !== "open" || !x.nudge) return await report(db, send, at, "That one's closed.");
      await toThem(db, send, x, x.nudge, { times: x.times + 1, next_at: iso(Date.now() + s.order_every_min * MIN) });
      return await report(db, send, at, `Reminded ${name}.`, [x]);
    case "done":
      if (await close(db, x, "done", "Closed by the team")) await report(db, send, at, "OK, closed.");
      return;
    case "stop":
      if (await close(db, x, "stopped", "Stopped by the team")) await report(db, send, at, "OK, I stopped.");
      return;
  }
}

// ------------------------------------------------------------ reminders --

/** Orders nobody has answered: reminded every order_every_min (working hours only; the caller checks). */
export async function nagOrders(db: Db, s: Settings, send: Send, deadline: number) {
  const { data } = await db.from("bot_order").select(COLS).eq("status", "open").lte("next_at", iso()).order("next_at").limit(10);
  let n = 0;
  for (const x of await freshNames(db, (data ?? []) as Order[])) {
    if (Date.now() > deadline) break;
    const at = { chat_id: x.chat_id, message_id: x.message_id };
    // A client gets so many messages at most; then the team hears it.
    if (x.to_kind === "client" && x.times >= s.order_client_max) {
      if (await close(db, x, "no_answer", null)) {
        await report(db, send, at, `${first(x.to_name)} hasn't answered after ${x.times} message${x.times === 1 ? "" : "s"}, so I stopped.`).catch(() => null);
      }
      continue;
    }
    if (x.to_kind === "team" && Date.now() - Date.parse(x.created_at) > TEAM_TTL_MS) {
      if (await close(db, x, "no_answer", null)) {
        await report(db, send, at, `${first(x.to_name)} still hasn't said it's done after a week, so I stopped reminding.`).catch(() => null);
      }
      continue;
    }
    // The last one hasn't gone out yet (the phone is offline): nothing piles up behind it.
    if (await stillQueued(db, x.to_chat, x.sent_ids.at(-1), x.updated_at)) continue;
    try {
      await toThem(db, send, x, x.nudge || `A reminder: ${x.task}.`, { times: x.times + 1, next_at: iso(Date.now() + s.order_every_min * MIN) });
      n++;
    } catch (e) {
      await db.from("bot_order").update({ next_at: iso(Date.now() + s.order_every_min * MIN) }).eq("id", x.id);
      console.error("order nudge", (e as Error).message);
    }
  }
  return n;
}
