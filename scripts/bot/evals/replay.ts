// The eval set (cases/*.json) replayed against the bot's own prompts and code
// with the real Claude API: the database is in memory, nothing is sent to
// WhatsApp, Calendly or anyone. Each case says what should come of a message:
// - route: what the bot does with a message from the team (orders.ts act):
//   orders, meetings, questions, reminders and when they're due, stopping...
// - alerts: what reading a group opens, closes, or doesn't open twice (chat.ts).
// - reply: a client's private chat (dm.ts): reply, ask the team, off topic,
//   a meeting; replies short, in English, in the bot's voice, nothing leaked.
// - booking: a meeting asked for (book.ts decide), and when it's free on the
//   calendar but past Calendly's hours, the reason the team hears (blocked.ts).
// It prints each case's pass or fail and what the calls cost. Run with
// run.mjs (npm run eval:bot -- --real); never in CI: it costs money.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cairoStamp, claude, iso, logAiCallsTo, MIN, TZ, type AiCall, type Person, type Settings, type Team } from "../../../supabase/functions/whatsapp-bot/kit.ts";
import { orderSystem, orderTool } from "../../../supabase/functions/whatsapp-bot/orders.ts";
import { readChat, type ChatLine } from "../../../supabase/functions/whatsapp-bot/chat.ts";
import { readDms } from "../../../supabase/functions/whatsapp-bot/dm.ts";
import { decide } from "../../../supabase/functions/whatsapp-bot/book.ts";
import { whyNot } from "../../../supabase/functions/whatsapp-bot/blocked.ts";
import { resolveWhen } from "../../../supabase/functions/whatsapp-bot/reminders.ts";
import { clockIn } from "../../../supabase/functions/whatsapp-bot/zones.ts";
import { voiceIssues } from "../../../supabase/functions/whatsapp-bot/voice.ts";
import { forgetClients } from "../../../supabase/functions/whatsapp-bot/guard.ts";
import { fakeDb } from "../../../supabase/functions/whatsapp-bot/test/fake-db.ts";
import type { Hours } from "../../../supabase/functions/_shared/calendly.ts";
import { aiCost } from "../../../src/lib/aiPrices.ts";

// ------------------------------------------------------------- the cases --

interface Base {
  id: string;
  lang: "ar-eg" | "franco" | "en";
  note?: string;
}
interface RouteCase extends Base {
  kind: "route";
  message: string;
  where?: "team" | "client" | "private";
  from?: string;
  open_orders?: { id: string; to: string; kind: string; task: string }[];
  open_alerts?: { id: string; what: string; where: string }[];
  your_reminders?: { id: string; for: string; at: string; text?: string }[];
  expect: { action: string | string[]; fields?: Record<string, unknown>; due?: { day: number; time: string } };
}
interface AlertsCase extends Base {
  kind: "alerts";
  lines: { name: string; text: string; team?: boolean; min_ago: number; seen?: boolean }[];
  open?: { kind: string; title: string; person: string; who: string; min_ago: number; due_in_min?: number }[];
  expect: { opened: number; kinds?: string[]; resolved?: number };
}
interface ReplyCase extends Base {
  kind: "reply";
  client?: { name: string; company?: string; projects?: { title: string; status: string }[] };
  chat: { me?: boolean; text: string; min_ago: number }[];
  expect: { action: string | string[] };
}
interface BookingCase extends Base {
  kind: "booking";
  message: string;
  expect: { action: string | string[]; day?: number; time?: string; why?: string };
  calendly?: Hours["rules"];
}
type Case = RouteCase | AlertsCase | ReplyCase | BookingCase;

