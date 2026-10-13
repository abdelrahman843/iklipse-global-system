// fireflies — each person connects any number of Fireflies.ai accounts with
// the account's API key (0059). Keeps a copy of every meeting the account was
// in (organizer or attendee) and fetches a transcript the first time someone
// opens it. The keys stay here and in fireflies_account (service role only).
//
// POST (login token) { action, ... }:
//   connect { api_key }        -> { id, email, meetings }   (checks the key, first sync)
//   disconnect { account }     -> { ok }
//   sync { account? }          -> { synced, errors }
//   meeting { id }             -> { sentences }            (owner or shared with)
//   media { id }               -> { audio_url, video_url }  (fresh, they expire in a day)
// POST { action: "public", token }  (no login: the email link)
//                              -> { title, started_at, duration, speakers, summary, sentences, shared_by }
// POST /fireflies/tick with X-Iklipse-Secret (pg_cron, every 15 minutes)
//
// Secret: FIREFLIES_WEBHOOK_SECRET (same as Vault fireflies_webhook_secret).
// Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { caller, cors, HttpError, json, route, same, serviceClient, toResponse } from "../_shared/oauth.ts";

const API = "https://api.fireflies.ai/graphql";
const TICK_SECRET = Deno.env.get("FIREFLIES_WEBHOOK_SECRET") ?? "";
const MAX_ACCOUNTS = 10;
const PAGE = 50;
const BACKFILL_PAGES = 6;

interface Account {
  id: string;
  user_id: string;
  ff_user_id: string;
  email: string | null;
  api_key: string;
  backfill_done: boolean;
  backfill_skip: number;
}

class FfError extends Error {
  constructor(message: string, public kind: "auth" | "rate" | "other" = "other") {
    super(message);
  }
}

async function gql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new FfError("Couldn't reach Fireflies");
  }
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message?: string; code?: string; extensions?: { code?: string } }[] };
  const err = body.errors?.[0];
  const text = `${err?.message ?? ""} ${err?.code ?? ""} ${err?.extensions?.code ?? ""}`;
  if (res.status === 401 || res.status === 403 || /auth|api.?key|unauthori|forbidden|invalid.?token/i.test(text)) {
    throw new FfError("Fireflies didn't accept the API key", "auth");
  }
  if (res.status === 429 || /too.?many|rate.?limit/i.test(text)) throw new FfError("Fireflies is limiting requests for now", "rate");
  if (err) throw new FfError(`Fireflies: ${err.message ?? "error"}`);
  if (!res.ok || !body.data) throw new FfError(`Fireflies answered ${res.status}`);
  return body.data;
}

// --------------------------------------------------------------- meetings --
const FIELDS = `id title date duration organizer_email participants transcript_url meeting_link
  meeting_attendees { displayName email name }
  speakers { id name }
  summary { overview short_summary action_items keywords bullet_gist outline shorthand_bullet topics_discussed }`;

const LIST_BY_USER = `query ($uid: String, $limit: Int, $skip: Int, $from: DateTime) {
  transcripts(user_id: $uid, limit: $limit, skip: $skip, fromDate: $from) { ${FIELDS} } }`;
const LIST_ALL = `query ($limit: Int, $skip: Int, $from: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $from) { ${FIELDS} } }`;

// deno-lint-ignore no-explicit-any
type Raw = any;

const text = (v: unknown): string | null => {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).join("\n") || null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const list = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
};

