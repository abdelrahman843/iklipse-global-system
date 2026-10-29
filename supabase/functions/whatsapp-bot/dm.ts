// Private chats with the bot (0087, 0095). Every message is kept. When answering
// is on (Alerts > Settings), a chat that went quiet is read by Claude, and the
// bot talks with them itself, like a person on the team: it answers from what
// iklipse knows about them (their projects, their meetings as they are now,
// what they said in the groups and by email), books a call at a free time they
// ask for or sends the free times and the link (book.ts), and says by itself it
// only helps with work when it's off topic. It comes back to the team (the
// person by WhatsApp, or the team group) only when it's stuck: it can't answer
// from what it knows, can't do what they ask, or it's risky (money, prices,
// contracts, a complaint, a date to promise). Then it tells them it'll check,
// and asks the team. The team's answer is sent (an OK for the bot's own reply,
// or what to tell them, in English), carried out when it's an order ("book it",
// "send him the link"), or dropped. The reply never shares anything that isn't
// theirs. The team's own private messages aren't answered here (orders.ts).
// Always English.

import { backoff, cairoStamp, claude, iso, MIN, stillQueued, str, tally, type ClaudeTool, type Db, type Settings, type Team } from "./kit.ts";
import { askPlaces, firstTime, phoneKey, type Send } from "./people.ts";
import { historyOf } from "./history.ts";
import { meetingsOf, type Attendee } from "./meetings.ts";
import { clientMeeting } from "./book.ts";
import { clockIn, saveZone, validZone, zoneOf } from "./zones.ts";
import { VOICE } from "./voice.ts";
import { guardIssues, keepBlock, otherClients, reasonsText, type Allowed } from "./guard.ts";
import { memoryFor, memoryOf } from "./memory.ts";
import { agentForClients, lookIntoIt } from "./stuck.ts";

/** A chat is read once it's been quiet reply_quiet_sec, or reply_max_sec after its first unread message (0098). */
export const quietMs = (s: Settings) => (s.reply_quiet_sec ?? 60) * 1000;
const maxWaitMs = (s: Settings) => (s.reply_max_sec ?? 300) * 1000;
/** A chat being read is left to that run this long (then it's free again, in case the run died). */
const CLAIM_MS = 3 * 60_000;
/** What Claude reads of a chat. */
const LAST_MESSAGES = 30;
/** "I only help with work" at most this often. */
const SORRY_EVERY_MS = 12 * 60 * MIN;
/** A question nobody answered is dropped after this long. */
const DRAFT_TTL_MS = 24 * 60 * MIN;
const SORRY = "That one's not really my area. Anything on your work with us I can help with?";
export const HOLD = "Checking on that. I'll get back to you.";
/** Outside working hours, at most once in this long. */
export const AWAY_EVERY_MS = 12 * 60 * MIN;
export const AWAY = "Got your message! We're off right now, I'll get back to you as soon as we're in.";

/** A private message, kept; new ones from outside the team wait to be read. */
export async function keepDm(
  db: Db,
  m: { id: string; chatId: string; phone: string | null; name: string | null; fromBot: boolean; text: string; quotedId: string | null; sentAt: string; read: boolean },
) {
  const { data: chat } = await db.from("wa_dm_chat").select("chat_id, pending_since").eq("chat_id", m.chatId).maybeSingle();
  if (!chat) {
    await db.from("wa_dm_chat").insert({ chat_id: m.chatId, phone: m.phone, name: m.fromBot ? null : m.name });
  }
  const { data: kept } = await db
    .from("wa_dm")
    .upsert(
      { id: m.id, chat_id: m.chatId, from_bot: m.fromBot, sender_name: m.fromBot ? null : m.name, text: m.text.slice(0, 4000), quoted_id: m.quotedId, sent_at: m.sentAt },
      { onConflict: "id", ignoreDuplicates: true },
    )
    .select("id");
  if (!kept?.length) return;
  await db
    .from("wa_dm_chat")
    .update({
      last_message_at: m.sentAt,
      ...(m.phone ? { phone: m.phone } : {}),
      ...(!m.fromBot && m.name ? { name: m.name } : {}),
      ...(m.read && !chat?.pending_since ? { pending_since: iso() } : {}),
    })
    .eq("chat_id", m.chatId);
}

// ------------------------------------------------------------ reading --

const READ_TOOL: ClaudeTool = {
  name: "decide",
  description: "What the bot does about this private chat.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["none", "off_topic", "reply", "meeting", "ask_team"] },
      text: {
        type: "string",
        description: "reply: the message to send them. ask_team: a short line to them now, while you check (\"Checking on that. I'll get back to you.\"), in their tone. Else empty.",
      },
      date: { type: "string", description: "meeting: the day they want, YYYY-MM-DD, when the chat gives one. Else empty." },
      time: { type: "string", description: "meeting: the time they want, HH:MM 24-hour, in their own time, when the chat gives one. Else empty." },
      timezone: {
        type: "string",
        description: "The IANA time zone they're in (\"Asia/Dubai\", \"Europe/London\", \"America/New_York\"), whenever the chat says where they are or what time it is for them (a city, a country, \"I'm in Toronto\", \"it's 9am here\"), with any action. Else empty.",
      },
      question: { type: "string", description: "ask_team: what you need from the team, short, in English (\"He asks where his project stands; I don't see one for him in iklipse. What should I tell him?\")." },
      draft: { type: "string", description: "ask_team: the reply you'd send if the team OKs it, when you have one (a risky one). Else empty." },
    },
    required: ["action"],
  },
};

