// The directory (0144): everyone iklipse deals with, one record each, wherever
// they're kept. The rules live in the database, so the dashboard and the bot
// keep the same ones; here is what only the bot needs: finding people the way
// they're asked for ("the production lead"), and reading and writing lists.
//
// A record gives nobody anything. Nothing here touches a role, a permission or
// a group: a list saying someone is an admin only fills in a job title.

import { str, type Db } from "./kit.ts";
import { FILES } from "./files.ts";
import { DirectoryNo, plain, type Entry, type Fields } from "./directory-lists.ts";
import { phoneKey } from "./people.ts";

export * from "./directory-lists.ts";

export interface Match {
  ref: string;
  kind: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  why: string;
}

export const FIELDS = ["kind", "name", "company", "department", "role_title", "team", "is_manager", "responsibilities", "email", "phone", "language", "notes"] as const;

export const isRef = (v: string) => /^(staff|client|partner|other|card):[0-9a-f-]{36}$/.test(v);

export async function directoryRead<T>(db: Db, what: string, p: Record<string, unknown>, full: boolean): Promise<T> {
  const { data, error } = await db.rpc("_directory_read", { p_what: what, p, p_full: full });
  if (error) throw new DirectoryNo(error.message);
  return data as T;
}

export async function directoryDo<T = Record<string, unknown>>(db: Db, op: string, p: Record<string, unknown>, actor: string, via: string): Promise<T> {
  const { data, error } = await db.rpc("_directory_do", { p_op: op, p, p_actor: actor, p_via: via });
  if (error) throw new DirectoryNo(error.message);
  return data as T;
}

// ------------------------------------------------------------- finding --

/** Its words, with Arabic's "the" off the front. */
const wordsOf = (v: unknown) =>
  plain(v)
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^ال[؀-ۿ]{2,}/.test(w) ? w.slice(2) : w));

const same = (a: string, b: string) => a === b || a === `${b}s` || b === `${a}s`;
const hasAll = (have: string[], need: string[]) => need.every((n) => have.some((h) => same(h, n)));

/** Search: every word asked for is somewhere in the record. Numbers match however they're written. */
export function searchRows(rows: Entry[], q: string, o: { kind?: string; archived?: boolean } = {}) {
  const need = wordsOf(q);
  const number = phoneKey(q);
  return rows.filter((r) => {
    if (!o.archived && r.status !== "active") return false;
    if (o.kind && !(o.kind === "manager" ? r.is_manager : r.kind === o.kind)) return false;
    if (!need.length) return true;
    if (number && number.length >= 6 && /^[\d\s+()-]+$/.test(q) && str(r.phone).includes(number.slice(-9))) return true;
    const text = plain([r.name, r.company, r.department, r.role_title, r.team, r.responsibilities, r.email, r.language, r.notes, r.kind].filter(Boolean).join(" "));
    return need.every((n) => text.includes(n));
  });
}

/** Words that say how senior, not what they do. */
const SENIOR = new Set(["lead", "leader", "head", "manager", "chief", "director", "مدير", "رئيس", "مسؤول", "مسئول"]);
const FILLER = new Set(["the", "our", "of", "for", "in", "at", "person", "guy", "who", "is", "owner", "charge", "responsible", "قسم", "بتاع", "بتاعه", "عن", "في"]);

/**
 * Who holds a role, best fit first: their title, then their department or
 * team, then what they're responsible for. Only the best fit comes back, so
 * more than one means more than one holds it, and it's for the asker to say
 * who. Nobody is never someone close.
 */
export function whoDoes(rows: Entry[], ask: string): Entry[] {
  const asked = wordsOf(ask);
  const need = asked.filter((w) => !SENIOR.has(w) && !FILLER.has(w));
  if (!need.length) return [];
  const senior = asked.some((w) => SENIOR.has(w));
  const scored = rows
    .filter((r) => r.status === "active")
    .map((r) => {
      const title = wordsOf(r.role_title);
      const lead = r.is_manager || title.some((w) => SENIOR.has(w));
      let score = 0;
      if (hasAll(title, need)) score = 4;
      else if (hasAll([...wordsOf(r.department), ...wordsOf(r.team)], need)) score = 2;
      else if (hasAll(wordsOf(r.responsibilities), need)) score = 1;
      if (score && senior && lead) score += 1;
      return { r, score };
    })
    .filter((x) => x.score > 0);
  const top = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === top).map((x) => x.r);
}

