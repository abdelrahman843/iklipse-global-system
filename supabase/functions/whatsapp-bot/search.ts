// Search that understands Arabic and meaning (0113). find (look.ts) matches
// words as written, so an English question misses an Egyptian Arabic or
// Franco message. Here, what was said (group messages, private chats with the
// bot, emails, Slack, the words read out of files, recorded meetings) is kept
// in pieces, with Arabic letters made one form for keywords and, once an
// embedding provider is set (embed.ts), an embedding for meaning. search
// finds pieces by both together, only among what the asker may read (find's
// rules, applied in the database before anything is ranked, and checked again
// here). The minute's run cuts what's new into pieces and embeds them, newest
// first, and the backfill a few hundred a minute (indexSome).

import { cairoStamp, str, type ClaudeTool, type Db } from "./kit.ts";
import { BATCH, embedder, type Embedder } from "./embed.ts";
import type { Me } from "./look.ts";

export type Source = "wa_message" | "wa_dm" | "mail_message" | "slack_message" | "wa_file" | "fireflies";

/** A piece of what was said, as kept in bot_search_chunk. */
export interface Piece {
  source: Source;
  source_id: string;
  part: number;
  at: string | null;
  chat_id: string | null;
  account_id: string | null;
  meeting_id: string | null;
  place: string | null;
  who: string | null;
  text: string;
}

/** About this many characters a piece (a few hundred words), and at most this many pieces of one thing. */
const PIECE = 1500;
const MAX_PIECES: Record<Source, number> = { wa_message: 4, wa_dm: 4, slack_message: 4, mail_message: 4, wa_file: 8, fireflies: 40 };

/** Text cut into pieces of about PIECE characters, at a line or sentence end when there's one. */
export function cut(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  while (rest && out.length < max) {
    if (rest.length <= PIECE) {
      out.push(rest);
      break;
    }
    const window = rest.slice(0, PIECE);
    const end = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("؟"), window.lastIndexOf("? "));
    const at = end > PIECE / 2 ? end + 1 : PIECE;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return out.filter(Boolean);
}

/** An email without the earlier messages it quotes ("On ... wrote:", "> ..."). */
const ownWords = (body: string) =>
  body
    .split(/\n(?:On .{5,200} wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/i)[0]!
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n");

// ------------------------------------------------------- cutting pieces --

type Row = Record<string, unknown>;
const s = (x: unknown) => str(x).trim();

/** The pieces of one row (one source's columns, as read in readRows). */
export function piecesOf(source: Source, r: Row): Piece[] {
  const base = { source, part: 0, chat_id: null, account_id: null, meeting_id: null, place: null, who: null } as Omit<Piece, "source_id" | "at" | "text">;
  let id = s(r.id);
  let at: string | null = null;
  let text = "";
  switch (source) {
    case "wa_message":
      Object.assign(base, { chat_id: s(r.chat_id), place: (r.wa_group as { name?: string } | null)?.name ?? "a WhatsApp group", who: s(r.sender_name) || null });
      at = s(r.sent_at);
      text = s(r.text);
      break;
    case "wa_dm":
      Object.assign(base, { chat_id: s(r.chat_id), place: "a private chat with the bot", who: r.from_bot ? "the bot" : s(r.sender_name) || null });
      at = s(r.sent_at);
      text = s(r.text);
      break;
    case "mail_message":
      Object.assign(base, { account_id: s(r.account_id), place: `the email "${s(r.subject) || "(no subject)"}"`, who: s(r.from_name) || s(r.from_addr) || null });
      at = s(r.sent_at) || null;
      text = [s(r.subject), ownWords(s(r.body))].filter(Boolean).join("\n");
      break;
    case "slack_message":
      id = `${s(r.channel_id)}:${s(r.ts)}`;
      Object.assign(base, { chat_id: s(r.channel_id), place: r.channel_name ? `#${s(r.channel_name)}` : "Slack", who: s(r.who) || null });
      at = s(r.sent_at) || null;
      text = s(r.text);
      break;
    case "wa_file":
      Object.assign(base, { chat_id: s(r.chat_id), place: `the file ${s(r.name) || "sent on WhatsApp"}` });
      at = s(r.created_at) || null;
      text = s(r.text);
      break;
    case "fireflies": {
      Object.assign(base, { account_id: s(r.account_id), meeting_id: id, place: `the meeting "${s(r.title) || "Untitled"}"` });
      at = s(r.started_at) || null;
      const sum = (r.summary ?? {}) as Record<string, unknown>;
      const summary = ["overview", "short_summary", "action_items", "keywords"].map((k) => s(Array.isArray(sum[k]) ? (sum[k] as unknown[]).join(", ") : sum[k])).filter(Boolean);
      const said = ((r.sentences ?? []) as { s?: string; t?: string }[]).map((x) => `${s(x.s) || "Speaker"}: ${s(x.t)}`).filter((l) => !l.endsWith(": "));
      text = [s(r.title), ...summary, ...said].join("\n");
      break;
    }
  }
  return cut(text, MAX_PIECES[source]).map((t, part) => ({ ...base, source_id: id, at, part, text: t }));
}

/** The rows of one source by their queued ids, read with what their pieces need. */
async function readRows(db: Db, source: Source, ids: string[]): Promise<Map<string, Row>> {
  const byId = (rows: Row[], key = (r: Row) => s(r.id)) => new Map(rows.map((r) => [key(r), r]));
  switch (source) {
    case "wa_message": {
      const { data, error } = await db.from("wa_message").select("id, chat_id, sender_name, text, sent_at, wa_group(name)").in("id", ids);
      if (error) throw new Error(error.message);
      return byId((data ?? []) as Row[]);
    }
    case "wa_dm": {
      const { data, error } = await db.from("wa_dm").select("id, chat_id, from_bot, sender_name, text, sent_at").in("id", ids);
      if (error) throw new Error(error.message);
      return byId((data ?? []) as Row[]);
    }
    case "mail_message": {
      const { data, error } = await db.from("mail_message").select("id, account_id, from_name, from_addr, subject, body, sent_at").in("id", ids);
      if (error) throw new Error(error.message);
      return byId((data ?? []) as Row[]);
    }
    case "slack_message": {
      const pairs = ids.map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 1)] as const);
      const [{ data, error }, { data: chans }] = await Promise.all([
        db.from("slack_message").select("channel_id, ts, slack_id, text, sent_at").in("channel_id", [...new Set(pairs.map((p) => p[0]))]).in("ts", pairs.map((p) => p[1])),
        db.from("slack_channel").select("channel_id, name").in("channel_id", [...new Set(pairs.map((p) => p[0]))]),
      ]);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      const { data: users } = await db.from("slack_user").select("slack_id, name, real_name").in("slack_id", [...new Set(rows.map((r) => s(r.slack_id)).filter(Boolean))]);
      const chan = new Map(((chans ?? []) as Row[]).map((c) => [s(c.channel_id), s(c.name)]));
      const user = new Map(((users ?? []) as Row[]).map((u) => [s(u.slack_id), s(u.real_name) || s(u.name)]));
      return byId(
        rows.map((r) => ({ ...r, channel_name: chan.get(s(r.channel_id)) ?? null, who: user.get(s(r.slack_id)) ?? null })),
        (r) => `${s(r.channel_id)}:${s(r.ts)}`,
      );
    }
    case "wa_file": {
      const { data, error } = await db.from("wa_file").select("id, chat_id, name, text, created_at").in("id", ids);
      if (error) throw new Error(error.message);
      return byId((data ?? []) as Row[]);
    }
    case "fireflies": {
      const { data, error } = await db.from("fireflies_meeting").select("id, account_id, title, started_at, summary, sentences").in("id", ids);
      if (error) throw new Error(error.message);
      return byId((data ?? []) as Row[]);
    }
  }
}

