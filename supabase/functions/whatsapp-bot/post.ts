// Posting in a group the bot is in, at an admin's word (orders.ts, action
// post): "@iklipse send @Sara a reminder in the Acme group about this alert".
// Right away, and said back where it went. The group is found by its name
// among the ones the bot is in, never guessed: a name that fits none, or more
// than one, is asked back (the alert's own group offered, when it's about
// one). The people named are tagged when they're in that group, else written
// by name, so a number never shows where they aren't. In a client group what
// it says is checked first, like any message to a client (guard.ts).

import { str, type Db } from "./kit.ts";
import type { Send } from "./people.ts";
import type { Attendee } from "./meetings.ts";
import { guardIssues, keepBlock, otherClients, reasonsText } from "./guard.ts";

/** A group the bot is in. */
export interface Group {
  chat_id: string;
  name: string;
  /** "team" or "client" (wa_group.kind). */
  kind: string;
}

/** The groups the bot is in (it hasn't left), by name. */
export async function groupsIn(db: Db): Promise<Group[]> {
  const { data } = await db.from("wa_group").select("chat_id, name, kind, left_at").is("left_at", null).order("name").limit(300);
  return ((data ?? []) as { chat_id: string; name: string | null; kind: string | null; left_at: string | null }[])
    .filter((g) => !g.left_at && str(g.name).trim())
    .map((g) => ({ chat_id: g.chat_id, name: str(g.name).trim(), kind: g.kind ?? "client" }));
}

/** Lower case, every Arabic alef as one, letters and digits only. */
const flat = (s: string) =>
  s
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[^\p{L}\p{N}]+/gu, "");
/** Words said with a group's name that aren't part of it. */
const NOT_THE_NAME = new Set(["the", "group", "groups", "chat", "in", "on", "جروب", "الجروب", "جروپ", "مجموعة"]);

/**
 * The group they mean: the one whose name is what they said (any case,
 * spacing or punctuation), else the only one with every word they said in its
 * name ("the acme group" is "iklipse X Acme - Launch trailer"). None, or
 * more than one: fits says which fit.
 */
export function groupNamed(groups: Group[], said: string): { group: Group | null; fits: Group[] } {
  const whole = flat(said);
  if (!whole) return { group: null, fits: [] };
  const same = groups.filter((g) => flat(g.name) === whole);
  if (same.length) return { group: same.length === 1 ? same[0]! : null, fits: same };
  const words = said
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !NOT_THE_NAME.has(w))
    .map(flat)
    .filter(Boolean);
  if (!words.length) return { group: null, fits: [] };
  const fits = groups.filter((g) => words.every((w) => flat(g.name).includes(w)));
  return { group: fits.length === 1 ? fits[0]! : null, fits };
}

/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** "Sara, Rabah and Omar" (or "... or Omar") */
const listOf = (xs: string[], and = "and") => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs.at(-1)}`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface PostAsk {
  /** The group's name, as Claude gave it. */
  group: string;
  /** The message, as it's posted (the tags go in it). */
  text: string;
  /** The people to tag. */
  tag: Attendee[];
  /** When it's about an open alert: the group that alert is from, offered when the name fits no group. */
  alertGroup?: string | null;
  /** What a message to a client group may repeat (guard.ts): what they asked, the alert. */
  said: string[];
}

/**
 * Posts it in the group, now. What comes back is what to tell the one who
 * asked: where it went, or the question back, or why it didn't go.
 */
export async function postInGroup(db: Db, send: Send, by: { admin: boolean }, x: PostAsk): Promise<string> {
  if (!by.admin) return "Only admins can have me post in other groups.";
  const said = x.group.trim();
  let text = x.text.replace(/\s*[—–]\s*/g, ", ").trim();
  if (!text) return "What should I post?";
  const groups = await groupsIn(db);
  const { group, fits } = groupNamed(groups, said);
  if (!group) {
    if (fits.length > 1) return `Which group: ${listOf(fits.slice(0, 6).map((g) => g.name), "or")}?`;
    const theAlerts = x.alertGroup ? groups.find((g) => g.chat_id === x.alertGroup) : undefined;
    const none = said ? `I'm not in a group called "${said}".` : "";
    // A client's group: they'd read it, so that's said before the yes.
    const theirs = theAlerts && theAlerts.kind !== "team" ? " (the client's group, they'll see it)" : "";
    if (theAlerts) return `${none ? `${none} ` : ""}Post it in ${theAlerts.name}${theirs}, where that alert is?`;
    return none ? `${none} Which group?` : "Which group should I post it in?";
  }

  // A tag only for someone in that group; anyone else by name.
  const { data: members } = await db.from("wa_participant").select("phone").eq("chat_id", group.chat_id);
  const there = new Set(((members ?? []) as { phone: string | null }[]).map((m) => str(m.phone)).filter(Boolean));
  const tagged: string[] = [];
  const front: string[] = [];
  // Their numbers go with it, so the tags are real ones on WAHA too (index.ts sendAs).
  const mentions: string[] = [];
  for (const p of x.tag) {
    const tag = p.phone && there.has(p.phone) ? `@${p.phone}` : first(p.name);
    if (tag.startsWith("@")) tagged.push(first(p.name));
    if (p.phone && tag === `@${p.phone}` && !mentions.includes(p.phone)) mentions.push(p.phone);
    // "@Sara" in the text is where their tag goes; else it goes first.
    const at = new RegExp(`@(${escape(p.name)}|${escape(first(p.name))})(?![\\p{L}\\p{N}])`, "giu");
    if (at.test(text)) text = text.replace(at, tag);
    else if (!front.includes(tag)) front.push(tag);
  }
  const message = [front.join(" "), text].filter(Boolean).join(" ").slice(0, 3000);

  // A client group reads it: only what they asked, the alert, and the group's own talk.
  if (group.kind !== "team") {
    const [{ data: rows }, { data: theirs }] = await Promise.all([
      db.from("wa_message").select("text").eq("chat_id", group.chat_id).order("sent_at", { ascending: false }).limit(30),
      db.from("client").select("name, company").eq("from_chat", group.chat_id),
    ]);
    const reasons = guardIssues(message, {
      said: [...x.said, ...((rows ?? []) as { text: string | null }[]).map((m) => str(m.text)), ...x.tag.map((p) => str(p.phone))],
      own: ((theirs ?? []) as { name: string | null; company: string | null }[]).flatMap((c) => [str(c.name), str(c.company)]).filter(Boolean),
      others: await otherClients(db, null),
    });
    if (reasons.length) {
      await keepBlock(db, { where: "orders.post", chat_id: group.chat_id, to_name: group.name, text: message, reasons });
      return `I didn't post it in ${group.name}: it had ${reasonsText(reasons)}, which isn't in your message or that group. Tell me exactly what to post.`;
    }
  }

  let id: string | null;
  try {
    id = await send(group.chat_id, message, null, mentions);
  } catch (e) {
    return `Couldn't post in ${group.name}: ${(e as Error).message.slice(0, 120)}`;
  }
  console.log(JSON.stringify({ ev: "group_post", chat: group.chat_id, id }));
  if (!id) return `I sent it to ${group.name}, but WhatsApp didn't confirm it went.`;
  return `Posted in ${group.name}${tagged.length ? `, tagging ${listOf(tagged)}` : ""}.`;
}
