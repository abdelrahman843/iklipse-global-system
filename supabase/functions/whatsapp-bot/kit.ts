// What the watch's sources share (index.ts: WhatsApp groups, mail.ts: email,
// slack.ts: Slack channels): the settings, the team, Cairo time and Claude.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const env = (k: string, d = "") => Deno.env.get(k) || d;
const ANTHROPIC_KEY = env("ANTHROPIC_API_KEY");
export const TZ = "Africa/Cairo";
export const MIN = 60_000;

export type Db = SupabaseClient;

export interface Settings {
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
  cc_admins: boolean;
  bot_phone: string | null;
  // Email (0076)
  mail_enabled: boolean;
  mail_reply_wait_min: number;
  mail_clients: boolean;
  mail_ads: boolean;
  mail_senders: string[];
  // Slack (0078)
  slack_enabled: boolean;
  slack_team_id: string | null;
  slack_bot_user: string | null;
  // Meetings from WhatsApp (0079), booked on Calendly (0084)
  book_enabled: boolean;
  // Waiting on them (follow_up alerts) and days off (0080)
  follow_enabled: boolean;
  follow_wait_min: number;
  follow_every_min: number;
  follow_alerts: number;
  /** 0 Sunday .. 6 Saturday, Cairo */
  off_days: number[];
  /** "2026-10-20", Cairo */
  off_dates: string[];
  // Deadlines (0081): alerts from this many hours before, this often
  deadline_enabled: boolean;
  deadline_before_hours: number;
  deadline_every_min: number;
  // Clients' details, asked by WhatsApp or in a team group (0086)
  ask_enabled: boolean;
  ask_to: "person" | "group";
  ask_phone: string | null;
  ask_group: string | null;
  ask_every_min: number;
  // Private chats answered after an OK there (0087)
  dm_enabled: boolean;
  // The Calendly whose booking link clients get (0088)
  book_link_account: string | null;
  /** Meetings' details and reminders, privately to the people on them. */
  meet_tell: boolean;
  // Orders in the team groups, alerts posted in one, files read (0090)
  orders_enabled: boolean;
  order_every_min: number;
  order_client_max: number;
  alert_group: string | null;
  read_files: boolean;
  // How fast it answers, and the bridge's typing (0098)
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

/** When a new alert first rings: a deadline some hours ahead of it, the rest when due. */
export function firstRing(s: Settings, kind: string, due: number) {
  return kind === "deadline" ? Math.max(Date.now(), due - s.deadline_before_hours * 60 * MIN) : due;
}

export interface Person {
  id: string;
  name: string;
  username: string;
  active: boolean;
  admin: boolean;
}

export interface Team {
  people: Map<string, Person>;
  /** WhatsApp number -> team member */
  byPhone: Map<string, Person>;
  /** WhatsApp id of a hidden number ("1234@lid") -> team member (0080) */
  byLid: Map<string, Person>;
}

export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// ----------------------------------------------------------------- Cairo --

export const cairoStamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "+03:00": Cairo's offset from UTC right now (summer time or not). */
export function cairoOffset(d = new Date()) {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  return v === "GMT" ? "+00:00" : v.replace("GMT", "");
}

// --------------------------------------------------------------- Claude --

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** user: the words, or content blocks (a photo or a PDF with the words). */
export async function claude(model: string, system: string, user: string | Record<string, unknown>[], tool?: ClaudeTool, maxTokens = 2000): Promise<any> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY isn't set on the whatsapp-bot function");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      // Current models don't take a forced tool_choice; the prompt asks for the tool.
      ...(tool ? { tools: [tool], tool_choice: { type: "auto" } } : {}),
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude: ${j?.error?.message ?? `error ${res.status}`}`);
  const content = (j.content ?? []) as { type: string; text?: string; name?: string; input?: unknown }[];
  if (tool) {
    const used = content.find((c) => c.type === "tool_use" && c.name === tool.name)?.input;
    if (used) return used;
    // Answered in words instead: the JSON in them, if any.
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const at = text.indexOf("{");
    try {
      return at >= 0 ? JSON.parse(text.slice(at, text.lastIndexOf("}") + 1)) : null;
    } catch {
      return null;
    }
  }
  return content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}

export type Block = { type: string; id?: string; name?: string; input?: any; text?: string };

/** One turn of a conversation with tools (look.ts): what Claude said and the tools it called. The system prompt is cached between turns. */
export async function claudeTurn(model: string, system: string, messages: Record<string, unknown>[], tools: ClaudeTool[], maxTokens = 2000): Promise<Block[]> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY isn't set on the whatsapp-bot function");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
      tool_choice: { type: "auto" },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude: ${j?.error?.message ?? `error ${res.status}`}`);
  return (j.content ?? []) as Block[];
}

// ---------------------------------------------------------------- alerts --

/** An alert closed by someone on the team (or by itself): it stops ringing and calling. */
export async function closeAlert(db: Db, id: string, status: "handled" | "stopped", note: string, by: string | null) {
  const { data: hit } = await db
    .from("watch_alert")
    .update({ status, closed_at: iso(), closed_by: by, close_note: note, next_alert_at: null, updated_at: iso() })
    .eq("id", id)
    .eq("status", "open")
    .select("id");
  if (!hit?.length) return false;
  await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", id);
  await db.from("watch_event").insert({ alert_id: id, what: status, detail: note, user_id: by });
  await db.rpc("_watch_quiet_notifications", { p_alert: id });
  return true;
}

// --------------------------------------------------------------- sending --

/**
 * The bot's last message to a private chat hasn't gone out yet (Green API
 * holds messages while the phone is offline): a reminder isn't queued behind
 * it, so they don't pile up and all go out at once when it's back. A message
 * is out once WhatsApp shows it (the hook keeps it in wa_dm).
 */
export async function stillQueued(db: Db, chatId: string | null, id: string | null | undefined, sentAt?: string | null) {
  if (!id || !chatId?.endsWith("@c.us")) return false;
  if (sentAt && Date.now() - Date.parse(sentAt) > 3 * 60 * MIN) return false;
  const { data } = await db.from("wa_dm").select("id").eq("id", id).maybeSingle();
  return !data;
}

/** Reminders that go unanswered come less often: every, then twice that, 4 times... at most a day apart. */
export const backoff = (everyMin: number, times: number) => Math.min(everyMin * 2 ** Math.max(0, Math.min(times, 6)), 24 * 60) * MIN;
