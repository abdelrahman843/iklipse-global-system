import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// WhatsApp watch (migration 0067 + the whatsapp-bot function): the bot reads
// the WhatsApp groups it's in; Claude opens an alert when a client is left
// without a reply or someone promises something; alerts ring the team members
// in that group like an alarm (notifications, then phone calls) until someone
// handles them, and then Ikli calls them inside the app (0068).
// Email too: each person turns on watching for their own Gmail accounts; Claude
// reads new emails there, and client or ad platform emails open the same kind
// of alerts, ringing only the mailbox's owner.
// -----------------------------------------------------------------------------

export type AlertKind = "unanswered" | "promise" | "follow_up" | "ads";
export type AlertStatus = "open" | "handled" | "resolved" | "stopped";
export type AlertSource = "whatsapp" | "email";

export interface WatchSettings {
  enabled: boolean;
  model: string;
  reply_wait_min: number;
  promise_wait_min: number;
  repeat_every_min: number;
  alerts_before_call: number;
  calls_enabled: boolean;
  call_retry_min: number;
  call_every_min: number;
  max_calls: number;
  stop_after_hours: number;
  quiet_from: string | null;
  quiet_to: string | null;
  call_language: "en" | "ar";
  cc_admins: boolean;
  /** Email: watch the accounts each person turns on; what counts. */
  mail_enabled: boolean;
  mail_reply_wait_min: number;
  mail_clients: boolean;
  mail_ads: boolean;
  /** More senders counted as clients: "a@b.com" or "@b.com". */
  mail_senders: string[];
  updated_at: string;
}

/** One of my own Gmail accounts, and whether Claude watches it. */
export interface MyMailAccount {
  account_id: string;
  email: string;
  watching: boolean;
  checked_at: string | null;
  last_error: string | null;
}

/** A team member and their Gmail accounts (admins). */
export interface MailWatchPerson {
  id: string;
  name: string;
  avatar_url: string | null;
  active: boolean;
  accounts: (MyMailAccount & { open_alerts: number })[];
}

export interface WatchOverview {
  is_admin: boolean;
  open: number;
  mine: number;
  /** I get push notifications somewhere (calls reach a closed app only that way). */
  my_push: boolean;
  /** A phone with the iklipse Android app is linked to me (calls ring like real ones). */
  my_phone: boolean;
  settings: WatchSettings | null;
  bot: {
    configured: boolean;
    instance: string | null;
    state: string | null;
    phone: string | null;
    hook_at: string | null;
    synced_at: string | null;
    groups: number;
    monitored: number;
  } | null;
  /** My own Gmail accounts (everyone). */
  my_mail: MyMailAccount[];
  /** Admins: how many accounts are watched, by how many people. */
  mail: { watched: number; people: number } | null;
}

export interface AlertRecipient {
  user_id: string;
  name: string;
  avatar_url: string | null;
  calls: number;
  answered: number;
  calling: boolean;
  next_call_at: string | null;
}

export interface AlertEvent {
  at: string;
  what: string;
  detail: string | null;
  by: string | null;
}

export interface WatchAlert {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string | null;
  person: string | null;
  priority: "normal" | "high" | "urgent";
  status: AlertStatus;
  due_at: string;
  next_alert_at: string | null;
  alerts_sent: number;
  last_alert_at: string | null;
  calls_made: number;
  snoozed_until: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  close_note: string | null;
  created_at: string;
  source: AlertSource;
  /** Email alerts: both empty. */
  group: { chat_id: string | null; name: string | null };
  /** Email alerts: the email (mine: my own mailbox, so I can open it on the Mail page). */
  mail: { account_id: string; email: string; thread_id: string; subject: string | null; from: string | null; mine: boolean } | null;
  mine: boolean;
  recipients: AlertRecipient[];
  events: AlertEvent[];
}

export interface RingingAlert {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string | null;
  priority: WatchAlert["priority"];
  source: AlertSource;
  /** The group's name, or the email's subject. */
  group: string | null;
  alerts_sent: number;
  last_alert_at: string | null;
}

export interface GroupParticipant {
  wa_id: string;
  phone: string | null;
  name: string | null;
  is_admin: boolean;
  user_id: string | null;
  user_name: string | null;
  avatar_url: string | null;
  user_active: boolean | null;
  /** The bot's own number. */
  is_bot: boolean;
}

export interface WatchGroup {
  chat_id: string;
  name: string | null;
  monitored: boolean;
  size: number | null;
  left: boolean;
  synced_at: string | null;
  last_message_at: string | null;
  analyzed_at: string | null;
  last_error: string | null;
  open_alerts: number;
  participants: GroupParticipant[];
}

export interface WatchMember {
  id: string;
  name: string;
  avatar_url: string | null;
  active: boolean;
  phones: string[];
  card_phone: string | null;
}

export async function fetchWatchOverview(): Promise<WatchOverview> {
  const { data, error } = await supabase.rpc("watch_overview");
  if (error) throw error;
  return data as WatchOverview;
}

export async function fetchAlerts(open: boolean): Promise<WatchAlert[]> {
  const { data, error } = await supabase.rpc("watch_alerts", { p_open: open });
  if (error) throw error;
  return (data ?? []) as WatchAlert[];
}

export async function fetchRinging(): Promise<RingingAlert[]> {
  const { data, error } = await supabase.rpc("watch_ringing");
  if (error) throw error;
  return (data ?? []) as RingingAlert[];
}

export async function closeAlert(id: string, note?: string) {
  const { error } = await supabase.rpc("watch_alert_close", { p_id: id, p_note: note ?? null });
  if (error) throw error;
}

export async function snoozeAlert(id: string, minutes: number) {
  const { error } = await supabase.rpc("watch_alert_snooze", { p_id: id, p_minutes: minutes });
  if (error) throw error;
}

