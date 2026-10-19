// The watch's email side (0076): the same alerts as the WhatsApp groups, from
// the Gmail accounts each person turned on (Alerts > Email).
//
// Every minute (tick): Gmail's history says which conversations got a new
// email in each watched mailbox (sent or received); they wait in mail_thread.
// Then Claude reads each of them, as long as it's with someone outside the
// team: when it's with a client (or someone new asking about work) or an ad
// platform, it opens an alert (a client waiting for a reply, a promise, a
// client's promise, an ad account that needs something) for the owner of the
// mailbox only, and closes the ones the conversation shows were dealt with.
// Ringing and calls are index.ts's, the same as WhatsApp's.
//
// Gmail is read each time, and Claude sees the last few emails of the
// conversation, cut short, quoted replies left out. Emails with clients are
// kept too (0090), for the bot only (history.ts): never shown in iklipse.
// Each mailbox is read back 90 days for them too (0091), searched by client
// (0092): a client added later gets their last 90 days read the same way.

import { cairoOffset, cairoStamp, claude, env, firstRing, iso, MIN, str, type ClaudeTool, type Db, type Person, type Settings, type Team } from "./kit.ts";

const CLIENT_ID = env("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET");
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Conversations read per run; the rest wait for the next minute. */
const THREADS_PER_RUN = 8;
/** What Claude reads: the last emails of the conversation, each cut to this many characters. */
const LAST_EMAILS = 10;
const EMAIL_CHARS = 1500;
/** Turned on: what came in this long before counts too. */
const LOOK_BACK_MS = 24 * 60 * MIN;
const LOOK_BACK_THREADS = 15;
/** Reading back (0091, 0092): clients searched together, emails per page, read at once, and at most this many a run (Gmail's limits). */
const BACK_KEYS = 8;
const BACK_PAGE = 25;
const BACK_AT_ONCE = 2;
const BACK_PER_RUN = 40;
const BACK_DAYS = 90;

interface Account {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
}

interface Watch {
  account_id: string;
  user_id: string;
  history_id: string | null;
  started_at: string;
  backfill_page: string | null;
  backfill_count: number;
  backfill_keys: string[];
  backfill_chunk: string[];
  account: Account | null;
}

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  headers?: Header[];
  body?: { data?: string };
  parts?: Part[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part;
}

class GmailError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// ---------------------------------------------------------------- Gmail --
// Tokens as in the gmail function; a mailbox whose login ended isn't removed
// here (the gmail function does that), it just says so.

async function token(db: Db, a: Account, force = false): Promise<string> {
  if (!force && a.access_token && a.token_expiry && Date.parse(a.token_expiry) > Date.now() + 30_000) return a.access_token;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new GmailError("Gmail isn't set up on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)", 503);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: a.refresh_token }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (/invalid_grant|unauthorized_client|invalid_client/.test(String(t.error))) throw new GmailError(`Connect ${a.email} again (Connected accounts)`, 401);
    throw new GmailError("Couldn't reach Google", 502);
  }
  const patch = {
    access_token: t.access_token as string,
    token_expiry: new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString(),
    updated_at: iso(),
    ...(t.refresh_token ? { refresh_token: t.refresh_token as string } : {}),
  };
  await db.from("gmail_account").update(patch).eq("id", a.id).eq("refresh_token", a.refresh_token);
  Object.assign(a, patch);
  return patch.access_token;
}

async function gmail<T>(db: Db, a: Account, path: string): Promise<T> {
  const go = async (tok: string) => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  let res = await go(await token(db, a));
  if (res.status === 401) res = await go(await token(db, a, true));
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({})))?.error?.message ?? `status ${res.status}`;
    if (res.status === 403 && /insufficient/i.test(msg)) throw new GmailError(`Connect ${a.email} again: Gmail access wasn't allowed`, 403);
    throw new GmailError(`Gmail: ${msg}`, res.status);
  }
  return (await res.json()) as T;
}

const head = (h: Header[] | undefined, name: string) => h?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
/** Drafts, spam, trash and chats aren't emails anyone is waiting on. */
const counts = (labels: string[] | undefined) => !labels?.some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH" || l === "CHAT");

// ---------------------------------------------------------- what changed --

/** Conversations with a new email wait for Claude (the oldest wait stays). */
async function markPending(db: Db, account: string, ids: string[]) {
  if (!ids.length) return;
  const now = iso();
  const { data: known } = await db.from("mail_thread").select("thread_id").eq("account_id", account).in("thread_id", ids);
  const have = new Set((known ?? []).map((r) => r.thread_id as string));
  const fresh = ids.filter((id) => !have.has(id));
  if (fresh.length) await db.from("mail_thread").insert(fresh.map((thread_id) => ({ account_id: account, thread_id, pending_since: now, seen_at: now })));
  if (have.size) {
    await db.from("mail_thread").update({ seen_at: now }).eq("account_id", account).in("thread_id", [...have]);
    await db.from("mail_thread").update({ pending_since: now }).eq("account_id", account).in("thread_id", [...have]).is("pending_since", null);
  }
}

