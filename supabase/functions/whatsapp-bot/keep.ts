// What the hook (index.ts) keeps of a message, besides the message itself.
//
// A team group not watched (watching off, or the group not watched) still
// keeps what gate.ts reads to know a reply to the bot, or an answer to what it
// just asked: the bot's own messages, and who wrote one that reached it, not
// their words, so none are searched or found (search.ts, look.ts). Their talk
// with each other isn't kept. No files read, no alerts.
//
// An edit (Green API's editedMessage; WAHA's message.edited, made into that
// in waha.ts) isn't a new message: it's the one it changes, with new words.
// The words are kept on that one, and it goes on as that one, by its id, so
// nothing done with it (an order, a reminder, a post, an answer: each once per
// id, people.ts firstTime) is done twice. One the bot already acted on goes no
// further; in a team group where the bot answered it, someone on the team is
// asked once what should change, since the edit itself changed nothing. But an
// answer to the bot's question about a reply that's still waiting (dm.ts) is
// that answer now: an OK the guard caught, edited into "send anyway", sends it.

import { str, type Db, type Team } from "./kit.ts";
import { firstTime } from "./people.ts";
import { draftFor } from "./dm.ts";
import { onTheTeam } from "./orders.ts";

/**
 * What the hook does with a group message after the gate: "watch" (watching
 * on, the group watched or new): kept, its files read, the group read for
 * alerts; "keep" (not watched, a team group): only what the gate reads is kept
 * (kept); null: nothing.
 */
export function keeping(watching: boolean, g: { monitored?: boolean | null; kind?: string | null } | null): "watch" | "keep" | null {
  if (watching && (!g || g.monitored)) return "watch";
  return g?.kind === "team" ? "keep" : null;
}

/** A group message as the hook keeps it (wa_message). */
export interface Kept {
  id: string;
  chat_id: string;
  sender_id: string | null;
  phone: string | null;
  sender_name: string | null;
  from_bot: boolean;
  text: string | null;
  quoted_id: string | null;
  sent_at: string;
}

/**
 * What's kept of a group message. Watched: all of it. Only kept ("keep"): the
 * bot's own messages whole (a reply to one, and what it asked, gate.ts); of
 * anyone else's, only one that reached the bot (forBot), and only who wrote it
 * and when (gate.ts askedThem): no words, so nothing of it is searched or found.
 * null: not kept.
 */
export function kept(keep: "watch" | "keep", m: Kept, forBot: boolean): Kept | null {
  if (keep === "watch" || m.from_bot) return m;
  return forBot ? { ...m, sender_name: null, text: null, quoted_id: null } : null;
}

/** The id of the message an edit changes, or null when it isn't an edit (or doesn't say which). */
export function editedId(md: Record<string, any> | undefined): string | null {
  if (str(md?.typeMessage) !== "editedMessage") return null;
  return str(md?.editedMessageData?.stanzaId) || null;
}

/** The bot did something with this message: one of its once-per-message marks (people.ts firstTime), or a meeting turn (book.ts heard). */
export async function actedOn(db: Db, id: string): Promise<boolean> {
  const [{ data: marks }, { data: turn }] = await Promise.all([
    db.from("bot_heard").select("id").in("id", [id, `order:${id}`, `follow:${id}`, `target:${id}`]).limit(1),
    db.from("wa_bot_turn").select("id").eq("id", id).limit(1),
  ]);
  return !!(marks?.length || turn?.length);
}

/** Said once, as a reply to a message the bot answered, when it's edited after: a question, so their answer reaches it (gate.ts). */
export const EDIT_NOTE = "I'd already acted on this before you edited it, so I didn't change anything. What should I change?";

export interface Edit {
  /** The message it changes. */
  id: string;
  /** Its words now, as kept (a file's tag, with what's in it, stays first). */
  text: string;
  /** What that message quoted, as kept (an edit doesn't say). */
  quotedId: string | null;
  /** The bot already acted on it (or this same edit came already): the edit goes no further. */
  done: boolean;
  /** What to tell them (a reply to it) when done: once, in a team group where the bot answered it, to someone on the team. */
  note: string | null;
  /**
   * Done, but it answered the bot's question about a reply that's still waiting
   * (dm.ts): its new words answer it now, as index.ts fromTeam takes an answer
   * (the question's message it replies to, who wrote it), once per edit.
   */
  answers: { chatId: string; quotedId: string; phone: string | null; lid: string | null; once: string } | null;
}

