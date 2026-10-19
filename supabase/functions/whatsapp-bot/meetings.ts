// Meetings on the team's Calendly (0088). Every meeting the bot books, and
// every one people book themselves from a link (Calendly tells us, and the bot
// looks every few minutes, for free plans), is kept. Everyone on it that
// iklipse knows (the team by their emails on the Users page, clients by theirs
// in Clients) gets its details privately on WhatsApp, and a reminder an hour
// before. Anyone else is left to Calendly's own emails. Always English.

import { accessToken, eventTypes, getEvent, inviteesOf, nameFromEmail, scheduledEvents } from "../_shared/calendly.ts";
import { iso, MIN, str, TZ, type Db, type Settings } from "./kit.ts";
import { phoneKey, type Send } from "./people.ts";

/** Someone on a meeting. */
export interface Attendee {
  kind: "team" | "client" | "guest";
  /** Their profile (team) or Clients row (client). */
  id: string | null;
  name: string;
  email: string | null;
  /** Their WhatsApp number (digits), when iklipse has it. */
  phone: string | null;
  /** The one whose Calendly it's on. */
  host?: boolean;
}

interface Row {
  event_id: string;
  account: string | null;
  owner: string;
  topic: string;
  start_at: string;
  minutes: number | null;
  join_url: string | null;
  invitee_email: string | null;
  invitee_name: string | null;
  attendees: Attendee[] | null;
  created_at: string;
}
const COLS = "event_id, account, owner, topic, start_at, minutes, join_url, invitee_email, invitee_name, attendees, created_at";

// ------------------------------------------------------------- Cairo time --

const dayName = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" });
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
/** "Sunday 25-12-2026, 3:00 PM" */
const whenText = (ms: number) =>
  `${dayName.format(new Date(ms))} ${ymd.format(new Date(ms)).split("-").reverse().join("-")}, ${clock.format(new Date(ms)).replace(/[  ]/g, " ")}`;