export async function reopenAlert(id: string) {
  const { error } = await supabase.rpc("watch_alert_reopen", { p_id: id });
  if (error) throw error;
}

export async function saveWatchSettings(patch: Partial<WatchSettings>) {
  const { error } = await supabase.rpc("watch_settings_set", { p: patch });
  if (error) throw error;
}

export async function fetchWatchGroups(): Promise<{ groups: WatchGroup[]; members: WatchMember[] }> {
  const { data, error } = await supabase.rpc("watch_groups");
  if (error) throw error;
  return data as { groups: WatchGroup[]; members: WatchMember[] };
}

export async function setGroupMonitored(chatId: string, monitored: boolean) {
  const { error } = await supabase.rpc("watch_group_set", { p_chat: chatId, p_monitored: monitored });
  if (error) throw error;
}

/** This WhatsApp number is this team member (null: nobody on the team). */
export async function linkNumber(phone: string, userId: string | null) {
  const { error } = await supabase.rpc("watch_link", { p_phone: phone, p_user: userId });
  if (error) throw error;
}

// ------------------------------------------------------------------ email --

/** Watch one of my Gmail accounts, or stop (admins may stop anyone's). */
export async function setMailWatch(account: string, on: boolean) {
  const { error } = await supabase.rpc("mail_watch_set", { p_account: account, p_on: on });
  if (error) throw error;
}

/** Everyone on the team and their Gmail accounts (admins). */
export async function fetchMailWatchPeople(): Promise<MailWatchPerson[]> {
  const { data, error } = await supabase.rpc("mail_watch_people");
  if (error) throw error;
  return (data ?? []) as MailWatchPerson[];
}

// ------------------------------------------------------------------ calls --

export interface WatchCall {
  id: string;
  alert_id: string | null;
  started_at: string;
  title: string;
  detail: string | null;
  group: string | null;
  priority: WatchAlert["priority"] | null;
  /** What Ikli says, and its voice (a file in watch-audio): fetched while it rings. */
  words: string | null;
  audio: string | null;
}

/** Ikli calling me right now, if it is. */
export async function fetchMyCall(): Promise<WatchCall | null> {
  const { data, error } = await supabase.rpc("watch_my_call");
  if (error) throw error;
  return (data as WatchCall | null) ?? null;
}

/** Ikli's voice for a call. */
export async function fetchCallAudio(path: string): Promise<Blob | null> {
  const dl = await supabase.storage.from("watch-audio").download(path);
  return dl.data ?? null;
}

/** Picked up: what Ikli says, and its voice (null when it couldn't be made, or not wanted). */
export async function answerCall(id: string, withAudio = true): Promise<{ words: string | null; audio: Blob | null }> {
  const { data, error } = await supabase.rpc("watch_call_answer", { p_call: id });
  if (error) throw error;
  const r = data as { words: string | null; audio: string | null };
  return { words: r.words, audio: withAudio && r.audio ? await fetchCallAudio(r.audio) : null };
}

/** Answered or declined here: my phone with the Android app stops ringing. */
export function hushPhones(callId: string) {
  callFunction("whatsapp-bot", { action: "hush", call: callId }).catch(() => {});
}

export async function declineCall(id: string) {
  const { error } = await supabase.rpc("watch_call_decline", { p_call: id });
  if (error) throw error;
}

export async function endCall(id: string) {
  await supabase.rpc("watch_call_end", { p_call: id });
}

// ------------------------------------------------------- the Android app --
// Ikli's calls ring like real ones on the iklipse Android app (android/, 0071);
// it links itself when someone signs in there (src/lib/nativeApp.ts).

export interface LinkedPhone {
  id: string;
  device: string | null;
  app_version: string | null;
  created_at: string;
  last_seen_at: string;
}

export async function fetchLinkedPhones(): Promise<LinkedPhone[]> {
  const { data, error } = await supabase.rpc("native_devices");
  if (error) throw error;
  return (data as LinkedPhone[]) ?? [];
}

export async function unlinkPhone(id: string) {
  const { error } = await supabase.rpc("native_device_remove", { p_id: id });
  if (error) throw error;
}

export const connectBot = () => callFunction<{ state: string; phone: string | null }>("whatsapp-bot", { action: "connect" });
export const botStatus = () => callFunction<{ state: string; phone: string | null }>("whatsapp-bot", { action: "status" });
export const syncGroups = () => callFunction<{ groups: number; read: number }>("whatsapp-bot", { action: "sync" });
export const testCall = () => callFunction<{ call: string }>("whatsapp-bot", { action: "test_call" });

// ------------------------------------------------------------------ words --

export const KIND_LABEL: Record<AlertKind, string> = {
  unanswered: "No reply",
  promise: "Promise",
  follow_up: "Follow up",
  ads: "Ads",
};

/** Green API's instance states, in plain words. */
export function botStateText(state: string | null | undefined): { text: string; ok: boolean } {
  switch (state) {
    case "authorized":
      return { text: "Connected", ok: true };
    case "notAuthorized":
      return { text: "Logged out: scan the QR code in Green API again", ok: false };
    case "blocked":
      return { text: "Blocked by WhatsApp: this number can't be used", ok: false };
    case "sleepMode":
      return { text: "Asleep: the phone is off or offline", ok: false };
    case "starting":
      return { text: "Starting", ok: false };
    case "yellowCard":
      return { text: "Warned by WhatsApp (yellow card): sending is paused", ok: false };
    case null:
    case undefined:
    case "":
      return { text: "Not checked yet", ok: false };
    default:
      return { text: state, ok: false };
  }
}

/** "3h 10m" */
export function span(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.round(h / 24)}d`;
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
