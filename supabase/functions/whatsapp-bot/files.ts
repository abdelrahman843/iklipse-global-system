// What people send, kept whole (0090): every file in a watched group or a
// private chat is stored (the wa-files bucket, private), and what's in it is
// put into the message the bot keeps: a voice note written out (ElevenLabs),
// what a photo shows and what a PDF says (Claude). So Claude reading a group
// knows what a voice note asked, and the bot knows what someone sent it. Only
// the bot reads them; nothing of it is shown in iklipse. Always English, except
// a voice note, written out as it was said. A voice note to the bot in any team
// group is kept and written out too (below), so it's read as what was said.

import { claude, env, iso, str, type Db, type Settings } from "./kit.ts";
import { wahaHeaders } from "./waha.ts";
import { callsBot, type Via } from "./gate.ts";

/** Read when used, so a test can stand in for it. */
const elevenKey = () => env("ELEVEN_API_KEY") || env("ELEVENLABS_API_KEY");
const STT_MODEL = env("ELEVEN_STT_MODEL", "scribe_v1");
export const FILES = "wa-files";
/** Bigger files aren't stored (the bucket's limit). */
const MAX_BYTES = 25 * 1024 * 1024;
/** What Claude reads: photos up to this size, PDFs up to this one. */
const MAX_PHOTO = 5 * 1024 * 1024;
const MAX_PDF = 15 * 1024 * 1024;
/** Tries before a file is left as it is. */
const TRIES = 3;

export type FileKind = "voice" | "audio" | "photo" | "video" | "document" | "sticker";
export interface SentFile {
  kind: FileKind;
  url: string;
  mime: string | null;
  name: string | null;
}

/** A message with a file, from Green API's webhook (or the bridge's, made to look like it): what it is and where WhatsApp has it. */
export function fileOf(md: Record<string, any> | undefined): SentFile | null {
  const t = str(md?.typeMessage);
  const f = md?.fileMessageData ?? {};
  const url = str(f.downloadUrl);
  if (!url) return null;
  const mime = str(f.mimeType) || null;
  const kind: FileKind | null =
    t === "audioMessage" ? (/ogg|opus/i.test(mime ?? "") ? "voice" : "audio")
    : t === "imageMessage" ? "photo"
    : t === "videoMessage" ? "video"
    : t === "documentMessage" ? "document"
    : t === "stickerMessage" ? "sticker"
    : null;
  return kind ? { kind, url, mime, name: str(f.fileName) || null } : null;
}

/** Kept to be stored and read (once per message). */
export async function noteFile(db: Db, o: { id: string; chatId: string; kind: FileKind; url: string; mime: string | null; name: string | null }) {
  const { data } = await db
    .from("wa_file")
    .upsert({ id: o.id, chat_id: o.chatId, kind: o.kind, url: o.url, mime: o.mime, name: o.name?.slice(0, 300) ?? null }, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  return !!data?.length;
}

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};
function extOf(mime: string | null, name: string | null, kind: FileKind) {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(name ?? "")?.[1];
  if (fromName) return fromName.toLowerCase();
  const m = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (EXT[m]) return EXT[m];
  return kind === "voice" ? "ogg" : kind === "photo" ? "jpg" : kind === "sticker" ? "webp" : "bin";
}

/** A voice note, written out as it was said (ElevenLabs Scribe). */
export async function writeOut(bytes: Uint8Array, mime: string | null) {
  const ELEVEN_KEY = elevenKey();
  if (!ELEVEN_KEY) throw new Error("ELEVEN_API_KEY isn't set on the whatsapp-bot function");
  const form = new FormData();
  form.append("model_id", STT_MODEL);
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: (mime ?? "audio/ogg").split(";")[0] }), /mpeg|mp3/i.test(mime ?? "") ? "voice.mp3" : "voice.ogg");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": ELEVEN_KEY }, body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ElevenLabs: ${str(j?.detail?.message) || str(j?.detail) || `error ${res.status}`}`);
  return str(j.text);
}

const READ_SYSTEM = `You read a file someone sent in a WhatsApp chat with iklipse (a creative and marketing agency), so the team's assistant knows what's in it without opening it. Write in English, plainly, no preamble: what it is, then what it says or shows: the text in it (translated to English when it isn't), names, numbers, dates, prices, links, anything asked or agreed. A photo: at most 80 words. A document: at most 250 words.`;

/** What a photo shows, or what a PDF says (Claude). */
async function readWith(s: Settings, kind: "photo" | "pdf", bytes: Uint8Array, mime: string) {
  const block =
    kind === "photo"
      ? { type: "image", source: { type: "base64", media_type: mime, data: base64(bytes) } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64(bytes) } };
  const text = await claude(s, { name: "files.read", role: "fast" }, READ_SYSTEM, [block, { type: "text", text: kind === "photo" ? "The photo." : "The document." }], undefined, 700);
  return str(text).replace(/[—–]/g, ", ");
}