function toRow(accountId: string, t: Raw) {
  const s = t.summary ?? null;
  const summary = s
    ? {
        overview: text(s.overview),
        short_summary: text(s.short_summary),
        action_items: text(s.action_items),
        keywords: list(s.keywords),
        bullet_gist: text(s.bullet_gist),
        outline: text(s.outline),
        shorthand_bullet: text(s.shorthand_bullet),
        topics: list(s.topics_discussed),
      }
    : null;
  const date = Number(t.date);
  return {
    account_id: accountId,
    ff_id: String(t.id),
    title: text(t.title) ?? "Untitled meeting",
    started_at: Number.isFinite(date) && date > 0 ? new Date(date).toISOString() : null,
    duration: Number.isFinite(Number(t.duration)) ? Number(t.duration) : null,
    organizer_email: text(t.organizer_email)?.toLowerCase() ?? null,
    // Fireflies sometimes puts several addresses in one entry.
    participants: list((t.participants ?? []).flatMap((p: string) => String(p).split(","))).map((p) => p.toLowerCase()),
    attendees: (t.meeting_attendees ?? [])
      .map((a: Raw) => ({ name: text(a?.displayName) ?? text(a?.name), email: text(a?.email)?.toLowerCase() ?? null }))
      .filter((a: { name: string | null; email: string | null }) => a.name || a.email),
    speakers: list((t.speakers ?? []).map((x: Raw) => x?.name)),
    transcript_url: text(t.transcript_url),
    meeting_link: text(t.meeting_link),
    summary,
    synced_at: new Date().toISOString(),
  };
}

/** Accounts whose key can't filter by user_id (then: everything the key sees). */
const noUserFilter = new Set<string>();

async function page(a: Account, skip: number, from: string | null): Promise<Raw[]> {
  const vars: Record<string, unknown> = { limit: PAGE, skip };
  if (from) vars.from = from;
  if (!noUserFilter.has(a.id)) {
    try {
      const d = await gql<{ transcripts: Raw[] }>(a.api_key, LIST_BY_USER, { ...vars, uid: a.ff_user_id });
      return d.transcripts ?? [];
    } catch (e) {
      if (!(e instanceof FfError) || e.kind !== "other") throw e;
      noUserFilter.add(a.id);
    }
  }
  const d = await gql<{ transcripts: Raw[] }>(a.api_key, LIST_ALL, vars);
  return d.transcripts ?? [];
}

async function save(db: SupabaseClient, a: Account, rows: Raw[]) {
  if (!rows.length) return;
  const { error } = await db.from("fireflies_meeting").upsert(rows.map((t) => toRow(a.id, t)), { onConflict: "account_id,ff_id" });
  if (error) throw new Error(`save meetings: ${error.message}`);
}

/** New meetings (and summaries that finished since), then older ones a few pages at a time. */
async function syncAccount(db: SupabaseClient, a: Account, deadline: number): Promise<string | null> {
  try {
    const { data: latest } = await db
      .from("fireflies_meeting")
      .select("started_at")
      .eq("account_id", a.id)
      .not("started_at", "is", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.started_at) {
      const from = new Date(Date.parse(latest.started_at) - 3 * 86400_000).toISOString();
      for (let skip = 0; skip < 500 && Date.now() < deadline; skip += PAGE) {
        const rows = await page(a, skip, from);
        await save(db, a, rows);
        if (rows.length < PAGE) break;
      }
    }
    if (!a.backfill_done) {
      let skip = a.backfill_skip;
      let done = false;
      for (let i = 0; i < BACKFILL_PAGES && Date.now() < deadline; i++) {
        const rows = await page(a, skip, null);
        await save(db, a, rows);
        skip += rows.length;
        if (rows.length < PAGE) {
          done = true;
          break;
        }
      }
      await db.from("fireflies_account").update({ backfill_skip: skip, backfill_done: done }).eq("id", a.id);
      a.backfill_skip = skip;
      a.backfill_done = done;
    }
    await db.from("fireflies_account").update({ last_sync_at: new Date().toISOString(), last_error: null }).eq("id", a.id);
    return null;
  } catch (e) {
    const msg =
      e instanceof FfError && e.kind === "auth"
        ? "The API key stopped working. Add the account again with a new key."
        : e instanceof FfError && e.kind === "rate"
          ? "Fireflies is limiting requests; it'll try again later."
          : (e as Error).message.slice(0, 300);
    await db.from("fireflies_account").update({ last_sync_at: new Date().toISOString(), last_error: msg }).eq("id", a.id);
    return msg;
  }
}

// ------------------------------------------------------------- transcript --
const TRANSCRIPT = `query ($id: String!) { transcript(id: $id) { id sentences { index speaker_name text start_time end_time } } }`;
const MEDIA = `query ($id: String!) { transcript(id: $id) { id audio_url video_url } }`;

