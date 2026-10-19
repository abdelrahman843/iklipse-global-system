// Slack (0078): the iklipse Slack app in client channels, watched the same way
// as the WhatsApp groups.
//
// An admin makes the app from the manifest on Alerts > Slack and invites it
// to channels. Slack sends every message in them here (POST
// /whatsapp-bot/slack, signed with the app's signing secret); the channels an
// admin turned on keep them (for good since 0086), the others aren't kept. Every minute (the
// tick, index.ts) the channels that went quiet are read by Claude (chat.ts).
// Who on Slack is who on the team: an admin's link, else the same email.

import { HttpError, json, same } from "../_shared/oauth.ts";
import { MAX_WAIT_MS, QUIET_MS, readChat, WINDOW_DAYS, WINDOW_MESSAGES, type ChatLine } from "./chat.ts";
import { iso, MIN, str, type Db, type Person, type Settings, type Team } from "./kit.ts";

// ------------------------------------------------------------- Slack API --

const SLACK_ERRORS: Record<string, string> = {
  invalid_auth: "the bot token is wrong",
  not_authed: "the bot token is missing",
  token_revoked: "the bot token was removed: install the app again and paste the new token",
  token_expired: "the bot token expired: install the app again and paste the new token",
  account_inactive: "the app was removed from the workspace",
  missing_scope: "the app is missing a permission: make it again from the manifest, or add the permission and reinstall it",
  ratelimited: "too many requests, try again in a minute",
  channel_not_found: "it can't find that channel",
  not_in_channel: "the iklipse app isn't in that channel",
  user_not_found: "it can't find that person",
};

async function slack<T>(token: string | null, method: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  if (!token) throw new HttpError(409, "Connect the Slack app first (Alerts > Slack)");
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  if (res.status === 429) throw new HttpError(429, `Slack: ${SLACK_ERRORS.ratelimited}`);
  const j = (await res.json().catch(() => ({ ok: false, error: `error ${res.status}` }))) as { ok?: boolean; error?: string; needed?: string };
  if (!j.ok) {
    const e = str(j.error) || "unknown_error";
    throw new HttpError(502, `Slack: ${SLACK_ERRORS[e] ?? e}${e === "missing_scope" && j.needed ? ` (${j.needed})` : ""}`);
  }
  return j as T;
}

/** Every page of a list (users.conversations, conversations.members, users.list). */
async function pages<T>(token: string | null, method: string, params: Record<string, string | number | boolean>, key: string, max: number): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  do {
    const r = await slack<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(token, method, { ...params, ...(cursor ? { cursor } : {}) });
    out.push(...((r[key] as T[] | undefined) ?? []));
    cursor = str(r.response_metadata?.next_cursor);
  } while (cursor && out.length < max);
  return out;
}

/** Checks the token: who the app is, in which workspace. The answer is kept for the Alerts page. */
export async function slackCheck(db: Db, token: string | null) {
  try {
    const a = await slack<{ team?: string; team_id?: string; url?: string; user_id?: string }>(token, "auth.test");
    const url = /^https:\/\/[a-z0-9.-]+\.slack\.com\/?$/i.test(str(a.url)) ? str(a.url).replace(/\/?$/, "/") : null;
    await db
      .from("watch_settings")
      .update({ slack_team: str(a.team) || null, slack_team_id: str(a.team_id) || null, slack_url: url, slack_bot_user: str(a.user_id) || null, slack_state: "ok" })
      .eq("id", 1);
    return { ok: true, team: str(a.team) || null, url };
  } catch (e) {
    const error = (e as Error).message;
    await db.from("watch_settings").update({ slack_state: error.slice(0, 300) }).eq("id", 1);
    return { ok: false, team: null, url: null, error };
  }
}

// ---------------------------------------------------------------- people --

interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  profile?: { display_name?: string; real_name?: string; email?: string; image_72?: string; image_48?: string };
}

function userRow(u: SlackUser, teamId: string | null) {
  const p = u.profile ?? {};
  return {
    slack_id: u.id,
    name: str(p.display_name) || str(p.real_name) || str(u.real_name) || str(u.name) || null,
    real_name: str(p.real_name) || str(u.real_name) || null,
    email: str(p.email).toLowerCase() || null,
    avatar: str(p.image_72) || str(p.image_48) || null,
    is_bot: !!u.is_bot || u.id === "USLACKBOT",
    external: !!teamId && !!u.team_id && u.team_id !== teamId,
    guest: !!(u.is_restricted || u.is_ultra_restricted),
    deleted: !!u.deleted,
    updated_at: iso(),
  };
}

