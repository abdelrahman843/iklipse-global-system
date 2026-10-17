// gmail — each person connects any number of Gmail accounts (0052), with the
// same Google OAuth client as the iklipse-system calendar. Used for the Mail
// page (read, reply, write, archive) and, for the one account an admin picks,
// to send the notification emails.
//
// POST (login token) { action, ... }:
//   connect { returnTo }                          -> { url }
//   disconnect { account }                        -> { ok }
//   summary                                       -> { accounts: [{ id, email, unread }] }
//   list { accounts?, folder?, q?, pages?, shared? } -> { threads, next, errors }
//
// thread / send / modify / trash / attachment also work on an account shared
// with the caller (0053), within what the owner allowed (see Box below);
// list { shared: true } lists those accounts instead of the caller's own.
//   thread { account, id }                        -> { thread }
//   send { account, to, cc?, subject, text, threadId?, inReplyTo?, references? } -> { id, threadId }
//   modify { account, ids, add?, remove? }        -> { ok }   (thread labels: UNREAD, INBOX, STARRED)
//   trash { account, ids }                        -> { ok }
//   attachment { account, message, id }           -> { data (base64url), size }
// GET  /gmail/callback?code&state                 (Google sends the browser here)
// POST /gmail/notify { account, to, subject, text } with X-Iklipse-Secret
//      (only the database calls this: public._send_email)
// POST /gmail/invite { account, to: [...], subject, text, ics?, method? } with X-Iklipse-Secret
//      (a Zoom meeting's invitation, from the zoom and whatsapp-bot functions: _shared/invite.ts)
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_WEBHOOK_SECRET,
// optional GMAIL_REDIRECT_URI (default <project>/functions/v1/gmail/callback,
// which must be an authorized redirect URI of the Google OAuth client).
// Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, same, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("GMAIL_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/gmail/callback`;
const NOTIFY_SECRET = Deno.env.get("GMAIL_WEBHOOK_SECRET") ?? "";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const SCOPES = ["openid", "email", "profile", GMAIL_SCOPE];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_ACCOUNTS = 10;
const PAGE = 20;
const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

interface Account {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
}

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

// --------------------------------------------------------------- tokens --