/** What goes into the kept message, before its caption: "[voice note, written out] ..." */
function label(kind: FileKind, name: string | null, text: string) {
  const one = text.replace(/\s+/g, " ").trim();
  switch (kind) {
    case "voice":
    case "audio":
      return `[${kind === "voice" ? "voice note" : "audio"}, written out] ${one}`;
    case "photo":
      return `[photo: ${one}]`;
    default:
      return `[document${name ? `: ${name}` : ""}, it says: ${one}]`;
  }
}

/**
 * One file: stored, then read when reading is on. The message kept for it
 * (in the group, or the private chat) gets what's in it. What it says comes
 * back (null: nothing to read, or it failed).
 */
export async function keepFile(db: Db, s: Settings, id: string): Promise<string | null> {
  // One run at a time: the one that moves it on works on it.
  const { data: f } = await db
    .from("wa_file")
    .select("id, chat_id, kind, mime, name, url, status, tries, path")
    .eq("id", id)
    .maybeSingle();
  if (!f || f.status === "read" || f.tries >= TRIES) return null;
  const { data: mine } = await db.from("wa_file").update({ tries: f.tries + 1 }).eq("id", id).eq("tries", f.tries).select("id");
  if (!mine?.length) return null;
  const kind = f.kind as FileKind;
  try {
    let bytes: Uint8Array | null = null;
    if (f.path) {
      const { data } = await db.storage.from(FILES).download(f.path);
      if (data) bytes = new Uint8Array(await data.arrayBuffer());
    }
    if (!bytes) {
      const res = await fetch(f.url, { headers: wahaHeaders(f.url) });
      if (!res.ok) throw new Error(`WhatsApp's copy: error ${res.status}`);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > MAX_BYTES) {
        await db.from("wa_file").update({ status: "failed", size, error: "Too big to keep", tries: TRIES }).eq("id", id);
        return null;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) {
        await db.from("wa_file").update({ status: "failed", size: bytes.length, error: "Too big to keep", tries: TRIES }).eq("id", id);
        return null;
      }
      const path = `${f.chat_id.replace(/[^\w.-]/g, "_")}/${id.replace(/[^\w.-]/g, "_")}.${extOf(f.mime, f.name, kind)}`;
      const up = await db.storage.from(FILES).upload(path, bytes, { contentType: (f.mime ?? "application/octet-stream").split(";")[0], upsert: true });
      if (up.error) throw new Error(`Storage: ${up.error.message}`);
      await db.from("wa_file").update({ path, size: bytes.length, status: "kept", url: null }).eq("id", id);
    }

    // What's in it: voice notes and audio written out, photos and PDFs read.
    const mime = (f.mime ?? "").split(";")[0].trim().toLowerCase();
    const pdf = mime === "application/pdf" || /\.pdf$/i.test(f.name ?? "");
    const photo = kind === "photo" && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime || "image/jpeg");
    let text = "";
    if (s.read_files) {
      if (kind === "voice" || kind === "audio") text = await writeOut(bytes, f.mime);
      else if (photo && bytes.length <= MAX_PHOTO) text = await readWith(s, "photo", bytes, mime || "image/jpeg");
      else if (kind === "document" && pdf && bytes.length <= MAX_PDF) text = await readWith(s, "pdf", bytes, "application/pdf");
    }
    if (!text) {
      await db.from("wa_file").update({ status: "kept", error: null }).eq("id", id);
      return null;
    }
    await db.from("wa_file").update({ text: text.slice(0, 8000), status: "read", read_at: iso(), error: null }).eq("id", id);
    // The message kept for it says what's in it (its caption after).
    // Privately all of it (the team asks for voice notes written out, 0102); in a group, enough to follow.
    const group = f.chat_id.endsWith("@g.us");
    const said = label(kind, f.name, text).slice(0, group ? 3500 : 8000);
    const table = group ? "wa_message" : "wa_dm";
    const { data: m } = await db.from(table).select("text").eq("id", id).maybeSingle();
    if (m) {
      const caption = str(m.text).replace(/^\[[^\]]*\]\s*/, "");
      await db.from(table).update({ text: `${said}${caption ? ` ${caption}` : ""}`.slice(0, group ? 4000 : 9000) }).eq("id", id);
    }
    return said;
  } catch (e) {
    await db.from("wa_file").update({ status: "failed", error: (e as Error).message.slice(0, 300) }).eq("id", id);
    return null;
  }
}

/** Every minute: files that didn't go through are tried again (a few times). */
export async function keepFiles(db: Db, s: Settings, deadline: number) {
  const { data } = await db
    .from("wa_file")
    .select("id")
    .in("status", ["new", "failed"])
    .lt("tries", TRIES)
    .lt("created_at", iso(Date.now() - 2 * 60_000))
    .gt("created_at", iso(Date.now() - 2 * 24 * 60 * 60_000))
    .order("created_at")
    .limit(5);
  let n = 0;
  for (const f of data ?? []) {
    if (Date.now() > deadline) break;
    if (await keepFile(db, s, f.id)) n++;
  }
  return n;
}

