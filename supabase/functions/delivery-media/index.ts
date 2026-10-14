// Images, videos and files of a delivery opened by link (0062).
//
// Visitors have no account, and a delivery's files sit in the private
// 'deliveries' bucket. This function checks the link (token, expiry, device
// and people limits) through delivery_media, then signs short-lived URLs for
// that delivery's files only. Files other than images and videos, and
// downloads, only when the link allows downloads.
// Deploy with --no-verify-jwt: visitors have no JWT.
//
// POST { token, device, items?: string[] }  ->  { urls: { [item id]: url } }
// POST { token, device, download: item id }  ->  { url }

import { cors, json, serviceClient } from "../_shared/admin.ts";

const BUCKET = "deliveries";
// Short, so a link that is turned off or expires stops showing files soon after.
const TTL = 900;
const DOWNLOAD_TTL = 120;
const UUID = /^[0-9a-f-]{36}$/;

type MediaFile = { id: string; path: string; name: string; kind: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  let body: { token?: unknown; device?: unknown; items?: unknown; download?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, { status: 400 });
  }
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
    const { data: s, error: e } = await db.storage.from(BUCKET).createSignedUrl(f.path, DOWNLOAD_TTL, { download: f.name });
    if (e || !s) return json({ error: "Couldn't get the file" }, { status: 500 });
    return json({ url: s.signedUrl });
  }

  const wanted = Array.isArray(body.items)
    ? new Set(body.items.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 500))
    : null;
  // Images and videos play in the page; other files only when downloads are on.
  const mine = media.files.filter((f) => (!wanted || wanted.has(f.id)) && (media.allow_download || f.kind !== "file"));
  if (!mine.length) return json({ urls: {} });
  const { data: signed, error: signErr } = await db.storage.from(BUCKET).createSignedUrls(mine.map((f) => f.path), TTL);
  if (signErr) return json({ error: "Couldn't load the files" }, { status: 500 });
  const byPath = new Map(mine.map((f) => [f.path, f.id]));
  const urls: Record<string, string> = {};
  for (const s of signed ?? []) {
    const id = s.path ? byPath.get(s.path) : undefined;
    if (id && s.signedUrl) urls[id] = s.signedUrl;
  }
  return json({ urls });
});
