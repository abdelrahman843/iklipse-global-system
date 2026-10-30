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
// Slack too (0078): the iklipse Slack app reads the channels it's invited to,
// the same way as the WhatsApp groups; admins pick the channels and say who on
// Slack is who on the team.
// -----------------------------------------------------------------------------

export type AlertKind = "unanswered" | "promise" | "follow_up" | "ads" | "deadline";
export type AlertStatus = "open" | "handled" | "resolved" | "stopped";
export type AlertSource = "whatsapp" | "email" | "slack";

export interface WatchSettings {
  enabled: boolean;
  /** The one model for everything before 0108 (kept as the bot's fallback). */
  model: string;
  /** A Claude model per job (0108): quick decisions, words people read, tasks with several steps. */
  model_fast: string;
  model_main: string;
  model_agent: string;
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
  cc_admins: boolean;
  /** Email: watch the accounts each person turns on; what counts. */
  mail_enabled: boolean;
  mail_reply_wait_min: number;
  mail_clients: boolean;
  mail_ads: boolean;
  /** More senders counted as clients: "a@b.com" or "@b.com". */
  mail_senders: string[];
  /** Slack: watch the channels turned on in Alerts > Slack. */
  slack_enabled: boolean;
  /** Admins book meetings on their Calendly by talking to the bot in a group. */
  book_enabled: boolean;
  /** Waiting on them (follow_up alerts): on or off, the first reminder when no time was given, how many, how far apart. */
  follow_enabled: boolean;
  follow_wait_min: number;
  follow_every_min: number;
  follow_alerts: number;
  /** Nothing rings on these days (Cairo): weekdays (0 Sunday .. 6 Saturday) and dates ("2026-10-20"). */
  off_days: number[];
  off_dates: string[];
  /** Deliveries promised for a day: alerts from this many hours before, this often (then like any alert). */
  deadline_enabled: boolean;
  deadline_before_hours: number;
  deadline_every_min: number;
  /** Clients' missing details: asked of these people (each privately) and a team group, this often (0132). */
  ask_enabled: boolean;
  ask_people: string[];
  /** Their numbers, kept by the server (someone with none isn't asked). */
  ask_phones?: string[];
  ask_group: string | null;
  ask_every_min: number;
  /** Private messages get a reply the bot writes, sent once the team says OK (where it asks). */
  dm_enabled: boolean;
  /** The Calendly whose booking link clients asking for a meeting get. */
  book_link_account: string | null;
  /** Everyone on a meeting iklipse knows gets its details privately, and a reminder an hour before. */
  meet_tell: boolean;
  /** Orders by mention in the team groups: carried out, then followed up this often; a client gets this many messages at most. */
  orders_enabled: boolean;
  order_every_min: number;
  order_client_max: number;
  /** The team group alerts are posted in too when they first ring. */
  alert_group: string | null;
  /** Voice notes written out, photos and PDFs read (files are kept either way). */
  read_files: boolean;
  updated_at: string;
}

/** A connected Calendly (anyone's), for the booking link clients get. */
export interface CalendlyChoice {
  id: string;
  owner: string;
  email: string | null;
  name: string | null;
  event_type: string | null;
  minutes: number | null;
}

/** Admins: every connected Calendly. */
export async function fetchCalendlyChoices(): Promise<CalendlyChoice[]> {
  const { data, error } = await supabase.rpc("watch_calendly_accounts");
  if (error) throw error;
  return (data ?? []) as CalendlyChoice[];
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
  /** Admins: the Slack app. */
  slack: SlackStatus | null;
}

export interface SlackStatus {
  /** The bot token and signing secret are saved. */
  configured: boolean;
  /** The Slack workspace's name, and its address (https://name.slack.com/). */
  team: string | null;
  url: string | null;
  /** "ok" when the token works; otherwise what's wrong (null: not checked yet). */
  state: string | null;
  /** The last event Slack sent, the last time the channels were read. */
  hook_at: string | null;
  synced_at: string | null;
  channels: number;
  monitored: number;
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
  /** Slack alerts: the channel, and a link to the message in Slack. */
  slack: { channel_id: string; name: string | null; url: string | null } | null;
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
  /** The group's name, "#channel", or the email's subject. */
  group: string | null;
  alerts_sent: number;
  last_alert_at: string | null;
}