/** The make-believe iklipse the cases run in: names and numbers are made up. */
const TEAM: Person[] = ["Sameh", "Rabah", "Omar", "Nour"].map((n) => ({ id: n.toLowerCase(), name: n, username: n.toLowerCase(), active: true, admin: n === "Sameh" }));
const CLIENTS = [
  { id: "abbas", name: "Abbas Hamdy", company: "Hamdy Motors", phone: "15550001001", group: "Hamdy Motors | iklipse" },
  { id: "lina", name: "Lina Saleh", company: "Bloom Cafe", phone: "15550001002", group: "Bloom Cafe" },
  { id: "karim", name: "Karim Nabil", company: "Nabil Dental", phone: "15550001003", group: "Nabil Dental x iklipse" },
];
const PEOPLE = [
  ...TEAM.map((p) => ({ ref: `t:${p.id}`, name: p.name, who: "team", whatsapp: null })),
  ...CLIENTS.map((c) => ({ ref: `c:${c.id}`, name: c.name, who: "client", group: c.group, whatsapp: `+${c.phone}` })),
];
const T: Team = { people: new Map(TEAM.map((p) => [p.id, p])), byPhone: new Map(), byLid: new Map(), others: new Set() };
const S = {
  model_fast: process.env.EVAL_MODEL_FAST || "claude-haiku-5-5",
  model_main: process.env.EVAL_MODEL_MAIN || "claude-sonnet-5-5",
  model_agent: "claude-sonnet-5-5",
  reply_wait_min: 10,
  promise_wait_min: 60,
  follow_wait_min: 120,
  deadline_enabled: true,
  follow_enabled: true,
  cc_admins: false,
  deadline_before_hours: 24,
  dm_enabled: true,
  ask_to: "person",
  ask_phone: "15550009999",
  ask_group: null,
  ask_every_min: 30,
  reply_quiet_sec: 60,
  reply_max_sec: 300,
  order_every_min: 60,
} as unknown as Settings;
const cairo = clockIn(TZ);
const WHERE = { team: "the team group", client: "a client group (you answer them privately, never in the group)", private: "privately" };
const ARABIC = /[؀-ۿ]/;

// ------------------------------------------------------- what came back --

/** What Claude's tools were called with, newest last: the decision a case is judged on. */
const decisions: { name: string; input: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  // Only Claude: nothing reaches Calendly, WhatsApp or anything else from here.
  if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`Not reached in evals: ${new URL(String(url)).host}`);
  const res = await realFetch(url, init);
  {
    try {
      const b = await res.clone().json();
      for (const c of b.content ?? []) if (c.type === "tool_use") decisions.push({ name: c.name, input: c.input });
    } catch {
      // Not JSON: the call itself says what went wrong.
    }
  }
  return res;
}) as typeof fetch;
const calls: AiCall[] = [];
logAiCallsTo(async (r) => void calls.push(r));

/** "remind.when.time" from an object; arrays by index ("orders.0.kind"). */
const pick = (o: unknown, path: string) => path.split(".").reduce<unknown>((x, k) => (x == null ? x : (x as Record<string, unknown>)[k]), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const oneOf = (want: string | string[], got: unknown) => (Array.isArray(want) ? want : [want]).includes(String(got));

// ------------------------------------------------------------ each kind --

async function route(c: RouteCase): Promise<string[]> {
  const ctx = {
    now: `${cairoStamp.format(new Date())} Cairo time`,
    where: WHERE[c.where ?? "team"],
    from: c.from ?? "Sameh",
    message: c.message,
    details_asked: false,
    people: PEOPLE,
    projects: [],
    open_orders: c.open_orders ?? [],
    open_alerts: c.open_alerts ?? [],
    ...(c.your_reminders ? { your_reminders: c.your_reminders } : {}),
  };
  const r = (await claude(S, { name: "orders.act", role: "fast", timeoutMs: 50_000 }, orderSystem(false), JSON.stringify(ctx), orderTool(false), 6000)) as Record<string, unknown> | null;
  if (!r) return ["no answer"];
  const out: string[] = [];
  if (!oneOf(c.expect.action, r.action)) out.push(`action ${r.action}, wanted ${c.expect.action}`);
  for (const [k, v] of Object.entries(c.expect.fields ?? {})) if (!same(pick(r, k), v)) out.push(`${k} ${JSON.stringify(pick(r, k))}, wanted ${JSON.stringify(v)}`);
  for (const o of (r.orders ?? []) as { message?: string }[]) {
    const v = voiceIssues(String(o.message ?? ""));
    if (v.length) out.push(`order message: ${v.join(", ")}: ${o.message}`);
  }
  if (c.expect.due && r.remind) {
    const w = resolveWhen(r.remind as Parameters<typeof resolveWhen>[0], TZ);
    const want = cairo.at(cairo.dayOf(Date.now() + c.expect.due.day * 24 * 60 * MIN), c.expect.due.time);
    if ("ask" in w) out.push(`asked back "${w.ask}", wanted ${c.expect.due.time}`);
    else if (w.at !== want) out.push(`due ${new Date(w.at).toISOString()}, wanted ${new Date(want).toISOString()}`);
  }
  if (r.action === "none" && voiceIssues(String(r.reply ?? "")).length) out.push(`question back: ${voiceIssues(String(r.reply)).join(", ")}`);
  return out;
}

async function alerts(c: AlertsCase): Promise<string[]> {
  const now = Date.now();
  const chat = { source: "whatsapp" as const, col: "chat_id" as const, id: "eval@g.us", name: "Hamdy Motors | iklipse" };
  const keyOf = (name: string, team?: boolean) => (team ? `t:${name.toLowerCase()}` : `c:${name.split(/\s+/)[0]!.toLowerCase()}`);
  const open = (c.open ?? []).map((a, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    chat_id: chat.id,
    source: "whatsapp",
    kind: a.kind,
    title: a.title,
    detail: null,
    person: a.person,
    person_key: a.who,
    status: "open",
    message_id: "m0",
    created_at: iso(now - a.min_ago * MIN),
    due_at: iso(now + (a.due_in_min ?? -5) * MIN),
    alerts_sent: 0,
  }));
  const f = fakeDb({ watch_alert: open, watch_recipient: [], watch_event: [] });
  const lines: ChatLine[] = c.lines.map((l, i) => ({
    id: `m${i + 1}`,
    sent_at: iso(now - l.min_ago * MIN),
    isNew: !l.seen,
    team: !!l.team,
    name: l.name,
    who: keyOf(l.name, l.team),
    replyTo: null,
    text: l.text,
  }));
  const inChat = new Map(TEAM.filter((p) => c.lines.some((l) => l.team && l.name === p.name)).map((p) => [p.id, p]));
  const r = await readChat(f.db, S, T, chat, lines, inChat.size ? inChat : new Map([[TEAM[0]!.id, TEAM[0]!]]));
  const fresh = f.tables.watch_alert.filter((a) => !open.some((o) => o.id === a.id));
  const out: string[] = [];
  if (fresh.length !== c.expect.opened) out.push(`opened ${fresh.length} (${fresh.map((a) => `${a.kind}: ${a.title}`).join("; ")}), wanted ${c.expect.opened}`);
  if (c.expect.kinds && !same(fresh.map((a) => a.kind).sort(), [...c.expect.kinds].sort())) out.push(`kinds ${fresh.map((a) => a.kind).join(", ")}, wanted ${c.expect.kinds.join(", ")}`);
  if (c.expect.resolved !== undefined && r.resolved !== c.expect.resolved) out.push(`closed ${r.resolved}, wanted ${c.expect.resolved}`);
  return out;
}

