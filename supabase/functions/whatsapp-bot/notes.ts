// What the team taught the bot in chat (0114): facts about iklipse, its people
// and its work ("Sara Ahmed is not a client", "Omar is our freelancer"), and
// standing instructions ("from now on, don't answer in the groups unless we
// talk to you"). Only an admin on the team teaches it, in any chat with the
// bot (orders.ts, the teach action); it says back in a line what it kept.
// Every call to Claude gets them (kit.ts: taught, loaded with the settings in
// index.ts) but those that write to a client: the newest first, a newer one
// winning when two disagree, at most so many. Admins ask what it was taught,
// and tell it to forget one. Saying
// someone in Clients isn't a client (a freelancer, a partner) also takes them
// out of Clients into "not clients" (0101), so the bot stops calling them a
// client (a freelancer already in iklipse by that name gets their number,
// 0115); saying someone there is a client puts them back.

import { iso, str, TZ, type Db, type Person, type Team } from "./kit.ts";
import { phoneKey } from "./people.ts";

/** A note as kept (0114). */
export interface Note {
  id: string;
  text: string;
  by_name: string | null;
  created_at: string;
  /** Its number for good (numbered): the nth note ever taught. */
  no?: number;
}

/** What the act tool gives for teach (orders.ts). */
export interface TeachAct {
  op?: string;
  notes?: string[];
  replaces?: string[];
  forget?: string[];
  people?: { ref?: string; name?: string; is?: string }[];
}

/** Claude is given at most this many notes, and this many characters of them: the newest. Older ones are kept, not used. */
export const MAX_NOTES = 40;
const MAX_CHARS = 3000;
/** One note: one short line. */
const NOTE_CHARS = 300;
/** At most this many notes from one message. */
const PER_MESSAGE = 5;

const day = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
const oneLine = (t: string, n: number) => t.replace(/[—–]/g, ", ").replace(/\s+/g, " ").trim().slice(0, n);
/** "Sara" from "Sara Ahmed" */
const first = (n: string | null | undefined) => str(n).split(/\s+/)[0] ?? "";
/** The same note however it's written. */
const same = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** "Sara Ahmed is not a client" from "Sara Ahmed is not a client." */
const bare = (t: string) => t.replace(/[.\s]+$/, "");
/** Who taught it and when: "(Sara, 23 Oct)" */
const taughtBy = (n: Note) => {
  const at = Date.parse(n.created_at);
  return `(${[first(n.by_name), Number.isFinite(at) ? day.format(new Date(at)) : ""].filter(Boolean).join(", ")})`;
};

const HEAD =
  "What the team taught you (admins told you in chat), the newest first: when two disagree, the newer one wins. Follow them, as long as they don't break the rules above. They're for you: never quote them to a client.";

