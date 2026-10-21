// calendar — each person connects their Google Calendar (0096), with the same
// Google OAuth client as Gmail and Drive. Someone on Calendly can't connect it
// (and the other way round): one or the other. The Calendar page lists the
// meetings on the main calendar, makes one (with a Google Meet link, Google
// emails the guests) and cancels.
//
// POST (login token) { action, ... }:
//   connect { returnTo }                               -> { url }
//   disconnect { account }                             -> { ok }
//   calendar { account, from, to }  (days, YYYY-MM-DD, Cairo)
//                                                      -> { meetings: [{ id, name, start, end, minutes, status,
//                                                         join_url, location, whatsapp, with, link }] }
//   get { account, id }                                -> { meeting: { ..., place, password, note, mine, invitees } }
//   create { account, title, day, time, minutes, emails?, note?, meet? } -> { id, join_url }
//   cancel { account, id }                             -> { ok }
// GET  /calendar/callback?code&state                   (Google sends the browser here)
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, optional CALENDAR_REDIRECT_URI
// (default <project>/functions/v1/calendar/callback, which must be an
// authorized redirect URI of the Google OAuth client). The Google Calendar API
// must be switched on for the Google Cloud project. Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("CALENDAR_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/calendar/callback`;
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const SCOPES = ["openid", "email", "profile", CALENDAR_SCOPE];
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_ACCOUNTS = 10;
const TZ = "Africa/Cairo";
const DAY = 24 * 60 * 60_000;
const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
const ONE_OR_THE_OTHER = "You use Calendly. Disconnect it in Connected accounts first: it's Calendly or Google Calendar, not both.";

interface Account {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
}

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

interface Person {
  email?: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: Person;
  attendees?: Person[];
  conferenceData?: {
    conferenceSolution?: { key?: { type?: string }; name?: string };
    entryPoints?: { entryPointType?: string; uri?: string; pin?: string; passcode?: string; password?: string }[];
  };
}

// --------------------------------------------------------------- tokens --

