import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// The Zoom page (0079): a calendar of one of my Zoom accounts, through the zoom
// function (the account must be mine). Past meetings come as far back as Zoom
// keeps them (about six months).
// -----------------------------------------------------------------------------

export interface CalMeeting {
  id: string;
  topic: string;
  start_time: string;
  duration: number | null;
  join_url: string | null;
  recurring: boolean;
  /** The WhatsApp group the bot booked it from, if it did. */
  whatsapp: string | null;
}

export interface MeetingDetails {
  id: string;
  topic: string;
  start_time: string | null;
  duration: number | null;
  timezone: string | null;
  agenda: string;
  join_url: string;
  password: string | null;
  type: number;
}

export interface MeetingInput {
  topic: string;
  /** ISO time. */
  start: string;
  minutes: number;
  agenda: string;
}

/** The person's time zone, so Zoom shows the meeting in it. */
const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Cairo";
  } catch {
    return "Africa/Cairo";
  }
};

/** Meetings on an account between two days ("YYYY-MM-DD"), past and coming. */
export async function fetchCalendar(account: string, from: string, to: string): Promise<CalMeeting[]> {
  const r = await callFunction<{ meetings: CalMeeting[] }>("zoom", { action: "calendar", account, from, to });
  return r.meetings ?? [];
}

export async function fetchMeetingDetails(account: string, id: string): Promise<MeetingDetails> {
  const r = await callFunction<{ meeting: MeetingDetails }>("zoom", { action: "get", account, id });
  return r.meeting;
}

export async function createZoomMeeting(account: string, m: MeetingInput) {
  return callFunction<{ id: string; join_url: string }>("zoom", { action: "create", account, ...m, timezone: timezone() });
}

export async function updateZoomMeeting(account: string, id: string, m: Partial<MeetingInput>) {
  await callFunction("zoom", { action: "update", account, id, ...m, timezone: timezone() });
}

export async function deleteZoomMeeting(account: string, id: string) {
  await callFunction("zoom", { action: "delete", account, id });
}
