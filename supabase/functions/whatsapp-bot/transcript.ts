// Recordings written out into one .md file, sent on WhatsApp (the brain's
// transcripts tool): "transcribe these voice notes and send me the file".
// The voice notes and audio files sent in a chat (wa_file, files.ts), and
// Fireflies' recorded meetings when their transcript is kept. A file kept
// with only part of its words (a long one is cut at 8,000 characters) is
// written out again whole from the stored copy; one not stored yet is kept
// first. The file goes through storage (a link that lasts an hour) and is
// sent as a document, where it was asked.

import { cairoStamp, iso, str, type Db, type Settings } from "./kit.ts";
import { FILES, keepFile, writeOut } from "./files.ts";

/** A record's words cut at this when kept (files.ts keepFile): one this long is written out again. */
const CUT_AT = 8000;
const MAX_RECORDS = 30;

export interface Recording {
  title: string;
  at: string | null;
  by: string | null;
  text: string | null;
  /** Why there are no words. */
  why?: string;
}

const when = (at: string | null) => (at ? `${cairoStamp.format(new Date(at))} (Cairo)` : "");

/** The .md file: a title, then each record under its own heading, in order. */
export function markdownOf(title: string, records: Recording[]) {
  const parts = [`# ${title}`, "", `${records.length} recording${records.length === 1 ? "" : "s"}, written out ${when(iso())}.`];
  records.forEach((r, i) => {
    parts.push("", `## ${i + 1}. ${r.title}`);
    const meta = [r.by, when(r.at)].filter(Boolean).join(", ");
    if (meta) parts.push(`*${meta}*`);
    parts.push("", r.text?.trim() || `_No transcript: ${r.why ?? "nothing could be written out"}._`);
  });
  return `${parts.join("\n")}\n`;
}

/** A file name for it: letters, digits and dashes, ".md". */
export const fileNameOf = (title: string) =>
  `${
    title
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "transcripts"
  }.md`;

interface FileRow {
  id: string;
  chat_id: string;
  kind: string;
  mime: string | null;
  name: string | null;
  path: string | null;
  text: string | null;
  status: string | null;
  created_at: string;
}
const FILE_COLS = "id, chat_id, kind, mime, name, path, text, status, created_at";

/** Which recordings: by id, else the last ones in a chat (since a time). */
export async function recordingsOf(db: Db, o: { ids: string[]; chat: string | null; since: string | null; last: number }): Promise<FileRow[]> {
  if (o.ids.length) {
    const { data } = await db.from("wa_file").select(FILE_COLS).in("id", o.ids.slice(0, MAX_RECORDS));
    const rows = (data ?? []) as FileRow[];
    return o.ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is FileRow => !!r);
  }
  if (!o.chat) return [];
  let q = db.from("wa_file").select(FILE_COLS).eq("chat_id", o.chat).in("kind", ["voice", "audio"]);
  if (o.since) q = q.gte("created_at", o.since);
  const { data } = await q.order("created_at", { ascending: false }).limit(Math.min(Math.max(o.last, 1), MAX_RECORDS));
  return ((data ?? []) as FileRow[]).reverse();
}

/** One recording's words, whole: stored first when it isn't, written out again when it was cut. */
async function wordsOf(db: Db, s: Settings, f: FileRow): Promise<{ text: string | null; why?: string }> {
  if (!["voice", "audio", "video"].includes(f.kind)) return { text: null, why: `it's a ${f.kind}, not a recording` };
  let row = f;
  if (!row.path) {
    await keepFile(db, s, row.id);
    const { data } = await db.from("wa_file").select(FILE_COLS).eq("id", row.id).maybeSingle();
    if (data) row = data as FileRow;
  }
  const kept = str(row.text);
  if (kept && kept.length < CUT_AT) return { text: kept };
  if (!row.path) return kept ? { text: kept } : { text: null, why: "the recording couldn't be downloaded from WhatsApp" };
  try {
    const { data } = await db.storage.from(FILES).download(row.path);
    if (!data) return kept ? { text: kept } : { text: null, why: "the stored copy is missing" };
    const whole = await writeOut(new Uint8Array(await data.arrayBuffer()), row.mime);
    return whole ? { text: whole } : { text: kept || null, why: "no speech in it" };
  } catch (e) {
    return kept ? { text: kept } : { text: null, why: (e as Error).message.slice(0, 200) };
  }
}

