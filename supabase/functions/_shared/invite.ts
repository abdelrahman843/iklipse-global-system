// Meeting invitations by email (0080). Zoom keeps a meeting's invitees on it
// but doesn't email them, so iklipse sends the invitation from the host's own
// Gmail (one of their connected accounts): a calendar invite that Gmail, Google
// Calendar and Outlook show with Yes / No, an updated one when the meeting
// changes, a cancellation when it's cancelled. The gmail function sends it
// (POST /gmail/invite with GMAIL_WEBHOOK_SECRET). Used by the zoom function
// (the Zoom page) and whatsapp-bot (meetings booked from a group).
// Also the words a meeting is described with, in the emails and by the bot.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { kindOf, type MeetingKind, type Recurrence, type ZoomMeetingFull } from "./zoom.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET = Deno.env.get("GMAIL_WEBHOOK_SECRET") ?? "";

export interface Sender {
  id: string;
  email: string;
  name: string | null;
}

/** A meeting, the way an invitation describes it. */
export interface Invited {
  id: string;
  topic: string;
  kind: MeetingKind;
  /** When it starts (ms): a meeting at a time, or the first of a series. */
  start?: number;
  minutes?: number | null;
  timezone: string;
  join_url: string;
  password?: string | null;
  agenda?: string | null;
  recurrence?: Recurrence | null;
}

/** A meeting from Zoom, the way an invitation describes it. */
export const invitedFrom = (m: ZoomMeetingFull): Invited => ({
  id: String(m.id),
  topic: m.topic,
  kind: kindOf(m.type),
  start: m.start_time ? Date.parse(m.start_time) : undefined,
  minutes: m.duration ?? null,
  timezone: m.timezone || "Africa/Cairo",
  join_url: m.join_url,
  password: m.password ?? null,
  agenda: m.agenda ?? null,
  recurrence: m.recurrence ?? null,
});

/** The emails a Zoom meeting has on it. */
export const inviteesOn = (m: ZoomMeetingFull | null | undefined) => (m?.settings?.meeting_invitees ?? []).map((i) => i.email.toLowerCase()).filter(Boolean);

// ------------------------------------------------------------- addresses --

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

/** The Gmail an invitation goes out from: the one asked for, else the one with this address, else the first connected (null: none). */
export async function senderFor(db: SupabaseClient, userId: string, o: { gmail?: string | null; email?: string | null } = {}): Promise<Sender | null> {
  const { data } = await db.from("gmail_account").select("id, email, name").eq("user_id", userId).order("connected_at");
  const list = (data ?? []) as Sender[];
  return (
    (o.gmail ? list.find((a) => a.id === o.gmail) : undefined) ??
    (o.email ? list.find((a) => a.email.toLowerCase() === o.email!.toLowerCase()) : undefined) ??
    list[0] ??
    null
  );
}

// ----------------------------------------------------------------- words --

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A moment in a time zone: "25-12-2019", "Sunday", "3:00 PM", and its parts. */
function inZone(ms: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "long" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms)).replace(/[\u202f\u00a0]/g, " ");
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute, s: +parts.second, date: `${parts.day}-${parts.month}-${parts.year}`, day: parts.weekday as string, time };
}

const zoneWords = (tz: string) => (tz === "Africa/Cairo" ? "Cairo time" : `${tz.split("/").pop()!.replace(/_/g, " ")} time`);

/** "30 minutes", "1 hour 30 minutes" */
export function lengthWords(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} minutes`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minutes` : ""}`;
}

/** "Every week on Sunday, Tuesday, 12 times" */
export function repeatWords(r: Recurrence, tz = "Africa/Cairo") {
  const n = r.repeat_interval ?? 1;
  const unit = r.type === 1 ? "day" : r.type === 2 ? "week" : "month";
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.type === 2 && r.weekly_days) {
    const days = r.weekly_days.split(",").map((d) => DAYS[Number(d) - 1]).filter(Boolean);
    if (days.length) s += ` on ${days.join(", ")}`;
  }
  if (r.type === 3 && r.monthly_day) s += ` on day ${r.monthly_day}`;
  if (r.end_times) s += `, ${r.end_times} time${r.end_times === 1 ? "" : "s"}`;
  else if (r.end_date_time) s += `, until ${inZone(Date.parse(r.end_date_time), tz).date}`;
  return s;
}

/** The meeting in lines: when, how long, how it repeats, the link, the id and the passcode. */
export function meetingLines(m: Invited): string[] {
  const lines: string[] = [];
  if (m.kind === "no_time") lines.push("Time: any time, the link always works");
  else if (m.kind === "instant" || m.start === undefined) lines.push("Time: now");
  else {
    const w = inZone(m.start, m.timezone);
    lines.push(`Date: ${w.date} (${w.day})`, `Time: ${w.time} ${zoneWords(m.timezone)}`);
  }
  if (m.minutes && m.kind !== "no_time") lines.push(`Length: ${lengthWords(m.minutes)}`);
  if (m.kind === "repeat" && m.recurrence) lines.push(`Repeats: ${repeatWords(m.recurrence, m.timezone)}`);
  lines.push(`Link: ${m.join_url}`, `Meeting ID: ${m.id.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1 $2 $3")}`);
  if (m.password) lines.push(`Passcode: ${m.password}`);
  return lines;
}

