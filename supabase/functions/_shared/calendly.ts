// Calendly for the edge functions (0084): each person's own
// accounts (one of them the WhatsApp bot's, with the event type it books
// with), a token refreshed when it runs out, event types, open times,
// scheduled events, booking and cancelling. Used by the calendly function
// (connecting, the Calendly page) and whatsapp-bot (meetings an admin asks
// for in a WhatsApp group).
//
// Calendly's rules that shape this:
// - Access tokens last 2 hours; a refresh token works once (each refresh gives
//   a new one), so only the first of two parallel refreshes may write.
// - Booking for someone (POST /invitees, the Scheduling API) needs a paid
//   Calendly plan (Standard and up), an invitee email, and a time that's open
//   on the event type. Its length is the event type's.
// - There's no moving a booked meeting: cancel it and book again.
// - The meeting's link (Calendly's own Zoom or Google Meet) comes a moment
//   after the booking.
//
// Secrets: CALENDLY_CLIENT_ID, CALENDLY_CLIENT_SECRET (the Calendly app's).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const CLIENT_ID = Deno.env.get("CALENDLY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("CALENDLY_CLIENT_SECRET") ?? "";
export const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
const basic = () => `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;

export const AUTH = "https://auth.calendly.com";
const API = "https://api.calendly.com";
/**
 * What iklipse asks for (the same ones are ticked on the Calendly app).
 * scheduled_events:write doesn't let it read them: listing the meetings needs
 * scheduled_events:read too.
 */
export const SCOPES =
  Deno.env.get("CALENDLY_SCOPES") ?? "users:read event_types:read availability:read scheduled_events:read scheduled_events:write webhooks:write scheduling_links:write";

/** Calendly said this token lacks access (its required_scopes are in the message). */
export const missingScopes = (e: unknown) => /required_scopes|Insufficient scope|needs access to/i.test((e as Error)?.message ?? "");

export interface CalendlyTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  /** https://api.calendly.com/users/... and .../organizations/... */
  owner?: string;
  organization?: string;
}

export async function tokenCall(body: Record<string, string>): Promise<CalendlyTokens> {
  const res = await fetch(`${AUTH}/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`calendly token: ${[data.error, data.error_description].filter(Boolean).join(" ") || res.status}`);
  return data as CalendlyTokens;
}