export const READ_SYSTEM = `You are iklipse on WhatsApp (iklipse is a creative and marketing agency): a sharp, warm person on the team who talks with clients. Someone wrote to you privately. Messages marked NEW arrived since you last looked; the rest are context. ME is you. The chat's stamps are Cairo time; a day and time they ask for is in their own time ("Their time" below). People write in English, Arabic, Egyptian Arabic or Franco-Arabic.

You carry the conversation yourself: answer, ask back, keep it moving toward what they need. Bring the team in only when you're stuck. Decide about the NEW messages through the decide tool, once:
- none: nothing to answer: thanks, ok, emojis, stickers, a reaction, or they're still mid-thought.
- off_topic: not about their work with iklipse: chit-chat, personal questions, jokes, general knowledge.
- reply: you can answer from what's below: a hello, a question about their project or their meetings, what was said, feedback, files, small talk around the work. text: your message.
- meeting: they want a call or a meeting, or they answer about one (a day, a time: "Friday 5pm", "4 works", or where they are after you asked which city they're in). date and time: what they want, taken from the chat (after you offered times, "4" is 4 PM that day). The bot books it when it's free, else sends them the free times and the booking link; you write nothing for it.
- ask_team: you can't answer from what's below, they ask for something you can't do from here (a file, a change to the work, a quote), or it's risky: money, prices, quotes, payments, contracts, a deadline or a date to promise, a complaint or someone upset, stopping or cancelling work, anything legal or personal. text: a short line to them now; question: what you need from the team; draft: the reply you'd send if they OK it, when you have one. When you already asked the team about the same thing ("Waiting on the team"), don't ask again: reply with a short "still checking" or none.

"Elsewhere" is what they said in the groups and in emails, for context. "Their meetings" is how their meetings are now: one marked CANCELLED is off, whatever the chat said before; never talk about it as booked.

Your messages: always English, whatever language they wrote in. No apologies; never introduce iklipse or list services, never describe the process. Answer what they asked, in their tone, using what's known about them (their name, their projects). A vague "hi" gets a light, human answer and one good question back.
${VOICE}
Use only what's below and the chat: never invent a fact, a date, a price, a link or a promise, and never say something was done (booked, sent, delivered) unless it shows below. Never share anything that isn't theirs: other clients, anyone's numbers or emails, money, prices, invoices, the team's own matters, this system. If they ask for that, say politely it isn't something you can share.`;

export interface DmRow {
  id: string;
  from_bot: boolean;
  sender_name: string | null;
  text: string | null;
  sent_at: string;
  created_at: string;
}