async function tokenCall(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google token: ${data.error ?? res.status}`);
  return data as GoogleTokens;
}

const expiry = (t: GoogleTokens) => new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString();

/** A working access token for the account, refreshed if needed. */
async function token(db: SupabaseClient, a: Account, force = false): Promise<string> {
  if (!force && a.access_token && a.token_expiry && Date.parse(a.token_expiry) > Date.now() + 30_000) return a.access_token;
  let t: GoogleTokens;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: a.refresh_token });
  } catch (e) {
    // Access was removed (or, while the Google app is in Testing, the weekly expiry).
    if (/invalid_grant/.test((e as Error).message)) {
      await db.from("gmail_account").delete().eq("id", a.id).eq("refresh_token", a.refresh_token);
      throw new HttpError(409, `${a.email} needs to be connected again`);
    }
    // Made by another Google OAuth client (the app's client was replaced): the
    // login has to be connected again. Kept, in case the client ID is the mistake.
    if (/unauthorized_client|invalid_client/.test((e as Error).message)) {
      throw new HttpError(409, `${a.email} needs to be connected again (Connected accounts)`);
    }
    throw new HttpError(502, "Couldn't reach Google. Try again.");
  }
  const patch = {
    access_token: t.access_token,
    token_expiry: expiry(t),
    updated_at: new Date().toISOString(),
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
  };
  await db.from("gmail_account").update(patch).eq("id", a.id).eq("refresh_token", a.refresh_token);
  Object.assign(a, patch);
  return t.access_token;
}

/** One Gmail API call for the account (retried once with a fresh token). */
async function gmail<T>(db: SupabaseClient, a: Account, path: string, init: RequestInit = {}): Promise<T> {
  const go = async (tok: string) =>
    fetch(`${API}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tok}`, "Content-Type": "application/json" } });
  let res = await go(await token(db, a));
  if (res.status === 401) res = await go(await token(db, a, true));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message ?? `status ${res.status}`;
    if (res.status === 403 && /insufficient/i.test(msg)) throw new HttpError(409, `${a.email} needs to be connected again (Gmail access wasn't allowed)`);
    throw new HttpError(res.status === 404 ? 404 : 502, `Gmail: ${msg}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

async function myAccount(db: SupabaseClient, userId: string, id: unknown): Promise<Account> {
  if (typeof id !== "string") throw new HttpError(400, "Pick an account");
  const { data } = await db.from("gmail_account").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "That Gmail account isn't connected");
  return data as Account;
}

// --------------------------------------------------------------- sharing --
// An account is either mine or shared with me (0053, gmail_share). A Box says
// what I may do with it; every action below checks it.

type Role = "owner" | "full" | "read_send" | "read" | "send" | "custom";

interface Box {
  a: Account;
  role: Role;
  /** Reads the whole mailbox (else only picked emails and listed senders). */
  readAll: boolean;
  /** any: new mail and replies; reply: replies in emails I can read; none. */
  send: "any" | "reply" | "none";
  /** Archive, star, mark read / unread, delete. */
  manage: boolean;
  senders: string[];
  threads: Set<string>;
  /** The picked emails, newest share first (the list pages through them). */
  picks: string[];
}

interface ShareRow {
  id: string;
  access: Exclude<Role, "owner">;
  senders: string[] | null;
  can_reply: boolean;
  account: Account;
  owner: { is_active: boolean } | null;
  threads: { thread_id: string; shared_at: string }[] | null;
}

function toBox(a: Account, role: Role, s?: ShareRow): Box {
  const readAll = role === "owner" || role === "full" || role === "read_send" || role === "read";
  const send = role === "owner" || role === "full" || role === "read_send" || role === "send" ? "any" : role === "custom" && s?.can_reply ? "reply" : "none";
  const picks = [...(s?.threads ?? [])].sort((x, y) => y.shared_at.localeCompare(x.shared_at)).map((t) => t.thread_id);
  return {
    a,
    role,
    readAll,
    send,
    manage: role === "owner" || role === "full",
    senders: s?.senders ?? [],
    threads: new Set(picks),
    picks,
  };
}

const SHARE_SELECT = "id, access, senders, can_reply, account:account_id(*), owner:owner_id(is_active), threads:gmail_share_thread(thread_id, shared_at)";

/** Mine, or shared with me: what I may do with this account. */
async function box(db: SupabaseClient, userId: string, id: unknown): Promise<Box> {
  if (typeof id !== "string") throw new HttpError(400, "Pick an account");
  const { data: own } = await db.from("gmail_account").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (own) return toBox(own as Account, "owner");
  const { data } = await db.from("gmail_share").select(SHARE_SELECT).eq("account_id", id).eq("grantee_id", userId).maybeSingle();
  const s = data as unknown as ShareRow | null;
  if (!s?.account || !s.owner?.is_active) throw new HttpError(404, "That Gmail account isn't shared with you (any more)");
  return toBox(s.account, s.access, s);
}

/** Every account shared with me. */
async function sharedBoxes(db: SupabaseClient, userId: string): Promise<Box[]> {
  const { data } = await db.from("gmail_share").select(SHARE_SELECT).eq("grantee_id", userId);
  return ((data ?? []) as unknown as ShareRow[]).filter((s) => s.account && s.owner?.is_active).map((s) => toBox(s.account, s.access, s));
}

// ------------------------------------------------------------ addresses --
// Address lists are parsed, not pattern-matched: a quoted name or a comment
// must never hide a recipient, or pass for a listed sender.

const ADDR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

interface Mailbox {
  name: string;
  addr: string;
}

/**
 * "Ann <a@b.com>, \"Doe, Jo\" <j@d.com>; c@d.com" -> mailboxes. strict: a
 * part that isn't a plain address is an error (what people type); else it is
 * skipped (headers of mail received).
 */
function mailboxes(raw: string, strict: string | false): Mailbox[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const ch of raw.replace(/[\r\n]+/g, " ")) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: Mailbox[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    // The address is the last <...>; anything before it is the name.
    const m = /^(.*)<([^<>]*)>$/.exec(p);
    const addr = (m ? m[2]! : p).trim();
    if (!ADDR.test(addr)) {
      if (strict) throw new HttpError(400, `${strict}: "${p.slice(0, 80)}" isn't an email address`);
      continue;
    }
    const name = m ? m[1]!.replace(/["\\<>]/g, "").trim() : "";
    out.push({ name, addr });
  }
  if (strict && out.length > 50) throw new HttpError(400, `${strict}: up to 50 addresses`);
  return out;
}

/** Mailboxes back into a header value (names quoted, or encoded when not ASCII). */
const mailboxHeader = (list: Mailbox[]) =>
  list.map((x) => (x.name ? `${/^[\x20-\x7e]*$/.test(x.name) ? `"${x.name}"` : word(x.name)} <${x.addr}>` : x.addr)).join(", ");

/** The one address a From header names (null when it names none, or several). */
function fromAddress(from: string): string | null {
  const list = mailboxes(from, false);
  return list.length === 1 ? list[0]!.addr.toLowerCase() : null;
}

/** From one of the senders listed ("a@b.com" exactly, "@b.com" the whole domain). */
function fromListed(from: string, senders: string[]): boolean {
  const addr = fromAddress(from);
  if (!addr) return false;
  return senders.some((s) => (s.startsWith("@") ? addr.endsWith(s) : addr === s));
}

const META_ALL = ["From", "To", "Cc", "Reply-To", "Subject"].map((h) => `metadataHeaders=${h}`).join("&");
const threadMeta = (db: SupabaseClient, a: Account, id: string) =>
  gmail<{ id: string; messages?: GMessage[] }>(db, a, `/threads/${encodeURIComponent(id)}?format=metadata&${META_ALL}`);

/** May I read this conversation? (msgs: its messages, when already fetched.) */
async function canRead(db: SupabaseClient, bx: Box, threadId: string, msgs?: GMessage[]): Promise<boolean> {
  if (bx.readAll || bx.threads.has(threadId)) return true;
  if (!bx.senders.length) return false;
  const list = msgs ?? (await threadMeta(db, bx.a, threadId)).messages ?? [];
  // Spam and trash don't count: anyone can put any name in From.
  return list.some(
    (m) => !m.labelIds?.some((l) => l === "SPAM" || l === "TRASH") && fromListed(head(m.payload?.headers, "From"), bx.senders),
  );
}

/** What others do in an account shared with them, for the owner to see. */
async function logShared(db: SupabaseClient, bx: Box, actor: string, action: string, detail?: string) {
  if (bx.role === "owner") return;
  await db.from("gmail_share_log").insert({ account_id: bx.a.id, actor_id: actor, action, detail: detail ? detail.slice(0, 300) : null });
}

// ------------------------------------------------------------- messages --

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

const head = (h: Header[] | undefined, name: string) => h?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function fromB64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const toB64url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeText(data: string, contentType: string): string {
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(fromB64url(data));
  } catch {
    return new TextDecoder().decode(fromB64url(data));
  }
}

