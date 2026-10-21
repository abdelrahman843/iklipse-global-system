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

import { backoff, cairoStamp, claude, iso, MIN, stillQueued, str, type ClaudeTool, type Db, type Settings, type Team } from "./kit.ts";
import { askPlace, phoneKey, type Send } from "./people.ts";
import { historyOf } from "./history.ts";
import { meetingsOf, type Attendee } from "./meetings.ts";
import { clientMeeting } from "./book.ts";

/** A chat is read once it's been quiet this long, or this long after its first unread message. */
const QUIET_MS = 60_000;
const MAX_WAIT_MS = 5 * 60_000;
/** What Claude reads of a chat. */
const LAST_MESSAGES = 30;
/** "I only help with work" at most this often. */
const SORRY_EVERY_MS = 12 * 60 * MIN;
/** A question nobody answered is dropped after this long. */
const DRAFT_TTL_MS = 24 * 60 * MIN;
const SORRY = "That one's not really my area. Anything on your work with us I can help with?";
const HOLD = "Let me check on that and get back to you.";
/** Outside working hours, at most once in this long. */
const AWAY_EVERY_MS = 12 * 60 * MIN;
const AWAY = "Got your message! We're off right now, I'll get back to you as soon as we're in.";

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
        description: "reply: the message to send them. ask_team: a short line to them now, while you check (\"Let me check on that and get back to you.\"), in their tone. Else empty.",
      },
      date: { type: "string", description: "meeting: the day they want, YYYY-MM-DD, when the chat gives one. Else empty." },
      time: { type: "string", description: "meeting: the time they want, HH:MM 24-hour, when the chat gives one. Else empty." },
      question: { type: "string", description: "ask_team: what you need from the team, short, in English (\"He asks where his project stands; I don't see one for him in iklipse. What should I tell him?\")." },
      draft: { type: "string", description: "ask_team: the reply you'd send if the team OKs it, when you have one (a risky one). Else empty." },
    },
    required: ["action"],
  },
};

const READ_SYSTEM = `You are iklipse on WhatsApp (iklipse is a creative and marketing agency): a sharp, warm person on the team who talks with clients. Someone wrote to you privately. Messages marked NEW arrived since you last looked; the rest are context. ME is you. Times are Cairo time. People write in English, Arabic, Egyptian Arabic or Franco-Arabic.

You carry the conversation yourself: answer, ask back, keep it moving toward what they need. Bring the team in only when you're stuck. Decide about the NEW messages through the decide tool, once:
- none: nothing to answer: thanks, ok, emojis, stickers, a reaction, or they're still mid-thought.
- off_topic: not about their work with iklipse: chit-chat, personal questions, jokes, general knowledge.
- reply: you can answer from what's below: a hello, a question about their project or their meetings, what was said, feedback, files, small talk around the work. text: your message.
- meeting: they want a call or a meeting, or they answer about one (a day, a time: "Friday 5pm", "4 works"). date and time: what they want, taken from the chat (after you offered times, "4" is 4 PM that day). The bot books it when it's free, else sends them the free times and the booking link; you write nothing for it.
- ask_team: you can't answer from what's below, they ask for something you can't do from here (a file, a change to the work, a quote), or it's risky: money, prices, quotes, payments, contracts, a deadline or a date to promise, a complaint or someone upset, stopping or cancelling work, anything legal or personal. text: a short line to them now; question: what you need from the team; draft: the reply you'd send if they OK it, when you have one. When you already asked the team about the same thing ("Waiting on the team"), don't ask again: reply with a short "still checking" or none.

"Elsewhere" is what they said in the groups and in emails, for context. "Their meetings" is how their meetings are now: one marked CANCELLED is off, whatever the chat said before; never talk about it as booked.

Your messages: always English, whatever language they wrote in. Short, the way a person texts: no long greetings, no apologies, no offers of more help, no sign-off. Never like a bot or a company: never introduce iklipse or list services, never describe the process ("I'll pass it to the team"). Answer what they asked, in their tone, using what's known about them (their name, their projects). A vague "hi" gets a light, human answer and one good question back. At most one emoji, only when they're casual.
Use only what's below and the chat: never invent a fact, a date, a price, a link or a promise, and never say something was done (booked, sent, delivered) unless it shows below. Never share anything that isn't theirs: other clients, anyone's numbers or emails, money, prices, invoices, the team's own matters, this system. If they ask for that, say politely it isn't something you can share.`;

