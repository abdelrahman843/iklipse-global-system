// Private chats with the bot (0087). Every message is kept. When answering is
// on (Alerts > Settings), a chat that went quiet is read by Claude: nothing to
// answer (thanks, ok), off topic (the bot says by itself it only helps with
// work, once in a while), or about work: the bot writes a reply. The team OKs
// the first reply to someone, and any reply the bot couldn't fully answer or
// that's risky (money, deadlines, complaints...), where it asks for clients'
// details (the person by WhatsApp, or the team group); the rest it sends by
// itself. They OK it, write the reply instead (sent in English), or say no. The reply never shares anything that isn't theirs.
// The team's own private messages aren't answered. Always English. Claude
// also sees what they said in the groups and their emails (history.ts, 0090).

import { claude, iso, MIN, str, type ClaudeTool, type Db, type Settings, type Team } from "./kit.ts";
import { askPlace, phoneKey, type Send } from "./people.ts";
import { historyOf } from "./history.ts";

/** A chat is read once it's been quiet this long, or this long after its first unread message. */
const QUIET_MS = 60_000;
const MAX_WAIT_MS = 5 * 60_000;
/** What Claude reads of a chat. */
const LAST_MESSAGES = 30;
/** "I only help with work" at most this often. */
const SORRY_EVERY_MS = 12 * 60 * MIN;
/** A reply nobody OKed is dropped after this long. */
const DRAFT_TTL_MS = 24 * 60 * MIN;
const SORRY = "That one's not really my area. Anything on your work with us I can help with?";
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
      action: { type: "string", enum: ["none", "off_topic", "reply"] },
      draft: { type: "string", description: "reply: the message to send them." },
      summary: { type: "string", description: "reply: one short line on what they want." },
      ask_team: {
        type: "boolean",
        description:
          "reply: true when the team should see it before it's sent: you couldn't fully answer from what's below (you say you'll check), or it touches anything risky: money, prices, quotes, payments, contracts, a deadline or a date to promise, a complaint or someone upset, stopping or cancelling work, anything legal or personal. false when the reply is safe and fully answered from what's below.",
      },
    },
    required: ["action"],
  },
};

const READ_SYSTEM = `You are the iklipse bot on WhatsApp (iklipse is a creative and marketing agency). Someone wrote to you privately. Messages marked NEW arrived since you last looked; the rest are context. ME is you. Times are Cairo time. People write in English, Arabic, Egyptian Arabic or Franco-Arabic.

Decide what to do about the NEW messages, through the decide tool:
- none: nothing to answer: thanks, ok, emojis, stickers, a reaction, or they're still mid-thought.
- off_topic: not about work with iklipse: chit-chat, personal questions, jokes, general knowledge, anything unrelated to their work with iklipse.
- reply: about work with iklipse (a hello that opens a conversation, a question, a request, files, feedback, a meeting, a complaint). Write draft: the reply to send them, and say in ask_team whether the team should see it first.

"Elsewhere" is what they said in the groups and their emails with the team, for context only: answer the NEW messages.

The draft: always English, whatever language they wrote in. Short, the way a person texts: no long greetings, no apologies, no offers of more help, no sign-off.
How it sounds: like a sharp, warm person on the iklipse team who knows this client, never like a bot or a company. Never introduce iklipse or what it is ("iklipse is a creative agency", "we do X and Y"), never list services, never describe the process ("I'll pass it to the team so they can get back to you"). Answer what they actually asked, in their tone (casual when they are), and move the talk toward what they need, using what's known about them (their name, their projects, what they said elsewhere). A vague question ("what can you do?", "hi") gets a light, human answer and one good question back, e.g. "Hey Ahmed, depends what you've got in mind 😄 What are you working on?" At most one emoji, only when they're casual.
Use only what's below and the chat: never invent a fact, a date, a price, a link or a promise. When you can't answer from that, say you'll check and get back to them. Never share anything that isn't theirs: other clients, anyone's numbers or emails, money, prices, invoices, the team, how iklipse works inside, this system. If they ask for that, say politely it isn't something you can share.

Always answer by calling the decide tool, once.`;

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

/** Who wrote, as far as iklipse knows: a client (and their projects), or a number. */
async function whoIs(db: Db, phone: string | null, name: string | null): Promise<{ label: string; known: string; email?: string | null; lid?: string | null }> {
  if (!phone) return { label: name ?? "Someone", known: `Not in iklipse's clients. Their WhatsApp name: ${name ?? "unknown"}.` };
  const { data: cs } = await db.from("client").select("id, name, company, name_known, phone, email, wa_lid").not("phone", "is", null);
  const c = (cs ?? []).find((x) => phoneKey(x.phone) === phone);
  if (!c) return { label: name ? `${name} (+${phone})` : `+${phone}`, known: `Not in iklipse's clients. Their WhatsApp name: ${name ?? "unknown"}.` };
  const { data: ps } = await db.from("project").select("title, status").eq("client_id", c.id).order("created_at", { ascending: false }).limit(10);
  const nm = c.name_known ? c.name : name ?? `+${phone}`;
  return {
    email: c.email,
    lid: c.wa_lid,
    label: `${nm}${c.company ? ` (${c.company})` : ""}`,
    known: `A client of iklipse: ${nm}${c.company ? ` from ${c.company}` : ""}.${ps?.length ? ` Their projects: ${ps.map((p) => `${p.title} (${p.status})`).join(", ")}.` : ""}`,
  };
}