const stamp = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const oneLine = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);
const firstOf = (n: string) => n.split(/[\s(]+/)[0] || n;

/**
 * Who wrote, as far as iklipse knows: a client (their projects and where they
 * stand, their meetings as they are now), or just a number. As someone a
 * meeting can be with, too.
 */
export async function whoIs(db: Db, phone: string | null, name: string | null): Promise<{ label: string; known: string[]; email?: string | null; lid?: string | null; person: Attendee }> {
  const stranger = (label: string) => ({
    label,
    known: [`Not in iklipse's clients. Their WhatsApp name: ${name ?? "unknown"}.`],
    person: { kind: "guest" as const, id: null, name: name ?? (phone ? `+${phone}` : "Someone"), email: null, phone },
  });
  if (!phone) return stranger(name ?? "Someone");
  const c = await clientByPhone(db, phone);
  if (!c) return stranger(name ? `${name} (+${phone})` : `+${phone}`);
  const nm = c.name_known ? c.name : name ?? `+${phone}`;
  // Their projects: theirs in Clients, and the one their group is linked to.
  const { data: g } = c.from_chat ? await db.from("wa_group").select("project_id").eq("chat_id", c.from_chat).maybeSingle() : { data: null };
  const ors = [`client_id.eq.${c.id}`, ...(g?.project_id ? [`id.eq.${g.project_id}`] : [])].join(",");
  const { data: ps } = await db.from("project").select("id, title, status, delivered_at").or(ors).order("created_at", { ascending: false }).limit(8);
  const { data: ds } = ps?.length
    ? await db.from("project_delivery").select("project_id, title, done_at").in("project_id", ps.map((p) => p.id)).order("due_at").limit(40)
    : { data: [] };
  const projects = (ps ?? []).map((p) => {
    const mine = (ds ?? []).filter((d) => d.project_id === p.id);
    const status = p.status === "on_hold" ? "on hold" : p.status === "delivered" ? `delivered${p.delivered_at ? ` ${stamp.format(new Date(p.delivered_at))}` : ""}` : p.status;
    return `- ${p.title}: ${status}${mine.length ? `; deliveries: ${mine.map((d) => `${d.title} (${d.done_at ? "done" : "not done yet"})`).join(", ")}` : ""}`;
  });
  const [meetings, notes] = await Promise.all([meetingsOf(db, { kind: "client", id: c.id, email: c.email }), memoryOf(db, c.id)]);
  // What iklipse remembers from their chats (memory.ts): all of it, it's their own chat.
  const remembered = memoryFor(notes, true);
  return {
    email: c.email,
    lid: c.wa_lid,
    label: `${nm}${c.company ? ` (${c.company})` : ""}`,
    known: [
      `A client of iklipse: ${nm}${c.company ? ` from ${c.company}` : ""}.`,
      projects.length ? `Their projects:\n${projects.join("\n")}` : "No project of theirs in iklipse.",
      `Their meetings: ${meetings.length ? `\n${meetings.map((m) => `- ${m}`).join("\n")}` : "none coming up."}`,
      ...(remembered ? [`What you remember about them from their chats (the chat below is newer, it wins):\n${remembered}`] : []),
    ],
    person: { kind: "client", id: c.id, name: nm, email: c.email, phone, zone: c.timezone },
  };
}

const CLIENT_COLS = "id, name, company, name_known, phone, email, wa_lid, from_chat, timezone";
type ClientRow = { id: string; name: string; company: string | null; name_known: boolean; phone: string | null; email: string | null; wa_lid: string | null; from_chat: string | null; timezone: string | null };

/**
 * The client with this WhatsApp number: found by its number as WhatsApp
 * writes it (client.phone_key, 0109, indexed). Before 0109 runs, by reading
 * every client, as before.
 */
export async function clientByPhone(db: Db, phone: string): Promise<ClientRow | null> {
  const r = await db.from("client").select(CLIENT_COLS).eq("phone_key", phone).limit(1);
  if (!r.error) return ((r.data ?? []) as ClientRow[])[0] ?? null;
  const { data: cs } = await db.from("client").select(CLIENT_COLS).not("phone", "is", null);
  return ((cs ?? []) as ClientRow[]).find((x) => phoneKey(x.phone) === phone) ?? null;
}

/**
 * Private chats that went quiet: read, and answered (by the bot itself, or
 * after asking the team when it's stuck). Outside working hours (away): they're
 * told the team will get back to them, and the messages stay unread until work
 * starts. only: just that chat (read right after its wait, 0098). Each chat is
 * claimed first, so the minute's run and a chat read right away never both answer.
 */
/** A client's new messages for the brain (index.ts, phase 3): true when it has them (it answers them itself). */
export type ClientBrain = (o: { chatId: string; phone: string | null; name: string | null; lastId: string; text: string }) => Promise<boolean>;

export async function readDms(db: Db, s: Settings, t: Team, send: Send, deadline: number, away = false, only?: string, brain?: ClientBrain) {
  // The brain answers clients whether answering is on or not (it's on for them by its phase).
  if (!s.dm_enabled && !brain) return 0;
  const places = await askPlaces(db, s);
  if (!places.length && !brain) return 0;
  let q = db
    .from("wa_dm_chat")
    .select("chat_id, phone, name, pending_since, last_message_at, analyzed_at, sorry_at, away_at, claimed_at")
    .not("pending_since", "is", null);
  if (only) q = q.eq("chat_id", only);
  const { data: chats } = await q.order("pending_since").limit(30);
  let read = 0;
  for (const c of chats ?? []) {
    if (Date.now() > deadline || read >= 5) break;
    const quiet = !c.last_message_at || Date.now() - Date.parse(c.last_message_at) >= quietMs(s);
    const long = Date.now() - Date.parse(c.pending_since) >= maxWaitMs(s);
    if (!quiet && !long) continue;
    // Away, and nothing new since they were told: it waits for work.
    if (away && c.away_at && c.last_message_at && Date.parse(c.away_at) >= Date.parse(c.last_message_at)) continue;
    const free = iso(Date.now() - CLAIM_MS);
    const { data: mine } = await db
      .from("wa_dm_chat")
      .update({ claimed_at: iso() })
      .eq("chat_id", c.chat_id)
      .or(`claimed_at.is.null,claimed_at.lt."${free}"`)
      .select("chat_id");
    if (!mine?.length) continue;
    try {
      await readDm(db, s, t, send, places, c, away, brain);
      read++;
    } catch (e) {
      await db.from("wa_dm_chat").update({ last_error: (e as Error).message.slice(0, 300) }).eq("chat_id", c.chat_id);
    } finally {
      await db.from("wa_dm_chat").update({ claimed_at: null }).eq("chat_id", c.chat_id);
    }
  }
  return read;
}

/** How long after the team wrote to a client through the bot it carries the chat on with them, at any hour. */
export const TALK_FOR_MS = 3 * 24 * 60 * MIN;
/** A chat quiet this long since the client last wrote is over: whoever had the bot write gets its summary. */
export const TALK_DONE_MS = 2 * 60 * MIN;

interface Talk {
  id: string;
  chat_id: string;
  to_chat: string;
  to_name: string;
  order_text: string;
  created_at: string;
}

const TALK_COLS = "id, chat_id, to_chat, to_name, order_text, created_at";

/** The latest order to this client from the team, lately: the bot talks with them for it, even outside working hours. */
export async function talkFor(db: Db, chatId: string): Promise<Talk | null> {
  const { data } = await db
    .from("bot_order")
    .select(TALK_COLS)
    .eq("to_chat", chatId)
    .eq("to_kind", "client")
    .gt("created_at", iso(Date.now() - TALK_FOR_MS))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Talk | null) ?? null;
}