/** Names and emails of these people, from Slack, for the ones not known (or not lately). */
async function learnUsers(db: Db, token: string | null, teamId: string | null, ids: (string | null)[], max: number, deadline: number) {
  const want = [...new Set(ids.filter((id): id is string => !!id && /^[UW][A-Z0-9]+$/.test(id)))];
  if (!want.length) return;
  const fresh = new Set<string>();
  for (let i = 0; i < want.length; i += 200) {
    const { data } = await db.from("slack_user").select("slack_id, updated_at").in("slack_id", want.slice(i, i + 200));
    for (const u of data ?? []) if (Date.now() - Date.parse(u.updated_at) < 7 * 24 * 60 * MIN) fresh.add(u.slack_id);
  }
  let asked = 0;
  for (const id of want) {
    if (fresh.has(id)) continue;
    if (asked >= max || Date.now() > deadline) break;
    asked++;
    try {
      const { user } = await slack<{ user: SlackUser }>(token, "users.info", { user: id });
      await db.from("slack_user").upsert(userRow(user, teamId), { onConflict: "slack_id" });
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) break;
      // Someone Slack won't show (another company's, gone): asked again in a week.
      if ((e as Error).message.includes(SLACK_ERRORS.user_not_found)) await db.from("slack_user").upsert({ slack_id: id, updated_at: iso() }, { onConflict: "slack_id" });
    }
  }
}

/** Every Slack person who is someone on the team. */
async function slackTeam(db: Db, t: Team): Promise<Map<string, Person>> {
  const { data, error } = await db.rpc("_slack_links");
  if (error) throw new Error(error.message);
  const out = new Map<string, Person>();
  for (const [sid, uid] of Object.entries((data ?? {}) as Record<string, string>)) {
    const p = t.people.get(uid);
    if (p) out.set(sid, p);
  }
  return out;
}

// -------------------------------------------------------------- channels --

interface SlackConversation {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  num_members?: number;
}

const sharedOf = (c: SlackConversation) => !!(c.is_ext_shared || c.is_pending_ext_shared);

/** A channel's name and who is in it now. */
async function syncChannel(db: Db, token: string | null, teamId: string | null, id: string, deadline: number) {
  const { channel: c } = await slack<{ channel: SlackConversation }>(token, "conversations.info", { channel: id, include_num_members: true });
  const now = iso();
  if (c.is_archived || c.is_member === false) {
    await db.from("slack_channel").update({ name: str(c.name) || null, left_at: now, synced_at: now, pending_since: null }).eq("channel_id", id);
    return;
  }
  const members = await pages<string>(token, "conversations.members", { channel: id, limit: 1000 }, "members", 5000);
  if (members.length) {
    await db.from("slack_participant").delete().eq("channel_id", id).not("slack_id", "in", `(${members.map((m) => `"${m}"`).join(",")})`);
    await db.from("slack_participant").upsert(members.map((m) => ({ channel_id: id, slack_id: m })), { onConflict: "channel_id,slack_id", ignoreDuplicates: true });
  }
  await db
    .from("slack_channel")
    .update({ name: str(c.name) || null, is_private: !!c.is_private, is_shared: sharedOf(c), size: c.num_members ?? members.length, synced_at: now, left_at: null, last_error: null })
    .eq("channel_id", id);
  await learnUsers(db, token, teamId, members, 100, deadline);
}

