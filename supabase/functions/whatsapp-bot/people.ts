// The people in the client groups (0086). Everyone in a client group who isn't
// on the team is a client: the bot keeps them in Clients (the Projects page)
// with their name on WhatsApp and their number. What's missing (a name, the
// number WhatsApp hides, the email) it asks one person for by WhatsApp, or a
// team group, again every so often until it's all there (Alerts > Settings).
// A reply fills it in; "skip" stops it asking about someone; a team member's
// name links that number to them instead. Filled in on the Projects page, it
// stops by itself. It never asks in a client group.

import { backoff, claude, iso, stillQueued, str, type ClaudeTool, type Db, type Person, type Settings, type Team } from "./kit.ts";

/** Sends a WhatsApp message (as a reply to quotedId, when given); the id of what it sent. */
export type Send = (chatId: string, text: string, quotedId?: string | null) => Promise<string | null>;

/** A number as WhatsApp writes it: digits with the country code ("01001234567" -> "201001234567"). */
export function phoneKey(v: unknown): string | null {
  const d = str(v).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) return d.slice(2) || null;
  if (/^0\d{10}$/.test(d)) return `20${d.slice(1)}`;
  return d;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** People listed in one message, at most. */
const PER_MESSAGE = 15;

interface Client {
  id: string;
  name: string;
  name_known: boolean;
  email: string | null;
  phone: string | null;
  company: string | null;
  wa_lid: string | null;
  ask_skip: boolean;
  created_by: string | null;
  from_chat: string | null;
}
const COLS = "id, name, name_known, email, phone, company, wa_lid, ask_skip, created_by, from_chat";

/** What the bot still needs to know about a client. */
const missing = (c: Pick<Client, "name_known" | "phone" | "email">) => [
  ...(c.name_known ? [] : ["name"]),
  ...(c.phone ? [] : ["number"]),
  ...(c.email ? [] : ["email"]),
];

/** "Sara (+201001234567)", "+201001234567", "Omar (number hidden)" */
function who(c: Client) {
  const phone = phoneKey(c.phone);
  if (!c.name_known) return phone ? `+${phone}` : c.name && c.name !== "Unknown" ? `${c.name} (number hidden)` : "Someone (number hidden)";
  return `${c.name} (${phone ? `+${phone}` : "number hidden"})`;
}

// ----------------------------------------------------------- the groups --

/** Clients by number and by hidden-number id. */
async function clientIndex(db: Db) {
  const { data } = await db.from("client").select(COLS);
  const byPhone = new Map<string, Client>();
  const byLid = new Map<string, Client>();
  for (const c of (data ?? []) as Client[]) {
    const k = phoneKey(c.phone);
    if (k && !byPhone.has(k)) byPhone.set(k, c);
    if (c.wa_lid) byLid.set(c.wa_lid, c);
  }
  return { byPhone, byLid };
}

/**
 * The client groups whose people changed since they were last checked (read
 * again, or someone wrote): everyone who isn't on the team is in Clients, and
 * what's missing about them is asked.
 */
export async function learnPeople(db: Db, t: Team, bot: string | null, deadline: number) {
  const { data: groups } = await db
    .from("wa_group")
    .select("chat_id, people_at, synced_at, last_message_at")
    .eq("kind", "client")
    .eq("monitored", true)
    .is("left_at", null);
  const after = (a: string | null, b: string | null) => !!a && (!b || Date.parse(a) > Date.parse(b));
  const due = (groups ?? []).filter((g) => !g.people_at || after(g.synced_at, g.people_at) || after(g.last_message_at, g.people_at)).slice(0, 5);
  if (!due.length) return 0;
  const idx = await clientIndex(db);
  let added = 0;
  for (const g of due) {
    if (Date.now() > deadline) break;
    added += await learnGroup(db, t, bot, g.chat_id, idx);
  }
  return added;
}

