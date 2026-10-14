// Images, videos and files of a delivery (0062, 0064, 0065).
//
// Visitors have no account, and a delivery's files sit in the private
// 'deliveries' bucket or in a connected Google Drive. This function checks the
// link (token, expiry, device and people limits) through delivery_media, then
// hands out that delivery's files only: short-lived signed storage URLs, and
// for Drive files Google's own preview links (the drive function made them
// "anyone with the link can view", download off), so nothing streams through
// us. Downloads of Drive files (only when the link allows them) go through a
// signed ticket to /stream below. Files other than images and videos only
// when the link allows downloads.
// Deploy with --no-verify-jwt: visitors have no JWT.
//
// POST { token, device, items?: string[] }       ->  { urls: { [item id]: url }, drive: { [item id]: { embed, image, thumb } } }
// POST { token, device, download: item id }      ->  { url }
// POST (team login) { team: true, items }        ->  { urls, drive }   Drive files the caller may see
// POST (team login) { team: true, download: id } ->  { url }
// GET  /stream?t=ticket                          ->  the Drive file's bytes (downloads)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ANON, cors, json, SERVICE_ROLE, serviceClient, SUPABASE_URL } from "../_shared/admin.ts";

const BUCKET = "deliveries";
// Short, so a link that is turned off or expires stops showing files soon after.
const TTL = 900;
const DOWNLOAD_TTL = 120;
const TEAM_TTL = 3600;
const TEAM_DOWNLOAD_TTL = 300;
const UUID = /^[0-9a-f-]{36}$/;
// One Range answer at most this big: the player asks again for the next part.
const CHUNK = 8 * 1024 * 1024;
const DRIVE = "https://www.googleapis.com/drive/v3";

type MediaFile = { id: string; path: string | null; name: string; kind: string; drive: boolean; drive_file_id?: string | null };

/**
 * A Drive file shows in Google's own preview (the file is "anyone with the
 * link can view", download off): nothing passes through us. embed: the page
 * Google plays a video or a document in; image: the picture itself; thumb: a
 * small still for the grid.
 */
function drivePreview(f: MediaFile) {
  const id = encodeURIComponent(f.drive_file_id ?? "");
  return {
    embed: `https://drive.google.com/file/d/${id}/preview`,
    image: `https://drive.google.com/thumbnail?id=${id}&sz=w2400`,
    thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w800`,
  };
}

// --------------------------------------------------------------- tickets --
// "<payload>.<sig>": HMAC of { i: item, e: expiry (ms), d: download }.

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
let keyPromise: Promise<CryptoKey> | null = null;
const hmacKey = () =>
  (keyPromise ??= crypto.subtle.importKey("raw", new TextEncoder().encode(`delivery-media:${SERVICE_ROLE}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]));

interface Ticket {
  i: string;
  e: number;
  d?: 1;
}

async function ticketUrl(item: string, ttl: number, download = false): Promise<string> {
  const t: Ticket = { i: item, e: Date.now() + ttl * 1000, ...(download ? { d: 1 as const } : {}) };
  const body = new TextEncoder().encode(JSON.stringify(t));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), body));
  return `${SUPABASE_URL}/functions/v1/delivery-media/stream?t=${b64url(body)}.${b64url(sig)}`;
}

async function readTicket(v: string | null): Promise<Ticket | null> {
  const [body, sig] = (v ?? "").split(".");
  if (!body || !sig) return null;
  try {
    const bytes = fromB64url(body);
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(), fromB64url(sig), bytes))) return null;
    const t = JSON.parse(new TextDecoder().decode(bytes)) as Ticket;
    return typeof t.i === "string" && UUID.test(t.i) && t.e > Date.now() ? t : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- drive --

interface Account {
  id: string;
  email: string;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
}

