import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Fireflies.ai meetings (0059 + the fireflies function). Each person connects
// their Fireflies accounts with an API key; the function keeps a copy of every
// meeting they were in. A meeting can be shared with people in iklipse, or by
// email as a private link (/meeting/<token>) that opens without signing in.
// -----------------------------------------------------------------------------

export interface FirefliesAccount {
  id: string;
  email: string | null;
  name: string | null;
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  /** Older meetings are still coming in. */
  syncing?: boolean;
  meetings: number;
}

export interface MeetingSummary {
  overview: string | null;
  short_summary: string | null;
  action_items: string | null;
  keywords: string[];
  bullet_gist: string | null;
  outline: string | null;
  shorthand_bullet: string | null;
  topics: string[];
}

export interface MeetingRow {
  id: string;
  account_id: string;
  title: string | null;
  started_at: string | null;
  duration: number | null;
  organizer_email: string | null;
  participants: string[];
  speakers: string[];
  short_summary: string | null;
  has_summary: boolean;
  shares: number;
  // Shared with me:
  owner_id?: string;
  owner_name?: string;
  owner_avatar?: string | null;
  shared_at?: string;
}

/** One line of the transcript: speaker, text, start and end (seconds). */
export interface Sentence {
  i: number;
  s: string;
  t: string;
  a: number;
  b: number;
}

export interface MeetingDetail extends MeetingRow {
  access: "owner" | "shared";
  account_email: string | null;
  owner_name: string;
  attendees: { name: string | null; email: string | null }[];
  transcript_url: string | null;
  meeting_link: string | null;
  summary: MeetingSummary | null;
  sentences: Sentence[] | null;
  people: { user_id: string; name: string; avatar_url: string | null; shared_at: string }[];
  links: { id: string; token: string; email: string | null; created_at: string; opened_at: string | null; by: string | null }[];
}

export interface MeetingsOverview {
  accounts: FirefliesAccount[];
  meetings: MeetingRow[];
}

export async function fetchMeetingsOverview(): Promise<MeetingsOverview> {
  const { data, error } = await supabase.rpc("meetings_overview");
  if (error) throw error;
  const d = (data ?? {}) as Partial<MeetingsOverview>;
  return { accounts: d.accounts ?? [], meetings: d.meetings ?? [] };
}

export async function fetchMeetingsSharedWithMe(): Promise<MeetingRow[]> {
  const { data, error } = await supabase.rpc("meetings_shared_with_me");
  if (error) throw error;
  return (data ?? []) as MeetingRow[];
}

export async function fetchMeeting(id: string): Promise<MeetingDetail> {
  const { data, error } = await supabase.rpc("meeting_get", { p_id: id });
  if (error) throw error;
  return data as MeetingDetail;
}

// --------------------------------------------------------------- accounts --
export function connectFireflies(apiKey: string) {
  return callFunction<{ id: string; email: string | null; meetings: number }>("fireflies", { action: "connect", api_key: apiKey });
}

export function disconnectFireflies(account: string) {
  return callFunction("fireflies", { action: "disconnect", account });
}

export function syncFireflies(account?: string) {
  return callFunction<{ synced: number; errors: string[] }>("fireflies", { action: "sync", account });
}

/** Fetches the transcript the first time (then it's kept with the meeting). */
export async function loadTranscript(id: string): Promise<Sentence[]> {
  const r = await callFunction<{ sentences: Sentence[] }>("fireflies", { action: "meeting", id });
  return r.sentences ?? [];
}

export function meetingMedia(id: string) {
  return callFunction<{ audio_url: string | null; video_url: string | null }>("fireflies", { action: "media", id });
}

// ---------------------------------------------------------------- sharing --
export async function shareMeeting(id: string, users: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("meeting_share", { p_id: id, p_users: users });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function unshareMeeting(id: string, user: string) {
  const { error } = await supabase.rpc("meeting_unshare", { p_id: id, p_user: user });
  if (error) throw error;
}

export async function revokeMeetingLink(link: string) {
  const { error } = await supabase.rpc("meeting_link_revoke", { p_link: link });
  if (error) throw error;
}

export const meetingLink = (token: string) => `${location.origin}${location.pathname}#/meeting/${token}`;

/** Email it through the workspace's notification sender. */
export async function emailMeetingFromWorkspace(id: string, email: string, note: string) {
  const { data, error } = await supabase.rpc("meeting_email_share", { p_id: id, p_email: email, p_note: note });
  if (error) throw error;
  return data as string;
}

/** Email it from one of my own Gmail accounts. */
export async function emailMeetingFromGmail(m: MeetingDetail, account: string, email: string, note: string, by: string) {
  const { data, error } = await supabase.rpc("meeting_link_create", { p_id: m.id, p_email: email });
  if (error) throw error;
  const link = meetingLink(data as string);
  const s = m.summary;
  const text = [
    note.trim() || null,
    [m.title ?? "Meeting", m.started_at ? meetingWhen(m.started_at) + (m.duration ? ` · ${minutes(m.duration)}` : "") : null].filter(Boolean).join("\n"),
    s?.overview || s?.short_summary ? `Summary\n${s.overview || s.short_summary}` : null,
    s?.action_items ? `Action items\n${s.action_items}` : null,
    `The full summary and transcript:\n${link}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  await callFunction("gmail", { action: "send", account, to: email, subject: `${by} shared a meeting with you: ${m.title ?? "Meeting"}`, text });
}

// ------------------------------------------------------------------ public --
export interface PublicMeeting {
  title: string | null;
  started_at: string | null;
  duration: number | null;
  speakers: string[];
  attendees: string[];
  summary: MeetingSummary | null;
  sentences: Sentence[];
  shared_by: string;
}

export function fetchPublicMeeting(token: string) {
  return callFunction<PublicMeeting>("fireflies", { action: "public", token });
}

// ----------------------------------------------------------------- helpers --
export function meetingWhen(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function minutes(m: number) {
  const n = Math.round(m);
  if (n < 60) return `${n} min`;
  return `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ""}`.trim();
}

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Fireflies' bullet text ("- a\n- b", "• a") as lines. */
export function bullets(v: string | null | undefined): string[] {
  if (!v) return [];
  return v
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}