interface Parsed {
  text: string | null;
  html: string | null;
  attachments: { id: string; name: string; mime: string; size: number }[];
}

function walk(p: Part, out: Parsed) {
  const mime = (p.mimeType ?? "").toLowerCase();
  if (p.filename && p.body?.attachmentId) {
    out.attachments.push({ id: p.body.attachmentId, name: p.filename, mime, size: p.body.size ?? 0 });
  } else if (mime === "text/plain" && p.body?.data && out.text === null) {
    out.text = decodeText(p.body.data, head(p.headers, "Content-Type"));
  } else if (mime === "text/html" && p.body?.data && out.html === null) {
    out.html = decodeText(p.body.data, head(p.headers, "Content-Type"));
  }
  for (const c of p.parts ?? []) walk(c, out);
}

function summary(m: GMessage) {
  const h = m.payload?.headers;
  return {
    id: m.id,
    from: head(h, "From"),
    to: head(h, "To"),
    cc: head(h, "Cc"),
    subject: head(h, "Subject"),
    date: Number(m.internalDate ?? 0),
    snippet: m.snippet ?? "",
    unread: m.labelIds?.includes("UNREAD") ?? false,
    labels: m.labelIds ?? [],
    messageId: head(h, "Message-ID") || head(h, "Message-Id"),
    references: head(h, "References"),
  };
}

