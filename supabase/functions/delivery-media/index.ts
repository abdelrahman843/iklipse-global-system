// Images, videos and files of a delivery (0062, 0064, 0065).
//
// Visitors have no account, and a delivery's files sit in the private
// 'deliveries' bucket or in a connected Google Drive. This function checks the
// link (token, expiry, device and people limits) through delivery_media, then
// hands out that delivery's files only: short-lived signed storage URLs, and
// for Drive files Google's own links to the file (the drive function made them
// "anyone with the link can view"). The page plays those in its own player, so
// the client never sees Google Drive, and nothing streams through us.
// Uploaded files other than images and videos only when the link allows
// downloads; Drive files that aren't pictures or videos likewise.
// Deploy with --no-verify-jwt: visitors have no JWT.
//
// POST { token, device, items?: string[] }       ->  { urls: { [item id]: url }, drive: { [item id]: { media, image, thumb } } }
// POST { token, device, download: item id }      ->  { url }
// POST (team login) { team: true, items }        ->  { urls, drive }   Drive files the caller may see (with embed)
// POST (team login) { team: true, download: id } ->  { url }

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ANON, cors, json, serviceClient, SUPABASE_URL } from "../_shared/admin.ts";

const BUCKET = "deliveries";
// Short, so a link that is turned off or expires stops showing files soon after.
const TTL = 900;
const DOWNLOAD_TTL = 120;
const TEAM_TTL = 3600;
const TEAM_DOWNLOAD_TTL = 300;
const UUID = /^[0-9a-f-]{36}$/;

type MediaFile = { id: string; path: string | null; name: string; kind: string; drive: boolean; drive_file_id?: string | null };

// Google's file-download address refuses requests from a player on another
// site (it only serves opening the link itself), so the player reads the file
// through the Drive API with a public API key: a key limited to the Drive API
// and to this site's address, kept in the GOOGLE_API_KEY secret.
const API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";

/** The file itself, as a download (opening it in the browser). */
const driveDownload = (id: string) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

/**
 * A Drive file, read straight from Google by the browser. media: the file
 * itself, for our player; image: a picture at full size; thumb: a small still
 * for the grid (a frame for videos); embed (team only): Google's own preview,
 * for documents.
 */
function drivePreview(f: MediaFile, team = false) {
  const id = encodeURIComponent(f.drive_file_id ?? "");
  return {
    media: API_KEY ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(API_KEY)}` : driveDownload(id),
    image: `https://drive.google.com/thumbnail?id=${id}&sz=w2400`,
    thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w800`,
    ...(team ? { embed: `https://drive.google.com/file/d/${id}/preview` } : {}),
  };
}

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
    urls[f.id] = f.kind === "image" ? d.image : d.media;
  }
  return urls;
}

/** For each Drive file: { media, image, thumb } (see drivePreview). */
function driveMap(files: MediaFile[], team = false) {
  return Object.fromEntries(files.filter((f) => f.drive && f.drive_file_id).map((f) => [f.id, drivePreview(f, team)]));
}

async function downloadUrl(db: SupabaseClient, f: MediaFile, ttl: number): Promise<string | null> {
  if (f.drive) return f.drive_file_id ? driveDownload(encodeURIComponent(f.drive_file_id)) : null;
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
  return json({ urls: await signFiles(db, shown, TEAM_TTL), drive: driveMap(shown, true) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
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
