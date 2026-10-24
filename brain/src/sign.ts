// Requests between the whatsapp-bot function and the brain are signed both
// ways with BRAIN_SECRET: HMAC-SHA256 over the direction, the time and the
// body, five minutes at most (the same as whatsapp-bot brain.ts). A request
// signed for one direction is refused in the other.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** to-brain: the function to the brain; to-bot: the brain to the function. */
export type Dir = "to-brain" | "to-bot";

const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

/** The x-brain-signature header: "t=<seconds>,v1=<hex>". */
export function signature(secret: string, dir: Dir, body: string, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${hmac(secret, `${dir}.${t}.${body}`)}`;
}

export function signedBy(secret: string, dir: Dir, body: string, header: string | null | undefined, now = Date.now()) {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || secret.length < 32) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > 300) return false;
  const want = Buffer.from(hmac(secret, `${dir}.${m[1]}.${body}`), "hex");
  const got = Buffer.from(m[2]!, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** JSON with its keys sorted: the same input is the same text (an OK's input_hash, as the function makes it). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
