// Orders from the team (0090, 0093). Anyone on the team (no guest, nobody
// iklipse doesn't know), in a team group, a client group or privately, talks
// to the bot: "@iklipse tell Rabah to send the logo files to
// Acme", "ask Sara when she's free", "book a meeting with Sara Sunday at 3",
// "what did Acme say about the logo?". It carries orders out without asking
// anyone for an OK, toward the team or clients: it writes to the person
// privately, and keeps after them (Settings: how often) until they say it's
// done, or what's in the way. A client gets at most so many messages
// (Settings); then the bot says so. Everything about an order is said where it
// was given, as a reply to it (from a client group: privately to whoever gave
// it): sent, their answer, done, stuck, a question back (the team's reply to
// that goes to them). Questions are answered from all of iklipse (look.ts).
// Anything else they'd ask an assistant (write a caption, translate, explain,
// brainstorm, an opinion) is answered like one (chat), in their own language,
// in a team group or privately, never from a client group. A
// booking link sent privately (book.ts) is followed up the same way, until they
// book. Meetings go to book.ts; the details the bot asked the team for to
// people.ts. No alerts for orders. Reminders only in working hours. Always
// English, in the bot's voice (voice.ts).

import { cairoOffset, cairoStamp, claude, claudeStep, closeAlert, env, iso, MIN, stillQueued, str, TZ, type ClaudeTool, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { firstTime, partnerPeople, partners, takeAnswer, WHO_IS_WHO, whoIsWho, type Send } from "./people.ts";
import { bookedSince, directory, type Attendee } from "./meetings.ts";
import { answer as answerTurn, bookTurnAt, botIds, freeTimesOf, heardPrivate, named, orderedMeeting, peopleFor, privateChat } from "./book.ts";
import { historyOf } from "./history.ts";
import { lookUp, notOthersMail, TABLE_GUIDE, whoAsks, type Me } from "./look.ts";
import { whenIn, zoneOf } from "./zones.ts";
import { runAgent } from "./agent/runtime.ts";
import { VOICE } from "./voice.ts";
import { guardIssues, keepBlock, otherClients, reasonsText } from "./guard.ts";
import { memoryFor, memoryOf } from "./memory.ts";
import { numbered, taughtNotes, teachFrom, type TeachAct } from "./notes.ts";
import { cancelReminders, listText, openReminders, sayWhen, setReminder } from "./reminders.ts";
import { CONVERSATION_MS, type Via } from "./gate.ts";
import { groupsIn, postInGroup } from "./post.ts";
import { alertAct, type AlertAct } from "./pause.ts";
import {
  bookMeetingCapability,
  closeAlertCapability,
  findCapability,
  freeTimesCapability,
  mayClose,
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

/**
 * Who an order to "everyone" goes to: the team (directory: active only), but
 * not the one asking (by profile or by number) and not the bot; a number two
 * profiles share gets it once. Someone with no number stays in: they hear why.
 */
export function everyone(team: Map<string, Attendee>, me: { id: string | null; phone: string | null }, botPhone: string | null): Attendee[] {
  const seen = new Set<string>();
  return [...team.values()]
    .filter((a) => {
      if (a.id === me.id || (a.phone && (a.phone === me.phone || a.phone === botPhone))) return false;
      if (!a.phone) return true;
      if (seen.has(a.phone)) return false;
      seen.add(a.phone);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A message to everyone, written to one of them: {name} is their first name;
 * else a greeting to someone else ("Hi team,", "Sara, a reminder") becomes
 * theirs, or they're greeted first. names: the team's first names, lower case.
 */
export function toEach(text: string, name: string, names: Set<string>) {
  const t = text.trim();
  if (!t) return t;
  if (t.includes("{name}")) return t.replaceAll("{name}", name);
  const hi = /^(hi|hello|hey|dear)\b[^,!.:\n]{0,20}[,!.:]\s*/i;
  if (hi.test(t)) return t.replace(hi, `Hi ${name}, `);
  const lead = /^(\p{L}+),\s*/u.exec(t);
  if (lead && (names.has(lead[1]!.toLowerCase()) || /^(team|everyone|all|guys)$/i.test(lead[1]!))) return `${name}, ${t.slice(lead[0].length)}`;
  return `Hi ${name}, ${/^(A|Just|Quick|Please|The|Reminder)\b/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t}`;
}

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
      action: { type: "string", enum: ["orders", "meeting", "my_order", "question", "answer", "handled", "stop", "status", "write_out", "remind", "post", "alert", "teach", "chat", "ignore", "none"] },
      text: { type: "string", description: "write_out: the voice note's words, written out. Else empty." },
      orders: {
        type: "array",
        description: "orders: one per person.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tell", "ask"] },
            to: { type: "string", description: "Their ref from people, or \"everyone\" for everyone on the team." },
            task: { type: "string", description: "What they're to do, or what they're asked, short, in English." },
            message: { type: "string", description: "The first message to them, in English. To everyone: {name} where each one's first name goes." },
            nudge: { type: "string", description: "The reminder, in English. To everyone: {name} where each one's first name goes." },
            wait: { type: "boolean", description: "false when it only passes something on and nothing is needed back; true when they're to do something or answer." },
          },
          required: ["kind", "to", "task", "message", "nudge", "wait"],
        },
      },
      about: { type: "array", items: { type: "string" }, description: "question or chat: the refs of the people and projects it's about, at most 3." },
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
      post: {
        type: "object",
        description: "post: what to post, and where.",
        properties: {
          group: { type: "string", description: "The group's name from groups; when what they said isn't clearly one of them, as they said it." },
          alert: { type: "string", description: "The id from open_alerts it's about, when it's about one. Else empty." },
          tag: { type: "array", items: { type: "string" }, description: "The refs from people to tag in it." },
          text: { type: "string", description: "The message as it's posted, in English." },
        },
        required: ["group", "text"],
      },
      alert: {
        type: "object",
        description: "alert: pause one open alert, or remind people about it every so often (pause.ts).",
        properties: {
          id: { type: "string", description: "The id from open_alerts: the one quoted or named, or \"this alert\" when only one fits. Empty when they don't say which." },
          until_date: { type: "string", description: "Pause it until: the day, YYYY-MM-DD, only when a day is said (\"tomorrow\", \"بكرة\"). Else empty." },
          until_time: { type: "string", description: "Pause it until: the time exactly as said, HH:MM (2 is 02:00, 14:00 is 14:00). Never work out AM or PM. Else empty." },
          until_ampm: { type: "string", enum: ["", "am", "pm"], description: "Only when the words say it (pm, الضهر، العصر، بالليل: pm; am, الصبح: am). Else empty." },
          pause_minutes: { type: "integer", description: "Pause it for a while: \"for 2 hours\" is 120. Else 0." },
          resume: { type: "boolean", description: "true: end its pause now (\"resume\", \"unpause\")." },
          every_min: { type: "integer", description: "Remind them every this many minutes (\"every 20 minutes\" 20, \"every hour\" 60, \"كل نص ساعة\" 30). 0 when not said." },
          people: { type: "array", items: { type: "string" }, description: "The refs from people of whoever to remind; empty when they name nobody (\"every 30 minutes instead\" keeps who's reminded)." },
          also: { type: "boolean", description: "true when the people named come on top of the ones already reminded (\"also remind Joe\")." },
          stop: { type: "boolean", description: "true: stop reminding them (\"stop reminding them\", \"بطل تفكرهم\")." },
        },
      },
      teach: {
        type: "object",
        description: "teach: what they teach you, or ask about it (notes.ts).",
        properties: {
          op: { type: "string", enum: ["add", "list", "forget"] },
          notes: { type: "array", items: { type: "string" }, description: "add: each thing to remember, one short line in English, people named in full (\"Sara Ahmed is not a client.\", \"Answer Omar in Franco-Arabic.\")." },
          replaces: { type: "array", items: { type: "string" }, description: "add: the ids from taught that these change or contradict." },
          people: {
            type: "array",
            description: "add: whoever it says is or isn't a client.",
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "Their ref from people; empty when they aren't in people." },
                name: { type: "string", description: "Their name as said." },
                is: { type: "string", enum: ["client", "freelancer", "partner", "not_client"] },
              },
              required: ["name", "is"],
            },
          },
          forget: { type: "array", items: { type: "string" }, description: "forget: the ids from taught to forget." },
        },
        required: ["op"],
      },
      reply: { type: "string", description: "none: the short question back, in English. Else empty." },
      answers: { type: "boolean", description: "Carrying on your conversation with them (came_by): true only when the message answers what you asked them (you_asked_them). Else false." },
    },
    required: ["action"],
  },
};

