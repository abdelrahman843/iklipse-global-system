// whatsapp-bot — the WhatsApp watch (0067).
//
// The bot's WhatsApp (Green API) sits in client groups. Every group message
// comes here (hook) and is kept (for good since 0086). Once a group goes quiet for a
// minute, Claude reads its new messages and opens an alert when a client is
// left without a reply, or someone promises something (the team: "I'll send it
// in an hour"; a client: "I'll send the files tomorrow"), and closes the ones
// the chat shows were dealt with.
//
// Every minute (tick) due alerts ring: a notification to the team members in
// that group (only the person it's about, when it's about one person), again
// every few minutes. After that many, Ikli calls each of them inside iklipse
// (0068: a ringing call screen in the app, a push that rings when it's closed;
// the voice agent's ElevenLabs voice, the words by Claude), again and again
// until they answer, then every so often while it's still open. On a phone
// with the iklipse Android app (0071) the call rings like a real one: full
// screen, the ringtone until it's answered (Firebase). It stops when
// someone marks it handled, when the chat shows it was dealt with, or after
// the hours set. All of it set in Alerts > Settings.
//
// Email (0076, mail.ts): the same alerts from the Gmail accounts each person
// turned on, read every minute in the same run, ringing only that person.
// Slack (0078, slack.ts): the iklipse Slack app in client channels, read the
// same way as the groups (what Claude makes of a chat is in chat.ts).
// Meetings (0079, on Calendly since 0084, book.ts): an admin mentions the bot in a
// group to book a meeting on their own Calendly, then talks to it by replying to its messages
// or privately (free times, another day, move, cancel); only admins get any answer. Since
// 0088 the group only sees what was done, and everyone on a meeting iklipse knows gets its
// details privately and a reminder an hour before (meetings.ts).
// People (0086, people.ts): a group is a client group or a team group; everyone
// in a client group who isn't on the team is kept in Clients, and what's
// missing about them is asked of one person by WhatsApp, or in a team group.
// First line (0087): in client groups an admin turns it on for, a client left
// waiting gets "we'll get back to you shortly" when the alert first rings;
// private chats are kept and answered (dm.ts): the team OKs the first reply to someone and anything risky.
// Orders (0090, orders.ts): anyone in a team group mentions the bot ("tell
// Rabah to...", "ask Sara when..."); it writes to them privately and keeps
// after them until it's done, reporting in the team group. The open alerts are
// posted in a team group every 2 hours. Files are stored, voice notes
// written out, photos and PDFs read (files.ts), and client emails kept, for
// the bot only (history.ts).
// The settings, the team, Cairo time and Claude are in kit.ts.
//
// POST /whatsapp-bot/hook     Green API webhooks (Authorization: Bearer WATCH_HOOK_TOKEN)
// POST /whatsapp-bot/slack    Slack's events (signed with the app's signing secret)
// POST /whatsapp-bot/tick     X-Iklipse-Secret (the database, every minute)
// POST /whatsapp-bot/selftest X-Iklipse-Secret -> { ok, text }: the voice speaks a line and it's written out again
// POST /whatsapp-bot/decline  ?c=<call>&s=<signature>: Decline on the call's notification
// POST /whatsapp-bot/pair     { code, token, device, version }: the Android app links a phone
// POST /whatsapp-bot/phone    { id, key, token?, version?, code? }: the app checks in (-> update: a newer app)
// POST /whatsapp-bot/unpair   { id, key }: signed out in the app
// POST /whatsapp-bot/act      { call, sig, act }: the app's buttons on a call
// POST /whatsapp-bot (login token) { action }:
//   test_call  -> { call }           Ikli calls me now
//   hush       { call }              answered here: my phone stops ringing
// admins:
//   connect    -> { state, phone }   point the Green API instance's webhooks here
//   status     -> { state, phone }
//   sync       -> { groups }         re-read the bot's groups and who is in them
//   slack_status -> { ok, team, url, error? }  check the Slack app's token
//   slack_sync -> { channels, read }  re-read the Slack app's channels and who is in them
//
// Secrets: ANTHROPIC_API_KEY, ELEVEN_API_KEY (ELEVEN_VOICE_ID, ELEVEN_MODEL),
// WATCH_WEBHOOK_SECRET, WATCH_HOOK_TOKEN, FCM_SERVICE_ACCOUNT_B64 (the Firebase
// service account JSON, base64). Green API (Users page) and the Slack app
// (Alerts > Slack) are kept in the vault.
// Deploy with --no-verify-jwt.

import { caller, cors, HttpError, json, route, same, serviceClient, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";
import { toPhones } from "../_shared/fcm.ts";
import { cairoStamp, claude, closeAlert, env, iso, MIN, str, TZ, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { MAX_WAIT_MS, QUIET_MS, readChat, WINDOW_DAYS, WINDOW_MESSAGES, type ChatLine } from "./chat.ts";
import { watchMail } from "./mail.ts";
import { slackCheck, slackHook, slackSync, watchSlack } from "./slack.ts";
import { answer, bookTurnAt, heard, heardPrivate, leftovers, mentionsBot } from "./book.ts";
import { bookingLink, pollCalendly, remindSoon, tellCancelled, tellNew } from "./meetings.ts";
import { askNow, firstTime, learnPeople, phoneKey, repliesToAsk, takeAnswer, type Send } from "./people.ts";
import { decideDraft, draftFor, keepDm, readDms, remindDrafts, repliesToDraft } from "./dm.ts";
import { bookedOrders, followOrder, fromTarget, nagOrders, orderAt, orderOf, takeOrder } from "./orders.ts";
import { fileOf, keepFile, keepFiles, noteFile, writeOut } from "./files.ts";

const ELEVEN_KEY = env("ELEVEN_API_KEY") || env("ELEVENLABS_API_KEY");
const VOICE = env("ELEVEN_VOICE_ID", "aMSt68OGf4xUZAnLpTU8");
const VOICE_MODEL = env("ELEVEN_MODEL", "eleven_flash_v2_5");
const TICK_SECRET = env("WATCH_WEBHOOK_SECRET");
const HOOK_TOKEN = env("WATCH_HOOK_TOKEN");
const PUSH_SECRET = env("PUSH_WEBHOOK_SECRET");
const BASE = `${SUPABASE_URL}/functions/v1/whatsapp-bot`;
const BUCKET = "watch-audio";
/** No new work is started after this long (the function has about 150 seconds). */
const RUN_MS = 100_000;

interface Config {
  greenapi_url: string | null;
  greenapi_instance: string | null;
  greenapi_token: string | null;
  slack_bot_token: string | null;
  slack_signing_secret: string | null;
  app_url: string | null;
}

interface Alert {
  id: string;
  chat_id: string | null;
  kind: "unanswered" | "promise" | "follow_up" | "ads" | "deadline";
  source: "whatsapp" | "email" | "slack";
  mail_subject: string | null;
  title: string;
  detail: string | null;
  person: string | null;
  priority: string;
  status: string;
  due_at: string;
  alerts_sent: number;
  calls_made: number;
  snoozed_until: string | null;
  created_at: string;
}

const digits = (s: unknown) => (typeof s === "string" ? s : "").replace(/\D/g, "");

/** The number in a WhatsApp id (2010...@c.us), or a number Green API sends as one, if it is one. */
function phoneOf(id: unknown): string | null {
  const s = typeof id === "number" ? String(id) : str(id);
  if (!/@c\.us$/.test(s) && !/^\+?\d+$/.test(s)) return null;
  const d = digits(s.split("@")[0]);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** The number of someone WhatsApp shows only by their lid: from a group they're in, Clients, or the team. */
async function phoneOfLid(db: Db, lid: string): Promise<string | null> {
  const { data: p } = await db.from("wa_participant").select("phone").eq("lid", lid).not("phone", "is", null).limit(1).maybeSingle();
  if (p?.phone) return p.phone as string;
  const { data: c } = await db.from("client").select("phone").eq("wa_lid", lid).not("phone", "is", null).limit(1).maybeSingle();
  if (c?.phone) return phoneKey(c.phone);
  const { data: m } = await db.from("wa_member_lid").select("user_id").eq("lid", lid).maybeSingle();
  if (!m) return null;
  const { data: w } = await db.from("wa_member").select("phone").eq("user_id", m.user_id).limit(1).maybeSingle();
  return (w?.phone as string | undefined) ?? null;
}

// ----------------------------------------------------------------- Cairo --

const cairoClock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const cairoSpoken = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

/** Within the quiet hours (Cairo), when nothing rings. */
function quietNow(s: Settings) {
  if (!s.quiet_from || !s.quiet_to) return false;
  const hm = cairoClock.format(new Date());
  const f = s.quiet_from.slice(0, 5);
  const t = s.quiet_to.slice(0, 5);
  if (f === t) return false;
  return f < t ? hm >= f && hm < t : hm >= f || hm < t;
}

const cairoDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const cairoWeekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });

/** A day off (Cairo): one of the weekdays off, or a date off. Nothing rings all day. */
function dayOff(s: Settings) {
  const now = new Date();
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(cairoWeekday.format(now));
  return (s.off_days ?? []).includes(wd) || (s.off_dates ?? []).includes(cairoDay.format(now));
}

/** "2 hours 10 minutes" */
function spokenSpan(ms: number) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minute${r === 1 ? "" : "s"}` : ""}`;
}

// --------------------------------------------------------------- loading --

async function settings(db: Db): Promise<Settings> {
  const { data, error } = await db.from("watch_settings").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data as Settings;
}

async function config(db: Db): Promise<Config> {
  const { data, error } = await db.rpc("_watch_config");
  if (error) throw new Error(error.message);
  return data as Config;
}

