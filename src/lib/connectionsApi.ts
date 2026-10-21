import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { FirefliesAccount } from "@/lib/firefliesApi";
import { openSignIn, signInReturn, type AppPlatform } from "@/lib/nativeApp";

// -----------------------------------------------------------------------------
// Calendly, Google Calendar, Gmail and Drive accounts each person connects
// (0052, 0054, 0084, 0096, edge functions calendly, calendar, gmail and drive).
// Calendly or Google Calendar, not both. Tokens never reach the browser:
// my_connections() says what's connected, and every call goes through the
// functions.
// -----------------------------------------------------------------------------

export interface GmailAccount {
  id: string;
  email: string;
  name: string | null;
  connected_at: string;
  /** This account sends the workspace's notification emails. */
  sends_notifications: boolean;
}

export interface CalendlyAccount {
  id: string;
  email: string | null;
  name: string | null;
  scheduling_url: string | null;
  connected_at: string;
  /** The WhatsApp bot books this person's meetings on this account. */
  for_bot: boolean;
  /** The event type the bot books with (its uri, name and length). */
  event_type: string | null;
  event_type_name: string | null;
  event_type_minutes: number | null;
}

/** One of the event types on a Calendly account. */
export interface CalendlyEventType {
  uri: string;
  name: string;
  minutes: number;
  /** Its booking page. */
  url: string;
  /** zoom_conference, google_conference, physical... */
  location: string | null;
}

/** A Google Calendar (0096). */
export interface CalendarAccount {
  id: string;
  email: string;
  name: string | null;
  connected_at: string;
}

export interface DriveAccount {
  id: string;
  email: string;
  name: string | null;
  connected_at: string;
}

export interface Connections {
  calendly: CalendlyAccount[];
  calendar: CalendarAccount[];
  gmail: GmailAccount[];
  drive: DriveAccount[];
  fireflies: FirefliesAccount[];
}

export async function fetchConnections(): Promise<Connections> {
  const { data, error } = await supabase.rpc("my_connections");
  if (error) throw error;
  const c = (data ?? {}) as Partial<Connections>;
  return {
    calendly: c.calendly ?? [],
    calendar: c.calendar ?? [],
    gmail: c.gmail ?? [],
    drive: c.drive ?? [],
    fireflies: c.fireflies ?? [],
  };
}

/** Calls one of the functions; their own error message comes back as the Error. */
export async function callFunction<T>(
  name: "calendly" | "calendar" | "gmail" | "drive" | "drive/upload" | "invoices" | "invoices/upload" | "fireflies" | "whatsapp-bot" | "apps",
  body: Record<string, unknown> | Blob,
  headers?: Record<string, string>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body, headers });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const msg = await error.context
        .json()
        .then((j: { error?: string }) => j?.error)
        .catch(() => null);
      throw new Error(msg || "Something went wrong. Try again.");
    }
    throw new Error(/fetch|network|offline/i.test(error.message) ? "This needs an internet connection." : error.message);
  }
  return data as T;
}

/**
 * Where Calendly / Google send the browser back: this app's Connected accounts
 * page; started in the Android or Windows app, back into that app
 * (?iklipse_app=..., _shared/oauth.ts backToApp).
 */
const returnTo = (app: AppPlatform | null) => `${location.origin}${location.pathname}${app ? `?iklipse_app=${app}` : ""}#/connections`;

/** Off to the provider's consent page (comes back to /connections?<provider>=...). */
export async function startConnect(provider: "calendly" | "calendar" | "gmail" | "drive") {
  const app = await signInReturn();
  const { url } = await callFunction<{ url: string }>(provider, { action: "connect", returnTo: returnTo(app) });
  if (app) openSignIn(url);
  else window.location.assign(url);
}

export async function disconnectCalendly(account: string) {
  await callFunction("calendly", { action: "disconnect", account });
}

/** The WhatsApp bot books my meetings on this Calendly account. */
export async function setCalendlyForBot(account: string) {
  await callFunction("calendly", { action: "use_for_bot", account });
}

/** The event types on one of my Calendly accounts. */
export async function fetchCalendlyEventTypes(account: string): Promise<CalendlyEventType[]> {
  const r = await callFunction<{ event_types: CalendlyEventType[] }>("calendly", { action: "event_types", account });
  return r.event_types ?? [];
}