interface Meeting {
  id: string;
  ff_id: string;
  account_id: string;
  title: string | null;
  started_at: string | null;
  duration: number | null;
  speakers: string[];
  attendees: { name: string | null; email: string | null }[];
  summary: Record<string, unknown> | null;
  sentences: unknown[] | null;
}

async function accountOf(db: SupabaseClient, id: string): Promise<Account> {
  const { data } = await db.from("fireflies_account").select("*").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Meeting not found");
  return data as Account;
}

/** The transcript, fetched once and kept. */
async function sentences(db: SupabaseClient, m: Meeting): Promise<unknown[]> {
  if (m.sentences) return m.sentences;
  const a = await accountOf(db, m.account_id);
  let d: { transcript: Raw };
  try {
    d = await gql<{ transcript: Raw }>(a.api_key, TRANSCRIPT, { id: m.ff_id });
  } catch (e) {
    throw new HttpError(502, (e as Error).message);
  }
  const out = (d.transcript?.sentences ?? []).map((s: Raw) => ({
    i: s.index,
    s: text(s.speaker_name) ?? "Speaker",
    t: text(s.text) ?? "",
    a: Number(s.start_time) || 0,
    b: Number(s.end_time) || 0,
  }));
  // An empty transcript may still be processing: don't keep it.
  if (out.length) await db.from("fireflies_meeting").update({ sentences: out, sentences_at: new Date().toISOString() }).eq("id", m.id);
  return out;
}

/** The meeting, if I own it or it's shared with me. */
async function visible(db: SupabaseClient, userId: string, id: unknown): Promise<Meeting> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "Pick a meeting");
  const { data: m } = await db.from("fireflies_meeting").select("*").eq("id", id).maybeSingle();
  if (!m) throw new HttpError(404, "Meeting not found");
  const { data: a } = await db.from("fireflies_account").select("user_id").eq("id", m.account_id).maybeSingle();
  if (a?.user_id === userId) return m as Meeting;
  const { data: s } = await db.from("fireflies_share").select("meeting_id").eq("meeting_id", id).eq("grantee_id", userId).maybeSingle();
  if (!s) throw new HttpError(404, "Meeting not found");
  const { data: owner } = await db.from("profile").select("is_active").eq("id", a?.user_id).maybeSingle();
  if (!owner?.is_active) throw new HttpError(404, "Meeting not found");
  return m as Meeting;
}

// ------------------------------------------------------------------ public --
async function publicMeeting(db: SupabaseClient, token: unknown) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new HttpError(404, "This link doesn't work");
  const { data: l } = await db.from("fireflies_link").select("*").eq("token", token).is("revoked_at", null).maybeSingle();
  if (!l) throw new HttpError(404, "This link was turned off or doesn't exist");
  const { data: m } = await db.from("fireflies_meeting").select("*").eq("id", l.meeting_id).maybeSingle();
  if (!m) throw new HttpError(404, "This link was turned off or doesn't exist");
  const { data: a } = await db.from("fireflies_account").select("user_id").eq("id", m.account_id).maybeSingle();
  const { data: owner } = await db.from("profile").select("display_name, is_active").eq("id", a?.user_id).maybeSingle();
  if (!owner?.is_active) throw new HttpError(404, "This link was turned off or doesn't exist");
  if (!l.opened_at) await db.from("fireflies_link").update({ opened_at: new Date().toISOString() }).eq("id", l.id);
  let sent: unknown[] = [];
  try {
    sent = await sentences(db, m as Meeting);
  } catch {
    /* the summary still shows */
  }
  const by = l.created_by ? (await db.from("profile").select("display_name").eq("id", l.created_by).maybeSingle()).data?.display_name : null;
  return {
    title: m.title,
    started_at: m.started_at,
    duration: m.duration,
    speakers: m.speakers,
    attendees: (m.attendees ?? []).map((x: { name: string | null }) => x.name).filter(Boolean),
    summary: m.summary,
    sentences: sent,
    shared_by: by ?? owner.display_name,
  };
}