/** Where Gmail is now; the last day's inbox conversations wait for Claude (just turned on, or lost track). */
async function start(db: Db, a: Account) {
  const p = await gmail<{ historyId?: string }>(db, a, "/profile");
  const q = new URLSearchParams({
    q: `in:inbox after:${Math.floor((Date.now() - LOOK_BACK_MS) / 1000)} -category:promotions -category:social -category:forums`,
    maxResults: String(LOOK_BACK_THREADS),
  });
  const l = await gmail<{ threads?: { id: string }[] }>(db, a, `/threads?${q}`);
  await markPending(db, a.id, (l.threads ?? []).map((t) => t.id));
  return p.historyId ?? null;
}

/** What changed since last time: the conversations that got an email. */
async function changes(db: Db, w: Watch, a: Account) {
  let historyId = w.history_id;
  if (!historyId) return await start(db, a);
  const ids = new Set<string>();
  let page: string | undefined;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ startHistoryId: historyId, historyTypes: "messageAdded", maxResults: "500", ...(page ? { pageToken: page } : {}) });
    let h: { history?: { messagesAdded?: { message?: GMessage }[] }[]; nextPageToken?: string; historyId?: string };
    try {
      h = await gmail(db, a, `/history?${q}`);
    } catch (e) {
      // Too far back for Gmail's history (off for days): start over.
      if (e instanceof GmailError && e.status === 404) return await start(db, a);
      throw e;
    }
    for (const x of h.history ?? []) for (const m of x.messagesAdded ?? []) if (m.message?.threadId && counts(m.message.labelIds)) ids.add(m.message.threadId);
    if (h.historyId) historyId = h.historyId;
    page = h.nextPageToken;
    if (!page) break;
  }
  // After a long break, the newest are enough.
  await markPending(db, a.id, [...ids].slice(-200));
  return historyId;
}

// ------------------------------------------------------------- who's who --

interface Addr {
  name: string;
  addr: string;
}

/** "Ann <a@b.com>, \"Doe, Jo\" <j@d.com>" -> addresses (anything that isn't one is skipped). */
function addresses(raw: string): Addr[] {
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
  const out: Addr[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.*)<([^<>]*)>$/.exec(p);
    const addr = (m ? m[2]! : p).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) continue;
    out.push({ name: m ? m[1]!.replace(/["\\]/g, "").trim() : "", addr });
  }
  return out;
}

const domainOf = (addr: string) => addr.slice(addr.lastIndexOf("@") + 1);
/** Mail anyone can sign up for: its domain says nothing about a company. */
const PUBLIC =
  /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|yandex|mail|gmx|zoho|tutanota|fastmail|hey)\.[a-z.]+$/;
const isPublic = (domain: string) => PUBLIC.test(domain);

/** The ad platform an address belongs to, if it is one (Claude has the last word). */
function adPlatform(addr: string): string | null {
  const d = domainOf(addr);
  const local = addr.slice(0, addr.indexOf("@"));
  const is = (...ds: string[]) => ds.some((x) => d === x || d.endsWith(`.${x}`));
  if (is("facebookmail.com", "fb.com", "facebook.com", "meta.com", "instagram.com")) return "Meta";
  if (is("google.com") && /ads|adwords|payments|merchant/.test(local)) return "Google Ads";
  if (is("tiktok.com", "tiktokv.com", "bytedance.com")) return "TikTok";
  if (is("snapchat.com", "snap.com")) return "Snapchat";
  if (is("linkedin.com") && /ads|advertis|billing|campaign/.test(local)) return "LinkedIn";
  if (is("x.com", "twitter.com") && /ads|advertis|billing/.test(local)) return "X";
  if (is("microsoft.com", "microsoftadvertising.com", "bingads.com") && /ads|advertis|billing/.test(local)) return "Microsoft Ads";
  if (is("pinterest.com") && /ads|business|billing/.test(local)) return "Pinterest";
  return null;
}

/** Sent by a machine: newsletters, notifications, no-reply addresses. */
function machine(h: Header[] | undefined, addr: string, labels: string[] | undefined) {
  if (head(h, "List-Unsubscribe") || head(h, "List-Id")) return true;
  if (/^(bulk|list|junk)$/i.test(head(h, "Precedence"))) return true;
  const auto = head(h, "Auto-Submitted");
  if (auto && auto.toLowerCase() !== "no") return true;
  if (/^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|newsletter|news|marketing|alerts?)([+._-]|@|$)/.test(addr)) return true;
  return !!labels?.some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_SOCIAL" || l === "CATEGORY_FORUMS");
}

