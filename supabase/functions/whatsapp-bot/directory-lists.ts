// The directory's lists, in and out: nothing but words, so the bot and the
// dashboard read and write them the same way (it's imported from src/ too).

/** Said as it is to whoever asked. */
export class DirectoryNo extends Error {}

export interface Entry {
  ref: string;
  kind: string;
  name: string;
  company: string | null;
  department: string | null;
  role_title: string | null;
  team: string | null;
  is_manager: boolean;
  responsibilities: string | null;
  email: string | null;
  phone: string | null;
  language: string | null;
  /** Admins only. */
  notes?: string | null;
  status: string;
  /** Admins only. */
  access?: string;
  updated_at?: string | null;
}

export type Fields = Record<string, string | boolean | null>;


const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** A number as WhatsApp writes it (people.ts phoneKey). */
export function phoneOf(v: unknown): string | null {
  const d = text(v).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) return d.slice(2) || null;
  if (/^0\d{10}$/.test(d)) return `20${d.slice(1)}`;
  return d;
}

/** Lower case, no Arabic marks, the Arabic letters people write either way made one. */
export function plain(v: unknown) {
  return text(v)
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}@.+]+/gu, " ")
    .trim();
}

/** What a list's columns may be called, in English and Arabic. */
const HEADERS: Record<string, string[]> = {
  name: ["name", "full name", "contact", "contact name", "person", "الاسم", "اسم"],
  kind: ["type", "kind", "category", "النوع"],
  company: ["company", "organisation", "organization", "account", "الشركه"],
  department: ["department", "dept", "القسم"],
  role_title: ["role", "title", "job", "job title", "position", "الوظيفه", "المنصب", "الدور"],
  team: ["team", "الفريق"],
  is_manager: ["manager", "is manager"],
  responsibilities: ["responsibilities", "responsibility", "duties", "المسؤوليات", "المسئوليات", "المهام"],
  email: ["email", "e mail", "mail", "email address", "الايميل", "البريد", "البريد الالكتروني"],
  phone: ["phone", "whatsapp", "mobile", "number", "phone number", "tel", "telephone", "الهاتف", "التليفون", "الموبايل", "واتساب", "الرقم"],
  language: ["language", "lang", "اللغه"],
  notes: ["notes", "note", "comments", "ملاحظات"],
};
const FIELD_OF = new Map(Object.entries(HEADERS).flatMap(([f, names]) => names.map((n) => [plain(n), f] as const)));

/** What a type in a list means here. Someone listed as staff is still only a contact: an account is an admin's to give. */
function kindIn(v: string) {
  const k = plain(v);
  if (/vendor|supplier|مورد/.test(k)) return "vendor";
  if (/client|customer|عميل/.test(k)) return "client";
  if (/freelanc|فريلانسر/.test(k)) return "freelancer";
  if (/partner|شريك/.test(k)) return "partner";
  return "contact";
}

/** A CSV's rows, quotes and all. */
function csvRows(words: string, cut: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < words.length; i++) {
    const ch = words[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (words[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === cut) row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && words[i + 1] === "\n") i++;
      row.push(cell), (cell = ""), rows.push(row), (row = []);
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** A list as rows, from a CSV (comma, semicolon or tab) or an Excel sheet as files.ts wrote it out ("Sheet1:" then "a | b"). */
export function tableOf(raw: string): string[][] {
  const words = raw.replace(/^﻿/, "");
  const lines = words.split(/\r?\n/).filter((l) => l.trim());
  if (lines.some((l) => l.includes(" | "))) {
    // One sheet: the one with names in it, else the first.
    const sheets = words.split(/\n\s*\n/).map((sheet) =>
      sheet
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/^[^|]{1,40}:\s*$/.test(l))
        .map((l) => l.split("|").map((c) => c.trim())),
    );
    return sheets.find((rows) => rows.some((r) => r.some((c) => FIELD_OF.get(plain(c)) === "name"))) ?? sheets[0]!;
  }
  const head = lines[0] ?? "";
  const cut = [",", ";", "\t"].sort((a, b) => head.split(b).length - head.split(a).length)[0]!;
  return csvRows(words, cut);
}

export interface ListRows {
  rows: Fields[];
  /** Rows that can't be used, and why. */
  bad: string[];
  /** Columns left out: never a way in, whatever they're called. */
  ignored: string[];
}

export function rowsOf(table: string[][]): ListRows {
  const at = table.findIndex((r) => r.some((c) => FIELD_OF.get(plain(c)) === "name"));
  if (at < 0) throw new DirectoryNo('That list has no column called Name, so I can\'t tell who\'s who. Nothing was read in.');
  const columns = table[at]!.map((c) => FIELD_OF.get(plain(c)) ?? null);
  const ignored = table[at]!.filter((c, i) => c.trim() && !columns[i]).map((c) => c.trim());
  const rows: Fields[] = [];
  const bad: string[] = [];
  table.slice(at + 1).forEach((cells, i) => {
    const line = at + i + 2;
    const f: Fields = {};
    columns.forEach((col, j) => {
      const v = text(cells[j]).trim();
      if (!col || !v) return;
      if (col === "kind") f.kind = kindIn(v);
      else if (col === "is_manager") f.is_manager = /^(y|yes|true|1|نعم|اه)$/i.test(v);
      else f[col] = v;
    });
    if (!text(f.name)) {
      bad.push(`row ${line}: no name`);
      return;
    }
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(f.email))) {
      bad.push(`row ${line} (${text(f.name)}): "${text(f.email)}" isn't an email`);
      return;
    }
    if (f.phone) {
      const number = phoneOf(f.phone);
      if (!number || !/^[1-9]\d{7,14}$/.test(number)) {
        bad.push(`row ${line} (${text(f.name)}): "${text(f.phone)}" isn't a full number with its country code`);
        return;
      }
      f.phone = number;
    }
    f.kind ??= "contact";
    rows.push(f);
  });
  return { rows, bad, ignored };
}

const COLUMNS: [string, keyof Entry][] = [
  ["Type", "kind"],
  ["Name", "name"],
  ["Company", "company"],
  ["Department", "department"],
  ["Role", "role_title"],
  ["Team", "team"],
  ["Manager", "is_manager"],
  ["Responsibilities", "responsibilities"],
  ["Email", "email"],
  ["Phone", "phone"],
  ["Language", "language"],
  ["Notes", "notes"],
  ["Access", "access"],
  ["Status", "status"],
];

/** A spreadsheet runs a cell starting with these as a formula: written so it's only ever words. */
const cellOf = (v: unknown) => {
  const s = typeof v === "boolean" ? (v ? "yes" : "") : text(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** With the mark Excel needs to read Arabic. */
export const toCsv = (rows: Entry[]) => `﻿${[COLUMNS.map(([h]) => h).join(","), ...rows.map((r) => COLUMNS.map(([, k]) => cellOf(r[k])).join(","))].join("\r\n")}\r\n`;