export const ORDER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team wrote to you, in a group or privately ("where" says which). In a group, "came_by" says how it reached you: a mention ("@iklipse ..."), a reply to you (to a message of yours), called you by name (it starts with "iklipse", "ikli", "ya bot", "ya robot", "اكليبس", "ايكليبس" or "يا بوت"), or carrying on your conversation with them (you asked them something there a few minutes ago, in "you_asked_them", and they wrote again without replying to it). Everyone on the team can ask you anything and give you orders. You carry out orders without asking anyone for an OK: you write to the person privately on WhatsApp, and keep after them until it's done; asked to, you also post in a group you're in. Decide what to do with the message and call act once. They write in English, Arabic, Egyptian Arabic or Franco-Arabic, or send voice notes (written out for you as "[voice note, written out] ..."): what they say in a voice note is their message to you, like text. A message can be a few they sent at once (a line asking for something, and the voice note it's about). Everything you write is in English, except a voice note written out.

- orders: tell someone to do something ("tell Rabah to send the logo files", "قول لرباح يبعت الفايلات لأكمي", "remind Sara to send the content") is kind tell; ask someone something and bring the answer back ("ask Sara when she's free this week", "اسأل عمر خلص الفيديو ولا لسه") is kind ask. Passing something on that needs nothing back ("قوله الميتنج اتأجلت لبكرة", "tell Sara the files are uploaded", "let Omar know I'm late") is kind tell with wait false: the message just says it ("Hi Omar, Sameh says he's running late."), with no "reply when it's done", and you don't follow up. Else wait is true. One order per person. to: their ref from people, never anyone else. task: what they're to do or what they're asked, short ("send the final logo files to Acme", "when she's free for a call this week"). message: the first message to them. To someone on the team: "Hi <first name>, <first name of who asked> asks you to <task>." plus anything the order gives, then for tell with wait true "Reply here when it's done, or tell me what's in the way." To a client: speak for iklipse ("Hi Sara, ..."), only what the order says to tell or ask them, never a team member's name unless the order says it, nothing internal. To a freelancer or a partner company's person (who "freelancer" or "partner"): they work with us, so like the team ("Hi Mona, Sameh asks you to ..."), but nothing else internal: no client's name, price or number the order doesn't give. nudge: the reminder if they don't answer, short ("Rabah, a reminder: Sameh asked you to send the logo files to Acme. Is it done?", "Hi Sara, just following up: when are you free for a call this week?"). Never invent a date, a file, a price or a promise. Everyone on the team ("message everyone on the team", "اسأل التيم كله", "tell the whole team"): one order with to "everyone", {name} in its message and nudge where each one's first name goes ("Hi {name}, ..."); it goes to each one active on the team but them, right away, so the message says all they need to do.
- meeting: about meetings on Calendly: book one with someone, free times, move or cancel one, send a booking link (in the group, or privately to someone). Privately, also a reply in a meeting conversation you're having with them ("meeting_talk" shows it, with what they asked for in the group, and "chat"): after you offered a time, "yes" or "4" is about the meeting; after you asked them a day and time, "check with the client", "ask him", "شوف هو فاضي امتى", "خليه يختار" is about the meeting too (the people it's with are in meeting_talk), never a question back about who they mean.
- my_order: privately, their own answer about something you asked them to do or asked them ("your_orders"): it's done, an answer, what's in the way, a question about it, when they'll do it.
- question: they ask about something or someone, anything in iklipse: a client, a project, a delivery, a Trello board or card, a Miro board, what someone said in a group, privately, on Slack or by email, someone's email or number, open alerts, meetings and what was said in them, who's working or came today, invoices, who's on the team, our freelancers or partners, anything. Asking you to remove or add someone on the team is question too (the answer says how it's done); telling you someone is our freelancer or a partner, or to add one ("add Mona to our freelancers", "Acme Studio is a partner company"), is teach. You never need it in people or projects to be a question: it's looked up. about: the refs (from people and projects) it's about, at most 3; empty when it's about none in particular. A name written in a group means the one in people with in_this_group true and that name, before anyone else elsewhere; ask which one only when two people in this group fit. Someone named by their number ("who's +201...") is the one in people whose whatsapp is that number, in any format (+20 10..., 010..., 2010...).
- answer: the message gives what you asked the team about people in the client groups (an email, a number, a name, "skip", "is Rabah"); only when details_asked is true.
- handled: they say open alerts were dealt with ("done", "I replied to Abbas", "خلاص رديت عليه", "handled", a reply to the open alerts list saying which); alerts lists their ids from open_alerts (all of them only when they clearly mean all).
- stop: stop open orders ("stop asking Sara", "خلاص سيبه", "cancel the one to Rabah"); stop lists their ids from open_orders.
- status: they ask what's still open ("what's left?", "ايه اللي لسه").
- remind: a reminder at a time or after a while, for them or for someone on the team: "فكرني الساعة 5", "فكرني بكرة 10 الصبح أكلم عباس", "remind me at 8 to send the invoice", "remind me in 30 minutes", "fakarny ba3d sa3a", "remind Rabah at 3 to send the files". op set: who "me" or their ref; when exactly as said (date, time, ampm, in_minutes), never worked out; text: what to remind them of. Telling someone to do something with no time ("remind Rabah to send the files") is orders, not remind; never an order to the one asking. op list: their reminders ("my reminders", "ايه التذكيرات"). op cancel: cancel from your_reminders ("cancel the 5 o'clock reminder", "شيل التذكير").
- write_out: the message has a voice note and they ask for it as text or in another language ("transcribe it", "اكتبهولي", "translate it to English", "ترجمها عربي"), or privately they sent you a voice note that asks you for nothing (thinking out loud, a pitch, meant for someone else). text: every word of the voice note, cleanly written: no "um", "uh" or repeats, nothing added, nothing left out, nothing summed up. In the language it was said in, unless they ask for English or Arabic (then translated into it). A voice note asking you for something (an order, a question, a meeting) is that action instead, unless they also ask for it written out.
- post: post a message in a group you're in, right away ("send @Sara a reminder in the Nile Foods group about this alert", "post in the Acme group that the files are ready", "ابعت في جروب أكمي إن الفيديو خلص"). group: its name from groups; when what they said isn't clearly one of groups, as they said it (never your guess). alert: the open alert it's about ("this alert", "the last open alert" is the newest, the last in open_alerts). tag: the refs from people of whoever they name to tag. text: the message as you'd post it, in English, "@<their name>" where a tag goes; about an alert, what it is and what's needed, from open_alerts. In a group of kind client the client reads it: write it to them, with nothing internal (no "a reminder", no alert, nothing the team says among itself). After you asked them where to post it ("Post it in X, where that alert is?", "Which group: A or B?"), their answer ("yes", "the first one", a group's name) is post: what they asked for in earlier, in the group they chose. Asking whether you can post in other groups is question.
- alert: pause one open alert until a time, or remind people about it every so often until it's resolved, or change that ("pause reminders for this alert till tomorrow at 2 pm, then send @Sara and Omar a message every 20 minutes till it's resolved", "pause it for 2 hours", "remind Sara about the Acme alert every 30 minutes", "resume", "stop reminding them", "every 30 minutes instead", "وقف التنبيه ده لحد بكرة الساعة 2"). id: the alert from open_alerts, the one quoted or named, or "this alert" when only one fits; empty when they don't say which. The pause's end exactly as said (until_date, until_time, until_ampm), never worked out, or pause_minutes for a while. every_min and people: the reminders. Reminding people about an open alert every so often is alert, never remind or orders. Asking whether you can do it is question.
- teach: they teach you something to keep from now on, in every chat: a fact about iklipse, its people, clients or work ("remember: Acme's launch moved to March", "Omar is our freelancer", "Sara Ahmed is not a client", "سارة هي اللي ماسكة ديزاين أكمي"), or a standing instruction ("from now on, answer me in Franco", "don't reply in the groups unless we talk to you", "ma tb3tsh l Omar ba3d 10 bel leil"). Correcting something you said ("she's not a client" after you called her one) is teach too, even carrying on a conversation. Telling you what someone is ("Omar is our freelancer") is teach; asking you to add or remove someone on the team is question; telling you someone is our freelancer or partner, or to add one, is teach. op add: notes, each a short line as you'll keep it; replaces: the ids from taught it changes or contradicts; people: whoever it says is or isn't a client (is client, freelancer, partner or not_client; ref from people when they're there). op list: they ask what you were taught ("what did we teach you?", "اتعلمت ايه"). op forget: forget some (forget: their ids from taught; "forget 2" is n2). Something to do once, now, is never teach.
- chat: they want you as their assistant, the way they'd use Claude or ChatGPT, for something none of the above does: write or rewrite something ("write me a caption for this", "draft a reply to this email", "اكتبلي بوست عن العرض", "e3mely caption lel reel da"), translate a text ("translate this to English", "ترجمها عربي"; a voice note in the message is write_out), explain or sum up ("explain what CPM means", "lakhasly el kalam da"), brainstorm ("5 names for the new brand", "ideas for Acme's Ramadan campaign"), give your opinion ("what do you think about this idea?", "eh ra2yak?"), answer a general question or give advice, or just talk with you ("how are you?", "عامل ايه"). Even about our work, when what they want is your own writing or thinking, it's chat: you can look things up in iklipse while you write (about: the refs it's about, as for question). A fact from iklipse (who, what, when, where it stands) is question; something to send to someone is orders; something to post in a group is post. After you wrote something for them (in earlier or chat), "shorter", "another one", "in Arabic", "خليها أقصر", "mesh 3agbany" is chat too.
- ignore: nothing for you (thanks, ok, a remark to someone else).
- none: an order you can't carry out: who it's for isn't clear or isn't in people, or what to do isn't said. reply: a short question back ("Who's Ahmed?", "What should I tell Rabah?"). No greeting, no apology.
In a group the team mostly talks to each other. A mention or a reply to you is for you. When came_by is "called you by name" or "carrying on your conversation with them", it may not be: anything addressed to someone else or said to the group ("@Rabah send it", "Omar, did you call them?", "حد شاف الفايل؟", "تمام يا شباب"), or a remark about iklipse the agency or about a bot rather than to you ("iklipse got a new client today", "بوت الواتساب واقع تاني"), is ignore. Carrying on a conversation, only an answer to what you asked them, or something they clearly ask of you, is for you; a question or chat only when it answers what you asked them (answers true), never small talk with the others. When you're not sure it's for you, ignore. Never answer talk that wasn't for you with a question (none).
In a group, "earlier" has what they wrote there in the last hour and what you answered them, and what you last posted to the group just before, oldest first. It's only to understand the new message: act on the new message alone, never again on something earlier you already did. When the new message only pushes ("right now", "now", "do it", "yalla", "go ahead", "and?"), it's their latest request in earlier that you didn't carry out: do that now, as if they'd just sent it, never ask them what they mean.
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

/** The act tool: with the agent, it can also be a task; chat off (a client group), never chat. */
export function orderTool(agent: boolean, chat = true): ClaudeTool {
  if (!agent && chat) return ORDER_TOOL;
  const props = ORDER_TOOL.input_schema.properties as Record<string, { enum?: string[] }>;
  const actions = [...props.action.enum!.filter((a) => chat || a !== "chat"), ...(agent ? ["task"] : [])];
  return {
    ...ORDER_TOOL,
    input_schema: { ...ORDER_TOOL.input_schema, properties: { ...props, action: { ...props.action, enum: actions } } },
  };
}

/**
 * What Claude is told about the message: with the agent, tasks too. Chat (an
 * assistant's answer, chatAnswer) only in a team group or privately: from a
 * client group, its line isn't there.
 */
export function orderSystem(agent: boolean, chat = true) {
  const words = chat ? ORDER_SYSTEM : ORDER_SYSTEM.replace(/\n- chat: [^\n]+/, "");
  const task = chat ? `${TASK_RULE} Your own writing or thinking for them is still chat.` : TASK_RULE;
  return agent ? words.replace("\n- ignore: ", `\n${task}\n- ignore: `) : words;
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

/** How far back what they said in a group is shown with their new message (earlier). */
export const EARLIER_MS = 60 * MIN;
/** How far back the bot's own last post to the group (the open alerts list) is shown with it. */
const POSTED_MS = 5 * MIN;

/**
 * In a group, what this sender wrote there in the last hour before this
 * message, and the bot's replies to it, oldest first: "right now" or "do it"
 * after a request is about that request, not a new one. With it, what the bot
 * last posted to the group in the few minutes before (the open alerts list),
 * so a push right after it is about what it shows. Each message is read on its
 * own (once, firstTime), so this is all it knows of the ones before.
 */
async function earlierFrom(db: Db, chatId: string, id: string, who: { phone: string | null; lid: string | null }, bot: Set<string>): Promise<string[]> {
  const { data } = await db
    .from("wa_message")
    .select("id, sender_id, phone, from_bot, text, quoted_id, sent_at")
    .eq("chat_id", chatId)
    .gt("sent_at", iso(Date.now() - EARLIER_MS))
    .order("sent_at", { ascending: false })
    .limit(100);
  const rows = (data ?? []) as { id: string; sender_id: string | null; phone: string | null; from_bot: boolean; text: string | null; quoted_id: string | null; sent_at: string }[];
  // Only before this one (it may be kept already, and more after it).
  const self = rows.find((m) => m.id === id);
  const before = rows.filter((m) => m.id !== id && str(m.text) && (!self || m.sent_at <= self.sent_at));
  const theirs = new Set(
    before
      .filter((m) => !m.from_bot && ((!!who.phone && (m.phone === who.phone || m.sender_id === `${who.phone}@c.us`)) || (!!who.lid && m.sender_id === who.lid)))
      .map((m) => m.id),
  );
  if (!theirs.size) return [];
  // The bot's last post to the group (a reply to no one), if it was just before.
  const posted = before
    .filter((m) => m.from_bot && !m.quoted_id && Date.parse(m.sent_at) > Date.now() - POSTED_MS)
    .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0];
  const lines = before
    .filter((m) => theirs.has(m.id) || (m.from_bot && !!m.quoted_id && theirs.has(m.quoted_id)) || m === posted)
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
    .slice(-12)
    .map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m === posted ? "YOU, to the group" : m.from_bot ? "YOU" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, m === posted ? 800 : 400)}`);
  // Tags as names, like the new message.
  return (await named(db, chatId, lines.join("\n"), bot)).split("\n");
}

/**
 * The message they replied to in a group: as WhatsApp sends it with theirs, or
 * as iklipse kept it when that says more. A photo or a voice note comes with
 * what's in it (files.ts), which the quote doesn't carry: "write me a caption
 * for this" is about what the photo shows.
 */
export async function quotedText(db: Db, chatId: string, quoted: string | null, quotedId?: string | null): Promise<string | null> {
  if (!quotedId || !chatId.endsWith("@g.us")) return quoted;
  const { data } = await db.from("wa_message").select("text").eq("id", quotedId).eq("chat_id", chatId).maybeSingle();
  const kept = str(data?.text);
  return kept.length > str(quoted).length ? kept : quoted;
}

/** Someone the bot takes orders from and answers: on the team now (not who left), and not a guest. */
export const onTheTeam = (p: Person | null | undefined): p is Person => !!p?.active && !p.guest;

/** What someone the bot doesn't help hears (cantHelp). */
export const CANT_HELP = "I can't help you here.";

/**
 * Someone the bot doesn't help (iklipse doesn't know them, they left, or a
 * guest) wrote to it: no order, no answer. In a team group or privately, when
 * it was clearly for the bot (a mention, a reply to it, privately), they hear
 * so, once a day at most; in a client group, nothing.
 */
async function cantHelp(db: Db, send: Send, o: { id: string; chatId: string; where: "team" | "client" | "private"; phone: string | null; lid: string | null; via?: Via }) {
  const who = o.phone ?? o.lid;
  if (o.where === "client" || !who || o.via === "conversation" || o.via === "name") return;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  if (await firstTime(db, `cant-help:${who}:${day}`)) await send(o.chatId, CANT_HELP, o.id);
}

/**
 * A reply in a group to what the bot asked the team (index.ts fromTeam: an OK
 * for a reply to a client, clients' details): only the team decides. Anyone
 * else hears cantHelp. true: not theirs to answer.
 */
export async function notTheTeam(db: Db, t: Team, send: Send, o: { id: string; chatId: string; phone?: string | null; lid?: string | null }) {
  if (!o.chatId.endsWith("@g.us")) return false;
  const by = (o.phone ? t.byPhone.get(o.phone) : undefined) ?? (o.lid ? t.byLid.get(o.lid) : undefined);
  if (onTheTeam(by)) return false;
  await cantHelp(db, send, { id: o.id, chatId: o.chatId, where: "team", phone: o.phone ?? null, lid: o.lid ?? null });
  return true;
}

/**
 * Someone on the team talking to the bot (once per message): in a team group,
 * a message for it (gate.ts, via: a mention, a reply to it, its name first,
 * or carrying on a conversation); in a client group by a mention, or
 * privately (0093: anyone on the team, nobody else; cantHelp). Done right
 * away; what came of it is said in the team group as a reply to it, else
 * privately to them (never in a client group).
 */
export async function takeOrder(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  o: { id: string; chatId: string; where: "team" | "client" | "private"; text: string; quoted: string | null; quotedId?: string | null; phone: string | null; lid: string | null; name: string | null; via?: Via },
  answerNow: (id: string) => Promise<void>,
) {
  if (!(await firstTime(db, `order:${o.id}`))) return;
  const by = (o.phone ? t.byPhone.get(o.phone) : undefined) ?? (o.lid ? t.byLid.get(o.lid) : undefined);
  // Only the team is heard, in every chat: anyone else gets no order and no answer.
  if (!onTheTeam(by)) return await cantHelp(db, send, o);
  const byName = by?.name ?? o.name ?? "Someone on the team";
  const dm = o.where === "private" ? o.chatId : o.where === "client" && by ? await privateChat(db, by.id) : null;
  const at: At = o.where === "team" ? { chat_id: o.chatId, message_id: o.id } : { chat_id: dm ?? "", message_id: o.where === "private" ? o.id : null };
  // From a client group with no number for them: nowhere to answer that the client wouldn't see.
  if (!at.chat_id) return;
  const ids = s.bot_phone ? await botIds(db, s.bot_phone) : new Set<string>();
  const text = await named(db, o.chatId, o.text, ids);
  const replied = await quotedText(db, o.chatId, o.quoted, o.quotedId);
  const quoted = replied ? await named(db, o.chatId, replied, ids) : null;
  // Carrying on a conversation with no quote: what the bot asked them, so the answer reads right.
  const before = o.via === "conversation" && !quoted ? await askedThem(db, o.chatId, { phone: o.phone, lid: o.lid }) : null;
  // In a group, what they asked just before: "right now" carries that on.
  const earlier = o.chatId.endsWith("@g.us") ? await earlierFrom(db, o.chatId, o.id, { phone: o.phone, lid: o.lid }, ids) : [];
  // Carrying on a conversation, or only starting with its name, it may have been meant for someone else:
  // no "didn't get that" and no "send it again" (and, carrying on, no question back either: below).
  const asksBack = o.via !== "conversation" && o.via !== "name";

  // The groups it's in: where it can post.
  const [dir, groups] = await Promise.all([directory(db), groupsIn(db)]);
  const [{ data: cl }, { data: pr }, { data: openRows }, { data: asked }, { data: alertRows }] = await Promise.all([
    db.from("client").select("id, name, company, name_known, wa_group(name)").order("updated_at", { ascending: false }).limit(300),
    db.from("project").select("id, title, status, client:client_id(name, company)").in("status", ["active", "on_hold"]).order("updated_at", { ascending: false }).limit(150),
    db.from("bot_order").select(COLS).eq("status", "open").order("created_at").limit(30),
    db.from("bot_ask_message").select("id").eq("chat_id", o.chatId).gt("sent_at", iso(Date.now() - 3 * 24 * 60 * MIN)).limit(1),
    db.from("watch_alert").select("id, chat_id, title, detail, source, created_at, wa_group(name), slack_channel(name)").eq("status", "open").neq("source", "email").order("created_at", { ascending: false }).limit(20),
  ]);
  // The newest 20, oldest first: the last one is the newest open alert ("the last open alert").
  const alerts = ((alertRows ?? []) as unknown as { id: string; chat_id: string | null; title: string; detail: string | null; source: string; created_at: string; wa_group: { name: string | null } | null; slack_channel: { name: string | null } | null }[])
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  // Who's in this group: a name said here means them first.
  const here = o.chatId.endsWith("@g.us")
    ? new Set((await peopleFor(db, o.chatId, by?.id ?? "", s.bot_phone ?? null)).people.filter((p) => p.in_group).map((p) => p.ref))
    : new Set<string>();
  // Freelancers and partners' people (people.ts, 0115): written to privately, like clients.
  const outside = partnerPeople(await partners(db));
  const people = [
    ...[...dir.team.values()].filter((a) => a.phone !== s.bot_phone).map((a) => ({ ref: `t:${a.id}`, name: a.name, who: "team", whatsapp: a.phone ? `+${a.phone}` : null })),
    ...((cl ?? []) as unknown as { id: string; company: string | null; wa_group: { name: string | null } | null }[]).map((c) => {
      const a = dir.clients.get(c.id)!;
      return { ref: `c:${c.id}`, name: a.name, who: "client", ...(c.wa_group?.name ? { group: c.wa_group.name } : {}), whatsapp: a.phone ? `+${a.phone}` : null };
    }),
    ...[...outside.values()].map((a) => ({ ref: `o:${a.id}`, name: a.name, who: a.who, ...(a.groups.length ? { group: a.groups.join(", ") } : {}), whatsapp: a.phone ? `+${a.phone}` : null })),
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
  // What admins taught it (notes.ts), with ids that never move (numbered), so an admin can change or forget one.
  const taught = by?.admin ? await numbered(db, await taughtNotes(db)) : [];

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
  // Chatting like a normal assistant: in a team group or privately, never from a client group.
  const chatOn = o.where !== "client";
  const r = (await claude(
    s,
    // A voice note written out can be long: more time than a quick decision.
    { name: "orders.act", role: "fast", timeoutMs: 50_000 },
    orderSystem(agent, chatOn),
    JSON.stringify({
      // With the date and year: a day said ("tomorrow") comes back as YYYY-MM-DD (remind, alert).
      now: nowText(),
      where: o.where === "team" ? "the team group" : o.where === "client" ? "a client group (you answer them privately, never in the group)" : "privately",
      ...(o.via ? { came_by: cameBy(o.via) } : {}),
      from: byName,
      message: text,
      ...(quoted ? { replying_to: quoted } : {}),
      ...(before ? { you_asked_them: before } : {}),
      ...(earlier.length ? { earlier } : {}),
      details_asked: !!asked?.length,
      people,
      projects,
      // Its kind: a client group is read by the client (the post rule).
      groups: groups.map((g) => ({ name: g.name, kind: g.kind === "team" ? "team" : "client" })),
      open_orders: open.map((x, i) => ({ id: `o${i + 1}`, to: x.to_name, kind: x.kind, task: x.task, since: cairoStamp.format(new Date(x.created_at)) })),
      open_alerts: alerts.map((a, i) => ({
        id: `a${i + 1}`,
        what: a.detail || a.title,
        where: a.source === "slack" ? `#${a.slack_channel?.name ?? "channel"}` : a.wa_group?.name ?? null,
        since: cairoStamp.format(new Date(a.created_at)),
      })),
      ...(o.where === "private" ? { chat, your_orders: mine.map((x) => ({ task: x.task, kind: x.kind, from: x.by_name })) } : {}),
      ...(meetingTalk ? { meeting_talk: meetingTalk } : {}),
      ...(taught.length ? { taught: taught.map((n) => ({ ...(n.no !== undefined ? { id: `n${n.no}` } : {}), text: n.text })) } : {}),
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
    orderTool(agent, chatOn),
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
    answers?: boolean;
    remind?: { op?: string; who?: string; text?: string; date?: string; time?: string; ampm?: string; in_minutes?: number; any_time?: boolean; cancel?: string[] };
    teach?: TeachAct;
    post?: { group?: string; alert?: string; tag?: string[]; text?: string };
    alert?: AlertAct;
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
    case "teach":
      // Carrying on a conversation, someone who can't teach it may have been talking to the others.
      if (!by?.admin && o.via === "conversation") return;
      return await report(db, send, at, await teachFrom(db, s, t, by, { id: o.id, chatId: o.chatId }, r.teach ?? {}, taught));
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
      // Carrying on a conversation, only an answer to what it asked them: small talk with the others isn't for it.
      if (o.via === "conversation" && r.answers !== true) return;
      if (!s.orders_enabled) return await off();
      return await report(db, send, at, await answerQuestion(db, s, t, dir, { by, text, quoted, about: (r.about ?? []).map(str).filter(Boolean).slice(0, 3) }));
    case "chat": {
      // Like a normal assistant, with what was said just before (earlier in a group, the chat privately).
      // From a client group it isn't offered: if it comes anyway, a question, as before.
      // Carrying on a conversation, only an answer to what it asked them, as for a question.
      if (o.via === "conversation" && r.answers !== true) return;
      if (!s.orders_enabled) return await off();
      const about = (r.about ?? []).map(str).filter(Boolean).slice(0, 3);
      const talk = o.where === "client" ? null : { where: o.where, name: byName, talk: o.where === "private" ? chat : earlier };
      return await report(db, send, at, await answerQuestion(db, s, t, dir, { by, text, quoted, about, ...(talk ? { chat: talk } : {}) }));
    }
    case "handled": {
      // The team dealt with them: closed as handled by whoever said so, by close_alert's rule (mayClose):
      // admins any, members the ones that ring them (email alerts aren't in open_alerts).
      const hit = (r.alerts ?? []).map((id) => alerts[Number(str(id).replace(/\D/g, "")) - 1]).filter((x): x is (typeof alerts)[number] => !!x);
      if (!hit.length) return await report(db, send, at, "Which one? No open alert matches.");
      const [asker, { data: rec }] = await Promise.all([whoAsks(db, by.id), db.from("watch_recipient").select("alert_id, user_id").in("alert_id", hit.map((a) => a.id))]);
      const rings = (id: string) => ((rec ?? []) as { alert_id: string; user_id: string }[]).filter((x) => x.alert_id === id).map((x) => x.user_id);
      const closed: string[] = [];
      const notTheirs: string[] = [];
      for (const a of hit) {
        if (!asker || mayClose(asker, { source: a.source, mail_account: null, recipients: rings(a.id) }) !== true) notTheirs.push(a.wa_group?.name ?? a.title);
        else if (await closeAlert(db, a.id, "handled", `Handled, said ${byName} on WhatsApp`, by.id)) closed.push(a.wa_group?.name ?? a.title);
      }
      const lines = [
        ...(closed.length ? [`Closed: ${namesOf([...new Set(closed)])}.`] : []),
        ...(notTheirs.length ? [`Not closed: ${namesOf([...new Set(notTheirs)])}. Only admins, or the people it rings, close an alert.`] : []),
      ];
      return await report(db, send, at, lines.join("\n") || "Already closed.");
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
    case "post": {
      // In a group it's in, right away (post.ts): admins only; about an alert, its group is offered when the name fits none.
      if (!s.orders_enabled) return await off();
      const q = r.post ?? {};
      const alert = alerts[Number(str(q.alert).replace(/\D/g, "")) - 1];
      const tag = (q.tag ?? [])
        .map(str)
        .map((ref) => (ref.startsWith("t:") ? dir.team.get(ref.slice(2)) : ref.startsWith("c:") ? dir.clients.get(ref.slice(2)) : ref.startsWith("o:") ? outside.get(ref.slice(2)) : undefined))
        .filter((p): p is Attendee => !!p);
      return await report(
        db,
        send,
        at,
        await postInGroup(db, send, { admin: !!by?.active && !!by?.admin }, {
          group: str(q.group),
          text: str(q.text),
          tag,
          alertGroup: alert?.source === "slack" ? null : alert?.chat_id ?? null,
          said: [text, str(quoted), ...(alert ? [alert.title, str(alert.detail)] : [])],
        }),
      );
    }
    case "alert": {
      // Pause an open alert, or remind people about it every so often (pause.ts): admins only.
      if (!s.orders_enabled) return await off();
      const q = r.alert ?? {};
      const refs = (q.people ?? []).map(str).filter(Boolean);
      const people = refs.map((ref) => (ref.startsWith("t:") ? dir.team.get(ref.slice(2)) : undefined)).filter((p): p is Attendee => !!p);
      const others = refs
        .filter((ref) => !ref.startsWith("t:") || !dir.team.has(ref.slice(2)))
        .map((ref) => (ref.startsWith("c:") ? dir.clients.get(ref.slice(2))?.name : ref.startsWith("o:") ? outside.get(ref.slice(2))?.name : undefined) ?? ref.replace(/^[tco]:/, ""));
      const act = { by: { id: by?.id ?? "", name: byName, admin: !!by?.active && !!by?.admin, zone: me?.zone }, act: q, open: alerts, people, others, at };
      return await report(db, send, at, await alertAct(db, s, { ...act, alert: alerts[Number(str(q.id).replace(/\D/g, "")) - 1] }));
    }
  }
  if (!s.orders_enabled) return await off();

  // Orders: written to each person now, then kept after.
  const made: Order[] = [];
  const told: string[] = [];
  const problems: string[] = [];
  const give = async (p: Attendee, x: Omit<TeamMessage, "person">) => {
    const g = await giveOrder(db, s, send, at, { id: by?.id ?? null, name: byName }, text, p, x);
    if (g.problem) problems.push(g.problem);
    else if (g.told) told.push(first(p.name));
    else if (g.order) made.push(g.order);
  };
  for (const x of r.orders ?? []) {
    const ref = str(x.to);
    const kind = x.kind === "ask" ? "ask" : "tell";
    // Everyone on the team: one order each, written to each by name.
    if (/^(t:)?(everyone|all|team)$/i.test(ref) && str(x.message) && str(x.task)) {
      const all = everyone(dir.team, { id: by?.id ?? null, phone: o.phone }, s.bot_phone ?? null);
      if (!all.length) problems.push("There's no one else on the team to write to.");
      const names = new Set([...dir.team.values()].map((a) => first(a.name).toLowerCase()));
      for (const p of all) {
        await give(p, { kind, task: str(x.task), message: toEach(str(x.message), first(p.name), names), nudge: toEach(str(x.nudge), first(p.name), names), wait: x.wait !== false });
      }
      continue;
    }
    const p = ref.startsWith("t:") ? dir.team.get(ref.slice(2)) : ref.startsWith("c:") ? dir.clients.get(ref.slice(2)) : ref.startsWith("o:") ? outside.get(ref.slice(2)) : undefined;
    if (!p || !str(x.message) || !str(x.task)) {
      problems.push(`Who's ${ref.replace(/^[tco]:/, "") || "that for"}?`);
      continue;
    }
    // An order to the one asking would only nag them: a reminder is what they want.
    if (by && p.kind === "team" && p.id === by.id) {
      problems.push("That's you. Want a reminder instead? Tell me when.");
      continue;
    }
    await give(p, { kind, task: str(x.task), message: str(x.message), nudge: str(x.nudge), wait: x.wait !== false });
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
    // A freelancer or a partner's person (0115): no page in iklipse to add it on yet.
    if (p.kind === "partner") return { stage: "check", problem: `I don't have ${p.name}'s WhatsApp number yet, so I can't write to them.` };
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
${WHO_IS_WHO}
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
        // Someone on the team only by their id: "Sara" can be a client too, so a name needs the OK.
        // A guest (directory has them as active) isn't on the team: booked by name, with the OK too.
        team: new Map([...dir.team].map(([id, a]): [string, Attendee] => [id, onTheTeam(t.people.get(id)) ? a : { ...a, kind: "guest" }])),
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
        // Freelancers and partners' people too (0115), written to the same way.
        clients: new Map([...dir.clients, ...partnerPeople(await partners(db))]),
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

/** What the bot does when the team asks it (takeOrder), for a question about it ("can you message other groups?"). */
export const YOU_CAN = [
  "write privately on WhatsApp to anyone on the team, or a client, for the team, and follow up until it's done or answered",
  "write privately to our freelancers and partners' people",
  "write to everyone on the team at once",
  "post in any group you're in right away, tagging people, when an admin asks, and say where it went",
  "remember what an admin teaches you in chat (facts, standing instructions, who is or isn't a client, our freelancers and partners) in every chat from then on, and list it or forget one when an admin asks",
  "book, move and cancel meetings on Calendly, and send booking links",
  "set reminders for them or anyone on the team",
  "answer questions about anything in iklipse",
  "close open alerts that were dealt with",
  "pause an open alert until a time, and remind people on the team about it privately every so often until it's resolved, when an admin asks",
  "in a team group, answer only what's meant for you: a mention, a reply to you, a message starting with your name, or an answer to what you just asked them",
  "understand voice notes, and write them out or translate them; in a team group, they send one as a reply to a message of yours, or start it with your name (that works in the groups you watch, like the alerts group)",
  "chat with anyone on the team like a normal assistant (as they'd use Claude or ChatGPT), in a team group when they talk to you, or privately: write and rewrite (captions, posts, emails, replies), translate, explain, brainstorm, give an honest opinion, answer general questions, in their own language and tone, knowing who they are, what the admins taught you, and what's in iklipse",
];

export const ANSWER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team asked you something. Answer from what iklipse knows, below: people (who's who: the team, the freelancers, the partner companies), projects and deliveries, open alerts, meetings (cancelled_meetings are off), orders, who's working today, and what people said in the groups and by email (voice notes written out, files read), and what iklipse remembers about a client from their chats (remembered: what they said since is newer and wins). They're on the team, so share anything below with them, numbers and emails too. You look up the rest of iklipse only for someone whose WhatsApp number is on their member card in iklipse, and theirs isn't: when the answer isn't below, say that, in a few words; never guess or invent. Always English. Times are Cairo time. Call reply once.
${WHO_IS_WHO}
${VOICE}`;

/**
 * A question from the team (0093): what's going on and the people and projects
 * named, then the rest looked up in iklipse as the one asking (look.ts). With
 * chat (in a team group or privately), what they asked is for an assistant:
 * answered like one (chatAnswer), with the same people and projects and the
 * same lookups.
 */
async function answerQuestion(
  db: Db,
  s: Settings,
  t: Team,
  dir: Awaited<ReturnType<typeof directory>>,
  q: { by: Person | undefined; text: string; quoted: string | null; about: string[]; chat?: ChatAt },
) {
  const nameOf = namer(t, dir);
  // What they may read (look.ts): their mail and email alerts only, whoever the question is about.
  const me = q.by ? await whoAsks(db, q.by.id) : null;
  // Someone iklipse can't look things up for (a guest, who left, nobody it knows): nothing about anyone.
  if (!me) return CANT_HELP;
  const mail = me.mail;
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
    } else if (ref.startsWith("o:")) {
      // A freelancer or a partner company's person (people.ts, 0115): who, where, and what they said.
      const a = partnerPeople(await partners(db)).get(id);
      if (!a) continue;
      about.push({
        ...(a.who === "freelancer" ? { freelancer: a.name } : { partner_person: a.name }),
        whatsapp: a.phone ? `+${a.phone}` : null,
        ...(a.groups.length ? { groups: a.groups } : {}),
        said: await historyOf(db, { phone: a.phone, lid: a.lid }, 30, mail),
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

  if (q.chat) return await chatAnswer(db, s, dir, me, { ...q, chat: q.chat }, about);
  const { now, ...going } = await situation(db, t, dir, mail);
  const known = JSON.stringify({
    now,
    asked_by: q.by?.name ?? "someone on the team",
    question: q.text,
    ...(q.quoted ? { replying_to: q.quoted } : {}),
    about,
    // "Can you post in other groups?": what the bot does, so it isn't guessed.
    you_can: YOU_CAN,
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

// -------------------------------------------------------------- a chat --

/** Where a chat is had (takeOrder), who's asking, and what was said just before: earlier in a group, the chat privately. */
export interface ChatAt {
  where: "team" | "private";
  /** Their name, also when iklipse doesn't know them (someone in a team group). */
  name: string;
  talk: string[];
}

/** The answer's own room: a translation or an explanation privately can run long (the words keep a group's short). */
const CHAT_TOKENS = 4000;

const CHAT_HEAD = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team ("asked_by": who they are, and whether they're an admin) wants you as their assistant, the way they'd use Claude: to write or rewrite something (a caption, a post, an email, a reply, a script, a brief), translate, explain, sum up, brainstorm, give an honest opinion, answer a general question, or just talk. Do it for real, with your own knowledge and judgement, as well as Claude would: never say it isn't your job or that you can't switch into it, never send them elsewhere, and when it's a little unclear, make a good first try rather than ask.
"request" is their message. "replying_to" is the message they replied to: "this" is usually it (a photo comes as "[photo: what it shows]", a voice note written out, a document with what it says). "conversation" is what they and you said just before, oldest first: "shorter", "another one" or "in Arabic" is about your last answer there. You know the team, our freelancers and partners ("who_is_who"), what the admins taught you, and what you can do ("you_can"). "about" is what iklipse knows about the people and projects it names.

Write in the language and the way they wrote: Egyptian Arabic in Arabic letters, Franco-Arabic in Franco, English in English, mixed when they mix, in their tone (casual, joking, formal). When they ask for another language (a caption in English, a translation), what you write for them is in that language. What they asked for comes first and whole (the caption, the list, the translation), ready to copy, with at most a line around it. "where" says where you are. In a group, keep it short: a few lines, a list of at most 5 short items unless they ask for more, never an essay. Privately, as long as it needs and no longer. WhatsApp shows *bold* with one star on each side and _italic_: never # headings, tables or double stars.
Never invent anything about iklipse, its people, clients or work: what isn't below or in what you looked up, you don't know (say so in a few words when it matters, or leave a [placeholder] in a draft). They're on the team: anything in iklipse is theirs to use.`;

const CHAT_LOOK = `When something in iklipse would make it better (a client's project, what Acme asked for, a brief, a delivery, what was said in a group), look it up with find, or search what people said (by meaning, in any language), then write. Most requests need no lookup: then answer at once.

${TABLE_GUIDE}`;

const CHAT_VOICE = `The length rule below is for your own words around it: what they asked for is as long as it needs to be, within the limits above.
${VOICE}`;

/** The words for a chat (no lookups: someone iklipse doesn't look things up for), and with find and search (look.ts). */
export const CHAT_SYSTEM = `${CHAT_HEAD}\n${WHO_IS_WHO}\n${CHAT_VOICE}`;
export const CHAT_LOOK_SYSTEM = `${CHAT_HEAD}\n\n${CHAT_LOOK}\n\n${WHO_IS_WHO}\n${CHAT_VOICE}`;

const CHAT_TOOL: ClaudeTool = {
  name: "reply",
  description: "Your answer, to send them. Call it once, at the end.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "Your answer: in their language and tone, or in the language they asked for." } },
    required: ["text"],
  },
};

/** Markdown WhatsApp doesn't show, the way it does: **bold** and # headings as *bold*; and no dashes. */
export const forWhatsApp = (t: string) =>
  t
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\s*[—–]\s*/g, ", ")
    .trim();