const SUM_SYSTEM = `You sum up, for someone on the team of iklipse (a creative and marketing agency), a WhatsApp chat the bot had with a client they had it write to. English, a few short lines: what the client said and wants, what the bot told them, what's left open for the team. Every fact kept (names, dates, times with the zone). Nothing made up. No greeting.`;

/**
 * Chats the bot carried on for the team (an order to a client, lately) that are
 * over (quiet TALK_DONE_MS since the client last wrote): one summary to the chat
 * the order was given in, never each message. Again if they write after it.
 */
export async function sumUpTalks(db: Db, s: Settings, send: Send, deadline: number) {
  const { data: orders } = await db
    .from("bot_order")
    .select(TALK_COLS)
    .eq("to_kind", "client")
    .gt("created_at", iso(Date.now() - TALK_FOR_MS))
    .order("created_at", { ascending: false })
    .limit(40);
  const latest = new Map<string, Talk>();
  for (const o of (orders ?? []) as Talk[]) if (o.chat_id && o.to_chat && !latest.has(o.to_chat)) latest.set(o.to_chat, o);
  let told = 0;
  for (const o of latest.values()) {
    if (Date.now() > deadline) break;
    const { data: rows } = await db
      .from("wa_dm")
      .select("id, from_bot, sender_name, text, sent_at, created_at")
      .eq("chat_id", o.to_chat)
      .gte("sent_at", o.created_at)
      .order("sent_at")
      .limit(80);
    const msgs = (rows ?? []) as DmRow[];
    const theirs = msgs.filter((m) => !m.from_bot);
    if (!theirs.length || Date.now() - Date.parse(theirs.at(-1)!.sent_at) < TALK_DONE_MS) continue;
    if (!(await firstTime(db, `dm-talk:${o.id}:${msgs.at(-1)!.id}`))) continue;
    const chat = msgs.map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m.from_bot ? "BOT" : o.to_name}: ${m.text ?? ""}`).join("\n");
    const sum = str(await claude(s, { name: "dm.talk", role: "fast" }, SUM_SYSTEM, `What the team asked: ${o.order_text}\n\nThe chat with ${o.to_name} (Cairo time):\n${chat}`, undefined, 600));
    if (!sum) continue;
    await send(o.chat_id, `Your chat with ${o.to_name}, summed up:\n${sum}`);
    told++;
  }
  return told;
}

async function readDm(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  places: string[],
  c: { chat_id: string; phone: string | null; name: string | null; analyzed_at: string | null; sorry_at: string | null; away_at: string | null },
  away = false,
  brain?: ClientBrain,
) {
  const started = iso();
  const done = async (patch: Record<string, unknown> = {}) => {
    const { count } = await db.from("wa_dm").select("id", { count: "exact", head: true }).eq("chat_id", c.chat_id).eq("from_bot", false).gt("created_at", started);
    await db
      .from("wa_dm_chat")
      .update({ analyzed_at: started, last_error: null, ...(count ? {} : { pending_since: null }), ...patch })
      .eq("chat_id", c.chat_id);
  };
  // The team's own messages aren't answered (nor the person who answers the bot's questions); a guest is, by the brain.
  const member = (c.phone ? t.byPhone.get(c.phone) : undefined) ?? t.byLid.get(c.chat_id);
  if ((member && !(brain && member.guest)) || (c.phone && (s.ask_phones ?? []).includes(c.phone))) return done();
  // Nor people who aren't clients (freelancers, partners, 0101): the team talks to them; the brain answers them too.
  if (!brain && ((c.phone && t.others.has(c.phone)) || t.others.has(c.chat_id))) return done();

  const { data: rows } = await db
    .from("wa_dm")
    .select("id, from_bot, sender_name, text, sent_at, created_at")
    .eq("chat_id", c.chat_id)
    .order("sent_at", { ascending: false })
    .limit(LAST_MESSAGES);
  const msgs = ((rows ?? []) as DmRow[]).reverse();
  const isNew = (m: DmRow) => !m.from_bot && (!c.analyzed_at || Date.parse(m.created_at) > Date.parse(c.analyzed_at));
  const fresh = msgs.filter(isNew);
  if (!fresh.length) return done();
  const last = fresh.at(-1)!.id;
  // The team had the bot write to them lately: it talks with them at any hour (the summary goes back, sumUpTalks).
  const talking = !!(await talkFor(db, c.chat_id));
  if (talking) away = false;
  // Outside working hours: "we'll get back to you" (once in a while), and the messages wait for work.
  const awayNow = async () => {
    const told = c.away_at && Date.now() - Date.parse(c.away_at) < AWAY_EVERY_MS;
    if (!told) await send(c.chat_id, AWAY, last);
    await db.from("wa_dm_chat").update({ away_at: iso(), last_error: null }).eq("chat_id", c.chat_id);
  };
  // The brain answers clients (phase 3): it has the new messages, and the chat is read.
  if (brain) {
    if (away) return await awayNow();
    if (await brain({ chatId: c.chat_id, phone: c.phone, name: c.name, lastId: last, text: fresh.map((m) => m.text ?? "").filter(Boolean).join("\n") })) return done();
    // Not taken: the old reply, which needs somewhere to ask the team, and answering on.
    if (!places.length || !s.dm_enabled) return done();
  }

  const who = await whoIs(db, c.phone, c.name);
  const zone = zoneOf(who.person);
  const [elsewhere, { data: waiting }] = await Promise.all([
    historyOf(db, { phone: c.phone, lid: who.lid, email: who.email }, 25),
    db.from("bot_draft").select("id, question, asked, created_at").eq("chat_id", c.chat_id).eq("status", "waiting").order("created_at", { ascending: false }),
  ]);
  const user = [
    `Who wrote: ${who.known.join("\n")}`,
    `Now: ${stamp.format(new Date())} (Cairo)`,
    zone
      ? `Their time: ${clockIn(zone).label} (${clockIn(zone).weekday(Date.now())} ${clockIn(zone).dayOf(Date.now())}, ${clockIn(zone).time12(Date.now())} there now)`
      : "Their time: not known (their number doesn't say where they are)",
    ...(waiting?.length ? [`Waiting on the team (asked ${stamp.format(new Date(waiting[0].created_at))}): ${waiting[0].question || waiting[0].asked}`] : []),
    "",
    ...(elsewhere.length ? ["Elsewhere:", ...elsewhere, ""] : []),
    "The chat:",
    ...msgs.map((m) => `${isNew(m) ? "NEW " : ""}[${stamp.format(new Date(m.sent_at))}] ${m.from_bot ? "ME" : "THEM"}: ${oneLine(m.text ?? "", 1200)}`),
  ].join("\n");
  const r = (await claude(s, { name: "dm.reply", role: "main" }, READ_SYSTEM, user, READ_TOOL, 1000)) as { action?: string; text?: string; date?: string; time?: string; timezone?: string; question?: string; draft?: string } | null;
  if (!r?.action) throw new Error("Claude gave no answer");
  // Where they said they are: kept on their Clients row (0101).
  const said = validZone(r.timezone);
  if (said && said !== who.person.zone) {
    who.person.zone = said;
    await saveZone(db, who.person, said);
  }

  if (r.action === "off_topic") {
    // In a chat the team had the bot start, they're never left unanswered.
    if (!talking && c.sorry_at && Date.now() - Date.parse(c.sorry_at) < SORRY_EVERY_MS) return done();
    await send(c.chat_id, SORRY, last);
    return done({ sorry_at: iso() });
  }
  if (!["reply", "meeting", "ask_team"].includes(r.action)) return done();

  // Outside working hours: "we'll get back to you" (once in a while), and the messages wait for work.
  if (away) return await awayNow();

  const asked = fresh.map((m) => oneLine(m.text ?? "", 300)).join("\n");
  const clean = (x: unknown) => str(x).replace(/[—–]/g, ", ");
  // What Claude wrote is checked before it goes to them (guard.ts).
  const allowed = await allowedFor(db, who, c.phone, msgs.map((m) => m.text ?? ""));
  const caught = async (text: string, where: string) => {
    const reasons = guardIssues(text, allowed);
    if (reasons.length) await keepBlock(db, { where, chat_id: c.chat_id, to_name: who.label, text, reasons });
    return reasons;
  };

  if (r.action === "reply") {
    const text = clean(r.text);
    if (!text) return done();
    const reasons = await caught(text, "dm.reply");
    if (!reasons.length) {
      await send(c.chat_id, text, last);
      await tally(db, "reply_alone");
      return done();
    }
    // Caught: it doesn't go. They hear we're on it; the team gets the reply to OK or change.
    await send(c.chat_id, HOLD, last);
    await askTeam(db, s, send, places, {
      chatId: c.chat_id,
      label: who.label,
      asked,
      fresh: fresh.map((m) => m.text ?? ""),
      question: `I didn't send my reply: it has ${reasonsText(reasons)}, which isn't theirs or in their chat.`,
      draft: text,
      hold: HOLD,
      risky: true,
    });
    return done();
  }

  let hold = clean(r.text) || HOLD;
  if (hold !== HOLD && (await caught(hold, "dm.hold")).length) hold = HOLD;
  let question = clean(r.question);
  let draft = clean(r.draft);
  if (r.action === "meeting") {
    const m = await clientMeeting(db, s, send, who.person, { date: str(r.date), time: str(r.time) });
    if (m.text) await send(c.chat_id, m.text, last);
    if (!m.stuck) {
      await tally(db, "reply_alone");
      return done();
    }
    // What the team has to sort out first: they hear it, and the client hears we're on it.
    const when = str(r.date) ? ` on ${str(r.date)}${str(r.time) ? ` at ${str(r.time)}` : ""}` : "";
    question = `${firstOf(who.label)} wants a call${when}, but: ${m.stuck} What should I do?`;
    hold = m.text ? "" : HOLD;
    draft = "";
  }

  // Stuck: they hear we're on it, and the team is asked.
  if (hold) await send(c.chat_id, hold, last);
  // With the agent on for everyone (stuck.ts): it looks into it first; the reply it'd send goes to the team as the draft to OK.
  if (r.action === "ask_team" && agentForClients()) {
    const looked = await lookIntoIt(db, s, {
      runKey: last,
      chatId: c.chat_id,
      client: who.person,
      label: who.label,
      known: who.known,
      chat: msgs.map((m) => `${m.from_bot ? "ME" : "THEM"}: ${oneLine(m.text ?? "", 500)}`),
      stuck: question || "What should I tell them?",
    }).catch((e) => {
      console.error("agent client", (e as Error).message);
      return null;
    });
    if (looked?.draft) draft = clean(looked.draft);
    if (looked?.found) question = `${question || "What should I tell them?"}\nWhat I found: ${oneLine(looked.found, 600)}`;
  }
  // The reply it'd send is checked too (guard.ts): caught, the team sees why, and a plain OK doesn't send it.
  const warn = draft ? await caught(draft, "dm.draft") : [];
  if (warn.length) question = `${question || "What should I tell them?"}\nMy reply has ${reasonsText(warn)}, which isn't theirs or in their chat.`;
  await askTeam(db, s, send, places, { chatId: c.chat_id, label: who.label, asked, fresh: fresh.map((m) => m.text ?? ""), question: question || "What should I tell them?", draft, hold, risky: warn.length > 0 });
  return done();
}