async function learnGroup(db: Db, t: Team, bot: string | null, chatId: string, idx: Awaited<ReturnType<typeof clientIndex>>) {
  const started = iso();
  const { data: parts } = await db.from("wa_participant").select("wa_id, phone, lid, name").eq("chat_id", chatId);
  let added = 0;
  const ask: string[] = [];
  for (const p of parts ?? []) {
    const phone = (p.phone as string | null) || null;
    const lid = str(p.lid) || (str(p.wa_id).endsWith("@lid") ? str(p.wa_id) : "") || null;
    if (phone && phone === bot) continue;
    if ((phone && t.byPhone.has(phone)) || (lid && t.byLid.has(lid))) continue;
    // Not a client: a freelancer, a partner (0101).
    if ((phone && t.others.has(phone)) || (lid && t.others.has(lid))) continue;
    if (!phone && !lid) continue;
    const name = str(p.name) || null;
    let c = (phone ? idx.byPhone.get(phone) : undefined) ?? (lid ? idx.byLid.get(lid) : undefined);
    if (!c) {
      const { data: made, error } = await db
        .from("client")
        .insert({ name: name ?? (phone ? `+${phone}` : "Unknown"), name_known: !!name, phone: phone ? `+${phone}` : null, wa_lid: lid, from_chat: chatId })
        .select(COLS)
        .single();
      if (error || !made) continue;
      c = made as Client;
      added++;
    } else {
      // What WhatsApp shows that Clients doesn't have yet.
      const patch: Partial<Client> = {};
      if (!c.phone && phone) patch.phone = `+${phone}`;
      if (!c.wa_lid && lid && !idx.byLid.has(lid)) patch.wa_lid = lid;
      if (!c.name_known && name) Object.assign(patch, { name, name_known: true });
      if (Object.keys(patch).length) {
        const { data: up } = await db.from("client").update({ ...patch, updated_at: iso() }).eq("id", c.id).select(COLS).single();
        if (up) c = up as Client;
      }
    }
    if (phone) idx.byPhone.set(phone, c);
    if (lid) idx.byLid.set(lid, c);
    if (!c.ask_skip && missing(c).length) ask.push(c.id);
  }
  if (ask.length) {
    await db.from("bot_ask").upsert(
      ask.map((id) => ({ client_id: id, chat_id: chatId })),
      { onConflict: "client_id", ignoreDuplicates: true },
    );
  }
  await db.from("wa_group").update({ people_at: started }).eq("chat_id", chatId);
  return added;
}

/** What WhatsApp shows about someone (getContactInfo): the name on their profile, a business's email, the number behind a hidden one. */
export type Look = (chatId: string) => Promise<{ name?: string; contactName?: string; email?: string; phone?: string | null } | null>;

/** A WhatsApp profile name worth keeping: some letters, without the emoji and dots around it. */
function realName(v: unknown) {
  const n = str(v).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.)]+$/gu, "").trim();
  return n.length <= 60 && (n.match(/\p{L}/gu) ?? []).length >= 2 ? n : null;
}

/**
 * Clients known only by their number (0100): the name on their WhatsApp
 * profile (even if they never wrote), a business account's email, and on the
 * bot's own bridge the number WhatsApp hides. A few a run, each looked up
 * again a week later if still missing something.
 */
export async function lookUpNames(db: Db, t: Team, look: Look, deadline: number) {
  // Never looked up first, then the longest ago: once the first is recent, they all are.
  const { data } = await db
    .from("client")
    .select(`${COLS}, wa_looked_at`)
    .or("name_known.eq.false,phone.is.null")
    .order("wa_looked_at", { ascending: true, nullsFirst: true })
    .limit(8);
  const due = ((data ?? []) as (Client & { wa_looked_at: string | null })[]).filter((c) => !c.wa_looked_at || Date.now() - Date.parse(c.wa_looked_at) > 7 * 24 * 60 * 60_000);
  if (!due.length) return 0;
  const idx = await clientIndex(db);
  let named = 0;
  for (const c of due) {
    if (Date.now() > deadline) break;
    const phone = phoneKey(c.phone);
    const id = phone && /^[1-9]\d{7,14}$/.test(phone) ? `${phone}@c.us` : c.wa_lid;
    if (!id) {
      await db.from("client").update({ wa_looked_at: iso() }).eq("id", c.id);
      continue;
    }
    let info: Awaited<ReturnType<Look>> = null;
    try {
      info = await look(id);
    } catch (e) {
      console.error("contact info", (e as Error).message);
    }
    const patch: Record<string, unknown> = { wa_looked_at: iso() };
    const name = realName(info?.name) ?? realName(info?.contactName);
    if (!c.name_known && name) Object.assign(patch, { name, name_known: true });
    const email = str(info?.email).toLowerCase();
    if (!c.email && EMAIL.test(email)) patch.email = email;
    const found = phoneKey(info?.phone);
    // The number behind a hidden one: unless it's the team's or another client's.
    if (!phone && found && /^[1-9]\d{7,14}$/.test(found) && !t.byPhone.has(found) && !idx.byPhone.has(found)) patch.phone = `+${found}`;
    if (patch.name || patch.email || patch.phone) named++;
    const { error } = await db.from("client").update({ ...patch, ...(Object.keys(patch).length > 1 ? { updated_at: iso() } : {}) }).eq("id", c.id);
    // A number that's the team's or not a client's (0101): the rest is still kept.
    if (error && patch.phone) {
      delete patch.phone;
      await db.from("client").update(patch).eq("id", c.id);
    }
  }
  return named;
}

