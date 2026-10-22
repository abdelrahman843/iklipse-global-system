// What Claude makes of a chat with a client: a WhatsApp group (index.ts) or a
// Slack channel (slack.ts). It reads the last messages and opens an alert when
// a client is left without a reply, or someone promises something (the team:
// "I'll send it in an hour"; a client: "I'll send the files tomorrow"), and
// closes the ones the chat shows were dealt with.

import { cairoOffset, cairoStamp, claude, firstRing, iso, MIN, str, type ClaudeTool, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { firstTime, type Send } from "./people.ts";

/** A chat is read once it's been quiet this long, or this long after its first unread message. */
export const QUIET_MS = 60_000;
export const MAX_WAIT_MS = 5 * 60_000;
/** What Claude reads of a chat: the last messages of the last days. */
export const WINDOW_MESSAGES = 60;
export const WINDOW_DAYS = 3;

export interface Chat {
  source: "whatsapp" | "slack";
  /** watch_alert's column for it: the WhatsApp group or the Slack channel. */
  col: "chat_id" | "channel_id";
  id: string;
  name: string;
}

/** A message, the way Claude reads it. */
export interface ChatLine {
  id: string;
  sent_at: string;
  /** Came in since Claude last read the chat. */
  isNew: boolean;
  /** Someone on the team (or the bot) wrote it. */
  team: boolean;
  /** The bot wrote it (its words never answer anyone). */
  bot?: boolean;
  name: string;
  /** Not on the team and not a client: a freelancer or a partner (0101). */
  other?: boolean;
  /** The sender's WhatsApp number (digits), when WhatsApp shows it. */
  phone?: string | null;
  /** The message it replies to (a quote, or the thread it's in). */
  replyTo: string | null;
  text: string;
}

const WORDS = {
  whatsapp: { what: "WhatsApp group", place: "group", Place: "Group" },
  slack: { what: "Slack channel", place: "channel", Place: "Channel" },
};

const readSystem = (what: string, place: string) => `You watch a ${what} between iklipse (a creative and marketing agency) and one of its clients, on behalf of the iklipse team. Each message is marked TEAM (iklipse staff), BOT (the iklipse bot), PARTNER (someone working with iklipse who isn't staff and isn't the client: a freelancer, a partner; never a client, so nothing they write needs an answer from the team, and nothing is opened about them as a client) or CLIENT (anyone else in the ${place}: the client and their colleagues). Messages marked NEW arrived since you last looked; the rest are context. Times are Cairo time. People write in English, Arabic, Egyptian Arabic or Franco-Arabic.

Your job: no client is left waiting, and no promise is forgotten. Report through the report tool.

open: new alerts, only for something in a NEW message that isn't already covered by an open alert.
- unanswered: a CLIENT message the team hasn't answered: a greeting that opens a conversation ("hi", "hello", "السلام عليكم", "صباح الخير"), a question, a request, feedback, a complaint, an approval, files or media sent, chasing. Only skip messages that close a conversation and expect nothing back: thanks, "ok", "تمام", likes, emojis, stickers, reactions. Anything a TEAM member wrote after it that responds to the client answers it, and so does a TEAM member telling the bot to act on it ("@iklipse book a call with Abbas", "@iklipse send her the files"): the team is on it. One alert per waiting client: when they sent several messages, one alert about their latest need.
- promise: a TEAM member committed to do something or to get back ("I'll send it in an hour", "هبعتهولك بكرة الصبح", "give me 10 minutes", "هرجعلك كمان شوية", "I'll check and get back to you"). If they already did it in a later message, don't open it.
- follow_up: the team is waiting on a CLIENT: they said they will send or do something the team needs (files, content, feedback, approval, payment, a call), or a TEAM member asked them for something the team needs (an answer to a question, a decision, approval, files, payment) and they haven't given it yet. Title it like "Waiting on Sara for the logo files". Not when the client already gave it in a later message.
- deadline: a TEAM member told the client when the team will deliver or hand over work, or they agreed a delivery date ("we'll deliver the video Sunday", "هتستلم التصميمات يوم الخميس", "the website goes live on the 25th", "هنسلمك الشغل بكرة الساعة 5"). A quick commitment within the hours ahead ("in an hour", "tonight", "give me 10 minutes") is a promise instead. Title it like "Deliver the final video to Sara by Sunday".
For promise, follow_up and deadline, due_at is when it is due (ISO 8601 with the Cairo offset given below), or null when no time was given ("shortly", "later", "كمان شوية"). A deadline needs its day: with only a day and no time, 10:00 that day.
Each alert has: title (one short line, like "Alessandro is waiting for a reply" or "Omar promised the final cut by 6 pm"), detail (one sentence in English on what is needed, no long quotes), person (who it is about: the client, or the team member who promised), for (the names of the TEAM members who should handle it: whoever promised, or the team member the client addressed; an empty list means everyone on the team in this ${place}), message (the # of the message it is about), priority (normal; high for an upset client, a deadline or money; urgent for an angry client or something broken right now).

resolve: open alerts the chat now shows were dealt with: the client got a real answer (from anyone, even their own colleague, or the bot doing what they asked), a TEAM member told the bot to act on it, the promise was kept, the delivery was made, what the team was waiting for arrived (or the client answered), or it no longer matters. A TEAM reply that only says "checking" or "one sec" is not an answer; if it promises a time, resolve the unanswered alert and open a promise instead.

BOT is the iklipse bot. Its holding line ("we got your message and we'll get back to you shortly", "as soon as the team is online") answers nobody: resolve nothing because of it. Its other messages do what they say: the booking link sent to a client who asked for a meeting, a meeting booked or moved for them, an answer to what they asked: those answer that client. Open nothing about the bot's own messages.

No client is left on read: when unsure whether a CLIENT message needs a reply, it does. Don't reopen anything listed under "Closed recently" unless a NEW message brings it back. When nothing needs doing, return empty lists.

Always answer by calling the report tool, once.`;

/** When the bot sends clients the booking link in this chat (0088): what Claude is told about meeting requests. */
const MEETING_RULE = `

meeting: every NEW CLIENT message asking for a meeting or a call ("I need to book a call", "can we have a call tomorrow?", "ممكن نعمل ميتنج", "نتكلم فون؟"), by its #, even when they asked before or said hello first, unless the bot or the team already answered that request. The bot sends them the booking link, so don't open unanswered for it, nor for a greeting or a chase ("hello?", "any update?") that only goes with it; only when they also ask for something else, or they say none of the link's times suit them or the link doesn't work.`;

const readTool = (place: string, meetings = false): ClaudeTool => ({
  name: "report",
  description: `The alerts to open and to close in this ${place}.`,
  input_schema: {
    type: "object",
    properties: {
      open: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["unanswered", "promise", "follow_up", "deadline"] },
            title: { type: "string" },
            detail: { type: "string" },
            person: { type: "string" },
            for: { type: "array", items: { type: "string" } },
            message: { type: "integer" },
            due_at: { type: ["string", "null"] },
            priority: { type: "string", enum: ["normal", "high", "urgent"] },
          },
          required: ["kind", "title", "detail", "person", "for", "message", "priority"],
        },
      },
      resolve: {
        type: "array",
        items: {
          type: "object",
          properties: { alert: { type: "string" }, reason: { type: "string" } },
          required: ["alert", "reason"],
        },
      },
      ...(meetings ? { meeting: { type: "array", items: { type: "integer" }, description: "The # of NEW CLIENT messages asking for a meeting or a call." } } : {}),
    },
    required: ["open", "resolve"],
  },
});