async function team(db: Db): Promise<Team> {
  const [profiles, links, cards, hidden] = await Promise.all([
    db.from("profile").select("id, display_name, username, is_active, role"),
    db.from("wa_member").select("phone, user_id"),
    db.from("profile_contact").select("user_id, whatsapp").not("whatsapp", "is", null),
    db.from("wa_member_lid").select("lid, user_id"),
  ]);
  const people = new Map<string, Person>();
  for (const p of profiles.data ?? []) {
    people.set(p.id, { id: p.id, name: p.display_name || p.username || "Someone", username: String(p.username ?? ""), active: !!p.is_active, admin: p.role === "admin" });
  }
  const byPhone = new Map<string, Person>();
  for (const c of cards.data ?? []) {
    const p = people.get(c.user_id);
    if (p && c.whatsapp) byPhone.set(c.whatsapp, p);
  }
  // A link made in Alerts > Groups wins over a member card.
  for (const l of links.data ?? []) {
    const p = people.get(l.user_id);
    if (p) byPhone.set(l.phone, p);
  }
  // People WhatsApp hides the number of, linked by their WhatsApp id.
  const byLid = new Map<string, Person>();
  for (const l of hidden.data ?? []) {
    const p = people.get(l.user_id);
    if (p) byLid.set(l.lid, p);
  }
  return { people, byPhone, byLid };
}

// ------------------------------------------------------------- Green API --

async function green<T>(cfg: Config, method: string, body?: unknown): Promise<T> {
  if (!cfg.greenapi_url || !cfg.greenapi_instance || !cfg.greenapi_token) {
    throw new HttpError(409, "Add the WhatsApp (Green API) connection on the Users page first");
  }
  const res = await fetch(
    `${cfg.greenapi_url}/waInstance${cfg.greenapi_instance}/${method}/${cfg.greenapi_token}`,
    body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error || msg;
    } catch {
      /* plain text */
    }
    throw new HttpError(502, `WhatsApp (Green API): ${msg || `error ${res.status}`}`);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}

/** Point the instance's webhooks at this function, then read its state. */
async function connect(db: Db, cfg: Config) {
  if (!HOOK_TOKEN) throw new HttpError(500, "WATCH_HOOK_TOKEN isn't set on the whatsapp-bot function");
  await green(cfg, "setSettings", {
    webhookUrl: `${BASE}/hook`,
    webhookUrlToken: HOOK_TOKEN,
    incomingWebhook: "yes",
    outgoingMessageWebhook: "yes",
    outgoingAPIMessageWebhook: "yes",
    stateWebhook: "yes",
    outgoingWebhook: "no",
  });
  return await botStatus(db, cfg);
}

async function botStatus(db: Db, cfg: Config) {
  const st = await green<{ stateInstance?: string }>(cfg, "getStateInstance");
  let phone: string | null = null;
  try {
    const s = await green<{ wid?: string }>(cfg, "getSettings");
    phone = phoneOf(s.wid);
  } catch {
    /* the state is what matters */
  }
  const state = st.stateInstance ?? "unknown";
  await db.from("watch_settings").update({ bot_state: state, ...(phone ? { bot_phone: phone } : {}) }).eq("id", 1);
  return { state, phone };
}

interface GroupData {
  groupId?: string;
  subject?: string;
  participants?: { id?: string; lid?: string; phoneNumber?: string; isAdmin?: boolean; isSuperAdmin?: boolean }[];
}

/** Who is in a group now (and its name). An empty list means the bot was taken out. */
async function syncGroup(db: Db, cfg: Config, chatId: string) {
  const d = await green<GroupData>(cfg, "getGroupData", { groupId: chatId });
  const parts = (d.participants ?? []).filter((p) => p.id || p.lid);
  const now = iso();
  if (!parts.length) {
    await db.from("wa_group").update({ left_at: now, synced_at: now, last_error: null }).eq("chat_id", chatId);
    return;
  }
  const rows = parts.map((p) => {
    const lid = str(p.lid) || (str(p.id).endsWith("@lid") ? str(p.id) : "");
    return {
      chat_id: chatId,
      wa_id: str(p.id) || lid,
      phone: phoneOf(p.phoneNumber) ?? phoneOf(p.id),
      lid: lid || null,
      is_admin: !!(p.isAdmin || p.isSuperAdmin),
    };
  });
  const seen = [...new Set(rows.map((r) => r.wa_id))];
  const unique = seen.map((id) => rows.find((r) => r.wa_id === id)!);
  await db.from("wa_participant").delete().eq("chat_id", chatId).not("wa_id", "in", `(${seen.map((s) => `"${s}"`).join(",")})`);
  await db.from("wa_participant").upsert(unique, { onConflict: "chat_id,wa_id" });
  await db
    .from("wa_group")
    // A good read clears an old error (team groups are never analyzed, so nothing else would).
    .update({ ...(d.subject ? { name: d.subject } : {}), size: unique.length, synced_at: now, left_at: null, last_error: null })
    .eq("chat_id", chatId);
}

/** Every group the bot is in: new ones added, ones it left marked, a few read now. */
async function syncAll(db: Db, cfg: Config, deadline: number) {
  const chats = await green<{ id?: string; name?: string; type?: string }[]>(cfg, "getChats");
  const groups = (Array.isArray(chats) ? chats : []).filter((c) => str(c.id).endsWith("@g.us"));
  const ids = groups.map((g) => str(g.id));
  const { data: known } = await db.from("wa_group").select("chat_id, left_at");
  const have = new Set((known ?? []).map((g) => g.chat_id));
  const fresh = groups.filter((g) => !have.has(str(g.id))).map((g) => ({ chat_id: str(g.id), name: str(g.name) || null }));
  if (fresh.length) await db.from("wa_group").insert(fresh);
  const gone = (known ?? []).filter((g) => !g.left_at && !ids.includes(g.chat_id)).map((g) => g.chat_id);
  if (gone.length) await db.from("wa_group").update({ left_at: iso() }).in("chat_id", gone);
  // Back in a group it had left.
  const back = (known ?? []).filter((g) => g.left_at && ids.includes(g.chat_id)).map((g) => g.chat_id);
  if (back.length) await db.from("wa_group").update({ left_at: null, synced_at: null }).in("chat_id", back);
  await db.from("watch_settings").update({ synced_at: iso() }).eq("id", 1);
  let read = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    try {
      await syncGroup(db, cfg, id);
      read++;
    } catch (e) {
      await db.from("wa_group").update({ last_error: (e as Error).message.slice(0, 300) }).eq("chat_id", id);
    }
  }
  return { groups: ids.length, read };
}

// ------------------------------------------------------------- the hook --

interface Hook {
  typeWebhook?: string;
  stateInstance?: string;
  instanceData?: { wid?: string };
  timestamp?: number;
  idMessage?: string;
  senderData?: { chatId?: string; chatName?: string; sender?: string; senderName?: string; senderContactName?: string; senderPhoneNumber?: string };
  messageData?: Record<string, any>;
}

/** The words of a message (captions for files), the message it replies to, or null to leave it out. */
function readMessage(md: Record<string, any> | undefined): { text: string; quoted: string | null } | null {
  const t = str(md?.typeMessage);
  const ext = md?.extendedTextMessageData ?? {};
  const file = md?.fileMessageData ?? {};
  const quoted = str(md?.quotedMessage?.stanzaId) || str(ext.stanzaId) || null;
  const media = (what: string) => {
    const cap = str(file.caption);
    return `[${what}${file.fileName && what === "document" ? `: ${str(file.fileName)}` : ""}]${cap ? ` ${cap}` : ""}`;
  };
  switch (t) {
    case "textMessage":
      return { text: str(md?.textMessageData?.textMessage), quoted };
    case "extendedTextMessage":
    case "quotedMessage":
      return { text: str(ext.text) || str(md?.textMessageData?.textMessage), quoted };
    case "editedMessage":
      return { text: `${str(md?.editedMessageData?.textMessage) || str(ext.text)} (edited)`, quoted };
    case "imageMessage":
      return { text: media("photo"), quoted };
    case "videoMessage":
      return { text: media("video"), quoted };
    case "documentMessage":
      return { text: media("document"), quoted };
    case "audioMessage":
      return { text: "[voice note]", quoted };
    case "stickerMessage":
      return { text: "[sticker]", quoted };
    case "locationMessage":
      return { text: "[location]", quoted };
    case "contactMessage":
    case "contactsArrayMessage":
      return { text: "[contact card]", quoted };
    case "pollMessage":
      return { text: `[poll] ${str(md?.pollMessageData?.name)}`, quoted };
    case "reactionMessage":
    case "deletedMessage":
    case "":
      return null;
    default:
      return { text: `[${t.replace(/Message$/, "")}]`, quoted };
  }
}