/** What a reply to them may repeat (guard.ts): what iklipse knows about them, and their chat. */
export async function allowedFor(db: Db, who: Awaited<ReturnType<typeof whoIs>>, phone: string | null, chat: string[]): Promise<Allowed> {
  return {
    said: [...who.known, ...chat],
    phone,
    email: who.email,
    own: [who.person.name, who.label],
    others: await otherClients(db, who.person.kind === "client" ? who.person.id : null),
  };
}

/** What the guard (guard.ts) finds now in a reply to this private chat; kept when it finds something (keep). */
export async function draftIssues(db: Db, chatId: string, text: string, keep = true, said: string[] = []) {
  const [{ data: c }, { data: rows }] = await Promise.all([
    db.from("wa_dm_chat").select("phone, name").eq("chat_id", chatId).maybeSingle(),
    db.from("wa_dm").select("text").eq("chat_id", chatId).order("sent_at", { ascending: false }).limit(LAST_MESSAGES),
  ]);
  const phone = (c?.phone as string | null | undefined) ?? null;
  const who = await whoIs(db, phone, (c?.name as string | null | undefined) ?? null);
  // said: what the team said it may tell them (their words to it), allowed too.
  const reasons = guardIssues(text, await allowedFor(db, who, phone, [...said, ...((rows ?? []) as { text: string | null }[]).map((m) => m.text ?? "")]));
  if (keep && reasons.length) await keepBlock(db, { where: "dm.ok", chat_id: chatId, to_name: who.label, text, reasons });
  return reasons;
}

