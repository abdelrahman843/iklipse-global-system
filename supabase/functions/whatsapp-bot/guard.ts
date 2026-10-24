// What the bot writes to a client is checked in code before it goes, not only
// by the prompt. It doesn't go when it has:
// - a phone number, an email or a price that isn't theirs and isn't already
//   in their chat or in what the team said;
// - another client's name;
// - a word that's only for inside iklipse.
// Caught, the team gets it instead, to OK or change, and every catch is kept
// (bot_guard_block, 0111) and logged. Links aren't checked: the bot's own
// booking links go to clients.

import { iso, str, type Db } from "./kit.ts";

/** What a message to one client may repeat. */
export interface Allowed {
  /** Text it may repeat numbers, emails, prices and names from: their chat, what the team said, what iklipse knows about them. */
  said: string[];
  /** Their own number and email. */
  phone?: string | null;
  email?: string | null;
  /** Their own names (name, company): never "another client". */
  own?: string[];
  /** The other clients, by name and company. */
  others: string[];
}

/** Words only for inside iklipse: how the bot works, the tools behind it, the team's money. */
export const INTERNAL_WORDS = [
  "Claude",
  "Anthropic",
  "system prompt",
  "Supabase",
  "database",
  "service role",
  "watch_alert",
  "bot_order",
  "bot_draft",
  "Ikli",
  "salary",
  "salaries",
  "commission",
  "profit margin",
];

const URL = /\bhttps?:\/\/\S+/gi;
const DATE = /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g;
const PHONE = /(?:\+|\b00)?\d[\d\s().-]{6,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A currency's code also stuck to the amount ("EGP5000", "5000LE"); Egypt's pound as ج.م too (not the end of a word: "حجم 5").
const MONEY = "(?:[$€£]|(?<![a-z])(?:usd|eur|gbp|egp|aed|sar|l\\.?e)(?![a-z])|(?<![\\u0600-\\u06FF])ج\\.?\\s?م(?![\\u0600-\\u06FF])|دولار|جنيه|جنية|ريال|درهم|يورو)";
const AMOUNT = "\\d[\\d,]*(?:\\.\\d+)?(?:\\s?[kK]\\b)?";
/** "price 5000", "it costs 5,000", "السعر 5000": an amount right after a word for what it costs. */
const COSTS = "(?:\\b(?:prices?|priced|costs?|fees?|budget|quoted?)\\b|سعر|اسعار|أسعار|تكلفة|تكلفه)(?:\\s*(?:(?:is|of|at|was|will be|would be|around|about|only)\\b|[:=-]))*\\s*";
const PRICE = new RegExp(`${MONEY}\\s?${AMOUNT}|${AMOUNT}\\s?(?:${MONEY}|\\b(?:dollars?|euros?|pounds?|bucks)\\b)|${COSTS}${AMOUNT}`, "gi");

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits as 0-9, Arabic's thousands and decimal marks as , and . */
const westernDigits = (t: string) =>
  t
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
/** Arabic written one way (every alef as ا, ة as ه, ى as ي, no vowel marks or stretching), so a name matches however it's spelled. */
const arabicPlain = (t: string) => t.replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ٰٟـ]/g, "");
const ARABIC = /\p{Script=Arabic}/u;
const letters = (t: string) => (t.match(/\p{L}/gu) ?? []).length;

/** The last 9 digits: the same number written with or without its country code. */
const tail = (digits: string) => digits.slice(-9);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name or word as a whole word (Arabic too: \b only knows Latin letters; an Arabic one with و, ف, ب, ل or ك stuck before it too). */
const wholeWord = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${ARABIC.test(w[0] ?? "") ? "[وفبلك]?" : ""}${escape(w)}($|[^\\p{L}\\p{N}_])`, "iu");

/** The numbers in a text as digit runs ("+20 100 123 4567" -> "201001234567"), for what may be repeated. */
function numbersIn(text: string): string[] {
  return (text.replace(URL, " ").match(/[\d][\d\s().,-]*/g) ?? []).map((n) => n.replace(/\D/g, "")).filter(Boolean);
}

/**
 * Why a message to a client mustn't go, one plain reason each, with what was
 * found ("a phone number (+20 100 123 4567)"); empty when it may go.
 */
export function guardIssues(text: string, a: Allowed): string[] {
  const out: string[] = [];
  // Arabic-Indic and Persian digits read as 0-9 first, for every check.
  text = westernDigits(text);
  const said = westernDigits(a.said.join("\n"));
  const saidLower = said.toLowerCase();
  const saidNumbers = numbersIn(said);
  const plain = text.replace(URL, " ").replace(DATE, " ");

  // Phone numbers: 9+ digits that aren't theirs and weren't said.
  const own = a.phone ? westernDigits(str(a.phone)).replace(/\D/g, "") : "";
  for (const m of plain.match(PHONE) ?? []) {
    const d = m.replace(/\D/g, "");
    if (d.length < 9 || d.length > 15) continue;
    if (own && tail(own) === tail(d)) continue;
    if (saidNumbers.some((n) => n.includes(tail(d)))) continue;
    out.push(`a phone number (${m.trim()})`);
  }

  // Emails that aren't theirs and weren't said.
  for (const m of text.replace(URL, " ").match(EMAIL) ?? []) {
    const e = m.toLowerCase();
    if (a.email && e === a.email.toLowerCase()) continue;
    if (saidLower.includes(e)) continue;
    out.push(`an email (${m})`);
  }

  // Prices whose amount wasn't said.
  for (const m of plain.match(PRICE) ?? []) {
    const amount = (m.match(/\d[\d,]*(?:\.\d+)?/) ?? [""])[0].replace(/,/g, "");
    if (amount && saidNumbers.includes(amount.replace(/\D/g, ""))) continue;
    out.push(`a price (${m.trim()})`);
  }

  // Another client's name, unless it's theirs too (whole words of a name of theirs: "Sara" in "Sara Ahmed", never
  // "Mona Fathy" for someone called "Mona"; an empty one is nobody's) or was already said.
  const mine = (a.own ?? []).map((n) => arabicPlain(str(n))).filter((n) => /[\p{L}\p{N}]/u.test(n));
  const plainText = arabicPlain(text);
  const plainSaid = arabicPlain(said);
  for (const n of new Set(a.others.map((x) => str(x).trim()).filter(Boolean))) {
    const p = arabicPlain(n);
    if (mine.some((m) => wholeWord(p).test(m))) continue;
    if (!wholeWord(p).test(plainText) || wholeWord(p).test(plainSaid)) continue;
    out.push(`another client's name (${n})`);
  }

  // Words only for inside iklipse, unless they said them.
  for (const w of INTERNAL_WORDS) {
    if (wholeWord(w).test(text) && !wholeWord(w).test(said)) out.push(`an internal word (${w})`);
  }
  return [...new Set(out)];
}