async function reply(c: ReplyCase): Promise<string[]> {
  forgetClients();
  const now = Date.now();
  const chatId = "15550002001@c.us";
  const client = c.client ?? { name: "Mariam Fawzy", company: "Fawzy Interiors" };
  const last = Math.min(...c.chat.map((m) => m.min_ago));
  const f = fakeDb({
    wa_dm_chat: [{ chat_id: chatId, phone: "15550002001", name: client.name.split(" ")[0], pending_since: iso(now - last * MIN), last_message_at: iso(now - Math.max(last, 2) * MIN), analyzed_at: null, sorry_at: null, away_at: null, claimed_at: null }],
    wa_dm: c.chat.map((m, i) => ({ id: `d${i}`, chat_id: chatId, from_bot: !!m.me, sender_name: m.me ? null : client.name, text: m.text, sent_at: iso(now - m.min_ago * MIN), created_at: iso(now - m.min_ago * MIN) })),
    client: [
      { id: "me", name: client.name, company: client.company ?? null, name_known: true, phone: "15550002001", email: null, wa_lid: null, from_chat: null, timezone: null },
      ...CLIENTS.map((x) => ({ id: x.id, name: x.name, company: x.company, name_known: true, phone: x.phone, email: null, wa_lid: null, from_chat: null, timezone: null })),
    ],
    project: (client.projects ?? []).map((p, i) => ({ id: `p${i}`, client_id: "me", title: p.title, status: p.status, delivered_at: null, created_at: iso(now - (i + 1) * 24 * 60 * MIN) })),
    project_delivery: [],
    bot_draft: [],
    bot_guard_block: [],
  });
  const sent: { chat: string; text: string }[] = [];
  const from = decisions.length;
  try {
    await readDms(f.db, S, T, async (chat, text) => (sent.push({ chat, text }), `s${sent.length}`), now + 120_000);
  } catch (e) {
    // A meeting reaches for Calendly, which isn't here: the decision is what's judged.
    if (!decisions.slice(from).some((d) => d.name === "decide")) return [`failed: ${(e as Error).message}`];
  }
  const d = decisions.slice(from).find((x) => x.name === "decide")?.input;
  if (!d) return ["no decision"];
  const out: string[] = [];
  if (!oneOf(c.expect.action, d.action)) out.push(`action ${d.action}, wanted ${c.expect.action}`);
  const theirs = sent.filter((m) => m.chat === chatId).map((m) => m.text);
  for (const text of theirs) {
    const v = voiceIssues(text);
    if (v.length) out.push(`${v.join(", ")}: ${text}`);
    if (ARABIC.test(text)) out.push(`not English: ${text}`);
  }
  for (const b of f.tables.bot_guard_block ?? []) out.push(`stopped by the check (${(b.reasons as string[]).join(", ")}): ${b.text}`);
  return out;
}

