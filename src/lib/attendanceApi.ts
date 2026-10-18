import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Attendance (migration 0083): team members log in when they start work, take
// breaks and log out when they leave, on the home page; the server keeps the
// times. Admins don't log anything; they see everyone's day and who's working
// or on a break right now. A day is a day in Cairo. A session nobody logged
// out of is closed by the system the next morning (auto) and doesn't count
// towards the time worked.
// -----------------------------------------------------------------------------

export type AttendanceStatus = "out" | "in" | "break";
export type AttendanceAction = "in" | "break" | "back" | "out";

export interface WorkBreak {
  started_at: string;
  ended_at: string | null;
}

export interface WorkSession {
  started_at: string;
  ended_at: string | null;
  /** Closed by the system: they didn't log out. */
  auto: boolean;
  breaks: WorkBreak[];
}

export type MyAttendance =
  | { tracked: false }
  | {
      tracked: true;
      /** Today in Cairo, "YYYY-MM-DD". */
      day: string;
      status: AttendanceStatus;
      /** When the work or the break going on now started. */
      since: string | null;
      /** Today's sessions, and the one going on now. */
      sessions: WorkSession[];
    };

/** One person's day, for admins. status / since: right now. */
export interface PersonDay {
  id: string;
  name: string;
  avatar_url: string | null;
  active: boolean;
  status: AttendanceStatus;
  since: string | null;
  sessions: WorkSession[];
}

export async function fetchMyAttendance(): Promise<MyAttendance> {
  const { data, error } = await supabase.rpc("attendance_me");
  if (error) throw error;
  return data as MyAttendance;
}

export async function attendanceAct(action: AttendanceAction): Promise<MyAttendance> {
  const { data, error } = await supabase.rpc("attendance_act", { p_action: action });
  if (error) throw error;
  return data as MyAttendance;
}

export async function fetchAttendanceDay(day: string): Promise<PersonDay[]> {
  const { data, error } = await supabase.rpc("attendance_day", { p_day: day });
  if (error) throw error;
  return (data ?? []) as PersonDay[];
}

const TZ = "Africa/Cairo";

/** Today in Cairo, "YYYY-MM-DD". */
export function cairoToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "2026-10-18" moved n days. */
export function addDays(day: string, n: number) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** "Sunday 18 October" (with the year when it isn't this year). */
export function dayText(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const sameYear = y === Number(cairoToday().slice(0, 4));
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: sameYear ? undefined : "numeric",
  });
}

/** "9:02 AM", Cairo time. */
export function timeText(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

/** "7h 58m", "40m". */
export function hm(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

const end = (iso: string | null, now: number) => (iso ? Date.parse(iso) : now);

/** Time worked and on breaks (what's going on now runs to now). Sessions nobody logged out of don't count. */
export function totals(sessions: WorkSession[], now = Date.now()) {
  let worked = 0;
  let breaks = 0;
  for (const s of sessions) {
    if (s.auto) continue;
    const b = s.breaks.reduce((sum, br) => sum + Math.max(0, end(br.ended_at, now) - Date.parse(br.started_at)), 0);
    worked += Math.max(0, end(s.ended_at, now) - Date.parse(s.started_at) - b);
    breaks += b;
  }
  return { worked, breaks };
}

/** When the day started, and how it ended: a time, still working (null), or they didn't log out. */
export function dayBounds(sessions: WorkSession[]) {
  const last = sessions[sessions.length - 1];
  return {
    first: sessions[0]?.started_at ?? null,
    last: !last ? null : last.auto ? ("missed" as const) : last.ended_at,
  };
}

/** The day as short steps: "In 9:02 AM", "Break 1:10 PM – 1:40 PM", "Out 5:30 PM". */
export function steps(sessions: WorkSession[]) {
  const out: { kind: "in" | "break" | "out" | "missed"; text: string }[] = [];
  for (const s of sessions) {
    out.push({ kind: "in", text: `In ${timeText(s.started_at)}` });
    for (const b of s.breaks) {
      if (s.auto && !b.ended_at) continue;
      out.push({ kind: "break", text: `Break ${timeText(b.started_at)}${b.ended_at ? ` to ${timeText(b.ended_at)}` : ", now"}` });
    }
    if (s.auto) out.push({ kind: "missed", text: "Didn't log out" });
    else if (s.ended_at) out.push({ kind: "out", text: `Out ${timeText(s.ended_at)}` });
  }
  return out;
}

/** Re-renders every `ms` so running times move. */
export function useNow(ms = 20_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
