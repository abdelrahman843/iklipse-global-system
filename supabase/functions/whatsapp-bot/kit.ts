// What the watch's sources share (index.ts: WhatsApp groups, mail.ts: email,
// slack.ts: Slack channels): the settings, the team, Cairo time and Claude.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const env = (k: string, d = "") => Deno.env.get(k) || d;
const ANTHROPIC_KEY = env("ANTHROPIC_API_KEY");
export const TZ = "Africa/Cairo";
export const MIN = 60_000;

export type Db = SupabaseClient;
export type Lang = "en" | "ar";

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
  call_language: Lang;
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

export async function claude(model: string, system: string, user: string, tool?: ClaudeTool, maxTokens = 2000): Promise<any> {
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