const FOLDERS: Record<string, string | null> = { inbox: "INBOX", sent: "SENT", starred: "STARRED", all: null };
const META = ["From", "To", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");

async function listThreads(db: SupabaseClient, a: Account, folder: string, q: string, page: string | undefined) {
  const params = new URLSearchParams({ maxResults: String(PAGE) });
  // "all" is no label at all (every folder but spam and trash).
  const label = folder in FOLDERS ? FOLDERS[folder] : "INBOX";
  if (label) params.set("labelIds", label);
  if (q) params.set("q", q.slice(0, 2000));
  if (page) params.set("pageToken", page);
  const list = await gmail<{ threads?: { id: string }[]; nextPageToken?: string }>(db, a, `/threads?${params}`);
  const threads = await Promise.all((list.threads ?? []).map((t) => threadSummary(db, a, t.id, folder)));
  return { threads, next: list.nextPageToken ?? null };
}

/** One conversation's line in the list. */
async function threadSummary(db: SupabaseClient, a: Account, id: string, folder: string) {
  const th = await gmail<{ id: string; messages?: GMessage[] }>(db, a, `/threads/${encodeURIComponent(id)}?format=metadata&${META}`);
  const msgs = (th.messages ?? []).map(summary);
  const last = msgs[msgs.length - 1];
  const people = [...new Set(msgs.map((m) => (folder === "sent" ? m.to : m.from)))];
  return {
    account: a.id,
    accountEmail: a.email,
    id: th.id,
    subject: msgs[0]?.subject ?? "",
    people,
    snippet: last?.snippet ?? "",
    date: last?.date ?? 0,
    count: msgs.length,
    unread: msgs.some((m) => m.unread),
    starred: msgs.some((m) => m.labels.includes("STARRED")),
    inInbox: msgs.some((m) => m.labels.includes("INBOX")),
  };
}

/**
 * A shared account I can't read whole: the conversations with the senders
 * listed (Gmail search, paged by Gmail) and the ones the owner picked for me
 * (newest share first, PAGE at a time). Inbox and All mail show both,
 * Starred the starred ones; there is no Sent. The page token carries both
 * positions: { s: Gmail's token (null = done), p: next pick (null = done) }.
 */
async function listLimited(db: SupabaseClient, bx: Box, folder: string, q: string, page: string | undefined) {
  type Line = Awaited<ReturnType<typeof threadSummary>>;
  if (folder === "sent") return { threads: [] as Line[], next: null };
  let at: { s: string | null | undefined; p: number | null } = { s: undefined, p: 0 };
  if (page) {
    try {
      at = JSON.parse(page);
    } catch {
      return { threads: [] as Line[], next: null };
    }
  }
  const out: Line[] = [];
  let nextS: string | null = null;
  if (bx.senders.length && at.s !== null) {
    const from = `from:(${bx.senders.map((s) => (s.startsWith("@") ? s.slice(1) : s)).join(" OR ")})`;
    const r = await listThreads(db, bx.a, folder === "starred" ? "starred" : "all", [from, q].filter(Boolean).join(" "), at.s);
    out.push(...r.threads.filter((t) => t.people.some((p) => fromListed(p, bx.senders))));
    nextS = r.next;
  }
  let nextP: number | null = null;
  if (at.p !== null && typeof at.p === "number" && at.p < bx.picks.length) {
    const needle = q.toLowerCase();
    const slice = bx.picks.slice(at.p, at.p + PAGE);
    const picked = await Promise.all(slice.map((id) => threadSummary(db, bx.a, id, "all").catch(() => null)));
    for (const t of picked) {
      if (!t || out.some((o) => o.id === t.id)) continue;
      if (folder === "starred" && !t.starred) continue;
      if (needle && ![t.subject, t.snippet, ...t.people].some((x) => x.toLowerCase().includes(needle))) continue;
      out.push(t);
    }
    nextP = at.p + PAGE < bx.picks.length ? at.p + PAGE : null;
  }
  return { threads: out, next: nextS || nextP !== null ? JSON.stringify({ s: nextS, p: nextP }) : null };
}

// ---------------------------------------------------------------- send --

const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${toB64(new TextEncoder().encode(s))}?=`);

/** Who a message goes to: parsed and checked, never passed on as typed. */
function recipients(m: { to?: unknown; cc?: unknown }) {
  const to = mailboxes(oneLine(m.to), "To");
  const cc = mailboxes(oneLine(m.cc), "Cc");
  if (!to.length) throw new HttpError(400, "Add who it's to");
  return { to, cc };
}

async function send(
  db: SupabaseClient,
  a: Account,
  m: { to?: unknown; cc?: unknown; subject?: unknown; text?: unknown; threadId?: unknown; inReplyTo?: unknown; references?: unknown },
) {
  const { to, cc } = recipients(m);
  const text = String(m.text ?? "");
  if (text.length > 200_000) throw new HttpError(400, "The message is too long");
  const lines = [
    `From: ${mailboxHeader([{ name: oneLine(a.name ?? "").replace(/["\\<>]/g, ""), addr: a.email }])}`,
    `To: ${mailboxHeader(to)}`,
    ...(cc.length ? [`Cc: ${mailboxHeader(cc)}`] : []),
    `Subject: ${word(oneLine(m.subject) || "(no subject)")}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references || m.inReplyTo ? [`References: ${oneLine([m.references, m.inReplyTo].filter(Boolean).join(" "))}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    toB64(new TextEncoder().encode(text)).replace(/.{76}/g, "$&\r\n"),
  ];
  const raw = toB64url(new TextEncoder().encode(lines.join("\r\n")));
  return gmail<{ id: string; threadId: string }>(db, a, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, ...(typeof m.threadId === "string" && m.threadId ? { threadId: m.threadId } : {}) }),
  });
}

// ------------------------------------------------------------ callback --

function idClaims(idToken: string | undefined): { email?: string; name?: string } {
  if (!idToken) return {};
  try {
    const p = idToken.split(".")[1]!;
    return JSON.parse(new TextDecoder().decode(fromB64url(p)));
  } catch {
    return {};
  }
}

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = await readState(url.searchParams.get("state"));
  const back = state?.r ?? safeReturn(null);
  if (url.searchParams.get("error")) return backToApp(back, "gmail", "denied");
  const code = url.searchParams.get("code");
  if (!state || !code) return backToApp(back, "gmail", "error");
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    // The person may untick "read, compose and send" on Google's screen.
    if (!(t.scope ?? "").split(" ").includes(GMAIL_SCOPE)) return backToApp(back, "gmail", "missing_scope");
    const who = idClaims(t.id_token);
    const email = who.email?.toLowerCase();
    if (!email) return backToApp(back, "gmail", "error");
    const db = serviceClient();
    const { data: existing } = await db.from("gmail_account").select("id").eq("user_id", state.u).eq("email", email).maybeSingle();
    if (!existing) {
      const { count } = await db.from("gmail_account").select("id", { count: "exact", head: true }).eq("user_id", state.u);
      if ((count ?? 0) >= MAX_ACCOUNTS) return backToApp(back, "gmail", "too_many");
    }
    const row = {
      user_id: state.u,
      email,
      name: who.name ?? null,
      access_token: t.access_token,
      token_expiry: expiry(t),
      scope: t.scope ?? null,
      updated_at: new Date().toISOString(),
    };
    if (t.refresh_token) {
      const { error } = await db
        .from("gmail_account")
        .upsert({ ...row, refresh_token: t.refresh_token, connected_at: new Date().toISOString() }, { onConflict: "user_id,email" });
      if (error) throw error;
    } else if (existing) {
      const { error } = await db.from("gmail_account").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      return backToApp(back, "gmail", "error");
    }
    return backToApp(back, "gmail", "connected");
  } catch (e) {
    console.error("gmail callback", (e as Error).message);
    return backToApp(back, "gmail", "error");
  }
}

