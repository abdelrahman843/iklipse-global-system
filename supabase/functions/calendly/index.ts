// calendly — each person connects their own Calendly accounts (0084), in place
// of Zoom: a public OAuth app (authorization code), refreshed when it runs out.
// One of a person's accounts is the one the WhatsApp bot books on (for_bot),
// with the event type it books with. The Calendly page lists the meetings on
// an account, books one for someone at an open time, and cancels.
//
// POST { action: "connect", returnTo }        (login token) -> { url }
// GET  /calendly/callback?code&state          (Calendly sends the browser here)
// POST { action: "disconnect", account }      -> { ok }
// POST { action: "use_for_bot", account }     -> { ok }
// POST { action: "event_types", account }     -> { event_types: [{ uri, name, minutes, url, location }] }
// POST { action: "set_event_type", account, event_type } -> { ok }  (the one the bot books with)
// POST { action: "calendar", account, from, to } (days, YYYY-MM-DD, Cairo)
//                                             -> { meetings: [{ id, name, start, end, minutes, status,
//                                                join_url, location, whatsapp, with }] }
// POST { action: "get", account, id }         -> { meeting: { ..., invitees: [{ name, email, status, answers }] } }
// POST { action: "times", account, event_type, day } -> { times: [ISO] } (open on that Cairo day)
// POST { action: "book", account, event_type, start, name, email, guests?, note? } -> { id, join_url }
// POST { action: "cancel", account, id, reason? } -> { ok }
// POST /calendly/events                       (Calendly's notifications, signed with the app's
//                                             webhook signing key): a meeting the bot booked that
//                                             was cancelled or moved on Calendly is kept up to date.
//
// Booking for someone needs a paid Calendly plan (Standard and up); the
// notifications too. Tokens and meetings: _shared/calendly.ts (whatsapp-bot books too).
// Secrets: CALENDLY_CLIENT_ID, CALENDLY_CLIENT_SECRET, CALENDLY_WEBHOOK_SIGNING_KEY
// (all three from the Calendly app), optional CALENDLY_REDIRECT_URI (default
// <project>/functions/v1/calendly/callback, the app's redirect URI) and
// CALENDLY_SCOPES. Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, same, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";
import {
  accessToken,
  AUTH,
  book,
  botAccount,
  cancelEvent,
  CLIENT_ID,
  configured,
  eventTypes,
  expiry,
  getEvent,
  inviteesOf,
  linkOf,
  me as whoAmI,
  openTimes,
  revoke,
  scheduledEvents,
  SCOPES,
  subscribe,
  tokenCall,
  uuidOf,
  type EventType,
  type ScheduledEvent,
} from "../_shared/calendly.ts";