interface People {
  /** Team members' addresses (their Gmail accounts, member cards). */
  team: Map<string, Person>;
  /** Their companies' domains (not public mail): anyone there is the team. */
  teamDomains: Set<string>;
  /** Clients' addresses and their companies' domains -> the client. */
  clients: Map<string, string>;
  clientDomains: Map<string, string>;
}

async function people(db: Db, s: Settings, t: Team): Promise<People> {
  const [accs, cards, cl] = await Promise.all([
    db.from("gmail_account").select("user_id, email"),
    db.from("profile_contact").select("user_id, email").not("email", "is", null),
    db.from("client").select("name, company, email").not("email", "is", null),
  ]);
  const team = new Map<string, Person>();
  const teamDomains = new Set<string>();
  for (const r of [...(accs.data ?? []), ...(cards.data ?? [])]) {
    const p = t.people.get(r.user_id);
    const addr = str(r.email).toLowerCase();
    if (!p || !addr.includes("@")) continue;
    team.set(addr, p);
    if (!isPublic(domainOf(addr))) teamDomains.add(domainOf(addr));
  }
  const clients = new Map<string, string>();
  const clientDomains = new Map<string, string>();
  for (const c of cl.data ?? []) {
    const who = [str(c.name), str(c.company)].filter(Boolean).join(", ");
    for (const a of addresses(str(c.email))) {
      clients.set(a.addr, who);
      const d = domainOf(a.addr);
      if (!isPublic(d) && !teamDomains.has(d)) clientDomains.set(d, who);
    }
  }
  // Senders an admin listed as clients (Alerts > Settings).
  for (const x of s.mail_senders ?? []) {
    if (x.startsWith("@")) clientDomains.set(x.slice(1), clientDomains.get(x.slice(1)) ?? "listed as a client");
    else if (x.includes("@")) clients.set(x, clients.get(x) ?? "listed as a client");
  }
  return { team, teamDomains, clients, clientDomains };
}

// ---------------------------------------------------------------- words --

function decode(data: string, contentType: string) {
  const b = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function findBody(p: Part, out: { text: string | null; html: string | null }) {
  const mime = (p.mimeType ?? "").toLowerCase();
  if (mime === "text/plain" && p.body?.data && out.text === null) out.text = decode(p.body.data, head(p.headers, "Content-Type"));
  else if (mime === "text/html" && p.body?.data && out.html === null) out.html = decode(p.body.data, head(p.headers, "Content-Type"));
  for (const c of p.parts ?? []) findBody(c, out);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    });
}