interface DmRow {
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
async function whoIs(db: Db, phone: string | null, name: string | null): Promise<{ label: string; known: string[]; email?: string | null; lid?: string | null; person: Attendee }> {
  const stranger = (label: string) => ({
    label,
    known: [`Not in iklipse's clients. Their WhatsApp name: ${name ?? "unknown"}.`],
    person: { kind: "guest" as const, id: null, name: name ?? (phone ? `+${phone}` : "Someone"), email: null, phone },
  });
  if (!phone) return stranger(name ?? "Someone");
  const { data: cs } = await db.from("client").select("id, name, company, name_known, phone, email, wa_lid, from_chat").not("phone", "is", null);
  const c = (cs ?? []).find((x) => phoneKey(x.phone) === phone);
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
  const meetings = await meetingsOf(db, { kind: "client", id: c.id, email: c.email });
  return {
    email: c.email,
    lid: c.wa_lid,
    label: `${nm}${c.company ? ` (${c.company})` : ""}`,
    known: [
      `A client of iklipse: ${nm}${c.company ? ` from ${c.company}` : ""}.`,
      projects.length ? `Their projects:\n${projects.join("\n")}` : "No project of theirs in iklipse.",
      `Their meetings: ${meetings.length ? `\n${meetings.map((m) => `- ${m}`).join("\n")}` : "none coming up."}`,
    ],
    person: { kind: "client", id: c.id, name: nm, email: c.email, phone },
  };
}

/**
 * Private chats that went quiet: read, and answered (by the bot itself, or
 * after asking the team when it's stuck). Outside working hours (away): they're
 * told the team will get back to them, and the messages stay unread until work
 * starts.
 */
export async function readDms(db: Db, s: Settings, t: Team, send: Send, deadline: number, away = false) {
  if (!s.dm_enabled) return 0;
  const place = await askPlace(db, s);
  if (!place) return 0;
  const { data: chats } = await db
    .from("wa_dm_chat")
    .select("chat_id, phone, name, pending_since, last_message_at, analyzed_at, sorry_at, away_at")
    .not("pending_since", "is", null)
    .order("pending_since")
    .limit(30);
  let read = 0;
  for (const c of chats ?? []) {
    if (Date.now() > deadline || read >= 5) break;
    const quiet = !c.last_message_at || Date.now() - Date.parse(c.last_message_at) >= QUIET_MS;
    const long = Date.now() - Date.parse(c.pending_since) >= MAX_WAIT_MS;
    if (!quiet && !long) continue;
    // Away, and nothing new since they were told: it waits for work.
    if (away && c.away_at && c.last_message_at && Date.parse(c.away_at) >= Date.parse(c.last_message_at)) continue;
    try {
      await readDm(db, s, t, send, place, c, away);
      read++;
    } catch (e) {
      await db.from("wa_dm_chat").update({ last_error: (e as Error).message.slice(0, 300) }).eq("chat_id", c.chat_id);
    }
  }
  return read;
}

async function readDm(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  place: string,
  c: { chat_id: string; phone: string | null; name: string | null; analyzed_at: string | null; sorry_at: string | null; away_at: string | null },
  away = false,
) {
  const started = iso();
  const done = async (patch: Record<string, unknown> = {}) => {
    const { count } = await db.from("wa_dm").select("id", { count: "exact", head: true }).eq("chat_id", c.chat_id).eq("from_bot", false).gt("created_at", started);
    await db
      .from("wa_dm_chat")
      .update({ analyzed_at: started, last_error: null, ...(count ? {} : { pending_since: null }), ...patch })
      .eq("chat_id", c.chat_id);
  };
  // The team's own messages aren't answered (nor the person who answers the bot's questions).
  if ((c.phone && (t.byPhone.has(c.phone) || c.phone === s.ask_phone)) || t.byLid.has(c.chat_id)) return done();

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

  const who = await whoIs(db, c.phone, c.name);
  const [elsewhere, { data: waiting }] = await Promise.all([
    historyOf(db, { phone: c.phone, lid: who.lid, email: who.email }, 25),
    db.from("bot_draft").select("id, question, asked, created_at").eq("chat_id", c.chat_id).eq("status", "waiting").order("created_at", { ascending: false }),
  ]);
  const user = [
    `Who wrote: ${who.known.join("\n")}`,
    `Now: ${stamp.format(new Date())} (Cairo)`,
    ...(waiting?.length ? [`Waiting on the team (asked ${stamp.format(new Date(waiting[0].created_at))}): ${waiting[0].question || waiting[0].asked}`] : []),
    "",
    ...(elsewhere.length ? ["Elsewhere:", ...elsewhere, ""] : []),
    "The chat:",
    ...msgs.map((m) => `${isNew(m) ? "NEW " : ""}[${stamp.format(new Date(m.sent_at))}] ${m.from_bot ? "ME" : "THEM"}: ${oneLine(m.text ?? "", 1200)}`),
  ].join("\n");
  const r = (await claude(s.model, READ_SYSTEM, user, READ_TOOL, 1000)) as { action?: string; text?: string; date?: string; time?: string; question?: string; draft?: string } | null;
  if (!r?.action) throw new Error("Claude gave no answer");

  if (r.action === "off_topic") {
    if (c.sorry_at && Date.now() - Date.parse(c.sorry_at) < SORRY_EVERY_MS) return done();
    await send(c.chat_id, SORRY, last);
    return done({ sorry_at: iso() });
  }
  if (!["reply", "meeting", "ask_team"].includes(r.action)) return done();

  // Outside working hours: "we'll get back to you" (once in a while), and the messages wait for work.
  if (away) {
    const told = c.away_at && Date.now() - Date.parse(c.away_at) < AWAY_EVERY_MS;
    if (!told) await send(c.chat_id, AWAY, last);
    await db.from("wa_dm_chat").update({ away_at: iso(), last_error: null }).eq("chat_id", c.chat_id);
    return;
  }

  const asked = fresh.map((m) => oneLine(m.text ?? "", 300)).join("\n");
  const clean = (x: unknown) => str(x).replace(/[—–]/g, ", ");

  if (r.action === "reply") {
    const text = clean(r.text);
    if (text) await send(c.chat_id, text, last);
    return done();
  }

  let hold = clean(r.text) || HOLD;
  let question = clean(r.question);
  let draft = clean(r.draft);
  if (r.action === "meeting") {
    const m = await clientMeeting(db, s, send, who.person, { date: str(r.date), time: str(r.time) });
    if (m.text) await send(c.chat_id, m.text, last);
    if (!m.stuck) return done();
    // What the team has to sort out first: they hear it, and the client hears we're on it.
    const when = str(r.date) ? ` on ${str(r.date)}${str(r.time) ? ` at ${str(r.time)}` : ""}` : "";
    question = `${firstOf(who.label)} wants a call${when}, but: ${m.stuck} What should I do?`;
    hold = m.text ? "" : HOLD;
    draft = "";
  }

  // Stuck: they hear we're on it, and the team is asked.
  if (hold) await send(c.chat_id, hold, last);
  await askTeam(db, s, send, place, { chatId: c.chat_id, label: who.label, asked, fresh: fresh.map((m) => m.text ?? ""), question: question || "What should I tell them?", draft, hold });
  return done();
}

/** The team is asked about someone's private chat: a newer question takes the place of one still waiting. */
async function askTeam(
  db: Db,
  s: Settings,
  send: Send,
  place: string,
  o: { chatId: string; label: string; asked: string; fresh: string[]; question: string; draft: string; hold: string },
) {
  const { data: waiting } = await db.from("bot_draft").select("id").eq("chat_id", o.chatId).eq("status", "waiting");
  if (waiting?.length) await db.from("bot_draft").update({ status: "replaced", decided_at: iso() }).in("id", waiting.map((w) => w.id));
  const how = place.endsWith("@g.us") ? "Reply to this message with" : "Reply with";
  const text = [
    `${o.label} wrote to me privately:`,
    ...o.fresh.slice(-3).map((m) => `"${oneLine(m, 300)}"`),
    "",
    ...(o.hold ? [`I told them: "${o.hold}"`] : []),
    o.question,
    ...(o.draft ? ["", "I'd reply:", `"${o.draft}"`, "", `${how} OK to send it, what to tell them instead, or what to do.`] : ["", `${how} what to tell them, or what to do.`]),
  ].join("\n");
  const askId = await send(place, text);
  await db.from("bot_draft").insert({
    chat_id: o.chatId,
    to_name: o.label,
    asked: o.asked.slice(0, 2000),
    draft: o.draft.slice(0, 2000),
    question: o.question.slice(0, 1000),
    ask_ids: askId ? [askId] : [],
    ask_chat: place,
    times: 1,
    next_at: iso(Date.now() + backoff(s.ask_every_min, 0)),
  });
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

const OK_SYSTEM = `The iklipse bot is talking privately with someone (usually a client) and asked the team about it. You get what they wrote, the last messages with them, what the bot asked the team, maybe the reply it would send, and the team's answer. Decide through the decision tool, once:
- send: the team OKs the bot's reply as it is ("ok", "okay", "send", "yes", "تمام", "ابعت", "ماشي", 👍). Only when the bot has a reply.
- own: the team says what to tell them, or gives the reply ("tell her we'll deliver Sunday", "قوله المشروع هيخلص الخميس"). text: that message as it goes to them, in English (translate it if needed), keeping exactly what the team means, short, the way a person texts. Never add facts the team didn't give, and never say something was done (booked, sent, fixed, delivered) unless the team says it was done.
- order: the team tells the bot to do something rather than say something: book a call or a meeting ("book it", "احجزله", "no just book it to him", "go ahead, Friday 5"), send the booking link, tell or ask someone on the team, find something out. order: the instruction as it stands alone, naming the person and every detail from the chat ("Book a call with Abbas on Friday at 5 PM", "Send Abbas the booking link").
- drop: don't reply ("no", "don't", "skip", "لا", "متردش", "سيبه").
- unclear: anything else (a question to the bot, a comment, something unrelated to this person).`;

interface Draft {
  id: string;
  chat_id: string;
  to_name: string | null;
  asked: string;
  draft: string;
  question: string | null;
  ask_ids: string[];
  ask_chat: string | null;
  times: number;
  created_at: string;
}
const DRAFT_COLS = "id, chat_id, to_name, asked, draft, question, ask_ids, ask_chat, times, created_at";

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
  const { data } = await db.from("bot_draft").select(DRAFT_COLS).eq("ask_chat", chatId).eq("status", "waiting").order("created_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as Draft | undefined) ?? null;
}

/**
 * The team answered the bot's question about someone: a reply sent (the bot's,
 * or theirs), an order carried out (order: hands it to orders.ts), or dropped.
 * false: it wasn't an answer to it.
 */
export async function decideDraft(db: Db, s: Settings, d: Draft, o: { id: string; chatId: string; text: string }, send: Send, order: (text: string) => Promise<void>) {
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
  const r = (await claude(s.model, OK_SYSTEM, user, OK_TOOL, 800)) as { decision?: string; text?: string; order?: string } | null;
  const who = d.to_name ?? "them";
  const claim = (patch: Record<string, unknown>) =>
    db.from("bot_draft").update({ decided_at: iso(), next_at: null, ...patch }).eq("id", d.id).eq("status", "waiting").select("id");

  if (r?.decision === "drop") {
    const { data: mine } = await claim({ status: "dropped" });
    if (mine?.length) await send(o.chatId, `OK, I'll leave ${firstOf(who)}.`, o.id);
    return true;
  }
  if (r?.decision === "order" && str(r.order)) {
    const { data: mine } = await claim({ status: "ordered", sent_text: str(r.order).slice(0, 2000) });
    if (mine?.length) await order(str(r.order));
    return true;
  }
  const text = r?.decision === "send" && d.draft ? d.draft : r?.decision === "own" ? str(r.text).replace(/[—–]/g, ", ") : "";
  if (!text) return false;
  // Once, even if two people answer at the same time.
  const { data: mine } = await claim({ status: "sent", sent_text: text.slice(0, 2000) });
  if (!mine?.length) return true;
  // As a reply to their last message.
  const theirs = chat.filter((m) => !m.from_bot).at(-1)?.id ?? null;
  await send(d.chat_id, text, theirs);
  await send(o.chatId, r?.decision === "send" ? `Sent to ${who}.` : `Sent to ${who}: "${text}"`, o.id);
  return true;
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
    if (await stillQueued(db, d.ask_chat, d.ask_ids.at(-1), d.created_at)) continue;
    let id: string | null = null;
    if (d.ask_chat) {
      const ask = d.draft ? "Say OK to send my reply, what to tell them instead, or what to do." : "What should I tell them, or do?";
      id = await send(d.ask_chat, `${d.to_name ?? "They"} is still waiting. ${ask}`, d.ask_ids.at(-1) ?? null);
      n++;
    }
    await db
      .from("bot_draft")
      .update({ times: d.times + 1, next_at: iso(Date.now() + backoff(s.ask_every_min, d.times)), ...(id ? { ask_ids: [...d.ask_ids, id] } : {}) })
      .eq("id", d.id);
  }
  return n;
}