/** The team is asked about someone's private chat: a newer question takes the place of one still waiting. */
export async function askTeam(
  db: Db,
  s: Settings,
  send: Send,
  places: string[],
  o: { chatId: string; label: string; asked: string; fresh: string[]; question: string; draft: string; hold: string; risky?: boolean },
) {
  const { data: waiting } = await db.from("bot_draft").select("id").eq("chat_id", o.chatId).eq("status", "waiting");
  if (waiting?.length) await db.from("bot_draft").update({ status: "replaced", decided_at: iso() }).in("id", waiting.map((w) => w.id));
  // Everyone it asks gets it; whoever answers first decides (decideDraft claims it once).
  const askIds: string[] = [];
  for (const place of places) {
    const how = place.endsWith("@g.us") ? "Reply to this message with" : "Reply with";
    const text = [
      `${o.label} wrote to me privately:`,
      ...o.fresh.slice(-3).map((m) => `"${oneLine(m, 300)}"`),
      "",
      ...(o.hold ? [`I told them: "${o.hold}"`] : []),
      o.question,
      ...(o.draft
        ? ["", "I'd reply:", `"${o.draft}"`, "", o.risky ? `${how} "send anyway" to send it as it is, what to tell them instead, or what to do.` : `${how} OK to send it, what to tell them instead, or what to do.`]
        : ["", `${how} what to tell them, or what to do.`]),
    ].join("\n");
    const askId = await send(place, text);
    if (askId) askIds.push(askId);
  }
  await db.from("bot_draft").insert({
    chat_id: o.chatId,
    to_name: o.label,
    asked: o.asked.slice(0, 2000),
    draft: o.draft.slice(0, 2000),
    question: o.question.slice(0, 1000),
    ask_ids: askIds,
    ask_chat: places[0] ?? null,
    ask_chats: places,
    times: 1,
    next_at: iso(Date.now() + backoff(s.ask_every_min, 0)),
  });
  await tally(db, "asked_team");
}

// ------------------------------------------------------- the team's answer --

const OK_TOOL: ClaudeTool = {
  name: "decision",
  description: "What the team said about the bot's question.",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["send", "own", "order", "drop", "unclear"] },
      text: { type: "string", description: "own: the message to send them, in English." },
      order: { type: "string", description: "order: the instruction as it stands alone, in English, naming the person and every detail the chat gives." },
    },
    required: ["decision"],
  },
};