/** What an email says, without the earlier emails it quotes. */
function bodyOf(m: GMessage, max = EMAIL_CHARS) {
  const found = { text: null as string | null, html: null as string | null };
  if (m.payload) findBody(m.payload, found);
  let t = found.text ?? (found.html ? htmlToText(found.html) : "");
  const cut = [
    /^\s*On .{4,300}wrote:\s*$/m,
    /^\s*في .{4,300}كتب:?\s*$/m,
    /^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/im,
    /^\s*_{10,}\s*$/m,
    /^\s*From: .*\n\s*(Sent|Date): /m,
  ];
  for (const re of cut) {
    const at = t.search(re);
    if (at > 0) t = t.slice(0, at);
  }
  return t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// --------------------------------------------------------------- Claude --

const MAIL_SYSTEM = `You watch the email of one person on the iklipse team (iklipse is a creative and marketing agency) and tell them what needs their attention. You get one email conversation from their mailbox. Each email is marked ME (the mailbox's owner), TEAM (someone else at iklipse) or OUTSIDE (anyone else), with what is known about the sender. Emails marked NEW arrived since you last looked; the rest are context. Times are Cairo time. People write in English, Arabic, Egyptian Arabic or Franco-Arabic.

First, what the conversation is (category):
- client: with a client of iklipse, someone at a client's company, or someone who could become a client (asking about services, prices, a project, a meeting), about work.
- ads: an ad platform (Meta, Facebook, Instagram, Google Ads, TikTok, Snapchat, LinkedIn, X, Microsoft Ads...) saying something on an ad account needs doing: an ad rejected or disapproved, a payment failed or a card declined, an account restricted, disabled or under review, a policy warning, verification needed, campaigns stopped, a billing problem.
- other: anything else: newsletters, promotions, tips, reports or receipts that need nothing, notifications, suppliers selling something, job applications, spam, mail only inside the team, personal mail. Open nothing for other.

open: new alerts, only for something in a NEW email that isn't already covered by an open alert.
- unanswered (client): an OUTSIDE email that needs an answer (a question, a request, feedback, a complaint, an approval, files sent, chasing, a new inquiry) and nobody on the team (ME or TEAM) answered after it. Skip emails that need nothing back: thanks, "ok", confirmations, FYI, automatic replies, out of office. At most one per conversation, about the latest need.
- promise (client): ME or TEAM committed to do something or to get back ("I'll send it tomorrow", "هبعتهولك بكرة الصبح", "I'll check and get back to you"). Not if they already did it in a later email.
- follow_up (client): the team is waiting on the OUTSIDE person: they said they will send or do something the team needs (files, content, feedback, approval, payment, a call), or ME or TEAM asked them for something the team needs (an answer, a decision, approval, files, payment) and they haven't given it yet. Title it like "Waiting on Sara for the logo files". Not when the answer already came in a later email.
- ads (ads): what needs doing on the ad account; one alert per issue.
- deadline (client): ME or TEAM told the OUTSIDE person when the team will deliver or hand over work, or they agreed a delivery date ("you'll get the designs Thursday", "the site goes live on the 25th"). A quick commitment within the hours ahead is a promise instead. Title it like "Deliver the final video to Sara by Sunday".
For promise, follow_up and deadline, due_at is when it is due (ISO 8601 with the Cairo offset given below), or null when no time was given. A deadline needs its day: with only a day and no time, 10:00 that day.
Each alert has: title (one short line, like "Alessandro is waiting for a reply about the logo", "You promised Omar the final cut by 6 pm" or "Meta rejected the Ramadan ad"), detail (one sentence in English on what is needed, no long quotes), person (who it is about: the client, the platform, or who promised), message (the # of the email it is about), priority (normal; high for an upset client, a deadline, money, or ads that stopped running; urgent for an angry client or something broken right now).

resolve: open alerts the conversation now shows were dealt with: ME or TEAM answered for real, the promise was kept, the delivery was made, what the team was waiting for arrived (or the client answered), the platform says it's fixed, or it no longer matters. A reply that only says "checking" or "will get back to you" is not an answer; if it promises a time, resolve the unanswered alert and open a promise instead.

When unsure whether a client's email needs an answer, it does. Don't reopen anything listed under "Closed recently" unless a NEW email brings it back. When nothing needs doing, return empty lists.

Always answer by calling the report tool, once.`;

const MAIL_TOOL: ClaudeTool = {
  name: "report",
  description: "What this conversation is, and the alerts to open and to close.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["client", "ads", "other"] },
      open: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["unanswered", "promise", "follow_up", "ads", "deadline"] },
            title: { type: "string" },
            detail: { type: "string" },
            person: { type: "string" },
            message: { type: "integer" },
            due_at: { type: ["string", "null"] },
            priority: { type: "string", enum: ["normal", "high", "urgent"] },
          },
          required: ["kind", "title", "detail", "person", "message", "priority"],
        },
      },
      resolve: {
        type: "array",
        items: {
          type: "object",
          properties: { alert: { type: "string" }, reason: { type: "string" } },
          required: ["alert", "reason"],
        },
      },
    },
    required: ["category", "open", "resolve"],
  },
};

type Kind = "unanswered" | "promise" | "follow_up" | "ads" | "deadline";
interface Opened {
  kind: Kind;
  title: string;
  detail: string;
  person: string;
  message: number;
  due_at?: string | null;
  priority: "normal" | "high" | "urgent";
}

// --------------------------------------------------------- kept emails --

/** Someone outside the team that iklipse knows as a client is on this email (from, to or cc). */
function withClient(a: Account, who: People, m: GMessage) {
  const mine = a.email.toLowerCase();
  const h = m.payload?.headers;
  const all = [...addresses(head(h, "From")), ...addresses(head(h, "To")), ...addresses(head(h, "Cc"))];
  return all.some((x) => x.addr !== mine && !who.team.has(x.addr) && !who.teamDomains.has(domainOf(x.addr)) && (who.clients.has(x.addr) || who.clientDomains.has(domainOf(x.addr))));
}

/** An email as it's kept for the bot (0090). */
function emailRow(a: Account, m: GMessage, subject: string | null) {
  const h = m.payload?.headers;
  const from = addresses(head(h, "From"))[0] ?? { name: "", addr: "" };
  const all = [from, ...addresses(head(h, "To")), ...addresses(head(h, "Cc"))].filter((x) => x.addr);
  return {
    id: m.id,
    account_id: a.id,
    thread_id: m.threadId,
    from_addr: from.addr || null,
    from_name: from.name || null,
    addrs: [...new Set(all.map((x) => x.addr))],
    subject: head(h, "Subject").slice(0, 300) || subject,
    body: bodyOf(m, 20000),
    sent_at: iso(Number(m.internalDate ?? Date.now())),
  };
}