/** Admins (Read the channels): every channel the app is in, who is in each, and their names. */
export async function slackSync(db: Db, token: string | null, deadline: number) {
  const check = await slackCheck(db, token);
  if (!check.ok) throw new HttpError(502, check.error ?? "Slack isn't connected");
  const { data: s } = await db.from("watch_settings").select("slack_team_id").eq("id", 1).single();
  const teamId = (s?.slack_team_id as string | null) ?? null;
  const chans = await pages<SlackConversation>(token, "users.conversations", { types: "public_channel,private_channel", exclude_archived: true, limit: 200 }, "channels", 2000);
  const ids = chans.map((c) => c.id);
  const { data: known } = await db.from("slack_channel").select("channel_id, left_at");
  const have = new Set((known ?? []).map((c) => c.channel_id));
  // New channels start off: an admin turns on the ones to watch.
  const fresh = chans.filter((c) => !have.has(c.id)).map((c) => ({ channel_id: c.id, name: str(c.name) || null, is_private: !!c.is_private, is_shared: sharedOf(c) }));
  if (fresh.length) await db.from("slack_channel").insert(fresh);
  const gone = (known ?? []).filter((c) => !c.left_at && !ids.includes(c.channel_id)).map((c) => c.channel_id);
  if (gone.length) await db.from("slack_channel").update({ left_at: iso(), pending_since: null }).in("channel_id", gone);
  const back = (known ?? []).filter((c) => c.left_at && ids.includes(c.channel_id)).map((c) => c.channel_id);
  if (back.length) await db.from("slack_channel").update({ left_at: null, synced_at: null }).in("channel_id", back);
  await db.from("watch_settings").update({ slack_synced_at: iso() }).eq("id", 1);
  // The workspace's people in one go (names and emails); other companies' one by one below.
  try {
    const all = await pages<SlackUser>(token, "users.list", { limit: 200 }, "members", 2000);
    for (let i = 0; i < all.length; i += 200) {
      await db.from("slack_user").upsert(all.slice(i, i + 200).map((u) => userRow(u, teamId)), { onConflict: "slack_id" });
    }
  } catch (e) {
    console.error("slack users", (e as Error).message);
  }
  let read = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    try {
      await syncChannel(db, token, teamId, id, deadline);
      read++;
    } catch (e) {
      await db.from("slack_channel").update({ last_error: (e as Error).message.slice(0, 300) }).eq("channel_id", id);
    }
  }
  return { channels: ids.length, read };
}

// ------------------------------------------------------------- the hook --

const enc = (t: string) => new TextEncoder().encode(t);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Slack signed it with the app's signing secret, in the last 5 minutes. */
async function signed(req: Request, raw: string, secret: string) {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`v0:${ts}:${raw}`)));
  return same(req.headers.get("x-slack-signature") ?? "", `v0=${hex(mac)}`);
}

interface SlackFile {
  name?: string;
  mimetype?: string;
}

/** The words of a message, its files named. */
function readSlack(m: { text?: string; files?: SlackFile[] }) {
  const files = (Array.isArray(m.files) ? m.files : []).map((f) => {
    const mime = str(f.mimetype);
    const what = mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "voice note" : "file";
    return `[${what}${f.name && what === "file" ? `: ${str(f.name)}` : ""}]`;
  });
  return [str(m.text), ...files].filter(Boolean).join(" ").trim();
}

// deno-lint-ignore no-explicit-any
type SlackEvent = Record<string, any>;

