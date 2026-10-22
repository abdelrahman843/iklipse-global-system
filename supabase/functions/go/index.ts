// go — the short links the bot sends (0105). GET /go/<code> sends the browser
// on to the long address it stands for: a Calendly link with a time and
// someone's details filled in. whatsapp-bot makes them (short_link).
//
// Deploy with --no-verify-jwt: whoever has the link opens it.

import { serviceClient } from "../_shared/oauth.ts";

const gone = () => new Response("This link isn't valid any more. Ask iklipse for a new one.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const code = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[0-9A-Za-z]{4,16}$/.test(code)) return gone();
  const db = serviceClient();
  const { data } = await db.from("short_link").select("url, hits").eq("code", code).maybeSingle();
  // Only ever on to Calendly.
  if (!data || !/^https:\/\/calendly\.com\//.test(data.url as string)) return gone();
  if (req.method === "GET") {
    await db.from("short_link").update({ hits: ((data.hits as number) ?? 0) + 1, last_hit_at: new Date().toISOString() }).eq("code", code);
  }
  return new Response(null, { status: 302, headers: { Location: data.url as string, "Cache-Control": "no-store" } });
});
