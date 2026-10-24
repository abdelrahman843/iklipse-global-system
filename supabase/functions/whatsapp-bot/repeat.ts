// Alerts that say the same thing (0109). A client waiting is one alert per
// chat and person, whatever their name is written as; a promise, a deadline
// or something we wait for that's said again (or with a new time) updates the
// one that's open instead of opening another. People are matched by who they
// are (person_key: the client or team member, else their WhatsApp number,
// hidden-number id, Slack id or email address), and only by name when that's
// all there is. The same email in several team members' mailboxes opens one
// alert (mail_key: its Message-ID is the same everywhere), and it stays its
// mailbox owner's: nobody else is added to it (mail.ts). Used when opening
// alerts (chat.ts, mail.ts), and so the digest and the ringing never show or
// ring the same thing twice (index.ts). Nothing here reads the database.

import { str } from "./kit.ts";

export interface AlertLike {
  id?: string;
  kind: string;
  source?: string | null;
  chat_id?: string | null;
  channel_id?: string | null;
  mail_account?: string | null;
  mail_thread?: string | null;
  mail_key?: string | null;
  person?: string | null;
  person_key?: string | null;
  title: string;
  due_at?: string | null;
  created_at?: string;
}

/** "Sara Ahmed (Acme)" -> "sara ahmed". */
export const normName = (n: string | null | undefined) =>
  str(n)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP = new Set(
  "a an the to for on of by and or in at is are was be it its with from about their his her them they you your our we us this that waiting wait promised promise send sent reply replied get back".split(" "),
);
/** A title's words that say what it's about. */
export const titleWords = (t: string) =>
  new Set(
    normName(t)
      .split(" ")
      .filter((w) => w && !STOP.has(w)),
  );

/** Each title names a number the other doesn't (invoice I260281 isn't invoice I260282). */
export function otherNumbers(a: string, b: string) {
  const nums = (t: string) => [...titleWords(t)].filter((w) => /\d/.test(w));
  const [nx, ny] = [nums(a), nums(b)];
  return (nx.length > 0 || ny.length > 0) && !nx.some((n) => ny.includes(n));
}

/** Two titles about the same thing: most of their words in common, and no number that differs. */
export function similarTitle(a: string, b: string) {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size || otherNumbers(a, b)) return false;
  const common = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return common / union >= 0.5 || common / Math.min(x.size, y.size) >= 0.8;
}

/** The same person: by who they are when both are known, else by the name written (a key that's only a name, "n:...", is a name). */
export function samePerson(a: AlertLike, b: AlertLike) {
  const known = (k: string | null | undefined) => !!k && !k.startsWith("n:");
  if (known(a.person_key) && known(b.person_key)) return a.person_key === b.person_key;
  const [x, y] = [normName(a.person), normName(b.person)];
  return !!x && x === y;
}

/**
 * The same thing: in a group or channel, one client waiting is one alert; a
 * promise, a deadline or something we wait for is the same one when it's the
 * same person and the same matter (similar title). Due close together alone
 * never makes two the same. Email: sameEmail.
 */
export function sameAlert(a: AlertLike, b: AlertLike) {
  if (a.kind !== b.kind || (a.source ?? "whatsapp") !== (b.source ?? "whatsapp")) return false;
  if (a.source === "email") return sameEmail(a, b);
  if ((a.chat_id ?? a.channel_id ?? null) !== (b.chat_id ?? b.channel_id ?? null) || !samePerson(a, b)) return false;
  if (a.kind === "unanswered") return true;
  if (otherNumbers(a.title, b.title)) return false;
  return similarTitle(a.title, b.title);
}

/**
 * Email: one conversation can be in several team members' mailboxes. A
 * client waiting is the same alert for the same email (mail_key) or the same
 * conversation in one mailbox. The rest: in the same conversation, the same
 * matter; in another one (another mailbox's copy, a new thread), the same
 * person (or the very same title) and the same matter. Never two numbers that
 * differ, and never only because they're due close together.
 */
function sameEmail(a: AlertLike, b: AlertLike) {
  const sameMail = !!a.mail_key && a.mail_key === b.mail_key;
  const sameThread = !!a.mail_thread && a.mail_account === b.mail_account && a.mail_thread === b.mail_thread;
  if (a.kind === "unanswered") return sameMail || sameThread;
  if (otherNumbers(a.title, b.title)) return false;
  if (sameMail || sameThread) return similarTitle(a.title, b.title);
  return (samePerson(a, b) || normName(a.title) === normName(b.title)) && similarTitle(a.title, b.title);
}

/** An open alert's id for Claude: short, and the same every time it's read. */
export const shortId = (id: string) => `A${id.replace(/-/g, "").slice(0, 6)}`;
/** The open alert Claude means (its short id, or the old "A3" by place in the list). */
export function byShortId<T extends { id: string }>(open: T[], said: unknown): T | undefined {
  const s = str(said);
  const hit = open.find((a) => shortId(a.id).toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  return /^A?\d{1,2}$/i.test(s) ? open[Number(s.replace(/\D/g, "")) - 1] : undefined;
}

/** An open alert with who it rings: to show and ring each thing once (index.ts). */
export type Seen = AlertLike & { id: string; created_at: string; people: string[] };

const olderThan = (b: Seen, a: Seen) => b.created_at < a.created_at || (b.created_at === a.created_at && b.id < a.id);

/**
 * An older open alert says the same thing: the digest leaves this one out,
 * and with a person, they aren't rung for it (the older one rings them).
 */
export function sameAsOlder(seen: Map<string, Seen>, id: string, person?: string) {
  const a = seen.get(id);
  if (!a) return false;
  return [...seen.values()].some((b) => b.id !== a.id && olderThan(b, a) && (!person || b.people.includes(person)) && sameAlert(b, a));
}