export async function slackHook(req: Request, db: Db, secret: string | null): Promise<Response> {
  const raw = await req.text();
  let b: SlackEvent;
  try {
    b = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // Slack checks the URL when the app is made, before its signing secret is
  // saved here: the answer is only Slack's own challenge.
  if (b?.type === "url_verification") {
    if (secret && !(await signed(req, raw, secret))) return new Response("Forbidden", { status: 403 });
    return json({ challenge: str(b.challenge) });
  }
  if (!secret || !(await signed(req, raw, secret))) return new Response("Forbidden", { status: 403 });
  if (b.type !== "event_callback" || !b.event) return json({ ok: true });
  const { data: s } = await db.from("watch_settings").select("slack_enabled, slack_bot_user").eq("id", 1).single();
  await db.from("watch_settings").update({ slack_hook_at: iso() }).eq("id", 1);
  if (!s?.slack_enabled) return json({ ok: true });
  await onEvent(db, b.event, (s.slack_bot_user as string | null) ?? null);
  return json({ ok: true });
}

async function onEvent(db: Db, e: SlackEvent, bot: string | null) {
  const type = str(e.type);
  if (type === "channel_rename" || type === "group_rename") {
    if (e.channel?.id) await db.from("slack_channel").update({ name: str(e.channel.name) || null }).eq("channel_id", str(e.channel.id));
    return;
  }
  const channel = str(e.channel);
  if (!/^[CG][A-Z0-9]+$/.test(channel)) return; // never direct messages
  if (type === "member_joined_channel" || type === "member_left_channel") {
    const who = str(e.user);
    if (!who) return;
    if (who === bot) {
      // Invited: listed (off until an admin turns it on) and read at the next minute. Removed: left.
      if (type === "member_joined_channel") {
        await db.from("slack_channel").upsert({ channel_id: channel, is_private: e.channel_type === "G", left_at: null, synced_at: null }, { onConflict: "channel_id" });
      } else {
        await db.from("slack_channel").update({ left_at: iso(), pending_since: null }).eq("channel_id", channel);
      }
    } else if (type === "member_joined_channel") {
      await db.from("slack_participant").upsert({ channel_id: channel, slack_id: who }, { onConflict: "channel_id,slack_id", ignoreDuplicates: true });
    } else {
      await db.from("slack_participant").delete().eq("channel_id", channel).eq("slack_id", who);
    }
    return;
  }
  if (type !== "message") return;
  if (e.channel_type && !["channel", "group"].includes(str(e.channel_type))) return;

  const { data: c } = await db.from("slack_channel").select("monitored, pending_since, left_at").eq("channel_id", channel).maybeSingle();
  if (!c) {
    // A channel it hadn't seen: listed, off.
    await db.from("slack_channel").insert({ channel_id: channel, is_private: e.channel_type === "group" });
    return;
  }
  if (!c.monitored) return;
  if (c.left_at) await db.from("slack_channel").update({ left_at: null }).eq("channel_id", channel);

  const sub = str(e.subtype);
  if (sub === "message_deleted") {
    await db.from("slack_message").delete().eq("channel_id", channel).eq("ts", str(e.deleted_ts));
    return;
  }
  if (sub === "message_changed") {
    // Edited by its writer (not a link preview added by Slack).
    const m = e.message ?? {};
    const text = readSlack(m);
    if (m.edited && text) await db.from("slack_message").update({ text: `${text} (edited)`.slice(0, 4000) }).eq("channel_id", channel).eq("ts", str(m.ts));
    return;
  }
  // People's messages only: not joins, topic changes, or other apps.
  if (sub && !["file_share", "thread_broadcast", "me_message"].includes(sub)) return;
  const user = str(e.user);
  if (e.bot_id || !user || user === bot) return;
  const text = readSlack(e);
  const ts = str(e.ts);
  if (!text || !/^\d+\.\d+$/.test(ts)) return;
  const sentAt = iso(Number(ts) * 1000);
  const thread = str(e.thread_ts);
  await db.from("slack_message").upsert(
    { channel_id: channel, ts, slack_id: user, thread_ts: thread && thread !== ts ? thread : null, text: text.slice(0, 4000), sent_at: sentAt },
    { onConflict: "channel_id,ts", ignoreDuplicates: true },
  );
  await db.from("slack_channel").update({ last_message_at: sentAt, ...(c.pending_since ? {} : { pending_since: iso() }) }).eq("channel_id", channel);
  await db.from("slack_participant").upsert({ channel_id: channel, slack_id: user }, { onConflict: "channel_id,slack_id", ignoreDuplicates: true });
}

// ---------------------------------------------------------------- reading --

/** Slack's markup in plain words: <@U1> -> @Name, <#C1|general> -> #general, <url|label> -> label (url). */
function plain(text: string, nameOf: (id: string) => string) {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, n: string) => `#${n || "channel"}`)
    .replace(/<#[A-Z0-9]+>/g, "#channel")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w: string) => `@${w}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, n: string | undefined) => n || "@group")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Read a channel's new messages; open and close its alerts (chat.ts). */
async function analyze(db: Db, s: Settings, t: Team, token: string | null, id: string, deadline: number) {
  const started = iso();
  const { data: c } = await db.from("slack_channel").select("channel_id, name, analyzed_at").eq("channel_id", id).single();
  if (!c) return { opened: 0, resolved: 0 };
  const { data: rows } = await db
    .from("slack_message")
    .select("ts, slack_id, thread_ts, text, sent_at, created_at")
    .eq("channel_id", id)
    .gte("sent_at", iso(Date.now() - WINDOW_DAYS * 24 * 60 * MIN))
    .order("sent_at", { ascending: false })
    .limit(WINDOW_MESSAGES);
  const msgs = (rows ?? []).reverse();
  const isNew = (m: { created_at: string }) => !c.analyzed_at || Date.parse(m.created_at) > Date.parse(c.analyzed_at);
  const done = async () => {
    // New messages that came in while reading wait for the next look.
    const { count } = await db.from("slack_message").select("ts", { count: "exact", head: true }).eq("channel_id", id).gt("created_at", started);
    await db
      .from("slack_channel")
      .update({ analyzed_at: started, last_error: null, ...(count ? {} : { pending_since: null }) })
      .eq("channel_id", id);
  };
  if (!msgs.some(isNew)) {
    await done();
    return { opened: 0, resolved: 0 };
  }

  // Who wrote and who was mentioned: their names (and emails, to know the team) first.
  const mentioned = msgs.flatMap((m) => [...str(m.text).matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]));
  await learnUsers(db, token, s.slack_team_id, [...msgs.map((m) => m.slack_id), ...mentioned], 30, deadline);
  const team = await slackTeam(db, t);
  const ids = [...new Set([...msgs.map((m) => m.slack_id as string | null), ...mentioned].filter((x): x is string => !!x))];
  const { data: users } = ids.length ? await db.from("slack_user").select("slack_id, name, real_name").in("slack_id", ids) : { data: [] };
  const names = new Map<string, string | null>((users ?? []).map((u) => [u.slack_id as string, (u.name as string | null) || (u.real_name as string | null)]));
  const nameOf = (sid: string) => team.get(sid)?.name ?? (names.get(sid) || "Someone");

  // The team in this channel: its members who are on the team, and anyone on the team who wrote here.
  const inChannel = new Map<string, Person>();
  const { data: parts } = await db.from("slack_participant").select("slack_id").eq("channel_id", id);
  for (const p of parts ?? []) {
    const who = team.get(p.slack_id);
    if (who?.active) inChannel.set(who.id, who);
  }
  for (const m of msgs) {
    const who = m.slack_id ? team.get(m.slack_id) : undefined;
    if (who?.active) inChannel.set(who.id, who);
  }

  const lines: ChatLine[] = msgs.map((m) => ({
    id: m.ts,
    sent_at: m.sent_at,
    isNew: isNew(m),
    team: !!(m.slack_id && team.get(m.slack_id)),
    name: m.slack_id ? nameOf(m.slack_id) : "Someone",
    replyTo: m.thread_ts,
    text: plain(m.text ?? "", nameOf),
  }));
  const r = await readChat(db, s, t, { source: "slack", col: "channel_id", id, name: `#${c.name ?? "channel"}` }, lines, inChannel);
  await done();
  return r;
}