/** What clients are known by in email: their addresses, and their companies' domains ("@acme.com"). */
const clientKeys = (who: People) => [...who.clients.keys(), ...[...who.clientDomains.keys()].map((d) => `@${d}`)];

/** Gmail's search for emails from, to or copying any of them. */
const searchFor = (keys: string[]) =>
  `(${keys.map((k) => (k.startsWith("@") ? k.slice(1) : k)).flatMap((k) => [`from:${k}`, `to:${k}`, `cc:${k}`]).join(" OR ")})`;

/**
 * Reading a mailbox back (0091, 0092): the last 90 days' emails with each
 * client, searched a few clients at a time, kept for the bot. At most budget
 * emails a run (Gmail's limits); where it stopped is kept for the next run.
 * The emails kept this run, and how many it fetched.
 */
async function backfill(db: Db, w: Watch, who: People, budget: number, until: number) {
  const a = w.account!;
  let chunk = w.backfill_chunk.length ? w.backfill_chunk : clientKeys(who).filter((k) => !w.backfill_keys.includes(k)).slice(0, BACK_KEYS);
  let page = w.backfill_chunk.length ? w.backfill_page : null;
  let kept = 0;
  let used = 0;
  const after = Math.floor((Date.now() - BACK_DAYS * 24 * 60 * MIN) / 1000);
  while (chunk.length && used < budget && Date.now() < until) {
    const q = new URLSearchParams({ q: `after:${after} ${searchFor(chunk)}`, maxResults: String(BACK_PAGE), ...(page ? { pageToken: page } : {}) });
    const l = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(db, a, `/messages?${q}`);
    used++;
    const ids = (l.messages ?? []).map((m) => m.id);
    const { data: have } = ids.length ? await db.from("mail_message").select("id").in("id", ids) : { data: [] };
    const stored = new Set((have ?? []).map((r) => r.id as string));
    const todo = ids.filter((id) => !stored.has(id));
    let finished = true;
    for (let i = 0; i < todo.length; i += BACK_AT_ONCE) {
      // Out of budget halfway: this page again next run (what's kept isn't fetched twice).
      if (used >= budget || Date.now() > until) {
        finished = false;
        break;
      }
      const batch = todo.slice(i, i + BACK_AT_ONCE);
      used += batch.length;
      const rows = (await Promise.all(batch.map((id) => gmail<GMessage>(db, a, `/messages/${id}?format=full`))))
        .filter((m) => counts(m.labelIds) && withClient(a, who, m))
        .map((m) => emailRow(a, m, null));
      if (rows.length) await db.from("mail_message").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      kept += rows.length;
    }
    if (!finished) break;
    page = l.nextPageToken ?? null;
    if (!page) {
      // These clients are done: the next ones.
      w.backfill_keys = [...w.backfill_keys, ...chunk];
      chunk = clientKeys(who).filter((k) => !w.backfill_keys.includes(k)).slice(0, BACK_KEYS);
    }
  }
  w.backfill_count += kept;
  await db
    .from("mail_watch")
    .update({ backfill_keys: w.backfill_keys, backfill_chunk: chunk, backfill_page: page, backfill_count: w.backfill_count, ...(chunk.length ? {} : { backfill_done_at: iso() }) })
    .eq("account_id", a.id);
  return { kept, used };
}

// ---------------------------------------------------------------- a read --

interface ThreadRow {
  account_id: string;
  thread_id: string;
  analyzed_at: string | null;
  created_at: string;
}