/**
 * What's queued, cut into pieces (newest first), then pieces embedded while
 * there's time. How many were; null before 0113 runs.
 */
export async function indexSome(db: Db, deadline: number, e: Embedder | null = embedder(), take = 300): Promise<{ indexed: number; pieces: number; embedded: number } | null> {
  const { data, error } = await db.rpc("_search_take", { p_limit: take });
  if (error) return null;
  const queued = (data ?? []) as { source: Source; source_id: string }[];
  let indexed = 0;
  let pieces = 0;
  for (const source of [...new Set(queued.map((q) => q.source))]) {
    const ids = queued.filter((q) => q.source === source).map((q) => q.source_id);
    try {
      const rows = await readRows(db, source, ids);
      const fresh = [...rows.values()].flatMap((r) => piecesOf(source, r));
      // Gone, or nothing said: no pieces. Else the new pieces in place of the old ones.
      await db.from("bot_search_chunk").delete().eq("source", source).in("source_id", ids);
      if (fresh.length) {
        const { error: e2 } = await db.from("bot_search_chunk").insert(fresh.map((p) => ({ ...p, tries: 0 })));
        if (e2) throw new Error(e2.message);
      }
      await db.from("bot_search_queue").delete().eq("source", source).in("source_id", ids);
      indexed += ids.length;
      pieces += fresh.length;
    } catch (e1) {
      // Left queued: taken again in a few minutes, up to five times.
      await db.from("bot_search_queue").update({ error: (e1 as Error).message.slice(0, 300) }).eq("source", source).in("source_id", ids);
      console.error("search index", source, (e1 as Error).message);
    }
  }
  const embedded = e ? await embedSome(db, e, deadline) : 0;
  return { indexed, pieces, embedded };
}