async function hook(req: Request, db: Db): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim() || new URL(req.url).searchParams.get("k") || "";
  if (!HOOK_TOKEN || !same(tok, HOOK_TOKEN)) return new Response("Forbidden", { status: 403 });
  const b = (await req.json().catch(() => null)) as Hook | null;
  if (!b) return json({ ok: true });
  const now = iso();
  const type = str(b.typeWebhook);
  const botPhone = phoneOf(b.instanceData?.wid);
  if (type === "stateInstanceChanged") {
    await db.from("watch_settings").update({ bot_state: str(b.stateInstance) || null, hook_at: now }).eq("id", 1);
    return json({ ok: true });
  }
  await db.from("watch_settings").update({ hook_at: now, ...(botPhone ? { bot_phone: botPhone } : {}) }).eq("id", 1);
  if (!["incomingMessageReceived", "outgoingMessageReceived", "outgoingAPIMessageReceived"].includes(type)) return json({ ok: true });

  const sd = b.senderData ?? {};
  const chatId = str(sd.chatId);
  if (!b.idMessage) return json({ ok: true });
  const m = readMessage(b.messageData);
  if (!m || !m.text) return json({ ok: true });
  // Private chats (dm.ts), kept for good. The person the bot asks answers it there (clients' details, OKs);
  // anyone else's new messages wait to be read, when answering is on.
  if (!chatId.endsWith("@g.us")) {
    if (!/@(c\.us|lid)$/.test(chatId)) return json({ ok: true });
    const mine = type.startsWith("outgoing");
    // WhatsApp may show the chat by lid, hiding the number: the one iklipse has for them.
    const lid = chatId.endsWith("@lid") ? chatId : null;
    const from = phoneOf(chatId) ?? (mine ? null : phoneOf(sd.sender) ?? phoneOf(sd.senderPhoneNumber)) ?? (lid ? await phoneOfLid(db, lid) : null);
    // Kept by number when it's known: the bot writes to them by number, and their answers land in the same chat.
    const chat = from ? `${from}@c.us` : chatId;
    const { data: st } = await db.from("watch_settings").select("ask_to, ask_phone, dm_enabled").eq("id", 1).single();
    const asks = !mine && !!from && st?.ask_to === "person" && st.ask_phone === from;
    // Someone the bot is following up an order with (orders.ts): their answer is for that first.
    const ordered = !mine && !!from && !!(await orderAt(db, `${from}@c.us`));
    await keepDm(db, {
      id: b.idMessage,
      chatId: chat,
      phone: from,
      name: mine ? null : str(sd.senderContactName) || str(sd.senderName) || null,
      fromBot: mine,
      text: m.text,
      quotedId: m.quoted,
      sentAt: iso(typeof b.timestamp === "number" ? b.timestamp * 1000 : Date.now()),
      read: !mine && !asks && !ordered && !!st?.dm_enabled,
    });
    // A file they sent: stored and read first (a voice note answering the bot is understood).
    const file = mine ? null : fileOf(b.messageData);
    const noted = !!file && (await noteFile(db, { id: b.idMessage, chatId: chat, ...file }));
    if (!mine && (from || noted)) {
      const id = b.idMessage;
      later(
        (async () => {
          let text = m.text;
          if (noted) {
            await keepFile(db, await settings(db), id);
            const { data: kept } = await db.from("wa_dm").select("text").eq("id", id).maybeSingle();
            text = str(kept?.text) || text;
          }
          if (from) await fromPrivate(db, { id, chatId: chat, raw: chat, text, quotedId: m.quoted, phone: from, asks });
        })(),
      );
    }
    return json({ ok: true });
  }
  const sender = str(sd.sender);
  // The sender's number: from their id, or the group member with that lid (looked up once, when needed).
  let found: Promise<string | null> | null = null;
  const senderPhone = () =>
    (found ??= (async () => {
      const phone = phoneOf(sender) ?? phoneOf(sd.senderPhoneNumber);
      if (phone || !sender.endsWith("@lid")) return phone;
      return await phoneOfLid(db, sender);
    })());

  // The team talking to the bot (orders.ts, 0093), in any group it's in: a mention is an order, a
  // question or a meeting (anyone in a team group; anyone on the team in a client group); a reply to
  // the bot's message about a meeting carries that on (book.ts).
  if (type === "incomingMessageReceived") {
    try {
      const ask = { id: b.idMessage, chatId, text: m.text, quotedId: m.quoted };
      const [{ data: st }, { data: gk }] = await Promise.all([
        db.from("watch_settings").select("bot_phone, alert_group").eq("id", 1).single(),
        db.from("wa_group").select("kind").eq("chat_id", chatId).maybeSingle(),
      ]);
      const teamGroup = gk?.kind === "team";
      // In a team group, no mention needed in the group the alerts go to, or in a reply to the bot.
      const toBot = async () =>
        (teamGroup && st?.alert_group === chatId) ||
        (teamGroup && !!m.quoted && !!(await db.from("wa_message").select("from_bot").eq("id", m.quoted).maybeSingle()).data?.from_bot) ||
        (await mentionsBot(db, m.text, botPhone ?? st?.bot_phone ?? null));
      const q = b.messageData?.quotedMessage ?? {};
      const quoted = str(q.textMessage) || str(q.caption) || null;
      let reported: Awaited<ReturnType<typeof orderOf>> = null;
      if ((await repliesToAsk(db, m.quoted)) || (await repliesToDraft(db, m.quoted))) {
        // A reply to the bot asking for clients' details (people.ts) or about a private chat (dm.ts).
        later(fromTeam(db, { ...ask, phone: await senderPhone(), lid: sender.endsWith("@lid") ? sender : null }));
      } else if (teamGroup && (reported = await orderOf(db, m.quoted, "report_ids"))) {
        // A reply to what the bot said about an order: for the person, or about it.
        const x = reported;
        later(followNow(db, x, { ...ask, phone: await senderPhone(), lid: sender.endsWith("@lid") ? sender : null }));
      } else {
        const asked = await heard(db, {
          id: b.idMessage,
          chatId,
          chatName: str(sd.chatName) || null,
          text: m.text,
          quoted,
          quotedId: m.quoted,
          sender,
          phone: senderPhone,
          botPhone,
        });
        if (asked) later(answerNow(db, b.idMessage));
        else if (await toBot()) {
          later(
            orderNow(db, {
              id: b.idMessage,
              chatId,
              where: teamGroup ? "team" : "client",
              text: m.text,
              quoted,
              phone: await senderPhone(),
              lid: sender.endsWith("@lid") ? sender : null,
              name: str(sd.senderContactName) || str(sd.senderName) || null,
            }),
          );
        }
      }
    } catch (e) {
      console.error("bot", (e as Error).message);
    }
  }

  const { data: on } = await db.from("watch_settings").select("enabled").eq("id", 1).single();
  if (!on?.enabled) return json({ ok: true });

  const { data: g } = await db.from("wa_group").select("chat_id, name, monitored, pending_since, left_at, kind").eq("chat_id", chatId).maybeSingle();
  if (!g) {
    await db.from("wa_group").insert({ chat_id: chatId, name: str(sd.chatName) || null });
  } else if (!g.monitored) {
    return json({ ok: true });
  } else if ((sd.chatName && sd.chatName !== g.name) || g.left_at) {
    await db.from("wa_group").update({ ...(sd.chatName ? { name: sd.chatName } : {}), left_at: null }).eq("chat_id", chatId);
  }

  const fromBot = type.startsWith("outgoing");
  let phone = await senderPhone();
  if (fromBot && !phone) phone = botPhone;
  const name = str(sd.senderContactName) || str(sd.senderName) || null;
  const sentAt = iso(typeof b.timestamp === "number" ? b.timestamp * 1000 : Date.now());

  await db.from("wa_message").upsert(
    { id: b.idMessage, chat_id: chatId, sender_id: sender || null, phone, sender_name: name, from_bot: fromBot, text: m.text.slice(0, 4000), quoted_id: m.quoted, sent_at: sentAt },
    { onConflict: "id", ignoreDuplicates: true },
  );
  // A file: stored, and what's in it read into the message (files.ts).
  const file = type === "outgoingAPIMessageReceived" ? null : fileOf(b.messageData);
  if (file && (await noteFile(db, { id: b.idMessage, chatId, ...file }))) later(readFileNow(db, b.idMessage));
  // A team group is kept, not read for alerts.
  await db.from("wa_group").update({ last_message_at: sentAt, ...(g?.pending_since || g?.kind === "team" ? {} : { pending_since: now }) }).eq("chat_id", chatId);
  // The name WhatsApp shows for this person, for the Groups list.
  if (name && sender) {
    await db.from("wa_participant").update({ name }).eq("chat_id", chatId).or(`wa_id.eq."${sender}",lid.eq."${sender}"${phone ? `,phone.eq.${phone}` : ""}`);
  }
  return json({ ok: true });
}

// --------------------------------------------------------------- Claude --