/** One conversation: is it with a client or an ad platform, and what's waiting. */
async function readThread(db: Db, s: Settings, a: Account, owner: Person, who: People, row: ThreadRow) {
  const started = iso();
  const done = async (patch: Record<string, unknown>) => {
    await db.from("mail_thread").update({ ...patch, analyzed_at: started, last_error: null }).eq("account_id", a.id).eq("thread_id", row.thread_id);
    // An email that came in while reading waits for the next look.
    await db.from("mail_thread").update({ pending_since: null }).eq("account_id", a.id).eq("thread_id", row.thread_id).lte("seen_at", started);
  };

  let th: { id: string; messages?: GMessage[] };
  try {
    th = await gmail(db, a, `/threads/${encodeURIComponent(row.thread_id)}?format=full`);
  } catch (e) {
    // Deleted for good: nothing left to watch.
    if (e instanceof GmailError && e.status === 404) {
      await db.from("mail_thread").delete().eq("account_id", a.id).eq("thread_id", row.thread_id);
      return { opened: 0, resolved: 0 };
    }
    throw e;
  }
  const msgs = (th.messages ?? []).filter((m) => counts(m.labelIds)).slice(-LAST_EMAILS);
  const subject = head(msgs[0]?.payload?.headers, "Subject").slice(0, 300) || null;
  if (!msgs.length) {
    await done({ subject, verdict: "other", note: "No emails left in it" });
    return { opened: 0, resolved: 0 };
  }

  // Who wrote each email, and what's known about everyone outside the team.
  const mine = a.email.toLowerCase();
  const isTeam = (addr: string) => addr === mine || who.team.has(addr) || who.teamDomains.has(domainOf(addr));
  const known = (addr: string) => who.clients.get(addr) ?? who.clientDomains.get(domainOf(addr)) ?? null;
  const lines: string[] = [];
  let relevant = false;
  // New: since Claude last read it; the first time, the day before it showed up.
  const cut = row.analyzed_at ? Date.parse(row.analyzed_at) : Date.parse(row.created_at) - LOOK_BACK_MS;
  const isNew = (m: GMessage) => Number(m.internalDate ?? 0) > cut;
  const outsiders = new Map<string, string>();
  /** Who on the team wrote in it, for the note when it's skipped. */
  const teamFrom = new Set<string>();

  msgs.forEach((m, i) => {
    const h = m.payload?.headers;
    const from = addresses(head(h, "From"))[0] ?? { name: "", addr: "" };
    const sent = m.labelIds?.includes("SENT") || from.addr === mine;
    const team = sent || isTeam(from.addr);
    const role = sent ? "ME" : team ? "TEAM" : "OUTSIDE";
    const name = sent ? owner.name : who.team.get(from.addr)?.name ?? (from.name || from.addr || "Unknown");
    const to = [...addresses(head(h, "To")), ...addresses(head(h, "Cc"))];
    const auto = !team && machine(h, from.addr, m.labelIds);
    const ad = !team ? adPlatform(from.addr) : null;
    const client = !team ? known(from.addr) : null;
    if (team) {
      const p = who.team.get(from.addr);
      teamFrom.add(sent ? "the owner" : p?.id === owner.id ? `the owner's other email ${from.addr}` : p ? `${p.name} (${from.addr})` : `${from.addr} (same company as the team)`);
    }
    if (!team) {
      outsiders.set(from.addr, [client && `client: ${client}`, ad && `ad platform: ${ad}`, auto && "sent by a machine"].filter(Boolean).join(", ") || "not a known client");
      if ((ad && s.mail_ads) || (s.mail_clients && (client || !auto))) relevant = true;
    } else if (s.mail_clients) {
      // The team writing to someone outside: a promise, or a client to chase.
      for (const r of to) {
        if (isTeam(r.addr)) continue;
        outsiders.set(r.addr, outsiders.get(r.addr) ?? (known(r.addr) ? `client: ${known(r.addr)}` : "not a known client"));
        if (known(r.addr) || !/^(no-?reply|do-?not-?reply)/.test(r.addr)) relevant = true;
      }
    }
    const toText = to.length ? ` to ${to.slice(0, 4).map((r) => (r.addr === mine ? "me" : r.name || r.addr)).join(", ")}${to.length > 4 ? ` and ${to.length - 4} more` : ""}` : "";
    lines.push(
      `${isNew(m) ? "NEW " : ""}#${i + 1} [${cairoStamp.format(new Date(Number(m.internalDate ?? 0)))}] ${role} ${name}${role === "OUTSIDE" ? ` <${from.addr}>` : ""}${toText}: ${bodyOf(m) || "(no text)"}`,
    );
  });

  // Emails with a client on them are kept for the bot (0090).
  const kept = msgs.filter((m) => withClient(a, who, m)).map((m) => emailRow(a, m, subject));
  if (kept.length) await db.from("mail_message").upsert(kept, { onConflict: "id", ignoreDuplicates: true });

  const { data: openRows } = await db
    .from("watch_alert")
    .select("id, kind, title, detail, message_id")
    .eq("mail_account", a.id)
    .eq("mail_thread", th.id)
    .eq("status", "open")
    .order("created_at");
  const open = openRows ?? [];

  // Nothing new, or nobody outside worth reading (newsletters, the team among themselves): no Claude.
  if (!msgs.some(isNew) || (!relevant && !open.length)) {
    const note = !msgs.some(isNew)
      ? "Nothing new in it"
      : !outsiders.size
        ? `Only the team wrote in it: ${[...teamFrom].join(", ")}`
        : `Nobody outside to watch: ${[...outsiders].map(([addr, what]) => `${addr} (${what})`).join(", ")}`;
    await done({ subject, note: note.slice(0, 500), ...(relevant ? {} : { verdict: "other" }) });
    return { opened: 0, resolved: 0 };
  }

  const { data: closedRows } = await db
    .from("watch_alert")
    .select("kind, title, status, close_note")
    .eq("mail_account", a.id)
    .eq("mail_thread", th.id)
    .neq("status", "open")
    .gt("closed_at", iso(Date.now() - 7 * 24 * 60 * MIN))
    .order("closed_at", { ascending: false })
    .limit(10);

  const index = new Map(msgs.map((m, i) => [m.id, i + 1]));
  const user = [
    `Mailbox: ${a.email}, of ${owner.name} (ME)`,
    `Subject: ${subject ?? "(no subject)"}`,
    `Now: ${cairoStamp.format(new Date())} Cairo time (UTC${cairoOffset()})`,
    "",
    "Outside the team:",
    ...([...outsiders].length ? [...outsiders].map(([addr, what]) => `- ${addr}: ${what}`) : ["nobody"]),
    "",
    "Emails (oldest first):",
    ...lines,
    "",
    "Open alerts:",
    ...(open.length
      ? open.map((x, i) => `A${i + 1}: ${x.kind}; ${x.title}; ${x.detail ?? ""}${x.message_id && index.has(x.message_id) ? `; about #${index.get(x.message_id)}` : ""}`)
      : ["none"]),
    "",
    "Closed recently:",
    ...((closedRows ?? []).length ? (closedRows ?? []).map((x) => `- ${x.kind}; ${x.title} (${x.status}${x.close_note ? `: ${x.close_note}` : ""})`) : ["none"]),
  ].join("\n");

  const r = (await claude(s.model, MAIL_SYSTEM, user, MAIL_TOOL)) as { category?: string; open?: Opened[]; resolve?: { alert: string; reason: string }[] } | null;
  if (!r) throw new Error("Claude gave no answer");
  const category = r.category === "client" || r.category === "ads" ? r.category : "other";

  // Close what the conversation shows was dealt with.
  let resolved = 0;
  for (const x of r.resolve ?? []) {
    const n = Number(String(x.alert).replace(/\D/g, ""));
    const al = open[n - 1];
    if (!al) continue;
    const { data: hit } = await db
      .from("watch_alert")
      .update({ status: "resolved", closed_at: iso(), close_note: str(x.reason).slice(0, 300) || "Answered in the email", next_alert_at: null, updated_at: iso() })
      .eq("id", al.id)
      .eq("status", "open")
      .select("id");
    if (!hit?.length) continue;
    await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", al.id);
    await db.from("watch_event").insert({ alert_id: al.id, what: "resolved", detail: str(x.reason).slice(0, 300) || null });
    await db.rpc("_watch_quiet_notifications", { p_alert: al.id });
    resolved++;
  }

  // Open the new ones: only what the settings watch, for the mailbox's owner.
  let opened = 0;
  const allowed = (category === "client" && s.mail_clients) || (category === "ads" && s.mail_ads);
  for (const o of allowed ? r.open ?? [] : []) {
    if (!str(o.title) || (category === "ads") !== (o.kind === "ads") || !["unanswered", "promise", "follow_up", "ads", "deadline"].includes(o.kind)) continue;
    // A deadline with no day is a promise.
    if (o.kind === "deadline" && !(o.due_at && Date.parse(o.due_at) > Date.now())) o.kind = "promise";
    if (o.kind === "deadline" && !s.deadline_enabled) continue;
    const m = msgs[Number(o.message) - 1];
    if (!m) continue;
    if (open.some((x) => x.message_id === m.id && x.kind === o.kind)) continue;
    if (o.kind === "unanswered" && open.some((x) => x.kind === "unanswered")) continue;
    if (o.kind === "follow_up" && !s.follow_enabled) continue;
    const sent = Number(m.internalDate ?? Date.now());
    let due: number;
    if (o.kind === "unanswered") due = sent + s.mail_reply_wait_min * MIN;
    else if (o.kind === "ads") due = sent;
    else {
      const asked = o.due_at ? Date.parse(o.due_at) : NaN;
      due = Number.isFinite(asked) && asked > sent ? asked : sent + (o.kind === "follow_up" ? s.follow_wait_min : s.promise_wait_min) * MIN;
    }
    const from = addresses(head(m.payload?.headers, "From"))[0];
    const { data: made, error } = await db
      .from("watch_alert")
      .insert({
        source: "email",
        mail_account: a.id,
        mail_thread: th.id,
        mail_subject: subject,
        mail_from: from && from.addr !== mine ? (from.name || from.addr).slice(0, 200) : null,
        kind: o.kind,
        title: str(o.title).slice(0, 200),
        detail: str(o.detail).slice(0, 500) || null,
        person: str(o.person).slice(0, 120) || null,
        priority: ["normal", "high", "urgent"].includes(o.priority) ? o.priority : "normal",
        message_id: m.id,
        due_at: iso(due),
        next_alert_at: iso(firstRing(s, o.kind, due)),
      })
      .select("id")
      .single();
    if (error || !made) continue;
    await db.from("watch_recipient").insert({ alert_id: made.id, user_id: owner.id });
    await db.from("watch_event").insert({
      alert_id: made.id,
      what: "opened",
      detail: `For ${owner.name} (${a.email})${o.kind === "promise" || o.kind === "follow_up" || o.kind === "deadline" ? `, due ${cairoStamp.format(new Date(due))}` : ""}`,
    });
    open.push({ id: made.id, kind: o.kind, title: o.title, detail: o.detail, message_id: m.id });
    opened++;
  }
  await done({ subject, verdict: category, note: `Read by Claude: ${category}${opened ? `, ${opened} opened` : ""}${resolved ? `, ${resolved} closed` : ""}` });
  return { opened, resolved };
}

// ----------------------------------------------------------------- a run --

/** Every watched mailbox: what changed, then the conversations waiting (until `until`). */
export async function watchMail(db: Db, s: Settings, t: Team, until: number) {
  const out = { mailboxes: 0, read: 0, opened: 0, resolved: 0, kept: 0, errors: [] as string[] };
  const { data: rows } = await db
    .from("mail_watch")
    .select("account_id, user_id, history_id, started_at, backfill_page, backfill_count, backfill_keys, backfill_chunk, account:account_id(*)")
    .order("checked_at", { ascending: true, nullsFirst: true });
  const watches = ((rows ?? []) as unknown as Watch[]).filter((w) => w.account && t.people.get(w.user_id)?.active);
  const byId = new Map(watches.map((w) => [w.account_id, w]));
  if (!watches.length) return out;

  for (const w of watches) {
    if (Date.now() > until) break;
    try {
      const historyId = await changes(db, w, w.account!);
      await db.from("mail_watch").update({ history_id: historyId, checked_at: iso(), last_error: null }).eq("account_id", w.account_id);
      out.mailboxes++;
    } catch (e) {
      out.errors.push(`${w.account!.email}: ${(e as Error).message}`);
      await db.from("mail_watch").update({ checked_at: iso(), last_error: (e as Error).message.slice(0, 300) }).eq("account_id", w.account_id);
    }
  }

  const { data: pending } = await db
    .from("mail_thread")
    .select("account_id, thread_id, analyzed_at, created_at")
    .not("pending_since", "is", null)
    .in("account_id", [...byId.keys()])
    .order("pending_since")
    .limit(THREADS_PER_RUN);
  let who: People | null = null;
  if (pending?.length) {
    who = await people(db, s, t);
    for (const row of pending as ThreadRow[]) {
      if (Date.now() > until) break;
      const w = byId.get(row.account_id)!;
      try {
        const r = await readThread(db, s, w.account!, t.people.get(w.user_id)!, who!, row);
        out.read++;
        out.opened += r.opened;
        out.resolved += r.resolved;
      } catch (e) {
        out.errors.push((e as Error).message);
        // Tried again later, behind the others.
        await db
          .from("mail_thread")
          .update({ pending_since: iso(), last_error: (e as Error).message.slice(0, 300) })
          .eq("account_id", row.account_id)
          .eq("thread_id", row.thread_id);
      }
    }
  }

  // The last 90 days' emails with each client, kept for the bot (0091, 0092): a few a minute, with the time left.
  if (Date.now() < until) {
    who ??= await people(db, s, t);
    const keys = clientKeys(who);
    let budget = BACK_PER_RUN;
    for (const w of watches) {
      if (Date.now() > until || budget <= 0) break;
      if (!w.backfill_chunk.length && keys.every((k) => w.backfill_keys.includes(k))) continue;
      try {
        const r = await backfill(db, w, who, budget, until);
        out.kept += r.kept;
        budget -= r.used;
      } catch (e) {
        // Gmail's limit for the minute: the rest wait for the next run.
        out.errors.push(`${w.account!.email} (reading back): ${(e as Error).message}`);
        if (/quota|rate limit/i.test((e as Error).message)) break;
      }
    }
  }

  // What Claude made of a conversation is kept 30 days after it last changed.
  await db.from("mail_thread").delete().is("pending_since", null).lt("analyzed_at", iso(Date.now() - 30 * 24 * 60 * MIN));
  return out;
}