export interface GroupParticipant {
  wa_id: string;
  phone: string | null;
  /** Their WhatsApp id ("...@lid"): how someone whose number WhatsApp hides is linked. */
  lid?: string | null;
  name: string | null;
  is_admin: boolean;
  user_id: string | null;
  user_name: string | null;
  avatar_url: string | null;
  user_active: boolean | null;
  /** The bot's own number. */
  is_bot: boolean;
  /** Not on the team and not a client: a freelancer, a partner (0101). */
  other?: boolean;
  /** Not on the team: the client they are in Clients (null: not added yet). */
  client?: GroupClient | null;
}

/** Someone in a client group, as Clients has them. */
export interface GroupClient {
  id: string;
  name: string;
  /** False: named after their number until someone says who they are. */
  name_known: boolean;
  email: string | null;
  phone: string | null;
  company: string | null;
  /** The bot doesn't ask about them. */
  skip: boolean;
  /** How many times the bot asked about them (null: it isn't asking). */
  asked: number | null;
}

/** A client group (the bot keeps its clients) or a team group (ours: the bot asks there). */
export type GroupKind = "client" | "team";

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
  kind: GroupKind;
  /** The bot replies to clients here ("we'll get back to you shortly"). */
  bot_replies: boolean;
  /** The project a client group is for. */
  project: { id: string; title: string } | null;
  participants: GroupParticipant[];
}

/** An open project a client group can be tied to. */
export interface GroupProject {
  id: string;
  title: string;
  client: string | null;
}

export interface WatchMember {
  id: string;
  name: string;
  avatar_url: string | null;
  active: boolean;
  phones: string[];
  card_phone: string | null;
}

/** Someone in a Slack channel, and who they are on the team. */
export interface SlackParticipant {
  slack_id: string;
  /** Their Slack name (display name, else real name). */
  name: string | null;
  real_name: string | null;
  email: string | null;
  avatar: string | null;
  /** An app, not a person (never counted). is_app: the iklipse app itself. */
  is_bot: boolean;
  is_app: boolean;
  /** From another company (a Slack Connect channel), or a guest in the workspace. */
  external: boolean;
  guest: boolean;
  user_id: string | null;
  user_name: string | null;
  avatar_url: string | null;
  user_active: boolean | null;
  /** Matched to the team member by their email (not linked by hand). */
  by_email: boolean;
}

export interface SlackChannel {
  channel_id: string;
  name: string | null;
  is_private: boolean;
  /** Shared with another company (Slack Connect). */
  is_shared: boolean;
  monitored: boolean;
  size: number | null;
  /** The iklipse app is no longer in it. */
  left: boolean;
  synced_at: string | null;
  last_message_at: string | null;
  analyzed_at: string | null;
  last_error: string | null;
  open_alerts: number;
  participants: SlackParticipant[];
}

