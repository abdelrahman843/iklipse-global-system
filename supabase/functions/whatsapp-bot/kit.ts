// What the watch's sources share (index.ts: WhatsApp groups, mail.ts: email,
// slack.ts: Slack channels): the settings, the team, Cairo time and Claude.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { retryAfterMs, transientStatus, withRetry } from "./agent/retry.ts";

export const env = (k: string, d = "") => Deno.env.get(k) || d;
const ANTHROPIC_KEY = env("ANTHROPIC_API_KEY");
export const TZ = "Africa/Cairo";
export const MIN = 60_000;

export type Db = SupabaseClient;

export interface Settings {
  enabled: boolean;
  /** The one model for everything before 0108; kept as the fallback. */
  model: string;
  /** A model per job (0108): modelFor. Missing until that migration runs. */
  model_fast?: string | null;
  model_main?: string | null;
  model_agent?: string | null;
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
  /** What the team taught the bot in chat (notes.ts, 0114), as Claude reads it: loaded with the settings (index.ts). */
  taught?: string | null;
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
  /** Numbers and hidden-number ids of people who aren't on the team and aren't clients: freelancers, partners (0101). */
  others: Set<string>;
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

export type Block = { type: string; id?: string; name?: string; input?: any; text?: string };
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Which model a call runs on (0108, Alerts > Settings): fast for quick
 * decisions (what to do with a message, reading chats and emails for alerts,
 * reading files), main for words people read (replies to clients, answers to
 * the team, call words), agent for the agent runtime (agent/).
 */
export type Role = "fast" | "main" | "agent";

/** A kind of call to Claude: its name in the usage log (bot_ai_call), and the model setting it runs on. */
export interface Job {
  /** "orders.act", "chat.read"... */
  name: string;
  role: Role;
  /** The longest wait for one try: 25 s for quick decisions, 45 s for the rest, unless said. */
  timeoutMs?: number;
}

export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;
const DEFAULT_MODEL: Record<Role, string> = { fast: "claude-haiku-5-5", main: "claude-sonnet-5-5", agent: "claude-sonnet-5-5" };
type ModelSettings = { model?: string | null; model_fast?: string | null; model_main?: string | null; model_agent?: string | null; taught?: string | null };

/** The model a job runs on: its role's setting; before 0108 runs, the one model set for everything, as before. */
export function modelFor(s: ModelSettings, role: Role) {
  return s[`model_${role}`] || s.model || DEFAULT_MODEL[role];
}

/**
 * How a quick decision is asked, so it answers without thinking first (short,
 * fast, cheap). Per model, as Anthropic's docs say (Oct 2026): Haiku 5.5 takes
 * a forced tool (and then doesn't think) or thinking off; Sonnet 5.5 refuses a
 * forced tool and turns thinking off with between_tools; Opus 5.5 can't turn
 * it off, so it thinks as little as it can.
 */
function quick(model: string, tool?: ClaudeTool): Record<string, unknown> {
  if (model.includes("haiku")) return tool ? { tool_choice: { type: "tool", name: tool.name } } : { thinking: { type: "disabled" } };
  if (model.includes("sonnet")) return { thinking: { type: "between_tools" } };
  if (model.includes("opus")) return { output_config: { effort: "low" } };
  return {};
}
/** Room for thinking on top of the answer's own tokens, when the model thinks (only what's used is paid). */
const THINKING_ROOM = 2000;
const thinks = (shape: Record<string, unknown>) => !shape.tool_choice && !(shape.thinking as { type?: string } | undefined)?.type?.match(/disabled|between_tools/);

/** The Messages API said no (its HTTP status), or never answered (0). */
export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** One call to Claude, for the usage log (bot_ai_call, 0108): never the message's words. */
export interface AiCall {
  job: string;
  role: Role;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ms: number;
  tries: number;
  ok: boolean;
  error: string | null;
  /** Something worth seeing that isn't a failure: the tool wasn't called, a refusal, cut at max_tokens. */
  note: string | null;
}
let sink: ((row: AiCall) => Promise<unknown>) | null = null;
/** Where each call is kept (index.ts: the bot_ai_call table). Unset (tests), nowhere. */
export function logAiCallsTo(fn: ((row: AiCall) => Promise<unknown>) | null) {
  sink = fn;
}

export interface Answer {
  content: Block[];
  usage: Usage;
  stop_reason?: string;
}

/**
 * One call to the Messages API. Each try waits at most job.timeoutMs (and
 * never past the deadline); when Anthropic is busy, the network blinks or a
 * try times out (429, a 5xx, 529 overloaded, no answer), it's tried twice more,
 * a second or two apart (or as long as Anthropic asks, up to 5 seconds);
 * anything else fails at once. Every call is logged (bot_ai_call), with what
 * note() makes of the answer.
 */
export async function claudeCall(
  body: Record<string, unknown>,
  job: Job = { name: "call", role: "main" },
  o: { deadline?: number; note?: (a: Answer) => string | null } = {},
): Promise<Answer> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY isn't set on the whatsapp-bot function");
  const t0 = Date.now();
  // The function has about 150 seconds; nothing waits on Claude past this.
  const deadline = o.deadline ?? t0 + 110_000;
  const each = job.timeoutMs ?? (job.role === "fast" ? 25_000 : 45_000);
  let tries = 0;
  const row = (a: Partial<AiCall>): AiCall => ({
    job: job.name,
    role: job.role,
    model: String(body.model ?? ""),
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ms: Date.now() - t0,
    tries,
    ok: true,
    error: null,
    note: null,
    ...a,
  });
  try {
    const a = await withRetry(
      async () => {
        tries++;
        const wait = Math.min(each, deadline - Date.now());
        if (wait < 1000) throw new ClaudeError("Claude: out of time", 0);
        let res: Response;
        try {
          res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(wait),
          });
        } catch (e) {
          const late = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
          throw new ClaudeError(late ? `Claude: no answer in ${Math.round(wait / 1000)}s` : `Claude: ${(e as Error).message}`, 0);
        }
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new ClaudeError(`Claude: ${j?.error?.message ?? `error ${res.status}`}`, res.status, retryAfterMs(res.headers.get("retry-after")));
        return { content: (j.content ?? []) as Block[], usage: (j.usage ?? {}) as Usage, stop_reason: j.stop_reason as string | undefined };
      },
      {
        retries: 2,
        baseMs: 1000,
        maxMs: 5000,
        deadline,
        transient: (e) => e instanceof ClaudeError && transientStatus(e.status),
        waitHint: (e) => (e instanceof ClaudeError ? e.retryAfter : null),
        onRetry: (n, ms, e) => console.error("claude retry", job.name, n, ms, (e as Error).message),
      },
    );
    const said = o.note?.(a) ?? null;
    const stopped = a.stop_reason === "refusal" || a.stop_reason === "max_tokens" ? `stopped: ${a.stop_reason}` : null;
    const note = [stopped, said].filter(Boolean).join("; ") || null;
    if (note) console.warn(JSON.stringify({ ev: "claude.note", job: job.name, model: body.model, note }));
    await keep(
      row({
        input_tokens: a.usage.input_tokens ?? 0,
        output_tokens: a.usage.output_tokens ?? 0,
        cache_read_tokens: a.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: a.usage.cache_creation_input_tokens ?? 0,
        note,
      }),
    );
    return a;
  } catch (e) {
    await keep(row({ ok: false, error: (e as Error).message.slice(0, 300) }));
    throw e;
  }
}