/** Read a group's new messages; open and close its alerts (chat.ts). */
async function analyze(db: Db, s: Settings, t: Team, chatId: string, send: Send) {
  const started = iso();
  const { data: g } = await db.from("wa_group").select("chat_id, name, analyzed_at, kind, bot_replies").eq("chat_id", chatId).single();
  if (!g) return { opened: 0, resolved: 0 };
  const { data: rows } = await db
    .from("wa_message")
    .select("id, sender_id, phone, sender_name, from_bot, text, quoted_id, sent_at, created_at")
    .eq("chat_id", chatId)
    .gte("sent_at", iso(Date.now() - WINDOW_DAYS * 24 * 60 * MIN))
    .order("sent_at", { ascending: false })
    .limit(WINDOW_MESSAGES);
  const msgs = (rows ?? []).reverse();
  const isNew = (m: { created_at: string }) => !g.analyzed_at || Date.parse(m.created_at) > Date.parse(g.analyzed_at);
  const done = async () => {
    // New messages that came in while reading wait for the next look.
    const { count } = await db.from("wa_message").select("id", { count: "exact", head: true }).eq("chat_id", chatId).gt("created_at", started);
    await db
      .from("wa_group")
      .update({ analyzed_at: started, last_error: null, ...(count ? {} : { pending_since: null }) })
      .eq("chat_id", chatId);
  };
  if (!msgs.some(isNew)) {
    await done();
    return { opened: 0, resolved: 0 };
  }

  const { data: parts } = await db.from("wa_participant").select("wa_id, phone, lid").eq("chat_id", chatId);
  const lidPhone = new Map<string, string>();
  for (const p of parts ?? []) if (p.lid && p.phone) lidPhone.set(p.lid, p.phone);
  const phoneOfMsg = (m: { phone: string | null; sender_id: string | null }) => m.phone ?? (m.sender_id ? lidPhone.get(m.sender_id) ?? null : null);

  // Who someone is: by their number, else (WhatsApp hides it) by their WhatsApp id.
  const whoOf = (phone: string | null, lid: string | null) => (phone ? t.byPhone.get(phone) : undefined) ?? (lid ? t.byLid.get(lid) : undefined);
  // The team in this group: members by their numbers, and anyone on the team who wrote here.
  const inGroup = new Map<string, Person>();
  for (const p of parts ?? []) {
    const who = whoOf(p.phone, p.lid ?? (String(p.wa_id).endsWith("@lid") ? p.wa_id : null));
    if (who?.active) inGroup.set(who.id, who);
  }
  for (const m of msgs) {
    const who = whoOf(phoneOfMsg(m), m.sender_id?.endsWith("@lid") ? m.sender_id : null);
    if (who?.active) inGroup.set(who.id, who);
  }

  // WhatsApp writes most mentions with the person's lid, not their number.
  const mention = (text: string) =>
    text.replace(/@(\d{8,15})\b/g, (all, d: string) => {
      const ph = lidPhone.get(`${d}@lid`) ?? d;
      if (ph === s.bot_phone) return "@iklipse";
      const who = t.byPhone.get(ph) ?? t.byLid.get(`${d}@lid`);
      return who ? `@${who.name}` : all;
    });
  const lines: ChatLine[] = msgs.map((m) => {
    const ph = phoneOfMsg(m);
    const who = whoOf(ph, m.sender_id?.endsWith("@lid") ? m.sender_id : null);
    return {
      id: m.id,
      sent_at: m.sent_at,
      isNew: isNew(m),
      team: !!(m.from_bot || who),
      bot: !!m.from_bot,
      name: m.from_bot ? "iklipse" : who?.name ?? (m.sender_name || (ph ? `+${ph}` : "Unknown")),
      replyTo: m.quoted_id,
      text: mention(m.text ?? ""),
    };
  });
  // Where the bot replies, a client asking for a meeting gets the booking link (0088).
  const link = g.bot_replies && g.kind === "client" && s.book_enabled ? await bookingLink(db, s).catch(() => null) : null;
  const r = await readChat(db, s, t, { source: "whatsapp", col: "chat_id", id: chatId, name: g.name ?? "Unnamed group" }, lines, inGroup, link ? { link, send } : undefined);
  await done();
  return r;
}

// ----------------------------------------------------------------- ring --

type Place = {
  wa_group?: { name: string | null; monitored?: boolean; kind?: string; bot_replies?: boolean; pending_since?: string | null } | null;
  slack_channel?: { name: string | null } | null;
};

/** Where an alert comes from, for people: the WhatsApp group, "#channel", or the email's subject. */
const placeOf = (a: Pick<Alert, "source" | "mail_subject"> & Place) =>
  a.source === "email" ? a.mail_subject || "(no subject)" : a.source === "slack" ? `#${a.slack_channel?.name ?? "channel"}` : a.wa_group?.name ?? null;

/** The sources switched on: only their alerts ring. */
const sourcesOn = (s: Settings) => [...(s.enabled ? ["whatsapp"] : []), ...(s.mail_enabled ? ["email"] : []), ...(s.slack_enabled ? ["slack"] : [])];