const REDIRECT_URI = Deno.env.get("CALENDLY_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/calendly/callback`;
const SIGNING_KEY = Deno.env.get("CALENDLY_WEBHOOK_SIGNING_KEY") ?? "";
const EVENTS_URL = `${SUPABASE_URL}/functions/v1/calendly/events`;
const MAX_ACCOUNTS = 10;
const TZ = "Africa/Cairo";
const DAY = 24 * 60 * 60_000;

/** The moment a Cairo day starts. */
function dayStart(day: string) {
  const v =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  return Date.parse(`${day}T00:00:00${v === "GMT" ? "+00:00" : v.replace("GMT", "")}`);
}
const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const emailOk = (e: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(e);

// ------------------------------------------------------------- connecting --

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = await readState(url.searchParams.get("state"));
  const back = state?.r ?? safeReturn(null);
  if (url.searchParams.get("error")) return backToApp(back, "calendly", "denied");
  const code = url.searchParams.get("code");
  if (!state || !code) return backToApp(back, "calendly", "error");
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    const u = await whoAmI(t.access_token);
    const db = serviceClient();
    const { data: mine } = await db.from("calendly_account").select("id, calendly_user, event_type, webhook").eq("user_id", state.u);
    const had = (mine ?? []).find((a) => a.calendly_user === u.uri);
    if (!had && (mine ?? []).length >= MAX_ACCOUNTS) return backToApp(back, "calendly", "too_many");
    // The event type the bot books with: the first one, until they pick another.
    let first: EventType | undefined;
    if (!had?.event_type) first = (await eventTypes(t.access_token, u.uri).catch(() => []))[0];
    // Calendly tells us when a meeting the bot booked is cancelled or moved there.
    const webhook = had?.webhook ?? (SIGNING_KEY ? await subscribe(t.access_token, EVENTS_URL, u.uri, t.organization ?? u.current_organization) : null);
    const now = new Date().toISOString();
    const { error } = await db.from("calendly_account").upsert(
      {
        user_id: state.u,
        calendly_user: u.uri,
        organization: t.organization ?? u.current_organization ?? null,
        email: u.email ?? null,
        name: u.name ?? null,
        scheduling_url: u.scheduling_url ?? null,
        timezone: u.timezone ?? null,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        token_expiry: expiry(t),
        scope: t.scope ?? null,
        webhook,
        ...(first ? { event_type: first.uri, event_type_name: first.name, event_type_minutes: first.duration } : {}),
        // Their first account is the bot's.
        ...(had ? {} : { connected_at: now, for_bot: !(mine ?? []).length }),
        updated_at: now,
      },
      { onConflict: "user_id,calendly_user" },
    );
    if (error) throw error;
    return backToApp(back, "calendly", had ? "again" : "connected");
  } catch (e) {
    const msg = (e as Error).message;
    console.error("calendly callback", msg);
    // Say what's wrong when it's the set-up: the app's keys, its redirect, its scopes.
    const why = /invalid_client|unauthorized_client/i.test(msg)
      ? "bad_keys"
      : /redirect/i.test(msg)
        ? "redirect"
        : /scope|Permission Denied/i.test(msg)
          ? "scopes"
          : "error";
    return backToApp(back, "calendly", why);
  }
}

// ----------------------------------------------------------- notifications --

/** HMAC-SHA256 of the text with the app's webhook signing key, in hex. */
async function signed(text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Calendly's notifications (Calendly-Webhook-Signature: t=..,v1=.., the HMAC
 * of "t.body", at most 3 minutes old). A meeting the bot booked that someone
 * cancelled on Calendly is cancelled here too; one moved there (Calendly's
 * reschedule link: the old one cancelled, a new one made) follows its new time.
 */