interface Opened {
  kind: "unanswered" | "promise" | "follow_up" | "deadline";
  title: string;
  detail: string;
  person: string;
  for: string[];
  message: number;
  due_at?: string | null;
  priority: "normal" | "high" | "urgent";
}

/** Team members by a name Claude wrote ("Omar", "omar k", the username). */
function findPeople(names: string[], pool: Person[]): Person[] {
  const out = new Map<string, Person>();
  for (const raw of names) {
    const n = str(raw).toLowerCase().replace(/^@/, "");
    if (!n) continue;
    const hit =
      pool.find((p) => p.name.toLowerCase() === n || p.username.toLowerCase() === n) ??
      pool.find((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
    if (hit) out.set(hit.id, hit);
  }
  return [...out.values()];
}

/** Claude reads a chat's messages (some NEW); its alerts open and close. inChat: the team in it. */
export async function readChat(
  db: Db,
  s: Settings,
  t: Team,
  chat: Chat,
  msgs: ChatLine[],
  inChat: Map<string, Person>,
  /** Clients asking for a meeting get a booking link made for them (WhatsApp groups where the bot replies). */
  booking?: { link: (p: { name?: string | null; phone?: string | null }) => Promise<string>; send: Send },
) {
  const { what, place, Place } = WORDS[chat.source];
  const index = new Map(msgs.map((m, i) => [m.id, i + 1]));
  const lines = msgs.map((m, i) => {
    const reply = m.replyTo ? (index.has(m.replyTo) ? ` (replying to #${index.get(m.replyTo)})` : " (replying to an older message)") : "";
    return `${m.isNew ? "NEW " : ""}#${i + 1} [${cairoStamp.format(new Date(m.sent_at))}] ${m.bot ? "BOT" : m.team ? "TEAM" : m.other ? "PARTNER" : "CLIENT"} ${m.name}${reply}: ${m.text.replace(/\s+/g, " ").slice(0, 1200)}`;
  });

  const { data: openRows } = await db
    .from("watch_alert")
    .select("id, kind, title, detail, person, message_id, due_at, created_at")
    .eq(chat.col, chat.id)
    .eq("status", "open")
    .order("created_at");
  const open = openRows ?? [];
  const { data: closedRows } = await db
    .from("watch_alert")
    .select("kind, title, status, close_note")
    .eq(chat.col, chat.id)
    .neq("status", "open")
    .gt("closed_at", iso(Date.now() - 24 * 60 * MIN))
    .order("closed_at", { ascending: false })
    .limit(10);

  const user = [
    `${Place}: ${chat.name}`,
    `Now: ${cairoStamp.format(new Date())} Cairo time (UTC${cairoOffset()})`,
    `Team members in this ${place}: ${[...inChat.values()].map((p) => p.name).join(", ") || "none known"}`,
    "",
    "Messages (oldest first):",
    ...lines,
    "",
    "Open alerts:",
    ...(open.length
      ? open.map((a, i) => `A${i + 1}: ${a.kind}; ${a.title}; ${a.detail ?? ""}${a.message_id && index.has(a.message_id) ? `; about #${index.get(a.message_id)}` : ""}`)
      : ["none"]),
    "",
    "Closed recently:",
    ...((closedRows ?? []).length ? (closedRows ?? []).map((a) => `- ${a.kind}; ${a.title} (${a.status}${a.close_note ? `: ${a.close_note}` : ""})`) : ["none"]),
  ].join("\n");

  const r = (await claude(s.model, readSystem(what, place) + (booking ? MEETING_RULE : ""), user, readTool(place, !!booking))) as {
    open?: Opened[];
    resolve?: { alert: string; reason: string }[];
    meeting?: number[];
  } | null;
  if (!r) throw new Error("Claude gave no answer");

  // A client asking for a meeting: the booking link, as a reply to them (once).
  if (booking) {
    for (const n of r.meeting ?? []) {
      const m = msgs[Number(n) - 1];
      if (!m || !m.isNew || m.team || !(await firstTime(db, `link:${m.id}`))) continue;
      try {
        await booking.send(chat.id, `You can book a time that suits you here:\n${await booking.link({ name: m.name, phone: m.phone })}`, m.id);
      } catch (e) {
        console.error("booking link", (e as Error).message);
      }
    }
  }

  // Close what the chat shows was dealt with.
  let resolved = 0;
  for (const x of r.resolve ?? []) {
    const n = Number(String(x.alert).replace(/\D/g, ""));
    const a = open[n - 1];
    if (!a) continue;
    const { data: hit } = await db
      .from("watch_alert")
      .update({ status: "resolved", closed_at: iso(), close_note: str(x.reason).slice(0, 300) || `Answered in the ${place}`, next_alert_at: null, updated_at: iso() })
      .eq("id", a.id)
      .eq("status", "open")
      .select("id");
    if (!hit?.length) continue;
    await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", a.id);
    await db.from("watch_event").insert({ alert_id: a.id, what: "resolved", detail: str(x.reason).slice(0, 300) || null });
    await db.rpc("_watch_quiet_notifications", { p_alert: a.id });
    resolved++;
  }

  // Open the new ones (not for a meeting request the link just answered).
  const linked = new Set((booking ? r.meeting ?? [] : []).map(Number));
  let opened = 0;
  const pool = [...t.people.values()].filter((p) => p.active);
  const admins = pool.filter((p) => p.admin);
  for (const o of r.open ?? []) {
    if (!["unanswered", "promise", "follow_up", "deadline"].includes(o.kind) || !str(o.title)) continue;
    // A deadline with no day is a promise.
    if (o.kind === "deadline" && !(o.due_at && Date.parse(o.due_at) > Date.now())) o.kind = "promise";
    if (o.kind === "deadline" && !s.deadline_enabled) continue;
    const m = msgs[Number(o.message) - 1];
    if (!m) continue;
    if (o.kind === "unanswered" && linked.has(Number(o.message))) continue;
    // Never twice for the same message, nor two "waiting" alerts for the same client.
    if (open.some((a) => a.message_id === m.id && a.kind === o.kind)) continue;
    if (o.kind === "unanswered" && open.some((a) => a.kind === "unanswered" && str(a.person).toLowerCase() === str(o.person).toLowerCase())) continue;
    if (o.kind === "follow_up" && !s.follow_enabled) continue;
    const sent = Date.parse(m.sent_at);
    let due: number;
    if (o.kind === "unanswered") {
      due = sent + s.reply_wait_min * MIN;
    } else {
      const asked = o.due_at ? Date.parse(o.due_at) : NaN;
      due = Number.isFinite(asked) && asked > sent ? asked : sent + (o.kind === "follow_up" ? s.follow_wait_min : s.promise_wait_min) * MIN;
    }
    // Who it rings for: the people named, else the team in the chat, else the admins.
    let to = findPeople(o.for ?? [], [...inChat.values()]);
    if (!to.length && (o.for ?? []).length) to = findPeople(o.for, pool);
    if (!to.length) to = [...inChat.values()];
    if (!to.length) to = admins;
    if (s.cc_admins) for (const a of admins) if (!to.some((p) => p.id === a.id)) to.push(a);
    if (!to.length) continue;

    const { data: made, error } = await db
      .from("watch_alert")
      .insert({
        [chat.col]: chat.id,
        source: chat.source,
        kind: o.kind,
        title: str(o.title).slice(0, 200),
        detail: str(o.detail).slice(0, 500) || null,
        person: str(o.person).slice(0, 120) || null,
        priority: ["normal", "high", "urgent"].includes(o.priority) ? o.priority : "normal",
        message_id: m.id,
        due_at: iso(due),
        next_alert_at: iso(firstRing(s, o.kind, due)),
      })
      .select("id")
      .single();
    if (error || !made) continue;
    await db.from("watch_recipient").insert(to.map((p) => ({ alert_id: made.id, user_id: p.id })));
    await db.from("watch_event").insert({
      alert_id: made.id,
      what: "opened",
      detail: `For ${to.map((p) => p.name).join(", ")}${o.kind === "unanswered" ? "" : `, due ${cairoStamp.format(new Date(due))}`}`,
    });
    open.push({ id: made.id, kind: o.kind, title: o.title, detail: o.detail, person: o.person, message_id: m.id, due_at: iso(due), created_at: iso() });
    opened++;
  }
  return { opened, resolved };
}
