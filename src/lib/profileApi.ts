import { supabase } from "@/lib/supabase";

const BUCKET = "avatars";
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const AVATAR_ACCEPT = Object.keys(EXT).join(",");

/** Why `file` can't be a profile picture, or null when it can. */
export function avatarFileError(file: File): string | null {
  if (!EXT[file.type]) return "Use a PNG, JPEG, WebP or GIF image.";
  if (file.size > MAX_SIZE) return "The picture is too large (max 2 MB).";
  return null;
}

/** Bucket path of a picture this user uploaded, or null for anything else
 *  (a Trello URL, no picture). Only these are ours to delete. */
function ownPath(url: string | null | undefined, userId: string) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i < 0) return null;
  const path = decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
  return path.startsWith(`${userId}/`) ? path : null;
}

async function removeOwnFile(url: string | null | undefined, userId: string) {
  const path = ownPath(url, userId);
  // Best effort: a leftover file only costs a little storage.
  if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}

async function saveAvatarUrl(userId: string, avatarUrl: string | null) {
  const { data, error } = await supabase
    .from("profile")
    .update({ avatar_url: avatarUrl })
    .eq("id", userId)
    .select("id");
  if (error) throw error;
  // RLS filters a disallowed update to zero rows instead of failing it.
  if (!data?.length) throw new Error("Your profile couldn't be updated.");
}

/** Upload a new picture, point the profile at it, then drop the old file.
 *  Returns the new public URL. */
export async function uploadAvatar(userId: string, file: File, previous: string | null | undefined): Promise<string> {
  const invalid = avatarFileError(file);
  if (invalid) throw new Error(invalid);

  // The storage policy requires the first folder to be the owner's id.
  const path = `${userId}/avatar-${Date.now()}.${EXT[file.type]}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600",
    contentType: file.type,
    upsert: false,
  });
  if (upErr) throw upErr;

  const url = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  try {
    await saveAvatarUrl(userId, url);
  } catch (e) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    throw e;
  }
  await removeOwnFile(previous, userId);
  return url;
}

/** Clear the profile picture (initials show instead). */
export async function removeAvatar(userId: string, previous: string | null | undefined) {
  await saveAvatarUrl(userId, null);
  await removeOwnFile(previous, userId);
}