/** Who wrote a group message, as the team knows them: by their number, else by their WhatsApp id. */
const sentBy = (t: Team, m: { phone?: string | null; sender_id?: string | null } | null) =>
  (m?.phone ? t.byPhone.get(m.phone) : undefined) ?? (m?.sender_id ? t.byLid.get(m.sender_id) : undefined);

/**
 * An edit, linked to the message it changes, its new words kept on that one
 * (wa_message in a group, wa_dm privately). null: it isn't an edit. own: the
 * edit's own id, so the same edit sent again (a webhook retried) does nothing.
 * team: who's on it (index.ts team), for the note: without it, nobody's told.
 */
export async function editOf(
  db: Db,
  o: { md: Record<string, any> | undefined; chatId: string; text: string; mine: boolean; own?: string; team?: () => Promise<Team> },
): Promise<Edit | null> {
  const id = editedId(o.md);
  if (!id) return null;
  const group = o.chatId.endsWith("@g.us");
  const table = group ? "wa_message" : "wa_dm";
  // In a group, who wrote it too (wa_dm keeps none).
  const cols = group ? "text, quoted_id, chat_id, phone, sender_id" : "text, quoted_id, chat_id";
  const { data: was } = (await db.from(table).select(cols).eq("id", id).maybeSingle()) as { data: Record<string, any> | null };
  // A file's caption edited: its tag (and what's in it, files.ts) stays first.
  const tag = /^\[(photo|video|document|sticker)\b[^\]]*\]/.exec(str(was?.text))?.[0];
  const text = tag && !o.text.startsWith(tag) ? `${tag} ${o.text}` : o.text;
  // One kept without its words (kept: a group not watched) stays without them.
  if (str(was?.text)) await db.from(table).update({ text: text.slice(0, group ? 4000 : 9000) }).eq("id", id);
  const quotedId = (was?.quoted_id as string | null | undefined) ?? null;
  // The same edit again: what came of it the first time stands (it may have gone on and been acted on: no note).
  if (o.own && o.own !== id && !(await firstTime(db, `edited:${o.own}`))) return { id, text, quotedId, done: true, note: null, answers: null };
  const done = await actedOn(db, id);
  if (!done || o.mine) return { id, text, quotedId, done, note: null, answers: null };
  const chat = str(was?.chat_id) || o.chatId;
  const { data: replies } = await db.from(table).select("id").eq("chat_id", chat).eq("from_bot", true).eq("quoted_id", id);
  const answered = (replies ?? []).map((r) => str(r.id));
  // It answered the bot's question about a reply, still waiting (dm.ts): what it quoted, or the bot's answer to it ("I didn't
  // send it..."), is one of the question's messages. Its new words answer it now; one decided (sent, dropped) isn't opened
  // again. Once per edit: by its own id, else (Green API may give it the id of the one it changes) by its words.
  for (const q of [quotedId, ...answered]) {
    if (!q || !(await draftFor(db, chat, q))) continue;
    const lid = str(was?.sender_id);
    const once = `${id}:edit:${o.own && o.own !== id ? o.own : text.slice(0, 500)}`;
    return { id, text, quotedId, done, note: null, answers: { chatId: chat, quotedId: q, phone: str(was?.phone) || null, lid: lid.endsWith("@lid") ? lid : null, once } };
  }
  // Told only to someone on the team (orders.ts onTheTeam): anyone else heard "I can't help you here", and that's all.
  let note: string | null = null;
  if (group && answered.length && o.team) {
    const { data: g } = await db.from("wa_group").select("kind").eq("chat_id", o.chatId).maybeSingle();
    if (g?.kind === "team" && onTheTeam(sentBy(await o.team(), was)) && (await firstTime(db, `edit:${id}`))) note = EDIT_NOTE;
  }
  return { id, text, quotedId, done, note, answers: null };
}
