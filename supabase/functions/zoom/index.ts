// zoom — each person connects their own Zoom account (0052), exactly like the
// iklipse-system app: a user-managed OAuth app (authorization code), scopes
// set on the Zoom app itself (meeting:write:meeting, user:read:user), one
// account per person, refreshed when it expires.
//
// POST { action: "connect", returnTo }  (login token) -> { url }
// GET  /zoom/callback?code&state       (Zoom sends the browser here)
// POST { action: "disconnect" }        (login token) -> { ok }
// POST { action: "meeting", topic, start, minutes, agenda? } (login token)
//                                      -> { join_url, start_url, id }
//
// Secrets: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (the Zoom app's), optional
// ZOOM_REDIRECT_URI (default <project>/functions/v1/zoom/callback, which must
// be on the Zoom app's redirect allow list). Deploy with --no-verify-jwt.

import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CLIENT_ID = Deno.env.get("ZOOM_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("ZOOM_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("ZOOM_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/zoom/callback`;
const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
const basic = () => `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;

interface ZoomTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

async function tokenCall(body: Record<string, string>): Promise<ZoomTokens> {
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`zoom token: ${data.reason ?? data.error ?? res.status}`);
  return data as ZoomTokens;
}

const expiry = (t: ZoomTokens) => new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString();

/** A working access token for this person, refreshed if needed (null = reconnect). */
async function accessToken(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data: row } = await db.from("zoom_account").select("*").eq("user_id", userId).maybeSingle();
  if (!row) return null;
  if (row.access_token && row.token_expiry && Date.parse(row.token_expiry) > Date.now() + 30_000) return row.access_token;
  let t: ZoomTokens;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  } catch (e) {
    // The refresh token is dead (revoked, or used by a parallel refresh).
    if (/invalid_grant|invalid token|Invalid Token/i.test((e as Error).message)) {
      const { data: again } = await db.from("zoom_account").select("access_token, token_expiry, refresh_token").eq("user_id", userId).maybeSingle();
      // Someone else refreshed meanwhile: use theirs.
      if (again && again.refresh_token !== row.refresh_token && again.access_token) return again.access_token;
      await db.from("zoom_account").delete().eq("user_id", userId).eq("refresh_token", row.refresh_token);
    }
    return null;
  }
  // Zoom rotates the refresh token: only the first of two parallel refreshes may write.
  const { data: won } = await db
    .from("zoom_account")
    .update({ access_token: t.access_token, refresh_token: t.refresh_token, token_expiry: expiry(t), scope: t.scope ?? row.scope, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("refresh_token", row.refresh_token)
    .select("access_token")
    .maybeSingle();
  if (won) return t.access_token;
  const { data: again } = await db.from("zoom_account").select("access_token").eq("user_id", userId).maybeSingle();
  return again?.access_token ?? null;
}

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = await readState(url.searchParams.get("state"));
  const back = state?.r ?? safeReturn(null);
  if (url.searchParams.get("error")) return backToApp(back, "zoom", "denied");
  const code = url.searchParams.get("code");
  if (!state || !code) return backToApp(back, "zoom", "error");
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    let email: string | null = null;
    let zoomId: string | null = null;
    try {
      const me = await fetch("https://api.zoom.us/v2/users/me", { headers: { Authorization: `Bearer ${t.access_token}` } });
      if (me.ok) {
        const u = await me.json();
        email = u.email ?? null;
        zoomId = u.id ?? null;
      }
    } catch {
      /* best effort */
    }
    const db = serviceClient();
    const { error } = await db.from("zoom_account").upsert(
      {
        user_id: state.u,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        token_expiry: expiry(t),
        scope: t.scope ?? null,
        zoom_email: email,
        zoom_user_id: zoomId,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    return backToApp(back, "zoom", "connected");
  } catch (e) {
    console.error("zoom callback", (e as Error).message);
    return backToApp(back, "zoom", "error");
  }
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
      const { data: row } = await db.from("zoom_account").select("access_token").eq("user_id", me.id).maybeSingle();
      // Tell Zoom too, so the app no longer has access (best effort).
      if (row?.access_token && configured()) {
        await fetch(`https://zoom.us/oauth/revoke?token=${encodeURIComponent(row.access_token)}`, {
          method: "POST",
          headers: { Authorization: basic() },
        }).catch(() => undefined);
      }
      await db.from("zoom_account").delete().eq("user_id", me.id);
      return json({ ok: true });
    }

    if (body.action === "meeting") {
      const token = await accessToken(db, me.id);
      if (!token) throw new HttpError(409, "Connect your Zoom account first");
      const start = typeof body.start === "string" ? new Date(body.start) : new Date();
      if (Number.isNaN(start.getTime())) throw new HttpError(400, "Bad start time");
      const minutes = Math.max(1, Math.min(24 * 60, Math.round(Number(body.minutes) || 30)));
      const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: String(body.topic ?? "Meeting").slice(0, 200),
          type: 2,
          start_time: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
          duration: minutes,
          timezone: "UTC",
          agenda: typeof body.agenda === "string" ? body.agenda.slice(0, 2000) : undefined,
          settings: { join_before_host: true, waiting_room: false, approval_type: 2 },
        }),
      });
      const m = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(502, `Zoom said no: ${m.message ?? res.status}`);
      return json({ id: m.id, join_url: m.join_url, start_url: m.start_url });
    }

    throw new HttpError(400, "Unknown action");
  } catch (e) {
    return toResponse(e);
  }
});