// ------------------------------------------------- voice notes to the bot --
// In a team group the bot hears only what's meant for it (gate.ts), and a voice
// note came to it as "[voice note]": nothing to go on, and no way to @mention
// it. Now one that replies to the bot, or answers what it just asked them, is
// written out first and read as what was said; any other is for the bot when
// what was said starts with its name, and is only read when it's written out
// anyway (a watched group, reading files on), so the team's voice notes to
// each other cost nothing more. Private chats are as they were (index.ts).

/** How long the bot waits on the run writing out a voice note (index.ts, readFileNow). */
const WAIT_MS = 60_000;

/**
 * The bot's name the way a voice note's writing-out may spell it, first in what
 * was said ("Eclipse, ...", "Hey iklipse ...", "يا إيكليبس ...", "Ya robot ..."): made
 * the name callsBot knows. The tag before it ("[voice note, written out]") stays.
 */
const HEARD_NAME = /^(\[[^\]]*\][\s\p{P}]*)(?:(?:hey|hi|hello|ok|okay|ya|يا)[\s\p{P}]*)?(?:[ei](?:c|k|ck)lipse?|[اإأآ]ي?كلي?بس|(?:ro)?bot|روبوت)(?=$|[\s\p{P}\p{S}])/iu;

/** A voice note, or an audio file: what's written out. */
export const spoken = (f: SentFile | null | undefined): f is SentFile => f?.kind === "voice" || f?.kind === "audio";

/** Written out as they come (index.ts, readFileNow): the watch on, the group watched, reading files on. */
async function readAnyway(db: Db, s: Settings, chatId: string) {
  if (!s.enabled || !s.read_files) return false;
  const { data: g } = await db.from("wa_group").select("monitored").eq("chat_id", chatId).maybeSingle();
  return !!g?.monitored;
}

/**
 * A voice note's words for the bot, "[voice note, written out] ...". In a
 * watched group the run the hook started for it writes it out, and that's
 * waited for (one writing-out, not two); elsewhere it's kept and written out
 * here. null: it isn't (reading files off, it failed, or it took over waitMs).
 */
async function wordsIn(db: Db, s: Settings, o: { id: string; chatId: string; file: SentFile }, anyway: boolean, waitMs: number): Promise<string | null> {
  if (!s.read_files) return null;
  if (!anyway) {
    await noteFile(db, { id: o.id, chatId: o.chatId, ...o.file });
    const said = await keepFile(db, s, o.id);
    if (said) return said;
  }
  const until = Date.now() + (anyway ? waitMs : 0);
  for (;;) {
    const { data: f } = await db.from("wa_file").select("kind, name, status, text").eq("id", o.id).maybeSingle();
    if (f?.status === "read" && str(f.text)) return label(f.kind as FileKind, f.name, str(f.text)).slice(0, 3500);
    if (f?.status === "failed" || Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * What a message in a team group says for the bot: a voice note's words once
 * written out, else its text as it came (and when it can't be written out).
 * The meeting conversation's turn for it (book.ts heard), when there's one,
 * says the same, so it's answered by what was said.
 */
export async function wordsOf(db: Db, s: Settings, o: { id: string; chatId: string; file: SentFile | null; text: string }, waitMs = WAIT_MS): Promise<string> {
  if (!spoken(o.file)) return o.text;
  const said = await wordsIn(db, s, { id: o.id, chatId: o.chatId, file: o.file }, await readAnyway(db, s, o.chatId), waitMs);
  if (!said) return o.text;
  await db.from("wa_bot_turn").update({ text: said.slice(0, 4000) }).eq("id", o.id).eq("status", "new");
  return said;
}

/**
 * A voice note in a team group that isn't carrying on a meeting conversation
 * (index.ts): for the bot or not. via: how it came (gate.ts), a reply to the
 * bot or an answer to what it just asked them; then it's written out and read
 * as what was said ("[voice note]" when it can't be). With none, it's for the
 * bot only when what was said starts with its name ("name"), and only one
 * written out anyway is read. null: not for the bot.
 */
export async function voiceToBot(
  db: Db,
  s: Settings,
  o: { id: string; chatId: string; file: SentFile; text: string; via: Via | null },
  waitMs = WAIT_MS,
): Promise<{ text: string; via: Via } | null> {
  const anyway = await readAnyway(db, s, o.chatId);
  if (o.via) return { text: (await wordsIn(db, s, o, anyway, waitMs)) ?? o.text, via: o.via };
  if (!anyway) return null;
  const named = (await wordsIn(db, s, o, true, waitMs))?.replace(HEARD_NAME, "$1iklipse");
  return named && callsBot(named) ? { text: named, via: "name" } : null;
}