// -------------------------------------------------------------- asking --

/** Where the bot asks: the person's private chat, or the team group (null: nowhere yet). */
export async function askPlace(db: Db, s: Settings): Promise<string | null> {
  if (s.ask_to === "person") return s.ask_phone ? `${s.ask_phone}@c.us` : null;
  if (!s.ask_group) return null;
  const { data: g } = await db.from("wa_group").select("kind, left_at").eq("chat_id", s.ask_group).maybeSingle();
  return g && g.kind === "team" && !g.left_at ? s.ask_group : null;
}

interface Ask {
  client_id: string;
  chat_id: string | null;
  times: number;
  next_at: string;
  /** A meeting waits on their email (that conversation). */
  meeting: string | null;
  client: Client | null;
  wa_group: { name: string | null; kind: string } | null;
}

/** The asks still open (the ones answered, skipped or in a team group now are dropped). */
async function openAsks(db: Db): Promise<Ask[]> {
  const { data } = await db
    .from("bot_ask")
    .select(`client_id, chat_id, times, next_at, meeting, client(${COLS}), wa_group(name, kind)`)
    .order("created_at");
  const open: Ask[] = [];
  const done: string[] = [];
  for (const a of (data ?? []) as unknown as Ask[]) {
    const c = a.client;
    if (!c || (c.ask_skip && !a.meeting) || !missing(c).length || (a.wa_group?.kind === "team" && !a.meeting)) done.push(a.client_id);
    else open.push(a);
  }
  if (done.length) await db.from("bot_ask").delete().in("client_id", done);
  return open;
}

/**
 * Ask for what's missing when some of it is due: one message with everyone
 * still missing something (up to PER_MESSAGE), then again after ask_every_min,
 * and less often each time nobody answers (twice that, 4 times..., at most a
 * day apart; someone new starts it over). With asking off, only the emails
 * meetings wait on.
 */
export async function askNow(db: Db, s: Settings, send: Send) {
  const place = await askPlace(db, s);
  if (!place) return 0;
  const open = (await openAsks(db)).filter((a) => s.ask_enabled || (a.meeting && !a.client!.email));
  const needs = (a: Ask) => (s.ask_enabled ? missing(a.client!) : ["email"]);
  if (!open.length || !open.some((a) => Date.parse(a.next_at) <= Date.now())) return 0;
  // The last one hasn't gone out yet (the phone is offline): nothing piles up behind it.
  const { data: prev } = await db.from("bot_ask_message").select("id, sent_at").eq("chat_id", place).order("sent_at", { ascending: false }).limit(1);
  if (await stillQueued(db, place, prev?.[0]?.id, prev?.[0]?.sent_at)) return 0;
  const list = open.slice(0, PER_MESSAGE);
  const again = list.every((a) => a.times > 0);
  const lines = list.map((a, i) => `${i + 1}. ${who(a.client!)}${a.wa_group?.name ? ` in ${a.wa_group.name}` : ""}: ${needs(a).join(", ")}${a.meeting ? " (a meeting waits on it)" : ""}`);
  const how = place.endsWith("@g.us") ? "Reply to this message" : "Reply here";
  const text = [
    again ? "Still missing these details:" : "I need a few details about people in the client groups:",
    ...lines,
    "",
    `${how}, like "1 sara@company.com". "2 skip" stops me asking about someone, and "3 is Rabah" means they're on our team.`,
  ].join("\n");
  const id = await send(place, text);
  if (id) await db.from("bot_ask_message").insert({ id, chat_id: place, clients: list.map((a) => a.client_id) });
  // A meeting waiting on someone's email is asked about at the usual pace.
  const asked = Math.min(...list.map((a) => (a.meeting ? 0 : a.times)));
  const next = iso(Date.now() + backoff(s.ask_every_min, asked));
  for (const a of open) {
    const listed = list.includes(a);
    await db
      .from("bot_ask")
      .update({ next_at: next, ...(listed ? { times: a.times + 1, last_at: iso() } : {}) })
      .eq("client_id", a.client_id);
  }
  return list.length;
}