// Access tokens kept between requests of the same worker (a video asks many times).
const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(db: SupabaseClient, a: Account, force = false): Promise<string> {
  const cached = tokens.get(a.id);
  if (!force && cached && cached.until > Date.now() + 30_000) return cached.token;
  if (!force && a.access_token && a.token_expiry && Date.parse(a.token_expiry) > Date.now() + 30_000) {
    tokens.set(a.id, { token: a.access_token, until: Date.parse(a.token_expiry) });
    return a.access_token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
    }),
  });
  const t = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!res.ok || !t.access_token) throw new Error("drive token");
  const until = Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000;
  await db
    .from("drive_account")
    .update({
      access_token: t.access_token,
      token_expiry: new Date(until).toISOString(),
      updated_at: new Date().toISOString(),
      ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    })
    .eq("id", a.id)
    .eq("refresh_token", a.refresh_token);
  tokens.set(a.id, { token: t.access_token, until });
  return t.access_token;
}

const ACCOUNT = "id, email, access_token, refresh_token, token_expiry";

/** The Drive account an item was added from (or, if it was connected again, the same email). */
async function accountOf(db: SupabaseClient, item: { drive_account_id: string | null; drive_email: string }): Promise<Account | null> {
  if (item.drive_account_id) {
    const { data } = await db.from("drive_account").select(ACCOUNT).eq("id", item.drive_account_id).maybeSingle();
    if (data) return data as Account;
  }
  const { data } = await db.from("drive_account").select(ACCOUNT).eq("email", item.drive_email).order("updated_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as Account | undefined) ?? null;
}

const plain = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

async function stream(req: Request): Promise<Response> {
  const t = await readTicket(new URL(req.url).searchParams.get("t"));
  if (!t) return plain(403, "This link has expired. Reload the page.");
  const db = serviceClient();
  const { data: item } = await db
    .from("delivery_item")
    .select("id, name, mime_type, drive_file_id, drive_account_id, drive_email")
    .eq("id", t.i)
    .maybeSingle();
  if (!item?.drive_file_id) return plain(404, "Not found");
  const a = await accountOf(db, item);
  if (!a) return plain(410, "The Google Drive this came from isn't connected any more");

  // Pass the player's Range on, a part at a time.
  const headers: Record<string, string> = {};
  const range = req.headers.get("range");
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), start + CHUNK - 1) : start + CHUNK - 1;
    headers.Range = `bytes=${start}-${end}`;
  } else if (range) headers.Range = range;

  const url = `${DRIVE}/files/${encodeURIComponent(item.drive_file_id)}?alt=media&supportsAllDrives=true`;
  let res: Response;
  try {
    const go = async (tok: string) => fetch(url, { headers: { ...headers, Authorization: `Bearer ${tok}` } });
    res = await go(await accessToken(db, a));
    if (res.status === 401) {
      await res.body?.cancel();
      res = await go(await accessToken(db, a, true));
    }
  } catch {
    return plain(502, "Couldn't reach Google Drive");
  }
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 416) return new Response(null, { status: 416, headers: { "content-range": res.headers.get("content-range") ?? "" } });
    console.error("delivery-media drive", res.status);
    return plain(res.status === 404 || res.status === 403 ? 404 : 502, "This file isn't in Google Drive any more");
  }

  const type = item.mime_type || res.headers.get("content-type") || "application/octet-stream";
  // Only pictures and video show in the page; anything else (HTML, SVG) is a download.
  const inline = !t.d && /^(image\/(png|jpe?g|gif|webp|avif|heic|heif)|video\/|audio\/)/i.test(type);
  const out = new Headers({
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=600",
    "x-content-type-options": "nosniff",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
  });
  for (const h of ["content-length", "content-range"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

// ---------------------------------------------------------------- serve --

async function signFiles(db: SupabaseClient, files: MediaFile[], ttl: number): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const stored = files.filter((f) => f.path);
  if (stored.length) {
    const { data: signed, error } = await db.storage.from(BUCKET).createSignedUrls(stored.map((f) => f.path!), ttl);
    if (error) throw error;
    const byPath = new Map(stored.map((f) => [f.path, f.id]));
    for (const s of signed ?? []) {
      const id = s.path ? byPath.get(s.path) : undefined;
      if (id && s.signedUrl) urls[id] = s.signedUrl;
    }
  }
  for (const f of files.filter((x) => x.drive && x.drive_file_id)) {
    const d = drivePreview(f);
    urls[f.id] = f.kind === "image" ? d.image : d.embed;
  }
  return urls;
}

/** For each Drive file: { embed, image, thumb } (see drivePreview). */
function driveMap(files: MediaFile[]) {
  return Object.fromEntries(files.filter((f) => f.drive && f.drive_file_id).map((f) => [f.id, drivePreview(f)]));
}

async function downloadUrl(db: SupabaseClient, f: MediaFile, ttl: number): Promise<string | null> {
  if (f.drive) return ticketUrl(f.id, ttl, true);
  const { data: s, error } = await db.storage.from(BUCKET).createSignedUrl(f.path!, ttl, { download: f.name });
  return error || !s ? null : s.signedUrl;
}

const wantedIds = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && UUID.test(x)))].slice(0, 500) : null;

