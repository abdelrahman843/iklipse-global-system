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
// POST { action: "meeting", topic, start, minutes, agenda? } (login token, on the bot's account)
//                                      -> { join_url, start_url, id }
//
// The token and the meetings themselves: _shared/zoom.ts (whatsapp-bot books too).
// Secrets: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (the Zoom app's), optional
// ZOOM_REDIRECT_URI (default <project>/functions/v1/zoom/callback, which must
// be on the Zoom app's redirect allow list). Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";
import { accessToken, basic, botAccount, CLIENT_ID, configured, createMeeting, expiry, tokenCall, upcomingMeetings } from "../_shared/zoom.ts";

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

/** One of this person's accounts, or a 404. */
async function mine(db: SupabaseClient, userId: string, account: unknown) {
  const id = typeof account === "string" && /^[0-9a-f-]{36}$/.test(account) ? account : "";
  const { data } = id ? await db.from("zoom_account").select("id, access_token, for_bot").eq("id", id).eq("user_id", userId).maybeSingle() : { data: null };
  if (!data) throw new HttpError(404, "That Zoom account isn't connected");
  return data as { id: string; access_token: string | null; for_bot: boolean };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET" && route(req) === "callback") return callback(req);
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