/**
 * Someone on the team chatting with the bot like a normal assistant (chat, in a
 * team group or privately): Claude answers for real, in their language and
 * tone, knowing who they are, the team (who_is_who) and what the admins taught
 * it (kit.ts adds that to every call), with what was said just before. It looks
 * things up in iklipse when that helps, as the one asking may read (look.ts);
 * someone iklipse doesn't look things up for is answered without.
 */
async function chatAnswer(
  db: Db,
  s: Settings,
  dir: Awaited<ReturnType<typeof directory>>,
  me: Me | null,
  q: { by: Person | undefined; text: string; quoted: string | null; chat: ChatAt },
  about: Record<string, unknown>[],
) {
  const known = JSON.stringify({
    now: nowText(),
    where: q.chat.where === "team" ? "a team group" : "privately",
    asked_by: { name: q.by?.name ?? q.chat.name, ...(q.by ? { admin: q.by.admin } : {}) },
    request: q.text,
    ...(q.quoted ? { replying_to: q.quoted } : {}),
    ...(q.chat.talk.length ? { conversation: q.chat.talk } : {}),
    ...(about.length ? { about } : {}),
    you_can: YOU_CAN,
    who_is_who: await whoIsWho(db),
  });
  if (me) {
    const names = new Map([...dir.team.entries()].map(([id, a]) => [id, a.name]));
    const found = await lookUp(db, s, me, known, names, { system: CHAT_LOOK_SYSTEM, reply: CHAT_TOOL, job: "look.chat", maxTokens: CHAT_TOKENS }).catch((e) => {
      console.error("chat", (e as Error).message);
      return null;
    });
    if (found) return forWhatsApp(found);
  }
  const r = (await claude(s, { name: "orders.chat", role: "main" }, CHAT_SYSTEM, known, CHAT_TOOL, CHAT_TOKENS).catch((e) => {
    console.error("chat", (e as Error).message);
    return null;
  })) as { text?: string } | null;
  return forWhatsApp(str(r?.text)) || "I couldn't answer that just now. Ask me again in a minute?";
}

