// iklipse brain (0119, everything since 0120): Claude on the Agent SDK, its
// own service on the claude-vps server (brain/ in the repo), as the bot's
// one mind on WhatsApp. This function keeps the plumbing (keeping messages,
// voice notes and files read, the team-group gate, alerts, reminders going
// out); everything said to the bot goes to the brain (index.ts): the team's
// new requests, their answers to what the bot asked, orders carried on,
// meetings, clients' details, and (phase 3) clients' private chats. When:
// - BRAIN_ENABLED is on, with BRAIN_URL and BRAIN_SECRET set;
// - the sender's tier reaches the phase (brain_settings): owner, then admins,
//   then members, then clients. The tier comes only from links an admin made
//   (wa_member, wa_member_lid), never from the number on someone's own
//   member card; a client is whoever writes privately and isn't on the team;
// - the message passed the gate (gate.ts), or came privately.
// A brain that doesn't answer in 10 seconds, or answers with an error: the
// person hears the bot is down for a moment, or (fallback_old) the old order
// router answers instead (logged).
//
// Also here, because they must work even when the brain is down or wrong:
// - the kill switch: the owner writes "وقف" or "stop" privately and the brain
//   only reads until "شغّل" or "start";
// - approvals: an action that can't be undone waits in brain_approval until
//   a new message from an owner number says "نعم 4821" / "yes 4821" (its
//   code) within 30 minutes; "لا" / "no" cancels it. Nothing the model writes,
//   and nothing inside a tool's result, ever approves anything.
//
// Requests between this function and the brain are signed both ways with
// BRAIN_SECRET (HMAC-SHA256 over the direction, the time and the body; five
// minutes at most).

import { env, iso, MIN, str, type Db } from "./kit.ts";
import type { Send } from "./people.ts";
import type { Via } from "./gate.ts";

export type Tier = "owner" | "admin" | "member" | "client";
/** The team's tiers: the ones with a profile. */
export type TeamTier = Exclude<Tier, "client">;

export interface BrainSettings {
  phase: number;
  stopped: boolean;
  /** Every WhatsApp number of the super admins (0131 keeps it from owner_users). */
  owner_phones: string[];
  /** The super admins, by account (0131). */
  owner_users?: string[];
  /** The brain down: the old order router answers (else the person hears it's down for a moment). */
  fallback_old: boolean;
  model_owner: string;
  model_member: string;
  model_fast: string;
  max_turns: number;
  member_turns: number;
  run_minutes: number;
  run_cost_usd: number;
  day_cost_usd: number;
}

export interface BrainEnv {
  url: string;
  secret: string;
  enabled: boolean;
}

/** The brain's address, secret and switch (Supabase secrets). */
export const brainEnv = (get: (k: string) => string = (k) => env(k)): BrainEnv => ({
  url: get("BRAIN_URL").replace(/\/+$/, ""),
  secret: get("BRAIN_SECRET"),
  enabled: /^(1|on|true|yes)$/i.test(get("BRAIN_ENABLED")),
});

/** Set up and switched on: a secret shorter than 32 characters doesn't count. */
export const brainOn = (e: BrainEnv) => e.enabled && /^https:\/\//.test(e.url) && e.secret.length >= 32;

/** The brain's settings; null before 0119 runs. */
export async function brainSettings(db: Db): Promise<BrainSettings | null> {
  const { data, error } = await db.from("brain_settings").select("*").eq("id", 1).maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  return {
    phase: Number(r.phase) || 0,
    stopped: r.stopped === true,
    owner_phones: ((r.owner_phones ?? []) as unknown[]).map((p) => digits(p)).filter(Boolean),
    owner_users: ((r.owner_users ?? []) as unknown[]).map((u) => str(u)).filter(Boolean),
    fallback_old: r.fallback_old === true,
    model_owner: str(r.model_owner) || "claude-opus-5-5",
    model_member: str(r.model_member) || "claude-sonnet-5-5",
    model_fast: str(r.model_fast) || "claude-haiku-5-5",
    max_turns: Number(r.max_turns) || 40,
    member_turns: Number(r.member_turns) || 12,
    run_minutes: Number(r.run_minutes) || 15,
    run_cost_usd: Number(r.run_cost_usd) || 5,
    day_cost_usd: Number(r.day_cost_usd) || 40,
  };
}

const digits = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "").replace(/\D/g, "");

// ------------------------------------------------------------------ tiers --

