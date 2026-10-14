import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Deliveries (migration 0062): what we hand to a client, like a Drive folder
// with previews. Admins and people allowed to (profile.delivery_role) prepare
// them and send links; everyone on the client's project sees them and the
// feedback. Files sit in the private 'deliveries' bucket (<folder>/<file>).
//
// Visitors have no account: delivery_open / delivery_comment_add /
// delivery_submit check the token, expiry and the device and people limits,
// and the delivery-media function signs the files for them.
// -----------------------------------------------------------------------------

export type DeliveryState = "open" | "submitted" | "approved";
export type ItemKind = "image" | "video" | "file" | "link";

export interface DeliveryItem {
  id: string;
  folder_id: string;
  kind: ItemKind;
  name: string;
  storage_path: string | null;
  external_url: string | null;
  mime_type: string | null;
  size: number | null;
  position: number;
  added_round: number;
  removed_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** An item as it was when a round closed (kept on the round). */
export interface SnapshotItem {
  id: string;
  kind: ItemKind;
  name: string;
  mime_type: string | null;
  size: number | null;
  storage_path: string | null;
  external_url: string | null;
  added_round: number;
}

export interface DeliveryViewer {
  link_id: string;
  device_id: string;
  name: string;
  email: string;
  device_name: string | null;
  first_seen: string;
  last_seen: string;
  opens: number;
}

export interface DeliveryLink {
  id: string;
  folder_id: string;
  token: string;
  label: string | null;
  max_devices: number | null;
  max_people: number | null;
  expires_at: string | null;
  allow_download: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  revoked_at: string | null;
  viewers: DeliveryViewer[];
}

export interface DeliveryComment {
  id: string;
  folder_id: string;
  item_id: string | null;
  round: number;
  body: string;
  at_seconds: number | null;
  guest: boolean;
  author_id: string | null;
  author_name: string;
  author_email: string | null;
  author_avatar: string | null;
  link_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  created_at: string;
}

export interface DeliveryRound {
  id: string;
  folder_id: string;
  number: number;
  opened_at: string;
  opened_by: string | null;
  opened_by_name: string | null;
  outcome: "feedback" | "approved" | null;
  submitted_at: string | null;
  submitted_name: string | null;
  submitted_email: string | null;
  client_note: string | null;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  items: SnapshotItem[] | null;
  /** Earlier feedback / approvals on this round, before the team reopened it (0063). */
  history: RoundHistory[];
}

export interface RoundHistory {
  outcome: "feedback" | "approved";
  submitted_at: string;
  submitted_name: string | null;
  submitted_email: string | null;
  client_note: string | null;
  reopened_at: string;
  reopened_by: string | null;
}

export interface Delivery {
  id: string;
  title: string;
  note: string | null;
  round: number;
  state: DeliveryState;
  project_id: string | null;
  project: string | null;
  client: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  /** Whether I can change it (admins and delivery managers). */
  manage: boolean;
  items: DeliveryItem[];
  /** Newest first. */
  rounds: DeliveryRound[];
  comments: DeliveryComment[];
  /** Managers only. */
  links: DeliveryLink[];
}

export interface DeliveryRow {
  id: string;
  title: string;
  note: string | null;
  round: number;
  state: DeliveryState;
  project_id: string | null;
  project: string | null;
  client: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  items: number;
  links: number;
  open_comments: number;
  last_activity: string;
}

export interface ProjectOption {
  id: string;
  title: string;
  client: string | null;
  status: string;
}

export const STATE_LABEL: Record<DeliveryState, string> = {
  open: "Waiting for feedback",
  submitted: "Feedback in",
  approved: "Approved",
};

export function kindOf(mime: string | null | undefined): ItemKind {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  return "file";
}

/** 185.4 -> "3:05", 3723 -> "1:02:03". */
export function clock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function deliveryUrl(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/d/${token}`;
}

export function linkLive(l: Pick<DeliveryLink, "revoked_at" | "expires_at">): boolean {
  return !l.revoked_at && (!l.expires_at || new Date(l.expires_at).getTime() > Date.now());
}

const rpc = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw new Error(error.message);
  return data as T;
};

// ------------------------------------------------------------------- team --
export const listDeliveries = () => rpc<{ folders: DeliveryRow[]; projects: ProjectOption[] }>("delivery_folders");
export const getDelivery = (id: string) => rpc<Delivery>("delivery_get", { p_id: id });
export const deliveriesForProject = (project: string) => rpc<Delivery[]>("delivery_for_project", { p_project: project });

const table = (name: string) => supabase.from(name as never);

export async function createDelivery(v: { title: string; note?: string | null; project_id?: string | null }): Promise<string> {
  const { data, error } = await table("delivery_folder")
    .insert({ title: v.title.trim(), note: v.note?.trim() || null, project_id: v.project_id ?? null } as never)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function updateDelivery(id: string, patch: { title?: string; note?: string | null; project_id?: string | null }) {
  const { error } = await table("delivery_folder").update(patch as never).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Deletes the delivery, its links, feedback history and its files. */
export async function deleteDelivery(id: string) {
  // Note the files first, delete the delivery, then its files: a failed
  // delete leaves everything as it was.
  const paths: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(id, { limit: 1000, offset });
    if (error) throw new Error(error.message);
    paths.push(...(data ?? []).map((f) => `${id}/${f.name}`));
    if ((data?.length ?? 0) < 1000) break;
  }
  const { error } = await table("delivery_folder").delete().eq("id", id);
  if (error) throw new Error(error.message);
  for (let i = 0; i < paths.length; i += 500) {
    const { error: e } = await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 500));
    if (e) throw new Error(`The delivery is deleted, but some files couldn't be removed: ${e.message}`);
  }
}

