// Firebase Cloud Messaging: Ikli's calls and every notification reach the
// iklipse Android app (android/, 0071) on the phones linked in native_device.
// Used by whatsapp-bot (calls) and push-send (notifications).
//
// Secret: FCM_SERVICE_ACCOUNT_B64 (the Firebase service account JSON, base64).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

type Fcm = { token: string; until: number; project: string };
let fcm: Fcm | null = null;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** A Google access token for Firebase, from the service account (null when it isn't set). */
async function firebase(): Promise<Fcm | null> {
  if (fcm && fcm.until > Date.now()) return fcm;
  const raw = (Deno.env.get("FCM_SERVICE_ACCOUNT_B64") ?? "").trim();
  if (!raw) return null;
  const sa = JSON.parse(new TextDecoder().decode(unb64(raw))) as { client_email: string; private_key: string; project_id: string };
  const now = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", unb64(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !j.access_token) throw new Error(`Firebase sign-in: ${j.error_description ?? j.error ?? res.status}`);
  fcm = { token: j.access_token, until: Date.now() + (Number(j.expires_in ?? 3600) - 300) * 1000, project: sa.project_id };
  return fcm;
}

/** Sends to a person's linked phones (drops the ones Firebase no longer knows). How many got it. */
export async function toPhones(db: SupabaseClient, userId: string, data: Record<string, string>, ttlSec: number) {
  const { data: phones } = await db.from("native_device").select("id, token").eq("user_id", userId);
  if (!phones?.length) return 0;
  let auth: Fcm | null = null;
  try {
    auth = await firebase();
  } catch (e) {
    console.error("firebase", (e as Error).message);
  }
  if (!auth) return 0;
  let sent = 0;
  for (const p of phones) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${auth.project}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token: p.token, data, android: { priority: "HIGH", ttl: `${ttlSec}s` } } }),
    });
    if (res.ok) {
      sent++;
      continue;
    }
    const t = await res.text();
    if (res.status === 404 || /UNREGISTERED|not a valid FCM registration token/i.test(t)) await db.from("native_device").delete().eq("id", p.id);
    else console.error("fcm", res.status, t.slice(0, 200));
  }
  return sent;
}