async function events(req: Request): Promise<Response> {
  if (!SIGNING_KEY) return json({ error: "CALENDLY_WEBHOOK_SIGNING_KEY isn't set" }, 503);
  const raw = await req.text();
  const parts = Object.fromEntries((req.headers.get("calendly-webhook-signature") ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 180;
  if (!fresh || !same(parts.v1 ?? "", await signed(`${parts.t}.${raw}`))) return json({ error: "Bad signature" }, 401);
  let e: { event?: string; payload?: Record<string, unknown> };
  try {
    e = JSON.parse(raw);
  } catch {
    return json({ error: "Bad body" }, 400);
  }
  const p = e.payload ?? {};
  const ev = (p.scheduled_event ?? {}) as Partial<ScheduledEvent>;
  const id = uuidOf(String(ev.uri ?? p.event ?? ""));
  if (!id) return json({ ok: true });
  const db = serviceClient();
  if (e.event === "invitee.canceled" && !p.rescheduled) {
    await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("zoom_id", id).eq("provider", "calendly");
  }
  if (e.event === "invitee.created" && typeof p.old_invitee === "string") {
    // The old meeting's id is in the old invitee's address (.../scheduled_events/<id>/invitees/<id>).
    const old = /scheduled_events\/([^/]+)\//.exec(p.old_invitee)?.[1];
    if (old && ev.start_time) {
      await db
        .from("wa_bot_meeting")
        .update({ zoom_id: id, start_at: ev.start_time, join_url: ev.location?.join_url ?? null, status: "booked", updated_at: new Date().toISOString() })
        .eq("zoom_id", old)
        .eq("provider", "calendly");
    }
  }
  return json({ ok: true });
}

// --------------------------------------------------------------- the page --

type Row = { id: string; calendly_user: string; for_bot: boolean; event_type: string | null; webhook: string | null; access_token: string | null };

/** One of this person's accounts, or a 404. */
async function mine(db: SupabaseClient, userId: string, account: unknown): Promise<Row> {
  const id = typeof account === "string" && /^[0-9a-f-]{36}$/.test(account) ? account : "";
  const { data } = id
    ? await db.from("calendly_account").select("id, calendly_user, for_bot, event_type, webhook, access_token").eq("id", id).eq("user_id", userId).maybeSingle()
    : { data: null };
  if (!data) throw new HttpError(404, "That Calendly account isn't connected");
  return data as Row;
}

/** The group each of these meetings was booked from, and who it's with (WhatsApp bookings). */
async function fromWhatsApp(db: SupabaseClient, ids: string[]) {
  const out = new Map<string, { group: string; with: string | null }>();
  if (!ids.length) return out;
  const { data } = await db.from("wa_bot_meeting").select("zoom_id, chat_id, invitee_name, invitee_email").eq("provider", "calendly").in("zoom_id", ids);
  const chats = [...new Set((data ?? []).map((r) => r.chat_id as string))];
  const { data: gs } = chats.length ? await db.from("wa_group").select("chat_id, name").in("chat_id", chats) : { data: [] };
  const names = new Map((gs ?? []).map((g) => [g.chat_id as string, (g.name as string | null) ?? "a WhatsApp group"]));
  for (const r of data ?? []) out.set(r.zoom_id as string, { group: names.get(r.chat_id as string) ?? "a WhatsApp group", with: (r.invitee_name as string | null) ?? (r.invitee_email as string | null) });
  return out;
}

const minutesOf = (e: ScheduledEvent) => Math.round((Date.parse(e.end_time) - Date.parse(e.start_time)) / 60_000);
const calendlySaid = (e: unknown) => {
  const msg = (e as Error).message;
  const status = (e as { status?: number }).status ?? 502;
  if (/only available on paid Calendly plans/i.test(msg)) return new HttpError(402, "Booking for someone needs a paid Calendly plan (Standard or higher).");
  return new HttpError(status === 401 ? 409 : status >= 500 ? 502 : status, `Calendly said: ${msg}`);
};

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
      if (!configured()) throw new HttpError(503, "Calendly isn't set up on the server yet (CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET).");
      const state = await signState(me.id, safeReturn(body.returnTo));
      const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state, scope: SCOPES });
      return json({ url: `${AUTH}/oauth/authorize?${q}` });
    }

    const row = await mine(db, me.id, body.account);

    if (body.action === "disconnect") {
      const token = await accessToken(db, row.id).catch(() => null);
      if (token && row.webhook) await fetch(row.webhook, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
      if (token) await revoke(token);
      await db.from("calendly_account").delete().eq("id", row.id);
      // The bot's account went: their next one takes over.
      if (row.for_bot) {
        const next = await botAccount(db, me.id);
        if (next) await db.from("calendly_account").update({ for_bot: true }).eq("id", next);
      }
      return json({ ok: true });
    }

    if (body.action === "use_for_bot") {
      await db.from("calendly_account").update({ for_bot: false }).eq("user_id", me.id).neq("id", row.id);
      await db.from("calendly_account").update({ for_bot: true }).eq("id", row.id);
      return json({ ok: true });
    }

    const token = await accessToken(db, row.id);
    if (!token) throw new HttpError(409, "This Calendly account needs connecting again");

    try {
      if (body.action === "event_types") {
        const types = await eventTypes(token, row.calendly_user);
        return json({
          event_types: types.map((t) => ({ uri: t.uri, name: t.name, minutes: t.duration, url: t.scheduling_url, location: t.locations?.[0]?.kind ?? null })),
        });
      }

      if (body.action === "set_event_type") {
        const t = (await eventTypes(token, row.calendly_user)).find((x) => x.uri === body.event_type);
        if (!t) throw new HttpError(404, "That event type isn't on this Calendly");
        await db.from("calendly_account").update({ event_type: t.uri, event_type_name: t.name, event_type_minutes: t.duration, updated_at: new Date().toISOString() }).eq("id", row.id);
        return json({ ok: true });
      }

      if (body.action === "calendar") {
        if (!isDay(body.from) || !isDay(body.to) || body.to < body.from) throw new HttpError(400, "from and to are days, YYYY-MM-DD");
        const from = dayStart(body.from);
        const to = Math.min(dayStart(body.to) + DAY, from + 120 * DAY);
        const list = await scheduledEvents(token, row.calendly_user, new Date(from).toISOString(), new Date(to).toISOString(), "active");
        const wa = await fromWhatsApp(db, list.map((e) => uuidOf(e.uri)));
        return json({
          meetings: list.map((e) => {
            const id = uuidOf(e.uri);
            return {
              id,
              name: e.name,
              start: e.start_time,
              end: e.end_time,
              minutes: minutesOf(e),
              status: e.status,
              join_url: e.location?.join_url ?? null,
              location: e.location?.type ?? null,
              whatsapp: wa.get(id)?.group ?? null,
              with: wa.get(id)?.with ?? null,
            };
          }),
        });
      }

      if (body.action === "get") {
        const id = str(body.id);
        if (!id) throw new HttpError(400, "Which meeting?");
        const [e, invitees] = await Promise.all([getEvent(token, id), inviteesOf(token, id)]);
        const wa = await fromWhatsApp(db, [id]);
        return json({
          meeting: {
            id,
            name: e.name,
            start: e.start_time,
            end: e.end_time,
            minutes: minutesOf(e),
            status: e.status,
            join_url: e.location?.join_url ?? null,
            location: e.location?.type ?? null,
            place: e.location?.location ?? null,
            password: e.location?.data?.password ?? null,
            whatsapp: wa.get(id)?.group ?? null,
            invitees: invitees.map((i) => ({
              name: i.name,
              email: i.email,
              status: i.status,
              answers: (i.questions_and_answers ?? []).map((q) => ({ question: q.question, answer: q.answer })),
            })),
          },
        });
      }

      if (body.action === "times") {
        if (!isDay(body.day)) throw new HttpError(400, "day is YYYY-MM-DD");
        const from = dayStart(body.day);
        const times = await openTimes(token, str(body.event_type), from, from + DAY);
        return json({ times: times.map((t) => new Date(t).toISOString()) });
      }

      if (body.action === "book") {
        const t = (await eventTypes(token, row.calendly_user)).find((x) => x.uri === body.event_type);
        if (!t) throw new HttpError(404, "That event type isn't on this Calendly");
        const start = Date.parse(str(body.start));
        if (Number.isNaN(start) || start < Date.now()) throw new HttpError(400, "Pick a time that's still ahead");
        const email = str(body.email).toLowerCase();
        if (!emailOk(email)) throw new HttpError(400, "Their email doesn't look right");
        const guests = (Array.isArray(body.guests) ? body.guests : []).map((g) => str(g).toLowerCase()).filter((g) => emailOk(g) && g !== email);
        const b = await book(token, {
          eventType: t,
          start,
          name: str(body.name) || email,
          email,
          guests,
          note: str(body.note) || undefined,
          timezone: TZ,
        });
        const ev = await linkOf(token, b.event, 3).catch(() => null);
        return json({ id: b.event, join_url: ev?.location?.join_url ?? null });
      }

      if (body.action === "cancel") {
        const id = str(body.id);
        if (!id) throw new HttpError(400, "Which meeting?");
        await cancelEvent(token, id, str(body.reason) || undefined);
        await db.from("wa_bot_meeting").update({ status: "deleted", updated_at: new Date().toISOString() }).eq("zoom_id", id).eq("provider", "calendly");
        return json({ ok: true });
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw calendlySaid(e);
    }

    throw new HttpError(400, "Unknown action");
  } catch (e) {
    return toResponse(e);
  }
});
