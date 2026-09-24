import { supabase } from "@/lib/supabase";
import type { Attachment } from "@/lib/database.types";

const BUCKET = "attachments";
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB per file — matches Supabase's free-tier soft cap.

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

/** Upload a file to storage AND insert its `attachment` row. Returns the row. */
export async function uploadCardAttachment(cardId: string, file: File): Promise<Attachment> {
  if (file.size > MAX_SIZE) {
    throw new Error(`File is too large (max ${Math.floor(MAX_SIZE / 1024 / 1024)} MB).`);
  }
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in.");

  const safe = sanitize(file.name || "file");
  const path = `${cardId}/${crypto.randomUUID()}_${safe}`;

  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600",
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (upErr) throw upErr;

  const { data: inserted, error: insErr } = await supabase
    .from("attachment")
    .insert({
      card_id: cardId,
      name: file.name,
      mime_type: file.type || null,
      size: file.size,
      storage_path: path,
      uploaded_by: uid,
    })
    .select("*")
    .single();
  if (insErr) {
    // Best-effort cleanup so we don't orphan the object.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    throw insErr;
  }
  return inserted as Attachment;
}

/** Attach a link (Drive, Figma, any URL) — a row with external_url, no storage object. */
export async function addLinkAttachment(cardId: string, url: string, name?: string): Promise<void> {
  let href = url.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  const parsed = new URL(href); // throws on garbage — surfaced to the caller as an error
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error("Not signed in.");
  const { error } = await supabase.from("attachment").insert({
    card_id: cardId,
    name: name?.trim() || parsed.host.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, ""),
    external_url: href,
    uploaded_by: uid,
  });
  if (error) throw error;
}

/** Delete both the storage object and the row. RLS decides who can. */
export async function deleteAttachment(a: Attachment) {
  if (a.storage_path) {
    // Ignore storage errors — the row delete matters more; RLS may reject
    // storage delete for a non-owner admin.
    await supabase.storage.from(BUCKET).remove([a.storage_path]).catch(() => {});
  }
  const { error } = await supabase.from("attachment").delete().eq("id", a.id);
  if (error) throw error;
}

/**
 * Get a short-lived signed URL for downloading a private storage object.
 * Returns null if the path is missing (external-link-only attachments).
 */
export async function signedUrlFor(a: Attachment, expiresIn = 60): Promise<string | null> {
  if (!a.storage_path) return a.external_url ?? null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(a.storage_path, expiresIn);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