const BUCKET = "deliveries";
const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";

/** One file straight to storage, with progress (0..1). */
async function putWithProgress(path: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", key);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Upload failed (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        msg = body.message || body.error || msg;
      } catch {
        /* keep the status */
      }
      if (xhr.status === 413 || /maximum allowed size|too large/i.test(msg)) {
        msg = `${file.name} is bigger than your storage plan allows for one file.`;
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    xhr.send(file);
  });
}

/** Upload files into a delivery. onProgress(file index, fraction of that file). */
export async function uploadDeliveryFiles(folder: string, files: File[], onProgress?: (index: number, fraction: number) => void) {
  for (const [i, f] of files.entries()) {
    const ext = (f.name.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? "").toLowerCase();
    const path = `${folder}/${crypto.randomUUID()}_${sanitize(f.name.replace(/\.[^.]*$/, ""))}${ext}`;
    await putWithProgress(path, f, (x) => onProgress?.(i, x));
    const { error } = await table("delivery_item").insert({
      folder_id: folder,
      kind: kindOf(f.type),
      name: f.name,
      storage_path: path,
      mime_type: f.type || null,
      size: f.size,
    } as never);
    if (error) {
      await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
      throw new Error(error.message);
    }
    onProgress?.(i, 1);
  }
}

export async function addDeliveryLinkItem(folder: string, url: string, name: string) {
  let href = url.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  const parsed = new URL(href);
  const { error } = await table("delivery_item").insert({
    folder_id: folder,
    kind: "link",
    name: name.trim() || parsed.host.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, ""),
    external_url: href,
  } as never);
  if (error) throw new Error(error.message);
}