// ---------------------------------------------------------------- notify --

async function notify(req: Request): Promise<Response> {
  if (!same(req.headers.get("x-iklipse-secret") ?? "", NOTIFY_SECRET)) return new Response("Forbidden", { status: 403 });
  const n = (await req.json().catch(() => null)) as { account?: string; to?: string; subject?: string; text?: string } | null;
  if (!n?.account || !n.to || !n.text) return new Response("Bad request", { status: 400 });
  const db = serviceClient();
  const { data: a } = await db.from("gmail_account").select("*").eq("id", n.account).maybeSingle();
  if (!a) return new Response("Sender not connected", { status: 409 });
  try {
    const sent = await send(db, a as Account, { to: n.to, subject: n.subject, text: n.text });
    return json({ id: sent.id });
  } catch (e) {
    console.error("gmail notify", (e as Error).message);
    return new Response("Not sent", { status: 502 });
  }
}

// ---------------------------------------------------------------- invite --
// A Zoom meeting's invitation (0080, _shared/invite.ts): the words, and the
// calendar invite both inline (Gmail and Outlook show Yes / No) and as a file.

async function invite(req: Request): Promise<Response> {
  if (!same(req.headers.get("x-iklipse-secret") ?? "", NOTIFY_SECRET)) return new Response("Forbidden", { status: 403 });
  const n = (await req.json().catch(() => null)) as { account?: string; to?: string[]; subject?: string; text?: string; ics?: string | null; method?: string } | null;
  if (!n?.account || !Array.isArray(n.to) || !n.to.length || !n.text) return new Response("Bad request", { status: 400 });
  const db = serviceClient();
  const { data: a } = await db.from("gmail_account").select("*").eq("id", n.account).maybeSingle();
  if (!a) return new Response("That Gmail isn't connected anymore", { status: 409 });
  try {
    const to = mailboxes(n.to.map(oneLine).join(", "), "To");
    if (!to.length) return new Response("Nobody to send it to", { status: 400 });
    const method = n.method === "CANCEL" ? "CANCEL" : "REQUEST";
    const b64 = (s: string) => toB64(new TextEncoder().encode(s)).replace(/.{76}/g, "$&\r\n");
    const id = crypto.randomUUID().replace(/-/g, "");
    const ics = typeof n.ics === "string" && n.ics.length < 200_000 ? n.ics : null;
    const text = [
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(String(n.text).slice(0, 50_000)),
    ];
    const body = ics
      ? [
          `Content-Type: multipart/mixed; boundary="mix${id}"`,
          "",
          `--mix${id}`,
          `Content-Type: multipart/alternative; boundary="alt${id}"`,
          "",
          `--alt${id}`,
          ...text,
          `--alt${id}`,
          `Content-Type: text/calendar; charset="UTF-8"; method=${method}`,
          "Content-Transfer-Encoding: base64",
          "",
          b64(ics),
          `--alt${id}--`,
          `--mix${id}`,
          'Content-Type: application/ics; name="invite.ics"',
          'Content-Disposition: attachment; filename="invite.ics"',
          "Content-Transfer-Encoding: base64",
          "",
          b64(ics),
          `--mix${id}--`,
        ]
      : text;
    const lines = [
      `From: ${mailboxHeader([{ name: oneLine(a.name ?? "").replace(/["\\<>]/g, ""), addr: a.email }])}`,
      `To: ${mailboxHeader(to)}`,
      `Subject: ${word(oneLine(n.subject) || "Zoom meeting")}`,
      "MIME-Version: 1.0",
      ...body,
    ];
    const raw = toB64url(new TextEncoder().encode(lines.join("\r\n")));
    const sent = await gmail<{ id: string }>(db, a as Account, "/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
    return json({ id: sent.id });
  } catch (e) {
    console.error("gmail invite", (e as Error).message);
    return new Response(e instanceof HttpError ? e.message : "Not sent", { status: e instanceof HttpError && e.status < 500 ? e.status : 502 });
  }
}

// ----------------------------------------------------------------- serve --

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const r = route(req);
  if (req.method === "GET" && r === "callback") return callback(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (r === "notify") return notify(req);
  if (r === "invite") return invite(req);
  try {
    const db = serviceClient();
    const me = await caller(req, db);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    switch (b.action) {
      case "connect": {
        if (!configured()) throw new HttpError(503, "Gmail isn't set up on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
        const state = await signState(me.id, safeReturn(b.returnTo));
        const q = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          // Always the account picker (to add another Gmail) and a fresh refresh token.
          prompt: "consent select_account",
          include_granted_scopes: "true",
          state,
        });
        return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
      }

      case "disconnect": {
        const a = await myAccount(db, me.id, b.account);
        // Revoking ends every grant of this Google login to the app, Drive
        // included: only when the same login isn't also connected for Drive.
        const { data: files } = await db.from("drive_account").select("id").eq("user_id", me.id).eq("email", a.email).maybeSingle();
        if (!files) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refresh_token)}`, { method: "POST" }).catch(() => undefined);
        await db.from("gmail_account").delete().eq("id", a.id);
        return json({ ok: true });
      }

      case "summary": {
        const { data } = await db.from("gmail_account").select("*").eq("user_id", me.id).order("connected_at");
        const accounts = await Promise.all(
          ((data ?? []) as Account[]).map(async (a) => {
            try {
              const l = await gmail<{ threadsUnread?: number }>(db, a, "/labels/INBOX");
              return { id: a.id, email: a.email, unread: l.threadsUnread ?? 0 };
            } catch (e) {
              return { id: a.id, email: a.email, unread: 0, error: (e as Error).message };
            }
          }),
        );
        return json({ accounts });
      }

      case "list": {
        // shared: the accounts others shared with me; else my own.
        let boxes: Box[];
        if (b.shared) boxes = await sharedBoxes(db, me.id);
        else {
          const { data } = await db.from("gmail_account").select("*").eq("user_id", me.id).order("connected_at");
          boxes = ((data ?? []) as Account[]).map((a) => toBox(a, "owner"));
        }
        if (Array.isArray(b.accounts) && b.accounts.length) boxes = boxes.filter((x) => (b.accounts as unknown[]).includes(x.a.id));
        const folder = typeof b.folder === "string" && b.folder in FOLDERS ? b.folder : "inbox";
        const q = typeof b.q === "string" ? b.q.trim().slice(0, 300) : "";
        const pages = (b.pages && typeof b.pages === "object" ? b.pages : {}) as Record<string, string | null>;
        const next: Record<string, string | null> = {};
        const errors: Record<string, string> = {};
        const threads: unknown[] = [];
        await Promise.all(
          boxes.map(async (bx) => {
            const a = bx.a;
            // A later page: only the accounts that still have one.
            if (a.id in pages && !pages[a.id]) {
              next[a.id] = null;
              return;
            }
            try {
              const page = pages[a.id] ?? undefined;
              const r = bx.readAll ? await listThreads(db, a, folder, q, page) : await listLimited(db, bx, folder, q, page);
              threads.push(...r.threads);
              next[a.id] = r.next;
            } catch (e) {
              errors[a.id] = (e as Error).message;
              next[a.id] = null;
            }
          }),
        );
        return json({ threads, next, errors });
      }

      case "thread": {
        const bx = await box(db, me.id, b.account);
        const a = bx.a;
        const th = await gmail<{ id: string; messages?: GMessage[] }>(db, a, `/threads/${encodeURIComponent(String(b.id))}?format=full`);
        if (!(await canRead(db, bx, th.id, th.messages))) throw new HttpError(403, "This email isn't shared with you");
        const messages = (th.messages ?? []).map((m) => {
          const parsed: Parsed = { text: null, html: null, attachments: [] };
          if (m.payload) walk(m.payload, parsed);
          return {
            ...summary(m),
            text: parsed.text?.slice(0, 200_000) ?? null,
            html: parsed.html?.slice(0, 400_000) ?? null,
            attachments: parsed.attachments,
          };
        });
        return json({ thread: { id: th.id, account: a.id, accountEmail: a.email, messages } });
      }

      case "send": {
        const bx = await box(db, me.id, b.account);
        if (bx.send === "none") throw new HttpError(403, "You can't send from this account");
        const threadId = typeof b.threadId === "string" && b.threadId ? b.threadId : null;
        if (bx.send === "reply" && !threadId) throw new HttpError(403, "You can only reply to the emails shared with you");
        if (threadId && !bx.readAll) {
          const msgs = (await threadMeta(db, bx.a, threadId)).messages ?? [];
          if (!(await canRead(db, bx, threadId, msgs))) throw new HttpError(403, "This email isn't shared with you");
          if (bx.send === "reply") {
            // Replies only: to the people already in the conversation.
            const people = new Set(
              msgs.flatMap((m) => ["From", "To", "Cc", "Reply-To"].flatMap((h) => mailboxes(head(m.payload?.headers, h), false).map((x) => x.addr.toLowerCase()))),
            );
            const { to, cc } = recipients(b);
            if ([...to, ...cc].some((x) => !people.has(x.addr.toLowerCase()))) throw new HttpError(403, "You can only reply to people already in this conversation");
          }
        }
        const sent = await send(db, bx.a, b);
        await logShared(db, bx, me.id, threadId ? "replied" : "sent", `${oneLine(b.subject) || "(no subject)"} · to ${oneLine(b.to)}`);
        return json(sent);
      }

      case "modify":
      case "trash": {
        const bx = await box(db, me.id, b.account);
        if (!bx.manage) throw new HttpError(403, "You can't change this account's mail");
        const a = bx.a;
        const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x): x is string => typeof x === "string").slice(0, 50);
        const allowed = new Set(["UNREAD", "INBOX", "STARRED"]);
        const add = (Array.isArray(b.add) ? b.add : []).filter((x): x is string => typeof x === "string" && allowed.has(x));
        const remove = (Array.isArray(b.remove) ? b.remove : []).filter((x): x is string => typeof x === "string" && allowed.has(x));
        await Promise.all(
          ids.map((id) =>
            b.action === "trash"
              ? gmail(db, a, `/threads/${encodeURIComponent(id)}/trash`, { method: "POST" })
              : gmail(db, a, `/threads/${encodeURIComponent(id)}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) }),
          ),
        );
        // Tell the owner (opening an email marks it read: not worth a line).
        const did =
          b.action === "trash" ? "deleted"
          : remove.includes("INBOX") ? "archived"
          : add.includes("INBOX") ? "moved to the inbox"
          : add.includes("STARRED") ? "starred"
          : remove.includes("STARRED") ? "unstarred"
          : add.includes("UNREAD") ? "marked unread"
          : null;
        if (did && bx.role !== "owner" && ids.length) {
          const first = await threadMeta(db, a, ids[0]!).catch(() => null);
          const subject = head(first?.messages?.[0]?.payload?.headers, "Subject") || "(no subject)";
          await logShared(db, bx, me.id, did, ids.length > 1 ? `${subject} and ${ids.length - 1} more` : subject);
        }
        return json({ ok: true });
      }

      case "attachment": {
        const bx = await box(db, me.id, b.account);
        const a = bx.a;
        if (!bx.readAll) {
          const m = await gmail<{ threadId: string }>(db, a, `/messages/${encodeURIComponent(String(b.message))}?format=minimal`);
          if (!(await canRead(db, bx, m.threadId))) throw new HttpError(403, "This email isn't shared with you");
        }
        const r = await gmail<{ data?: string; size?: number }>(
          db,
          a,
          `/messages/${encodeURIComponent(String(b.message))}/attachments/${encodeURIComponent(String(b.id))}`,
        );
        return json({ data: r.data ?? "", size: r.size ?? 0 });
      }

      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    return toResponse(e);
  }
});