export const OK_SYSTEM = `The iklipse bot is talking privately with someone (usually a client) and asked the team about it. You get what they wrote, the last messages with them, what the bot asked the team, maybe the reply it would send, and the team's answer. Decide through the decision tool, once:
- send: the team OKs the bot's reply as it is ("ok", "okay", "send", "send anyway", "yes", "تمام", "ابعت", "ماشي", 👍). Only when the bot has a reply.
- own: the team says what to tell them, or gives the reply ("tell her we'll deliver Sunday", "قوله المشروع هيخلص الخميس"). text: that message as it goes to them, in English (translate it if needed), keeping exactly what the team means. Never add facts the team didn't give, and never say something was done (booked, sent, fixed, delivered) unless the team says it was done.
- order: the team tells the bot to do something rather than say something: book a call or a meeting ("book it", "احجزله", "no just book it to him", "go ahead, Friday 5"), send the booking link, tell or ask someone on the team, find something out. order: the instruction as it stands alone, naming the person and every detail from the chat ("Book a call with Abbas on Friday at 5 PM", "Send Abbas the booking link").
- drop: don't reply ("no", "don't", "skip", "لا", "متردش", "سيبه").
- unclear: anything else (a question to the bot, a comment, something unrelated to this person).
${VOICE}`;

export interface Draft {
  id: string;
  chat_id: string;
  to_name: string | null;
  asked: string;
  draft: string;
  question: string | null;
  ask_ids: string[];
  ask_chat: string | null;
  /** Every chat the question went to (0132); ask_chat is the first. */
  ask_chats: string[];
  times: number;
  created_at: string;
}
export const DRAFT_COLS = "id, chat_id, to_name, asked, draft, question, ask_ids, ask_chat, ask_chats, times, created_at";
/** The team sending the bot's reply even though the guard caught something in it. */
const ANYWAY = /\banyways?\b|كده كده|كدا كدا/i;

/** The message it replies to is the bot asking the team (or reminding). */
export async function repliesToDraft(db: Db, quotedId: string | null) {
  if (!quotedId) return false;
  const { data } = await db.from("bot_draft").select("id").contains("ask_ids", [quotedId]).limit(1);
  return !!data?.length;
}

/** The question waiting for the team that this message answers: the one it replies to, else (in the private chat) the latest. */
export async function draftFor(db: Db, chatId: string, quotedId: string | null): Promise<Draft | null> {
  if (quotedId) {
    const { data } = await db.from("bot_draft").select(DRAFT_COLS).contains("ask_ids", [quotedId]).eq("status", "waiting").limit(1);
    return ((data ?? [])[0] as Draft | undefined) ?? null;
  }
  if (chatId.endsWith("@g.us")) return null;
  const { data } = await db.from("bot_draft").select(DRAFT_COLS).contains("ask_chats", [chatId]).eq("status", "waiting").order("created_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as Draft | undefined) ?? null;
}

/**
 * The team answered the bot's question about someone: a reply sent (the bot's,
 * or theirs), an order carried out (order: hands it to orders.ts), or dropped.
 * false: it wasn't an answer to it.
 */
export async function decideDraft(db: Db, s: Settings, d: Draft, o: { id: string; chatId: string; text: string; by?: string | null }, send: Send, order: (text: string) => Promise<void>) {
  const { data: lastRows } = await db.from("wa_dm").select("id, from_bot, text, sent_at").eq("chat_id", d.chat_id).order("sent_at", { ascending: false }).limit(8);
  const chat = ((lastRows ?? []) as { id: string; from_bot: boolean; text: string | null; sent_at: string }[]).reverse();
  const user = [
    `${d.to_name ?? "They"} wrote:\n${d.asked}`,
    "",
    "The last messages with them:",
    ...chat.map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m.from_bot ? "BOT" : "THEM"}: ${oneLine(m.text ?? "", 400)}`),
    "",
    ...(d.question ? [`The bot asked the team: ${d.question}`] : []),
    ...(d.draft ? [`The bot's reply:\n${d.draft}`] : ["The bot has no reply of its own."]),
    "",
    `The team answered:\n${o.text.slice(0, 2000)}`,
  ].join("\n");
  const r = (await claude(s, { name: "dm.ok", role: "fast" }, OK_SYSTEM, user, OK_TOOL, 600)) as { decision?: string; text?: string; order?: string } | null;
  return await settleDraft(db, d, { decision: str(r?.decision), text: str(r?.text), order: str(r?.order), anyway: ANYWAY.test(o.text), group: o.chatId.endsWith("@g.us"), by: { chat: o.chatId, name: o.by } }, send, (t) => send(o.chatId, t, o.id), order);
}

/**
 * What the team decided about the bot's question on someone's private chat,
 * carried out once: send (the bot's reply; "anyway" sends it even when the
 * guard catches something), own (their words), order, or drop. tell: what's
 * said back to the team (its id: a reply to it answers the question too).
 * by: who answered, and where (the others asked hear it's closed).
 * false: nothing it can do with that.
 */