/**
 * Other clients' names worth checking for: their names of 3 letters or more
 * (one word too, as a whole word), company names of 4 letters or more, and,
 * for a name iklipse keeps in English, the Arabic spelling WhatsApp shows for
 * their number (their private chat with the bot, the groups). Read once every
 * few minutes per run.
 */
let othersCache: { at: number; rows: { id: string; names: string[] }[] } | null = null;
const OTHERS_MS = 5 * 60_000;

export async function otherClients(db: Db, notId: string | null | undefined): Promise<string[]> {
  if (!othersCache || Date.now() - othersCache.at > OTHERS_MS) {
    const [{ data }, arabic] = await Promise.all([db.from("client").select("id, name, company, name_known, phone"), arabicNames(db)]);
    const rows = ((data ?? []) as { id: string; name: string | null; company: string | null; name_known: boolean | null; phone: string | null }[]).map((c) => {
      const name = str(c.name).trim();
      const known = c.name_known !== false;
      const english = /[a-z]/i.test(name) && !ARABIC.test(name);
      const number = str(c.phone).replace(/\D/g, "");
      return {
        id: c.id,
        names: [
          ...(known && letters(name) >= 3 ? [name] : []),
          ...(str(c.company).trim().length >= 4 ? [str(c.company).trim()] : []),
          ...(known && english && number.length >= 9 ? arabic.get(tail(number)) ?? [] : []),
        ],
      };
    });
    othersCache = { at: Date.now(), rows };
  }
  return othersCache.rows.filter((r) => r.id !== notId).flatMap((r) => r.names);
}

/** The names in Arabic letters (3 letters or more) WhatsApp shows for numbers, by their last 9 digits. */
async function arabicNames(db: Db): Promise<Map<string, string[]>> {
  const [dms, groups] = await Promise.all([
    db.from("wa_dm_chat").select("phone, name").not("name", "is", null),
    db.from("wa_participant").select("phone, name").not("name", "is", null),
  ]);
  const out = new Map<string, string[]>();
  for (const r of [...(dms.data ?? []), ...(groups.data ?? [])] as { phone: string | null; name: string | null }[]) {
    const name = str(r.name);
    const number = str(r.phone).replace(/\D/g, "");
    if (number.length < 9 || !ARABIC.test(name) || letters(name) < 3) continue;
    const k = tail(number);
    if (!out.get(k)?.includes(name)) out.set(k, [...(out.get(k) ?? []), name]);
  }
  return out;
}

/** For the tests: forget the clients read. */
export function forgetClients() {
  othersCache = null;
}

/** A message that didn't go: kept for the admins, and logged. Never throws. */
export async function keepBlock(db: Db, o: { where: string; chat_id: string | null; to_name?: string | null; text: string; reasons: string[] }) {
  console.log(JSON.stringify({ ev: "guard_block", where: o.where, chat: o.chat_id, reasons: o.reasons }));
  try {
    await db.from("bot_guard_block").insert({ at: iso(), where_from: o.where, chat_id: o.chat_id, to_name: o.to_name ?? null, text: o.text.slice(0, 4000), reasons: o.reasons });
  } catch {
    // Before 0111 the table isn't there: the log line is enough.
  }
}

/** Plain words for the team: "a phone number (...) and a price (...)". */
export const reasonsText = (r: string[]) => (r.length < 2 ? r.join("") : `${r.slice(0, -1).join(", ")} and ${r.at(-1)}`);