async function keep(row: AiCall) {
  if (!sink) return;
  await sink(row).catch((e) => console.error("ai call log", (e as Error).message));
}

/** A system prompt: the part that never changes (cached), then what does (the time now, a calendar...). */
export type System = string | { stable: string; now: string };
/**
 * Then what the team taught the bot (notes.ts), cached too (it rarely
 * changes), before what does change. Every call gets it but reading a file
 * and writing a client's notes, which go only by what's in front of them.
 */
const systemBlocks = (s: System, taught: string | null = null) => [
  { type: "text", text: typeof s === "string" ? s : s.stable, cache_control: { type: "ephemeral" } },
  ...(taught ? [{ type: "text", text: taught, cache_control: { type: "ephemeral" } }] : []),
  ...(typeof s === "string" ? [] : [{ type: "text", text: s.now }]),
];
const UNTAUGHT = new Set(["files.read", "memory.write"]);
const taughtFor = (s: ModelSettings, job: Job) => (UNTAUGHT.has(job.name) ? null : str(s.taught) || null);

/**
 * One question to Claude. user: the words, or content blocks (a photo or a
 * PDF with the words). With a tool, its input; else the words. The system
 * prompt (and the tool before it) is cached, so it's cheaper the next time.
 * A quick decision (role fast) is asked so it doesn't think first.
 */
export async function claude(s: ModelSettings, job: Job, system: System, user: string | Record<string, unknown>[], tool?: ClaudeTool, maxTokens = 2000): Promise<any> {
  const model = modelFor(s, job.role);
  const shape = job.role === "fast" ? quick(model, tool) : {};
  // A forced tool where the model takes one (Haiku); else the prompt asks for it, and what comes back is checked.
  let note: string | null = null;
  const { content } = await claudeCall(
    {
      model,
      max_tokens: maxTokens + (thinks(shape) ? THINKING_ROOM : 0),
      system: systemBlocks(system, taughtFor(s, job)),
      messages: [{ role: "user", content: user }],
      ...(tool ? { tools: [tool], tool_choice: { type: "auto" } } : {}),
      ...shape,
    },
    job,
    {
      note: (a) => {
        if (!tool || a.content.some((c) => c.type === "tool_use" && c.name === tool.name)) return null;
        note = toolMissing(a.content);
        return note;
      },
    },
  );
  if (tool) {
    const used = content.find((c) => c.type === "tool_use" && c.name === tool.name)?.input;
    if (used) return used;
    // Answered in words instead: the JSON in them, if any (logged above, with the call's name).
    return note === "no tool: JSON read from the words" ? jsonIn(content) : null;
  }
  return content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}