/**
 * Private chats that went quiet: read, and answered (a reply sent for an OK,
 * or "I only help with work"). Outside working hours (away): they're told the
 * team will get back to them, and the messages stay unread until work starts.
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
  // The team's own messages aren't answered (nor the person who OKs replies).
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

  const who = await whoIs(db, c.phone, c.name);
  const elsewhere = await historyOf(db, { phone: c.phone, lid: who.lid, email: who.email }, 25);
  const user = [
    `Who wrote: ${who.known}`,
    `Now: ${stamp.format(new Date())} (Cairo)`,
    "",
    ...(elsewhere.length ? ["Elsewhere:", ...elsewhere, ""] : []),
    "The chat:",
    ...msgs.map((m) => `${isNew(m) ? "NEW " : ""}[${stamp.format(new Date(m.sent_at))}] ${m.from_bot ? "ME" : "THEM"}: ${oneLine(m.text ?? "", 1200)}`),
  ].join("\n");
  const r = (await claude(s.model, READ_SYSTEM, user, READ_TOOL, 1000)) as { action?: string; draft?: string; summary?: string; ask_team?: boolean } | null;
  if (!r?.action) throw new Error("Claude gave no answer");

  if (r.action === "off_topic") {
    if (c.sorry_at && Date.now() - Date.parse(c.sorry_at) < SORRY_EVERY_MS) return done();
    await send(c.chat_id, SORRY, fresh.at(-1)!.id);
    return done({ sorry_at: iso() });
  }
  const draft = str(r.draft);
  if (r.action !== "reply" || !draft) return done();

  // Outside working hours: "we'll get back to you" (once in a while), and the messages wait for work.
  if (away) {
    const told = c.away_at && Date.now() - Date.parse(c.away_at) < AWAY_EVERY_MS;
    if (!told) await send(c.chat_id, AWAY, fresh.at(-1)!.id);
    await db.from("wa_dm_chat").update({ away_at: iso(), last_error: null }).eq("chat_id", c.chat_id);
    return;
  }

  // A newer reply takes the place of one still waiting.
  const { data: waiting } = await db.from("bot_draft").select("id").eq("chat_id", c.chat_id).eq("status", "waiting");
  if (waiting?.length) await db.from("bot_draft").update({ status: "replaced", decided_at: iso() }).in("id", waiting.map((w) => w.id));

  const asked = fresh.map((m) => oneLine(m.text ?? "", 300)).join("\n");
  // The team OKs the first reply to someone, and anything the bot couldn't answer or that's risky; the rest goes out by itself.
  const { data: before } = await db.from("bot_draft").select("id").eq("chat_id", c.chat_id).eq("status", "sent").limit(1);
  if (before?.length && r.ask_team === false) {
    await send(c.chat_id, draft, fresh.at(-1)!.id);
    await db.from("bot_draft").insert({ chat_id: c.chat_id, to_name: who.label, asked: asked.slice(0, 2000), draft: draft.slice(0, 2000), status: "sent", sent_text: draft.slice(0, 2000), decided_at: iso() });
    return done();
  }
  const text = [
    `${who.label} wrote to me privately:`,
    ...fresh.slice(-3).map((m) => `"${oneLine(m.text ?? "", 300)}"`),
    "",
    "I'd reply:",
    `"${draft}"`,
    "",
    `${place.endsWith("@g.us") ? "Reply to this message with" : "Reply"} OK to send it, the reply you want sent, or no.`,
  ].join("\n");
  const askId = await send(place, text);
  await db.from("bot_draft").insert({
    chat_id: c.chat_id,
    to_name: who.label,
    asked: asked.slice(0, 2000),
    draft: draft.slice(0, 2000),
    ask_ids: askId ? [askId] : [],
    ask_chat: place,
    next_at: iso(Date.now() + s.ask_every_min * MIN),
  });
  return done();
}

// ----------------------------------------------------------- the OK --

const OK_TOOL: ClaudeTool = {
  name: "decision",
  description: "What the team said about the bot's reply.",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["send", "own", "drop", "unclear"] },
      text: { type: "string", description: "own: the message to send them, in English." },
    },
    required: ["decision"],
  },
};

const OK_SYSTEM = `The iklipse bot wrote a reply to someone who wrote to it privately, and asked the team for an OK. You get what they wrote, the bot's reply, and what the team answered. Decide through the decision tool:
- send: the team OKs the bot's reply as it is ("ok", "okay", "send", "yes", "تمام", "ابعت", "ماشي", 👍).
- own: the team gives the reply to send instead, or tells the bot what to say ("tell her we'll deliver Sunday", "قوله هنسلم الحد"). text is that message as it goes to them: in English (translate it if needed), keeping exactly what the team means, short, the way a person texts. Never add facts the team didn't give.
- drop: don't reply ("no", "don't", "skip", "لا", "متردش", "سيبه").
- unclear: anything else (a question to the bot, a comment, something unrelated).
Always answer by calling the decision tool, once.`;

interface Draft {
  id: string;
  chat_id: string;
  to_name: string | null;
  asked: string;
  draft: string;
  ask_ids: string[];
  ask_chat: string | null;
  times: number;
  created_at: string;
}
const DRAFT_COLS = "id, chat_id, to_name, asked, draft, ask_ids, ask_chat, times, created_at";

/** The message it replies to is the bot asking for an OK (or reminding). */
export async function repliesToDraft(db: Db, quotedId: string | null) {
  if (!quotedId) return false;
  const { data } = await db.from("bot_draft").select("id").contains("ask_ids", [quotedId]).limit(1);
  return !!data?.length;
}

