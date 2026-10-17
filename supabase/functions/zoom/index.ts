// zoom — each person connects their own Zoom accounts (0052; more than one
// since 0079), exactly like the iklipse-system app: a user-managed OAuth app
// (authorization code), scopes set on the Zoom app itself (user:read:user,
// meeting:write:meeting, meeting:read:list_meetings, meeting:read:meeting,
// meeting:update:meeting, meeting:delete:meeting), refreshed when it expires.
// One of a person's accounts is the one the WhatsApp bot books on (for_bot).
// The Zoom app itself: zoom-app-manifest.json (Marketplace > Develop > Build
// from an app manifest).
//
// POST { action: "connect", returnTo }  (login token) -> { url }
// GET  /zoom/callback?code&state       (Zoom sends the browser here)
// POST { action: "disconnect", account } (login token) -> { ok }
// POST { action: "use_for_bot", account } (login token) -> { ok }
// POST { action: "meetings", account }  (login token) -> { meetings: [{ id, topic, start_time, duration, join_url }] }
// The Zoom page, a calendar of one account (login token, the account is theirs):
// POST { action: "calendar", account, from, to } (days, YYYY-MM-DD) -> { meetings: [... past and coming,
//                                      each meeting of a series apart (occurrence), whatsapp: the group
//                                      the bot booked it from, or null], rooms: [links with no fixed time] }
// POST { action: "get", account, id }  -> { meeting: { id, topic, kind, start_time, duration, timezone, agenda,
//                                      join_url, password, repeat, options, invitees } }
// POST { action: "create", account, topic, kind (once | instant | no_time | repeat), start?, minutes?,
//        agenda?, timezone?, password?, repeat?, options?, invitees?, notify?, gmail? } -> { id, join_url, invited }
// POST { action: "update", account, id, (the same, each optional) } -> { ok, invited }
// POST { action: "delete", account, id, occurrence?, notify? } -> { ok, invited }
// invitees: emails. Zoom keeps them on the meeting; unless notify is false they get the
// invitation (and changes, and the cancellation) by email from the person's Gmail (gmail:
// which one; _shared/invite.ts). invited: { sent, from } or { error }, null when nobody.
// POST { action: "meeting", topic, start, minutes, agenda? } (login token, on the bot's account)
//                                      -> { join_url, start_url, id }
// POST /zoom/events                    (Zoom: the app's event notifications, signed with its
//                                      secret token) app_deauthorized: someone removed iklipse
//                                      in Zoom, so that account's tokens and details go.
//
// The token and the meetings themselves: _shared/zoom.ts (whatsapp-bot books too).
// Secrets: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (the Zoom app's), ZOOM_WEBHOOK_SECRET
// (its Secret Token, for /zoom/events), optional ZOOM_REDIRECT_URI (default
// <project>/functions/v1/zoom/callback, which must be on the Zoom app's
// redirect allow list). Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, same, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";
import {
  accessToken,
  basic,
  botAccount,
  CLIENT_ID,
  configured,
  createMeeting,
  deleteMeeting,
  expiry,
  getMeeting,
  listMeetings,
  kindOf,
  tokenCall,
  upcomingMeetings,
  updateMeeting,
  type MeetingKind,
  type MeetingSettings,
  type Recurrence,
  type ZoomListed,
  type ZoomMeetingFull,
} from "../_shared/zoom.ts";
import { emailsOf, invitedFrom, inviteesOn, repeatWords, sendInvites, senderFor, type Invited } from "../_shared/invite.ts";

