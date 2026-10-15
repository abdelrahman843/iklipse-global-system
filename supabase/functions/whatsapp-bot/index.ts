// whatsapp-bot — the WhatsApp watch (0067).
//
// The bot's WhatsApp (Green API) sits in client groups. Every group message
// comes here (hook) and is kept for 30 days. Once a group goes quiet for a
// minute, Claude reads its new messages and opens an alert when a client is
// left without a reply, or someone promises something (the team: "I'll send it
// in an hour"; a client: "I'll send the files tomorrow"), and closes the ones
// the chat shows were dealt with.
//
// Every minute (tick) due alerts ring: a notification to the team members in
// that group (only the person it's about, when it's about one person), again
// every few minutes. After that many, a phone call to each of them (Twilio, in
// the voice agent's ElevenLabs voice, the words by Claude), again and again
// until they pick up, then every so often while it's still open. It stops when
// someone marks it handled (the app, or 1 on the call), when the chat shows it
// was dealt with, or after the hours set. All of it set in Alerts > Settings.
//
// POST /whatsapp-bot/hook     Green API webhooks (Authorization: Bearer WATCH_HOOK_TOKEN)
// POST /whatsapp-bot/tick     X-Iklipse-Secret (the database, every minute)
// POST /whatsapp-bot/voice    Twilio: the call was picked up (?c=<call>&s=<signature>)
// POST /whatsapp-bot/gather   Twilio: a key was pressed
// POST /whatsapp-bot/status   Twilio: the call ended
// POST /whatsapp-bot (login token, admin) { action }:
//   connect    -> { state, phone }   point the Green API instance's webhooks here
//   status     -> { state, phone }
//   sync       -> { groups }         re-read the bot's groups and who is in them
//   test_call  -> { to }             call me now
//
// Secrets: ANTHROPIC_API_KEY, ELEVEN_API_KEY (ELEVEN_VOICE_ID, ELEVEN_MODEL),
// WATCH_WEBHOOK_SECRET, WATCH_HOOK_TOKEN. Green API (Users page) and Twilio
// (Alerts > Settings) are kept in the vault. Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { caller, cors, HttpError, json, route, same, serviceClient, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const ANTHROPIC_KEY = env("ANTHROPIC_API_KEY");
const ELEVEN_KEY = env("ELEVEN_API_KEY") || env("ELEVENLABS_API_KEY");
const VOICE = env("ELEVEN_VOICE_ID", "aMSt68OGf4xUZAnLpTU8");
const VOICE_MODEL = env("ELEVEN_MODEL", "eleven_flash_v2_5");
const TICK_SECRET = env("WATCH_WEBHOOK_SECRET");
const HOOK_TOKEN = env("WATCH_HOOK_TOKEN");
const TZ = "Africa/Cairo";
const BASE = `${SUPABASE_URL}/functions/v1/whatsapp-bot`;
const BUCKET = "watch-audio";
/** No new work is started after this long (the function has about 150 seconds). */
const RUN_MS = 100_000;
/** A group is read once it's been quiet this long, or this long after its first unread message. */
const QUIET_MS = 60_000;
const MAX_WAIT_MS = 5 * 60_000;
/** What Claude reads of a group: the last messages of the last days. */
const WINDOW_MESSAGES = 60;
const WINDOW_DAYS = 3;
const MIN = 60_000;

type Db = SupabaseClient;
type Lang = "en" | "ar";

interface Settings {
  enabled: boolean;
  model: string;
  reply_wait_min: number;
  promise_wait_min: number;
  repeat_every_min: number;
  alerts_before_call: number;
  calls_enabled: boolean;
  call_retry_min: number;
  call_every_min: number;
  max_calls: number;
  stop_after_hours: number;
  quiet_from: string | null;
  quiet_to: string | null;
  call_language: Lang;
  cc_admins: boolean;
  bot_phone: string | null;
}

interface Config {
  greenapi_url: string | null;
  greenapi_instance: string | null;
  greenapi_token: string | null;
  twilio_sid: string | null;
  twilio_token: string | null;
  twilio_from: string | null;
}

interface Person {
  id: string;
  name: string;
  username: string;
  active: boolean;
  admin: boolean;
}

interface Team {
  people: Map<string, Person>;
  /** WhatsApp number -> team member */
  byPhone: Map<string, Person>;
}

