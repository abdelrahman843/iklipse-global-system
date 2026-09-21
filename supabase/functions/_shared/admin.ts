// Shared helpers for admin-only Edge Functions.
// Each function must:
//   1) validate the caller is an authenticated admin (using the caller's JWT).
//   2) perform privileged operations with the service role client.
//   3) never leak service-role keys or errors verbatim.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...cors, ...(init.headers ?? {}) },
  });
}

export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Verify the request is authenticated AND the caller is admin. Returns the caller user id. */
export async function requireAdmin(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "Missing bearer token");
  const jwt = auth.slice(7);

  // Use anon key + caller JWT so we can call is_admin() as them.
  const asCaller = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userRes, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userRes?.user) throw new HttpError(401, "Invalid session");

  const { data: adminRes, error: adminErr } = await asCaller.rpc("is_admin");
  if (adminErr) throw new HttpError(500, "Authorization check failed");
  if (!adminRes) throw new HttpError(403, "Admin only");

  return userRes.user.id;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function toResponse(err: unknown) {
  if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
  console.error(err);
  return json({ error: "Internal error" }, { status: 500 });
}

export function localEmail(username: string) {
  // Members sign in with a username. We store a stable synthetic email so Supabase Auth
  // (which requires an email) has something to key on. Never shown to the user.
  return `${username.toLowerCase().trim()}@iklipse.local`;
}