// ------------------------------------------------------------------ .ics --

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const localStamp = (p: { y: number; mo: number; d: number; h: number; mi: number; s: number }) => `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;

/** Lines longer than 75 bytes go on, folded (RFC 5545). */
function fold(line: string) {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** The calendar invite (null: no time to put in a calendar). */
function calendarInvite(m: Invited, cancel: boolean, from: Sender, to: string[]) {
  if ((m.kind !== "once" && m.kind !== "repeat") || m.start === undefined) return null;
  const minutes = m.minutes || 30;
  const desc = [...meetingLines(m), ...(m.agenda ? ["", m.agenda] : [])].join("\n");
  let when: string[];
  if (m.kind === "repeat" && m.recurrence) {
    const r = m.recurrence;
    // In the meeting's zone, so a series keeps its time across summer time. A
    // weekly series starts on its first listed day.
    let p = inZone(m.start, m.timezone);
    const days = r.type === 2 && r.weekly_days ? r.weekly_days.split(",").map(Number).filter((d) => d >= 1 && d <= 7) : [];
    for (let i = 0; i < 7 && days.length; i++) {
      const wd = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 1;
      if (days.includes(wd)) break;
      const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
      p = { ...p, y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() };
    }
    const endMin = p.h * 60 + p.mi + minutes;
    const endDay = new Date(Date.UTC(p.y, p.mo - 1, p.d + Math.floor(endMin / (24 * 60))));
    const end = { y: endDay.getUTCFullYear(), mo: endDay.getUTCMonth() + 1, d: endDay.getUTCDate(), h: Math.floor((endMin % (24 * 60)) / 60), mi: endMin % 60, s: p.s };
    const freq = r.type === 1 ? "DAILY" : r.type === 2 ? "WEEKLY" : "MONTHLY";
    const rule = [
      `FREQ=${freq}`,
      `INTERVAL=${r.repeat_interval ?? 1}`,
      ...(days.length ? [`BYDAY=${days.map((d) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d - 1]).join(",")}`] : []),
      ...(r.type === 3 && r.monthly_day ? [`BYMONTHDAY=${r.monthly_day}`] : []),
      r.end_date_time ? `UNTIL=${utcStamp(Date.parse(r.end_date_time))}` : `COUNT=${r.end_times ?? 1}`,
    ].join(";");
    when = [`DTSTART;TZID=${m.timezone}:${localStamp(p)}`, `DTEND;TZID=${m.timezone}:${localStamp(end)}`, `RRULE:${rule}`];
  } else {
    when = [`DTSTART:${utcStamp(m.start)}`, `DTEND:${utcStamp(m.start + minutes * 60_000)}`];
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//iklipse//Zoom meetings//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancel ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:zoom-${m.id}@iklipse`,
    `DTSTAMP:${utcStamp(Date.now())}`,
    // Each change is newer than the last, so calendars take it.
    `SEQUENCE:${Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000)}`,
    ...when,
    `SUMMARY:${icsText(m.topic)}`,
    `DESCRIPTION:${icsText(desc)}`,
    `LOCATION:${icsText(m.join_url)}`,
    `URL:${m.join_url}`,
    `ORGANIZER;CN="${(from.name ?? from.email).replace(/["\\]/g, "")}":mailto:${from.email}`,
    ...to.map((e) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${e}`),
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ send --

/** Emails the invitation (new, changed or cancelled) to these people, from the host's Gmail. Throws why it couldn't. */
export async function sendInvites(o: { from: Sender; host: string; to: string[]; m: Invited; how: "new" | "update" | "cancel" }) {
  if (!o.to.length) return;
  if (!SECRET) throw new Error("Invitations can't be emailed: GMAIL_WEBHOOK_SECRET isn't set");
  const { m } = o;
  const cancel = o.how === "cancel";
  const at = m.kind === "once" || m.kind === "repeat" ? (m.start !== undefined ? inZone(m.start, m.timezone) : null) : null;
  const subject =
    (cancel ? "Cancelled: " : o.how === "update" ? "Updated invitation: " : "Invitation: ") +
    m.topic +
    (at ? ` @ ${at.day.slice(0, 3)} ${at.date} ${at.time}` : m.kind === "instant" ? " (now)" : "");
  const head = cancel
    ? `${o.host} cancelled this Zoom meeting.`
    : o.how === "update"
      ? `${o.host} changed this Zoom meeting.`
      : m.kind === "instant"
        ? `${o.host} invited you to a Zoom meeting, now.`
        : `${o.host} invited you to a Zoom meeting.`;
  const text = [head, "", m.topic, ...meetingLines(m), ...(m.agenda && !cancel ? ["", m.agenda] : [])].join("\n");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/gmail/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-iklipse-secret": SECRET },
    body: JSON.stringify({ account: o.from.id, to: o.to, subject, text, ics: calendarInvite(m, cancel, o.from, o.to), method: cancel ? "CANCEL" : "REQUEST" }),
  });
  if (!res.ok) {
    const why = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Gmail didn't send the invitation${why ? `: ${why}` : ""}`);
  }
}
