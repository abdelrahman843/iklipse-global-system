// The bot's own WhatsApp bridge (0097): WAHA (devlikeapro/waha, GOWS engine)
// on the claude-vps server, next to Green API. An admin links a number with its
// QR code in Connected accounts > WhatsApp and chooses which one the bot uses
// (watch_settings.wa_provider).
//
// The rest of the bot speaks Green API: here WAHA's calls are made to look like
// Green API's (call), and its webhooks are turned into Green API's (toGreen),
// so nothing else changes. WAHA writes a message's id whole
// (false_2010...@c.us_3EB0...); the bot keeps the short one, as Green API sends
// it, and waha_msg holds the whole one to reply to it.
//
// Secrets: WAHA_URL (https://waha.2-29-53-111.sslip.io), WAHA_API_KEY,
// WAHA_SESSION (default "default").

import { HttpError, serviceClient } from "../_shared/oauth.ts";
import { env, iso, str, type Db } from "./kit.ts";

export const WAHA_URL = env("WAHA_URL").replace(/\/+$/, "");
const KEY = env("WAHA_API_KEY");
const SESSION = env("WAHA_SESSION", "default");

export const wahaReady = () => !!(WAHA_URL && KEY);

/** The key for WAHA's own links (the files people send), and only for those. */
export const wahaHeaders = (url: string): Record<string, string> =>
  wahaReady() && url.startsWith(`${WAHA_URL}/`) ? { "X-Api-Key": KEY } : {};

