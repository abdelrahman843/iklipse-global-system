// apps — the iklipse apps (android/, desktop/) come from inside iklipse only (0072).
//
// The builds upload to the private "apps" bucket and record the newest
// version; signed-in team members get a link that works for a few minutes.
//
// POST /apps (login token) { platform }               -> { code, name, url }
// GET  /apps/feed/<platform>/<file> (login token)     -> redirect to the file (the Windows app's updates)
// POST /apps/upload  X-Upload-Secret { path }         -> { url }  where the build PUTs a file
// POST /apps/release X-Upload-Secret { platform, code, name, file }
// POST /apps/file    X-Upload-Secret { path }         -> { url }  a build's file, to check it
//
// Secret: APPS_UPLOAD_SECRET. Deploy with --no-verify-jwt.

import { caller, cors, HttpError, json, same, serviceClient, toResponse } from "../_shared/oauth.ts";

const BUCKET = "apps";
const UPLOAD_SECRET = Deno.env.get("APPS_UPLOAD_SECRET") ?? "";
const PLATFORMS = ["android", "windows", "mac"];
const FILE = { android: "iklipse.apk", windows: "iklipse-setup.exe", mac: "iklipse.dmg" } as Record<string, string>;
const safePath = (p: string) => /^(android|windows|mac)\/[A-Za-z0-9._ -]{1,120}$/.test(p) && !p.includes("..");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = serviceClient();
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const at = parts.indexOf("apps");
  const [route, ...rest] = parts.slice(at + 1);
  try {
    // The builds.
    if (route === "upload" || route === "release" || route === "file") {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      if (!UPLOAD_SECRET || !same(req.headers.get("x-upload-secret") ?? "", UPLOAD_SECRET)) return new Response("Forbidden", { status: 403 });
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (route === "file") {
        const path = String(b.path ?? "");
        if (!safePath(path)) throw new HttpError(400, "Bad path");
        const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 10 * 60);
        if (error || !data) throw new HttpError(404, "Not found");
        return json({ url: data.signedUrl });
      }
      if (route === "upload") {
        const path = String(b.path ?? "");
        if (!safePath(path)) throw new HttpError(400, "Bad path");
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
        if (error || !data) throw new Error(error?.message ?? "Couldn't make an upload link");
        return json({ url: data.signedUrl });
      }
      const platform = String(b.platform ?? "");
      const file = String(b.file ?? "");
      const code = Number(b.code);
      if (!PLATFORMS.includes(platform) || !safePath(file) || !Number.isInteger(code) || code < 1) throw new HttpError(400, "Bad release");
      const { error } = await db
        .from("app_release")
        .upsert({ platform, code, name: String(b.name ?? code).slice(0, 20), file, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    // The Windows app's updates: its files, for a signed-in person.
    if (route === "feed") {
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
      await caller(req, db);
      const path = rest.join("/");
      if (!safePath(path)) throw new HttpError(404, "Not found");
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 10 * 60);
      if (error || !data) throw new HttpError(404, "Not found");
      return new Response(null, { status: 302, headers: { ...cors, Location: data.signedUrl, "Cache-Control": "no-store" } });
    }

    // Download the app: signed-in team members only.
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    await caller(req, db);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const platform = String(b.platform ?? "");
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, "Which app?");
    const { data: rel } = await db.from("app_release").select("code, name, file").eq("platform", platform).maybeSingle();
    if (!rel) throw new HttpError(404, "This app isn't ready yet");
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(rel.file, 10 * 60, { download: FILE[platform] });
    if (error || !data) throw new Error(error?.message ?? "Couldn't make a link");
    return json({ code: rel.code, name: rel.name, url: data.signedUrl });
  } catch (e) {
    return toResponse(e);
  }
});