const REDIRECT_URI = Deno.env.get("ZOOM_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/zoom/callback`;
const MAX_ACCOUNTS = 10;

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = await readState(url.searchParams.get("state"));
  const back = state?.r ?? safeReturn(null);
  if (url.searchParams.get("error")) return backToApp(back, "zoom", "denied");
  const code = url.searchParams.get("code");
  if (!state || !code) return backToApp(back, "zoom", "error");
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    // Which Zoom account this is: a person can connect several.
    const me = await fetch("https://api.zoom.us/v2/users/me", { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (!me.ok) throw new Error(`zoom users/me: ${me.status}`);
    const u = await me.json();
    const zoomId = String(u.id ?? "");
    if (!zoomId) throw new Error("zoom users/me: no id");
    const db = serviceClient();
    const { data: mine } = await db.from("zoom_account").select("id, zoom_user_id").eq("user_id", state.u);
    const again = (mine ?? []).some((a) => a.zoom_user_id === zoomId);
    if (!again && (mine ?? []).length >= MAX_ACCOUNTS) return backToApp(back, "zoom", "too_many");
    const now = new Date().toISOString();
    const { error } = await db.from("zoom_account").upsert(
      {
        user_id: state.u,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        token_expiry: expiry(t),
        scope: t.scope ?? null,
        zoom_email: u.email ?? null,
        zoom_user_id: zoomId,
        // Their first account is the bot's.
        ...(again ? {} : { connected_at: now, for_bot: !(mine ?? []).length }),
        updated_at: now,
      },
      { onConflict: "user_id,zoom_user_id" },
    );
    if (error) throw error;
    return backToApp(back, "zoom", again ? "again" : "connected");
  } catch (e) {
    const msg = (e as Error).message;
    console.error("zoom callback", msg);
    // Say what's wrong when it's the set-up: the app's keys, its redirect, its scopes.
    const why = /invalid_client|client_id|client_secret/i.test(msg)
      ? "bad_keys"
      : /redirect/i.test(msg)
        ? "redirect"
        : /users\/me: (401|403)/.test(msg)
          ? "scopes"
          : "error";
    return backToApp(back, "zoom", why);
  }
}

const WEBHOOK_SECRET = Deno.env.get("ZOOM_WEBHOOK_SECRET") ?? "";

/** HMAC-SHA256 of the text with the Zoom app's secret token, in hex. */
async function signed(text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** This person's next Zoom account becomes the bot's, when the bot's one went. */
async function nextForBot(db: SupabaseClient, userId: string) {
  const { data } = await db.from("zoom_account").select("id").eq("user_id", userId).eq("for_bot", true).limit(1);
  if (data?.length) return;
  const next = await botAccount(db, userId);
  if (next) await db.from("zoom_account").update({ for_bot: true }).eq("id", next);
}

/**
 * Zoom's event notifications (the app's Event Subscription and its
 * Deauthorization Notification Endpoint): POST /zoom/events, signed with the
 * app's secret token (x-zm-signature). endpoint.url_validation: Zoom checking
 * the URL. app_deauthorized: someone removed iklipse in Zoom: that Zoom
 * account's tokens and details are deleted, as when it's disconnected here.
 * Unsigned (Zoom has sent some without), it's only believed once Zoom itself
 * refuses the account's refresh token.
 */
async function events(req: Request): Promise<Response> {
  if (!WEBHOOK_SECRET) return json({ error: "ZOOM_WEBHOOK_SECRET isn't set" }, 503);
  const raw = await req.text();
  const ts = req.headers.get("x-zm-request-timestamp") ?? "";
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  const ok = fresh && same(req.headers.get("x-zm-signature") ?? "", `v0=${await signed(`v0:${ts}:${raw}`)}`);
  let e: { event?: string; payload?: Record<string, unknown> };
  try {
    e = JSON.parse(raw);
  } catch {
    return json({ error: "Bad body" }, 400);
  }
  if (e.event === "endpoint.url_validation") {
    if (!ok) return json({ error: "Bad signature" }, 401);
    const plainToken = String(e.payload?.plainToken ?? "");
    return json({ plainToken, encryptedToken: await signed(plainToken) });
  }
  if (e.event === "app_deauthorized") {
    const zoomId = String(e.payload?.user_id ?? "");
    if (!zoomId) return json({ ok: true });
    const db = serviceClient();
    const { data: rows } = await db.from("zoom_account").select("id, user_id").eq("zoom_user_id", zoomId);
    for (const r of rows ?? []) {
      if (ok) await db.from("zoom_account").delete().eq("id", r.id);
      else {
        // Unsigned: a refresh now; Zoom refusing it deletes the account (accessToken).
        await db.from("zoom_account").update({ token_expiry: new Date().toISOString() }).eq("id", r.id);
        await accessToken(db, r.id);
      }
      await nextForBot(db, r.user_id as string);
    }
    console.log("zoom deauthorized", { accounts: rows?.length ?? 0, signed: ok });
  }
  return json({ ok: true });
}

const DAY = 24 * 60 * 60_000;
const isDay =(v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const meetingId = (v: unknown) => {
  const id = typeof v === "string" || typeof v === "number" ? String(v) : "";
  if (!/^\d{6,15}$/.test(id)) throw new HttpError(400, "Bad meeting id");
  return id;
};
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** "2026-10-20T13:00:00Z" from the app's ISO time, or a 400. */
function startOf(v: unknown) {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new HttpError(400, "Bad start time");
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}
/** The person's time zone name, or Cairo's. */
const zoneOf = (v: unknown) => (typeof v === "string" && v.length <= 64 && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v) ? v : "Africa/Cairo");

const clampMinutes = (v: unknown) => Math.max(1, Math.min(24 * 60, Math.round(Number(v)) || 30));
const KINDS: MeetingKind[] = ["once", "instant", "no_time", "repeat"];
const kindIn = (v: unknown): MeetingKind => (KINDS.includes(v as MeetingKind) ? (v as MeetingKind) : "once");
const timed = (k: MeetingKind) => k === "once" || k === "repeat";

/** How it repeats, from the page: { type: daily | weekly | monthly, every, days (1 Sunday..7), monthDay, times | until }. */
function recurrenceOf(v: unknown): Recurrence {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const type = r.type === "daily" ? 1 : r.type === "weekly" ? 2 : r.type === "monthly" ? 3 : 0;
  if (!type) throw new HttpError(400, "Pick how it repeats");
  // Zoom's limits: every 99 days, 50 weeks or 10 months at most.
  const max = type === 1 ? 99 : type === 2 ? 50 : 10;
  const out: Recurrence = { type, repeat_interval: Math.max(1, Math.min(max, Math.round(Number(r.every)) || 1)) };
  if (type === 2) {
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
    if (!days.length) throw new HttpError(400, "Pick the days it repeats on");
    out.weekly_days = days.join(",");
  }
  if (type === 3) {
    const d = Math.round(Number(r.monthDay));
    if (!(d >= 1 && d <= 31)) throw new HttpError(400, "Pick the day of the month it repeats on");
    out.monthly_day = d;
  }
  if (r.until) out.end_date_time = startOf(r.until);
  else out.end_times = Math.max(1, Math.min(50, Math.round(Number(r.times)) || 10));
  return out;
}

/** Back to the page's shape. */
const repeatOut = (r: Recurrence) => ({
  type: r.type === 1 ? "daily" : r.type === 2 ? "weekly" : "monthly",
  every: r.repeat_interval ?? 1,
  days: r.weekly_days ? r.weekly_days.split(",").map(Number) : [],
  monthDay: r.monthly_day ?? null,
  times: r.end_times ?? null,
  until: r.end_date_time ?? null,
});

const OPTIONS = ["host_video", "participant_video", "join_before_host", "mute_upon_entry", "waiting_room"] as const;

/** The meeting's options from the page (only the ones given), and its invitees. */
function settingsOf(v: unknown, invitees?: string[]): MeetingSettings | undefined {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s: MeetingSettings = {};
  for (const k of OPTIONS) if (typeof o[k] === "boolean") s[k] = o[k] as boolean;
  if (o.auto_recording === "none" || o.auto_recording === "local" || o.auto_recording === "cloud") s.auto_recording = o.auto_recording;
  if (typeof o.jbh_time === "number" && [0, 5, 10, 15].includes(o.jbh_time)) s.jbh_time = o.jbh_time;
  if (invitees) s.meeting_invitees = invitees.map((email) => ({ email }));
  return Object.keys(s).length ? s : undefined;
}

/** A passcode: up to 10 letters, numbers or @ - _ * (none: Zoom makes one). */
function passcodeOf(v: unknown) {
  const p = typeof v === "string" ? v.trim() : "";
  if (!p) return undefined;
  if (!/^[A-Za-z0-9@_*-]{1,10}$/.test(p)) throw new HttpError(400, "A passcode is up to 10 letters, numbers or @ - _ *");
  return p;
}

/** The invitees' emails, or a 400 naming the ones that aren't. */
function inviteesOf(v: unknown) {
  const { good, bad } = emailsOf(v);
  if (bad.length) throw new HttpError(400, `Not an email address: ${bad.slice(0, 3).join(", ")}`);
  return good;
}

type Account = { id: string; zoom_email: string | null };
type Me = { id: string; name: string };
type InviteResult = { sent: number; from: string } | { error: string } | null;

/** Emails the invitation to these people, unless asked not to: who it went from, or why it didn't. */
async function emailInvites(db: SupabaseClient, me: Me, row: Account, body: Record<string, unknown>, to: string[], m: Invited, how: "new" | "update" | "cancel"): Promise<InviteResult> {
  if (!to.length || body.notify === false) return null;
  const from = await senderFor(db, me.id, { gmail: typeof body.gmail === "string" ? body.gmail : null, email: row.zoom_email });
  if (!from) return { error: "Connect a Gmail account (Connections page) to email the invitations" };
  try {
    await sendInvites({ from, host: me.name || from.name || from.email, to, m, how });
    return { sent: to.length, from: from.email };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Zoom said no: its own words. */
function zoomSaid(e: unknown): never {
  if (e instanceof HttpError) throw e;
  throw new HttpError(502, `Zoom said no: ${(e as Error).message}`);
}

/** Meetings the WhatsApp bot booked, by Zoom id: the group they were asked for in. */
async function fromWhatsApp(db: SupabaseClient, ids: string[]) {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data } = await db.from("wa_bot_meeting").select("zoom_id, chat_id").in("zoom_id", ids).eq("status", "booked");
  const chats = [...new Set((data ?? []).map((r) => r.chat_id as string))];
  const { data: groups } = chats.length ? await db.from("wa_group").select("chat_id, name").in("chat_id", chats) : { data: [] };
  const names = new Map((groups ?? []).map((g) => [g.chat_id as string, (g.name as string | null) ?? "a WhatsApp group"]));
  for (const r of data ?? []) out.set(r.zoom_id as string, names.get(r.chat_id as string) ?? "a WhatsApp group");
  return out;
}

/** One of this person's accounts, or a 404. */
async function mine(db: SupabaseClient, userId: string, account: unknown) {
  const id = typeof account === "string" && /^[0-9a-f-]{36}$/.test(account) ? account : "";
  const { data } = id ? await db.from("zoom_account").select("id, access_token, for_bot, zoom_email").eq("id", id).eq("user_id", userId).maybeSingle() : { data: null };
  if (!data) throw new HttpError(404, "That Zoom account isn't connected");
  return data as { id: string; access_token: string | null; for_bot: boolean; zoom_email: string | null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET" && route(req) === "callback") return callback(req);
  if (req.method === "POST" && route(req) === "events") return events(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = serviceClient();
    const me = await caller(req, db);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (body.action === "connect") {
      if (!configured()) throw new HttpError(503, "Zoom isn't set up on the server yet (ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET).");
      const state = await signState(me.id, safeReturn(body.returnTo));
      const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state });
      return json({ url: `https://zoom.us/oauth/authorize?${q}` });
    }

    if (body.action === "disconnect") {
      const row = await mine(db, me.id, body.account);
      // Tell Zoom too, so the app no longer has access (best effort).
      if (row.access_token && configured()) {
        await fetch(`https://zoom.us/oauth/revoke?token=${encodeURIComponent(row.access_token)}`, {
          method: "POST",
          headers: { Authorization: basic() },
        }).catch(() => undefined);
      }
      await db.from("zoom_account").delete().eq("id", row.id);
      // The bot's account went: their next one takes over.
      if (row.for_bot) {
        const next = await botAccount(db, me.id);
        if (next) await db.from("zoom_account").update({ for_bot: true }).eq("id", next);
      }
      return json({ ok: true });
    }

    if (body.action === "use_for_bot") {
      const row = await mine(db, me.id, body.account);
      await db.from("zoom_account").update({ for_bot: false }).eq("user_id", me.id).neq("id", row.id);
      await db.from("zoom_account").update({ for_bot: true }).eq("id", row.id);
      return json({ ok: true });
    }

    if (body.action === "meetings") {
      const row = await mine(db, me.id, body.account);
      const token = await accessToken(db, row.id);
      if (!token) throw new HttpError(409, "This Zoom account needs connecting again");
      try {
        const list = await upcomingMeetings(token);
        const meetings = list
          .filter((m) => m.start_time)
          .sort((a, b) => Date.parse(a.start_time!) - Date.parse(b.start_time!))
          .map((m) => ({ id: String(m.id), topic: m.topic, start_time: m.start_time, duration: m.duration ?? null, join_url: m.join_url ?? null }));
        return json({ meetings });
      } catch (e) {
        throw new HttpError(502, `Zoom said no: ${(e as Error).message}`);
      }
    }

    // ---------------------------------------------------------- the Zoom page --
    if (["calendar", "get", "create", "update", "delete"].includes(String(body.action))) {
      const row = await mine(db, me.id, body.account);
      const token = await accessToken(db, row.id);
      if (!token) throw new HttpError(409, "This Zoom account needs connecting again");

      if (body.action === "calendar") {
        if (!isDay(body.from) || !isDay(body.to) || body.from > body.to) throw new HttpError(400, "Bad days");
        let scheduled: ZoomListed[] = [];
        try {
          scheduled = await listMeetings(token, { type: "scheduled" });
        } catch (e) {
          zoomSaid(e);
        }
        // Past ones (Zoom keeps about six months of them).
        const previous = await listMeetings(token, { type: "previous_meetings", from: body.from, to: body.to }).catch(() => [] as ZoomListed[]);
        // A series is listed once, at its next time: each of its meetings instead.
        type Item = ZoomListed & { occurrence?: string };
        const series = scheduled.filter((m) => m.type === 8).slice(0, 25);
        const full = await Promise.all(series.map((m) => getMeeting(token, m.id).catch(() => null)));
        const expanded = new Set<number>();
        const occurrences: Item[] = [];
        full.forEach((d, i) => {
          const list = (d?.occurrences ?? []).filter((o) => o.status !== "deleted");
          if (!list.length) return;
          expanded.add(series[i]!.id);
          for (const o of list) occurrences.push({ ...series[i]!, start_time: o.start_time, duration: o.duration ?? series[i]!.duration, occurrence: o.occurrence_id });
        });
        // A day either side: the app keeps the ones on its own days.
        const lo = Date.parse(`${body.from}T00:00:00Z`) - DAY;
        const hi = Date.parse(`${body.to}T00:00:00Z`) + 2 * DAY;
        const seen = new Set<string>();
        const list = [...occurrences, ...scheduled.filter((m) => m.type !== 3 && !expanded.has(m.id)), ...previous].filter((m: Item) => {
          const t = m.start_time ? Date.parse(m.start_time) : NaN;
          const key = `${m.id}|${m.start_time}`;
          if (Number.isNaN(t) || t < lo || t > hi || seen.has(key)) return false;
          seen.add(key);
          return true;
        }) as Item[];
        // Links with no fixed time: no place on a calendar.
        const rooms = scheduled.filter((m) => m.type === 3);
        const wa = await fromWhatsApp(db, [...list, ...rooms].map((m) => String(m.id)));
        const meetings = list
          .sort((a, b) => Date.parse(a.start_time!) - Date.parse(b.start_time!))
          .map((m) => ({
            id: String(m.id),
            occurrence: m.occurrence ?? null,
            topic: m.topic,
            kind: kindOf(m.type),
            start_time: m.start_time,
            duration: m.duration ?? null,
            join_url: m.join_url ?? null,
            recurring: m.type === 3 || m.type === 8,
            whatsapp: wa.get(String(m.id)) ?? null,
          }));
        return json({
          meetings,
          rooms: rooms.map((m) => ({ id: String(m.id), topic: m.topic, join_url: m.join_url ?? null, created_at: m.created_at ?? null, whatsapp: wa.get(String(m.id)) ?? null })),
        });
      }

      if (body.action === "get") {
        try {
          const m = await getMeeting(token, meetingId(body.id));
          const st = m.settings ?? {};
          return json({
            meeting: {
              id: String(m.id),
              topic: m.topic,
              kind: kindOf(m.type),
              start_time: m.start_time ?? null,
              duration: m.duration ?? null,
              timezone: m.timezone ?? null,
              agenda: m.agenda ?? "",
              join_url: m.join_url,
              password: m.password ?? null,
              type: m.type,
              repeat: m.recurrence ? repeatOut(m.recurrence) : null,
              repeat_words: m.recurrence ? repeatWords(m.recurrence, m.timezone || "Africa/Cairo") : null,
              options: {
                host_video: !!st.host_video,
                participant_video: !!st.participant_video,
                join_before_host: !!st.join_before_host,
                jbh_time: st.jbh_time ?? 0,
                mute_upon_entry: !!st.mute_upon_entry,
                waiting_room: !!st.waiting_room,
                auto_recording: st.auto_recording ?? "none",
              },
              invitees: (st.meeting_invitees ?? []).map((i) => i.email).filter(Boolean),
            },
          });
        } catch (e) {
          zoomSaid(e);
        }
      }

      if (body.action === "create") {
        const topic = text(body.topic, 200);
        if (!topic) throw new HttpError(400, "Give the meeting a title");
        const kind = kindIn(body.kind);
        const zone = zoneOf(body.timezone);
        const start = timed(kind) ? startOf(body.start) : undefined;
        if (start && Date.parse(start) < Date.now() - 5 * 60_000) throw new HttpError(400, "That time has passed");
        // Now, or a link for any time: a length only when one is given.
        const minutes = body.minutes ? clampMinutes(body.minutes) : timed(kind) ? 30 : undefined;
        const invitees = inviteesOf(body.invitees);
        const recurrence = kind === "repeat" ? recurrenceOf(body.repeat) : undefined;
        const password = passcodeOf(body.password);
        const agenda = text(body.agenda, 2000);
        let made;
        try {
          made = await createMeeting(token, {
            topic,
            kind,
            start_time: start,
            timezone: zone,
            minutes,
            agenda: agenda || undefined,
            password,
            recurrence,
            settings: settingsOf(body.options, invitees.length ? invitees : undefined),
          });
        } catch (e) {
          zoomSaid(e);
        }
        const invited = await emailInvites(db, me, row, body, invitees, {
          id: String(made.id),
          topic,
          kind,
          start: start ? Date.parse(start) : undefined,
          minutes: minutes ?? null,
          timezone: zone,
          join_url: made.join_url,
          password: made.password ?? null,
          agenda,
          recurrence: recurrence ?? null,
        }, "new");
        return json({ id: String(made.id), join_url: made.join_url, invited });
      }

      if (body.action === "update") {
        const id = meetingId(body.id);
        let before: ZoomMeetingFull;
        try {
          before = await getMeeting(token, id);
        } catch (e) {
          zoomSaid(e);
        }
        const kind = body.kind === undefined ? undefined : kindIn(body.kind);
        const k = kind ?? kindOf(before.type);
        const start = timed(k) && body.start !== undefined ? startOf(body.start) : undefined;
        const minutes = body.minutes ? clampMinutes(body.minutes) : undefined;
        const topic = body.topic === undefined ? undefined : text(body.topic, 200);
        if (topic === "") throw new HttpError(400, "Give the meeting a title");
        const agenda = body.agenda === undefined ? undefined : text(body.agenda, 2000);
        const invitees = body.invitees === undefined ? undefined : inviteesOf(body.invitees);
        const recurrence = k === "repeat" && body.repeat !== undefined ? recurrenceOf(body.repeat) : undefined;
        const password = passcodeOf(body.password);
        try {
          await updateMeeting(token, id, {
            topic,
            kind,
            start_time: start,
            timezone: zoneOf(body.timezone),
            minutes,
            agenda,
            password,
            recurrence,
            settings: settingsOf(body.options, invitees),
          });
        } catch (e) {
          zoomSaid(e);
        }
        // The WhatsApp bot's copy, when it booked this one.
        await db
          .from("wa_bot_meeting")
          .update({ ...(topic ? { topic } : {}), ...(start ? { start_at: start } : {}), ...(minutes ? { minutes } : {}), updated_at: new Date().toISOString() })
          .eq("zoom_id", id)
          .eq("account", row.id);

        // The invitees hear about it: new ones get the invitation, the rest the
        // change (when something they'd see changed), the ones taken off a cancellation.
        const was = inviteesOn(before);
        const now = invitees ?? was;
        const added = now.filter((e) => !was.includes(e));
        const kept = now.filter((e) => was.includes(e));
        const removed = was.filter((e) => !now.includes(e));
        const changed =
          (start !== undefined && Date.parse(start) !== Date.parse(before.start_time ?? "")) ||
          (minutes !== undefined && minutes !== before.duration) ||
          (topic !== undefined && topic !== before.topic) ||
          (kind !== undefined && kind !== kindOf(before.type)) ||
          recurrence !== undefined ||
          (agenda !== undefined && agenda !== (before.agenda ?? "")) ||
          (password !== undefined && password !== before.password);
        let invited: InviteResult = null;
        if (body.notify !== false && (added.length || removed.length || (changed && kept.length))) {
          const after = await getMeeting(token, id).catch(() => null);
          if (after) {
            const results = [
              await emailInvites(db, me, row, body, added, invitedFrom(after), "new"),
              changed ? await emailInvites(db, me, row, body, kept, invitedFrom(after), "update") : null,
              await emailInvites(db, me, row, body, removed, invitedFrom(before), "cancel"),
            ].filter((r): r is NonNullable<InviteResult> => !!r);
            const failed = results.find((r) => "error" in r);
            invited = failed ?? (results.length ? { sent: results.reduce((n, r) => n + ("sent" in r ? r.sent : 0), 0), from: (results[0] as { from: string }).from } : null);
          }
        }
        return json({ ok: true, invited });
      }

      // delete: the meeting, or one meeting of a series
      const id = meetingId(body.id);
      const occurrence = typeof body.occurrence === "string" && /^\d{6,20}$/.test(body.occurrence) ? body.occurrence : undefined;
      const before = occurrence ? null : await getMeeting(token, id).catch(() => null);
      try {
        await deleteMeeting(token, id, occurrence);
      } catch (e) {
        zoomSaid(e);
      }
      if (!occurrence) await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("zoom_id", id).eq("account", row.id);
      const invitees = inviteesOn(before);
      const invited = before ? await emailInvites(db, me, row, body, invitees, invitedFrom(before), "cancel") : null;
      return json({ ok: true, invited });
    }

    if (body.action === "meeting") {
      const account = await botAccount(db, me.id);
      const token = account ? await accessToken(db, account) : null;
      if (!token) throw new HttpError(409, "Connect your Zoom account first");
      const start = typeof body.start === "string" ? new Date(body.start) : new Date();
      if (Number.isNaN(start.getTime())) throw new HttpError(400, "Bad start time");
      try {
        const m = await createMeeting(token, {
          topic: String(body.topic ?? "Meeting"),
          start_time: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
          timezone: "UTC",
          minutes: Number(body.minutes) || 30,
          agenda: typeof body.agenda === "string" ? body.agenda : undefined,
        });
        return json({ id: m.id, join_url: m.join_url, start_url: m.start_url });
      } catch (e) {
        throw new HttpError(502, `Zoom said no: ${(e as Error).message}`);
      }
    }

    throw new HttpError(400, "Unknown action");
  } catch (e) {
    return toResponse(e);
  }
});
