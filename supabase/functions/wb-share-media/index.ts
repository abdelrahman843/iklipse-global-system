// Images and videos on a Miro board shared by link (0045).
//
// Visitors have no account, and the board's files sit in the private
// 'whiteboard' bucket. This function checks the link (token, expiry, device
// limit) through wb_share_board, then signs URLs for the requested files of
// that board only. Deploy with --no-verify-jwt: visitors have no JWT.
//
// POST { token, device, paths: string[] }  ->  { urls: { [path]: url } }

import { cors, json, serviceClient } from "../_shared/admin.ts";

const BUCKET = "whiteboard";
const TTL = 6 * 3600;
const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|gif|webp|mp4|webm|mov)$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  let body: { token?: unknown; device?: unknown; paths?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const device = typeof body.device === "string" ? body.device : "";
  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string").slice(0, 500) : [];

  const db = serviceClient();
  const { data: boardId, error } = await db.rpc("wb_share_board", { p_token: token, p_device: device });
  // The link's own message (expired, turned off, device limit) is safe to show.
  if (error || !boardId) return json({ error: error?.message ?? "This link is not valid" }, { status: 403 });

  // Only files that belong to this board.
  const mine = [...new Set(paths)].filter((p) => PATH.test(p) && p.startsWith(`${boardId}/`));
  if (!mine.length) return json({ urls: {} });
  const { data, error: signErr } = await db.storage.from(BUCKET).createSignedUrls(mine, TTL);
  if (signErr) return json({ error: "Couldn't load the files" }, { status: 500 });
  const urls: Record<string, string> = {};
  for (const d of data ?? []) if (d.path && d.signedUrl) urls[d.path] = d.signedUrl;
  return json({ urls });
});