interface Alert {
  id: string;
  chat_id: string | null;
  kind: "unanswered" | "promise" | "follow_up";
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

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const digits = (s: unknown) => (typeof s === "string" ? s : "").replace(/\D/g, "");
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The number in a WhatsApp id (2010...@c.us), if it is one. */
function phoneOf(id: unknown): string | null {
  const s = str(id);
  if (!/@c\.us$/.test(s) && !/^\+?\d+$/.test(s)) return null;
  const d = digits(s.split("@")[0]);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

// ----------------------------------------------------------------- Cairo --

const cairoClock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const cairoStamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const cairoSpoken = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

/** "+03:00": Cairo's offset from UTC right now (summer time or not). */
function cairoOffset(d = new Date()) {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  return v === "GMT" ? "+00:00" : v.replace("GMT", "");
}

/** Within the quiet hours (Cairo), when nothing rings. */
function quietNow(s: Settings) {
  if (!s.quiet_from || !s.quiet_to) return false;
  const hm = cairoClock.format(new Date());
  const f = s.quiet_from.slice(0, 5);
  const t = s.quiet_to.slice(0, 5);
  if (f === t) return false;
  return f < t ? hm >= f && hm < t : hm >= f || hm < t;
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
  const [profiles, links, cards] = await Promise.all([
    db.from("profile").select("id, display_name, username, is_active, role"),
    db.from("wa_member").select("phone, user_id"),
    db.from("profile_contact").select("user_id, whatsapp").not("whatsapp", "is", null),
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
  return { people, byPhone };
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
    await db.from("wa_group").update({ left_at: now, synced_at: now }).eq("chat_id", chatId);
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
    .update({ ...(d.subject ? { name: d.subject } : {}), size: unique.length, synced_at: now, left_at: null })
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
  // Groups only: private chats with the bot are never kept.
  if (!chatId.endsWith("@g.us") || !b.idMessage) return json({ ok: true });
  const { data: on } = await db.from("watch_settings").select("enabled").eq("id", 1).single();
  if (!on?.enabled) return json({ ok: true });
  const m = readMessage(b.messageData);
  if (!m || !m.text) return json({ ok: true });

  const { data: g } = await db.from("wa_group").select("chat_id, name, monitored, pending_since, left_at").eq("chat_id", chatId).maybeSingle();
  if (!g) {
    await db.from("wa_group").insert({ chat_id: chatId, name: str(sd.chatName) || null });
  } else if (!g.monitored) {
    return json({ ok: true });
  } else if ((sd.chatName && sd.chatName !== g.name) || g.left_at) {
    await db.from("wa_group").update({ ...(sd.chatName ? { name: sd.chatName } : {}), left_at: null }).eq("chat_id", chatId);
  }

  const fromBot = type.startsWith("outgoing");
  const sender = str(sd.sender);
  let phone = phoneOf(sender) ?? phoneOf(sd.senderPhoneNumber);
  if (!phone && sender.endsWith("@lid")) {
    const { data: p } = await db.from("wa_participant").select("phone").eq("lid", sender).not("phone", "is", null).limit(1).maybeSingle();
    phone = p?.phone ?? null;
  }
  if (fromBot && !phone) phone = botPhone;
  const name = str(sd.senderContactName) || str(sd.senderName) || null;
  const sentAt = iso(typeof b.timestamp === "number" ? b.timestamp * 1000 : Date.now());

  await db.from("wa_message").upsert(
    { id: b.idMessage, chat_id: chatId, sender_id: sender || null, phone, sender_name: name, from_bot: fromBot, text: m.text.slice(0, 4000), quoted_id: m.quoted, sent_at: sentAt },
    { onConflict: "id", ignoreDuplicates: true },
  );
  await db.from("wa_group").update({ last_message_at: sentAt, ...(g?.pending_since ? {} : { pending_since: now }) }).eq("chat_id", chatId);
  // The name WhatsApp shows for this person, for the Groups list.
  if (name && sender) {
    await db.from("wa_participant").update({ name }).eq("chat_id", chatId).or(`wa_id.eq."${sender}",lid.eq."${sender}"${phone ? `,phone.eq.${phone}` : ""}`);
  }
  return json({ ok: true });
}

// --------------------------------------------------------------- Claude --

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

async function claude(model: string, system: string, user: string, tool?: ClaudeTool, maxTokens = 2000): Promise<any> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY isn't set on the whatsapp-bot function");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      // Current models don't take a forced tool_choice; the prompt asks for the tool.
      ...(tool ? { tools: [tool], tool_choice: { type: "auto" } } : {}),
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude: ${j?.error?.message ?? `error ${res.status}`}`);
  const content = (j.content ?? []) as { type: string; text?: string; name?: string; input?: unknown }[];
  if (tool) {
    const used = content.find((c) => c.type === "tool_use" && c.name === tool.name)?.input;
    if (used) return used;
    // Answered in words instead: the JSON in them, if any.
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const at = text.indexOf("{");
    try {
      return at >= 0 ? JSON.parse(text.slice(at, text.lastIndexOf("}") + 1)) : null;
    } catch {
      return null;
    }
  }
  return content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}

const READ_SYSTEM = `You watch a WhatsApp group between iklipse (a creative and marketing agency) and one of its clients, on behalf of the iklipse team. Each message is marked TEAM (iklipse staff) or CLIENT (anyone else in the group: the client and their colleagues). Messages marked NEW arrived since you last looked; the rest are context. Times are Cairo time. People write in English, Arabic, Egyptian Arabic or Franco-Arabic.

Your job: no client is left waiting, and no promise is forgotten. Report through the report tool.

open: new alerts, only for something in a NEW message that isn't already covered by an open alert.
- unanswered: a CLIENT message that needs an answer or action from the team (a question, a request, feedback, a complaint, an approval, files sent for review, chasing) and no TEAM message after it deals with it. Not for greetings, thanks, "ok", emojis, stickers or chat that needs nothing. One alert per waiting client: when they sent several messages, one alert about their latest need.
- promise: a TEAM member committed to do something or to get back ("I'll send it in an hour", "هبعتهولك بكرة الصبح", "give me 10 minutes", "هرجعلك كمان شوية", "I'll check and get back to you"). If they already did it in a later message, don't open it.
- follow_up: a CLIENT said they will send or do something the team needs (files, content, feedback, approval, payment, a call), so the team should chase it if it doesn't come.
For promise and follow_up, due_at is when it is due (ISO 8601 with the Cairo offset given below), or null when no time was given ("shortly", "later", "كمان شوية").
Each alert has: title (one short line, like "Alessandro is waiting for a reply" or "Omar promised the final cut by 6 pm"), detail (one sentence in English on what is needed, no long quotes), person (who it is about: the client, or the team member who promised), for (the names of the TEAM members who should handle it: whoever promised, or the team member the client addressed; an empty list means everyone on the team in this group), message (the # of the message it is about), priority (normal; high for an upset client, a deadline or money; urgent for an angry client or something broken right now).

resolve: open alerts the chat now shows were dealt with: the client got a real answer (from anyone, even their own colleague), the promise was kept, the follow-up arrived, or it no longer matters. A TEAM reply that only says "checking" or "one sec" is not an answer; if it promises a time, resolve the unanswered alert and open a promise instead.

Be useful, not noisy. A direct question or request to the team needs a reply. Don't reopen anything listed under "Closed recently" unless a NEW message brings it back. When nothing needs doing, return empty lists.

Always answer by calling the report tool, once.`;

const READ_TOOL: ClaudeTool = {
  name: "report",
  description: "The alerts to open and to close in this group.",
  input_schema: {
    type: "object",
    properties: {
      open: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["unanswered", "promise", "follow_up"] },
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
    },
    required: ["open", "resolve"],
  },
};

interface Opened {
  kind: Alert["kind"];
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

/** Read a group's new messages; open and close its alerts. */
async function analyze(db: Db, s: Settings, t: Team, chatId: string) {
  const started = iso();
  const { data: g } = await db.from("wa_group").select("chat_id, name, analyzed_at").eq("chat_id", chatId).single();
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

  // The team in this group: members by their numbers, and anyone on the team who wrote here.
  const inGroup = new Map<string, Person>();
  for (const p of parts ?? []) {
    const who = p.phone ? t.byPhone.get(p.phone) : undefined;
    if (who?.active) inGroup.set(who.id, who);
  }
  for (const m of msgs) {
    const ph = phoneOfMsg(m);
    const who = ph ? t.byPhone.get(ph) : undefined;
    if (who?.active) inGroup.set(who.id, who);
  }

  const index = new Map(msgs.map((m, i) => [m.id, i + 1]));
  const mention = (text: string) =>
    text.replace(/@(\d{8,15})\b/g, (all, d: string) => {
      const who = t.byPhone.get(d);
      return who ? `@${who.name}` : all;
    });
  const lines = msgs.map((m, i) => {
    const ph = phoneOfMsg(m);
    const who = ph ? t.byPhone.get(ph) : undefined;
    const role = m.from_bot || who ? "TEAM" : "CLIENT";
    const name = m.from_bot ? "iklipse" : who?.name ?? (m.sender_name || (ph ? `+${ph}` : "Unknown"));
    const reply = m.quoted_id ? (index.has(m.quoted_id) ? ` (replying to #${index.get(m.quoted_id)})` : " (replying to an older message)") : "";
    return `${isNew(m) ? "NEW " : ""}#${i + 1} [${cairoStamp.format(new Date(m.sent_at))}] ${role} ${name}${reply}: ${mention(m.text ?? "").replace(/\s+/g, " ").slice(0, 1200)}`;
  });

  const { data: openRows } = await db
    .from("watch_alert")
    .select("id, kind, title, detail, person, message_id, due_at, created_at")
    .eq("chat_id", chatId)
    .eq("status", "open")
    .order("created_at");
  const open = openRows ?? [];
  const { data: closedRows } = await db
    .from("watch_alert")
    .select("kind, title, status, close_note")
    .eq("chat_id", chatId)
    .neq("status", "open")
    .gt("closed_at", iso(Date.now() - 24 * 60 * MIN))
    .order("closed_at", { ascending: false })
    .limit(10);

  const user = [
    `Group: ${g.name ?? "Unnamed group"}`,
    `Now: ${cairoStamp.format(new Date())} Cairo time (UTC${cairoOffset()})`,
    `Team members in this group: ${[...inGroup.values()].map((p) => p.name).join(", ") || "none known"}`,
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

  const r = (await claude(s.model, READ_SYSTEM, user, READ_TOOL)) as { open?: Opened[]; resolve?: { alert: string; reason: string }[] } | null;
  if (!r) throw new Error("Claude gave no answer");

  // Close what the chat shows was dealt with.
  let resolved = 0;
  for (const x of r.resolve ?? []) {
    const n = Number(String(x.alert).replace(/\D/g, ""));
    const a = open[n - 1];
    if (!a) continue;
    const { data: hit } = await db
      .from("watch_alert")
      .update({ status: "resolved", closed_at: iso(), close_note: str(x.reason).slice(0, 300) || "Answered in the group", next_alert_at: null, updated_at: iso() })
      .eq("id", a.id)
      .eq("status", "open")
      .select("id");
    if (!hit?.length) continue;
    await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", a.id);
    await db.from("watch_event").insert({ alert_id: a.id, what: "resolved", detail: str(x.reason).slice(0, 300) || null });
    await db.rpc("_watch_quiet_notifications", { p_alert: a.id });
    resolved++;
  }

  // Open the new ones.
  let opened = 0;
  const pool = [...t.people.values()].filter((p) => p.active);
  const admins = pool.filter((p) => p.admin);
  for (const o of r.open ?? []) {
    if (!["unanswered", "promise", "follow_up"].includes(o.kind) || !str(o.title)) continue;
    const m = msgs[Number(o.message) - 1];
    if (!m) continue;
    // Never twice for the same message, nor two "waiting" alerts for the same client.
    if (open.some((a) => a.message_id === m.id && a.kind === o.kind)) continue;
    if (o.kind === "unanswered" && open.some((a) => a.kind === "unanswered" && str(a.person).toLowerCase() === str(o.person).toLowerCase())) continue;
    const sent = Date.parse(m.sent_at);
    let due: number;
    if (o.kind === "unanswered") {
      due = sent + s.reply_wait_min * MIN;
    } else {
      const asked = o.due_at ? Date.parse(o.due_at) : NaN;
      due = Number.isFinite(asked) && asked > sent ? asked : sent + s.promise_wait_min * MIN;
    }
    // Who it rings for: the people named, else the team in the group, else the admins.
    let to = findPeople(o.for ?? [], [...inGroup.values()]);
    if (!to.length && (o.for ?? []).length) to = findPeople(o.for, pool);
    if (!to.length) to = [...inGroup.values()];
    if (!to.length) to = admins;
    if (s.cc_admins) for (const a of admins) if (!to.some((p) => p.id === a.id)) to.push(a);
    if (!to.length) continue;

    const { data: made, error } = await db
      .from("watch_alert")
      .insert({
        chat_id: chatId,
        kind: o.kind,
        title: str(o.title).slice(0, 200),
        detail: str(o.detail).slice(0, 500) || null,
        person: str(o.person).slice(0, 120) || null,
        priority: ["normal", "high", "urgent"].includes(o.priority) ? o.priority : "normal",
        message_id: m.id,
        due_at: iso(due),
        next_alert_at: iso(due),
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
  await done();
  return { opened, resolved };
}

// ----------------------------------------------------------------- ring --

async function closeAlert(db: Db, id: string, status: "handled" | "stopped", note: string, by: string | null) {
  const { data: hit } = await db
    .from("watch_alert")
    .update({ status, closed_at: iso(), closed_by: by, close_note: note, next_alert_at: null, updated_at: iso() })
    .eq("id", id)
    .eq("status", "open")
    .select("id");
  if (!hit?.length) return false;
  await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", id);
  await db.from("watch_event").insert({ alert_id: id, what: status, detail: note, user_id: by });
  await db.rpc("_watch_quiet_notifications", { p_alert: id });
  return true;
}

/** Due alerts: a notification to each person on them, and the next one set. */
async function ring(db: Db, s: Settings, t: Team, deadline: number) {
  const now = Date.now();
  const { data: due } = await db
    .from("watch_alert")
    .select("id, chat_id, kind, title, detail, priority, due_at, alerts_sent, snoozed_until, wa_group(name, monitored)")
    .eq("status", "open")
    .lte("next_alert_at", iso(now))
    .order("next_alert_at")
    .limit(40);
  let rang = 0;
  for (const a of (due ?? []) as unknown as (Alert & { wa_group: { name: string | null; monitored: boolean } | null })[]) {
    if (Date.now() > deadline) break;
    if (a.snoozed_until && Date.parse(a.snoozed_until) > now) continue;
    if (s.stop_after_hours > 0 && now - Date.parse(a.due_at) > s.stop_after_hours * 60 * MIN) {
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
          data: { alert_id: a.id, title: a.title, detail: a.detail, group: a.wa_group?.name ?? null, alert_kind: a.kind, priority: a.priority, count: n },
        })),
      );
    }
    await db
      .from("watch_alert")
      .update({ alerts_sent: n, last_alert_at: iso(), next_alert_at: iso(Date.now() + s.repeat_every_min * MIN), updated_at: iso() })
      .eq("id", a.id);
    await db.from("watch_event").insert({ alert_id: a.id, what: "alert", detail: `Alert ${n} to ${people.map((p) => p.name).join(", ") || "nobody active"}` });
    // Enough alerts with nobody acting: the phone calls start.
    if (s.calls_enabled && n >= s.alerts_before_call) {
      await db.from("watch_recipient").update({ next_call_at: iso() }).eq("alert_id", a.id).is("next_call_at", null).eq("calling", false).eq("calls", 0);
    }
    rang++;
  }
  return rang;
}

// ---------------------------------------------------------------- calls --

const twilioReady = (c: Config) => !!(c.twilio_sid && c.twilio_token && c.twilio_from);

let signKey: Promise<CryptoKey> | null = null;
/** The token in a Twilio address: only this function can make one for a call. */
async function sign(callId: string) {
  signKey ??= crypto.subtle.importKey("raw", new TextEncoder().encode(`watch-call:${TICK_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signKey, new TextEncoder().encode(callId)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function speak(text: string, lang: Lang): Promise<Uint8Array> {
  if (!ELEVEN_KEY) throw new Error("ELEVEN_API_KEY isn't set on the whatsapp-bot function");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_22050_32`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: VOICE_MODEL,
      language_code: lang,
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
};

/** What the call says: Claude writes it from the alert; a plain sentence if Claude can't. */
async function callWords(s: Settings, a: Alert, group: string | null, name: string): Promise<string> {
  const first = name.split(/\s+/)[0];
  const waiting = spokenSpan(Date.now() - Date.parse(a.kind === "unanswered" ? a.created_at : a.due_at));
  const fallback =
    s.call_language === "ar"
      ? `أهلا ${first}، معاك إكلي من iklipse. فيه تنبيه في جروب ${group ?? "الواتساب"}: ${a.title}. لو اتعمل دوس واحد.`
      : `Hi ${first}, it's Ikli from iklipse. ${a.title}${group ? ` in ${group}` : ""}, for ${waiting} now. Please take care of it. Press 1 if it's handled.`;
  try {
    const lang = s.call_language === "ar" ? "Egyptian Arabic, natural and spoken (not formal Arabic)" : "English";
    const text = await claude(
      s.model,
      `You write what an automated phone call from iklipse's alert line says to someone on the iklipse team. Spoken, short and clear: at most 3 short sentences, about 40 words. Start by greeting them by first name and saying it's Ikli from iklipse. Then say why you're calling: what needs doing, who it's about, which WhatsApp group, and how long it has been waiting or how late it is. End with: press 1 if it's handled. No emojis, lists, links, phone numbers or em dashes. Write in ${lang}. Reply with the words only.`,
      JSON.stringify({
        name: first,
        what: KIND_WORDS[a.kind],
        title: a.title,
        detail: a.detail,
        about: a.person,
        group,
        [a.kind === "unanswered" ? "waiting_for" : "due"]: a.kind === "unanswered" ? waiting : cairoSpoken.format(new Date(a.due_at)),
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

/** Ring a person: the words in the voice, kept for the call, then Twilio dials. */
async function placeCall(
  db: Db,
  s: Settings,
  cfg: Config,
  o: { alert?: Alert & { group: string | null }; person: Person; phone: string; test?: boolean },
) {
  const { data: call, error } = await db
    .from("watch_call")
    .insert({ alert_id: o.alert?.id ?? null, user_id: o.person.id, phone: o.phone })
    .select("id")
    .single();
  if (error || !call) throw new Error(error?.message ?? "Couldn't start the call");
  try {
    const first = o.person.name.split(/\s+/)[0];
    const words = o.test
      ? s.call_language === "ar"
        ? `أهلا ${first}، معاك إكلي من iklipse. دي مكالمة تجربة من التنبيهات. لو سامعني دوس واحد.`
        : `Hi ${first}, it's Ikli from iklipse. This is a test call from Alerts. If you can hear me, press 1.`
      : await callWords(s, o.alert!, o.alert!.group, o.person.name);
    const audio = await speak(words, s.call_language);
    const path = `${call.id}.mp3`;
    const up = await db.storage.from(BUCKET).upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (up.error) throw new Error(up.error.message);
    const q = `c=${call.id}&s=${await sign(call.id)}`;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_sid}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${cfg.twilio_sid}:${cfg.twilio_token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: `+${o.phone}`,
        From: cfg.twilio_from!,
        Url: `${BASE}/voice?${q}`,
        Method: "POST",
        StatusCallback: `${BASE}/status?${q}`,
        StatusCallbackMethod: "POST",
        Timeout: "40",
      }),
    });
    const tw = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio: ${tw.message ?? `error ${res.status}`}`);
    await db.from("watch_call").update({ sid: tw.sid ?? null, audio: path }).eq("id", call.id);
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
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await db.from("watch_call").update({ status: "failed", error: msg, ended_at: iso() }).eq("id", call.id);
    await db.storage.from(BUCKET).remove([`${call.id}.mp3`]);
    if (o.alert) {
      await db
        .from("watch_recipient")
        .update({ next_call_at: iso(Date.now() + Math.max(5, s.call_retry_min) * MIN) })
        .eq("alert_id", o.alert.id)
        .eq("user_id", o.person.id);
      await db.from("watch_event").insert({ alert_id: o.alert.id, what: "call_failed", detail: `Couldn't call ${o.person.name}: ${msg}` });
    }
    throw e;
  }
}

/** People due a call: dial them (a few at a time). */
async function callDue(db: Db, s: Settings, cfg: Config, t: Team, deadline: number) {
  if (!s.calls_enabled || !twilioReady(cfg)) return 0;
  const { data: due } = await db
    .from("watch_recipient")
    .select("alert_id, user_id, calls, watch_alert!inner(id, chat_id, kind, title, detail, person, priority, status, due_at, alerts_sent, calls_made, snoozed_until, created_at, wa_group(name))")
    .lte("next_call_at", iso())
    .eq("calling", false)
    .eq("watch_alert.status", "open")
    .order("next_call_at")
    .limit(6);
  let placed = 0;
  for (const r of (due ?? []) as unknown as { alert_id: string; user_id: string; calls: number; watch_alert: Alert & { wa_group: { name: string | null } | null } }[]) {
    if (Date.now() > deadline) break;
    const a = r.watch_alert;
    if (a.snoozed_until && Date.parse(a.snoozed_until) > Date.now()) continue;
    const person = t.people.get(r.user_id);
    if (!person?.active || (s.max_calls > 0 && r.calls >= s.max_calls)) {
      await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", r.alert_id).eq("user_id", r.user_id);
      continue;
    }
    const { data: phone } = await db.rpc("_watch_phone", { p_user: r.user_id });
    if (!phone) {
      await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", r.alert_id).eq("user_id", r.user_id);
      await db.from("watch_event").insert({ alert_id: r.alert_id, what: "call_failed", detail: `No phone number for ${person.name}`, user_id: r.user_id });
      continue;
    }
    try {
      await placeCall(db, s, cfg, { alert: { ...a, group: a.wa_group?.name ?? null }, person, phone: String(phone) });
      placed++;
    } catch (e) {
      console.error("call", (e as Error).message);
    }
  }
  return placed;
}

/** Calls Twilio never reported back on (10 minutes): counted as not picked up. */
async function sweepCalls(db: Db, s: Settings) {
  const { data: stuck } = await db.from("watch_call").select("id").eq("status", "calling").lt("started_at", iso(Date.now() - 10 * MIN)).limit(20);
  for (const c of stuck ?? []) await finishCall(db, s, c.id, "no_answer", 0);
}

async function finishCall(db: Db, s: Settings, callId: string, status: "answered" | "no_answer" | "busy" | "failed", seconds: number) {
  const { data: c } = await db
    .from("watch_call")
    .update({ status, seconds, ended_at: iso() })
    .eq("id", callId)
    .eq("status", "calling")
    .select("alert_id, user_id, audio")
    .maybeSingle();
  if (!c) return;
  if (c.audio) await db.storage.from(BUCKET).remove([c.audio]);
  if (!c.alert_id || !c.user_id) return;
  const { data: a } = await db.from("watch_alert").select("status").eq("id", c.alert_id).single();
  const { data: r } = await db.from("watch_recipient").select("answered").eq("alert_id", c.alert_id).eq("user_id", c.user_id).single();
  const picked = status === "answered";
  await db
    .from("watch_recipient")
    .update({
      calling: false,
      answered: (r?.answered ?? 0) + (picked ? 1 : 0),
      // Didn't pick up: again soon. Picked up: again later, while it's still open.
      next_call_at: a?.status === "open" ? iso(Date.now() + (picked ? s.call_every_min : s.call_retry_min) * MIN) : null,
    })
    .eq("alert_id", c.alert_id)
    .eq("user_id", c.user_id);
  const { data: p } = await db.from("profile").select("display_name").eq("id", c.user_id).single();
  const who = p?.display_name ?? "They";
  await db.from("watch_event").insert({
    alert_id: c.alert_id,
    what: picked ? "answered" : "no_answer",
    detail: picked ? `${who} picked up (${seconds}s)` : status === "busy" ? `${who} declined the call` : status === "failed" ? `The call to ${who} didn't go through` : `${who} didn't pick up`,
    user_id: c.user_id,
  });
}

// --------------------------------------------------------------- Twilio --

const twiml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "content-type": "text/xml" } });
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function signedAudio(db: Db, path: string) {
  const { data } = await db.storage.from(BUCKET).createSignedUrl(path, 30 * 60);
  return data?.signedUrl ?? null;
}

/** The "thanks" line, made once per language and kept. */
async function thanksAudio(db: Db, lang: Lang) {
  const path = `fixed/thanks-${lang}.mp3`;
  const have = await signedAudio(db, path);
  if (have) {
    const head = await fetch(have, { method: "HEAD" }).catch(() => null);
    if (head?.ok) return have;
  }
  const words = lang === "ar" ? "تمام، اتعلم إنه اتعمل. شكرا!" : "Got it, it's marked as handled. Thanks!";
  await db.storage.from(BUCKET).upload(path, await speak(words, lang), { contentType: "audio/mpeg", upsert: true });
  return await signedAudio(db, path);
}

async function twilio(req: Request, db: Db, r: string): Promise<Response> {
  const u = new URL(req.url);
  const callId = u.searchParams.get("c") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(callId) || !same(u.searchParams.get("s") ?? "", await sign(callId))) return new Response("Forbidden", { status: 403 });
  const form = new URLSearchParams(await req.text());
  const s = await settings(db);
  const q = `c=${callId}&amp;s=${await sign(callId)}`;

  if (r === "voice") {
    const { data: c } = await db.from("watch_call").select("audio, alert_id").eq("id", callId).single();
    const url = c?.audio ? await signedAudio(db, c.audio) : null;
    if (!url) return twiml("<Hangup/>");
    return twiml(
      `<Gather input="dtmf" numDigits="1" timeout="6" action="${BASE}/gather?${q}" method="POST"><Play>${xmlEsc(url)}</Play></Gather><Hangup/>`,
    );
  }

  if (r === "gather") {
    const d = form.get("Digits") ?? "";
    const { data: c } = await db.from("watch_call").select("alert_id, user_id").eq("id", callId).single();
    await db.from("watch_call").update({ pressed: d.slice(0, 4) || null }).eq("id", callId);
    if (d !== "1") return twiml("<Hangup/>");
    if (c?.alert_id) await closeAlert(db, c.alert_id, "handled", "Pressed 1 on the call", c.user_id ?? null);
    try {
      const url = await thanksAudio(db, s.call_language);
      return twiml(`${url ? `<Play>${xmlEsc(url)}</Play>` : ""}<Hangup/>`);
    } catch {
      return twiml("<Hangup/>");
    }
  }

  // status: the call ended.
  const st = form.get("CallStatus") ?? "";
  if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(st)) return new Response("ok");
  const status = st === "completed" ? "answered" : st === "busy" ? "busy" : st === "failed" ? "failed" : "no_answer";
  await finishCall(db, s, callId, status, Number(form.get("CallDuration") ?? 0) || 0);
  return new Response("ok");
}