async function booking(c: BookingCase): Promise<string[]> {
  const now = Date.now();
  const act = await decide(
    S,
    {
      group: "iklipse team",
      pending: {},
      lengths: [30, 60],
      people: PEOPLE.map((p) => ({ ref: p.ref, name: p.name, who: p.who, in_group: p.who === "team", has_email: true, zone: "Africa/Cairo" })),
      meetings: [],
      cancelled: [],
      conversation: [{ from: "Sameh", where: "group", at: `${cairo.dayOf(now)} ${cairo.hm(now)}`, text: c.message }],
    },
    cairo,
  );
  if (!act) return ["no answer"];
  const out: string[] = [];
  if (!oneOf(c.expect.action, act.action)) out.push(`action ${act.action}, wanted ${c.expect.action}`);
  const day = c.expect.day !== undefined ? cairo.dayOf(now + c.expect.day * 24 * 60 * MIN) : null;
  if (day && act.date !== day) out.push(`day ${act.date}, wanted ${day}`);
  if (c.expect.time && act.time !== c.expect.time) out.push(`time ${act.time}, wanted ${c.expect.time}`);
  if (c.calendly && c.expect.why && act.date && act.time) {
    const start = cairo.at(act.date, act.time);
    const why = whyNot(start, { span: 30 * MIN, hours: { zone: TZ, rules: c.calendly }, busy: [], offered: [now + 60 * MIN], readUntil: now + 30 * 24 * 60 * MIN, now }, cairo);
    if (why !== c.expect.why) out.push(`reason "${why}", wanted "${c.expect.why}"`);
  }
  return out;
}

// --------------------------------------------------------------- the run --

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const oneCase = args.find((a) => a.startsWith("--case="))?.slice(7);
const dir = join(process.cwd(), "scripts", "bot", "evals", "cases");
const cases = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Case[])
  .filter((c) => (!only || c.kind === only) && (!oneCase || c.id === oneCase));

const priced = (xs: AiCall[]) => xs.reduce((sum, x) => sum + (aiCost({ model: x.model, input: x.input_tokens, output: x.output_tokens, cache_read: x.cache_read_tokens, cache_write: x.cache_write_tokens }) ?? 0), 0);
const money = (n: number) => `$${n.toFixed(4)}`;
const results: { c: Case; fails: string[]; cost: number }[] = [];
for (const c of cases) {
  const before = calls.length;
  let fails: string[];
  try {
    fails = c.kind === "route" ? await route(c) : c.kind === "alerts" ? await alerts(c) : c.kind === "reply" ? await reply(c) : await booking(c);
  } catch (e) {
    fails = [`error: ${(e as Error).message}`];
  }
  const cost = priced(calls.slice(before));
  results.push({ c, fails, cost });
  console.log(`${fails.length ? "FAIL" : "pass"}  ${c.id.padEnd(14)} ${c.lang.padEnd(6)} ${money(cost)}${fails.length ? `\n      ${fails.join("\n      ")}` : ""}`);
}

const passed = results.filter((r) => !r.fails.length).length;
console.log("");
for (const kind of ["route", "alerts", "reply", "booking"]) {
  const mine = results.filter((r) => r.c.kind === kind);
  if (mine.length) console.log(`${kind.padEnd(8)} ${mine.filter((r) => !r.fails.length).length}/${mine.length}  ${money(mine.reduce((s, r) => s + r.cost, 0))}`);
}
const failedCalls = calls.filter((x) => !x.ok).length;
console.log(`\n${passed}/${results.length} passed, ${calls.length} Claude calls${failedCalls ? ` (${failedCalls} failed)` : ""}, ${money(priced(calls))} in all.`);
process.exit(passed === results.length ? 0 : 1);
