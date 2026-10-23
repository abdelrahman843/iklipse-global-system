// Which messages in a group are for the bot (index.ts): only these reach the
// order router (orders.ts takeOrder); everything else is kept, with no model
// call and no reply. In a team group, the alerts group included:
// - mention: it @mentions the bot;
// - reply: it quotes a message of the bot's;
// - name: it starts by calling the bot by name ("iklipse", "ikli", "اكليبس", "يا بوت"...);
// - conversation: what the bot last said to this same sender in this group,
//   in the last 5 minutes, asked them something, and they answer without quoting.
// In a client group, only a mention, as before.

import { iso, type Db } from "./kit.ts";
import { mentionsBot } from "./book.ts";

/** How a message reached the bot. */
export type Via = "mention" | "reply" | "name" | "conversation";

/** How long after the bot asks someone something their answer, unquoted, still counts as for it. */
export const CONVERSATION_MS = 5 * 60_000;

/** The bot's names, written plain (below), the longer of two alike first. */
const NAMES = ["iklipse", "ikli", "اكليبس", "بوت"];

/** Arabic written one way: every alef as ا, no vowel marks or stretching; Latin in lower case. */
function plain(text: string) {
  return text
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ً-ٰٟـ]/g, "");
}

/**
 * The message starts by calling the bot by name: "iklipse who's late today?",
 * "يا اكليبس فكرني...", "بوت، ...". Only at the very start (after any spaces,
 * punctuation, or a file's "[photo]" tag before its caption), and only the
 * whole name: "iklipses" or "بوتات" isn't it, and neither is the name later on.
 */
export function callsBot(text: string): boolean {
  const t = plain(text)
    .replace(/^[\s\p{P}\p{S}\p{M}\p{Cf}]*\[[^\]]*\]/u, "")
    .replace(/^[\s\p{P}\p{S}\p{M}\p{Cf}]+/u, "");
  // "يا اكليبس", "يابوت": the name after it.
  const name = t.startsWith("يا") ? t.slice(2).trimStart() : t;
  return NAMES.some((n) => name.startsWith(n) && /^($|[\s\p{P}\p{S}\p{Cf}])/u.test(name.slice(n.length)));
}

/**
 * A message from the bot that asks something. A "?" in a link doesn't count,
 * and neither does one in words it passes on in quotes (Acme asked: "can you
 * make the blue darker?"): that's someone else's question, not the bot's.
 */
export const asks = (text: unknown) =>
  /[?؟]/.test(
    String(text ?? "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, "")
      .replace(/(^|\s)'[^'\n]*'(?=$|[\s.,:;!])/g, "$1"),
  );

/**
 * The bot asked this sender something in this chat in the last CONVERSATION_MS:
 * what it last said to them there (its newest message quoting one of theirs:
 * the same WhatsApp id, or the same number) asks something. "Told Ahmed." after
 * "Who's Ahmed?" closes it. Two small reads: the bot's latest replies, then
 * whose messages they quote (none when nothing it said asks anything).
 */
async function askedThem(
  db: Db,
  o: { chatId: string; sender: string; senderPhone: () => Promise<string | null>; now: number },
): Promise<boolean> {
  const { data: mine } = await db
    .from("wa_message")
    .select("quoted_id, text, sent_at")
    .eq("chat_id", o.chatId)
    .eq("from_bot", true)
    .gte("sent_at", iso(o.now - CONVERSATION_MS))
    .not("quoted_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(10);
  // Newest first, sorted here too.
  const ours = ((mine ?? []) as { quoted_id: string | null; text: string | null; sent_at: string }[])
    .filter((m) => m.quoted_id)
    .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
  if (!ours.some((m) => asks(m.text))) return false;
  const { data: theirs } = await db
    .from("wa_message")
    .select("id, sender_id, phone")
    .eq("chat_id", o.chatId)
    .in("id", [...new Set(ours.map((m) => m.quoted_id!))]);
  const quoted = new Map(((theirs ?? []) as { id: string; sender_id: string | null; phone: string | null }[]).map((m) => [m.id, m]));
  // Theirs: by WhatsApp id, else by number (looked up once, only when needed).
  let phone: Promise<string | null> | null = null;
  const isTheirs = async (m: { sender_id: string | null; phone: string | null } | undefined) => {
    if (!m) return false;
    if (o.sender && m.sender_id === o.sender) return true;
    return !!m.phone && m.phone === (await (phone ??= o.senderPhone()));
  };
  for (const m of ours) if (await isTheirs(quoted.get(m.quoted_id!))) return asks(m.text);
  return false;
}

/** Why a message in a group is for the bot, or null when it isn't. */
export async function viaOf(
  db: Db,
  o: {
    chatId: string;
    teamGroup: boolean;
    text: string;
    quotedId: string | null;
    /** The sender's WhatsApp id ("...@c.us", or "...@lid"). */
    sender: string;
    senderPhone: () => Promise<string | null>;
    botPhone: string | null;
    now?: number;
  },
): Promise<Via | null> {
  if (await mentionsBot(db, o.text, o.botPhone)) return "mention";
  // A client group: a mention only.
  if (!o.teamGroup) return null;
  if (o.quotedId) {
    const { data } = await db.from("wa_message").select("from_bot").eq("id", o.quotedId).maybeSingle();
    if (data?.from_bot) return "reply";
  }
  if (callsBot(o.text)) return "name";
  // Quoting someone else's message is talking to them, not answering the bot.
  if (!o.quotedId && (await askedThem(db, { ...o, now: o.now ?? Date.now() }))) return "conversation";
  return null;
}
