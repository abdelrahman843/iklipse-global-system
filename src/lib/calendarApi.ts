import { callFunction } from "@/lib/connectionsApi";
import type { CalendlyMeeting } from "@/lib/calendlyApi";

// -----------------------------------------------------------------------------
// The Calendar page (0096, edge function calendar): the meetings on one of my
// Google Calendars, making one (Google emails the guests, with a Google Meet
// link), cancelling. Meetings come in the Calendly page's shape, so the same
// calendar shows them.
// -----------------------------------------------------------------------------

export interface CalendarMeeting extends CalendlyMeeting {
  /** The meeting on Google Calendar. */
  link: string | null;
}

export interface CalendarGuest {
  name: string;
  email: string;
  status: "needsAction" | "declined" | "tentative" | "accepted";
  organizer: boolean;
  self: boolean;
}

export interface CalendarMeetingDetails extends CalendarMeeting {
  place: string | null;
  password: string | null;
  note: string | null;
  /** Made by me: cancelling tells the guests. Else it only leaves my calendar. */
  mine: boolean;
  invitees: CalendarGuest[];
}

export interface NewMeeting {
  title: string;
  /** Cairo day and time, "2026-10-21" and "14:30". */
  day: string;
  time: string;
  minutes: number;
  emails: string[];
  note: string;
  /** Add a Google Meet link. */
  meet: boolean;
}

export async function fetchCalendarMeetings(account: string, from: string, to: string): Promise<CalendarMeeting[]> {
  const r = await callFunction<{ meetings: CalendarMeeting[] }>("calendar", { action: "calendar", account, from, to });
  return r.meetings ?? [];
}

export async function fetchCalendarMeeting(account: string, id: string): Promise<CalendarMeetingDetails> {
  const r = await callFunction<{ meeting: CalendarMeetingDetails }>("calendar", { action: "get", account, id });
  return r.meeting;
}

export async function createCalendarMeeting(account: string, m: NewMeeting): Promise<{ id: string; join_url: string | null }> {
  return callFunction("calendar", { action: "create", account, ...m });
}

export async function cancelCalendarMeeting(account: string, id: string) {
  await callFunction("calendar", { action: "cancel", account, id });
}
