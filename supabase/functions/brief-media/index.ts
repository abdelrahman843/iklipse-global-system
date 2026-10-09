// Moodboard images for a brief link (0050).
//
// Visitors have no account, and the images sit in the private 'brief'
// bucket. This function checks the link through brief_media_link (the token,
// that this is the device that opened it, and that the answers aren't sent
// yet), then stores, shows or removes that link's images only.
// Deploy with --no-verify-jwt: visitors have no JWT.
//
// POST multipart { token, device, file }               -> { path, url }
// POST json { action: "sign", token, device, paths }    -> { urls: { [path]: url } }
// POST json { action: "delete", token, device, path }   -> { ok: true }

import { cors, json, serviceClient } from "../_shared/admin.ts";

const BUCKET = "brief";
const TTL = 6 * 3600;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 12;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const db = serviceClient();
  const linkOf = async (token: unknown, device: unknown) => {
    const { data, error } = await db.rpc("brief_media_link", {
      p_token: typeof token === "string" ? token : "",
      p_device: typeof device === "string" ? device : "",
    });
    // The link's own message (sent already, another device) is safe to show.
    if (error || !data) throw new Response(JSON.stringify({ error: error?.message ?? "This link is not valid" }), { status: 403 });
    return data as string;
  };

  try {
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      if (!form) return json({ error: "Bad request" }, { status: 400 });
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "Choose an image to upload" }, { status: 400 });
      const ext = TYPES[file.type];
      if (!ext) return json({ error: "Images only: PNG, JPG, GIF or WebP" }, { status: 400 });
      if (file.size > MAX_BYTES) return json({ error: "That image is over 10 MB. Try a smaller one." }, { status: 400 });

      const linkId = await linkOf(form.get("token"), form.get("device"));
      const { data: existing } = await db.storage.from(BUCKET).list(linkId, { limit: 100 });
      if ((existing?.length ?? 0) >= MAX_FILES) return json({ error: `Up to ${MAX_FILES} images` }, { status: 400 });

      const path = `${linkId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) return json({ error: "Couldn't save the image. Try again." }, { status: 500 });
      const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(path, TTL);
      return json({ path, url: signed?.signedUrl ?? "" });
    }

    const body = await req.json().catch(() => null) as { action?: unknown; token?: unknown; device?: unknown; paths?: unknown; path?: unknown } | null;
    if (!body) return json({ error: "Bad request" }, { status: 400 });
    const linkId = await linkOf(body.token, body.device);

    if (body.action === "sign") {
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string").slice(0, 50) : [];
      const mine = [...new Set(paths)].filter((p) => PATH.test(p) && p.startsWith(`${linkId}/`));
      if (!mine.length) return json({ urls: {} });
      const { data, error } = await db.storage.from(BUCKET).createSignedUrls(mine, TTL);
      if (error) return json({ error: "Couldn't load the images" }, { status: 500 });
      const urls: Record<string, string> = {};
      for (const d of data ?? []) if (d.path && d.signedUrl) urls[d.path] = d.signedUrl;
      return json({ urls });
    }

    if (body.action === "delete") {
      const p = typeof body.path === "string" ? body.path : "";
      if (!PATH.test(p) || !p.startsWith(`${linkId}/`)) return json({ error: "Not found" }, { status: 404 });
      await db.storage.from(BUCKET).remove([p]);
      return json({ ok: true });
    }

    return json({ error: "Bad request" }, { status: 400 });
  } catch (e) {
    if (e instanceof Response) return new Response(e.body, { status: e.status, headers: { "content-type": "application/json", ...cors } });
    console.error("brief-media", (e as Error).message);
    return json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
});
