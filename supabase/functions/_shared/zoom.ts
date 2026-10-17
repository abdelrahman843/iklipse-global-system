// Zoom for the edge functions: each person's own accounts (0052; more than
// one since 0079, one of them the WhatsApp bot's), a token refreshed when it
// runs out, and meetings listed, made, moved and cancelled on them. Used by the zoom
// function (connecting, meetings from the app) and whatsapp-bot (meetings an
// admin asks for in a WhatsApp group, 0079).
//
// Secrets: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (the Zoom app's).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const CLIENT_ID = Deno.env.get("ZOOM_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("ZOOM_CLIENT_SECRET") ?? "";
export const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
export const basic = () => `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;

export interface ZoomTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

export async function tokenCall(body: Record<string, string>): Promise<ZoomTokens> {
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`zoom token: ${data.reason ?? data.error ?? res.status}`);
  return data as ZoomTokens;
}

export const expiry = (t: ZoomTokens) => new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString();

/** The account the WhatsApp bot books on for this person: the one they picked, else their first. */
export async function botAccount(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from("zoom_account").select("id").eq("user_id", userId).order("for_bot", { ascending: false }).order("connected_at").limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

/** A working access token for this account, refreshed if needed (null = reconnect). */
export async function accessToken(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data: row } = await db.from("zoom_account").select("*").eq("id", accountId).maybeSingle();
  if (!row) return null;
  if (row.access_token && row.token_expiry && Date.parse(row.token_expiry) > Date.now() + 30_000) return row.access_token;
  let t: ZoomTokens;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  } catch (e) {
    // The refresh token is dead (revoked, or used by a parallel refresh).
    if (/invalid_grant|invalid token|Invalid Token/i.test((e as Error).message)) {
      const { data: again } = await db.from("zoom_account").select("access_token, token_expiry, refresh_token").eq("id", accountId).maybeSingle();
      // Someone else refreshed meanwhile: use theirs.
      if (again && again.refresh_token !== row.refresh_token && again.access_token) return again.access_token;
      await db.from("zoom_account").delete().eq("id", accountId).eq("refresh_token", row.refresh_token);
    }
    return null;
  }
  // Zoom rotates the refresh token: only the first of two parallel refreshes may write.
  const { data: won } = await db
    .from("zoom_account")
    .update({ access_token: t.access_token, refresh_token: t.refresh_token, token_expiry: expiry(t), scope: t.scope ?? row.scope, updated_at: new Date().toISOString() })
    .eq("id", accountId)
    .eq("refresh_token", row.refresh_token)
    .select("access_token")
    .maybeSingle();
  if (won) return t.access_token;
  const { data: again } = await db.from("zoom_account").select("access_token").eq("id", accountId).maybeSingle();
  return again?.access_token ?? null;
}

export interface ZoomMeeting {
  id: number;
  join_url: string;
  start_url: string;
  password?: string;
  start_time?: string;
}

/**
 * A scheduled meeting on this person's Zoom. start_time is "2026-10-20T15:00:00Z"
 * with timezone "UTC", or a local "2026-10-20T15:00:00" with its timezone.
 * Throws Zoom's own words when it says no.
 */
export async function createMeeting(
  token: string,
  m: { topic: string; start_time: string; timezone: string; minutes: number; agenda?: string },
): Promise<ZoomMeeting> {
  return (await zoomCall(token, "POST", "/users/me/meetings", {
    topic: m.topic.slice(0, 200) || "Meeting",
    type: 2,
    start_time: m.start_time,
    duration: Math.max(1, Math.min(24 * 60, Math.round(m.minutes) || 30)),
    timezone: m.timezone,
    agenda: m.agenda ? m.agenda.slice(0, 2000) : undefined,
    settings: { join_before_host: true, waiting_room: false, approval_type: 2 },
  })) as ZoomMeeting;
}

/** Zoom's answer, or its own words when it says no (204: nothing to read). */
async function zoomCall(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.zoom.us/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(String(j.message ?? `error ${res.status}`)), { status: res.status, code: j.code });
  return j;
}

export interface ZoomListed {
  id: number;
  topic: string;
  start_time?: string;
  duration?: number;
  join_url?: string;
}

/** This person's upcoming meetings (what makes a time busy). */
export async function upcomingMeetings(token: string): Promise<ZoomListed[]> {
  const out: ZoomListed[] = [];
  let next = "";
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ type: "upcoming", page_size: "300", ...(next ? { next_page_token: next } : {}) });
    const j = await zoomCall(token, "GET", `/users/me/meetings?${q}`);
    out.push(...((j.meetings ?? []) as ZoomListed[]));
    next = String(j.next_page_token ?? "");
    if (!next) break;
  }
  return out;
}

/** A new time, length or title for a meeting (the link stays the same). */
export async function updateMeeting(token: string, id: number | string, m: { topic?: string; start_time?: string; timezone?: string; minutes?: number; agenda?: string }) {
  await zoomCall(token, "PATCH", `/meetings/${encodeURIComponent(String(id))}`, {
    ...(m.topic ? { topic: m.topic.slice(0, 200) } : {}),
    ...(m.start_time ? { start_time: m.start_time, timezone: m.timezone ?? "UTC" } : {}),
    ...(m.minutes ? { duration: Math.max(1, Math.min(24 * 60, Math.round(m.minutes))) } : {}),
    ...(m.agenda ? { agenda: m.agenda.slice(0, 2000) } : {}),
  });
}

/** Cancels a meeting. One that's already gone counts as cancelled. */
export async function deleteMeeting(token: string, id: number | string) {
  try {
    await zoomCall(token, "DELETE", `/meetings/${encodeURIComponent(String(id))}?schedule_for_reminder=false`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return;
    throw e;
  }
}