/** Who wrote, as the brain knows them. A client's id is "client:<their private chat>". */
export interface Asker {
  id: string;
  name: string;
  tier: Tier;
  admin: boolean;
  /** A client's row in Clients, when iklipse has them. */
  clientId?: string | null;
}

/** A client's (or a stranger's) asker id: by their private chat, the one thing they write from. */
export const clientKey = (chatId: string) => `client:${chatId}`;

/** Someone who isn't on the team writing privately: a client, as the brain answers them (phase 3). */
export function clientAsker(chatId: string, c: { id: string | null; name: string }): Asker {
  return { id: clientKey(chatId), name: c.name, tier: "client", admin: false, clientId: c.id };
}

/** The numbers an admin linked to someone (wa_member). */
async function linkedPhones(db: Db, userId: string): Promise<string[]> {
  const { data } = await db.from("wa_member").select("phone").eq("user_id", userId);
  return ((data ?? []) as { phone: string | null }[]).map((w) => digits(w.phone)).filter(Boolean);
}

/**
 * The tier of whoever wrote, from their WhatsApp number (as WhatsApp gives it,
 * never a number typed into iklipse) or their hidden-number id: only through
 * the links an admin made. The owner: one of the owner numbers, and linked to
 * the account (a hidden number: one of the numbers linked to it). null: not
 * someone the brain answers (no link, left the team, a guest).
 */