/** The event type the bot books with on this account. */
export async function setCalendlyEventType(account: string, eventType: string) {
  await callFunction("calendly", { action: "set_event_type", account, event_type: eventType });
}

export async function disconnectCalendar(account: string) {
  await callFunction("calendar", { action: "disconnect", account });
}

export async function disconnectGmail(account: string) {
  await callFunction("gmail", { action: "disconnect", account });
}

export async function disconnectDrive(account: string) {
  await callFunction("drive", { action: "disconnect", account });
}

/** Admin: notification emails go out from this account (null = back to n8n). */
export async function setNotifyGmail(account: string | null) {
  const { error } = await supabase.rpc("admin_set_notify_gmail", { p_account: account });
  if (error) throw error;
}

/** What the provider's return (?calendly= / ?calendar= / ?gmail= / ?drive=) means, for the toast. */
export const RETURN_MESSAGES: Record<string, { kind: "success" | "error"; title: string; description?: string }> = {
  "calendly:connected": { kind: "success", title: "Calendly connected" },
  "calendly:again": {
    kind: "success",
    title: "Calendly connected again",
    description: "Its access is up to date. To add a different account, sign out of Calendly first.",
  },
  "calendly:too_many": { kind: "error", title: "Calendly wasn't connected", description: "You can connect up to 10 Calendly accounts." },
  "calendly:denied": { kind: "error", title: "Calendly wasn't connected", description: "You cancelled on Calendly's page." },
  "calendly:error": { kind: "error", title: "Couldn't connect Calendly", description: "Try again in a moment." },
  "calendly:bad_keys": {
    kind: "error",
    title: "Couldn't connect Calendly",
    description: "Calendly didn't accept the app's keys. CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET on the server must both come from the same Calendly app.",
  },
  "calendly:redirect": {
    kind: "error",
    title: "Couldn't connect Calendly",
    description: "The Calendly app's redirect URI doesn't match. It must be .../functions/v1/calendly/callback.",
  },
  "calendly:scopes": {
    kind: "error",
    title: "Couldn't connect Calendly",
    description: "The Calendly app is missing a scope. Tick the scopes in the setup notes, then connect again.",
  },
  "calendly:calendar": {
    kind: "error",
    title: "Calendly wasn't connected",
    description: "You use Google Calendar. Disconnect it first: it's Calendly or Google Calendar, not both.",
  },
  "calendar:connected": { kind: "success", title: "Google Calendar connected" },
  "calendar:denied": { kind: "error", title: "Google Calendar wasn't connected", description: "You cancelled on Google's page." },
  "calendar:missing_scope": {
    kind: "error",
    title: "Google Calendar wasn't connected",
    description: "Tick the box that lets iklipse see and change your calendar events, then try again.",
  },
  "calendar:calendly": {
    kind: "error",
    title: "Google Calendar wasn't connected",
    description: "You use Calendly. Disconnect it first: it's Calendly or Google Calendar, not both.",
  },
  "calendar:too_many": { kind: "error", title: "Google Calendar wasn't connected", description: "You can connect up to 10 calendars." },
  "calendar:error": { kind: "error", title: "Couldn't connect Google Calendar", description: "Try again in a moment." },
  "gmail:connected": { kind: "success", title: "Gmail connected" },
  "gmail:denied": { kind: "error", title: "Gmail wasn't connected", description: "You cancelled on Google's page." },
  "gmail:missing_scope": {
    kind: "error",
    title: "Gmail wasn't connected",
    description: "Tick the box that lets iklipse read, write and send email, then try again.",
  },
  "gmail:too_many": { kind: "error", title: "Gmail wasn't connected", description: "You can connect up to 10 Gmail accounts." },
  "gmail:error": { kind: "error", title: "Couldn't connect Gmail", description: "Try again in a moment." },
  "drive:connected": { kind: "success", title: "Google Drive connected" },
  "drive:denied": { kind: "error", title: "Drive wasn't connected", description: "You cancelled on Google's page." },
  "drive:missing_scope": {
    kind: "error",
    title: "Drive wasn't connected",
    description: "Tick the box that lets iklipse see and change your Drive files, then try again.",
  },
  "drive:too_many": { kind: "error", title: "Drive wasn't connected", description: "You can connect up to 10 Drive accounts." },
  "drive:error": { kind: "error", title: "Couldn't connect Drive", description: "Try again in a moment." },
};