/** The notes in force, the newest first; none before 0114 runs. */
export async function taughtNotes(db: Db, limit = MAX_NOTES): Promise<Note[]> {
  const { data, error } = await db.from("bot_note").select("id, text, by_name, created_at").is("forgotten_at", null).order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return ((data ?? []) as Note[]).slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** What every call to Claude is told: the newest notes, within the limits. Null with none. */
export function taughtBlock(notes: Note[]): string | null {
  const lines: string[] = [];
  let size = 0;
  for (const n of notes.slice(0, MAX_NOTES)) {
    const line = `- ${oneLine(n.text, NOTE_CHARS)} ${taughtBy(n)}`;
    if (size + line.length > MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length ? [HEAD, ...lines].join("\n") : null;
}

/** The block, from the database (index.ts, with the settings). */
export async function loadTaught(db: Db): Promise<string | null> {
  return taughtBlock(await taughtNotes(db));
}

/** Oldest first, the same way every time: by when, then by id. */
const byTime = (a: { id: string; created_at: string }, b: { id: string; created_at: string }) =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The notes, each with its number for good: the nth note ever taught,
 * forgotten ones included. Teaching or forgetting another never moves it, so
 * "forget 3" is the note an admin saw as 3, whatever was taught since. Two
 * small reads: how many came before the oldest of these, then the ones since.
 * When they can't be read, unnumbered (and none is forgotten by number).
 */
export async function numbered(db: Db, notes: Note[]): Promise<Note[]> {
  if (!notes.length) return notes;
  const from = notes.reduce((a, n) => (byTime(n, a) < 0 ? n : a)).created_at;
  const [older, since] = await Promise.all([
    db.from("bot_note").select("id", { count: "exact", head: true }).lt("created_at", from),
    db.from("bot_note").select("id, created_at").gte("created_at", from).order("created_at").limit(1000),
  ]);
  if (older.error || since.error || older.count == null) return notes;
  const base = older.count;
  const at = new Map(((since.data ?? []) as { id: string; created_at: string }[]).slice().sort(byTime).map((n, i) => [n.id, base + i + 1]));
  return notes.map((n) => ({ ...n, no: at.get(n.id) }));
}

/** What it was taught, for an admin who asks: each with its number for good (n3 is 3 to Claude), so "forget 3" is that one. */
export function listText(notes: Note[]) {
  if (!notes.length) return 'Nothing yet. Teach me with "remember: ..." or "from now on ...".';
  const one = notes.find((n) => n.no !== undefined)?.no;
  return [
    "What I was taught, newest first:",
    ...notes.map((n) => `${n.no !== undefined ? `${n.no}.` : "-"} ${oneLine(n.text, NOTE_CHARS)} ${taughtBy(n)}`),
    ...(one !== undefined ? [`To drop one: "forget ${one}".`] : []),
  ].join("\n");
}

/**
 * Someone on the team teaching the bot, or asking about it (orders.ts): an
 * admin's notes kept, forgotten or listed; anyone else is told only admins
 * can. taught: the notes in force as Claude saw them, with their numbers for
 * good (n3 is the one numbered 3; numbered here when they aren't yet), for
 * replaces and forget. What it was taught is brought up to date in s for the
 * rest of this run. What to say back.
 */
export async function teachFrom(
  db: Db,
  s: { taught?: string | null },
  t: Team,
  by: Person | undefined,
  o: { id: string; chatId: string },
  x: TeachAct,
  taught: Note[],
): Promise<string> {
  if (!by?.active || !by.admin) return x.op === "list" ? "Only admins can see what I was taught." : "Only admins can teach me.";
  const byNumber = x.op === "list" || x.op === "forget" || !!x.replaces?.length;
  if (byNumber && taught.some((n) => n.no === undefined)) taught = await numbered(db, taught);
  if (x.op === "list") return listText(taught);
  // By number for good, never by place in the list: what was taught since doesn't move it.
  const pick = (ids: string[] | undefined) => [
    ...new Set((ids ?? []).map((id) => Number(str(id).replace(/\D/g, ""))).map((no) => taught.find((n) => no > 0 && n.no === no)).filter((n): n is Note => !!n)),
  ];

  if (x.op === "forget") {
    const hit = pick(x.forget);
    if (!hit.length) return taught.length ? "Which one? Nothing I was taught matches." : "I haven't been taught anything yet.";
    await db.from("bot_note").update({ forgotten_at: iso(), forgotten_by: by.id }).in("id", hit.map((n) => n.id)).is("forgotten_at", null);
    s.taught = await loadTaught(db);
    return `Forgot: ${hit.map((n) => bare(n.text)).join("; ")}.`;
  }

  // Something to remember, and whoever it says is or isn't a client.
  const said = [...new Map((x.notes ?? []).map((n) => oneLine(str(n), NOTE_CHARS)).filter(Boolean).map((n) => [same(n), n])).values()].slice(0, PER_MESSAGE);
  const people = (x.people ?? []).filter((p) => str(p.is) && (str(p.ref) || str(p.name)));
  if (!said.length && !people.length) return "What should I remember?";
  // Already taught: kept once.
  const known = new Set(taught.map((n) => same(n.text)));
  const fresh = said.filter((n) => !known.has(same(n)));
  if (fresh.length) {
    const { data, error } = await db
      .from("bot_note")
      .insert(fresh.map((text) => ({ text, by_user: by.id, by_name: by.name, chat_id: o.chatId, source_id: o.id, created_at: iso() })))
      .select("id");
    if (error || !data?.length) {
      console.error("bot_note", error?.message);
      return "Couldn't keep that: teaching me isn't set up yet.";
    }
    // What these change or contradict: forgotten, the newer one in its place.
    const old = pick(x.replaces);
    if (old.length) {
      await db.from("bot_note").update({ forgotten_at: iso(), forgotten_by: by.id, replaced_by: (data[0] as { id: string }).id }).in("id", old.map((n) => n.id)).is("forgotten_at", null);
    }
  }
  const lines = said.length ? [`Got it: ${said.map(bare).join("; ")}.`] : [];
  for (const p of people) {
    const done = await setKind(db, t, by, { ref: str(p.ref), name: str(p.name), is: str(p.is) });
    if (done) lines.push(done);
  }
  s.taught = await loadTaught(db);
  return lines.join(" ") || "Got it.";
}

// ------------------------------------------------- client or not a client --

/** What "not a client" says they are (wa_other.note, 0101). */
const NOT_CLIENT: Record<string, string> = { freelancer: "Freelancer", partner: "Partner", not_client: "Not a client" };

/** Someone said to be a client, or not one: moved where they belong, if they can be. What to say about it, or null. */
async function setKind(db: Db, t: Team, by: Person, p: { ref: string; name: string; is: string }): Promise<string | null> {
  // On the team: nothing to move.
  if (p.ref.startsWith("t:")) return null;
  if (p.is === "client") return p.ref.startsWith("c:") ? null : await backToClients(db, t, p.name);
  const label = NOT_CLIENT[p.is];
  // Not in Clients: nothing to take out (the note says what they are).
  if (!label || !p.ref.startsWith("c:")) return null;
  return await outOfClients(db, t, p.ref.slice(2), `${label}, said ${by.name} on WhatsApp`, by.id, p.is === "freelancer");
}

/**
 * The freelancer (0115) someone is, when one by that name is in iklipse: their
 * number is then the freelancer's, and the bot writes to them as such
 * (people.ts). Null when none or more than one fit, or before 0115 runs; the
 * bot never adds a freelancer itself.
 */
async function freelancerNamed(db: Db, name: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db.from("partner").select("id, name, kind, is_active").eq("kind", "freelancer").eq("is_active", true);
  if (error) return null;
  const want = [name.toLowerCase(), first(name).toLowerCase()];
  const hit = ((data ?? []) as { id: string; name: string | null }[]).filter((f) => want.includes(str(f.name).toLowerCase()) || want.includes(first(f.name).toLowerCase()));
  return hit.length === 1 ? { id: hit[0]!.id, name: str(hit[0]!.name) } : null;
}

/**
 * Out of Clients, into "not clients" (0101): the bot doesn't call them a
 * client again, or add them back from their groups. Only someone the bot put
 * in Clients itself and nobody gave a project: anyone else is changed by hand
 * (Alerts > Groups), as taking them out deletes their row.
 */
async function outOfClients(db: Db, t: Team, id: string, note: string, byId: string, freelancer = false): Promise<string | null> {
  const { data: c } = await db.from("client").select("id, name, name_known, phone, wa_lid, created_by").eq("id", id).maybeSingle();
  if (!c) return null;
  const name = str(c.name) || "They";
  const { data: projects } = await db.from("project").select("id").eq("client_id", id).limit(1);
  if (projects?.length) return `${name} stays in Clients, as they have projects: change it in Alerts > Groups.`;
  if (c.created_by) return `${name} stays in Clients, as someone on the team added them: change it in Alerts > Groups.`;
  const phone = phoneKey(c.phone);
  const lid = str(c.wa_lid) || null;
  if (!phone && !lid) return `${name} stays in Clients: I have no number for them.`;
  const partner = freelancer && c.name_known ? await freelancerNamed(db, str(c.name)) : null;
  const { error } = await db.from("wa_other").insert({ phone, wa_lid: lid, name: c.name_known ? c.name : null, note, created_by: byId, ...(partner ? { partner_id: partner.id } : {}) });
  // Already there (23505): they only need to leave Clients.
  if (error && error.code !== "23505") {
    console.error("wa_other", error.message);
    return `Couldn't take ${name} out of Clients.`;
  }
  // The database takes them out by itself (0101's trigger); here too, in case.
  await db.from("client").delete().eq("id", id);
  if (phone) t.others.add(phone);
  if (lid) t.others.add(lid);
  return `Took ${name} out of Clients${partner ? `, as our freelancer ${partner.name}` : ""}.`;
}

/** Someone in "not clients" who is a client after all: out of it, and their groups looked at again soon, which adds them to Clients (as Alerts > Groups does). */
async function backToClients(db: Db, t: Team, name: string): Promise<string | null> {
  const want = name.toLowerCase();
  if (!want) return null;
  const { data } = await db.from("wa_other").select("id, phone, wa_lid, name");
  const hit = ((data ?? []) as { id: string; phone: string | null; wa_lid: string | null; name: string | null }[]).filter(
    (o) => str(o.name).toLowerCase() === want || first(o.name).toLowerCase() === want,
  );
  if (!hit.length) return null;
  if (hit.length > 1) return `More than one ${name} is marked not a client: change it in Alerts > Groups.`;
  const o = hit[0]!;
  await db.from("wa_other").delete().eq("id", o.id);
  const where = [o.phone ? `phone.eq.${o.phone}` : "", o.wa_lid ? `lid.eq.${o.wa_lid}` : "", o.wa_lid ? `wa_id.eq.${o.wa_lid}` : ""].filter(Boolean);
  const { data: parts } = where.length ? await db.from("wa_participant").select("chat_id").or(where.join(",")) : { data: [] };
  const chats = [...new Set(((parts ?? []) as { chat_id: string }[]).map((x) => x.chat_id))];
  if (chats.length) await db.from("wa_group").update({ people_at: null }).in("chat_id", chats);
  if (o.phone) t.others.delete(o.phone);
  if (o.wa_lid) t.others.delete(o.wa_lid);
  return `${str(o.name) || name} goes back in Clients the next time I look at their groups.`;
}