export async function tierOf(db: Db, s: BrainSettings, who: { phone: string | null; lid: string | null }): Promise<Asker | null> {
  const phone = digits(who.phone);
  const lid = str(who.lid).endsWith("@lid") ? str(who.lid) : "";
  const [byPhone, byLid] = await Promise.all([
    phone ? db.from("wa_member").select("user_id").eq("phone", phone).maybeSingle() : Promise.resolve({ data: null }),
    lid ? db.from("wa_member_lid").select("user_id").eq("lid", lid).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const userId = str((byPhone.data as { user_id?: string } | null)?.user_id) || str((byLid.data as { user_id?: string } | null)?.user_id);
  if (!userId) return null;
  const { data: p } = await db.from("profile").select("id, display_name, username, role, is_active").eq("id", userId).maybeSingle();
  if (!p?.is_active || (p.role !== "admin" && p.role !== "member")) return null;
  const phones = phone && byPhone.data ? [phone] : await linkedPhones(db, userId);
  const owner = (s.owner_users ?? []).includes(String(p.id)) || phones.some((x) => s.owner_phones.includes(x));
  const admin = p.role === "admin";
  return { id: String(p.id), name: str(p.display_name) || str(p.username) || "Someone", admin, tier: owner ? "owner" : admin ? "admin" : "member" };
}

/** The phase lets this tier in: 0 the owner, 1 admins too, 2 members too, 3 clients too. */
export const reaches = (s: Pick<BrainSettings, "phase">, tier: Tier) =>
  tier === "owner" || (tier === "admin" ? s.phase >= 1 : tier === "member" ? s.phase >= 2 : s.phase >= 3);

/**
 * The tier of a run's asker now (a tool call, an approval): they may have
 * left, lost admin, or stopped being an owner since. null: not anymore.
 */
export async function tierNow(db: Db, s: BrainSettings, asker: string): Promise<Asker | null> {
  const { data: p } = await db.from("profile").select("id, display_name, username, role, is_active").eq("id", asker).maybeSingle();
  if (!p?.is_active || (p.role !== "admin" && p.role !== "member")) return null;
  const owner = (s.owner_users ?? []).includes(String(p.id)) || (await linkedPhones(db, asker)).some((x) => s.owner_phones.includes(x));
  const admin = p.role === "admin";
  return { id: String(p.id), name: str(p.display_name) || str(p.username) || "Someone", admin, tier: owner ? "owner" : admin ? "admin" : "member" };
}

/** A message from one of the owner numbers: the number WhatsApp gives, or a hidden number an admin linked to an owner's account. */
/** The numbers someone writes from: the one WhatsApp gives, or (a hidden number) the ones linked to their account. */
async function senderPhones(db: Db, who: { phone: string | null; lid: string | null }): Promise<string[]> {
  const phone = digits(who.phone);
  if (phone) return [phone];
  const lid = str(who.lid);
  if (!lid.endsWith("@lid")) return [];
  const { data } = await db.from("wa_member_lid").select("user_id").eq("lid", lid).maybeSingle();
  return data?.user_id ? await linkedPhones(db, String(data.user_id)) : [];
}

export async function fromOwner(db: Db, s: BrainSettings, who: { phone: string | null; lid: string | null }): Promise<boolean> {
  const phone = digits(who.phone);
  if (phone) return s.owner_phones.includes(phone);
  const lid = str(who.lid);
  if (!lid.endsWith("@lid")) return false;
  const { data } = await db.from("wa_member_lid").select("user_id").eq("lid", lid).maybeSingle();
  return !!data?.user_id && (await linkedPhones(db, String(data.user_id))).some((x) => s.owner_phones.includes(x));
}

// ---------------------------------------------------------------- signing --

/** to-brain: this function to the brain; to-bot: the brain to this function. A request can't be sent back the other way. */
export type Dir = "to-brain" | "to-bot";
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** The x-brain-signature header for a body: "t=<seconds>,v1=<hex>". */
export async function signature(secret: string, dir: Dir, body: string, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmac(secret, `${dir}.${t}.${body}`)}`;
}

function sameText(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The body was signed with the secret, for this direction, in the last five minutes. */
export async function signedBy(secret: string, dir: Dir, body: string, header: string | null, now = Date.now()) {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(str(header));
  if (!m || secret.length < 32) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > 300) return false;
  return sameText(await hmac(secret, `${dir}.${m[1]}.${body}`), m[2]!);
}

export async function sha256(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** JSON with its keys sorted: the same input is the same text (an approval's input_hash). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A signed POST to the brain. */
export async function toBrainPost(e: BrainEnv, path: string, payload: unknown, f: typeof fetch = fetch, timeoutMs = 10_000) {
  const body = JSON.stringify(payload);
  return await f(`${e.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-signature": await signature(e.secret, "to-brain", body) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// ---------------------------------------------------------------- a message --

export interface Forward {
  /** The WhatsApp message (several sent at once: the last one's id). */
  id: string;
  chatId: string;
  where: "team" | "client" | "private";
  via?: Via;
  text: string;
  /** What it replies to, as kept. */
  quoted: string | null;
  quotedId?: string | null;
  asker: Asker;
  /** Where the answer goes: this chat, or (from a client group) their private chat. */
  replyChat: string;
  chatName?: string | null;
}

/**
 * Hands the message to the brain: a run kept first (once per message: the
 * same message twice is one run), then the brain told, signed. sent: the
 * brain has it. duplicate: it was handled already, nothing more to do.
 * fallback: the order router takes it (the brain is down, slow, or 0119
 * hasn't run).
 */
export async function forward(db: Db, e: BrainEnv, o: Forward, f: typeof fetch = fetch, timeoutMs = 10_000): Promise<"sent" | "duplicate" | "fallback"> {
  const { data: run, error } = await db
    .from("brain_run")
    .insert({
      message_id: o.id,
      chat_id: o.chatId,
      reply_chat: o.replyChat,
      // A client has no profile: by their Clients row (client_id) and their chat.
      asker: o.asker.tier === "client" ? null : o.asker.id,
      asker_name: o.asker.name,
      tier: o.asker.tier,
      client_id: o.asker.tier === "client" ? (o.asker.clientId ?? null) : null,
      quoted_id: o.quotedId ?? null,
      via: o.where === "private" ? "private" : o.via ?? null,
      request: o.text.slice(0, 4000),
      status: "queued",
    })
    .select("id")
    .single();
  if (error?.code === "23505") return "duplicate";
  if (error || !run) {
    if (!/brain_run|does not exist|schema cache/i.test(error?.message ?? "")) console.error("brain run", error?.message);
    return "fallback";
  }
  const runId = String((run as { id: string }).id);
  const fail = async (why: string) => {
    console.error(JSON.stringify({ ev: "brain.fallback", run: runId, why }));
    await db.from("brain_run").update({ status: "fallback", error: why.slice(0, 300), finished_at: iso() }).eq("id", runId);
    return "fallback" as const;
  };
  // What was in its files, read out (files.ts): a voice note is already the text.
  const { data: files } = await db.from("wa_file").select("kind, name, text").eq("id", o.id);
  const payload = {
    run_id: runId,
    message_id: o.id,
    chat_id: o.chatId,
    reply_chat: o.replyChat,
    where: o.where,
    chat_name: o.chatName ?? null,
    via: o.where === "private" ? "private" : o.via ?? null,
    sender: { id: o.asker.id, name: o.asker.name, tier: o.asker.tier },
    text: o.text,
    quoted: o.quoted ? { id: o.quotedId ?? null, text: o.quoted.slice(0, 4000) } : null,
    files: ((files ?? []) as { kind: string; name: string | null; text: string | null }[])
      .filter((x) => str(x.text))
      .map((x) => ({ kind: x.kind, name: x.name, text: str(x.text).slice(0, 60_000) })),
    sent_at: iso(),
  };
  try {
    const res = await toBrainPost(e, "/message", payload, f, timeoutMs);
    if (!res.ok) return await fail(`brain answered ${res.status}`);
    return "sent";
  } catch (err) {
    return await fail((err as Error).name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : (err as Error).message);
  }
}

/**
 * An edit of a message the brain had: a correction of that run, never a new
 * one (the brain redoes only what the change needs; what was already done
 * isn't done twice). false: the brain never had it.
 */
export async function forwardEdit(db: Db, e: BrainEnv, o: { id: string; text: string }, f: typeof fetch = fetch): Promise<boolean> {
  const { data: run } = await db.from("brain_run").select("id, chat_id, reply_chat, asker, asker_name, tier, via, edits, status").eq("message_id", o.id).maybeSingle();
  if (!run || run.status === "fallback") return false;
  const edits = (Number(run.edits) || 0) + 1;
  await db.from("brain_run").update({ edits }).eq("id", run.id);
  try {
    const res = await toBrainPost(e, "/message", {
      run_id: run.id,
      message_id: o.id,
      chat_id: run.chat_id,
      reply_chat: run.reply_chat,
      sender: { id: run.asker ?? clientKey(run.reply_chat), name: run.asker_name, tier: run.tier },
      via: run.via,
      text: o.text,
      edit: edits,
      sent_at: iso(),
    }, f);
    if (!res.ok) console.error(JSON.stringify({ ev: "brain.edit_failed", run: run.id, status: res.status }));
  } catch (err) {
    console.error(JSON.stringify({ ev: "brain.edit_failed", run: run.id, why: (err as Error).message }));
  }
  return true;
}

// ------------------------------------------------------- the owner's words --

export type OwnerWord = { kind: "stop" } | { kind: "start" } | { kind: "yes"; code: string } | { kind: "no"; code: string | null };

/** Arabic and Persian digits as 0-9, no vowel marks or stretching, every alef as ا, lower case, one space. */
function plainWords(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The owner's words to the brain itself, the whole message only: "وقف" /
 * "stop", "شغّل" / "start", "نعم 4821" / "yes 4821" (also ok, اه, ايوه),
 * "لا" / "no" (with the code, or the latest request).
 */
export function ownerWord(text: string): OwnerWord | null {
  const t = plainWords(text);
  if (/^(وقف|stop)$/.test(t)) return { kind: "stop" };
  if (/^(شغل|start)$/.test(t)) return { kind: "start" };
  const yes = /^(نعم|اه|ايوه|ايوا|تمام|yes|ok|okay)\s?(\d{4})$/.exec(t);
  if (yes) return { kind: "yes", code: yes[2]! };
  const no = /^(لا|no)(?:\s?(\d{4}))?$/.exec(t);
  if (no) return { kind: "no", code: no[2] ?? null };
  return null;
}

// ---------------------------------------------------------------- approvals --

/** How long the owner has to answer. */
export const APPROVAL_MS = 30 * MIN;

export interface ApprovalRow {
  id: string;
  run_id: string | null;
  chat_id: string;
  message_id: string | null;
  tool: string;
  input: Record<string, unknown>;
  input_hash: string;
  what: string;
  why: string | null;
  detail: string | null;
  code_hash: string;
  /** Who answers its code (an admin's own change); null: the owner. */
  approver_phones: string[] | null;
  status: string;
  expires_at: string;
  created_at: string;
}

const codeHash = (id: string, code: string) => sha256(`${id}:${code}`);

function fourDigits() {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0]! % 10_000).padStart(4, "0");
}

/** Where the owner is written to: each owner number's private chat. */
const ownerChats = (s: BrainSettings) => s.owner_phones.map((p) => `${p}@c.us`);

/**
 * An action held for the owner's OK: kept with its exact input and a code
 * no other waiting request has, and the owner told what, why, who asked, the
 * exact text or diff, and how to answer. While the brain is stopped nothing
 * is asked (it only reads).
 */
export async function askOwner(
  db: Db,
  s: BrainSettings,
  send: Send,
  x: {
    run: { id: string; reply_chat: string; message_id: string; asker_name: string | null; tier: string } | null;
    tool: string;
    input: Record<string, unknown>;
    what: string;
    why?: string | null;
    detail?: string | null;
    /** Who answers the code instead of the owner (an admin's own change to the system): their numbers. */
    approvers?: string[];
  },
): Promise<{ id: string } | { error: string }> {
  if (s.stopped) return { error: "The brain is stopped: it only reads until the super admin says start." };
  const approvers = [...new Set((x.approvers ?? []).map(digits).filter(Boolean))];
  if (!approvers.length && !s.owner_phones.length) return { error: "No super admin is set (Alerts > Brain), so nobody can OK it." };
  const { data: waiting } = await db.from("brain_approval").select("id, code_hash").eq("status", "waiting").gt("expires_at", iso());
  const id = crypto.randomUUID();
  let code = fourDigits();
  for (let i = 0; i < 20; i++) {
    const clash = await Promise.all(((waiting ?? []) as { id: string; code_hash: string }[]).map(async (w) => (await codeHash(w.id, code)) === w.code_hash));
    if (!clash.some(Boolean)) break;
    code = fourDigits();
  }
  const row = {
    id,
    run_id: x.run?.id ?? null,
    chat_id: x.run?.reply_chat ?? ownerChats(s)[0]!,
    message_id: x.run?.message_id ?? null,
    tool: x.tool,
    input: x.input,
    input_hash: await sha256(canonical(x.input)),
    what: x.what.slice(0, 500),
    why: x.why ? x.why.slice(0, 500) : null,
    detail: x.detail ? x.detail.slice(0, 6000) : null,
    code_hash: await codeHash(id, code),
    approver_phones: approvers.length ? approvers : null,
    status: "waiting",
    created_at: iso(),
    expires_at: iso(Date.now() + APPROVAL_MS),
  };
  const { error } = await db.from("brain_approval").insert(row);
  if (error) return { error: "Couldn't keep the request for the OK." };
  const text = [
    `OK needed (code ${code})`,
    `What: ${row.what}`,
    ...(row.why ? [`Why: ${row.why}`] : []),
    ...(x.run ? [`Asked by: ${x.run.asker_name ?? "someone"} (${x.run.tier})`] : []),
    ...(row.detail ? ["", row.detail.slice(0, 3000)] : []),
    "",
    `Reply "yes ${code}" to approve, "no" to cancel. It expires in 30 minutes.`,
  ].join("\n");
  let asked: string | null = null;
  for (const chat of approvers.length ? approvers.map((p) => `${p}@c.us`) : ownerChats(s)) {
    try {
      asked ??= await send(chat, text);
    } catch (e) {
      console.error(JSON.stringify({ ev: "brain.ask_failed", approval: id, why: (e as Error).message }));
    }
  }
  if (!asked) {
    await db.from("brain_approval").update({ status: "failed", result: "The OK couldn't be asked for on WhatsApp." }).eq("id", id);
    return { error: "Couldn't ask for the OK on WhatsApp." };
  }
  // An admin's own change: the owner hears of it (no code: it isn't theirs to answer).
  if (approvers.length && !approvers.some((p) => s.owner_phones.includes(p))) {
    const fyi = `${x.run?.asker_name ?? "An admin"} asked me to ${row.what}; the OK is theirs (a code went to them).`;
    for (const chat of ownerChats(s)) await send(chat, fyi).catch(() => null);
  }
  await db.from("brain_approval").update({ asked_message_id: asked }).eq("id", id);
  return { id };
}

/** The waiting request this code is for (and whether it ran out). */
async function byCode(db: Db, code: string): Promise<{ row: ApprovalRow; expired: boolean } | null> {
  const { data } = await db.from("brain_approval").select("*").in("status", ["waiting", "expired"]).gt("created_at", iso(Date.now() - 2 * APPROVAL_MS)).order("created_at", { ascending: false }).limit(50);
  for (const row of (data ?? []) as ApprovalRow[]) {
    if ((await codeHash(row.id, code)) !== row.code_hash) continue;
    return { row, expired: row.status === "expired" || Date.parse(row.expires_at) <= Date.now() };
  }
  return null;
}

/**
 * The owner's words, in their private chat with the bot: the kill switch,
 * and OKs. Only a new message (never an edit), only from an owner number;
 * an admin's only for the OKs of their own changes to the system.
 * true: it was one of them, and handled. approved: carries out what was OK'd
 * (brain-tools.ts); told: the brain hears about the switch.
 */
export async function ownerSays(
  db: Db,
  s: BrainSettings | null,
  send: Send,
  o: { id: string; chatId: string; phone: string | null; lid: string | null; text: string; quotedId: string | null },
  hooks: { approved: (id: string) => Promise<void>; told: (stopped: boolean) => Promise<void> },
): Promise<boolean> {
  if (!s) return false;
  const w = ownerWord(o.text);
  if (!w) return false;
  const owner = await fromOwner(db, s, o);
  // The switch: the owner or any admin (the role in iklipse, by their linked number).
  const admin = owner || (await tierOf(db, s, { phone: o.phone, lid: o.lid }))?.admin === true;
  if ((w.kind === "stop" || w.kind === "start") && !admin) return false;
  // A code still waiting from before (the brain no longer asks for them): the owner answers any; an admin only their own.
  const mine = owner ? [] : await senderPhones(db, o);
  const may = (row: ApprovalRow) => owner || !!row.approver_phones?.some((p) => mine.includes(p));
  if (!owner && w.kind !== "stop" && w.kind !== "start") {
    if (!mine.length) return false;
    const { data: theirs } = await db.from("brain_approval").select("id").eq("status", "waiting").overlaps("approver_phones", mine).limit(1);
    const coded = w.kind === "yes" || w.code ? await byCode(db, w.code ?? "") : null;
    if (!theirs?.length && !(coded && may(coded.row))) return false;
  }
  const say = (text: string) => send(o.chatId, text, o.id);
  if (w.kind === "stop" || w.kind === "start") {
    // "stop" as a reply to something (an order's report) is about that, not the brain.
    if (o.quotedId) return false;
    const stopped = w.kind === "stop";
    await db.from("brain_settings").update({ stopped, stopped_at: stopped ? iso() : null, stopped_by: stopped ? `${owner ? "super admin" : "admin"} ${digits(o.phone) || "lid"}` : null, updated_at: iso() }).eq("id", 1);
    await hooks.told(stopped).catch((e) => console.error(JSON.stringify({ ev: "brain.control_failed", why: (e as Error).message })));
    await say(
      stopped ? "Stopped every run. I only read now, nothing changes until you say start." : "Back on.",
    );
    return true;
  }
  if (w.kind === "yes") {
    const found = await byCode(db, w.code);
    const hit = found && may(found.row) ? found : null;
    if (!hit) {
      await say(`Nothing is waiting with code ${w.code}.`);
      return true;
    }
    if (hit.expired) {
      await db.from("brain_approval").update({ status: "expired" }).eq("id", hit.row.id).eq("status", "waiting");
      await say(`Code ${w.code} ran out (30 minutes). Ask again.`);
      return true;
    }
    const { data: took } = await db
      .from("brain_approval")
      .update({ status: "approved", decided_at: iso(), decided_by: digits(o.phone) || str(o.lid), decided_message_id: o.id })
      .eq("id", hit.row.id)
      .eq("status", "waiting")
      .select("id");
    if (!took?.length) return true;
    await say(`OK, doing it: ${hit.row.what}`);
    await hooks.approved(hit.row.id);
    return true;
  }
  // No: the one with that code, else the latest still waiting.
  let row: ApprovalRow | null = null;
  if (w.code) row = (await byCode(db, w.code))?.row ?? null;
  else {
    const { data } = await db.from("brain_approval").select("*").eq("status", "waiting").gt("expires_at", iso()).order("created_at", { ascending: false }).limit(10);
    row = ((data ?? []) as ApprovalRow[]).find(may) ?? null;
  }
  if (row && !may(row)) row = null;
  // A plain "no" with nothing waiting is an answer to something else.
  if (!row) {
    if (!w.code) return false;
    await say(`Nothing is waiting with code ${w.code}.`);
    return true;
  }
  const { data: took } = await db
    .from("brain_approval")
    .update({ status: "refused", decided_at: iso(), decided_by: digits(o.phone) || str(o.lid), decided_message_id: o.id })
    .eq("id", row.id)
    .eq("status", "waiting")
    .select("id");
  if (!took?.length) return true;
  await say(`Cancelled: ${row.what}`);
  if (row.chat_id && row.chat_id !== o.chatId && !ownerChats(s).includes(row.chat_id)) await send(row.chat_id, `${owner ? "The super admin said no" : "Cancelled"}: ${row.what}`, row.message_id).catch(() => null);
  return true;
}