// ------------------------------------------------------------- answers --

const TOOL: ClaudeTool = {
  name: "details",
  description: "What the reply says about the people the bot asked about.",
  input_schema: {
    type: "object",
    properties: {
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer", description: "Their number in the bot's list." },
            name: { type: "string" },
            email: { type: "string" },
            phone: { type: "string", description: "Their WhatsApp number, with the country code if given." },
            company: { type: "string" },
            team_member: { type: "string", description: "The id of the team member this person is, when the reply says they're on the team." },
            skip: { type: "boolean", description: "The reply says to stop asking about them." },
          },
          required: ["n"],
        },
      },
    },
    required: ["people"],
  },
};

const SYSTEM = `The iklipse bot asked someone on the iklipse team (a creative and marketing agency) for missing details about people in client WhatsApp groups. You get the bot's numbered list, the team members, and the reply. Report through the details tool what the reply gives for each person, by their number in the list: a name, an email, a WhatsApp number, a company, that they're on the team (the team member's id from the list), or to skip them. People write in English, Arabic, Egyptian Arabic or Franco-Arabic.
People are named by their number in the list, by their name, or by the group they're in ("in client test her email is ..." is the one in that group, when only one there fits). A list number stuck to the start of an email ("6sara@x.com" when the list has a 6) is that number, and the email is the rest.
Only what the reply says: never invent an email, a number or a name. "skip", "ignore", "not a client", "سيبه", "مش مهم" mean skip. "is Rabah", "ده رباح", "from our team" mean team_member (only an id from the list; when the name matches nobody there, leave it out). Several people in one reply are fine. When the reply gives nothing for anyone, return an empty list.
Always answer by calling the details tool, once.`;

interface Detail {
  n: number;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  team_member?: string;
  skip?: boolean;
}

/** Already acted on (WhatsApp can send a message again): true the first time only. */
export async function firstTime(db: Db, id: string) {
  const { data } = await db.from("bot_heard").upsert({ id }, { onConflict: "id", ignoreDuplicates: true }).select("id");
  return !!data?.length;
}

/** The message it replies to is the bot asking for details. */
export async function repliesToAsk(db: Db, quotedId: string | null) {
  if (!quotedId) return false;
  const { data } = await db.from("bot_ask_message").select("id").eq("id", quotedId).maybeSingle();
  return !!data;
}

/**
 * A message where the bot asks: what it says about the people asked about is
 * saved, and the bot says what it saved. true: it was an answer.
 */