export async function settleDraft(
  db: Db,
  d: Draft,
  r: { decision: string; text?: string; order?: string; anyway?: boolean; group?: boolean; by?: By },
  send: Send,
  tell: (text: string) => Promise<string | null>,
  order?: (text: string) => Promise<void>,
): Promise<boolean> {
  const { data: lastRows } = await db.from("wa_dm").select("id, from_bot").eq("chat_id", d.chat_id).order("sent_at", { ascending: false }).limit(8);
  const chat = ((lastRows ?? []) as { id: string; from_bot: boolean }[]).reverse();
  const who = d.to_name ?? "them";
  const claim = (patch: Record<string, unknown>) =>
    db.from("bot_draft").update({ decided_at: iso(), next_at: null, ...patch }).eq("id", d.id).eq("status", "waiting").select("id");

  if (r.decision === "drop") {
    const { data: mine } = await claim({ status: "dropped" });
    if (mine?.length) {
      await tell(`OK, I'll leave ${firstOf(who)}.`);
      await closedFor(d, r.by, `I'll leave ${firstOf(who)}`, send);
    }
    return true;
  }
  if (r.decision === "order" && str(r.order) && order) {
    const { data: mine } = await claim({ status: "ordered", sent_text: str(r.order).slice(0, 2000) });
    if (mine?.length) {
      await order(str(r.order));
      await closedFor(d, r.by, "I'm doing what they said", send);
    }
    return true;
  }
  // A plain OK sends the bot's reply only when the guard still finds nothing in it (guard.ts); else they say "send anyway".
  if (r.decision === "send" && d.draft && !r.anyway) {
    const reasons = await draftIssues(db, d.chat_id, d.draft);
    if (reasons.length) {
      const how = r.group ? "Reply to this message with" : "Say";
      const id = await tell(`I didn't send it: my reply has ${reasonsText(reasons)}, which isn't theirs or in their chat. ${how} "send anyway" to send it as it is, or tell me what to tell them instead.`);
      // A reply to this one answers the question too (repliesToDraft, draftFor).
      if (id) await db.from("bot_draft").update({ ask_ids: [...d.ask_ids, id] }).eq("id", d.id);
      return true;
    }
  }
  const text = r.decision === "send" && d.draft ? d.draft : r.decision === "own" ? str(r.text).replace(/[—–]/g, ", ") : "";
  if (!text) return false;
  // Once, even if two people answer at the same time.
  const { data: mine } = await claim({ status: "sent", sent_text: text.slice(0, 2000) });
  if (!mine?.length) return true;
  // As a reply to their last message.
  const theirs = chat.filter((m) => !m.from_bot).at(-1)?.id ?? null;
  await send(d.chat_id, text, theirs);
  await tell(r.decision === "send" ? `Sent to ${who}.` : `Sent to ${who}: "${text}"`);
  await closedFor(d, r.by, r.decision === "send" ? "my reply was sent" : `I sent them "${oneLine(text, 200)}"`, send);
  return true;
}

/** Who answered the bot's question, and in which chat. */
export interface By {
  chat: string;
  name?: string | null;
}

/** Everyone else it asked hears the question is closed (who answered, and what came of it), so nobody answers it twice. */
async function closedFor(d: Draft, by: By | undefined, what: string, send: Send) {
  if (!by) return;
  const chats = d.ask_chats?.length ? d.ask_chats : d.ask_chat ? [d.ask_chat] : [];
  const name = str(by.name) || "Someone on the team";
  for (const chat of chats.filter((c) => c !== by.chat)) {
    await send(chat, `${name} answered about ${d.to_name ?? "them"}: ${what}. Nothing needed from you.`);
  }
}

/** What the team hears when their reply to the bot's question wasn't clear (index.ts fromTeam). */
export async function askAgain(db: Db, d: Draft) {
  // A reply the guard catches doesn't go on a plain OK (decideDraft).
  const ok = !d.draft ? "" : (await draftIssues(db, d.chat_id, d.draft, false)).length ? `A plain OK won't send my reply: "send anyway" sends it as it is. ` : "OK sends my reply. ";
  return `What should I tell ${d.to_name ?? "them"}, or do? ${ok}"No" leaves it.`;
}

/** Questions still waiting for the team: asked again less and less often, dropped after a day. */
export async function remindDrafts(db: Db, s: Settings, send: Send) {
  const { data } = await db.from("bot_draft").select(DRAFT_COLS).eq("status", "waiting").lte("next_at", iso()).limit(10);
  let n = 0;
  for (const d of (data ?? []) as Draft[]) {
    if (Date.now() - Date.parse(d.created_at) > DRAFT_TTL_MS) {
      await db.from("bot_draft").update({ status: "expired", decided_at: iso(), next_at: null }).eq("id", d.id);
      continue;
    }
    // The last one hasn't gone out yet (the phone is offline): nothing piles up behind it.
    const chats = d.ask_chats?.length ? d.ask_chats : d.ask_chat ? [d.ask_chat] : [];
    if (await stillQueued(db, chats.at(-1) ?? null, d.ask_ids.at(-1), d.created_at)) continue;
    const ids: string[] = [];
    if (chats.length) {
      // A reply the guard catches doesn't go on a plain OK (decideDraft).
      const ok = d.draft && (await draftIssues(db, d.chat_id, d.draft, false)).length ? `"send anyway"` : "OK";
      const ask = d.draft ? `Say ${ok} to send my reply, what to tell them instead, or what to do.` : "What should I tell them, or do?";
      for (const chat of chats) {
        // As a reply to the last ask when it went to one chat only (with several, which id is whose isn't kept).
        const id = await send(chat, `${d.to_name ?? "They"} is still waiting. ${ask}`, chats.length === 1 ? (d.ask_ids.at(-1) ?? null) : null);
        if (id) ids.push(id);
      }
      n++;
    }
    await db
      .from("bot_draft")
      .update({ times: d.times + 1, next_at: iso(Date.now() + backoff(s.ask_every_min, d.times)), ...(ids.length ? { ask_ids: [...d.ask_ids, ...ids] } : {}) })
      .eq("id", d.id);
  }
  return n;
}
