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

async function waha<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
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
        events: ["message.any", "session.status"],
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
      const send = (reply_to: string | null) =>
        waha<{ id?: unknown }>("POST", "/api/sendText", { session: SESSION, chatId, text, linkPreview: false, ...(reply_to ? { reply_to } : {}) });
      let r;
      try {
        r = await send(reply);
      } catch (e) {
        // A reply WhatsApp won't take (an old message): sent as it is.
        if (!reply) throw e;
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
      if (!g.data) return { groupId: id, participants: [] } as T;
      const p = await waha<{ id?: string; pn?: string; role?: string }[]>("GET", `/api/${SESSION}/groups/${encodeURIComponent(id)}/participants/v2`);
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
    return { typeWebhook: "stateInstanceChanged", stateInstance: state, instanceData: { wid: me } };
  }
  if (event !== "message.any" && event !== "message") return null;
  const p = (ev.payload ?? {}) as Record<string, any>;
  const whole = str(p.id);
  const id = shortId(whole);
  if (!id) return null;
  await db.from("waha_msg").upsert({ id, full_id: whole }, { onConflict: "id", ignoreDuplicates: true });
  const type = kindOf(p);
  if (!type) return null;

  const mine = !!p.fromMe;
  const chatId = mine ? str(p.to) : str(p.from);
  if (!chatId || chatId === "status@broadcast" || chatId.endsWith("@newsletter")) return null;
  const group = chatId.endsWith("@g.us");
  const sender = group ? str(p.participant) || (mine ? me : "") : mine ? me : chatId;
  // The sender's number when WhatsApp shows them by lid: what came with the message, else asked of WAHA.
  const info = (p._data?.Info ?? {}) as Record<string, unknown>;
  let senderPhone = numberOf(sender) ?? numberOf(info.SenderAlt);
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