/** Tells Calendly this token is done with (best effort). */
export async function revoke(token: string) {
  if (!configured()) return;
  await fetch(`${AUTH}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, token }),
  }).catch(() => undefined);
}

export const expiry = (t: CalendlyTokens) => new Date(Date.now() + Math.max(60, (t.expires_in ?? 7200) - 60) * 1000).toISOString();

/**
 * Which account and event type the bot books with (for_bot, set_event_type) is
 * an admin's choice, as on the Calendly page: checked here too, not only in
 * the app, so nobody else changes it by calling the function directly.
 */
export async function mayPickForBot(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await db.from("profile").select("role, is_active").eq("id", userId).maybeSingle();
  return !!data?.is_active && data.role === "admin";
}

/** The account the WhatsApp bot books on for this person: the one they picked, else their first. */
export async function botAccount(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from("calendly_account").select("id").eq("user_id", userId).order("for_bot", { ascending: false }).order("connected_at").limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

/** A working access token for this account, refreshed if needed (null = reconnect). */
export async function accessToken(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data: row } = await db.from("calendly_account").select("access_token, refresh_token, token_expiry, scope").eq("id", accountId).maybeSingle();
  if (!row) return null;
  if (row.access_token && row.token_expiry && Date.parse(row.token_expiry) > Date.now() + 30_000) return row.access_token;
  let t: CalendlyTokens;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  } catch (e) {
    // The refresh token is dead (revoked, or used by a parallel refresh).
    if (/invalid_grant/i.test((e as Error).message)) {
      const { data: again } = await db.from("calendly_account").select("access_token, refresh_token").eq("id", accountId).maybeSingle();
      // Someone else refreshed meanwhile: use theirs.
      if (again && again.refresh_token !== row.refresh_token && again.access_token) return again.access_token;
      // Else it's gone for good: the person connects again.
      await db.from("calendly_account").update({ access_token: null, token_expiry: null }).eq("id", accountId).eq("refresh_token", row.refresh_token);
    }
    return null;
  }
  const { data: won } = await db
    .from("calendly_account")
    .update({ access_token: t.access_token, refresh_token: t.refresh_token, token_expiry: expiry(t), scope: t.scope ?? row.scope, updated_at: new Date().toISOString() })
    .eq("id", accountId)
    .eq("refresh_token", row.refresh_token)
    .select("access_token")
    .maybeSingle();
  if (won) return t.access_token;
  const { data: again } = await db.from("calendly_account").select("access_token").eq("id", accountId).maybeSingle();
  return again?.access_token ?? null;
}

/** Calendly's answer, or its own words when it says no. */
export async function calendlyCall<T = Record<string, unknown>>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = Array.isArray(j.details) ? j.details.map((d: { message?: string }) => d.message).filter(Boolean).join("; ") : "";
    const msg = Array.isArray(j.required_scopes)
      ? `iklipse needs access to ${j.required_scopes.join(", ")} on this Calendly`
      : [j.message ?? j.title ?? `error ${res.status}`, details].filter(Boolean).join(": ");
    throw Object.assign(new Error(String(msg)), { status: res.status });
  }
  return j as T;
}

/** "abc" from "https://api.calendly.com/scheduled_events/abc". */
export const uuidOf = (uri: string) => uri.split("/").filter(Boolean).pop() ?? "";

// ------------------------------------------------------------------- user --

export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string;
  timezone: string;
  current_organization: string;
}

export async function me(token: string): Promise<CalendlyUser> {
  const r = await calendlyCall<{ resource: CalendlyUser }>(token, "GET", "/users/me");
  return r.resource;
}

// ------------------------------------------------------------ event types --

export interface EventType {
  uri: string;
  name: string;
  active: boolean;
  duration: number;
  kind: string;
  pooling_type: string | null;
  scheduling_url: string;
  locations: { kind: string; location?: string }[] | null;
  custom_questions: Question[];
}

/** A question on the event type's booking form (string, text, phone_number, single_select, multi_select). */
export interface Question {
  name: string;
  type: string;
  required: boolean;
  enabled: boolean;
  position: number;
  answer_choices?: string[] | null;
}

const isText = (q: Question) => q.type === "text" || q.type === "string" || q.type === "paragraph" || q.type === "multi_line";
const ASKS_NUMBER = /phone|mobile|whats ?app|number|رقم|موبايل|تليفون|واتس/i;

/** The form's question for a phone number: a phone question, else a text one asking for a number ("a working mobile number, ideally WhatsApp"). */
const phoneQuestion = (questions: Question[]) => questions.find((q) => q.type === "phone_number") ?? questions.find((q) => isText(q) && ASKS_NUMBER.test(q.name));

/**
 * The booking form's answers iklipse can give: the details in its first text
 * question, a phone number in its phone question. Required ones it can't answer
 * (a choice, another text question) are missing: the person answers them on
 * a custom link.
 */
export function answersFor(et: EventType, p: { note?: string; phone?: string | null }) {
  const questions = (et.custom_questions ?? []).filter((q) => q.enabled).sort((x, y) => x.position - y.position);
  // With a number to give, a text question asking for one gets it, not the details.
  const phoneQ = p.phone ? phoneQuestion(questions) : undefined;
  const firstText = questions.find((q) => isText(q) && q !== phoneQ);
  const answers: { question: string; answer: string; position: number }[] = [];
  const missing: string[] = [];
  for (const q of questions) {
    let a = "";
    if (q === phoneQ) a = `+${p.phone!.replace(/\D/g, "")}`;
    else if (q === firstText && p.note) a = p.note.slice(0, 2000);
    else if (q.type === "phone_number" && p.phone) a = `+${p.phone.replace(/\D/g, "")}`;
    if (a) answers.push({ question: q.name, answer: a, position: q.position });
    else if (q.required) missing.push(q.name);
  }
  return { answers, missing };
}

/** Calendly needs answers iklipse doesn't have (the questions, by name). */
export class NeedsAnswers extends Error {
  constructor(public questions: string[]) {
    super(`Calendly's booking form needs answers to: ${questions.join(", ") || "its required questions"}`);
  }
}

