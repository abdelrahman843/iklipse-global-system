// Shared pieces of the Zoom and Gmail connections (functions zoom / gmail).
//
// The connect flow, as in the iklipse-system app:
//   1. the app POSTs { action: "connect", returnTo } with the person's login
//      token; the function answers { url } (the provider's consent page)
//   2. the provider sends the browser to <function>/callback?code&state
//   3. the callback checks the signed state, swaps the code for tokens, keeps
//      them (service role only) and sends the browser back to returnTo with
//      ?zoom=connected (or ?gmail=...).
// The callback is a plain browser visit with no login token, so the person is
// taken from the signed state (HMAC, 10 minutes). Deploy with --no-verify-jwt.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function toResponse(e: unknown) {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: "Something went wrong. Try again." }, 500);
}

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ------------------------------------------------------------------ caller --

function jwtClaims(jwt: string): { iat?: number } {
  try {
    const p = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch {
    return {};
  }
}

/** The signed-in, active person calling (same rules as the app's own login checks). */
export async function caller(req: Request, db: SupabaseClient): Promise<{ id: string; name: string }> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "Sign in first");
  const jwt = auth.slice(7);
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "Your session ended. Sign in again.");
  const { data: p } = await db
    .from("profile")
    .select("id, display_name, is_active, sessions_revoked_at")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!p || !p.is_active) throw new HttpError(403, "This account is turned off");
  // Signed out everywhere by an admin after this login was made.
  const iat = jwtClaims(jwt).iat;
  if (p.sessions_revoked_at && iat && Date.parse(p.sessions_revoked_at) / 1000 > iat) {
    throw new HttpError(401, "Your session ended. Sign in again.");
  }
  return { id: p.id, name: p.display_name ?? "" };
}

// -------------------------------------------------------------- the state --

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

let keyPromise: Promise<CryptoKey> | null = null;
function hmacKey() {
  keyPromise ??= crypto.subtle.importKey("raw", new TextEncoder().encode(`oauth-state:${SERVICE_ROLE}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  return keyPromise;
}

interface State {
  /** person */
  u: string;
  /** where to send the browser back */
  r: string;
  /** issued at (ms) */
  t: number;
}

export async function signState(userId: string, returnTo: string): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify({ u: userId, r: returnTo, t: Date.now() } satisfies State));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), body));
  return `${b64url(body)}.${b64url(sig)}`;
}

/** The person and return address from a state, or null if forged / older than 10 minutes. */
export async function readState(state: string | null): Promise<State | null> {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  try {
    const bytes = fromB64url(body);
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), fromB64url(sig), bytes);
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(bytes)) as State;
    if (!s.u || !s.r || Date.now() - s.t > 10 * 60_000) return null;
    return s;
  } catch {
    return null;
  }
}

// --------------------------------------------------------- back to the app --

const DEFAULT_ORIGINS = ["https://abdelrahman843.github.io", "http://localhost:5173", "http://localhost:4174", "http://127.0.0.1:5173"];
const allowedOrigins = () => [
  ...DEFAULT_ORIGINS,
  ...(Deno.env.get("APP_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
];
const DEFAULT_RETURN = "https://abdelrahman843.github.io/iklipse-global-system/#/connections";

/** Only addresses of the app itself (no open redirect). */
export function safeReturn(returnTo: unknown): string {
  if (typeof returnTo !== "string") return DEFAULT_RETURN;
  try {
    const u = new URL(returnTo);
    return allowedOrigins().includes(u.origin) ? u.href : DEFAULT_RETURN;
  } catch {
    return DEFAULT_RETURN;
  }
}

/** Back to the app's page (a HashRouter address), with ?<key>=<value> added to its route. */
export function backToApp(returnTo: string, key: string, value: string): Response {
  const u = new URL(safeReturn(returnTo));
  const hash = u.hash || "#/connections";
  const [route, query = ""] = hash.slice(1).split("?");
  const q = new URLSearchParams(query);
  q.set(key, value);
  u.hash = `${route}?${q}`;
  return new Response(null, { status: 302, headers: { location: u.href, "cache-control": "no-store" } });
}

/** Constant-time compare, so a shared secret can't be guessed byte by byte. */
export function same(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Last part of the path: /zoom/callback -> "callback", /zoom -> "zoom". */
export const route = (req: Request) => new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
