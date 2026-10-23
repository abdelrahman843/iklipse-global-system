// What the bot remembers about each client (0112), so it doesn't depend on the
// last few dozen messages alone: short notes, written by Claude from what was
// said in their WhatsApp chats (their private chat with the bot, both sides,
// and what they wrote in the groups). Facts about them and their work, what
// they like and don't, and what's still open. Only what the messages say,
// never a guess. Never from email: email stays with its mailbox (look.ts).
// Updated in the minute's run once a client's chats have been quiet 30
// minutes, a few clients a run. Each line says whether it was said only in
// their private chat: those lines are for admins and for their own chat with
// the bot, like the private chat itself. Used when the bot answers them
// (dm.ts) and when the team asks about them (orders.ts).

import { cairoStamp, claude, str, type ClaudeTool, type Db, type Settings } from "./kit.ts";

/** A line of the notes; private: said only in their private chat with the bot. */
export interface Line {
  text: string;
  private: boolean;
}
export interface Notes {
  facts: Line[];
  likes: Line[];
  open: Line[];
}

/** At most this many lines in each part of the notes. */
const MAX_LINES = 8;
const oneLine = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);

const LINE = {
  type: "object",
  properties: {
    text: { type: "string", description: "One short line, in English." },
    private: { type: "boolean", description: "true when it was said only in the private chat (PRIVATE lines), never in a group." },
  },
  required: ["text", "private"],
};
const TOOL: ClaudeTool = {
  name: "notes",
  description: "The client's notes, as they stand now.",
  input_schema: {
    type: "object",
    properties: {
      facts: { type: "array", items: LINE, description: "Facts about them and their work: who they are, their business, their projects, people they mention, where they are." },
      likes: { type: "array", items: LINE, description: "What they like and don't: how they want to be talked to, times that suit them, styles, what upset them." },
      open: { type: "array", items: LINE, description: "What's still open: what they asked for or are waiting on, what was promised to them, with dates when said." },
    },
    required: ["facts", "likes", "open"],
  },
};

const SYSTEM = `You keep short notes on a client of iklipse (a creative and marketing agency), so the team's assistant remembers them. You get the notes so far and the new messages: their private chat with the assistant (PRIVATE, both sides: THEM and IKLIPSE) and what they wrote in WhatsApp groups (GROUP). They write in English, Arabic, Egyptian Arabic or Franco-Arabic; the notes are in English.
Give the notes as they stand now, through the notes tool, once:
- Keep what's still true from the notes so far; change what the new messages change; drop what's settled, done or no longer true.
- Only what the messages say. Never guess, never add what isn't said, never judge them.
- private: true for something said only in PRIVATE messages; false once it's said in a GROUP.
- Never keep money owed, passwords, card or bank details, or anything about their health or family beyond what the work needs.
- Short lines, at most ${MAX_LINES} in each part; the most useful first.`;

const lines = (x: unknown): Line[] =>
  (Array.isArray(x) ? x : [])
    .map((l) => ({ text: oneLine(str((l as Line)?.text), 200), private: (l as Line)?.private !== false }))
    .filter((l) => l.text)
    .slice(0, MAX_LINES);

/** The notes as Claude reads and writes them. */
function notesText(n: Notes) {
  const part = (title: string, ls: Line[]) => (ls.length ? [`${title}:`, ...ls.map((l) => `- ${l.text}${l.private ? " (private)" : ""}`)] : []);
  return [...part("Facts", n.facts), ...part("Likes", n.likes), ...part("Open", n.open)].join("\n") || "None yet.";
}

/**
 * The notes for someone to read, or null with none: everything for admins and
 * for the client's own chat; for anyone else, only what was said in groups.
 */
export function memoryFor(n: Partial<Notes> | null | undefined, seePrivate: boolean): string | null {
  if (!n) return null;
  const keep = (ls: Line[] | undefined) => (ls ?? []).filter((l) => seePrivate || !l.private);
  const out = notesText({ facts: keep(n.facts), likes: keep(n.likes), open: keep(n.open) });
  return out === "None yet." ? null : out;
}