export async function updateItem(id: string, patch: { name?: string; position?: number; removed_at?: string | null }) {
  const { error } = await table("delivery_item").update(patch as never).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Hide an item from the client. Its file stays for the feedback history. */
export const removeItem = (id: string) => updateItem(id, { removed_at: new Date().toISOString() });
export const restoreItem = (id: string) => updateItem(id, { removed_at: null });

/** Short-lived links to a delivery's files for the team (preview or download). */
export async function teamFileUrls(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw new Error(error.message);
  const out: Record<string, string> = {};
  for (const r of data ?? []) if (r.path && r.signedUrl) out[r.path] = r.signedUrl;
  return out;
}

export async function teamDownloadUrl(path: string, name: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300, { download: name });
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export interface LinkInput {
  label?: string | null;
  max_devices?: number | null;
  max_people?: number | null;
  expires_at?: string | null;
  allow_download?: boolean;
}

export async function createLink(folder: string, v: LinkInput): Promise<DeliveryLink> {
  const { data, error } = await table("delivery_link")
    .insert({ folder_id: folder, ...v } as never)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { ...(data as DeliveryLink), viewers: [], created_by_name: null };
}

export async function updateLink(id: string, patch: LinkInput & { revoked_at?: string | null }) {
  const { error } = await table("delivery_link").update(patch as never).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteLink(id: string) {
  const { error } = await table("delivery_link").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Free a device's place on a link (it has to say who it is again). */
export async function removeViewer(link: string, device: string) {
  const { error } = await table("delivery_viewer").delete().eq("link_id", link).eq("device_id", device);
  if (error) throw new Error(error.message);
}

export async function addTeamComment(folder: string, item: string | null, body: string, at?: number | null) {
  const { error } = await table("delivery_comment").insert({
    folder_id: folder,
    item_id: item,
    body: body.trim(),
    at_seconds: at ?? null,
    author_name: "Team",
  } as never);
  if (error) throw new Error(error.message);
}

export async function setResolved(id: string, resolved: boolean) {
  const { error } = await table("delivery_comment")
    .update({ resolved_at: resolved ? new Date().toISOString() : null } as never)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteComment(id: string) {
  const { error } = await table("delivery_comment").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** clear: close this round (kept in history) and open a clean one. Otherwise only reopen it. */
export const nextRound = (folder: string, clear = true) =>
  rpc<number>("delivery_next_round", { p_folder: folder, p_clear: clear });

// --------------------------------------------------------------- visitors --
const DEVICE_KEY = "iklipse.delivery.device";
const WHO_KEY = "iklipse.delivery.who";

export function deliveryDevice(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || id.length < 8) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    const w = window as unknown as { __deliveryDevice?: string };
    return (w.__deliveryDevice ??= crypto.randomUUID());
  }
}

export function savedWho(): { name: string; email: string } {
  try {
    const v = JSON.parse(localStorage.getItem(WHO_KEY) ?? "{}") as { name?: string; email?: string };
    return { name: v.name ?? "", email: v.email ?? "" };
  } catch {
    return { name: "", email: "" };
  }
}

export function saveWho(name: string, email: string) {
  try {
    localStorage.setItem(WHO_KEY, JSON.stringify({ name, email }));
  } catch {
    /* private mode */
  }
}

/** A short "Chrome on Windows" so the team can tell devices apart. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export interface VisitorItem {
  id: string;
  kind: ItemKind;
  name: string;
  mime_type: string | null;
  size: number | null;
  external_url: string | null;
  /** Added in this round (after the first). */
  is_new: boolean;
}

export interface VisitorComment {
  id: string;
  item_id: string | null;
  body: string;
  at_seconds: number | null;
  author: string;
  guest: boolean;
  mine: boolean;
  resolved: boolean;
  created_at: string;
}

export interface OpenedDelivery {
  folder: { title: string; note: string | null; round: number; state: DeliveryState; client: string | null };
  round: { number: number; outcome: "feedback" | "approved" | null; submitted_at: string | null; submitted_name: string | null };
  link: { label: string | null; allow_download: boolean; expires_at: string | null };
  viewer: { name: string; email: string };
  items: VisitorItem[];
  comments: VisitorComment[];
}

/** Thrown when this device has to say who it is first (also after the team frees it). */
export class IdentifyFirst extends Error {}

const visitorError = (error: { message: string }) =>
  error.message === "IDENTIFY" ? new IdentifyFirst("Tell us who you are") : new Error(error.message);

export async function openDelivery(token: string, who?: { name: string; email: string }): Promise<OpenedDelivery> {
  const { data, error } = await supabase.rpc("delivery_open" as never, {
    p_token: token,
    p_device: deliveryDevice(),
    p_name: who?.name || null,
    p_email: who?.email || null,
    p_agent: deviceName(),
  } as never);
  if (error) {
    throw visitorError(error);
  }
  return data as unknown as OpenedDelivery;
}

export async function visitorComment(token: string, item: string, body: string, at?: number | null): Promise<VisitorComment> {
  const { data, error } = await supabase.rpc("delivery_comment_add" as never, {
    p_token: token,
    p_device: deliveryDevice(),
    p_item: item,
    p_body: body,
    p_at: at ?? null,
  } as never);
  if (error) throw visitorError(error);
  return data as unknown as VisitorComment;
}

export async function visitorRemoveComment(token: string, id: string) {
  const { error } = await supabase.rpc("delivery_comment_remove" as never, { p_token: token, p_device: deliveryDevice(), p_id: id } as never);
  if (error) throw visitorError(error);
}

export async function submitDelivery(token: string, outcome: "feedback" | "approved", note: string) {
  const { error } = await supabase.rpc("delivery_submit" as never, {
    p_token: token,
    p_device: deliveryDevice(),
    p_outcome: outcome,
    p_note: note.trim() || null,
  } as never);
  if (error) throw visitorError(error);
}

/** The message a failed edge-function call came back with. */
async function fnError(error: unknown, fallback: string): Promise<Error> {
  const res = (error as { context?: Response } | null)?.context;
  try {
    const body = res && typeof res.json === "function" ? ((await res.json()) as { error?: string }) : null;
    if (body?.error) return body.error === "IDENTIFY" ? new IdentifyFirst("Tell us who you are") : new Error(body.error);
  } catch {
    /* not JSON */
  }
  return new Error(fallback);
}

/** Signed URLs (an hour) for the delivery's files, by item id. */
export async function visitorMedia(token: string, items?: string[]): Promise<Record<string, string>> {
  const { data, error } = await supabase.functions.invoke<{ urls?: Record<string, string>; error?: string }>("delivery-media", {
    body: { token, device: deliveryDevice(), items },
  });
  if (error) throw await fnError(error, "Couldn't load the files");
  return data?.urls ?? {};
}

export async function visitorDownload(token: string, item: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>("delivery-media", {
    body: { token, device: deliveryDevice(), download: item },
  });
  if (error) throw await fnError(error, "Couldn't get the file");
  if (!data?.url) throw new Error("Couldn't get the file");
  return data.url;
}