// ----------------------------------------------------------------- tick --

async function tick(db: Db) {
  const t0 = Date.now();
  const deadline = t0 + RUN_MS;
  const s = await settings(db);
  if (!s.enabled) return { off: true };
  // One run at a time (a slow one can outlast the minute).
  const { data: lock } = await db
    .from("watch_settings")
    .update({ tick_lock: iso() })
    .eq("id", 1)
    .or(`tick_lock.is.null,tick_lock.lt."${iso(Date.now() - 3 * MIN)}"`)
    .select("id");
  if (!lock?.length) return { busy: true };
  const out = { synced: 0, analyzed: 0, opened: 0, resolved: 0, rang: 0, calls: 0, errors: [] as string[] };
  try {
    const cfg = await config(db);
    const t = await team(db);

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

    // Groups with new messages that went quiet.
    const { data: pending } = await db
      .from("wa_group")
      .select("chat_id, pending_since, last_message_at")
      .eq("monitored", true)
      .not("pending_since", "is", null)
      .order("pending_since")
      .limit(8);
    for (const g of pending ?? []) {
      if (Date.now() > deadline - 30_000) break;
      const quiet = !g.last_message_at || Date.now() - Date.parse(g.last_message_at) >= QUIET_MS;
      const long = Date.now() - Date.parse(g.pending_since) >= MAX_WAIT_MS;
      if (!quiet && !long) continue;
      try {
        const r = await analyze(db, s, t, g.chat_id);
        out.analyzed++;
        out.opened += r.opened;
        out.resolved += r.resolved;
      } catch (e) {
        out.errors.push((e as Error).message);
        await db.from("wa_group").update({ last_error: (e as Error).message.slice(0, 300) }).eq("chat_id", g.chat_id);
      }
    }

    if (!quietNow(s)) {
      out.rang = await ring(db, s, t, deadline);
      await sweepCalls(db, s);
      out.calls = await callDue(db, s, cfg, t, deadline);
    }

    // Group messages are kept 30 days.
    await db.from("wa_message").delete().lt("sent_at", iso(Date.now() - 30 * 24 * 60 * MIN));
  } finally {
    await db.from("watch_settings").update({ tick_lock: null }).eq("id", 1);
  }
  return out;
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
  if (r === "tick") {
    if (!TICK_SECRET || !same(req.headers.get("x-iklipse-secret") ?? "", TICK_SECRET)) return new Response("Forbidden", { status: 403 });
    try {
      return json(await tick(db));
    } catch (e) {
      console.error("watch tick", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }
  if (r === "voice" || r === "gather" || r === "status") {
    try {
      return await twilio(req, db, r);
    } catch (e) {
      console.error("twilio", r, (e as Error).message);
      return r === "status" ? new Response("ok") : twiml("<Hangup/>");
    }
  }

  try {
    const me = await caller(req, db);
    const { data: p } = await db.from("profile").select("role").eq("id", me.id).maybeSingle();
    if (p?.role !== "admin") throw new HttpError(403, "Admins only");
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cfg = await config(db);
    switch (b.action) {
      case "connect":
        return json(await connect(db, cfg));
      case "status":
        return json(await botStatus(db, cfg));
      case "sync":
        return json(await syncAll(db, cfg, Date.now() + 90_000));
      case "test_call": {
        if (!twilioReady(cfg)) throw new HttpError(409, "Add the Twilio account first");
        const { data: phone } = await db.rpc("_watch_phone", { p_user: me.id });
        if (!phone) throw new HttpError(409, "Add your WhatsApp number on your member card (Users page) or link it in Groups first");
        const s = await settings(db);
        const t = await team(db);
        const person = t.people.get(me.id)!;
        try {
          await placeCall(db, s, cfg, { person, phone: String(phone), test: true });
        } catch (e) {
          throw new HttpError(502, (e as Error).message);
        }
        return json({ to: String(phone) });
      }
      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    return toResponse(e);
  }
});