/** "Sara" from "Sara Ahmed (Acme)"; nothing from a number, a name in Arabic letters (the bot writes English) or "Unknown". */
function firstName(person: string | null) {
  const w = str(person).split(/[\s(,]+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z'.-]*$/.test(w) && !/^(unknown|client|someone|the)$/i.test(w) ? w : "";
}

/**
 * A client left waiting in a group where the bot replies (0087): it tells
 * them we'll get back to them, once, as a reply to their message. Outside
 * working hours (0089): as soon as the team is online.
 */
async function holdOn(db: Db, a: Alert & Place & { message_id: string | null }, send: Send, away = false) {
  const name = firstName(a.person);
  const text = away
    ? `Thanks${name ? ` ${name}` : ""}, we got your message. We'll get back to you as soon as the team is online.`
    : `Thanks${name ? ` ${name}` : ""}, we got your message and we'll get back to you shortly.`;
  let detail = `The bot told them: "${text}"`;
  try {
    await send(a.chat_id!, text, a.message_id);
  } catch (e) {
    detail = `The bot couldn't reply: ${(e as Error).message.slice(0, 200)}`;
  }
  await db.from("watch_alert").update({ held_at: iso() }).eq("id", a.id);
  await db.from("watch_event").insert({ alert_id: a.id, what: "held", detail });
}

/**
 * Outside working hours and on days off (0089): clients waiting in groups
 * where the bot replies are told at once the team will get back to them once
 * it's online. Their alerts ring when work starts (without the bot's usual words).
 */
async function holdOffHours(db: Db, send: Send, deadline: number) {
  const { data } = await db
    .from("watch_alert")
    .select("id, chat_id, kind, source, mail_subject, title, detail, person, priority, due_at, alerts_sent, snoozed_until, message_id, held_at, wa_group(name, monitored, kind, bot_replies, pending_since)")
    .eq("status", "open")
    .eq("kind", "unanswered")
    .eq("source", "whatsapp")
    .is("held_at", null)
    .order("created_at")
    .limit(20);
  let n = 0;
  for (const a of (data ?? []) as unknown as (Alert & Place & { message_id: string | null })[]) {
    if (Date.now() > deadline) break;
    const g = a.wa_group;
    if (!g?.bot_replies || g.kind !== "client" || g.monitored === false) continue;
    // Claude hasn't read the newest messages yet (the team may have answered): next minute.
    if (g.pending_since && Date.now() - Date.parse(g.pending_since) < 10 * MIN) continue;
    await holdOn(db, a, send, true);
    n++;
  }
  return n;
}

/** Where alerts are posted too (0090): the team group picked in Settings, while it's still a team group. */
async function alertPlace(db: Db, s: Settings) {
  if (!s.alert_group) return null;
  const { data: g } = await db.from("wa_group").select("kind, left_at").eq("chat_id", s.alert_group).maybeSingle();
  return g?.kind === "team" && !g.left_at ? s.alert_group : null;
}

/** An alert as the team group sees it. */
/** "2 hours 40 minutes", "1 hour", "25 minutes", "1 day 3 hours". */
function lasting(ms: number) {
  const m = Math.max(1, Math.round(ms / MIN));
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const [d, h, mm] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60];
  if (d) return [part(d, "day"), h ? part(h, "hour") : ""].filter(Boolean).join(" ");
  return [h ? part(h, "hour") : "", mm ? part(mm, "minute") : ""].filter(Boolean).join(" ");
}

const hourKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const LINE = "------------------------";

/**
 * Every 2 hours in working hours (on the even hour, Cairo time): the open group
 * and Slack alerts in one message to the team group picked in Settings, or that
 * there are none. Email alerts stay with the mailbox owner.
 */
async function digest(db: Db, s: Settings, send: Send) {
  const postTo = await alertPlace(db, s);
  if (!postTo) return false;
  const parts = Object.fromEntries(hourKey.formatToParts(new Date()).map((x) => [x.type, x.value]));
  if (Number(parts.hour) % 2 || Number(parts.minute) >= 15) return false;
  if (!(await firstTime(db, `digest:${parts.year}-${parts.month}-${parts.day}T${parts.hour}`))) return false;

  const { data } = await db
    .from("watch_alert")
    .select("id, chat_id, kind, source, mail_subject, title, detail, person, due_at, message_id, created_at, wa_group(name), slack_channel(name)")
    .eq("status", "open")
    .in("source", sourcesOn(s).filter((x) => x !== "email"))
    .order("created_at")
    .limit(30);
  const open = (data ?? []) as unknown as (Alert & Place & { message_id: string | null; created_at: string })[];
  if (!open.length) {
    await send(postTo, "No open alerts right now.");
    return true;
  }
  // Waiting since the client's message, when it's known.
  const ids = open.map((a) => a.message_id).filter((x): x is string => !!x);
  const { data: ms } = ids.length ? await db.from("wa_message").select("id, sent_at").in("id", ids) : { data: [] };
  const sent = new Map(((ms ?? []) as { id: string; sent_at: string }[]).map((x) => [x.id, Date.parse(x.sent_at)]));
  const now = Date.now();
  const items = open
    .sort((a, b) => (placeOf(a) ?? "").localeCompare(placeOf(b) ?? ""))
    .map((a) => {
      const since = (a.message_id && sent.get(a.message_id)) || Date.parse(a.created_at);
      const due = Date.parse(a.due_at);
      const when =
        a.kind === "unanswered" || a.kind === "follow_up"
          ? `Waiting ${lasting(now - since)}`
          : due > now
            ? `Due in ${lasting(due - now)}`
            : `Overdue by ${lasting(now - due)}`;
      return [`*${placeOf(a) ?? "A group"}*`, a.detail || a.title, when].join("\n");
    });
  await send(postTo, [`*Open alerts: ${open.length}*`, ...items].join(`\n${LINE}\n`));
  return true;
}

/** Due alerts: a notification to each person on them, and the next one set. */
async function ring(db: Db, s: Settings, t: Team, deadline: number, send: Send) {
  const now = Date.now();
  const { data: due } = await db
    .from("watch_alert")
    .select(
      "id, chat_id, kind, source, mail_subject, title, detail, person, priority, due_at, alerts_sent, snoozed_until, message_id, held_at, wa_group(name, monitored, kind, bot_replies, pending_since), slack_channel(name)",
    )
    .eq("status", "open")
    .in("source", sourcesOn(s))
    .lte("next_alert_at", iso(now))
    .order("next_alert_at")
    .limit(40);
  let rang = 0;
  for (const a of (due ?? []) as unknown as (Alert & Place & { message_id: string | null; held_at: string | null })[]) {
    if (Date.now() > deadline) break;
    if (a.snoozed_until && Date.parse(a.snoozed_until) > now) continue;
    // A client still waiting in a group where the bot replies: it answers first.
    const g = a.wa_group;
    if (a.kind === "unanswered" && a.source === "whatsapp" && !a.held_at && g?.bot_replies && g.kind === "client" && g.monitored !== false) {
      // Claude hasn't read the newest messages yet (the team may have answered): next minute.
      // Still unread after 10 minutes (Claude failing): it rings without the bot's reply.
      if (g.pending_since && now - Date.parse(g.pending_since) < 10 * MIN) continue;
      if (!g.pending_since) await holdOn(db, a, send);
    }
    // Waiting on them: their own reminders (how many, how far apart), never a call.
    const follow = a.kind === "follow_up";
    // A deadline: its own pace until the deadline, then like any alert.
    const due = Date.parse(a.due_at);
    const early = a.kind === "deadline" && now < due;
    if ((follow && !s.follow_enabled) || (a.kind === "deadline" && !s.deadline_enabled)) {
      await db.from("watch_alert").update({ next_alert_at: null, updated_at: iso() }).eq("id", a.id);
      continue;
    }
    if (!follow && !early && s.stop_after_hours > 0 && now - Date.parse(a.due_at) > s.stop_after_hours * 60 * MIN) {
      await closeAlert(db, a.id, "stopped", `Stopped by itself after ${s.stop_after_hours} hour${s.stop_after_hours === 1 ? "" : "s"}`, null);
      continue;
    }
    const { data: rec } = await db.from("watch_recipient").select("user_id").eq("alert_id", a.id);
    const people = (rec ?? []).map((r) => t.people.get(r.user_id)).filter((p): p is Person => !!p?.active);
    const n = a.alerts_sent + 1;
    // One notification per person per alert: the newest ring replaces the last.
    await db.from("notification").delete().eq("kind", "watch_alert").eq("data->>alert_id", a.id);
    if (people.length) {
      await db.from("notification").insert(
        people.map((p) => ({
          user_id: p.id,
          kind: "watch_alert",
          data: { alert_id: a.id, title: a.title, detail: a.detail, group: placeOf(a), source: a.source, alert_kind: a.kind, priority: a.priority, count: n },
        })),
      );
    }
    // The last reminder of a follow-up: it stays open, quietly, until it's dealt with.
    const last = follow && n >= s.follow_alerts;
    const next = last
      ? null
      : early
        ? iso(Math.min(Date.now() + s.deadline_every_min * MIN, due))
        : iso(Date.now() + (follow ? s.follow_every_min : s.repeat_every_min) * MIN);
    await db.from("watch_alert").update({ alerts_sent: n, last_alert_at: iso(), next_alert_at: next, updated_at: iso() }).eq("id", a.id);
    await db.from("watch_event").insert({
      alert_id: a.id,
      what: "alert",
      detail: `${follow || early ? "Reminder" : "Alert"} ${n}${follow ? ` of ${s.follow_alerts}` : ""}${early ? ` before the deadline` : ""} to ${people.map((p) => p.name).join(", ") || "nobody active"}`,
    });
    // Enough alerts with nobody acting: Ikli starts calling.
    if (s.calls_enabled && !follow && !early && n >= s.alerts_before_call) {
      await db.from("watch_recipient").update({ next_call_at: iso() }).eq("alert_id", a.id).is("next_call_at", null).eq("calling", false).eq("calls", 0);
    }
    rang++;
  }
  return rang;
}

// ---------------------------------------------------------------- calls --
// Calls happen inside iklipse (0068): a ringing call screen when the app is
// open, a push "Ikli is calling you" when it isn't. Answering plays what Ikli
// says (Claude's words, the voice agent's ElevenLabs voice).

/** A call rings this long; then it's missed and rings again after call_retry_min. */
const RING_MS = 55_000;
/** While it rings, the phone's notification rings again at these moments. */
const RING_AGAIN_MS = [18_000, 36_000];

let signKey: Promise<CryptoKey> | null = null;
/** The token in a call's Decline link: only this function can make one. */
async function sign(callId: string) {
  signKey ??= crypto.subtle.importKey("raw", new TextEncoder().encode(`watch-call:${TICK_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signKey, new TextEncoder().encode(callId)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runs after the response is sent. */
function later(job: Promise<unknown>) {
  const p = job.catch((e) => console.error("later", (e as Error).message));
  (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(p);
}

// -------------------------------------------------------------- meetings --

/** Answers an admin talking to the bot about a meeting, in a group or privately (book.ts). */
async function answerNow(db: Db, id: string) {
  const [s, cfg] = await Promise.all([settings(db), config(db)]);
  await answer(db, s, id, sendAs(cfg));
}

/**
 * Someone writing to the bot privately: someone answering it about an order
 * (orders.ts), someone on the team answering it about a meeting (book.ts), or
 * the person the bot asks answering that (fromTeam). A reply to one of its
 * messages is about that one; else whichever the bot wrote about last.
 */
async function fromPrivate(db: Db, o: { id: string; chatId: string; raw: string; text: string; quotedId: string | null; phone: string; asks: boolean }) {
  const meeting = async () => {
    if (await heardPrivate(db, o)) await answerNow(db, o.id);
  };
  if (o.quotedId) {
    if (await orderOf(db, o.quotedId, "sent_ids")) return await fromTargetNow(db, o);
    // What the bot said about an order given privately (0093): the reply is about it.
    const reported = await orderOf(db, o.quotedId, "report_ids");
    if (reported) return await followNow(db, reported, o);
    if (await bookTurnAt(db, o.chatId, o.quotedId)) return await meeting();
    if (o.asks && ((await repliesToAsk(db, o.quotedId)) || (await repliesToDraft(db, o.quotedId)))) return await fromTeam(db, o);
  }
  const [book, order, a, d] = await Promise.all([
    bookTurnAt(db, o.chatId, null),
    orderAt(db, o.chatId),
    o.asks ? db.from("bot_ask_message").select("sent_at").eq("chat_id", o.chatId).order("sent_at", { ascending: false }).limit(1) : null,
    o.asks ? db.from("bot_draft").select("created_at").eq("ask_chat", o.chatId).eq("status", "waiting").order("created_at", { ascending: false }).limit(1) : null,
  ]);
  const ask = [a?.data?.[0]?.sent_at, d?.data?.[0]?.created_at].filter(Boolean).map((x) => Date.parse(x as string));
  const at = { book: book ? Date.parse(book) : 0, order: order ? Date.parse(order) : 0, ask: o.asks ? Math.max(1, ...ask) : 0 };
  // Someone on the team (0093): an order, a question, a meeting, or their answer about what they were
  // asked to do (orders.ts reads which). Unless it answers what the bot just asked the team (details, an OK).
  const me = (await team(db)).byPhone.get(o.phone);
  if (me?.active) {
    const asked = ask.length ? Math.max(...ask) : 0;
    // What isn't an answer to that (a question, an order) is read like any other message from the team.
    if (o.asks && asked && asked >= Math.max(at.book, at.order) && Date.now() - asked < 6 * 60 * MIN && (await fromTeam(db, o))) return;
    return await orderNow(db, { id: o.id, chatId: o.chatId, where: "private", text: o.text, quoted: null, phone: o.phone, lid: null, name: me.name });
  }
  const latest = Math.max(at.book, at.order, at.ask);
  if (!latest) return;
  if (latest === at.order) return await fromTargetNow(db, o);
  if (latest === at.book) return await meeting();
  await fromTeam(db, o);
}

/** Someone answering the bot about an order; anything else they say is read like any private message. */
async function fromTargetNow(db: Db, o: { id: string; chatId: string; raw: string; text: string; quotedId: string | null; asks: boolean }) {
  const [s, cfg] = await Promise.all([settings(db), config(db)]);
  if (await fromTarget(db, s, sendAs(cfg), o)) return;
  if (o.asks) return await fromTeam(db, o);
  if (s.dm_enabled) await db.from("wa_dm_chat").update({ pending_since: iso() }).eq("chat_id", o.raw).is("pending_since", null);
}

/** The team talking to the bot: in a group by mention, or privately (orders.ts). */
async function orderNow(
  db: Db,
  o: { id: string; chatId: string; where: "team" | "client" | "private"; text: string; quoted: string | null; phone: string | null; lid: string | null; name: string | null },
) {
  const [s, cfg, t] = await Promise.all([settings(db), config(db), team(db)]);
  await takeOrder(db, s, t, sendAs(cfg), o, (id) => answerNow(db, id));
}

/** The team replying to what the bot said about an order. */
async function followNow(db: Db, x: NonNullable<Awaited<ReturnType<typeof orderOf>>>, o: { id: string; chatId: string; text: string; phone?: string | null; lid?: string | null }) {
  const [s, cfg] = await Promise.all([settings(db), config(db)]);
  const order = (text: string) =>
    orderNow(db, { id: o.id, chatId: o.chatId, where: o.chatId.endsWith("@g.us") ? "team" : "private", text, quoted: null, phone: o.phone ?? phoneOf(o.chatId), lid: o.lid ?? null, name: null });
  await followOrder(db, s, sendAs(cfg), x, o, order);
}

/** A file someone sent in a group: stored and read (files.ts). */
async function readFileNow(db: Db, id: string) {
  await keepFile(db, await settings(db), id);
}

// ---------------------------------------------------------------- people --

/** The bot writes in a chat (a group, or someone's private chat), as a reply when quotedId is given. */
const sendAs =
  (cfg: Config): Send =>
  async (chatId, text, quotedId) => {
    const r = await green<{ idMessage?: string }>(cfg, "sendMessage", { chatId, message: text, ...(quotedId ? { quotedMessageId: quotedId } : {}), linkPreview: false });
    return r.idMessage ?? null;
  };

/**
 * The team answering the bot where it asks, once per message: an OK for a
 * reply (dm.ts), else clients' details (people.ts). With no reply to one of
 * its messages (the private chat), it's about whichever the bot asked last.
 * false: it wasn't an answer to either.
 */
async function fromTeam(db: Db, o: { id: string; chatId: string; text: string; quotedId: string | null; phone?: string | null; lid?: string | null }) {
  if (!(await firstTime(db, o.id))) return true;
  const [s, cfg, t] = await Promise.all([settings(db), config(db), team(db)]);
  const send = sendAs(cfg);
  const d = await draftFor(db, o.chatId, o.quotedId);
  if (d) {
    const askedSince = o.quotedId
      ? null
      : (await db.from("bot_ask_message").select("id").eq("chat_id", o.chatId).gt("sent_at", d.created_at).limit(1)).data?.[0];
    if (!askedSince) {
      // "Book it", "send him the link": carried out like any order from them (orders.ts).
      const order = (text: string) =>
        orderNow(db, {
          id: o.id,
          chatId: o.chatId,
          where: o.chatId.endsWith("@g.us") ? "team" : "private",
          text,
          quoted: null,
          phone: o.phone ?? phoneOf(o.chatId),
          lid: o.lid ?? null,
          name: null,
        });
      if (await decideDraft(db, s, d, o, send, order)) return true;
      if (o.quotedId) {
        await send(o.chatId, `What should I tell ${d.to_name ?? "them"}, or do? ${d.draft ? "OK sends my reply. " : ""}"No" leaves it.`, o.id);
        return true;
      }
    }
  }
  return (await takeAnswer(db, s, t, o, send)) || !!o.quotedId;
}

/** The phone's "Ikli is calling you" notification, with Answer and Decline. */
async function callPush(userId: string, callId: string, alert: { id: string; title: string; group: string | null } | null, appUrl: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Iklipse-Secret": PUSH_SECRET },
    body: JSON.stringify({
      user_id: userId,
      product: "mail",
      title: "Ikli is calling you",
      body: alert ? [alert.title, alert.group].filter(Boolean).join("\n") : "Test call",
      url: `${appUrl}/#/alerts?call=${callId}`,
      tag: `watch-call-${alert?.id ?? callId}`,
      call: { id: callId, decline: `${BASE}/decline?c=${callId}&s=${await sign(callId)}` },
    }),
  });
  if (!res.ok) console.error("call push", res.status, (await res.text()).slice(0, 200));
}