/** Every minute: who is in the channels, and the ones with new messages read. */
export async function watchSlack(db: Db, s: Settings, t: Team, token: string | null, deadline: number) {
  const out = { synced: 0, analyzed: 0, opened: 0, resolved: 0, errors: [] as string[] };
  if (!token) {
    out.errors.push("The Slack app isn't connected");
    return out;
  }
  // Not checked since it was saved: who the app is (its own messages aren't read).
  if (!s.slack_bot_user) {
    const r = await slackCheck(db, token);
    if (!r.ok) {
      out.errors.push(r.error ?? "Slack");
      return out;
    }
  }

  // Who is in them: new channels once (for their names), watched ones twice a day.
  const { data: stale } = await db
    .from("slack_channel")
    .select("channel_id")
    .is("left_at", null)
    .or(`synced_at.is.null,and(monitored.eq.true,synced_at.lt."${iso(Date.now() - 12 * 60 * MIN)}")`)
    .order("monitored", { ascending: false })
    .limit(3);
  for (const c of stale ?? []) {
    if (Date.now() > deadline) break;
    try {
      await syncChannel(db, token, s.slack_team_id, c.channel_id, deadline);
      out.synced++;
    } catch (e) {
      out.errors.push((e as Error).message);
      await db.from("slack_channel").update({ synced_at: iso(), last_error: (e as Error).message.slice(0, 300) }).eq("channel_id", c.channel_id);
    }
  }

  // Channels with new messages that went quiet.
  const { data: pending } = await db
    .from("slack_channel")
    .select("channel_id, pending_since, last_message_at")
    .eq("monitored", true)
    .not("pending_since", "is", null)
    .order("pending_since")
    .limit(8);
  for (const c of pending ?? []) {
    if (Date.now() > deadline) break;
    const quiet = !c.last_message_at || Date.now() - Date.parse(c.last_message_at) >= QUIET_MS;
    const long = Date.now() - Date.parse(c.pending_since) >= MAX_WAIT_MS;
    if (!quiet && !long) continue;
    try {
      const r = await analyze(db, s, t, token, c.channel_id, deadline);
      out.analyzed++;
      out.opened += r.opened;
      out.resolved += r.resolved;
    } catch (e) {
      out.errors.push((e as Error).message);
      await db.from("slack_channel").update({ last_error: (e as Error).message.slice(0, 300) }).eq("channel_id", c.channel_id);
    }
  }

  return out;
}
