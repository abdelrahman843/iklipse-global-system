import { supabase } from "@/lib/supabase";
import type { BriefAnswers, BriefForm, BriefImage } from "./forms";

// -----------------------------------------------------------------------------
// Brief links (migration 0050). The team makes a link, sends it themselves,
// and reads the answers here. Visitors have no account: brief_open / save /
// submit check the token and that this is the device that opened it first,
// and the brief-media function stores and shows their moodboard images.
// -----------------------------------------------------------------------------

export interface BriefLink {
  id: string;
  token: string;
  form: string;
  questions: BriefForm;
  label: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  opened_at: string | null;
  device_id: string | null;
  device_name: string | null;
  last_seen_at: string | null;
  answers: BriefAnswers;
  progress: number;
  submitted_at: string | null;
  revoked_at: string | null;
}

export type BriefStatus = "waiting" | "progress" | "answered" | "off";

export function briefStatus(l: Pick<BriefLink, "opened_at" | "submitted_at" | "revoked_at">): BriefStatus {
  if (l.submitted_at) return "answered";
  if (l.revoked_at) return "off";
  return l.opened_at ? "progress" : "waiting";
}

/** The address the person opens. */
export function briefUrl(token: string) {
  return `${location.origin}${location.pathname}#/b/${token}`;
}

// ---------------------------------------------------------------- team --
const LIST_COLS =
  "id, token, form, label, note, created_by, created_at, opened_at, device_id, device_name, last_seen_at, progress, submitted_at, revoked_at";

export async function listBriefs(): Promise<Omit<BriefLink, "questions" | "answers">[]> {
  const { data, error } = await supabase.from("brief_link").select(LIST_COLS).order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as Omit<BriefLink, "questions" | "answers">[];
}

export async function getBrief(id: string): Promise<BriefLink | null> {
  const { data, error } = await supabase.from("brief_link").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as BriefLink | null) ?? null;
}

export async function createBrief(input: { form: BriefForm; label: string; note: string | null }): Promise<BriefLink> {
  const { data, error } = await supabase
    .from("brief_link")
    .insert({ form: input.form.key, questions: input.form, label: input.label, note: input.note } as never)
    .select("*")
    .single();
  if (error) throw error;
  return data as BriefLink;
}

export async function updateBrief(id: string, patch: Partial<Pick<BriefLink, "label" | "note" | "revoked_at" | "device_id">>) {
  const { error } = await supabase.from("brief_link").update(patch as never).eq("id", id);
  if (error) throw error;
}

/** Deletes the link, its answers and its moodboard images. */
export async function deleteBrief(id: string) {
  const files = await supabase.storage.from("brief").list(id, { limit: 100 });
  const paths = (files.data ?? []).map((f) => `${id}/${f.name}`);
  if (paths.length) await supabase.storage.from("brief").remove(paths);
  const { error } = await supabase.from("brief_link").delete().eq("id", id);
  if (error) throw error;
}

/** Signed URLs for a link's moodboard (team side). */
export async function signBriefImages(linkId: string, images: BriefImage[]): Promise<Record<string, string>> {
  const paths = images.map((i) => i.path).filter((p) => p.startsWith(`${linkId}/`));
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from("brief").createSignedUrls(paths, 3600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}

// ------------------------------------------------------------- visitor --
const DEVICE_KEY = "iklipse.brief.device";

/** A random id this browser keeps: the link stays with the first device that opens it. */
export function briefDevice(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked (private mode on some browsers): this visit only.
    const w = window as unknown as { __briefDevice?: string };
    w.__briefDevice ??= Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");
    return w.__briefDevice;
  }
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iphone/i.test(ua) ? "iPhone" : /ipad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad"
    : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /mac/i.test(ua) ? "Mac" : /linux/i.test(ua) ? "Linux" : "Device";
  const br = /edg\//i.test(ua) ? "Edge" : /samsungbrowser/i.test(ua) ? "Samsung Internet" : /firefox|fxios/i.test(ua) ? "Firefox"
    : /chrome|crios/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}

export type BriefOpen =
  | { status: "open"; form: string; label: string; note: string | null; questions: BriefForm; answers: BriefAnswers; from: string | null }
  | { status: "submitted"; label: string; mine: boolean }
  | { status: "used" | "off" | "invalid" };

export async function openBrief(token: string): Promise<BriefOpen> {
  const { data, error } = await supabase.rpc("brief_open" as never, { p_token: token, p_device: briefDevice(), p_device_name: deviceLabel() } as never);
  if (error) throw new Error(error.message);
  return data as unknown as BriefOpen;
}

export async function saveBrief(token: string, answers: BriefAnswers, progress: number) {
  const { error } = await supabase.rpc("brief_save" as never, { p_token: token, p_device: briefDevice(), p_answers: answers, p_progress: progress } as never);
  if (error) throw new Error(error.message);
}

export async function submitBrief(token: string, answers: BriefAnswers) {
  const { error } = await supabase.rpc("brief_submit" as never, { p_token: token, p_device: briefDevice(), p_answers: answers } as never);
  if (error) throw new Error(error.message);
}

async function media<T>(body: FormData | Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>("brief-media", { body });
  if (error) {
    // The function's own message (link closed, file too big) is safe to show.
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? await ctx.json().then((j: { error?: string }) => j.error).catch(() => null) : null;
    throw new Error(msg || "Couldn't reach the upload service. Check the connection and try again.");
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

/** Upload one moodboard image; returns its path and a URL to show it. */
export async function uploadBriefImage(token: string, file: File): Promise<{ path: string; url: string }> {
  const fd = new FormData();
  fd.append("token", token);
  fd.append("device", briefDevice());
  fd.append("file", file, file.name);
  return media<{ path: string; url: string }>(fd);
}

export async function signVisitorImages(token: string, paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const r = await media<{ urls: Record<string, string> }>({ action: "sign", token, device: briefDevice(), paths });
  return r.urls ?? {};
}

export async function removeBriefImage(token: string, path: string) {
  await media<{ ok: boolean }>({ action: "delete", token, device: briefDevice(), path });
}
