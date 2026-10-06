import { supabase } from "@/lib/supabase";
import type { Board } from "@/lib/database.types";

// Whiteboard data that isn't canvas items: board row, comments, timer, voting, images.

export type WbBoard = Board & { kind: "kanban" | "whiteboard"; preview: WbPreview | null };

/** Thumbnail sketch stored on the board row: boxes in a w x h frame. */
export interface WbPreview {
  w: number;
  h: number;
  /** [x, y, w, h, colour, kind] kind: 0 box, 1 frame, 2 line, 3 text */
  r: [number, number, number, number, string, number][];
}

export async function fetchWbBoard(boardId: string): Promise<WbBoard> {
  const { data, error } = await supabase.from("board").select("*").eq("id", boardId).single();
  if (error) throw error;
  return data as WbBoard;
}

export async function savePreview(boardId: string, preview: WbPreview) {
  await supabase.from("board").update({ preview }).eq("id", boardId);
}

// ---------------------------------------------------------------- comments --
export interface WbComment {
  id: string;
  board_id: string;
  thread_id: string | null;
  item_id: string | null;
  x: number | null;
  y: number | null;
  author_id: string;
  body: string;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

export async function fetchComments(boardId: string): Promise<WbComment[]> {
  const { data, error } = await supabase.from("wb_comment").select("*").eq("board_id", boardId).order("created_at");
  if (error) throw error;
  return (data ?? []) as WbComment[];
}

export async function addComment(input: {
  board_id: string;
  body: string;
  thread_id?: string | null;
  item_id?: string | null;
  x?: number | null;
  y?: number | null;
  author_id: string;
}): Promise<WbComment> {
  const { data, error } = await supabase.from("wb_comment").insert(input).select("*").single();
  if (error) throw error;
  return data as WbComment;
}

export async function updateComment(id: string, patch: Partial<Pick<WbComment, "body" | "resolved" | "x" | "y" | "item_id">>) {
  const { error } = await supabase.from("wb_comment").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteComment(id: string) {
  const { error } = await supabase.from("wb_comment").delete().eq("id", id);
  if (error) throw error;
}

// ------------------------------------------------------------------- timer --
export interface WbState {
  board_id: string;
  timer_ends_at: string | null;
  timer_left_ms: number | null;
  timer_total_ms: number | null;
  timer_by: string | null;
  updated_at: string;
}

export async function fetchState(boardId: string): Promise<WbState | null> {
  const { data, error } = await supabase.from("wb_state").select("*").eq("board_id", boardId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as WbState | null;
}

export async function saveState(boardId: string, patch: Partial<Omit<WbState, "board_id" | "updated_at" | "timer_by">>) {
  const { error } = await supabase.from("wb_state").upsert({ board_id: boardId, ...patch }, { onConflict: "board_id" });
  if (error) throw error;
}

// ------------------------------------------------------------------ voting --
export interface VoteSession {
  id: string;
  board_id: string;
  title: string;
  votes_per_user: number;
  one_per_item: boolean;
  status: "open" | "closed";
  created_by: string | null;
  created_at: string;
  closed_at: string | null;
}

export async function fetchVoteSessions(boardId: string): Promise<VoteSession[]> {
  const { data, error } = await supabase
    .from("wb_vote_session")
    .select("*")
    .eq("board_id", boardId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as VoteSession[];
}

export async function startVoting(boardId: string, title: string, votes: number, onePerItem: boolean) {
  const { error } = await supabase
    .from("wb_vote_session")
    .insert({ board_id: boardId, title, votes_per_user: votes, one_per_item: onePerItem });
  if (error) throw error;
}

export async function endVoting(id: string) {
  const { error } = await supabase.from("wb_vote_session").update({ status: "closed" }).eq("id", id);
  if (error) throw error;
}

export async function deleteVoting(id: string) {
  const { error } = await supabase.from("wb_vote_session").delete().eq("id", id);
  if (error) throw error;
}

/** My votes in a session: item id -> count. */
export async function fetchMyVotes(sessionId: string, userId: string): Promise<Record<string, number>> {
  const { data, error } = await supabase.from("wb_vote").select("item_id, n").eq("session_id", sessionId).eq("user_id", userId);
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as { item_id: string; n: number }[]).map((r) => [r.item_id, r.n]));
}

export async function castVote(sessionId: string, itemId: string, delta: 1 | -1): Promise<number> {
  const { data, error } = await supabase.rpc("wb_cast_vote", { p_session: sessionId, p_item: itemId, p_delta: delta });
  if (error) throw error;
  return data as number;
}

export async function voteResults(sessionId: string): Promise<{ voters: number; items: Record<string, number> }> {
  const { data, error } = await supabase.rpc("wb_vote_results", { p_session: sessionId });
  if (error) throw error;
  return data as { voters: number; items: Record<string, number> };
}

// ------------------------------------------------------------------ images --
const BUCKET = "whiteboard";
const MAX_IMAGE = 15 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Local previews while an upload is running (path -> object URL). */
const localUrls = new Map<string, string>();
const signed = new Map<string, { url: string; exp: number }>();
const waiting = new Map<string, ((u: string | null) => void)[]>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

export function isUploadableImage(f: File) {
  return IMAGE_TYPES.includes(f.type);
}

export async function uploadImage(boardId: string, file: File): Promise<{ path: string; nw: number; nh: number }> {
  if (!isUploadableImage(file)) throw new Error("Only PNG, JPEG, GIF and WebP images can go on a board.");
  if (file.size > MAX_IMAGE) throw new Error("Image is too large (max 15 MB).");
  const ext = file.type.split("/")[1]!.replace("jpeg", "jpg");
  const path = `${boardId}/${crypto.randomUUID()}.${ext}`;
  const local = URL.createObjectURL(file);
  localUrls.set(path, local);
  const size = await new Promise<{ nw: number; nh: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ nw: img.naturalWidth || 400, nh: img.naturalHeight || 300 });
    img.onerror = () => resolve({ nw: 400, nh: 300 });
    img.src = local;
  });
  return { path, ...size };
}

/** Second half of an upload: send the bytes (the item already shows the local preview). */
export async function sendImage(path: string, file: File) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: "31536000",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
}

/** Display URL for a stored image (signed in batches, cached for hours). */
export function imageUrl(path: string): Promise<string | null> {
  const l = localUrls.get(path);
  if (l) return Promise.resolve(l);
  const hit = signed.get(path);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    const list = waiting.get(path) ?? [];
    list.push(resolve);
    waiting.set(path, list);
    if (!batchTimer) batchTimer = setTimeout(signBatch, 30);
  });
}

export function cachedImageUrl(path: string): string | null {
  const l = localUrls.get(path);
  if (l) return l;
  const s = signed.get(path);
  return s && s.exp > Date.now() ? s.url : null;
}

async function signBatch() {
  batchTimer = null;
  const paths = [...waiting.keys()];
  const cbs = new Map(waiting);
  waiting.clear();
  const ttl = 6 * 3600;
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, ttl);
  const got = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  for (const p of paths) {
    const url = got.get(p) ?? null;
    if (url) signed.set(p, { url, exp: Date.now() + (ttl - 600) * 1000 });
    for (const cb of cbs.get(p) ?? []) cb(url);
  }
}