export async function takeAnswer(
  db: Db,
  s: Settings,
  t: Team,
  o: { id: string; chatId: string; text: string; quotedId: string | null },
  send: Send,
): Promise<boolean> {
  const text = o.text.trim();
  if (!text) return false;
  // The list it answers: the one it replies to, else the last one sent there.
  const { data: rows } = o.quotedId
    ? await db.from("bot_ask_message").select("id, clients").eq("id", o.quotedId).limit(1)
    : await db.from("bot_ask_message").select("id, clients").eq("chat_id", o.chatId).order("sent_at", { ascending: false }).limit(1);
  const asked = rows?.[0] as { id: string; clients: string[] } | undefined;
  if (!asked) return false;
  const { data: cl } = await db.from("client").select(COLS).in("id", asked.clients);
  const byId = new Map(((cl ?? []) as Client[]).map((c) => [c.id, c]));
  const list = asked.clients.map((id) => byId.get(id)).filter((c): c is Client => !!c);
  if (!list.length) return false;
  // The group each one is in, as the bot's list said it.
  const chats = [...new Set(list.map((c) => c.from_chat).filter((x): x is string => !!x))];
  const { data: gs } = chats.length ? await db.from("wa_group").select("chat_id, name").in("chat_id", chats) : { data: [] };
  const groupOf = new Map(((gs ?? []) as { chat_id: string; name: string | null }[]).map((g) => [g.chat_id, g.name]));

  const members = [...t.people.values()].filter((p) => p.active);
  const user = [
    "The bot's list:",
    ...list.map((c, i) => `${i + 1}. ${who(c)}${c.from_chat && groupOf.get(c.from_chat) ? ` in ${groupOf.get(c.from_chat)}` : ""}: needs ${missing(c).join(", ") || "nothing more"}`),
    "",
    "The team (id: name, username):",
    ...members.map((p) => `${p.id}: ${p.name}, ${p.username}`),
    "",
    `The reply: ${text.slice(0, 2000)}`,
  ].join("\n");
  const r = (await claude(s, { name: "people.answer", role: "fast" }, SYSTEM, user, TOOL, 1200)) as { people?: Detail[] } | null;
  const said = (r?.people ?? []).filter((d) => Number.isInteger(d.n) && d.n >= 1 && d.n <= list.length);

  const done: string[] = [];
  for (const d of said) {
    const c = list[d.n - 1]!;
    const member = d.team_member ? t.people.get(d.team_member) : undefined;
    if (member) {
      await toTeam(db, c, member);
      done.push(`${who(c)} is ${member.name}`);
      continue;
    }
    if (d.skip) {
      await db.from("client").update({ ask_skip: true, updated_at: iso() }).eq("id", c.id);
      await db.from("bot_ask").delete().eq("client_id", c.id);
      done.push(`I'll stop asking about ${who(c)}`);
      continue;
    }
    const patch: Record<string, unknown> = {};
    const email = str(d.email).toLowerCase();
    if (EMAIL.test(email)) patch.email = email;
    const phone = phoneKey(d.phone);
    if (phone && /^[1-9]\d{7,14}$/.test(phone)) patch.phone = `+${phone}`;
    if (str(d.name)) Object.assign(patch, { name: str(d.name).slice(0, 200), name_known: true });
    if (str(d.company)) patch.company = str(d.company).slice(0, 200);
    if (!Object.keys(patch).length) continue;
    const { data: up } = await db.from("client").update({ ...patch, updated_at: iso() }).eq("id", c.id).select(COLS).single();
    const now = (up ?? c) as Client;
    // Everything there, or the email a meeting waited on (the meeting goes ahead; the rest is asked as usual).
    if (!missing(now).length) await db.from("bot_ask").delete().eq("client_id", c.id);
    else if (now.email) await db.from("bot_ask").update({ meeting: null }).eq("client_id", c.id);
    done.push([now.name_known ? now.name : who(now), now.email].filter(Boolean).join(", "));
  }

  if (done.length) {
    const left = (await openAsks(db)).length;
    await send(o.chatId, `Saved: ${done.join("; ")}.${left ? ` ${left} still missing something.` : " That's everyone."}`, o.id);
  } else if (o.quotedId) {
    await send(o.chatId, `I couldn't tell who that's for. Reply like "1 sara@company.com".`, o.id);
  }
  return done.length > 0;
}

/** They're on the team: their number (or hidden-number id) is linked to that member, and they're no client. */
async function toTeam(db: Db, c: Client, member: Person) {
  const phone = phoneKey(c.phone);
  if (phone && /^[1-9]\d{7,14}$/.test(phone)) await db.from("wa_member").upsert({ phone, user_id: member.id }, { onConflict: "phone" });
  if (c.wa_lid) await db.from("wa_member_lid").upsert({ lid: c.wa_lid, user_id: member.id }, { onConflict: "lid" });
  // One the bot added itself, on no project, goes; anyone else stays, unasked.
  const { count } = await db.from("project").select("id", { count: "exact", head: true }).eq("client_id", c.id);
  if (!c.created_by && c.from_chat && !count) await db.from("client").delete().eq("id", c.id);
  else {
    await db.from("client").update({ ask_skip: true, updated_at: iso() }).eq("id", c.id);
    await db.from("bot_ask").delete().eq("client_id", c.id);
  }
}