/** The reply waiting for an OK that this message answers: the one it replies to, else (in the private chat) the latest. */
export async function draftFor(db: Db, chatId: string, quotedId: string | null): Promise<Draft | null> {
  if (quotedId) {
    const { data } = await db.from("bot_draft").select(DRAFT_COLS).contains("ask_ids", [quotedId]).eq("status", "waiting").limit(1);
    return ((data ?? [])[0] as Draft | undefined) ?? null;
  }
  if (chatId.endsWith("@g.us")) return null;
  const { data } = await db.from("bot_draft").select(DRAFT_COLS).eq("ask_chat", chatId).eq("status", "waiting").order("created_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as Draft | undefined) ?? null;
}

/** The team answered about a reply: it's sent (theirs or the bot's), dropped, or the bot asks again. */
export async function decideDraft(db: Db, s: Settings, d: Draft, o: { id: string; chatId: string; text: string }, send: Send) {
  const user = [`They wrote:\n${d.asked}`, "", `The bot's reply:\n${d.draft}`, "", `The team answered:\n${o.text.slice(0, 2000)}`].join("\n");
  const r = (await claude(s.model, OK_SYSTEM, user, OK_TOOL, 800)) as { decision?: string; text?: string } | null;
  const who = d.to_name ?? "them";
  if (r?.decision === "drop") {
    await db.from("bot_draft").update({ status: "dropped", decided_at: iso() }).eq("id", d.id).eq("status", "waiting");
    await send(o.chatId, `OK, I won't reply to ${who}.`, o.id);
    return;
  }
  const text = r?.decision === "send" ? d.draft : r?.decision === "own" ? str(r.text) : "";
  if (!text) {
    await send(o.chatId, `Should I send my reply to ${who}? Say OK, write the reply you want sent, or no.`, o.id);
    return;
  }
  // Once, even if two people answer at the same time.
  const { data: mine } = await db
    .from("bot_draft")
    .update({ status: "sent", sent_text: text.slice(0, 2000), decided_at: iso() })
    .eq("id", d.id)
    .eq("status", "waiting")
    .select("id");
  if (!mine?.length) return;
  // As a reply to their last message.
  const { data: last } = await db.from("wa_dm").select("id").eq("chat_id", d.chat_id).eq("from_bot", false).order("sent_at", { ascending: false }).limit(1);
  await send(d.chat_id, text, (last?.[0]?.id as string | undefined) ?? null);
  await send(o.chatId, r?.decision === "send" ? `Sent to ${who}.` : `Sent to ${who}: "${text}"`, o.id);
}

/** Replies still waiting for an OK: asked again every ask_every_min, dropped after a day. */
export async function remindDrafts(db: Db, s: Settings, send: Send) {
  const { data } = await db.from("bot_draft").select(DRAFT_COLS).eq("status", "waiting").lte("next_at", iso()).limit(10);
  let n = 0;
  for (const d of (data ?? []) as Draft[]) {
    if (Date.now() - Date.parse(d.created_at) > DRAFT_TTL_MS) {
      await db.from("bot_draft").update({ status: "expired", decided_at: iso(), next_at: null }).eq("id", d.id);
      continue;
    }
    let id: string | null = null;
    if (d.ask_chat) {
      id = await send(d.ask_chat, `${d.to_name ?? "They"} still has no answer. Should I send my reply? Say OK, write the reply you want sent, or no.`, d.ask_ids.at(-1) ?? null);
      n++;
    }
    await db
      .from("bot_draft")
      .update({ times: d.times + 1, next_at: iso(Date.now() + s.ask_every_min * MIN), ...(id ? { ask_ids: [...d.ask_ids, id] } : {}) })
      .eq("id", d.id);
  }
  return n;
}