// -------------------------------------------------------------------- tick --
async function tick(req: Request): Promise<Response> {
  if (!same(TICK_SECRET, req.headers.get("x-iklipse-secret") ?? "")) return json({ error: "Not allowed" }, 401);
  const db = serviceClient();
  const deadline = Date.now() + 120_000;
  const stale = new Date(Date.now() - 25 * 60_000).toISOString();
  const { data } = await db
    .from("fireflies_account")
    .select("*")
    .or(`backfill_done.eq.false,last_sync_at.is.null,last_sync_at.lt.${stale}`)
    .order("last_sync_at", { ascending: true, nullsFirst: true })
    .limit(20);
  let n = 0;
  for (const a of (data ?? []) as Account[]) {
    if (Date.now() > deadline) break;
    await syncAccount(db, a, deadline);
    n++;
  }
  return json({ synced: n });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (route(req) === "tick") return tick(req);
  try {
    const db = serviceClient();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "public") return json(await publicMeeting(db, body.token));

    const me = await caller(req, db);

    if (body.action === "connect") {
      const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
      if (key.length < 10 || key.length > 300 || /\s/.test(key)) throw new HttpError(400, "Paste the whole API key");
      let u: { user_id: string; email: string | null; name: string | null };
      try {
        u = (await gql<{ user: Raw }>(key, `query { user { user_id email name } }`)).user;
      } catch (e) {
        throw new HttpError(400, e instanceof FfError && e.kind === "auth" ? "Fireflies didn't accept that API key. Copy it again." : (e as Error).message);
      }
      if (!u?.user_id) throw new HttpError(400, "Fireflies didn't say whose key this is");
      const { data: mine } = await db.from("fireflies_account").select("id, ff_user_id").eq("user_id", me.id);
      const existing = (mine ?? []).find((x) => x.ff_user_id === u.user_id);
      if (!existing && (mine ?? []).length >= MAX_ACCOUNTS) throw new HttpError(400, `You can connect up to ${MAX_ACCOUNTS} Fireflies accounts`);
      const now = new Date().toISOString();
      const { data: row, error } = existing
        ? await db.from("fireflies_account").update({ api_key: key, email: u.email, name: u.name, updated_at: now, last_error: null }).eq("id", existing.id).select("*").single()
        : await db
            .from("fireflies_account")
            .insert({ user_id: me.id, ff_user_id: u.user_id, api_key: key, email: u.email, name: u.name })
            .select("*")
            .single();
      if (error || !row) throw new Error(error?.message ?? "save account");
      await syncAccount(db, row as Account, Date.now() + 40_000);
      const { count } = await db.from("fireflies_meeting").select("id", { count: "exact", head: true }).eq("account_id", row.id);
      return json({ id: row.id, email: u.email, meetings: count ?? 0 });
    }

    if (body.action === "disconnect") {
      await db.from("fireflies_account").delete().eq("id", String(body.account ?? "")).eq("user_id", me.id);
      return json({ ok: true });
    }

    if (body.action === "sync") {
      let q = db.from("fireflies_account").select("*").eq("user_id", me.id);
      if (typeof body.account === "string") q = q.eq("id", body.account);
      const { data } = await q;
      const deadline = Date.now() + 90_000;
      const errors: string[] = [];
      for (const a of (data ?? []) as Account[]) {
        const err = await syncAccount(db, a, deadline);
        if (err) errors.push(`${a.email ?? "Fireflies"}: ${err}`);
      }
      return json({ synced: (data ?? []).length, errors });
    }

    if (body.action === "meeting") {
      const m = await visible(db, me.id, body.id);
      return json({ sentences: await sentences(db, m) });
    }

    if (body.action === "media") {
      const m = await visible(db, me.id, body.id);
      const a = await accountOf(db, m.account_id);
      try {
        const d = await gql<{ transcript: Raw }>(a.api_key, MEDIA, { id: m.ff_id });
        return json({ audio_url: text(d.transcript?.audio_url), video_url: text(d.transcript?.video_url) });
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    }

    throw new HttpError(400, "Unknown action");
  } catch (e) {
    return toResponse(e);
  }
});