/** A time in Cairo ("Thu 23 Oct, 14:00"), or null. */
const stamp = (x: string | null | undefined) => (x ? cairoStamp.format(new Date(x)) : null);
/** Now, for Claude: "Sat 24 Oct, 14:00 Cairo time (2026-10-24T14:00+03:00)". */
export const nowText = () => `${cairoStamp.format(new Date())} Cairo time (${new Date(Date.now() + Number(cairoOffset().slice(0, 3)) * 60 * MIN).toISOString().slice(0, 16)}${cairoOffset()})`;
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
      now: nowText(),
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
      // The team as it is now (who left only counted), the freelancers and the partners (people.ts, 0115).
      who_is_who: await whoIsWho(db),
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

export const REPLY_SYSTEM = `The iklipse bot (a creative and marketing agency's assistant on WhatsApp) wrote to someone privately because the team asked it to: to do something (tell), or to answer a question (ask). You get what it asked them (open orders), the last messages, and their new message. They write in English, Arabic, Egyptian Arabic or Franco-Arabic. Decide through the outcome tool:
- done: it's done ("done", "sent", "خلصت", "بعته", "تم").
- answer: an ask, answered ("Tuesday at 3 works", "الفيديو لسه هيخلص بكرة").
- blocked: they can't, or something is in the way ("I don't have the files", "مش هقدر", "مستني العميل").
- later: they will, not yet ("ok", "on it", "حاضر", "بعد الغدا").
- question: they ask something back about it that the team has to answer ("which files?", "أبعتها لمين؟").
- other: not about it.
Always answer by calling the outcome tool, once.
${VOICE}`;

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
export async function followOrder(db: Db, s: Settings, send: Send, x: Order, o: { id: string; chatId: string; text: string; by?: Person }, order?: (text: string) => Promise<void>) {
  if (!(await firstTime(db, `follow:${o.id}`))) return;
  // Only the team carries an order on (by: who replied, index.ts): anyone else's reply is read as theirs to the bot (takeOrder: cantHelp).
  if (!onTheTeam(o.by)) return order ? await order(o.text) : undefined;
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