export interface SlackMember {
  id: string;
  name: string;
  avatar_url: string | null;
  active: boolean;
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

/** Open alerts I can see (admins: all), the number on Alerts in the sidebar (0083). */
export async function fetchOpenAlertCount(): Promise<number> {
  const { data, error } = await supabase.rpc("watch_open_count");
  if (error) throw error;
  return Number(data ?? 0);
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

export async function fetchWatchGroups(): Promise<{ groups: WatchGroup[]; members: WatchMember[]; projects: GroupProject[] }> {
  const { data, error } = await supabase.rpc("watch_groups");
  if (error) throw error;
  const d = data as { groups: WatchGroup[]; members: WatchMember[]; projects?: GroupProject[] };
  return { ...d, groups: d.groups.map((g) => ({ ...g, kind: g.kind ?? "client", bot_replies: !!g.bot_replies, project: g.project ?? null })), projects: d.projects ?? [] };
}

/** The bot replies to clients in this group, or not. */
export async function setGroupReplies(chatId: string, on: boolean) {
  const { error } = await supabase.rpc("watch_group_replies", { p_chat: chatId, p_on: on });
  if (error) throw error;
}

/** A client group or a team group, and the project a client group is for. */
export async function editGroup(chatId: string, kind: GroupKind, projectId: string | null) {
  const { error } = await supabase.rpc("watch_group_edit", { p_chat: chatId, p_kind: kind, p_project: projectId });
  if (error) throw error;
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

/** Who this WhatsApp number (or hidden-number id) is: someone on the team, a client, or not a client (a freelancer, a partner). */
export async function setPerson(phone: string, as: "team" | "client" | "other", userId: string | null) {
  const { error } = await supabase.rpc("watch_person_set", { p_phone: phone, p_as: as, p_user: userId });
  if (error) throw error;
}

// ------------------------------------------------------------------ slack --

/** Admins: the channels the iklipse app is in, who is in each, and the team. */
export async function fetchSlackChannels(): Promise<{ channels: SlackChannel[]; members: SlackMember[] }> {
  const { data, error } = await supabase.rpc("watch_slack");
  if (error) throw error;
  return data as { channels: SlackChannel[]; members: SlackMember[] };
}

export async function setSlackMonitored(channelId: string, monitored: boolean) {
  const { error } = await supabase.rpc("watch_slack_set", { p_channel: channelId, p_monitored: monitored });
  if (error) throw error;
}

/** This Slack person is this team member (null: not on the team, even if their email matches). */
export async function linkSlackUser(slackId: string, userId: string | null) {
  const { error } = await supabase.rpc("watch_slack_link", { p_slack: slackId, p_user: userId });
  if (error) throw error;
}

/** Admins: the Slack app's bot token and signing secret (both empty: remove Slack). */
export async function saveSlack(token: string, secret: string) {
  const { error } = await supabase.rpc("admin_set_slack", { p_token: token, p_secret: secret });
  if (error) throw error;
}

/** Checks the token with Slack: the workspace, or what's wrong. */
export const slackStatus = () => callFunction<{ ok: boolean; team: string | null; url: string | null; error?: string }>("whatsapp-bot", { action: "slack_status" });
/** Reads the channels the app is in and who is in them. */
export const syncSlack = () => callFunction<{ channels: number; read: number }>("whatsapp-bot", { action: "slack_sync" });

/** Where Slack sends its events (the app's Event Subscriptions). */
export const SLACK_EVENTS_URL = `${String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "")}/functions/v1/whatsapp-bot/slack`;

/** The Slack app, ready to paste in api.slack.com/apps (Create New App, From a manifest). */
export function slackManifest() {
  return JSON.stringify(
    {
      display_information: {
        name: "iklipse",
        description: "Reads the channels it's added to and alerts the team when a client is waiting for a reply.",
        background_color: "#1f1f1f",
      },
      features: { bot_user: { display_name: "iklipse", always_online: false } },
      oauth_config: {
        scopes: { bot: ["channels:read", "groups:read", "channels:history", "groups:history", "users:read", "users:read.email"] },
      },
      settings: {
        event_subscriptions: {
          request_url: SLACK_EVENTS_URL,
          bot_events: ["message.channels", "message.groups", "member_joined_channel", "member_left_channel", "channel_rename", "group_rename"],
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
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

// The bot's own WhatsApp bridge (0097, WAHA on the claude-vps server): admins
// link a number by its QR code and choose which one the bot uses.

export type WaProvider = "green" | "waha";

export interface BridgeStatus {
  /** The function has the bridge's address and key. */
  ready: boolean;
  /** Green API's words: authorized, notAuthorized, starting, stopped, failed, notStarted. */
  state: string;
  /** WAHA's own: WORKING, SCAN_QR_CODE, STARTING, STOPPED, FAILED, null before it's made. */
  status: string | null;
  phone: string | null;
  name: string | null;
  /** The QR code to scan (a data: image) while it waits for one. */
  qr: string | null;
  provider: WaProvider;
}

export const bridgeStatus = () => callFunction<BridgeStatus>("whatsapp-bot", { action: "waha_status" });
export const bridgeStart = () => callFunction<BridgeStatus>("whatsapp-bot", { action: "waha_start" });
export const bridgeLogout = () => callFunction<BridgeStatus>("whatsapp-bot", { action: "waha_logout" });
export const bridgeCode = (phone: string) => callFunction<{ code: string }>("whatsapp-bot", { action: "waha_code", phone });
/** How fast the bot answers, and how it looks while it does (0098). */
export interface BridgeSettings {
  reply_quiet_sec: number;
  reply_max_sec: number;
  group_quiet_sec: number;
  group_max_sec: number;
  wa_seen: boolean;
  wa_typing: boolean;
  typing_cps: number;
  typing_min_sec: number;
  typing_max_sec: number;
  wa_online: boolean;
}

export interface BridgeInfo {
  server: { url: string; version: string | null; engine: string | null };
  status: string | null;
  presence: string | null;
  /** Last activity, ms */
  activity: number | null;
  phone: string | null;
  profile: { name: string | null; picture: string | null } | null;
  /** WhatsApp's quota of new chats: total -1 means no cap. ends: seconds. */
  capping: { status: string | null; total: number; used: number; ends: number | null } | null;
  /** WhatsApp restricting the number from reaching out. ends: seconds. */
  timelock: { active: boolean; type: string | null; ends: number | null } | null;
  webhook: { to: string; ours: boolean; events: string[] } | null;
  ignore: Record<string, boolean> | null;
  /** on: the number reaches WhatsApp through a home address (WAHA_PROXY); set: the secret is there. */
  proxy: { on: boolean; set: boolean };
  settings: (BridgeSettings & { wa_provider: WaProvider; dm_enabled: boolean }) | null;
}

export const bridgeInfo = () => callFunction<BridgeInfo>("whatsapp-bot", { action: "waha_info" });
export const bridgeRestart = () => callFunction<BridgeStatus>("whatsapp-bot", { action: "waha_restart" });
export const bridgeStop = () => callFunction<BridgeStatus>("whatsapp-bot", { action: "waha_stop" });
export const saveBridgeSettings = (settings: Partial<BridgeSettings>) => callFunction<BridgeInfo>("whatsapp-bot", { action: "waha_settings", settings });
export const saveBridgeProfile = (profile: { name?: string; about?: string; picture?: { mimetype: string; data: string } | null }) =>
  callFunction<{ ok: boolean }>("whatsapp-bot", { action: "waha_profile", profile });

export const setBotProvider = (provider: WaProvider) =>
  callFunction<{ provider: WaProvider; bot: { state: string; phone: string | null } | null }>("whatsapp-bot", { action: "waha_use", provider });

// ------------------------------------------------------------------ words --

export const KIND_LABEL: Record<AlertKind, string> = {
  unanswered: "No reply",
  promise: "Promise",
  follow_up: "Waiting on them",
  deadline: "Deadline",
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

// ------------------------------------------------------------- metrics --
// The bot's numbers per day, for admins (Alerts > Metrics, 0111).

export interface BotAiUse {
  role: "fast" | "main" | "agent";
  model: string;
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  failed: number;
}

export interface BotMetricsDay {
  day: string;
  group_messages: number;
  private_in: number;
  replies_alone: number;
  asked_team: number;
  alerts_opened: number;
  alerts_closed: number;
  duplicates_kept_out: number;
  messages_stopped: number;
  reminders_sent: number;
  /** The median time to a client's reply in their private chat, in seconds; null with none that day. */
  median_reply_sec: number | null;
  ai: BotAiUse[];
}

export async function fetchBotMetrics(days: number): Promise<BotMetricsDay[]> {
  const { data, error } = await supabase.rpc("bot_metrics", { p_days: days });
  if (error) throw error;
  return (data ?? []) as BotMetricsDay[];
}

/** A message to a client the check stopped (whatsapp-bot guard.ts): the team got it instead. */
export interface GuardBlock {
  id: number;
  at: string;
  where_from: string;
  to_name: string | null;
  text: string;
  reasons: string[];
}

export async function fetchGuardBlocks(): Promise<GuardBlock[]> {
  const { data, error } = await supabase.from("bot_guard_block").select("id, at, where_from, to_name, text, reasons").order("at", { ascending: false }).limit(20);
  if (error) throw error;
  return (data ?? []) as GuardBlock[];
}

/** The WhatsApp numbers linked to a team member (member_phones, 0131). */
export async function fetchMemberPhones(userId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("member_phones", { p_user: userId });
  if (error) throw error;
  return (data ?? []) as string[];
}