/** Calendly said required questions were left blank. */
export const blankAnswers = (e: unknown) => e instanceof NeedsAnswers || /Required Questions and Answers cannot be blank/i.test((e as Error)?.message ?? "");

/** This person's own event types that can be booked (active, one host). */
export async function eventTypes(token: string, user: string): Promise<EventType[]> {
  const out: EventType[] = [];
  let page: string | null = `/event_types?${new URLSearchParams({ user, active: "true", count: "100", sort: "name:asc" })}`;
  while (page && out.length < 300) {
    const r: { collection: EventType[]; pagination: { next_page: string | null } } = await calendlyCall(token, "GET", page);
    out.push(...r.collection);
    page = r.pagination?.next_page ?? null;
  }
  return out.filter((e) => e.active && e.kind === "solo" && !e.pooling_type);
}

/** The bot's event type for this length: one that lasts it, else the one picked (null: none of that length). */
export function typeFor(types: EventType[], picked: string | null, minutes?: number) {
  const chosen = types.find((e) => e.uri === picked) ?? types[0] ?? null;
  if (!minutes || chosen?.duration === minutes) return chosen;
  return types.find((e) => e.duration === minutes) ?? null;
}

/** "30 min", "1 hour", "1 hour 30 min" */
export function lengthWords(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} min`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}

// ------------------------------------------------------------- open times --

/** The open start times (ms) of an event type between two moments (Calendly answers a week at a time, so in turns). */
export async function openTimes(token: string, eventType: string, from: number, to: number): Promise<number[]> {
  const start = Math.max(from, Date.now() + 60_000);
  const out: number[] = [];
  const SPAN = 7 * 24 * 3600_000 - 60_000;
  const calls: Promise<{ collection: { status: string; start_time: string }[] }>[] = [];
  for (let a = start; a < to; a += SPAN) {
    const q = new URLSearchParams({ event_type: eventType, start_time: new Date(a).toISOString(), end_time: new Date(Math.min(to, a + SPAN)).toISOString() });
    calls.push(calendlyCall(token, "GET", `/event_type_available_times?${q}`));
  }
  for (const r of await Promise.all(calls)) {
    for (const s of r.collection ?? []) if (s.status === "available") out.push(Date.parse(s.start_time));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** A busy time: start and end as the calendar has them; Calendly's own meetings also say their buffers. */
export interface Busy {
  start: number;
  end: number;
  /** calendly: a Calendly meeting; reserved: held by Calendly; external: an event on a connected calendar. */
  kind: string;
  /** Calendly's meetings: the start and end with the buffers set around them. */
  bufferedStart?: number;
  bufferedEnd?: number;
}

/**
 * When a Calendly user is busy between two moments (ms): the events on the
 * calendars connected in Calendly ("Check for conflicts"), and Calendly's own
 * meetings, as the calendar has them (their buffers apart). A week at a
 * time (Calendly's limit for /user_busy_times), like open times (0105).
 */
export async function busyTimes(token: string, user: string, from: number, to: number): Promise<Busy[]> {
  const start = Math.max(from, Date.now() + 60_000);
  const SPAN = 7 * 24 * 3600_000 - 60_000;
  const calls: Promise<{ collection: { type?: string; start_time: string; end_time: string; buffered_start_time?: string; buffered_end_time?: string }[] }>[] = [];
  for (let a = start; a < to; a += SPAN) {
    const q = new URLSearchParams({ user, start_time: new Date(a).toISOString(), end_time: new Date(Math.min(to, a + SPAN)).toISOString() });
    calls.push(calendlyCall(token, "GET", `/user_busy_times?${q}`));
  }
  const out: Busy[] = [];
  for (const r of await Promise.all(calls)) {
    for (const b of r.collection ?? []) {
      const s = Date.parse(b.start_time);
      const e = Date.parse(b.end_time);
      if (!(s < e)) continue;
      const bs = b.buffered_start_time ? Date.parse(b.buffered_start_time) : NaN;
      const be = b.buffered_end_time ? Date.parse(b.buffered_end_time) : NaN;
      out.push({ start: s, end: e, kind: b.type ?? "external", ...(bs < s ? { bufferedStart: bs } : {}), ...(be > e ? { bufferedEnd: be } : {}) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** An event type's hours on Calendly: when it may be booked, in the schedule's time zone. */
export interface Hours {
  zone: string;
  /** wday: every such weekday ("friday"); date: that day only, instead of its weekday (a date override). */
  rules: { type: string; wday?: string; date?: string; intervals: { from: string; to: string }[] }[];
}
const hoursCache = new Map<string, { at: number; hours: Hours | null }>();
/** The hours are read again after this long (a few minutes per run, not on every message). */
const HOURS_TTL_MS = 5 * 60_000;

/**
 * The hours an event type takes bookings (Calendly's availability schedule
 * for it: weekdays and date overrides; /event_type_availability_schedules,
 * availability:read). null: Calendly didn't say. Calendly doesn't expose an
 * event type's minimum notice, daily limit or how far ahead it books: those
 * are only seen in the times it offers (event_type_available_times).
 */
export async function eventTypeHours(token: string, eventType: string): Promise<Hours | null> {
  const hit = hoursCache.get(eventType);
  if (hit && Date.now() - hit.at < HOURS_TTL_MS) return hit.hours;
  let hours: Hours | null = null;
  try {
    const r = await calendlyCall<{ collection?: { availability_rule?: { timezone?: string; rules?: Hours["rules"] } }[] }>(
      token,
      "GET",
      `/event_type_availability_schedules?${new URLSearchParams({ event_type: eventType })}`,
    );
    const rule = r.collection?.[0]?.availability_rule;
    if (rule?.timezone && Array.isArray(rule.rules)) hours = { zone: rule.timezone, rules: rule.rules };
  } catch (e) {
    console.error("calendly hours", (e as Error).message);
  }
  hoursCache.set(eventType, { at: Date.now(), hours });
  return hours;
}

// -------------------------------------------------------- scheduled events --

export interface ScheduledEvent {
  uri: string;
  name: string;
  status: "active" | "canceled";
  start_time: string;
  end_time: string;
  event_type: string;
  location: { type?: string; location?: string | null; join_url?: string | null; status?: string | null; data?: { password?: string } } | null;
  invitees_counter?: { total: number; active: number; limit: number };
  /** More people on it, by email (added by the one who booked). */
  event_guests?: { email: string }[];
  /** Its hosts (the Calendly users it's on). */
  event_memberships?: { user: string; user_email?: string; user_name?: string }[];
  created_at: string;
}

export interface Invitee {
  uri: string;
  name: string;
  email: string;
  status: "active" | "canceled";
  cancel_url?: string;
  reschedule_url?: string;
  questions_and_answers?: { question: string; answer: string }[];
  /** The utm_ values the booking link carried (personalLink puts the person's WhatsApp number in utm_content). */
  tracking?: { utm_source?: string | null; utm_medium?: string | null; utm_content?: string | null } | null;
  /** The number they gave for text reminders. */
  text_reminder_number?: string | null;
}

/** This person's events between two moments (active, or canceled too). */
export async function scheduledEvents(token: string, user: string, from: string, to: string, status?: "active" | "canceled"): Promise<ScheduledEvent[]> {
  const out: ScheduledEvent[] = [];
  const q = new URLSearchParams({ user, min_start_time: from, max_start_time: to, sort: "start_time:asc", count: "100" });
  if (status) q.set("status", status);
  let page: string | null = `/scheduled_events?${q}`;
  while (page && out.length < 500) {
    const r: { collection: ScheduledEvent[]; pagination: { next_page: string | null } } = await calendlyCall(token, "GET", page);
    out.push(...r.collection);
    page = r.pagination?.next_page ?? null;
  }
  return out;
}

export async function getEvent(token: string, uuid: string): Promise<ScheduledEvent> {
  const r = await calendlyCall<{ resource: ScheduledEvent }>(token, "GET", `/scheduled_events/${encodeURIComponent(uuid)}`);
  return r.resource;
}

export async function inviteesOf(token: string, uuid: string): Promise<Invitee[]> {
  const r = await calendlyCall<{ collection: Invitee[] }>(token, "GET", `/scheduled_events/${encodeURIComponent(uuid)}/invitees?count=100`);
  return r.collection ?? [];
}

/** Cancels it; Calendly tells the invitees. An event that's already cancelled counts as done. */
export async function cancelEvent(token: string, uuid: string, reason?: string) {
  try {
    await calendlyCall(token, "POST", `/scheduled_events/${encodeURIComponent(uuid)}/cancellation`, reason ? { reason: reason.slice(0, 1000) } : {});
  } catch (e) {
    if (!/already canceled/i.test((e as Error).message)) throw e;
  }
}

/** The meeting's link once Calendly has made it (it takes a moment): asks a few times. */
export async function linkOf(token: string, uuid: string, tries = 4): Promise<ScheduledEvent | null> {
  let ev: ScheduledEvent | null = null;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    ev = await getEvent(token, uuid).catch(() => ev);
    if (ev?.location?.join_url || (ev?.location && !ev.location.join_url && !["processing", "initiated"].includes(String(ev.location.status)))) break;
  }
  return ev;
}

// ---------------------------------------------------------------- booking --

export interface Booking {
  eventType: EventType;
  /** When it starts (an open time on the event type). */
  start: number;
  name: string;
  email: string;
  /** More people, by email (10 at most). */
  guests?: string[];
  /** The title and details, put in the booking form's first text question. */
  note?: string;
  /** Their WhatsApp number (digits), for a phone question on the form. */
  phone?: string | null;
  timezone: string;
}

/** Books it on Calendly for that person (Scheduling API): the event's id. Calendly emails everyone. */
export async function book(token: string, b: Booking): Promise<{ event: string; invitee: string }> {
  const loc = b.eventType.locations?.[0];
  const { answers, missing } = answersFor(b.eventType, { note: b.note, phone: b.phone });
  if (missing.length) throw new NeedsAnswers(missing);
  const r = await calendlyCall<{ resource: { uri: string; event: string } }>(token, "POST", "/invitees", {
    event_type: b.eventType.uri,
    start_time: new Date(b.start).toISOString(),
    invitee: { name: b.name, email: b.email, timezone: b.timezone },
    ...(loc && !b.eventType.pooling_type ? { location: { kind: loc.kind, ...(loc.location ? { location: loc.location } : {}) } } : {}),
    ...(answers.length ? { questions_and_answers: answers } : {}),
    ...(b.guests?.length ? { event_guests: b.guests.slice(0, 10) } : {}),
  });
  return { event: uuidOf(r.resource.event), invitee: r.resource.uri };
}

/**
 * A booking link that opens on one time with the person's details filled in
 * (name, email, guests, the first text question): they only tap "Schedule
 * Event". date "2026-10-21", time "15:00", offset "+03:00" (that day's).
 * Without a time it opens on the day, for them to pick one.
 */
export function slotLink(et: EventType, at: { date: string; time?: string; offset?: string }, p: { name: string; email?: string | null; guests?: string[]; note?: string; phone?: string | null }) {
  const q = new URLSearchParams({ month: at.date.slice(0, 7), date: at.date });
  fill(et, q, p);
  if (p.guests?.length) q.set("guests", p.guests.slice(0, 10).join(","));
  const base = et.scheduling_url.replace(/\/+$/, "");
  return `${base}${at.time ? `/${at.date}T${at.time}:00${at.offset}` : ""}?${q.toString().replace(/\+/g, "%20")}`;
}

/**
 * A client's own booking link (0099), any time: their name and email filled in
 * when iklipse has them, their WhatsApp number in the form's phone question.
 * The number rides in utm_content too, which Calendly hands back on the
 * booking (bookedBy) even if they change the form: what they type there fills
 * in what Clients is missing about them.
 */
export function personalLink(et: EventType, p: { name?: string | null; email?: string | null; phone?: string | null }, base = et.scheduling_url) {
  const q = new URLSearchParams();
  fill(et, q, p);
  const url = base.replace(/\/+$/, "");
  const s = q.toString().replace(/\+/g, "%20");
  return s ? `${url}?${s}` : url;
}

/**
 * A client's own link that works once (0103): a single-use link on the event
 * type (Calendly's "single-use link", gone after one booking or 90 days), with
 * their details filled in as personalLink. Without Calendly's
 * scheduling_links:write on the account (connected before it was asked for),
 * the event type's link with their details.
 */
export async function oneTimeLink(token: string, et: EventType, p: { name?: string | null; email?: string | null; phone?: string | null }) {
  return (await oneTimeLinkOf(token, et, p)).url;
}

/** As oneTimeLink, saying whether it's really single-use (once) or the event type's link. */
export async function oneTimeLinkOf(token: string, et: EventType, p: { name?: string | null; email?: string | null; phone?: string | null }) {
  try {
    const r = await calendlyCall<{ resource: { booking_url: string } }>(token, "POST", "/scheduling_links", { max_event_count: 1, owner: et.uri, owner_type: "EventType" });
    if (r.resource?.booking_url) return { url: personalLink(et, p, r.resource.booking_url), once: true };
  } catch (e) {
    if (!missingScopes(e)) console.error("single-use link", (e as Error).message);
  }
  return { url: personalLink(et, p), once: false };
}

/** The person's details on a link: a real name (not "+2010..."), the email, the answers iklipse can give, and the number in utm_content. */
function fill(et: EventType, q: URLSearchParams, p: { name?: string | null; email?: string | null; note?: string; phone?: string | null }) {
  // A client's name as iklipse shows it is "Sara (Acme)": the form wants "Sara".
  const name = (p.name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (name && !/^\+?[\d\s()-]+$/.test(name) && name !== "Unknown") q.set("name", name);
  if (p.email) q.set("email", p.email);
  const questions = (et.custom_questions ?? []).filter((x) => x.enabled).sort((x, y) => x.position - y.position);
  const { answers } = answersFor(et, { note: p.note?.slice(0, 1000), phone: p.phone });
  for (const a of answers) {
    const i = questions.findIndex((x) => x.name === a.question);
    if (i >= 0) q.set(`a${i + 1}`, a.answer);
  }
  const digits = (p.phone ?? "").replace(/\D/g, "");
  if (/^[1-9]\d{7,14}$/.test(digits)) {
    q.set("utm_source", "iklipse");
    q.set("utm_medium", "whatsapp");
    q.set("utm_content", digits);
  }
}

/**
 * Who booked, by WhatsApp number: the one our link carried (fromLink), else
 * the number they typed in the form's phone question, else their text
 * reminder number.
 */
export function bookedBy(i: Partial<Invitee>): { phone: string | null; fromLink: boolean } {
  const t = i.tracking;
  const carried = t?.utm_source === "iklipse" ? String(t.utm_content ?? "").replace(/\D/g, "") : "";
  if (/^[1-9]\d{7,14}$/.test(carried)) return { phone: carried, fromLink: true };
  const said = (i.questions_and_answers ?? []).find((x) => ASKS_NUMBER.test(x.question ?? "") && /\d{7}/.test(String(x.answer ?? "").replace(/\D/g, "")));
  const typed = String(said?.answer ?? i.text_reminder_number ?? "").replace(/[^\d+]/g, "");
  return { phone: typed.replace(/\D/g, "").length >= 8 ? typed : null, fromLink: false };
}

const ADDR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Email addresses from a list or from text ("a@b.com, c@d.com"): the good ones (lower case, once each), and the rest. */
export function emailsOf(v: unknown): { good: string[]; bad: string[] } {
  const parts = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : []).map((x) => (typeof x === "string" ? x.trim().replace(/^<|>$/g, "") : ""));
  const good: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const e = p.toLowerCase();
    if (!ADDR.test(e) || e.length > 254) bad.push(p.slice(0, 80));
    else if (!good.includes(e)) good.push(e);
  }
  return { good: good.slice(0, 50), bad };
}

/** A name for someone known only by email: "sara.ali@x.com" -> "Sara Ali". */
export function nameFromEmail(email: string) {
  return email
    .split("@")[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ") || email;
}

// --------------------------------------------------------------- webhooks --

/** Signs Calendly's notifications about this person up for us (paid plans only; quietly nothing otherwise). */
export async function subscribe(token: string, url: string, user: string, organization: string): Promise<string | null> {
  try {
    const r = await calendlyCall<{ resource: { uri: string } }>(token, "POST", "/webhook_subscriptions", {
      url,
      events: ["invitee.created", "invitee.canceled"],
      organization,
      user,
      scope: "user",
    });
    return r.resource.uri;
  } catch (e) {
    console.error("calendly webhook", (e as Error).message);
    return null;
  }
}
