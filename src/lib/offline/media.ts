import { isOnline } from "./net";
import { queuedUpload } from "./outbox";

// Pictures with no network: a file still waiting to upload is shown straight
// from the device; one seen before comes from the service worker's copy
// (public/sw.js keeps stored pictures by path, whatever the link's token).

const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");

/** A link for a stored file when the server can't sign one (offline), or null. */
export async function deviceMediaUrl(bucket: string, path: string): Promise<string | null> {
  const blob = await queuedUpload(bucket, path);
  if (blob) return URL.createObjectURL(blob);
  if (!isOnline() && base) {
    const p = path.split("/").map(encodeURIComponent).join("/");
    return `${base}/storage/v1/object/sign/${bucket}/${p}?token=offline`;
  }
  return null;
}
