// push-send — delivers one notification to a person's devices (Web Push).
//
// Called only by the database (public._send_push, through pg_net) with the
// shared secret in X-Iklipse-Secret. Looks up the person's devices that have
// this product (Trello / Miro) switched on, sends to each, and forgets devices
// the push service says are gone (uninstalled, permission revoked).
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_WEBHOOK_SECRET.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const env = (k: string) => Deno.env.get(k) ?? "";
webpush.setVapidDetails(env("VAPID_SUBJECT"), env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

/** Constant-time compare, so the secret can't be guessed byte by byte. */
function same(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!same(req.headers.get("x-iklipse-secret") ?? "", env("PUSH_WEBHOOK_SECRET"))) return new Response("Forbidden", { status: 403 });

  const n = await req.json().catch(() => null) as
    | { user_id: string; product: "trello" | "miro"; title: string; body?: string; url?: string | null; tag?: string }
    | null;
  if (!n?.user_id || !n.title) return new Response("Bad request", { status: 400 });

  const { data: subs, error } = await db
    .from("push_subscription")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", n.user_id)
    .eq(n.product === "miro" ? "miro" : "trello", true);
  if (error) return new Response(error.message, { status: 500 });

  const payload = JSON.stringify({ title: n.title, body: n.body ?? "", url: n.url ?? null, tag: n.tag ?? null, product: n.product });
  const gone: string[] = [];
  const ok: string[] = [];
  await Promise.all(
    (subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24, urgency: "high" });
        ok.push(s.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(s.id);
        else console.error("push failed", code, (e as Error).message);
      }
    }),
  );
  if (gone.length) await db.from("push_subscription").delete().in("id", gone);
  if (ok.length) await db.from("push_subscription").update({ last_sent_at: new Date().toISOString() }).in("id", ok);
  return Response.json({ sent: ok.length, removed: gone.length });
});