/** Team members: the items they may see (row security decides), by their own login. */
async function team(req: Request, body: { items?: unknown; download?: unknown }): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Sign in first" }, { status: 401 });
  const user = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const ids = typeof body.download === "string" && UUID.test(body.download) ? [body.download] : wantedIds(body.items) ?? [];
  if (!ids.length) return json({ urls: {} });
  const { data, error } = await user.from("delivery_item").select("id, name, kind, storage_path, drive_file_id").in("id", ids);
  if (error) return json({ error: "Your session ended. Sign in again." }, { status: 401 });
  const files: MediaFile[] = (data ?? []).map((r) => ({ id: r.id, path: r.storage_path, name: r.name, kind: r.kind, drive: Boolean(r.drive_file_id), drive_file_id: r.drive_file_id }));
  const db = serviceClient();
  if (typeof body.download === "string") {
    const f = files[0];
    const url = f && (f.path || f.drive) ? await downloadUrl(db, f, TEAM_DOWNLOAD_TTL) : null;
    return url ? json({ url }) : json({ error: "Couldn't get the file" }, { status: 404 });
  }
  const shown = files.filter((f) => f.drive);
  return json({ urls: await signFiles(db, shown, TEAM_TTL), drive: driveMap(shown) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/stream")) return stream(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  let body: { token?: unknown; device?: unknown; items?: unknown; download?: unknown; team?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, { status: 400 });
  }
  if (body.team === true) return team(req, body);
  const token = typeof body.token === "string" ? body.token : "";
  const device = typeof body.device === "string" ? body.device : "";

  const db = serviceClient();
  const { data, error } = await db.rpc("delivery_media", { p_token: token, p_device: device });
  // The link's own message (expired, turned off, limits) is safe to show.
  if (error || !data) return json({ error: error?.message ?? "This link is not valid" }, { status: 403 });
  const media = data as { allow_download: boolean; files: MediaFile[] };

  if (typeof body.download === "string") {
    if (!media.allow_download) return json({ error: "Downloads are off for this link" }, { status: 403 });
    const f = media.files.find((x) => x.id === body.download);
    if (!f) return json({ error: "That file is not in this delivery" }, { status: 404 });
    const url = await downloadUrl(db, f, DOWNLOAD_TTL);
    return url ? json({ url }) : json({ error: "Couldn't get the file" }, { status: 500 });
  }

  const wanted = wantedIds(body.items);
  const set = wanted ? new Set(wanted) : null;
  // Images and videos play in the page; other files only when downloads are on.
  const mine = media.files.filter((f) => (!set || set.has(f.id)) && (media.allow_download || f.kind !== "file"));
  if (!mine.length) return json({ urls: {} });
  try {
    return json({ urls: await signFiles(db, mine, TTL), drive: driveMap(mine) });
  } catch {
    return json({ error: "Couldn't load the files" }, { status: 500 });
  }
});
