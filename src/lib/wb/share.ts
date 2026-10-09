import { supabase } from "@/lib/supabase";
import type { WbItem } from "./types";

// -----------------------------------------------------------------------------
// Miro boards shared with clients by link (migration 0045). Visitors have no
// account: the database checks the token, expiry and device limit in
// wb_share_open / wb_share_comment, and the wb-share-media function signs the
// board's images and videos for them.
// -----------------------------------------------------------------------------

export type ShareAccess = "view" | "comment";

export interface ShareLink {
  id: string;
  board_id: string;
  token: string;
  label: string | null;
  access: ShareAccess;
  expires_at: string | null;
  max_devices: number | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ShareDevice {
  link_id: string;
  device_id: string;
  name: string | null;
  first_seen: string;
  last_seen: string;
}

/** The address a client opens. */
export function shareUrl(token: string) {
  return `${location.origin}${location.pathname}#/s/${token}`;
}

// ------------------------------------------------------------- managing --
export async function fetchShareLinks(boardId: string): Promise<{ links: ShareLink[]; devices: ShareDevice[] }> {
  const { data, error } = await supabase.from("wb_share_link").select("*").eq("board_id", boardId).order("created_at", { ascending: false });
  if (error) throw error;
  const links = (data ?? []) as ShareLink[];
  if (!links.length) return { links, devices: [] };
  const dev = await supabase
    .from("wb_share_device")
    .select("*")
    .in("link_id", links.map((l) => l.id))
    .order("last_seen", { ascending: false });
  if (dev.error) throw dev.error;
  return { links, devices: (dev.data ?? []) as ShareDevice[] };
}

export async function createShareLink(input: { board_id: string; label: string | null; access: ShareAccess; expires_at: string | null; max_devices: number | null }) {
  const { data, error } = await supabase.from("wb_share_link").insert(input).select("*").single();
  if (error) throw error;
  return data as ShareLink;
}

export async function updateShareLink(id: string, patch: Partial<Pick<ShareLink, "label" | "access" | "expires_at" | "max_devices" | "revoked_at">>) {
  const { error } = await supabase.from("wb_share_link").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteShareLink(id: string) {
  const { error } = await supabase.from("wb_share_link").delete().eq("id", id);
  if (error) throw error;
}

/** Free a device's place (that browser has to open the link again, if there's room). */
export async function removeShareDevice(linkId: string, deviceId: string) {
  const { error } = await supabase.from("wb_share_device").delete().eq("link_id", linkId).eq("device_id", deviceId);
  if (error) throw error;
}

// -------------------------------------------------------------- visiting --
const DEVICE_KEY = "iklipse.share.device";
const NAME_KEY = "iklipse.share.name";

/** This browser's id for share links (kept, so reopening doesn't use up another device). */
export function shareDevice(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || id.length < 8) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked: one id per tab at least.
    const w = window as unknown as { __shareDevice?: string };
    return (w.__shareDevice ??= crypto.randomUUID());
  }
}

export function savedGuestName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
export function saveGuestName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage blocked */
  }
}

export interface SharedComment {
  id: string;
  thread_id: string | null;
  item_id: string | null;
  x: number | null;
  y: number | null;
  body: string;
  resolved: boolean;
  created_at: string;
  author: string;
  guest: boolean;
}

export interface SharedBoard {
  board: { id: string; title: string };
  link: { access: ShareAccess; label: string | null; expires_at: string | null };
  items: WbItem[];
  comments: SharedComment[];
}

export async function openShared(token: string, name?: string): Promise<SharedBoard> {
  const { data, error } = await supabase.rpc("wb_share_open" as never, { p_token: token, p_device: shareDevice(), p_name: name || null } as never);
  if (error) throw new Error(error.message);
  return data as unknown as SharedBoard;
}

export async function commentShared(token: string, name: string, body: string, at: { thread?: string; item?: string | null; x?: number; y?: number }) {
  const { error } = await supabase.rpc(
    "wb_share_comment" as never,
    {
      p_token: token,
      p_device: shareDevice(),
      p_name: name,
      p_body: body,
      p_thread: at.thread ?? null,
      p_item: at.item ?? null,
      p_x: at.x ?? null,
      p_y: at.y ?? null,
    } as never,
  );
  if (error) throw new Error(error.message);
}

/** Signed URLs for the board's images and videos (empty if the media service isn't there). */
export async function sharedMediaUrls(token: string, paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  try {
    const { data, error } = await supabase.functions.invoke<{ urls?: Record<string, string> }>("wb-share-media", {
      body: { token, device: shareDevice(), paths },
    });
    if (error) return {};
    return data?.urls ?? {};
  } catch {
    return {};
  }
}