const time12 = (ms: number) => clock.format(new Date(ms)).replace(/[  ]/g, " ");
/** "30 min", "1 hour 30 min" */
function length(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} min`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}

// ------------------------------------------------------------- who's who --

/** The team (active) and the clients, by email; the team by id. With their WhatsApp numbers. */
export async function directory(db: Db) {
  const [profiles, cards, links, clients] = await Promise.all([
    db.from("profile").select("id, display_name, is_active"),
    db.from("profile_contact").select("user_id, whatsapp, email"),
    db.from("wa_member").select("phone, user_id").order("created_at"),
    db.from("client").select("id, name, company, email, phone, name_known"),
  ]);
  const card = new Map((cards.data ?? []).map((c) => [c.user_id as string, c]));
  const linked = new Map<string, string>();
  for (const l of links.data ?? []) if (!linked.has(l.user_id)) linked.set(l.user_id, l.phone);
  const team = new Map<string, Attendee>();
  const byEmail = new Map<string, Attendee>();
  for (const p of profiles.data ?? []) {
    if (!p.is_active) continue;
    const c = card.get(p.id);
    const a: Attendee = { kind: "team", id: p.id, name: p.display_name || "Someone", email: str(c?.email).toLowerCase() || null, phone: c?.whatsapp ?? linked.get(p.id) ?? null };
    team.set(p.id, a);
    if (a.email) byEmail.set(a.email, a);
  }
  const clientsById = new Map<string, Attendee>();
  for (const c of clients.data ?? []) {
    const phone = phoneKey(c.phone);
    const a: Attendee = {
      kind: "client",
      id: c.id,
      name: c.name_known ? `${c.name}${c.company ? ` (${c.company})` : ""}` : phone ? `+${phone}` : c.name,
      email: str(c.email).toLowerCase() || null,
      phone: phone && /^[1-9]\d{7,14}$/.test(phone) ? phone : null,
    };
    clientsById.set(c.id, a);
    if (a.email && !byEmail.has(a.email)) byEmail.set(a.email, a);
  }
  return { team, byEmail, clients: clientsById };
}

/** Who is on a meeting: kept on it, else read from Calendly (its invitees and guests) and kept. */
async function attendeesOf(db: Db, row: Row): Promise<Attendee[]> {
  if (row.attendees?.length) return row.attendees;
  const dir = await directory(db);
  const list: Attendee[] = [];
  const host = dir.team.get(row.owner);
  if (host) list.push({ ...host, host: true });
  let join = row.join_url;
  let invitee: { email: string; name: string } | null = null;
  const token = row.account ? await accessToken(db, row.account) : null;
  if (token) {
    const [ev, inv] = await Promise.all([getEvent(token, row.event_id).catch(() => null), inviteesOf(token, row.event_id).catch(() => [])]);
    join ??= ev?.location?.join_url ?? null;
    const people = [
      ...inv.filter((i) => i.status === "active").map((i) => ({ email: str(i.email).toLowerCase(), name: str(i.name) })),
      ...(ev?.event_guests ?? []).map((g) => ({ email: str(g.email).toLowerCase(), name: "" })),
    ];
    invitee = people[0] ?? null;
    for (const p of people) {
      if (!p.email || list.some((a) => a.email === p.email)) continue;
      const known = dir.byEmail.get(p.email);
      if (known && list.some((a) => a.kind === known.kind && a.id === known.id)) continue;
      list.push(known ?? { kind: "guest", id: null, name: p.name || nameFromEmail(p.email), email: p.email, phone: null });
    }
  }
  await db
    .from("wa_bot_meeting")
    .update({
      attendees: list,
      join_url: join,
      ...(!row.invitee_email && invitee ? { invitee_email: invitee.email, invitee_name: invitee.name || null } : {}),
      updated_at: iso(),
    })
    .eq("event_id", row.event_id);
  row.join_url = join;
  return list;
}

/** "Sara (Acme), Rabah and Sameh" */
const names = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ---------------------------------------------------------------- telling --

/**
 * A meeting's details, privately, to everyone on it iklipse knows (once: only
 * the run that claims it). The number of people told.
 */
export async function tellMeeting(db: Db, send: Send, eventId: string, bot: string | null) {
  const { data } = await db
    .from("wa_bot_meeting")
    .update({ told_at: iso() })
    .eq("event_id", eventId)
    .eq("status", "booked")
    .is("told_at", null)
    .select(COLS)
    .maybeSingle();
  if (!data) return 0;
  const row = data as Row;
  if (Date.parse(row.start_at) < Date.now()) return 0;
  const people = await attendeesOf(db, row);
  let told = 0;
  for (const a of people) {
    if (!a.phone || a.kind === "guest" || a.phone === bot) continue;
    const others = people.filter((x) => x !== a).map((x) => x.name);
    const text = [
      `Meeting booked: *${row.topic}*`,
      `${whenText(Date.parse(row.start_at))} Cairo time${row.minutes ? `, ${length(row.minutes)}` : ""}`,
      ...(others.length ? [`With ${names(others)}`] : []),
      row.join_url ?? "The link is in Calendly's email.",
    ].join("\n");
    try {
      await send(`${a.phone}@c.us`, text);
      told++;
    } catch (e) {
      console.error("meeting tell", (e as Error).message);
    }
  }
  return told;
}

/** Meetings not told yet (booked from a link, or moved on Calendly): told now. */
export async function tellNew(db: Db, send: Send, bot: string | null, deadline: number) {
  const { data } = await db.from("wa_bot_meeting").select("event_id, start_at").eq("status", "booked").is("told_at", null).order("start_at").limit(5);
  let told = 0;
  for (const m of data ?? []) {
    if (Date.now() > deadline) break;
    if (Date.parse(m.start_at) < Date.now()) {
      await db.from("wa_bot_meeting").update({ told_at: iso() }).eq("event_id", m.event_id);
      continue;
    }
    told += await tellMeeting(db, send, m.event_id, bot);
  }
  return told;
}

/** An hour before a meeting: a reminder to everyone on it iklipse knows (not for one booked within that hour). */
export async function remindSoon(db: Db, send: Send, bot: string | null, deadline: number) {
  const { data } = await db
    .from("wa_bot_meeting")
    .select("event_id, start_at")
    .eq("status", "booked")
    .is("reminded_at", null)
    .lte("start_at", iso(Date.now() + 60 * MIN))
    .order("start_at")
    .limit(10);
  let sent = 0;
  for (const m of data ?? []) {
    if (Date.now() > deadline) break;
    const { data: claimed } = await db
      .from("wa_bot_meeting")
      .update({ reminded_at: iso() })
      .eq("event_id", m.event_id)
      .is("reminded_at", null)
      .select(COLS)
      .maybeSingle();
    if (!claimed) continue;
    const row = claimed as Row;
    const start = Date.parse(row.start_at);
    if (start < Date.now() || Date.parse(row.created_at) > start - 60 * MIN) continue;
    const people = await attendeesOf(db, row);
    if (!row.join_url && row.account) {
      const token = await accessToken(db, row.account);
      const ev = token ? await getEvent(token, row.event_id).catch(() => null) : null;
      if (ev?.location?.join_url) {
        row.join_url = ev.location.join_url;
        await db.from("wa_bot_meeting").update({ join_url: row.join_url }).eq("event_id", row.event_id);
      }
    }
    const mins = Math.max(1, Math.round((start - Date.now()) / MIN));
    const text = [
      `Reminder: *${row.topic}* starts ${mins >= 55 ? "in 1 hour" : `in ${mins} minutes`}, at ${time12(start)} Cairo time.`,
      row.join_url ?? "The link is in Calendly's email.",
    ].join("\n");
    for (const a of people) {
      if (!a.phone || a.kind === "guest" || a.phone === bot) continue;
      try {
        await send(`${a.phone}@c.us`, text);
        sent++;
      } catch (e) {
        console.error("meeting remind", (e as Error).message);
      }
    }
  }
  return sent;
}

// ------------------------------------------------------------ Calendly --

/**
 * Each connected Calendly's meetings, read every few minutes (every half hour
 * when Calendly tells us itself): new ones are kept (to be told), cancelled
 * ones stop. The first read keeps what's there without telling anyone.
 */
export async function pollCalendly(db: Db, deadline: number) {
  const { data: accounts } = await db.from("calendly_account").select("id, user_id, calendly_user, webhook, polled_at").order("polled_at", { ascending: true, nullsFirst: true });
  let found = 0;
  for (const a of accounts ?? []) {
    if (Date.now() > deadline) break;
    const every = (a.webhook ? 30 : 5) * MIN;
    if (a.polled_at && Date.now() - Date.parse(a.polled_at) < every) continue;
    await db.from("calendly_account").update({ polled_at: iso() }).eq("id", a.id);
    const token = await accessToken(db, a.id);
    if (!token) continue;
    const from = iso(Date.now() - 2 * 60 * MIN);
    const to = iso(Date.now() + 60 * 24 * 60 * MIN);
    let events;
    try {
      events = await scheduledEvents(token, a.calendly_user, from, to, "active");
    } catch (e) {
      console.error("calendly poll", (e as Error).message);
      continue;
    }
    const ids = events.map((e) => e.uri.split("/").pop()!).filter(Boolean);
    const { data: have } = ids.length ? await db.from("wa_bot_meeting").select("event_id").in("event_id", ids) : { data: [] };
    const known = new Set((have ?? []).map((h) => h.event_id as string));
    const first = !a.polled_at;
    const fresh = events
      .filter((e) => !known.has(e.uri.split("/").pop()!))
      .map((e) => ({
        event_id: e.uri.split("/").pop()!,
        account: a.id,
        owner: a.user_id,
        chat_id: null,
        source: "link",
        topic: str(e.name).slice(0, 200) || "Meeting",
        start_at: e.start_time,
        minutes: Math.max(1, Math.round((Date.parse(e.end_time) - Date.parse(e.start_time)) / MIN)),
        join_url: e.location?.join_url ?? null,
        ...(first ? { told_at: iso(), reminded_at: Date.parse(e.start_time) < Date.now() + 60 * MIN ? iso() : null } : {}),
      }));
    if (fresh.length) {
      await db.from("wa_bot_meeting").upsert(fresh, { onConflict: "event_id", ignoreDuplicates: true });
      if (!first) found += fresh.length;
    }
    // Cancelled on Calendly: ours on this account in that window that aren't there anymore.
    const { data: ours } = await db
      .from("wa_bot_meeting")
      .select("event_id, created_at")
      .eq("account", a.id)
      .eq("status", "booked")
      .gte("start_at", from)
      .lte("start_at", to);
    const gone = (ours ?? []).filter((m) => !ids.includes(m.event_id) && Date.now() - Date.parse(m.created_at) > 2 * MIN).map((m) => m.event_id);
    if (gone.length) await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: iso() }).in("event_id", gone);
  }
  return found;
}

let linkMemo: { account: string; url: string | null; at: number } | null = null;

/** The booking link clients get (the Calendly picked in Settings, its event type for the bot); null: none. */
export async function bookingLink(db: Db, s: Settings): Promise<string | null> {
  if (!s.book_link_account) return null;
  if (linkMemo && linkMemo.account === s.book_link_account && Date.now() - linkMemo.at < 10 * MIN) return linkMemo.url;
  const { data: a } = await db.from("calendly_account").select("calendly_user, event_type, scheduling_url").eq("id", s.book_link_account).maybeSingle();
  if (!a) return null;
  let url: string | null = a.scheduling_url ?? null;
  const token = await accessToken(db, s.book_link_account);
  if (token) {
    const types = await eventTypes(token, a.calendly_user).catch(() => []);
    url = (types.find((t) => t.uri === a.event_type) ?? types[0])?.scheduling_url ?? url;
  }
  linkMemo = { account: s.book_link_account, url, at: Date.now() };
  return url;
}
