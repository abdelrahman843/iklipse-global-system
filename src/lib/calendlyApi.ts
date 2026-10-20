import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// The Calendly page (0084, edge function calendly): the meetings on one of my
// Calendly accounts, booking one for someone at an open time, cancelling.
// -----------------------------------------------------------------------------

export interface CalendlyMeeting {
  id: string;
  name: string;
  start: string;
  end: string;
  minutes: number;
  status: "active" | "canceled";
  join_url: string | null;
  /** zoom, google_conference, physical... */
  location: string | null;
  /** Booked from WhatsApp: the group's name. */
  whatsapp: string | null;
  /** Booked from WhatsApp: who it's with. */
  with: string | null;
}

export interface CalendlyMeetingDetails extends CalendlyMeeting {
  place: string | null;
  password: string | null;
  invitees: { name: string; email: string; status: string; answers: { question: string; answer: string }[] }[];
}

export interface CalendlyBooking {
  event_type: string;
  /** ISO, one of the open times. */
  start: string;
  name: string;
  email: string;
  guests: string[];
  note: string;
}

export async function fetchCalendlyMeetings(account: string, from: string, to: string): Promise<CalendlyMeeting[]> {
  const r = await callFunction<{ meetings: CalendlyMeeting[] }>("calendly", { action: "calendar", account, from, to });
  return r.meetings ?? [];
}

export async function fetchCalendlyMeeting(account: string, id: string): Promise<CalendlyMeetingDetails> {
  const r = await callFunction<{ meeting: CalendlyMeetingDetails }>("calendly", { action: "get", account, id });
  return r.meeting;
}

/** The open times of an event type on a day (Cairo), or from that day to another (3 weeks at most). */
export async function fetchOpenTimes(account: string, eventType: string, day: string, to?: string): Promise<string[]> {
  const r = await callFunction<{ times: string[] }>("calendly", { action: "times", account, event_type: eventType, day, ...(to ? { to } : {}) });
  return r.times ?? [];
}

export async function bookCalendly(account: string, b: CalendlyBooking): Promise<{ id: string; join_url: string | null }> {
  return callFunction("calendly", { action: "book", account, ...b });
}

export async function cancelCalendly(account: string, id: string, reason?: string) {
  await callFunction("calendly", { action: "cancel", account, id, reason });
}

/** "Zoom", "Google Meet"... from Calendly's location type. */
export function placeName(type: string | null) {
  if (!type) return null;
  const names: Record<string, string> = {
    zoom: "Zoom",
    zoom_conference: "Zoom",
    google_conference: "Google Meet",
    microsoft_teams_conference: "Microsoft Teams",
    webex_conference: "Webex",
    gotomeeting: "GoTo Meeting",
    gotomeeting_conference: "GoTo Meeting",
    physical: "In person",
    inbound_call: "Phone call",
    outbound_call: "Phone call",
    custom: "Custom",
    ask_invitee: "They pick",
  };
  return names[type] ?? type.replace(/_/g, " ");
}
