import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { FirefliesAccount } from "@/lib/firefliesApi";
import { appPlatform, openSignIn, signInReturn, type AppPlatform } from "@/lib/nativeApp";

// -----------------------------------------------------------------------------
// Zoom, Gmail and Drive accounts each person connects (0052, 0054, 0079, edge
// functions zoom, gmail and drive). Tokens never reach the browser:
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

export interface ZoomAccount {
  id: string;
  email: string | null;
  connected_at: string;
  /** The WhatsApp bot books this person's meetings on this account. */
  for_bot: boolean;
}

/** An upcoming meeting on one of my Zoom accounts. */
export interface ZoomMeeting {
  id: string;
  topic: string;
  start_time: string;
  duration: number | null;
  join_url: string | null;
}

export interface DriveAccount {
  id: string;
  email: string;
  name: string | null;
  connected_at: string;
}

export interface Connections {
  zoom: ZoomAccount[];
  gmail: GmailAccount[];
  drive: DriveAccount[];
  fireflies: FirefliesAccount[];
}

export async function fetchConnections(): Promise<Connections> {
  const { data, error } = await supabase.rpc("my_connections");
  if (error) throw error;
  const c = (data ?? {}) as Partial<Connections>;
  return { zoom: Array.isArray(c.zoom) ? c.zoom : [], gmail: c.gmail ?? [], drive: c.drive ?? [], fireflies: c.fireflies ?? [] };
}

/** Calls one of the functions; their own error message comes back as the Error. */
export async function callFunction<T>(
  name: "zoom" | "gmail" | "drive" | "drive/upload" | "invoices" | "invoices/upload" | "fireflies" | "whatsapp-bot" | "apps",
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
 * Where Zoom / Google send the browser back: this app's Connected accounts
 * page; started in the Android or Windows app, back into that app
 * (?iklipse_app=..., _shared/oauth.ts backToApp).
 */
const returnTo = (app: AppPlatform | null) => `${location.origin}${location.pathname}${app ? `?iklipse_app=${app}` : ""}#/connections`;

/** Off to Zoom's / Google's consent page (comes back to /connections?<provider>=...). */
export async function startConnect(provider: "zoom" | "gmail" | "drive") {
  const app = await signInReturn();
  const { url } = await callFunction<{ url: string }>(provider, { action: "connect", returnTo: returnTo(app) });
  if (app) openSignIn(url);
  else window.location.assign(url);
}

// Zoom's sign-out (then on to zoom.com) and its sign-in.
const ZOOM_SIGN_OUT = "https://zoom.us/logout";
const ZOOM_SIGN_IN = "https://zoom.us/signin";
let zoomWindow: Window | null = null;

/**
 * Switching the account signed in on Zoom, before connecting another one.
 * Zoom's consent page has no account picker (it goes on as whoever is signed
 * in to zoom.us), and signing in on the way there fails (Google sign-in lands
 * on marketplace.zoom.us/error). So: signed out, then Zoom's own sign-in, and
 * only then the connect. A browser: one small window, out then on to the
 * sign-in. The Windows app: the same in the browser. Android: the app's
 * browser tab, signed out, where Zoom's Sign in button is. Call it straight
 * from the click (a browser opens the window only then); false: the window
 * was blocked.
 */
export function switchZoomAccount(): boolean {
  if (appPlatform === "android") {
    openSignIn(ZOOM_SIGN_OUT);
    return true;
  }
  if (appPlatform === "windows") {
    window.location.assign(ZOOM_SIGN_OUT);
    window.setTimeout(() => window.location.assign(ZOOM_SIGN_IN), 3000);
    return true;
  }
  const w = window.open(ZOOM_SIGN_OUT, "zoom-account", "popup,width=520,height=720");
  if (!w) return false;
  zoomWindow = w;
  window.setTimeout(() => {
    if (!w.closed) w.location.href = ZOOM_SIGN_IN;
  }, 2500);
  return true;
}

/** Connecting Zoom, with the account now signed in there (the switching window closes). */
export function connectZoom() {
  try {
    zoomWindow?.close();
  } catch {
    /* already closed */
  }
  zoomWindow = null;
  return startConnect("zoom");
}

export async function disconnectZoom(account: string) {
  await callFunction("zoom", { action: "disconnect", account });
}

/** The WhatsApp bot books my meetings on this account. */
export async function setZoomForBot(account: string) {
  await callFunction("zoom", { action: "use_for_bot", account });
}

/** What's coming up on one of my Zoom accounts. */
export async function fetchZoomMeetings(account: string): Promise<ZoomMeeting[]> {
  const r = await callFunction<{ meetings: ZoomMeeting[] }>("zoom", { action: "meetings", account });
  return r.meetings ?? [];
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

/** What the provider's return (?zoom= / ?gmail=) means, for the toast. */
export const RETURN_MESSAGES: Record<string, { kind: "success" | "error"; title: string; description?: string }> = {
  "zoom:connected": { kind: "success", title: "Zoom connected" },
  "zoom:again": {
    kind: "success",
    title: "That Zoom account was already connected",
    description: "To add a different one, connect again and pick Another account.",
  },
  "zoom:too_many": { kind: "error", title: "Zoom wasn't connected", description: "You can connect up to 10 Zoom accounts." },
  "zoom:denied": { kind: "error", title: "Zoom wasn't connected", description: "You cancelled on Zoom's page." },
  "zoom:error": { kind: "error", title: "Couldn't connect Zoom", description: "Try again in a moment." },
  "zoom:bad_keys": {
    kind: "error",
    title: "Couldn't connect Zoom",
    description: "Zoom didn't accept the app's keys. ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET on the server must both come from the same Zoom app.",
  },
  "zoom:redirect": {
    kind: "error",
    title: "Couldn't connect Zoom",
    description: "The Zoom app's redirect URL doesn't match. It must be .../functions/v1/zoom/callback, on its OAuth allow list too.",
  },
  "zoom:scopes": {
    kind: "error",
    title: "Couldn't connect Zoom",
    description: "The Zoom app is missing a scope (user:read:user). Upload the manifest again, then connect.",
  },
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