/** Rings the phone now and again while the call rings (after the response, too). */
function ringPhone(db: Db, userId: string, callId: string, alert: { id: string; title: string; group: string | null } | null, appUrl: string) {
  const started = Date.now();
  const job = (async () => {
    // The Android app rings like a phone call; the web's notification is for phones without it.
    const call = { type: "call", call: callId, sig: await sign(callId), title: alert?.title ?? "Test call", group: alert?.group ?? "", ms: String(RING_MS) };
    if (await toPhones(db, userId, call, Math.round(RING_MS / 1000))) return;
    await callPush(userId, callId, alert, appUrl);
    for (const at of RING_AGAIN_MS) {
      await new Promise((r) => setTimeout(r, Math.max(0, started + at - Date.now())));
      const { data } = await db.from("watch_call").select("status").eq("id", callId).single();
      if (data?.status !== "ringing") return;
      await callPush(userId, callId, alert, appUrl);
    }
  })();
  later(job);
}

// ---------------------------------------------------------- android app --
// The iklipse Android app (android/, 0071). A phone links to a person with a
// code from Alerts > My phone, then gets calls through Firebase: "call" rings,
// "hush" stops the ringing (answered or declined elsewhere, or missed).

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (t: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))));
const isId = (v: string) => /^[0-9a-f-]{36}$/.test(v);

/** Stops a call ringing on the person's phones. */
const hush = (db: Db, userId: string, callId: string) => toPhones(db, userId, { type: "hush", call: callId }, 60);

/** The app links a phone with the code from Alerts > My phone. */
async function pairPhone(req: Request, db: Db) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = str(b.code).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const token = str(b.token);
  if (code.length !== 8) throw new HttpError(400, "The code has 8 letters and numbers");
  if (token.length < 20 || token.length > 4096) throw new HttpError(400, "This phone has no Firebase token yet. Try again in a moment.");
  const { data: p } = await db
    .from("native_pair")
    .update({ used_at: iso() })
    .eq("code", code)
    .is("used_at", null)
    .gt("created_at", iso(Date.now() - 10 * MIN))
    .select("user_id")
    .maybeSingle();
  if (!p) throw new HttpError(404, "That code is wrong or expired. Get a new one in iklipse.");
  const { data: who } = await db.from("profile").select("display_name, is_active").eq("id", p.user_id).single();
  if (!who?.is_active) throw new HttpError(403, "This account is turned off");
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  const { data: d, error } = await db
    .from("native_device")
    .upsert(
      {
        user_id: p.user_id,
        token,
        key_hash: await sha256(key),
        device: str(b.device).slice(0, 80) || null,
        app_version: str(b.version).slice(0, 20) || null,
        created_at: iso(),
        last_seen_at: iso(),
      },
      { onConflict: "token" },
    )
    .select("id")
    .single();
  if (error || !d) throw new Error(error?.message ?? "Couldn't link this phone");
  return json({ id: d.id, key, name: who.display_name, user: p.user_id });
}

/** The app checks in: its new Firebase token and version, or it learns it was unlinked. */
async function phoneCheckIn(req: Request, db: Db) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(b.id);
  const key = str(b.key);
  if (!isId(id) || !key) throw new HttpError(400, "Bad request");
  const { data: d } = await db.from("native_device").select("key_hash, user_id, profile(display_name)").eq("id", id).maybeSingle();
  if (!d || !same(d.key_hash as string, await sha256(key))) throw new HttpError(404, "This phone isn't linked");
  const token = str(b.token);
  const version = str(b.version).slice(0, 20);
  await db
    .from("native_device")
    .update({ last_seen_at: iso(), ...(token.length >= 20 && token.length <= 4096 ? { token } : {}), ...(version ? { app_version: version } : {}) })
    .eq("id", id);
  // A newer app (0072): a link to it, for this linked phone only.
  let update: { code: number; name: string; url: string } | null = null;
  const code = Number(b.code ?? 0);
  const { data: rel } = await db.from("app_release").select("code, name, file").eq("platform", "android").maybeSingle();
  if (rel && code > 0 && rel.code > code) {
    const { data: u } = await db.storage.from("apps").createSignedUrl(rel.file, 30 * 60, { download: "iklipse.apk" });
    if (u?.signedUrl) update = { code: rel.code, name: rel.name, url: u.signedUrl };
  }
  return json({ name: (d.profile as unknown as { display_name: string } | null)?.display_name ?? null, user: d.user_id, update });
}

/** Signed out in the app: this phone stops getting that person's calls and notifications. */
async function unpairPhone(req: Request, db: Db) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(b.id);
  const key = str(b.key);
  if (!isId(id) || !key) throw new HttpError(400, "Bad request");
  const { data: d } = await db.from("native_device").select("key_hash").eq("id", id).maybeSingle();
  if (d && same(d.key_hash as string, await sha256(key))) await db.from("native_device").delete().eq("id", id);
  return json({ ok: true });
}

/** The app's buttons on a call: answer (the words and a link to the voice), decline, end, handled, snooze, state. */
async function phoneAct(req: Request, db: Db) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const callId = str(b.call);
  const act = str(b.act);
  if (!isId(callId) || !same(str(b.sig), await sign(callId))) return new Response("Forbidden", { status: 403 });
  if (!["answer", "decline", "end", "handled", "snooze", "state"].includes(act)) throw new HttpError(400, "Unknown action");
  const { data, error } = await db.rpc("_watch_call_act", { p_call: callId, p_act: act });
  if (error) throw new HttpError(409, error.message);
  const out = { ...(data as Record<string, unknown>) };
  // Its voice; the app asks for it while it rings too (voice: true), so Ikli speaks the moment it's answered.
  if ((act === "answer" || (act === "state" && b.voice === true)) && typeof out.audio === "string") {
    const { data: u } = await db.storage.from(BUCKET).createSignedUrl(out.audio, 15 * 60);
    out.audio = u?.signedUrl ?? null;
  } else delete out.audio;
  // Answered or declined on this phone: the person's other phones stop ringing.
  if (act === "answer" || act === "decline") {
    const { data: c } = await db.from("watch_call").select("user_id").eq("id", callId).single();
    if (c?.user_id) later(hush(db, c.user_id, callId));
  }
  return json(out);
}