/** Pieces without an embedding (or with another model's), embedded a batch at a time while there's time. */
export async function embedSome(db: Db, e: Embedder, deadline: number, batches = 4): Promise<number> {
  let done = 0;
  for (let b = 0; b < batches && Date.now() < deadline - 15_000; b++) {
    const { data } = await db
      .from("bot_search_chunk")
      .select("id, text, tries")
      .or(`embedding.is.null,model.neq.${e.model}`)
      .lt("tries", 5)
      .order("at", { ascending: false })
      .limit(BATCH);
    const rows = (data ?? []) as { id: number; text: string; tries: number }[];
    if (!rows.length) break;
    try {
      const vs = await e.embed(rows.map((r) => r.text), "document", Math.max(5_000, Math.min(30_000, deadline - Date.now() - 5_000)));
      const { error } = await db.rpc("_search_set_embeddings", { p: rows.map((r, i) => ({ id: r.id, e: JSON.stringify(vs[i]) })), p_model: e.model });
      if (error) throw new Error(error.message);
      done += rows.length;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      console.error("search embed", e.provider, msg);
      // Tried once more: after five times a piece is left to keywords.
      for (const tries of new Set(rows.map((r) => r.tries))) {
        await db.from("bot_search_chunk").update({ tries: tries + 1, error: msg }).in("id", rows.filter((r) => r.tries === tries).map((r) => r.id));
      }
      break;
    }
  }
  return done;
}

// ------------------------------------------------------------ searching --

/** Where to look, as Claude asks for it, and the sources it means. */
const WHERE: Record<string, Source[]> = {
  groups: ["wa_message"],
  private: ["wa_dm"],
  email: ["mail_message"],
  slack: ["slack_message"],
  files: ["wa_file"],
  meetings: ["fireflies"],
};

export const SEARCH_TOOL: ClaudeTool = {
  name: "search",
  description:
    "Searches what people said, by meaning and by words, in any language: a question in English finds Egyptian Arabic and Franco-Arabic messages too. In the WhatsApp groups, the bot's private chats, email, Slack, files and recorded meetings, only what this person may read. Use it for what was said about something (\"what did Acme say about the logo\", \"when did we talk about the price\"); use find for exact lookups (a table, an id, dates, counts). Gives the pieces that match: where, who, when, the words.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to look for, in a few words (any language)." },
      in: { type: "array", items: { type: "string", enum: Object.keys(WHERE) }, description: "Where to look; everywhere when empty." },
      since: { type: "string", description: "Only what was said since this day or time (ISO 8601 with Cairo's offset). Else empty." },
      limit: { type: "integer", description: "How many pieces, up to 30 (default 12)." },
    },
    required: ["text"],
  },
};

export interface Search {
  text?: string;
  in?: string[];
  since?: string;
  limit?: number;
}

/** A piece as bot_search gives it back. */
interface Found extends Piece {
  id: number;
  score: number;
}

/** find's rules for who may read what (look.ts), checked again on what comes back. */
export function mayRead(me: Me, p: Pick<Piece, "source" | "chat_id" | "account_id" | "meeting_id">): boolean {
  switch (p.source) {
    case "wa_dm":
      return me.admin || me.dms.includes(str(p.chat_id));
    case "wa_file":
      return me.admin || str(p.chat_id).endsWith("@g.us") || me.dms.includes(str(p.chat_id));
    case "mail_message":
      return me.mail.includes(str(p.account_id));
    case "fireflies":
      return me.ffAccounts.includes(str(p.account_id)) || me.ffMeetings.includes(str(p.meeting_id));
    default:
      return true;
  }
}

export class SearchRefused extends Error {}

/** The pieces that match, as Claude reads them (like find's answer). */
export async function search(db: Db, me: Me, q: Search, e: Embedder | null = embedder()): Promise<string> {
  const text = str(q.text).trim().slice(0, 300);
  if (!text) throw new SearchRefused("search needs words to look for.");
  const unknown = (q.in ?? []).filter((w) => !WHERE[w]);
  if (unknown.length) throw new SearchRefused(`Unknown place ${unknown.join(", ")}: ${Object.keys(WHERE).join(", ")}.`);
  const sources = (q.in?.length ? q.in : Object.keys(WHERE)).flatMap((w) => WHERE[w]!);
  const since = q.since && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since).toISOString() : null;

  // Meaning too when there's a provider; its failing leaves the words.
  let vec: number[] | null = null;
  let note: string | null = e ? null : "By words only (no embedding provider set).";
  if (e) {
    try {
      vec = (await e.embed([text], "query", 10_000))[0] ?? null;
    } catch (err) {
      console.error("search query", (err as Error).message);
      note = "By words only this time (the embedding provider didn't answer).";
    }
  }
  const { data, error } = await db.rpc("bot_search", {
    p_query: text,
    p_embedding: vec ? JSON.stringify(vec) : null,
    p_model: e?.model ?? null,
    p_sources: sources,
    p_scope: { admin: me.admin, dms: me.dms, mail: me.mail, ff_accounts: me.ffAccounts, ff_meetings: me.ffMeetings },
    p_since: since,
    p_limit: Math.max(1, Math.min(Number(q.limit) || 12, 30)),
  });
  if (error) throw new SearchRefused(/bot_search/.test(error.message) ? "Search isn't set up yet (0113)." : "That search failed.");
  const found = ((data ?? []) as Found[]).filter((p) => mayRead(me, p));
  return JSON.stringify({
    by: vec ? "meaning and words" : "words",
    ...(note ? { note } : {}),
    found: found.map((p) => ({
      where: p.place,
      who: p.who,
      when: p.at ? `${cairoStamp.format(new Date(p.at))} Cairo time` : null,
      text: p.text.slice(0, 700),
    })),
  });
}