/** A client's notes, or null (none yet, or before 0112 runs). */
export async function memoryOf(db: Db, clientId: string | null | undefined): Promise<Notes | null> {
  if (!clientId) return null;
  const { data, error } = await db.from("bot_client_memory").select("notes").eq("client_id", clientId).maybeSingle();
  if (error || !data) return null;
  return data.notes as Notes;
}

/**
 * The clients whose chats have something new and went quiet: their notes
 * brought up to date, a few a run. How many were.
 */
export async function rememberClients(db: Db, s: Settings, deadline: number, limit = 3): Promise<number> {
  const { data, error } = await db.rpc("_bot_memory_due", { p_limit: limit });
  // Before 0112 runs: nothing to remember into.
  if (error) return 0;
  let done = 0;
  for (const { client_id } of (data ?? []) as { client_id: string }[]) {
    if (Date.now() > deadline) {
      await db.from("bot_client_memory").update({ claimed_at: null }).eq("client_id", client_id);
      continue;
    }
    try {
      if (await rememberOne(db, s, client_id)) done++;
    } catch (e) {
      console.error("memory", client_id, (e as Error).message);
      await db.from("bot_client_memory").update({ claimed_at: null }).eq("client_id", client_id);
    }
  }
  return done;
}

/** One client's notes, brought up to date with what they said since. */
export async function rememberOne(db: Db, s: Settings, clientId: string): Promise<boolean> {
  const [{ data: c }, { data: mem }] = await Promise.all([
    db.from("client").select("id, name, company, phone_key").eq("id", clientId).maybeSingle(),
    db.from("bot_client_memory").select("notes, through_at").eq("client_id", clientId).maybeSingle(),
  ]);
  const phone = str(c?.phone_key);
  if (!c || !phone) {
    await db.from("bot_client_memory").update({ claimed_at: null }).eq("client_id", clientId);
    return false;
  }
  const since = str(mem?.through_at) || null;
  let dms = db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", `${phone}@c.us`);
  let groups = db.from("wa_message").select("text, sent_at, wa_group(name)").eq("phone", phone).eq("from_bot", false);
  if (since) {
    dms = dms.gt("sent_at", since);
    groups = groups.gt("sent_at", since);
  }
  const [{ data: d }, { data: g }] = await Promise.all([
    dms.order("sent_at", { ascending: false }).limit(80),
    groups.order("sent_at", { ascending: false }).limit(60),
  ]);
  const said = [
    ...((d ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[]).map((m) => ({ at: m.sent_at, line: `PRIVATE ${m.from_bot ? "IKLIPSE" : "THEM"}: ${oneLine(str(m.text), 600)}`, text: m.text })),
    ...((g ?? []) as unknown as { text: string | null; sent_at: string; wa_group: { name: string | null } | null }[]).map((m) => ({ at: m.sent_at, line: `GROUP ${m.wa_group?.name ?? "a group"}, THEM: ${oneLine(str(m.text), 600)}`, text: m.text })),
  ]
    .filter((m) => str(m.text))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const through = said.at(-1)?.at ?? since;
  if (!said.length) {
    await db.from("bot_client_memory").update({ claimed_at: null, through_at: through }).eq("client_id", clientId);
    return false;
  }
  const before: Notes = { facts: lines(mem?.notes?.facts), likes: lines(mem?.notes?.likes), open: lines(mem?.notes?.open) };
  const user = [
    `The client: ${c.name}${c.company ? ` (${c.company})` : ""}`,
    "",
    "The notes so far:",
    notesText(before),
    "",
    "New messages:",
    ...said.map((m) => `[${cairoStamp.format(new Date(m.at))}] ${m.line}`),
  ].join("\n");
  const r = (await claude(s, { name: "memory.write", role: "fast" }, SYSTEM, user, TOOL, 1200)) as Partial<Record<keyof Notes, unknown>> | null;
  if (!r) throw new Error("Claude gave no notes");
  const notes: Notes = { facts: lines(r.facts), likes: lines(r.likes), open: lines(r.open) };
  await db
    .from("bot_client_memory")
    .update({ notes, through_at: through, updated_at: new Date().toISOString(), claimed_at: null })
    .eq("client_id", clientId);
  return true;
}