async function speak(text: string): Promise<Uint8Array> {
  if (!ELEVEN_KEY) throw new Error("ELEVEN_API_KEY isn't set on the whatsapp-bot function");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: VOICE_MODEL,
      language_code: "en",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.9 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs: ${(await res.text()).slice(0, 160) || res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const KIND_WORDS: Record<Alert["kind"], string> = {
  unanswered: "a client is waiting for a reply",
  promise: "a promise made to a client is due",
  follow_up: "something a client said they would send hasn't come yet",
  deadline: "a delivery the team promised a client is due",
  ads: "an ad platform says an ad account needs something done",
};

/** What the call says: Claude writes it from the alert; a plain sentence if Claude can't. */
async function callWords(s: Settings, a: Alert, group: string | null, name: string): Promise<string> {
  const first = name.split(/\s+/)[0];
  const email = a.source === "email";
  const slack = a.source === "slack";
  const waits = a.kind === "unanswered" || a.kind === "ads";
  const waiting = spokenSpan(Date.now() - Date.parse(waits ? a.created_at : a.due_at));
  const fallback = `Hi ${first}. ${a.title}${group ? ` ${email ? "in the email" : "in"} ${group}` : ""}, for ${waiting} now. Please take care of it, and tap Handled when it's done.`;
  try {
    const text = await claude(
      s.model,
      `You write what Ikli, iklipse's alert assistant, says when it calls someone on the iklipse team inside the iklipse app. Spoken, short and clear: at most 3 short sentences, about 35 words. Start with a short warm greeting by first name, then go straight to why you're calling. Don't introduce yourself: never say your name, "Ikli", "iklipse" or who is calling. Say why you're calling: what needs doing, who it's about, where (the WhatsApp group, the Slack channel, or the email by its subject, said naturally), and how long it has been waiting or how late it is. End by asking them to tap Handled once it's done. No emojis, lists, links, phone numbers, email addresses or em dashes. Write in English only, even when the chat or the email is in Arabic. Reply with the words only.`,
      JSON.stringify({
        name: first,
        what: KIND_WORDS[a.kind],
        title: a.title,
        detail: a.detail,
        about: a.person,
        ...(email ? { email_subject: group } : slack ? { slack_channel: group } : { whatsapp_group: group }),
        [waits ? "waiting_for" : "due"]: waits ? waiting : cairoSpoken.format(new Date(a.due_at)),
        times_alerted: a.alerts_sent,
        priority: a.priority,
      }),
      undefined,
      300,
    );
    return str(text).replace(/[—–]/g, ", ") || fallback;
  } catch (e) {
    console.error("call words", (e as Error).message);
    return fallback;
  }
}

/** Ring a person: the words, the voice kept for the call, the call, a push. */
async function startCall(db: Db, s: Settings, cfg: Config, o: { alert?: Alert & { group: string | null }; person: Person; test?: boolean }) {
  const first = o.person.name.split(/\s+/)[0];
  const words = o.test
    ? `Hi ${first}. This is a test call from Alerts. If you can hear me, calls work.`
    : await callWords(s, o.alert!, o.alert!.group, o.person.name);
  const { data: call, error } = await db
    .from("watch_call")
    .insert({ alert_id: o.alert?.id ?? null, user_id: o.person.id, words })
    .select("id")
    .single();
  if (error || !call) throw new Error(error?.message ?? "Couldn't start the call");
  // No voice (ElevenLabs down): the call still rings and shows the words.
  try {
    const path = `${call.id}.mp3`;
    const up = await db.storage.from(BUCKET).upload(path, await speak(words), { contentType: "audio/mpeg", upsert: true });
    if (up.error) throw new Error(up.error.message);
    await db.from("watch_call").update({ audio: path }).eq("id", call.id);
  } catch (e) {
    await db.from("watch_call").update({ error: (e as Error).message.slice(0, 300) }).eq("id", call.id);
  }
  if (o.alert) {
    const { data: r } = await db.from("watch_recipient").select("calls").eq("alert_id", o.alert.id).eq("user_id", o.person.id).single();
    await db
      .from("watch_recipient")
      .update({ calling: true, calls: (r?.calls ?? 0) + 1, last_call_at: iso(), next_call_at: null })
      .eq("alert_id", o.alert.id)
      .eq("user_id", o.person.id);
    await db.from("watch_alert").update({ calls_made: o.alert.calls_made + 1, updated_at: iso() }).eq("id", o.alert.id);
    await db.from("watch_event").insert({ alert_id: o.alert.id, what: "call", detail: `Calling ${o.person.name}`, user_id: o.person.id });
  }
  // The phone rings even with the app closed: a notification with Answer / Decline, again while it rings.
  ringPhone(db, o.person.id, call.id, o.alert ? { id: o.alert.id, title: o.alert.title, group: o.alert.group } : null, cfg.app_url ?? "");
  return call.id as string;
}

/** People due a call: ring them (a few at a time). */
async function callDue(db: Db, s: Settings, cfg: Config, t: Team, deadline: number) {
  if (!s.calls_enabled) return 0;
  const { data: due } = await db
    .from("watch_recipient")
    .select("alert_id, user_id, calls, watch_alert!inner(id, chat_id, kind, source, mail_subject, title, detail, person, priority, status, due_at, alerts_sent, calls_made, snoozed_until, created_at, wa_group(name), slack_channel(name))")
    .lte("next_call_at", iso())
    .eq("calling", false)
    .eq("watch_alert.status", "open")
    .in("watch_alert.source", sourcesOn(s))
    .order("next_call_at")
    .limit(8);
  let placed = 0;
  for (const r of (due ?? []) as unknown as { alert_id: string; user_id: string; calls: number; watch_alert: Alert & Place }[]) {
    if (Date.now() > deadline) break;
    const a = r.watch_alert;
    if (a.snoozed_until && Date.parse(a.snoozed_until) > Date.now()) continue;
    const person = t.people.get(r.user_id);
    if (!person?.active || (s.max_calls > 0 && r.calls >= s.max_calls)) {
      await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", r.alert_id).eq("user_id", r.user_id);
      continue;
    }
    try {
      await startCall(db, s, cfg, { alert: { ...a, group: placeOf(a) }, person });
      placed++;
    } catch (e) {
      console.error("call", (e as Error).message);
      await db
        .from("watch_recipient")
        .update({ next_call_at: iso(Date.now() + s.call_retry_min * MIN) })
        .eq("alert_id", r.alert_id)
        .eq("user_id", r.user_id);
    }
  }
  return placed;
}

/** Calls nobody answered within RING_MS are missed: they ring again after call_retry_min. Old voices go. */
async function sweepCalls(db: Db, s: Settings) {
  const { data: missed } = await db
    .from("watch_call")
    .update({ status: "missed", ended_at: iso() })
    .eq("status", "ringing")
    .lt("started_at", iso(Date.now() - RING_MS))
    .select("id, alert_id, user_id");
  for (const c of missed ?? []) {
    if (c.user_id) later(hush(db, c.user_id, c.id));
    if (!c.alert_id || !c.user_id) continue;
    const { data: a } = await db.from("watch_alert").select("status").eq("id", c.alert_id).single();
    await db
      .from("watch_recipient")
      .update({ calling: false, next_call_at: a?.status === "open" ? iso(Date.now() + s.call_retry_min * MIN) : null })
      .eq("alert_id", c.alert_id)
      .eq("user_id", c.user_id)
      .eq("calling", true);
    const { data: p } = await db.from("profile").select("display_name").eq("id", c.user_id).single();
    await db.from("watch_event").insert({ alert_id: c.alert_id, what: "no_answer", detail: `${p?.display_name ?? "They"} didn't answer`, user_id: c.user_id });
  }
  const { data: old } = await db.from("watch_call").select("id, audio").not("audio", "is", null).lt("started_at", iso(Date.now() - 2 * 60 * MIN)).limit(50);
  if (old?.length) {
    await db.storage.from(BUCKET).remove(old.map((c) => c.audio as string));
    await db.from("watch_call").update({ audio: null }).in("id", old.map((c) => c.id));
  }
}

/** Decline on the call's notification: rings again after call_retry_min. */
async function declineFromPhone(req: Request, db: Db) {
  const u = new URL(req.url);
  const callId = u.searchParams.get("c") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(callId) || !same(u.searchParams.get("s") ?? "", await sign(callId))) return new Response("Forbidden", { status: 403 });
  const { data: c } = await db
    .from("watch_call")
    .update({ status: "declined", ended_at: iso() })
    .eq("id", callId)
    .eq("status", "ringing")
    .select("alert_id, user_id")
    .maybeSingle();
  if (c?.user_id) later(hush(db, c.user_id, callId));
  if (c?.alert_id && c.user_id) {
    const s = await settings(db);
    const { data: a } = await db.from("watch_alert").select("status").eq("id", c.alert_id).single();
    await db
      .from("watch_recipient")
      .update({ calling: false, next_call_at: a?.status === "open" ? iso(Date.now() + s.call_retry_min * MIN) : null })
      .eq("alert_id", c.alert_id)
      .eq("user_id", c.user_id);
    const { data: p } = await db.from("profile").select("display_name").eq("id", c.user_id).single();
    await db.from("watch_event").insert({ alert_id: c.alert_id, what: "declined", detail: `${p?.display_name ?? "They"} declined the call`, user_id: c.user_id });
  }
  return json({ ok: true });
}

// ----------------------------------------------------------------- tick --

async function tick(db: Db) {
  const t0 = Date.now();
  const deadline = t0 + RUN_MS;
  const s = await settings(db);
  if (!s.enabled && !s.mail_enabled && !s.slack_enabled) return { off: true };
  // One run at a time (a slow one can outlast the minute).
  const { data: lock } = await db
    .from("watch_settings")
    .update({ tick_lock: iso() })
    .eq("id", 1)
    .or(`tick_lock.is.null,tick_lock.lt."${iso(Date.now() - 3 * MIN)}"`)
    .select("id");
  if (!lock?.length) return { busy: true };
  const out = { synced: 0, analyzed: 0, opened: 0, resolved: 0, clients: 0, asked: 0, dms: 0, rang: 0, calls: 0, booked: 0, told: 0, reminded: 0, links: 0, held: 0, orders: 0, files: 0, mail: null as unknown, slack: null as unknown, errors: [] as string[] };
  try {
    const cfg = await config(db);
    const t = await team(db);
    // Admins' messages to the bot still waiting for an answer (book.ts); meetings told and reminded (meetings.ts).
    try {
      out.booked = await leftovers(db, s, sendAs(cfg), deadline - 60_000);
      if (s.book_enabled) {
        // Bookings from the links: told about (when that's on), and booking links followed up closed (orders.ts).
        await pollCalendly(db, deadline - 70_000, s.meet_tell);
        out.links = await bookedOrders(db, sendAs(cfg));
        if (s.meet_tell) {
          out.told = await tellNew(db, sendAs(cfg), s.bot_phone, deadline - 60_000);
          out.reminded = await remindSoon(db, sendAs(cfg), s.bot_phone, deadline - 60_000);
          out.told += await tellCancelled(db, sendAs(cfg), s.bot_phone, deadline - 60_000);
        }
      }
    } catch (e) {
      out.errors.push(`meetings: ${(e as Error).message}`);
    }
    if (s.enabled) await whatsappTick(db, s, cfg, t, deadline, out);
    // The team's email (mail.ts): what changed in each mailbox, then Claude reads it.
    if (s.mail_enabled) {
      try {
        out.mail = await watchMail(db, s, t, deadline - 30_000);
      } catch (e) {
        out.errors.push(`email: ${(e as Error).message}`);
      }
    }
    // The Slack channels (slack.ts), the same way as the groups.
    if (s.slack_enabled) {
      try {
        out.slack = await watchSlack(db, s, t, cfg.slack_bot_token, deadline - 30_000);
      } catch (e) {
        out.errors.push(`slack: ${(e as Error).message}`);
      }
    }

    // Outside working hours and on days off nothing rings (alerts wait for work to start);
    // clients waiting where the bot replies hear the team will get back to them.
    if (!quietNow(s) && !dayOff(s)) {
      out.rang = await ring(db, s, t, deadline, sendAs(cfg));
      await digest(db, s, sendAs(cfg)).catch((e) => out.errors.push(`digest: ${(e as Error).message}`));
      await sweepCalls(db, s);
      out.calls = await callDue(db, s, cfg, t, deadline);
    } else if (s.enabled) {
      out.held = await holdOffHours(db, sendAs(cfg), deadline);
    }
  } finally {
    await db.from("watch_settings").update({ tick_lock: null }).eq("id", 1);
  }
  return out;
}

/** The WhatsApp groups: who is in them (and who of them is a client), and the ones with new messages read. */
async function whatsappTick(
  db: Db,
  s: Settings,
  cfg: Config,
  t: Team,
  deadline: number,
  out: { synced: number; analyzed: number; opened: number; resolved: number; clients: number; asked: number; dms: number; orders: number; files: number; errors: string[] },
) {
  // Who is in the groups: new ones, and each again twice a day.
  const { data: stale } = await db
    .from("wa_group")
    .select("chat_id")
    .is("left_at", null)
    .eq("monitored", true)
    .or(`synced_at.is.null,synced_at.lt."${iso(Date.now() - 12 * 60 * MIN)}"`)
    .limit(3);
  for (const g of stale ?? []) {
    try {
      await syncGroup(db, cfg, g.chat_id);
      out.synced++;
    } catch (e) {
      out.errors.push((e as Error).message);
      await db.from("wa_group").update({ synced_at: iso(), last_error: (e as Error).message.slice(0, 300) }).eq("chat_id", g.chat_id);
    }
  }

  // Everyone in the client groups who isn't on the team is in Clients; what's missing is asked (people.ts).
  try {
    out.clients = await learnPeople(db, t, s.bot_phone, deadline - 40_000);
    if (!quietNow(s) && !dayOff(s)) out.asked = await askNow(db, s, sendAs(cfg));
  } catch (e) {
    out.errors.push(`people: ${(e as Error).message}`);
  }
  // Orders and booking links (orders.ts): the people who haven't answered reminded, in working hours
  // (orders already given go on even with taking new ones turned off).
  if (!quietNow(s) && !dayOff(s)) {
    try {
      out.orders = await nagOrders(db, s, sendAs(cfg), deadline - 40_000);
    } catch (e) {
      out.errors.push(`orders: ${(e as Error).message}`);
    }
  }
  // Files that didn't go through when they came (files.ts), tried again.
  try {
    out.files = await keepFiles(db, s, deadline - 50_000);
  } catch (e) {
    out.errors.push(`files: ${(e as Error).message}`);
  }
  // Private chats (dm.ts): replies for an OK, and the ones still waiting for it. Outside working
  // hours they're told the team will get back to them, and the replies wait for work.
  try {
    const away = quietNow(s) || dayOff(s);
    out.dms = await readDms(db, s, t, sendAs(cfg), deadline - 40_000, away);
    if (!away) await remindDrafts(db, s, sendAs(cfg));
  } catch (e) {
    out.errors.push(`private: ${(e as Error).message}`);
  }

  // Client groups with new messages that went quiet.
  const { data: pending } = await db
    .from("wa_group")
    .select("chat_id, pending_since, last_message_at")
    .eq("monitored", true)
    .eq("kind", "client")
    .not("pending_since", "is", null)
    .order("pending_since")
    .limit(8);
  for (const g of pending ?? []) {
    if (Date.now() > deadline - 30_000) break;
    const quiet = !g.last_message_at || Date.now() - Date.parse(g.last_message_at) >= QUIET_MS;
    const long = Date.now() - Date.parse(g.pending_since) >= MAX_WAIT_MS;
    if (!quiet && !long) continue;
    try {
      const r = await analyze(db, s, t, g.chat_id, sendAs(cfg));
      out.analyzed++;
      out.opened += r.opened;
      out.resolved += r.resolved;
    } catch (e) {
      out.errors.push((e as Error).message);
      await db.from("wa_group").update({ last_error: (e as Error).message.slice(0, 300) }).eq("chat_id", g.chat_id);
    }
  }
}

// --------------------------------------------------------------- server --

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = serviceClient();
  const r = route(req);

  if (r === "hook") {
    try {
      return await hook(req, db);
    } catch (e) {
      console.error("hook", (e as Error).message);
      return json({ ok: false }, 200); // Green API retries failed webhooks; one bad message shouldn't loop.
    }
  }
  if (r === "slack") {
    try {
      return await slackHook(req, db, (await config(db)).slack_signing_secret);
    } catch (e) {
      console.error("slack", (e as Error).message);
      return json({ ok: false }, 500); // Slack sends it again a few times; a message is kept once.
    }
  }
  if (r === "decline") {
    try {
      return await declineFromPhone(req, db);
    } catch (e) {
      console.error("decline", (e as Error).message);
      return json({ ok: false }, 500);
    }
  }
  if (r === "pair" || r === "phone" || r === "act" || r === "unpair") {
    try {
      return await (r === "pair" ? pairPhone : r === "phone" ? phoneCheckIn : r === "unpair" ? unpairPhone : phoneAct)(req, db);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(r, (e as Error).message);
      return toResponse(e);
    }
  }
  // Voice notes can be written out: the voice says a line, and it's written out again (ElevenLabs both ways).
  if (r === "selftest") {
    if (!TICK_SECRET || !same(req.headers.get("x-iklipse-secret") ?? "", TICK_SECRET)) return new Response("Forbidden", { status: 403 });
    try {
      return json({ ok: true, text: await writeOut(await speak("Hello, this is a test of the voice notes."), "audio/mpeg") });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message });
    }
  }
  if (r === "tick") {
    if (!TICK_SECRET || !same(req.headers.get("x-iklipse-secret") ?? "", TICK_SECRET)) return new Response("Forbidden", { status: 403 });
    try {
      return json(await tick(db));
    } catch (e) {
      console.error("watch tick", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }
  try {
    const me = await caller(req, db);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cfg = await config(db);
    // Everyone: a test call to themselves; their phone stops ringing once they answer in the app.
    if (b.action === "test_call") {
      const s = await settings(db);
      const t = await team(db);
      try {
        return json({ call: await startCall(db, s, cfg, { person: t.people.get(me.id)!, test: true }) });
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    }
    if (b.action === "hush") {
      const callId = str(b.call);
      const { data: c } = isId(callId) ? await db.from("watch_call").select("user_id").eq("id", callId).maybeSingle() : { data: null };
      if (c?.user_id === me.id) await hush(db, me.id, callId);
      return json({ ok: true });
    }
    const { data: p } = await db.from("profile").select("role").eq("id", me.id).maybeSingle();
    if (p?.role !== "admin") throw new HttpError(403, "Admins only");
    switch (b.action) {
      case "connect":
        return json(await connect(db, cfg));
      case "status":
        return json(await botStatus(db, cfg));
      case "sync":
        return json(await syncAll(db, cfg, Date.now() + 90_000));
      case "slack_status":
        return json(await slackCheck(db, cfg.slack_bot_token));
      case "slack_sync":
        return json(await slackSync(db, cfg.slack_bot_token, Date.now() + 90_000));
      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    return toResponse(e);
  }
});