/** One line for a person, what there is of it. */
export function lineOf(r: Pick<Entry, "name" | "kind"> & Partial<Entry>) {
  const place = [r.role_title, r.department, r.company].filter(Boolean).join(", ");
  const reach = [r.phone ? `+${r.phone}` : "", r.email ?? ""].filter(Boolean).join(", ");
  return `${r.name} (${r.kind}${r.status && r.status !== "active" ? `, ${r.status}` : ""})${place ? `: ${place}` : ""}${reach ? ` · ${reach}` : ""}`;
}

export const dupesLine = (m: Match[]) => m.map((x) => `${lineOf(x)}, ${x.why} [${x.ref}]`).join("; ");

// ---------------------------------------------------------------- lists --

export interface Plan {
  fresh: Fields[];
  /** Probably someone already here: left alone until someone says. */
  known: { name: string; matches: Match[] }[];
}

const gramsOf = (s: string) => {
  const out = new Set<string>();
  for (const word of s.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const pad = `  ${word} `;
    for (let i = 0; i + 3 <= pad.length; i++) out.add(pad.slice(i, i + 3));
  }
  return out;
};

/** The database's "similar name" (_directory_dupes), for rows of a list that aren't in it yet. */
export function nameLike(a: string, b: string) {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 3 || y.length < 3) return false;
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return true;
  const [p, q] = [gramsOf(x), gramsOf(y)];
  const shared = [...p].filter((g) => q.has(g)).length;
  return shared / (p.size + q.size - shared) >= 0.55;
}

/** What a list would do: who's new, and who's probably someone already here or earlier in the same list. */
export async function planOf(db: Db, rows: Fields[]): Promise<Plan> {
  const fresh: Fields[] = [];
  const known: Plan["known"] = [];
  const seen = new Map<string, string>();
  for (const f of rows) {
    const keys = [str(f.phone) && `p:${str(f.phone).slice(-9)}`, str(f.email) && `e:${str(f.email).toLowerCase()}`, `n:${plain(f.name)}`].filter(Boolean);
    const twin = keys.map((k) => seen.get(k)).find(Boolean);
    if (twin) {
      known.push({ name: str(f.name), matches: [{ ref: "", kind: "this list", name: twin, company: null, email: null, phone: null, status: "active", why: "twice in this list" }] });
      continue;
    }
    keys.forEach((k) => seen.set(k, str(f.name)));
    const matches = await directoryRead<Match[]>(db, "dupes", { name: f.name, email: f.email, phone: f.phone }, true);
    const near = matches.length ? undefined : fresh.find((o) => nameLike(str(o.name), str(f.name)));
    if (matches.length) known.push({ name: str(f.name), matches });
    else if (near) known.push({ name: str(f.name), matches: [{ ref: "", kind: "this list", name: str(near.name), company: null, email: null, phone: null, status: "active", why: "similar name in this list" }] });
    else fresh.push(f);
  }
  return { fresh, known };
}

/** A link to the list, long enough to send it; off() takes it away after. */
export async function csvLink(db: Db, name: string, csv: string) {
  const path = `directory/${crypto.randomUUID()}/${name}`;
  const up = await db.storage.from(FILES).upload(path, new TextEncoder().encode(csv), { contentType: "text/csv" });
  if (up.error) throw new DirectoryNo(`Storage: ${up.error.message}`);
  const { data, error } = await db.storage.from(FILES).createSignedUrl(path, 15 * 60);
  if (error || !data?.signedUrl) throw new DirectoryNo(`Storage: ${error?.message ?? "no link"}`);
  return { url: data.signedUrl, off: () => db.storage.from(FILES).remove([path]) };
}