/** Who sent each one, from the message kept for it. */
async function sendersOf(db: Db, rows: FileRow[]) {
  const ids = rows.map((r) => r.id);
  const [{ data: g }, { data: d }] = await Promise.all([
    db.from("wa_message").select("id, sender_name, from_bot, sent_at").in("id", ids),
    db.from("wa_dm").select("id, sender_name, from_bot, sent_at").in("id", ids),
  ]);
  const by = new Map<string, { name: string | null; at: string | null }>();
  for (const m of [...(g ?? []), ...(d ?? [])] as { id: string; sender_name: string | null; from_bot: boolean; sent_at: string }[]) {
    by.set(m.id, { name: m.from_bot ? "iklipse bot" : str(m.sender_name) || null, at: m.sent_at });
  }
  return by;
}

/** Fireflies' recorded meetings, by id: their kept transcript (speaker: words). */
async function meetingsOf(db: Db, ids: string[]): Promise<Recording[]> {
  if (!ids.length) return [];
  const { data } = await db.from("fireflies_meeting").select("id, title, started_at, sentences").in("id", ids.slice(0, MAX_RECORDS));
  const rows = (data ?? []) as { id: string; title: string | null; started_at: string | null; sentences: { speaker_name?: string; text?: string }[] | null }[];
  return ids.map((id): Recording => {
    const m = rows.find((r) => r.id === id);
    if (!m) return { title: `Meeting ${id}`, at: null, by: null, text: null, why: "no such recorded meeting" };
    const lines: string[] = [];
    for (const x of m.sentences ?? []) {
      const who = str(x.speaker_name) || "Speaker";
      const said = str(x.text);
      if (!said) continue;
      // One speaker's sentences in a row: one paragraph.
      const lastLine = lines.at(-1);
      if (lastLine?.startsWith(`**${who}:** `)) lines[lines.length - 1] = `${lastLine} ${said}`;
      else lines.push(`**${who}:** ${said}`);
    }
    return { title: str(m.title) || "Recorded meeting", at: m.started_at, by: "Fireflies", text: lines.join("\n\n") || null, why: "its transcript isn't in iklipse yet (open it once on the Meetings page)" };
  });
}

/** The records written out, in order: WhatsApp's first, then the meetings. */
export async function transcribe(db: Db, s: Settings, o: { ids: string[]; chat: string | null; since: string | null; last: number; meetings: string[] }): Promise<Recording[]> {
  const rows = await recordingsOf(db, o);
  const senders = rows.length ? await sendersOf(db, rows) : new Map();
  const out: Recording[] = [];
  for (const f of rows) {
    const w = await wordsOf(db, s, f);
    const m = senders.get(f.id);
    out.push({ title: f.name || (f.kind === "voice" ? "Voice note" : f.kind === "video" ? "Video" : "Audio"), at: m?.at ?? f.created_at, by: m?.name ?? null, ...w });
  }
  return [...out, ...(await meetingsOf(db, o.meetings))];
}

/** The .md file kept in storage, and a link to it that lasts an hour. */
export async function linkTo(db: Db, name: string, md: string) {
  const path = `transcripts/${crypto.randomUUID()}/${name}`;
  const up = await db.storage.from(FILES).upload(path, new TextEncoder().encode(md), { contentType: "text/markdown", upsert: false });
  if (up.error) throw new Error(`Storage: ${up.error.message}`);
  const { data, error } = await db.storage.from(FILES).createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) throw new Error(`Storage: ${error?.message ?? "no link"}`);
  return data.signedUrl;
}
