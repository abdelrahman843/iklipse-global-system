import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// The Zoom page (0079, 0080): a calendar of one of my Zoom accounts, through
// the zoom function (the account must be mine). Past meetings come as far
// back as Zoom keeps them (about six months). Meetings at a time, right now,
// with no set time (a link that always works) or repeating; invitees get the
// invitation by email from my Gmail.
// -----------------------------------------------------------------------------

/** once: at a time. instant: now. no_time: a link for any time. repeat: a series. */
export type MeetingKind = "once" | "instant" | "no_time" | "repeat";

export interface CalMeeting {
  id: string;
  /** One meeting of a series (its Zoom occurrence id). */
  occurrence: string | null;
  topic: string;
  kind: MeetingKind;
  start_time: string;
  duration: number | null;
  join_url: string | null;
  recurring: boolean;
  /** The WhatsApp group the bot booked it from, if it did. */
  whatsapp: string | null;
}

/** A link with no set time: no place on the calendar. */
export interface Room {
  id: string;
  topic: string;
  join_url: string | null;
  created_at: string | null;
  whatsapp: string | null;
}

export interface Repeat {
  type: "daily" | "weekly" | "monthly";
  every: number;
  /** Weekly: 1 Sunday .. 7 Saturday. */
  days: number[];
  monthDay: number | null;
  /** Ends after this many meetings, or on a day (ISO). */
  times: number | null;
  until: string | null;
}

export interface MeetingOptions {
  waiting_room: boolean;
  join_before_host: boolean;
  /** Minutes before the start people may join without the host (0: any time). */
  jbh_time: number;
  mute_upon_entry: boolean;
  host_video: boolean;
  participant_video: boolean;
  auto_recording: "none" | "local" | "cloud";
}

export interface MeetingDetails {
  id: string;
  topic: string;
  kind: MeetingKind;
  start_time: string | null;
  duration: number | null;
  timezone: string | null;
  agenda: string;
  join_url: string;
  password: string | null;
  type: number;
  repeat: Repeat | null;
  repeat_words: string | null;
  options: MeetingOptions;
  invitees: string[];
}

export interface MeetingInput {
  topic: string;
  kind: MeetingKind;
  /** ISO time: a meeting at a time, or a series' first. */
  start?: string;
  /** None: no set length (now, or no set time). */
  minutes?: number | null;
  agenda: string;
  password?: string;
  repeat?: Repeat;
  options?: Partial<MeetingOptions>;
  invitees: string[];
  /** Email the invitation (from this Gmail; null: the one with the Zoom's address, else the first). */
  notify: boolean;
  gmail?: string | null;
}

/** Who the invitation was emailed to, or why it wasn't. */
export type Invited = { sent: number; from: string } | { error: string } | null;

/** The person's time zone, so Zoom shows the meeting in it. */
const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Cairo";
  } catch {
    return "Africa/Cairo";
  }
};

/** Meetings on an account between two days ("YYYY-MM-DD"), past and coming, and its links with no set time. */
export async function fetchCalendar(account: string, from: string, to: string): Promise<{ meetings: CalMeeting[]; rooms: Room[] }> {
  const r = await callFunction<{ meetings: CalMeeting[]; rooms?: Room[] }>("zoom", { action: "calendar", account, from, to });
  return { meetings: r.meetings ?? [], rooms: r.rooms ?? [] };
}

export async function fetchMeetingDetails(account: string, id: string): Promise<MeetingDetails> {
  const r = await callFunction<{ meeting: MeetingDetails }>("zoom", { action: "get", account, id });
  return r.meeting;
}

export async function createZoomMeeting(account: string, m: MeetingInput) {
  return callFunction<{ id: string; join_url: string; invited: Invited }>("zoom", { action: "create", account, ...m, timezone: timezone() });
}

export async function updateZoomMeeting(account: string, id: string, m: Partial<MeetingInput>) {
  return callFunction<{ ok: true; invited: Invited }>("zoom", { action: "update", account, id, ...m, timezone: timezone() });
}

/** Cancels a meeting, or (occurrence) one meeting of a series. */
export async function deleteZoomMeeting(account: string, id: string, o: { occurrence?: string | null; notify?: boolean } = {}) {
  return callFunction<{ ok: true; invited: Invited }>("zoom", { action: "delete", account, id, occurrence: o.occurrence ?? undefined, notify: o.notify ?? true });
}