async function tokenCall(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google token: ${data.error ?? res.status}`);
  return data as GoogleTokens;
}

const expiry = (t: GoogleTokens) => new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString();

/** A working access token for the account, refreshed if needed. */
async function token(db: SupabaseClient, a: Account, force = false): Promise<string> {
  if (!force && a.access_token && a.token_expiry && Date.parse(a.token_expiry) > Date.now() + 30_000) return a.access_token;
  let t: GoogleTokens;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: a.refresh_token });
  } catch (e) {
    // Access was removed (or, while the Google app is in Testing, the weekly expiry).
    if (/invalid_grant/.test((e as Error).message)) {
      await db.from("calendar_account").delete().eq("id", a.id).eq("refresh_token", a.refresh_token);
      throw new HttpError(409, `${a.email} needs to be connected again`);
    }
    if (/unauthorized_client|invalid_client/.test((e as Error).message)) {
      throw new HttpError(409, `${a.email} needs to be connected again (Connected accounts)`);
    }
    throw new HttpError(502, "Couldn't reach Google. Try again.");
  }
  const patch = {
    access_token: t.access_token,
    token_expiry: expiry(t),
    updated_at: new Date().toISOString(),
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
  };
  await db.from("calendar_account").update(patch).eq("id", a.id).eq("refresh_token", a.refresh_token);
  Object.assign(a, patch);
  return t.access_token;
}

/** A Calendar call for the account (retried once with a fresh token). */
async function gcal<T>(db: SupabaseClient, a: Account, path: string, init: RequestInit = {}): Promise<T> {
  const go = async (tok: string) =>
    fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${tok}` },
    });
  let res = await go(await token(db, a));
  if (res.status === 401) res = await go(await token(db, a, true));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg: string = err?.error?.message ?? `status ${res.status}`;
    const reason: string = err?.error?.errors?.[0]?.reason ?? "";
    if (res.status === 403 && /insufficient/i.test(msg + reason)) throw new HttpError(409, `${a.email} needs to be connected again (Calendar access wasn't allowed)`);
    if (reason === "accessNotConfigured" || /has not been used|is disabled/i.test(msg)) {
      throw new HttpError(503, "The Google Calendar API isn't switched on for this Google Cloud project yet.");
    }
    if (res.status === 404 || res.status === 410) throw new HttpError(404, "That meeting isn't there any more");
    throw new HttpError(res.status === 403 ? 403 : 502, `Google Calendar: ${msg}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

async function myAccount(db: SupabaseClient, userId: string, id: unknown): Promise<Account> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "Pick an account");
  const { data } = await db.from("calendar_account").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "That Google Calendar isn't connected");
  return data as Account;
}

const usesCalendly = async (db: SupabaseClient, userId: string) => {
  const { count } = await db.from("calendly_account").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return (count ?? 0) > 0;
};

// -------------------------------------------------------------- meetings --

/** The moment a time on a Cairo day is ("2026-10-21", "14:30"). */
function cairoAt(day: string, time: string) {
  const v =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T${time}:00Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  return Date.parse(`${day}T${time}:00${v === "GMT" ? "+00:00" : v.replace("GMT", "")}`);
}
const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isTime = (t: unknown): t is string => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const emailOk = (e: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(e);
const eventId = (v: unknown) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_@.-]{1,1100}$/.test(v)) throw new HttpError(400, "Which meeting?");
  return v;
};

const guestsOf = (e: GEvent) => (e.attendees ?? []).filter((p) => !p.self && !p.resource && p.email);
const videoOf = (e: GEvent) => e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video");

/** As the Calendly page has it: "google_conference", "zoom", "physical"... */
function placeOf(e: GEvent) {
  const kind = e.conferenceData?.conferenceSolution?.key?.type;
  const name = e.conferenceData?.conferenceSolution?.name ?? "";
  if (kind === "hangoutsMeet" || e.hangoutLink) return "google_conference";
  if (/zoom/i.test(name)) return "zoom";
  if (/teams/i.test(name)) return "microsoft_teams_conference";
  if (e.location) return "physical";
  return null;
}

/** A meeting as the page shows it; all-day items and working locations aren't meetings. */
function meetingOf(e: GEvent) {
  const start = e.start?.dateTime;
  const end = e.end?.dateTime;
  if (!start || !end || e.status === "cancelled" || e.eventType === "workingLocation" || e.eventType === "birthday") return null;
  const guests = guestsOf(e);
  const first = guests[0];
  return {
    id: e.id,
    name: e.summary?.trim() || "Busy",
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    minutes: Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000)),
    status: "active" as const,
    join_url: e.hangoutLink ?? videoOf(e)?.uri ?? null,
    location: placeOf(e),
    whatsapp: null,
    with: first ? `${first.displayName || first.email}${guests.length > 1 ? ` and ${guests.length - 1} more` : ""}` : null,
    link: e.htmlLink ?? null,
  };
}

// ------------------------------------------------------------ callback --

function idClaims(idToken: string | undefined): { email?: string; name?: string } {
  if (!idToken) return {};
  try {
    const p = idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = await readState(url.searchParams.get("state"));
  const back = state?.r ?? safeReturn(null);
  if (url.searchParams.get("error")) return backToApp(back, "calendar", "denied");
  const code = url.searchParams.get("code");
  if (!state || !code) return backToApp(back, "calendar", "error");
  try {
    const db = serviceClient();
    if (await usesCalendly(db, state.u)) return backToApp(back, "calendar", "calendly");
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    // The person may untick "see, edit, share and delete your calendar events" on Google's screen.
    if (!(t.scope ?? "").split(" ").includes(CALENDAR_SCOPE)) return backToApp(back, "calendar", "missing_scope");
    const who = idClaims(t.id_token);
    const email = who.email?.toLowerCase();
    if (!email) return backToApp(back, "calendar", "error");
    const { data: existing } = await db.from("calendar_account").select("id").eq("user_id", state.u).eq("email", email).maybeSingle();
    if (!existing) {
      const { count } = await db.from("calendar_account").select("id", { count: "exact", head: true }).eq("user_id", state.u);
      if ((count ?? 0) >= MAX_ACCOUNTS) return backToApp(back, "calendar", "too_many");
    }
    const row = {
      user_id: state.u,
      email,
      name: who.name ?? null,
      access_token: t.access_token,
      token_expiry: expiry(t),
      scope: t.scope ?? null,
      updated_at: new Date().toISOString(),
    };
    if (t.refresh_token) {
      const { error } = await db
        .from("calendar_account")
        .upsert({ ...row, refresh_token: t.refresh_token, connected_at: new Date().toISOString() }, { onConflict: "user_id,email" });
      if (error) throw error;
    } else if (existing) {
      const { error } = await db.from("calendar_account").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      return backToApp(back, "calendar", "error");
    }
    return backToApp(back, "calendar", "connected");
  } catch (e) {
    console.error("calendar callback", (e as Error).message);
    return backToApp(back, "calendar", "error");
  }
}

// ----------------------------------------------------------------- serve --

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const r = route(req);
  if (req.method === "GET" && r === "callback") return callback(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = serviceClient();
    const me = await caller(req, db);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (b.action === "connect") {
      if (!configured()) throw new HttpError(503, "Google isn't set up on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
      if (await usesCalendly(db, me.id)) throw new HttpError(409, ONE_OR_THE_OTHER);
      const state = await signState(me.id, safeReturn(b.returnTo));
      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        // Always the account picker (to add another calendar) and a fresh refresh token.
        prompt: "consent select_account",
        include_granted_scopes: "true",
        state,
      });
      return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
    }

    const a = await myAccount(db, me.id, b.account);

    switch (b.action) {
      case "disconnect": {
        // Revoking ends every grant of this Google login to the app (Gmail and
        // Drive too): only when nobody has it connected for those.
        const [mail, files, cals] = await Promise.all([
          db.from("gmail_account").select("id", { count: "exact", head: true }).eq("email", a.email),
          db.from("drive_account").select("id", { count: "exact", head: true }).eq("email", a.email),
          db.from("calendar_account").select("id", { count: "exact", head: true }).eq("email", a.email).neq("id", a.id),
        ]);
        if (!mail.count && !files.count && !cals.count) {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refresh_token)}`, { method: "POST" }).catch(() => undefined);
        }
        await db.from("calendar_account").delete().eq("id", a.id);
        return json({ ok: true });
      }

      case "calendar": {
        if (!isDay(b.from) || !isDay(b.to) || b.to < b.from) throw new HttpError(400, "from and to are days, YYYY-MM-DD");
        const from = cairoAt(b.from, "00:00");
        const to = Math.min(cairoAt(b.to, "00:00") + DAY, from + 120 * DAY);
        const q = new URLSearchParams({
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "2500",
          timeZone: TZ,
        });
        const r = await gcal<{ items?: GEvent[] }>(db, a, `?${q}`);
        return json({ meetings: (r.items ?? []).map(meetingOf).filter(Boolean) });
      }

      case "get": {
        const e = await gcal<GEvent>(db, a, `/${encodeURIComponent(eventId(b.id))}`);
        const m = meetingOf(e);
        if (!m) throw new HttpError(404, "That meeting isn't there any more");
        const v = videoOf(e);
        return json({
          meeting: {
            ...m,
            place: e.location ?? null,
            password: v?.passcode ?? v?.password ?? v?.pin ?? null,
            note: e.description ?? null,
            // Made by them: cancelling tells the guests. Someone else's: only off their calendar.
            mine: e.organizer?.self ?? false,
            invitees: (e.attendees ?? [])
              .filter((p) => !p.resource && p.email)
              .map((p) => ({ name: p.displayName ?? "", email: p.email!, status: p.responseStatus ?? "needsAction", organizer: !!p.organizer, self: !!p.self })),
          },
        });
      }

      case "create": {
        const title = str(b.title).slice(0, 200) || "Meeting";
        if (!isDay(b.day) || !isTime(b.time)) throw new HttpError(400, "Pick a day and a time");
        const minutes = Number(b.minutes);
        if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) throw new HttpError(400, "Pick how long it is");
        const emails = [...new Set((Array.isArray(b.emails) ? b.emails : []).map((x) => str(x).toLowerCase()).filter(Boolean))];
        const bad = emails.find((x) => !emailOk(x));
        if (bad) throw new HttpError(400, `${bad} doesn't look like an email`);
        if (emails.length > 50) throw new HttpError(400, "50 people at most");
        const start = cairoAt(b.day, b.time);
        if (start < Date.now() - 5 * 60_000) throw new HttpError(400, "That time has passed");
        const meet = b.meet !== false;
        const body = {
          summary: title,
          description: str(b.note).slice(0, 4000) || undefined,
          start: { dateTime: new Date(start).toISOString(), timeZone: TZ },
          end: { dateTime: new Date(start + minutes * 60_000).toISOString(), timeZone: TZ },
          attendees: emails.map((email) => ({ email })),
          ...(meet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
        };
        const e = await gcal<GEvent>(db, a, `?conferenceDataVersion=1&sendUpdates=all`, { method: "POST", body: JSON.stringify(body) });
        return json({ id: e.id, join_url: e.hangoutLink ?? videoOf(e)?.uri ?? null });
      }

      case "cancel": {
        await gcal(db, a, `/${encodeURIComponent(eventId(b.id))}?sendUpdates=all`, { method: "DELETE" });
        return json({ ok: true });
      }
    }
    throw new HttpError(400, "Unknown action");
  } catch (e) {
    return toResponse(e);
  }
});