/** The JSON object in Claude's words, or null. */
function jsonIn(content: Block[]) {
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const at = text.indexOf("{");
  try {
    const v = at >= 0 ? JSON.parse(text.slice(at, text.lastIndexOf("}") + 1)) : null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
const toolMissing = (content: Block[]) => (jsonIn(content) ? "no tool: JSON read from the words" : "no tool: nothing to read");

/**
 * One turn of a conversation with tools (look.ts, agent/): what Claude said,
 * the tools it called, the tokens it took. The system prompt and the
 * conversation so far are cached between turns. timeoutMs: the turn waits no
 * longer (the agent's time left).
 */
export async function claudeStep(
  s: ModelSettings,
  job: Job,
  system: string,
  messages: Record<string, unknown>[],
  tools: ClaudeTool[],
  maxTokens = 2000,
  o: { timeoutMs?: number } = {},
) {
  const deadline = o.timeoutMs ? Date.now() + o.timeoutMs : undefined;
  return await claudeCall(
    {
      model: modelFor(s, job.role),
      max_tokens: maxTokens + THINKING_ROOM,
      system: systemBlocks(system, taughtFor(s, job)),
      // The conversation so far, cached up to its last message (the next turn reads it back).
      cache_control: { type: "ephemeral" },
      messages,
      tools,
      tool_choice: { type: "auto" },
    },
    o.timeoutMs ? { ...job, timeoutMs: o.timeoutMs } : job,
    { deadline },
  );
}

/** One turn of a conversation with tools: what Claude said and the tools it called. */
export async function claudeTurn(s: ModelSettings, job: Job, system: string, messages: Record<string, unknown>[], tools: ClaudeTool[], maxTokens = 2000): Promise<Block[]> {
  return (await claudeStep(s, job, system, messages, tools, maxTokens)).content;
}

// ---------------------------------------------------------------- alerts --

/**
 * A new alert, kept: its id, or null when it isn't (the same one is already
 * open: the unique index of 0109, or the database said no). Before 0109 runs,
 * it's kept without person_key and mail_key.
 */
export async function insertAlert(db: Db, row: Record<string, unknown>): Promise<{ id: string } | null> {
  let r = await db.from("watch_alert").insert(row).select("id").single();
  if (r.error && /person_key|mail_key/.test(r.error.message)) {
    const { person_key: _k, mail_key: _m, ...before } = row;
    r = await db.from("watch_alert").insert(before).select("id").single();
  }
  if (r.error || !r.data) {
    if (r.error?.code === "23505") await tally(db, "alert_duplicate");
    else console.error("alert", r.error?.message ?? "not kept");
    return null;
  }
  return r.data as { id: string };
}

/** One more of something the admins' numbers count (0111, Alerts > Metrics). Never in the way: nothing before 0111. */
export async function tally(db: Db, what: "reply_alone" | "asked_team" | "alert_duplicate", n = 1) {
  try {
    await db.rpc("_bot_tally", { p_what: what, p_n: n });
  } catch {
    // Only a number.
  }
}

/**
 * The same thing said again, or with a new time (0109): the open alert's due
 * time and detail change instead of a new one opening. Not rung yet, it rings
 * at the new time.
 */
export async function updateAlert(
  db: Db,
  s: Settings,
  a: { id: string; kind: string; alerts_sent?: number | null; due_at?: string | null; detail?: string | null },
  o: { due?: number | null; detail?: string | null; why: string },
) {
  const patch: Record<string, unknown> = { updated_at: iso() };
  const due = o.due && Number.isFinite(o.due) && o.due > Date.now() ? o.due : null;
  if (due && iso(due) !== a.due_at) {
    patch.due_at = iso(due);
    if (!a.alerts_sent) patch.next_alert_at = iso(firstRing(s, a.kind, due));
  }
  const detail = str(o.detail).slice(0, 500);
  if (detail && detail !== a.detail) patch.detail = detail;
  if (Object.keys(patch).length === 1) return false;
  const { data: hit } = await db.from("watch_alert").update(patch).eq("id", a.id).eq("status", "open").select("id");
  if (!hit?.length) return false;
  await db.from("watch_event").insert({ alert_id: a.id, what: "updated", detail: `${o.why}${patch.due_at ? `, now due ${cairoStamp.format(new Date(due!))}` : ""}`.slice(0, 300) });
  if (patch.due_at) a.due_at = patch.due_at as string;
  if (patch.detail) a.detail = patch.detail as string;
  return true;
}

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

/**
 * One more call about an alert, counted from what's kept now (index.ts
 * startCall): several people called in one run all add up. was: the count
 * read with the call that's due, when it can't be read now.
 */
export async function countCall(db: Db, id: string, was = 0) {
  const { data } = await db.from("watch_alert").select("calls_made").eq("id", id).single();
  await db.from("watch_alert").update({ calls_made: ((data?.calls_made as number | null | undefined) ?? was) + 1, updated_at: iso() }).eq("id", id);
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
