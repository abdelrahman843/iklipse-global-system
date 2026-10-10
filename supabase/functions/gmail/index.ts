// gmail — each person connects any number of Gmail accounts (0052), with the
// same Google OAuth client as the iklipse-system calendar. Used for the Mail
// page (read, reply, write, archive) and, for the one account an admin picks,
// to send the notification emails.
//
// POST (login token) { action, ... }:
//   connect { returnTo }                          -> { url }
//   disconnect { account }                        -> { ok }
//   summary                                       -> { accounts: [{ id, email, unread }] }
//   list { accounts?, folder?, q?, pages? }       -> { threads, next, errors }
//   thread { account, id }                        -> { thread }
//   send { account, to, cc?, subject, text, threadId?, inReplyTo?, references? } -> { id, threadId }
//   modify { account, ids, add?, remove? }        -> { ok }   (thread labels: UNREAD, INBOX, STARRED)
//   trash { account, ids }                        -> { ok }
//   attachment { account, message, id }           -> { data (base64url), size }
// GET  /gmail/callback?code&state                 (Google sends the browser here)
// POST /gmail/notify { account, to, subject, text } with X-Iklipse-Secret
//      (only the database calls this: public._send_email)
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
  const label = FOLDERS[folder] ?? "INBOX";
  if (label) params.set("labelIds", label);
  if (q) params.set("q", q.slice(0, 300));
  if (page) params.set("pageToken", page);
  const list = await gmail<{ threads?: { id: string }[]; nextPageToken?: string }>(db, a, `/threads?${params}`);
  const threads = await Promise.all(
    (list.threads ?? []).map(async (t) => {
      const th = await gmail<{ id: string; messages?: GMessage[] }>(db, a, `/threads/${t.id}?format=metadata&${META}`);
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
    }),
  );
  return { threads, next: list.nextPageToken ?? null };
}

// ---------------------------------------------------------------- send --

const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${toB64(new TextEncoder().encode(s))}?=`);
const EMAIL = /[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+/;

async function send(
  db: SupabaseClient,
  a: Account,
  m: { to?: unknown; cc?: unknown; subject?: unknown; text?: unknown; threadId?: unknown; inReplyTo?: unknown; references?: unknown },
) {
  const to = oneLine(m.to);
  const cc = oneLine(m.cc);
  if (!EMAIL.test(to)) throw new HttpError(400, "Add who it's to");
  const text = String(m.text ?? "");
  if (text.length > 200_000) throw new HttpError(400, "The message is too long");
  const lines = [
    `From: ${a.name ? `${word(oneLine(a.name))} <${a.email}>` : a.email}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
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

// ----------------------------------------------------------------- serve --

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const r = route(req);
  if (req.method === "GET" && r === "callback") return callback(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (r === "notify") return notify(req);
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
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refresh_token)}`, { method: "POST" }).catch(() => undefined);
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
        const { data } = await db.from("gmail_account").select("*").eq("user_id", me.id).order("connected_at");
        let accounts = (data ?? []) as Account[];
        if (Array.isArray(b.accounts) && b.accounts.length) accounts = accounts.filter((a) => (b.accounts as unknown[]).includes(a.id));
        const folder = typeof b.folder === "string" && b.folder in FOLDERS ? b.folder : "inbox";
        const q = typeof b.q === "string" ? b.q.trim() : "";
        const pages = (b.pages && typeof b.pages === "object" ? b.pages : {}) as Record<string, string | null>;
        const next: Record<string, string | null> = {};
        const errors: Record<string, string> = {};
        const threads: unknown[] = [];
        await Promise.all(
          accounts.map(async (a) => {
            // A later page: only the accounts that still have one.
            if (a.id in pages && !pages[a.id]) {
              next[a.id] = null;
              return;
            }
            try {
              const r = await listThreads(db, a, folder, q, pages[a.id] ?? undefined);
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
        const a = await myAccount(db, me.id, b.account);
        const th = await gmail<{ id: string; messages?: GMessage[] }>(db, a, `/threads/${encodeURIComponent(String(b.id))}?format=full`);
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
        const a = await myAccount(db, me.id, b.account);
        return json(await send(db, a, b));
      }

      case "modify":
      case "trash": {
        const a = await myAccount(db, me.id, b.account);
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
        return json({ ok: true });
      }

      case "attachment": {
        const a = await myAccount(db, me.id, b.account);
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
