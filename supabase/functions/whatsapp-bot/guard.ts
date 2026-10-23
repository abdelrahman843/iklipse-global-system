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
const MONEY = "(?:[$€£]|\\b(?:usd|eur|gbp|egp|aed|sar|le)\\b|دولار|جنيه|ريال|درهم|يورو)";
const AMOUNT = "\\d[\\d,]*(?:\\.\\d+)?(?:\\s?[kK]\\b)?";
const PRICE = new RegExp(`${MONEY}\\s?${AMOUNT}|${AMOUNT}\\s?(?:${MONEY}|\\b(?:dollars?|euros?|pounds?|bucks)\\b)`, "gi");

/** The last 9 digits: the same number written with or without its country code. */
const tail = (digits: string) => digits.slice(-9);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name or word as a whole word (Arabic too: \b only knows Latin letters). */
const wholeWord = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(w)}($|[^\\p{L}\\p{N}_])`, "iu");

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
  const said = a.said.join("\n");
  const saidLower = said.toLowerCase();
  const saidNumbers = numbersIn(said);
  const plain = text.replace(URL, " ").replace(DATE, " ");

  // Phone numbers: 9+ digits that aren't theirs and weren't said.
  const own = a.phone ? str(a.phone).replace(/\D/g, "") : "";
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

  // Another client's name, unless it's theirs too or was already said.
  const mine = (a.own ?? []).map((n) => n.toLowerCase());
  for (const n of new Set(a.others.map((x) => str(x).trim()).filter(Boolean))) {
    const low = n.toLowerCase();
    if (mine.some((m) => m === low || m.includes(low) || low.includes(m))) continue;
    if (!wholeWord(n).test(text) || wholeWord(n).test(said)) continue;
    out.push(`another client's name (${n})`);
  }

  // Words only for inside iklipse, unless they said them.
  for (const w of INTERNAL_WORDS) {
    if (wholeWord(w).test(text) && !wholeWord(w).test(said)) out.push(`an internal word (${w})`);
  }
  return [...new Set(out)];
}

/**
 * Other clients' names worth checking for: full names of two words or more
 * (one first name is too common to tell apart) and company names of 4
 * letters or more. Read once every few minutes per run.
 */
let othersCache: { at: number; rows: { id: string; names: string[] }[] } | null = null;
const OTHERS_MS = 5 * 60_000;

export async function otherClients(db: Db, notId: string | null | undefined): Promise<string[]> {
  if (!othersCache || Date.now() - othersCache.at > OTHERS_MS) {
    const { data } = await db.from("client").select("id, name, company, name_known");
    const rows = ((data ?? []) as { id: string; name: string | null; company: string | null; name_known: boolean | null }[]).map((c) => ({
      id: c.id,
      names: [
        ...(c.name_known !== false && str(c.name).trim().split(/\s+/).length >= 2 ? [str(c.name).trim()] : []),
        ...(str(c.company).trim().length >= 4 ? [str(c.company).trim()] : []),
      ],
    }));
    othersCache = { at: Date.now(), rows };
  }
  return othersCache.rows.filter((r) => r.id !== notId).flatMap((r) => r.names);
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