async function waha<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  if (!wahaReady()) throw new HttpError(409, "The WhatsApp bridge isn't set up (WAHA_URL, WAHA_API_KEY)");
  const res = await fetch(`${WAHA_URL}${path}`, {
    method,
    headers: { "X-Api-Key": KEY, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) {
    const d = data as { message?: unknown; error?: unknown } | null;
    const msg = (typeof d === "string" ? d : str(d?.message) || str(d?.error)) || `error ${res.status}`;
    throw new HttpError(502, `WhatsApp bridge: ${msg.slice(0, 200)}`);
  }
  return { status: res.status, data: data as T };
}

// ------------------------------------------------------------- the session --

interface Session {
  name?: string;
  status?: string;
  me?: { id?: string; pushName?: string } | null;
}

/** WAHA's session states, as Green API's (what the Alerts page knows). */
export function stateOf(status: unknown): string {
  switch (str(status)) {
    case "WORKING":
      return "authorized";
    case "SCAN_QR_CODE":
    case "PASSKEY_REQUIRED":
    case "PASSKEY_CONFIRMATION_REQUIRED":
      return "notAuthorized";
    case "STARTING":
      return "starting";
    case "FAILED":
      return "failed";
    case "STOPPED":
      return "stopped";
    default:
      return "notStarted";
  }
}

const digits = (s: string) => s.replace(/\D/g, "");

/** The number in a WhatsApp id: 2010...@c.us, 2010...:12@s.whatsapp.net, or the number. */
function numberOf(id: unknown): string | null {
  const s = str(id);
  if (!s || s.endsWith("@lid") || s.endsWith("@g.us")) return null;
  const d = digits(s.split("@")[0].split(":")[0]);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

async function session() {
  return (await waha<Session>("GET", `/api/sessions/${SESSION}`)).data;
}

/**
 * The session made (or set again) to send everything here, and started. Only
 * new messages (message.any: the bot's own too) and its state come back.
 */
export async function wahaEnsure(hookUrl: string, hookToken: string) {
  const config = {
    metadata: { app: "iklipse" },
    ignore: { status: true, channels: true, groups: false },
    webhooks: [
      {
        url: hookUrl,
        events: ["message.any", "message.edited", "session.status"],
        customHeaders: [{ name: "Authorization", value: `Bearer ${hookToken}` }],
        retries: { policy: "exponential", delaySeconds: 2, attempts: 4 },
      },
    ],
  };
  const s = await session();
  if (!s) await waha("POST", "/api/sessions", { name: SESSION, start: true, config });
  else {
    await waha("PUT", `/api/sessions/${SESSION}`, { name: SESSION, config });
    if (["STOPPED", "FAILED"].includes(str(s.status))) await waha("POST", `/api/sessions/${SESSION}/start`);
  }
}

/** Where the bridge is: its state, the number linked, and the QR code to scan while it waits for one. */
export async function wahaStatus(db: Db) {
  if (!wahaReady()) return { ready: false, state: "notStarted", status: null, phone: null, name: null, qr: null };
  const s = await session();
  const status = str(s?.status) || null;
  const phone = numberOf(s?.me?.id);
  let qr: string | null = null;
  if (status === "SCAN_QR_CODE") {
    try {
      const q = await waha<{ mimetype?: string; data?: string }>("GET", `/api/${SESSION}/auth/qr?format=image`);
      if (q.data?.data) qr = `data:${q.data.mimetype || "image/png"};base64,${q.data.data}`;
    } catch {
      /* the next look brings it */
    }
  }
  const state = s ? stateOf(status) : "notStarted";
  await db.from("watch_settings").update({ waha_state: state, waha_phone: phone, waha_at: iso() }).eq("id", 1);
  return { ready: true, state, status, phone, name: str(s?.me?.pushName) || null, qr };
}

/** Linking by a code typed on the phone instead of the QR code. */
export async function wahaCode(phone: string) {
  const n = digits(phone);
  if (n.length < 8 || n.length > 15) throw new HttpError(400, "Write the number with its country code, like 2010...");
  const r = await waha<{ code?: string }>("POST", `/api/${SESSION}/auth/request-code`, { phoneNumber: n });
  const code = str(r.data?.code);
  if (!code) throw new HttpError(502, "WhatsApp didn't give a code; try the QR code");
  return { code };
}

/** The number unlinked (it leaves the phone's Linked devices); the session waits for a new QR code. */
export async function wahaLogout() {
  await waha("POST", `/api/sessions/${SESSION}/logout`);
}

// ------------------------------------------------- what admins control (0098) --

interface Behaviour {
  wa_seen: boolean;
  wa_typing: boolean;
  typing_cps: number;
  typing_min_sec: number;
  typing_max_sec: number;
  wa_online: boolean;
}

/**
 * Before the bot writes: the chat marked read, and in a private chat "typing…"
 * for as long as a person would take to write it (typing_cps a second, between
 * typing_min_sec and typing_max_sec). None of it stops the message.
 */
async function likeAPerson(db: Db, chatId: string, text: string) {
  const { data } = await db.from("watch_settings").select("wa_seen, wa_typing, typing_cps, typing_min_sec, typing_max_sec").eq("id", 1).single();
  const b = data as Behaviour | null;
  if (!b) return;
  if (b.wa_seen) await waha("POST", "/api/sendSeen", { session: SESSION, chatId }).catch(() => {});
  if (!b.wa_typing || chatId.endsWith("@g.us")) return;
  const lo = Math.max(0, b.typing_min_sec);
  const hi = Math.max(lo, b.typing_max_sec);
  const secs = Math.min(hi, Math.max(lo, text.length / Math.max(1, b.typing_cps)));
  if (secs <= 0) return;
  try {
    await waha("POST", "/api/startTyping", { session: SESSION, chatId });
    await new Promise((r) => setTimeout(r, secs * 1000));
    await waha("POST", "/api/stopTyping", { session: SESSION, chatId });
  } catch {
    /* typing is only for show */
  }
}

/** The number shown online (WhatsApp then doesn't ring the phone for new messages) or offline. */
export async function wahaPresence(online: boolean) {
  await waha("POST", `/api/${SESSION}/presence`, { presence: online ? "online" : "offline" });
}

const shortHook = (url: unknown) => str(url).replace(/^https?:\/\//, "").replace(/\?.*$/, "");

/**
 * All there is to see of the bridge for the panel: the server, the number and
 * its profile, WhatsApp's limits on it, where its messages go, and the settings.
 * The webhook's token never leaves the function.
 */
export async function wahaInfo(db: Db, hookUrl: string) {
  const [s, version, profile, { data: st }] = await Promise.all([
    waha<
      Session & {
        presence?: string | null;
        timestamps?: { activity?: number | null };
        config?: { webhooks?: { url?: string; events?: unknown[] }[]; ignore?: Record<string, boolean> };
        me?: Session["me"] & { messageCapping?: Record<string, unknown> | null; reachoutTimelock?: Record<string, unknown> | null };
      }
    >("GET", `/api/sessions/${SESSION}`).then((r) => r.data),
    waha<{ version?: string; engine?: string; tier?: string }>("GET", "/api/server/version").then((r) => r.data).catch(() => null),
    waha<{ name?: string; picture?: string | null }>("GET", `/api/${SESSION}/profile`).then((r) => r.data).catch(() => null),
    db
      .from("watch_settings")
      .select("reply_quiet_sec, reply_max_sec, group_quiet_sec, group_max_sec, wa_seen, wa_typing, typing_cps, typing_min_sec, typing_max_sec, wa_online, wa_provider, dm_enabled")
      .eq("id", 1)
      .single(),
  ]);
  const hooks = s?.config?.webhooks ?? [];
  const cap = s?.me?.messageCapping ?? null;
  const lock = s?.me?.reachoutTimelock ?? null;
  return {
    server: { url: WAHA_URL, version: str(version?.version) || null, engine: str(version?.engine) || null },
    status: str(s?.status) || null,
    presence: str(s?.presence) || null,
    activity: typeof s?.timestamps?.activity === "number" ? s.timestamps.activity : null,
    phone: numberOf(s?.me?.id),
    profile: profile ? { name: str(profile.name) || str(s?.me?.pushName) || null, picture: str(profile.picture) || null } : null,
    capping: cap
      ? { status: str(cap.cappingStatus) || null, total: Number(cap.totalQuota ?? -1), used: Number(cap.usedQuota ?? 0), ends: Number(cap.cycleEnd ?? 0) || null }
      : null,
    timelock: lock ? { active: !!lock.isActive, type: str(lock.enforcementType) || null, ends: Number(lock.timeEnforcementEnds ?? 0) || null } : null,
    webhook: hooks.length
      ? { to: shortHook(hooks[0].url), ours: str(hooks[0].url) === hookUrl, events: (hooks[0].events ?? []).map(String) }
      : null,
    ignore: s?.config?.ignore ?? null,
    settings: st ?? null,
  };
}

export async function wahaRestart() {
  await waha("POST", `/api/sessions/${SESSION}/restart`);
}

export async function wahaStop() {
  await waha("POST", `/api/sessions/${SESSION}/stop`);
}

/** The number's name, About, and picture (a JPEG/PNG as base64, or null to remove it). */
export async function wahaProfile(p: { name?: unknown; about?: unknown; picture?: unknown }) {
  const name = str(p.name);
  if (name) await waha("PUT", `/api/${SESSION}/profile/name`, { name: name.slice(0, 25) });
  if (typeof p.about === "string") await waha("PUT", `/api/${SESSION}/profile/status`, { status: p.about.trim().slice(0, 139) });
  if (p.picture === null) await waha("DELETE", `/api/${SESSION}/profile/picture`);
  else if (p.picture && typeof p.picture === "object") {
    const f = p.picture as { mimetype?: unknown; data?: unknown };
    const mimetype = str(f.mimetype);
    const data = str(f.data);
    if (!/^image\/(jpeg|png)$/.test(mimetype) || !data) throw new HttpError(400, "A JPEG or PNG picture");
    if (data.length > 7_000_000) throw new HttpError(400, "The picture is too big (5 MB at most)");
    await waha("PUT", `/api/${SESSION}/profile/picture`, { file: { mimetype, filename: mimetype === "image/png" ? "picture.png" : "picture.jpg", data } });
  }
}

/** The settings above, as an admin set them (each kept within its range). */
export async function wahaSettings(db: Db, patch: Record<string, unknown>) {
  const ints: Record<string, [number, number]> = {
    reply_quiet_sec: [5, 600],
    reply_max_sec: [30, 3600],
    group_quiet_sec: [15, 1800],
    group_max_sec: [60, 7200],
    typing_cps: [3, 100],
    typing_min_sec: [0, 30],
    typing_max_sec: [0, 30],
  };
  const bools = ["wa_seen", "wa_typing", "wa_online"];
  const row: Record<string, unknown> = {};
  for (const [k, [lo, hi]] of Object.entries(ints)) {
    if (patch[k] === undefined) continue;
    const n = Math.round(Number(patch[k]));
    if (!Number.isFinite(n)) throw new HttpError(400, `${k}: a number`);
    row[k] = Math.min(hi, Math.max(lo, n));
  }
  for (const k of bools) if (typeof patch[k] === "boolean") row[k] = patch[k];
  if (!Object.keys(row).length) return;
  const { error } = await db.from("watch_settings").update(row).eq("id", 1);
  if (error) throw new HttpError(400, error.message);
  if (typeof row.wa_online === "boolean") {
    const s = await session();
    if (s?.status === "WORKING") await wahaPresence(row.wa_online);
  }
}

// ------------------------------------------------------ Green API's calls --

/** The whole id of a message the bot keeps by its short one, to reply to it. */
async function fullId(db: Db, id: string) {
  const { data } = await db.from("waha_msg").select("full_id").eq("id", id).maybeSingle();
  return (data?.full_id as string | undefined) ?? null;
}

/** "false_2010...@c.us_3EB0..._2011...@lid" -> "3EB0..." (Green API's id). */
export function shortId(id: unknown) {
  const s = str(id);
  const p = s.split("_");
  return p.length >= 3 && (p[0] === "true" || p[0] === "false") ? p[2] : s;
}

interface GroupInfo {
  id?: string | { _serialized?: string };
  JID?: string;
  subject?: string;
  Name?: string;
  name?: string;
}

const groupId = (g: GroupInfo) => (typeof g.id === "string" ? g.id : str(g.id?._serialized)) || str(g.JID);
const groupName = (g: GroupInfo) => str(g.subject) || str(g.Name) || str(g.name);

/** One of Green API's calls the bot makes, made on WAHA, answered the way Green API answers. */
export async function wahaCall<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const db = serviceClient();
  switch (method) {
    case "sendMessage": {
      const chatId = str(body?.chatId);
      const text = str(body?.message);
      const quoted = str(body?.quotedMessageId);
      const reply = quoted ? await fullId(db, quoted) : null;
      await likeAPerson(db, chatId, text);
      const send = (reply_to: string | null) =>
        waha<{ id?: unknown }>("POST", "/api/sendText", { session: SESSION, chatId, text, linkPreview: false, ...(reply_to ? { reply_to } : {}) });
      let r;
      try {
        r = await send(reply);
      } catch (e) {
        // A reply WhatsApp won't take (an old message): sent as it is. Not when it may have gone (no answer).
        if (!reply || !(e instanceof HttpError)) throw e;
        r = await send(null);
      }
      const whole = typeof r.data?.id === "string" ? r.data.id : str((r.data?.id as { _serialized?: string } | undefined)?._serialized);
      const id = shortId(whole);
      if (whole && id) await db.from("waha_msg").upsert({ id, full_id: whole }, { onConflict: "id" });
      return { idMessage: id || undefined } as T;
    }
    case "getStateInstance": {
      const s = await session();
      return { stateInstance: s ? stateOf(s.status) : "notStarted" } as T;
    }
    case "getSettings": {
      const s = await session();
      return { wid: str(s?.me?.id) || undefined } as T;
    }
    case "getChats": {
      const r = await waha<GroupInfo[] | Record<string, GroupInfo>>("GET", `/api/${SESSION}/groups`);
      const list = Array.isArray(r.data) ? r.data : Object.values(r.data ?? {});
      return list.map((g) => ({ id: groupId(g), name: groupName(g), type: "group" })).filter((g) => g.id.endsWith("@g.us")) as T;
    }
    case "getGroupData": {
      const id = str(body?.groupId);
      const g = await waha<GroupInfo>("GET", `/api/${SESSION}/groups/${encodeURIComponent(id)}`);
      if (!g.data) {
        // Not found: left only when it isn't among the bot's groups either (a 404 can be anything) (0104).
        const all = await waha<GroupInfo[] | Record<string, GroupInfo>>("GET", `/api/${SESSION}/groups`);
        const list = Array.isArray(all.data) ? all.data : Object.values(all.data ?? {});
        if (!all.data || list.some((x) => groupId(x) === id)) throw new HttpError(502, "WhatsApp bridge: couldn't read the group");
        return { groupId: id, participants: [] } as T;
      }
      const p = await waha<{ id?: string; pn?: string; role?: string }[]>("GET", `/api/${SESSION}/groups/${encodeURIComponent(id)}/participants/v2`);
      if (!p.data) throw new HttpError(502, "WhatsApp bridge: couldn't read the group's people");
      const participants = (p.data ?? [])
        .filter((x) => x.role !== "left" && str(x.id))
        .map((x) => {
          const pid = str(x.id);
          const lid = pid.endsWith("@lid") ? pid : undefined;
          const pn = str(x.pn) || (pid.endsWith("@c.us") ? pid : "");
          return { id: pn || pid, lid, phoneNumber: numberOf(pn) ?? undefined, isAdmin: x.role === "admin", isSuperAdmin: x.role === "superadmin" };
        });
      return { groupId: id, subject: groupName(g.data), participants } as T;
    }
    case "getContactInfo": {
      // As Green API's, plus phone: the number behind a lid (0100).
      const chatId = str(body?.chatId);
      // The number behind a lid is found even when the contact can't be read.
      const r = await waha<Record<string, unknown>>("GET", `/api/contacts?contactId=${encodeURIComponent(chatId)}&session=${encodeURIComponent(SESSION)}`).catch(() => ({ data: null }));
      const c = r.data ?? {};
      const phone = chatId.endsWith("@lid") ? await numberOfLid(chatId) : numberOf(chatId);
      return { chatId, name: str(c.pushname) || str(c.pushName) || str(c.name), contactName: str(c.name), email: "", phone } as T;
    }
    default:
      throw new HttpError(500, `The WhatsApp bridge can't do ${method}`);
  }
}

// ------------------------------------------------------- Green API's hook --

/** The number behind a lid, from WAHA (what WhatsApp told it). */
async function numberOfLid(lid: string): Promise<string | null> {
  try {
    const r = await waha<{ pn?: string }>("GET", `/api/${SESSION}/lids/${encodeURIComponent(lid)}`);
    return numberOf(r.data?.pn);
  } catch {
    return null;
  }
}

/** What kind of message it is, in Green API's words, from what WhatsApp sent (GOWS: _data.Message). */
function kindOf(p: Record<string, any>): string | null {
  const raw = (p._data?.Message ?? p._data?.message ?? {}) as Record<string, unknown>;
  const has = (k: string) => raw && typeof raw === "object" && raw[k] != null;
  // Reactions, deletions, edits and the like: not messages.
  if (has("reactionMessage") || has("protocolMessage") || has("encReactionMessage")) return null;
  if (has("stickerMessage")) return "stickerMessage";
  if (has("locationMessage") || has("liveLocationMessage")) return "locationMessage";
  if (has("contactMessage")) return "contactMessage";
  if (has("contactsArrayMessage")) return "contactsArrayMessage";
  if (has("pollCreationMessage") || has("pollCreationMessageV2") || has("pollCreationMessageV3")) return "pollMessage";
  const mime = str(p.media?.mimetype);
  if (p.hasMedia || p.media || has("imageMessage") || has("videoMessage") || has("audioMessage") || has("documentMessage") || has("documentWithCaptionMessage")) {
    if (has("imageMessage") || mime.startsWith("image/")) return "imageMessage";
    if (has("videoMessage") || mime.startsWith("video/")) return "videoMessage";
    if (has("audioMessage") || mime.startsWith("audio/")) return "audioMessage";
    return "documentMessage";
  }
  return str(p.body) ? "extendedTextMessage" : null;
}

function pollName(p: Record<string, any>) {
  const m = p._data?.Message ?? {};
  return str((m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3)?.name);
}

/**
 * A WAHA webhook as Green API would have sent it, or null when there's nothing
 * in it for the bot. Only message.any (people's messages and the bot's own,
 * from the phone or sent here) and session.status come.
 */
export async function toGreen(db: Db, ev: Record<string, any>): Promise<Record<string, any> | null> {
  const event = str(ev.event);
  const me = str(ev.me?.id);
  if (event === "session.status") {
    const state = stateOf(ev.payload?.status);
    await db.from("watch_settings").update({ waha_state: state, waha_at: iso(), ...(numberOf(me) ? { waha_phone: numberOf(me) } : {}) }).eq("id", 1);
    // Back up (a restart): shown online again if it's set to be.
    if (str(ev.payload?.status) === "WORKING") {
      const { data } = await db.from("watch_settings").select("wa_online").eq("id", 1).single();
      if (data?.wa_online) await wahaPresence(true).catch(() => {});
    }
    return { typeWebhook: "stateInstanceChanged", stateInstance: state, instanceData: { wid: me } };
  }
  if (event !== "message.any" && event !== "message" && event !== "message.edited") return null;
  const p = (ev.payload ?? {}) as Record<string, any>;
  const whole = str(p.id);
  const id = shortId(whole);
  if (!id) return null;
  await db.from("waha_msg").upsert({ id, full_id: whole }, { onConflict: "id", ignoreDuplicates: true });
  // An edit (0104): the new text, as Green API's editedMessage.
  const edited = event === "message.edited";
  const type = edited ? (str(p.body) ? "editedMessage" : null) : kindOf(p);
  if (!type) return null;

  const mine = !!p.fromMe;
  const info = (p._data?.Info ?? {}) as Record<string, unknown>;
  // The chat is the one in the whole id ("true_<chat>_<id>"): the bot's own messages may come with "to" set to itself (0104).
  const inId = whole.split("_")[1] ?? "";
  let chatId = /@(g\.us|c\.us|lid)$/.test(inId) ? inId : mine ? str(p.to) : str(p.from);
  if (!chatId || chatId === "status@broadcast" || chatId.endsWith("@newsletter")) return null;
  const group = chatId.endsWith("@g.us");
  // A private chat WhatsApp shows by lid: kept by the number behind it, where the bot writes to them (0104).
  const lidChat = !group && chatId.endsWith("@lid") ? chatId : null;
  if (lidChat) {
    const n = numberOf(mine ? info.RecipientAlt : info.SenderAlt) ?? (await numberOfLid(lidChat));
    if (n) chatId = `${n}@c.us`;
  }
  const sender = group ? str(p.participant) || (mine ? me : "") : mine ? me : lidChat ?? chatId;
  // The sender's number when WhatsApp shows them by lid: what came with the message, else asked of WAHA.
  let senderPhone = numberOf(sender) ?? numberOf(info.SenderAlt) ?? (lidChat && !mine ? numberOf(chatId) : null);
  if (!senderPhone && sender.endsWith("@lid") && !mine) senderPhone = await numberOfLid(sender);

  const body = str(p.body);
  const reply = (p.replyTo ?? null) as Record<string, any> | null;
  const quoted = reply ? shortId(reply.id) : "";
  const messageData: Record<string, any> = { typeMessage: type };
  if (type === "extendedTextMessage") messageData.extendedTextMessageData = { text: body, ...(quoted ? { stanzaId: quoted } : {}) };
  if (["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"].includes(type)) {
    const url = str(p.media?.url) || str(p.mediaUrl);
    messageData.fileMessageData = {
      downloadUrl: p.media?.error ? "" : url,
      mimeType: str(p.media?.mimetype),
      fileName: str(p.media?.filename),
      caption: body,
      ...(quoted ? { stanzaId: quoted } : {}),
    };
  }
  if (type === "pollMessage") messageData.pollMessageData = { name: pollName(p) || body };
  if (type === "editedMessage") messageData.editedMessageData = { textMessage: body, ...(str(p.editedMessageId) ? { stanzaId: shortId(p.editedMessageId) } : {}) };
  if (quoted) messageData.quotedMessage = { stanzaId: quoted, textMessage: str(reply?.body) };

  return {
    typeWebhook: !mine ? "incomingMessageReceived" : str(p.source) === "api" ? "outgoingAPIMessageReceived" : "outgoingMessageReceived",
    instanceData: { wid: me },
    timestamp: typeof p.timestamp === "number" ? p.timestamp : Math.floor(Date.now() / 1000),
    idMessage: id,
    senderData: {
      chatId,
      chatName: "",
      sender,
      senderName: str(info.PushName) || str(p.notifyName) || str(p._data?.notifyName),
      senderContactName: "",
      senderPhoneNumber: senderPhone ?? "",
    },
    messageData,
  };
}
