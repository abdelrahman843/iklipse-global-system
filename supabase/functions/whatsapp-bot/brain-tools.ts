// What the brain (brain.ts, brain/ in the repo) can use of iklipse: one
// internal API, POST /whatsapp-bot/brain-tools/<name>, signed with
// BRAIN_SECRET, so the logic and who may do what stay here, in one place.
// The brain has no database key of its own.
//
// Every call names its run (brain_run, kept when the message came in) and
// acts as that run's asker; it's refused when the run is over, when it's
// someone else, when the asker isn't on the team anymore or their tier is out
// of the phase, and when the tool isn't for their tier. What each tool does is
// the bot's own code, scoped as the asker (look.ts whoAsks, the Alerts page's
// rule for closing, notes for admins...).
// - Doing things is for admins (the role in iklipse, by their linked number):
//   they ask and it's done, no code, no second asking. The team reads (asks
//   questions) and answers what the bot asked them; clients only their own.
// - While the brain is stopped (the kill switch) only reading works.
// - A change is done once per run (bot_heard), whatever is asked again.
// Underscored names are the run itself: start, reply, steps, finish, and what
// the brain does on its own side (GitHub, deploys: _approval, kept as done by
// the admin who asked).

import { cairoOffset, cairoStamp, closeAlert, iso, MIN, str, TZ, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { askList, askPlace, asksLeft, firstTime, partnerPeople, partners, saveDetails, WHO_IS_WHO, type Detail, type Send } from "./people.ts";
import { directory, type Attendee } from "./meetings.ts";
import { TABLE_GUIDE, whoAsks, type Me } from "./look.ts";
import { answer as answerTurn, clientMeeting, freeTimesOf, orderedMeeting } from "./book.ts";
import { everyone, freshNames, giveOrder, nowText, openTo, ORDER_COLS, orderFollow, orderOutcome, situation, toEach, type Follow, type Order, type Outcome } from "./orders.ts";
import { askTeam, draftIssues, DRAFT_COLS, HOLD, settleDraft, whoIs, type Draft } from "./dm.ts";
import { historyOf } from "./history.ts";
import { reasonsText } from "./guard.ts";
import { cancelReminders, listText, openReminders, setReminder } from "./reminders.ts";
import { alertAct, type AlertAct, type OpenAlert } from "./pause.ts";
import { groupNamed, groupsIn, postInGroup } from "./post.ts";
import { setReport } from "./report.ts";
import { fileNameOf, linkTo, markdownOf, transcribe } from "./transcript.ts";
import { loadTaught, numbered, taughtNotes, teachFrom } from "./notes.ts";
import { asThem, boardCall, boardTools, BoardsRefused } from "./boards.ts";
import {
  bookMeetingCapability,
  closeAlertCapability,
  findCapability,
  freeTimesCapability,
  messageClientCapability,
  messageTeamCapability,
  reminderCapability,
  searchCapability,
  type AlertSeen,
} from "./agent/capabilities.ts";
import { ToolError, type Capability } from "./agent/runtime.ts";
import {
  askOwner,
  brainEnv,
  brainOn,
  brainSettings,
  canonical,
  clientAsker,
  clientKey,
  reaches,
  sha256,
  signedBy,
  tierNow,
  toBrainPost,
  type Asker,
  type BrainEnv,
  type BrainSettings,
  type Tier,
} from "./brain.ts";

/** A document sent by its link (index.ts sendFileAs): its message id. */
export type SendFile = (chatId: string, f: { url: string; name: string; mime: string; caption?: string }) => Promise<string | null>;

export interface Deps {
  db: Db;
  s: Settings;
  t: Team;
  send: Send;
  /** Absent where no file can be sent (tests). */
  sendFile?: SendFile;
  env: BrainEnv;
}

interface Run {
  id: string;
  message_id: string;
  chat_id: string;
  reply_chat: string;
  asker: string | null;
  asker_name: string | null;
  tier: Tier;
  status: string;
  request: string | null;
  quoted_id: string | null;
  created_at: string;
}
const RUN_COLS = "id, message_id, chat_id, reply_chat, asker, asker_name, tier, status, request, quoted_id, created_at";

/** A run's tools work this long after it came in (the longest run is 60 minutes). */
const RUN_LIFE_MS = 90 * MIN;

interface Ctx {
  d: Deps;
  run: Run;
  brain: BrainSettings;
  asker: Asker;
  /** What the asker may read (look.ts); a client reads nothing but their own (who). */
  me: Me | null;
  /** A client: who they are to iklipse (dm.ts whoIs). */
  who: Awaited<ReturnType<typeof whoIs>> | null;
  dir: Awaited<ReturnType<typeof directory>>;
  names: Map<string, string>;
  by: Person;
  /** Where what's done is said: the run's chat, as a reply when that's where it was asked. */
  at: { chat_id: string; message_id: string | null };
}

/** Said back to the brain as the tool's error: nothing was done. maybeDone: it may have been. */
export class Refuse extends Error {
  constructor(
    message: string,
    readonly maybeDone = false,
  ) {
    super(message);
  }
}

interface Spec {
  tiers: Tier[];
  /** Changes something: refused while stopped, done once per run. */
  write: boolean;
  run: (x: Record<string, unknown>, c: Ctx) => Promise<unknown>;
}

const ALL: Tier[] = ["owner", "admin", "member"];
const ADMINS: Tier[] = ["owner", "admin"];
const OWNER: Tier[] = ["owner"];
const CLIENT: Tier[] = ["client"];
/** The team and clients. */
const ANYONE: Tier[] = [...ALL, "client"];

/**
 * The brain's own tools that wait for an OK (brain/src/github.ts): asked and
 * claimed through _approval. Changes to the system: asked for in a private
 * chat only; the owner's are done at once, an admin's wait for the owner's OK
 * (a code goes to the owner, who's told who asked and what).
 */
const BRAIN_HELD: Record<string, Tier[]> = { merge_pr: ADMINS, deploy: ADMINS, rollback: ADMINS, deploy_brain: ADMINS };

const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
/** A secret never goes into the log of what the brain did. */
export const redact = (t: string) =>
  t
    .replace(/(sk-(ant|proj)-[\w-]{8})[\w-]+/g, "$1…")
    .replace(/\b(gh[pousr]_|github_pat_)[\w]{6}[\w]+/g, "$1…")
    .replace(/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, "eyJ…")
    .replace(/\b(xox[abp]-)[\w-]+/g, "$1…")
    .replace(/\b(AIza)[\w-]{10,}/g, "$1…")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key]");

// --------------------------------------------------------------- the run --

async function runOf(db: Db, id: unknown, live = true): Promise<Run> {
  const runId = str(id);
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Refuse("No such run.");
  const { data } = await db.from("brain_run").select(RUN_COLS).eq("id", runId).maybeSingle();
  const run = data as Run | null;
  if (!run) throw new Refuse("No such run.");
  if (live && (!["queued", "running"].includes(run.status) || Date.now() - Date.parse(run.created_at) > RUN_LIFE_MS)) throw new Refuse("This run is over.");
  return run;
}

/** A private chat's number ("201001234567@c.us" -> "201001234567"). */
const phoneOfChat = (chatId: string) => (/^\d{8,15}@c\.us$/.test(chatId) ? chatId.split("@")[0]! : null);

/** Who the run is for now, what they may read, and where things are said. */
async function ctxOf(d: Deps, run: Run): Promise<Ctx> {
  const brain = await brainSettings(d.db);
  if (!brain) throw new Refuse("The brain isn't set up.");
  const dirNow = () => directory(d.db);
  if (run.tier === "client") {
    // A client: who they are now, by their private chat; they read nothing but their own.
    if (!reaches(brain, "client")) throw new Refuse("The brain isn't on for clients yet.");
    const phone = phoneOfChat(run.reply_chat);
    // On the team: never as a client (a guest is, like anyone outside the team).
    const member = phone ? d.t.byPhone.get(phone) : undefined;
    if (member && !member.guest) throw new Refuse("They're on the team.");
    const who = await whoIs(d.db, phone, run.asker_name);
    const asker = clientAsker(run.reply_chat, { id: who.person.kind === "client" ? who.person.id : null, name: who.label });
    const dir = await dirNow();
    return {
      d,
      run,
      brain,
      asker,
      me: null,
      who,
      dir,
      names: new Map(),
      by: { id: "", name: who.label, username: "", active: false, admin: false },
      at: { chat_id: run.reply_chat, message_id: run.message_id },
    };
  }
  const asker = run.asker ? await tierNow(d.db, brain, run.asker) : null;
  if (!asker) throw new Refuse("They aren't someone the brain answers anymore.");
  if (!reaches(brain, asker.tier)) throw new Refuse("The brain isn't on for them yet.");
  const me = await whoAsks(d.db, asker.id);
  if (!me) throw new Refuse("They can't use iklipse.");
  // The owner reads as an admin does; their mail stays theirs.
  if (asker.tier === "owner") me.admin = true;
  const dir = await dirNow();
  const names = new Map([...dir.team.entries()].map(([id, a]) => [id, a.name]));
  const by: Person = d.t.people.get(asker.id) ?? { id: asker.id, name: asker.name, username: "", active: true, admin: asker.admin };
  return {
    d,
    run,
    brain,
    asker,
    me,
    who: null,
    dir,
    names,
    by: { ...by, admin: asker.admin || asker.tier === "owner" },
    at: { chat_id: run.reply_chat, message_id: run.reply_chat === run.chat_id ? run.message_id : null },
  };
}

/** What someone on the team may read; a client never gets here (their tools don't read iklipse). */
function mine(c: Ctx): Me {
  if (!c.me) throw new Refuse("That's for the team.");
  return c.me;
}

/** The private chats someone on the team writes from: the numbers linked to them. */
async function chatsOf(c: Ctx): Promise<string[]> {
  if (c.asker.tier === "client") return [c.run.reply_chat];
  const { data } = await c.d.db.from("wa_member").select("phone").eq("user_id", c.asker.id);
  const mine = ((data ?? []) as { phone: string | null }[]).map((w) => str(w.phone).replace(/\D/g, "")).filter(Boolean).map((p) => `${p}@c.us`);
  return [...new Set([...mine, ...(c.run.reply_chat.endsWith("@c.us") ? [c.run.reply_chat] : [])])];
}

/** One order by its id, as it is now (names as iklipse has them now). */
async function orderById(db: Db, id: unknown): Promise<Order> {
  const oid = str(id);
  if (!/^[0-9a-f-]{36}$/i.test(oid)) throw new Refuse("It needs the order's id (from orders).");
  const { data } = await db.from("bot_order").select(ORDER_COLS).eq("id", oid).maybeSingle();
  if (!data) throw new Refuse("No order has that id.");
  return (await freshNames(db, [data as Order]))[0]!;
}

/** One question to the team about a private chat (bot_draft), still waiting. */
async function draftById(db: Db, id: unknown): Promise<Draft> {
  const did = str(id);
  if (!/^[0-9a-f-]{36}$/i.test(did)) throw new Refuse("It needs the question's id (from what's waiting).");
  const { data } = await db.from("bot_draft").select(`${DRAFT_COLS}, status`).eq("id", did).maybeSingle();
  if (!data) throw new Refuse("No question has that id.");
  if ((data as { status: string }).status !== "waiting") throw new Refuse("That one was already answered.");
  return data as unknown as Draft;
}

/** One of the bot's capabilities (agent/capabilities.ts), checked and run for this asker. */
async function use<I>(cap: Capability<I>, x: unknown, c: Ctx) {
  const v = cap.validate(x);
  if (typeof v === "string") throw new Refuse(v);
  const actor = { id: c.asker.id, name: c.asker.name, role: c.by.admin ? ("admin" as const) : ("member" as const) };
  const ok = cap.allowed(actor);
  if (ok !== true) throw new Refuse(ok);
  try {
    const done = await cap.run(v, { actor, runKey: c.run.id, attempt: 1 });
    return { data: done.data, ...(done.receipt ? { said: done.receipt } : {}), ...(done.verified ? { verified: done.verified } : {}) };
  } catch (e) {
    if (e instanceof ToolError) throw new Refuse(e.message, e.maybeDone);
    throw e;
  }
}

/** A meeting as if they'd asked the bot themselves (book.ts): it does it, and says so where they asked. */
async function meetingSaid(c: Ctx, text: string, key: string) {
  const { db, s, send } = c.d;
  if (!s.book_enabled) return { status: "failed", said: "Booking meetings from WhatsApp is off (Alerts > Settings)." };
  const id = `${c.run.message_id}:${key}`;
  await orderedMeeting(db, { id, chatId: c.at.chat_id, text, quoted: null, userId: c.asker.id });
  await answerTurn(db, s, id, send);
  const { data: turn } = await db.from("wa_bot_turn").select("status, error, thread_id").eq("id", id).maybeSingle();
  const { data: said } = turn
    ? await db.from("wa_bot_turn").select("text").eq("thread_id", turn.thread_id).eq("from_bot", true).order("created_at", { ascending: false }).limit(1)
    : { data: [] };
  return { status: str(turn?.status) || "unknown", said: str((said ?? [])[0]?.text) || str(turn?.error) || null };
}

/** Whether their calendar (wa_bot_meeting) shows it now: a meeting of theirs at that day and time (Cairo), booked or cancelled since. */
async function onCalendar(c: Ctx, date: string, time: string, status: "booked" | "deleted", since: string) {
  const at = Date.parse(`${date}T${time}:00${cairoOffset(new Date(`${date}T12:00:00Z`))}`);
  const { data } = await c.d.db.from("wa_bot_meeting").select("start_at").eq("owner", c.asker.id).eq("status", status).gte(status === "booked" ? "created_at" : "updated_at", since).limit(20);
  return ((data ?? []) as { start_at: string }[]).some((m) => Date.parse(m.start_at) === at);
}

/**
 * One order to everyone on the team (orders.ts everyone): each one's own
 * message ({name} their first name), followed up like any order.
 */
async function toEveryone(x: Record<string, unknown>, c: Ctx) {
  const task = str(x.task);
  const message = str(x.message);
  if (!task || !message) throw new Refuse("It needs the task and the message.");
  const me = c.dir.team.get(c.asker.id);
  const list = everyone(c.dir.team, { id: c.asker.id, phone: me?.phone ?? null }, c.d.s.bot_phone);
  if (!list.length) throw new Refuse("There's nobody else on the team.");
  const names = new Set([...c.dir.team.values()].map((a) => first(a.name).toLowerCase()));
  const sent: string[] = [];
  const problems: string[] = [];
  for (const p of list) {
    const name = first(p.name);
    const g = await giveOrder(c.d.db, c.d.s, c.d.send, c.at, { id: c.asker.id, name: c.asker.name }, str(c.run.request), p, {
      kind: x.kind === "ask" ? "ask" : "tell",
      task,
      message: toEach(message, name, names),
      nudge: toEach(str(x.nudge), name, names),
      wait: x.wait !== false,
    });
    if (g.problem) problems.push(g.problem);
    else sent.push(name);
  }
  return { said: `${sent.length ? `Sent to ${listOf(sent)}.` : "Sent to nobody."}${problems.length ? ` ${problems.join(" ")}` : ""}` };
}

/** The team by id; a guest isn't on it (booked by name, and held: bookMeetingCapability). */
const teamOf = (c: Ctx) => new Map([...c.dir.team].map(([id, a]): [string, Attendee] => [id, c.d.t.people.get(id)?.guest ? { ...a, kind: "guest" } : a]));

/** The people named by their profile ids, on the team now. */
const teamNamed = (c: Ctx, ids: string[]) => ids.map((id) => c.dir.team.get(id.replace(/^t:/, ""))).filter((a): a is Attendee => !!a);

/** The watch_settings columns the brain may change, with the owner's OK: never a token, a key or the WhatsApp line itself. */
const SETTING_DENY = /^(id|bot_phone|bot_state|hook_at|wa_provider|taught)$|token|secret|key|password|instance/i;
const BRAIN_KEYS: Record<string, (v: unknown) => boolean> = {
  phase: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3,
  fallback_old: (v) => typeof v === "boolean",
  model_owner: (v) => typeof v === "string" && /^claude-(haiku|sonnet|opus)-5-5$/.test(v),
  model_member: (v) => typeof v === "string" && /^claude-(haiku|sonnet|opus)-5-5$/.test(v),
  model_fast: (v) => typeof v === "string" && /^claude-(haiku|sonnet|opus)-5-5$/.test(v),
  max_turns: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 200,
  member_turns: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  run_minutes: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 60,
  run_cost_usd: (v) => typeof v === "number" && v > 0 && v <= 100,
  day_cost_usd: (v) => typeof v === "number" && v > 0 && v <= 1000,
};

const patchText = (p: Record<string, unknown>) => Object.entries(p).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");

// -------------------------------------------------------------- the tools --

export const TOOLS: Record<string, Spec> = {
  // ---- reading, as the asker may (look.ts, search.ts)
  find: { tiers: ALL, write: false, run: (x, c) => use(findCapability(c.d.db, mine(c), c.names), x, c) },
  search: { tiers: ALL, write: false, run: (x, c) => use(searchCapability(c.d.db, mine(c)), x, c) },
  overview: {
    tiers: ALL,
    write: false,
    run: async (_x, c) => await situation(c.d.db, c.d.t, c.dir, mine(c).mail),
  },
  free_times: { tiers: ALL, write: false, run: (x, c) => use(freeTimesCapability({ free: (q) => freeTimesOf(c.d.db, c.asker.id, q) }), x, c) },
  reminders: {
    tiers: ALL,
    write: false,
    run: async (_x, c) => {
      const list = await openReminders(c.d.db, c.asker.id);
      return { said: listText(list, { id: c.asker.id, zone: c.dir.team.get(c.asker.id)?.zone }, (id) => c.names.get(id) ?? "someone"), count: list.length };
    },
  },
  taught: {
    tiers: ADMINS,
    write: false,
    run: async (_x, c) => ({ said: await teachFrom(c.d.db, c.d.s, c.d.t, c.by, { id: c.run.message_id, chatId: c.at.chat_id }, { op: "list" }, await taughtNotes(c.d.db)) }),
  },
  brain_log: {
    tiers: ADMINS,
    write: false,
    run: async (x, c) => {
      const days = Math.max(1, Math.min(7, Math.round(Number(x.days) || 1)));
      const from = iso(cairoMidnight() - (days - 1) * 24 * 60 * MIN);
      const { data: runs } = await c.d.db.from("brain_run").select("id, asker_name, tier, request, status, cost_usd, turns, created_at").gte("created_at", from).order("created_at").limit(100);
      const ids = ((runs ?? []) as { id: string }[]).map((r) => r.id);
      const { data: steps } = ids.length ? await c.d.db.from("brain_step").select("run_id, tool, outcome").in("run_id", ids) : { data: [] };
      return ((runs ?? []) as { id: string; asker_name: string | null; tier: string; request: string | null; status: string; cost_usd: number; turns: number | null; created_at: string }[]).map((r) => ({
        at: r.created_at,
        who: r.asker_name,
        asked: str(r.request).slice(0, 200),
        status: r.status,
        cost_usd: Number(r.cost_usd),
        tools: ((steps ?? []) as { run_id: string; tool: string; outcome: string }[]).filter((s) => s.run_id === r.id).map((s) => `${s.tool}: ${s.outcome}`),
      }));
    },
  },
  boards_tools: {
    tiers: ALL,
    write: false,
    run: async (_x, c) => await asThem(c.d.db, c.asker.id, (token) => boardTools(token)),
  },

  // ---- inside the team
  message_team_member: {
    tiers: ADMINS,
    write: true,
    run: (x, c) =>
      str(x.person) === "everyone" ? toEveryone(x, c) : use(
        messageTeamCapability({
          team: c.dir.team,
          botPhone: c.d.s.bot_phone,
          answerTo: c.at.message_id ? "here" : "to you",
          give: (p, q) => giveOrder(c.d.db, c.d.s, c.d.send, c.at, { id: c.asker.id, name: c.asker.name }, str(c.run.request), p, q),
          check: async (id) => {
            const { data } = await c.d.db.from("bot_order").select("status, sent_ids").eq("id", id).maybeSingle();
            return data ? { status: String(data.status), sent: ((data.sent_ids ?? []) as string[]).length } : null;
          },
        }),
        x,
        c,
      ),
  },
  set_reminder: {
    tiers: ADMINS,
    write: true,
    run: (x, c) =>
      use(
        reminderCapability({
          team: c.dir.team,
          me: c.asker.id,
          set: (who, q) =>
            setReminder(c.d.db, c.d.s, {
              by: { id: c.asker.id, name: c.asker.name, zone: c.dir.team.get(c.asker.id)?.zone },
              who,
              text: q.text,
              when: { date: q.date, time: q.time, ampm: q.ampm, in_minutes: q.in_minutes },
              anyTime: q.any_time,
              repeat: { everyMinutes: q.every_minutes, times: q.times, until: { date: q.until_date, time: q.until_time, ampm: q.until_ampm, in_minutes: q.until_in_minutes } },
              sourceId: `brain:${c.run.id}:${q.person}:${q.date}${q.time}${q.ampm}${q.in_minutes}${q.every_minutes ? `:every${q.every_minutes}` : ""}`,
              chatId: c.at.chat_id,
            }),
          check: async (id) => {
            const { data } = await c.d.db.from("bot_reminder").select("status").eq("id", id).maybeSingle();
            return data ? { status: String(data.status) } : null;
          },
        }),
        x,
        c,
      ),
  },
  cancel_reminders: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const list = await openReminders(c.d.db, c.asker.id);
      const which = arr(x.which);
      const ids = which.includes("all") ? list.map((_r, i) => String(i + 1)) : which;
      return { said: await cancelReminders(c.d.db, list, ids, { zone: c.dir.team.get(c.asker.id)?.zone }) };
    },
  },
  close_alert: {
    tiers: ADMINS,
    write: true,
    run: (x, c) =>
      use(
        closeAlertCapability({
          me: mine(c),
          read: async (id) => {
            const { data } = await c.d.db.from("watch_alert").select("id, title, status, source, mail_account, watch_recipient(user_id)").eq("id", id).maybeSingle();
            if (!data) return null;
            const a = data as unknown as AlertSeen & { watch_recipient: { user_id: string }[] | null };
            return { ...a, recipients: (a.watch_recipient ?? []).map((r) => r.user_id) };
          },
          close: (id, note) => closeAlert(c.d.db, id, "handled", note || `Handled, said ${c.asker.name} to the brain`, c.asker.id),
        }),
        x,
        c,
      ),
  },
  alert_pause: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const id = str(x.alert);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Refuse("It needs the alert's id (watch_alert.id): find it first.");
      const cols = "id, chat_id, title, detail, source, created_at, wa_group(name), slack_channel(name)";
      const { data: rows } = await c.d.db.from("watch_alert").select(cols).eq("status", "open").neq("source", "email").order("created_at", { ascending: false }).limit(20);
      const open = ((rows ?? []) as unknown as OpenAlert[]).slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      const alert = open.find((a) => a.id === id);
      if (!alert) throw new Refuse("No open WhatsApp or Slack alert has that id.");
      const act: AlertAct = {
        until_date: str(x.until_date),
        until_time: str(x.until_time),
        until_ampm: str(x.until_ampm),
        pause_minutes: Number(x.pause_minutes) || 0,
        resume: x.resume === true,
        every_min: Number(x.every_min) || 0,
        people: arr(x.people).map((p) => `t:${p.replace(/^t:/, "")}`),
        also: x.also === true,
        stop: x.stop === true,
      };
      const people = teamNamed(c, arr(x.people));
      const said = await alertAct(c.d.db, c.d.s, {
        by: { id: c.asker.id, name: c.asker.name, admin: true, zone: c.dir.team.get(c.asker.id)?.zone },
        act,
        open,
        alert,
        people,
        others: [],
        at: c.at,
      });
      return { said };
    },
  },
  group_report: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const id = str(x.person) === "me" || !str(x.person) ? c.asker.id : str(x.person).replace(/^t:/, "");
      const to = c.dir.team.get(id);
      if (!to) throw new Refuse("They aren't on the team: give their profile.id, or \"me\".");
      const hours = Number(x.every_hours ?? 48);
      return { said: await setReport(c.d.db, { group: str(x.group), to, everyHours: hours, by: c.asker.id, stop: x.stop === true }) };
    },
  },
  transcripts: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      if (!c.d.sendFile) throw new Refuse("Files can't be sent from here.");
      let chat: string | null = c.run.reply_chat;
      if (str(x.group)) {
        const { group, fits } = groupNamed(await groupsIn(c.d.db), str(x.group));
        if (!group) throw new Refuse(fits.length > 1 ? `Which group: ${fits.slice(0, 6).map((g) => g.name).join(", ")}?` : `I'm not in a group called "${str(x.group)}".`);
        chat = group.chat_id;
      }
      const meetings = arr(x.meetings);
      const records = await transcribe(c.d.db, c.d.s, { ids: arr(x.files), chat, since: str(x.since) || null, last: Number(x.last ?? 10) || 10, meetings });
      if (!records.length) return { said: "No recordings found there: nothing sent." };
      const title = str(x.title) || "Transcripts";
      const name = fileNameOf(title);
      const url = await linkTo(c.d.db, name, markdownOf(title, records));
      const done = records.filter((r) => r.text).length;
      const id = await c.d.sendFile(c.at.chat_id, { url, name, mime: "text/markdown", caption: `${done} of ${records.length} written out.` });
      if (!id) throw new Refuse("The file may not have gone: WhatsApp gave no message id.", true);
      const missing = records.filter((r) => !r.text).map((r) => `${r.title}: ${r.why ?? "nothing written out"}`);
      return { said: `Sent ${name} here (${done} of ${records.length} written out).${missing.length ? ` Not written out: ${missing.join("; ")}.` : ""}`, sent_id: id };
    },
  },
  post_in_group: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const text = str(x.text);
      const said = await postInGroup(c.d.db, c.d.send, { admin: true }, { group: str(x.group), text, tag: teamNamed(c, arr(x.tag)), said: [str(c.run.request), text] });
      return { said };
    },
  },
  meeting: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const action = str(x.action) || "book";
      const team = teamOf(c);
      const names = arr(x.with).map((p) => team.get(p.replace(/^t:/, ""))?.name ?? p);
      if (action === "book") {
        // An admin asked: booked as asked, nothing to confirm.
        const cap = bookMeetingCapability({
          team,
          book: async (q, key) => {
            const since = new Date().toISOString();
            const r = await meetingSaid(c, `Book a ${q.minutes ? `${q.minutes}-minute ` : ""}call with ${listOf(q.with)} on ${q.date} at ${q.time}${q.topic ? ` about ${q.topic}` : ""}.`, key);
            // Booked only when the calendar shows it: the booking flow answering (a question, the free times) isn't a booking.
            if (r.status === "done" && !(await onCalendar(c, q.date, q.time, "booked", since))) {
              return { status: "not booked", said: `NOT booked: nothing is on the calendar on ${q.date} at ${q.time}.${r.said ? ` The booking said: ${r.said}` : ""}` };
            }
            return r;
          },
        });
        return await use({ ...cap, confirm: false }, x, c);
      }
      if (action === "link") {
        if (!names.length) throw new Refuse("Who gets the booking link?");
        const since = new Date().toISOString();
        const r = await meetingSaid(c, `Send ${listOf(names)} the booking link${str(x.topic) ? ` for a call about ${str(x.topic)}` : ""}.`, `link:${names.join(",")}`);
        if (r.status === "failed") throw new Refuse(r.said ?? "It didn't go through.");
        // Done only when each one named got their own link (an order to them, orders.ts linkOrders):
        // the plain link posted to the asker's own chat is not sent to anyone.
        const { data: made } = await c.d.db.from("bot_order").select("to_name").eq("by_user", c.asker.id).not("book_url", "is", null).gte("created_at", since);
        const got = (made ?? []).map((o) => str(o.to_name).toLowerCase());
        const missed = names.filter((n) => !got.some((g) => g === n.toLowerCase() || g.split(/\s+/)[0] === n.toLowerCase().split(/\s+/)[0]));
        if (missed.length) {
          throw new Refuse(`The booking link did NOT go to ${listOf(missed)}: it only came to your own chat${r.said ? ` (${r.said})` : ""}. Send it to them another way (message_client or message_team_member, with the link).`);
        }
        return { status: r.status, said: r.said };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(x.date)) || !/^\d{2}:\d{2}$/.test(str(x.time))) throw new Refuse("It needs the meeting's day (YYYY-MM-DD) and time (HH:MM).");
      const text =
        action === "cancel"
          ? `Cancel the call with ${listOf(names)} on ${str(x.date)} at ${str(x.time)}.`
          : `Move the call with ${listOf(names)} on ${str(x.date)} at ${str(x.time)} to ${str(x.new_date)} at ${str(x.new_time)}.`;
      const since = new Date().toISOString();
      const r = await meetingSaid(c, text, `${action}:${str(x.date)}:${str(x.time)}`);
      if (r.status === "failed") throw new Refuse(r.said ?? "It didn't go through.");
      // Done only when the calendar shows it: the old one cancelled, and moved, the new one booked.
      const gone = await onCalendar(c, str(x.date), str(x.time), "deleted", since);
      const there = action === "move" ? await onCalendar(c, str(x.new_date), str(x.new_time), "booked", since) : true;
      if (!gone || !there) {
        throw new Refuse(`NOT ${action === "cancel" ? "cancelled" : "moved"}: the calendar doesn't show it${r.said ? ` (it said: ${r.said})` : ""}. Check wa_bot_meeting before saying anything changed.`);
      }
      return { status: r.status, said: r.said };
    },
  },
  remember: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      // Whoever it says is or isn't a client: moved where they belong (notes.ts), by their client.id when iklipse has them.
      const people = (Array.isArray(x.people) ? x.people : []).map((p) => {
        const r = (p ?? {}) as Record<string, unknown>;
        const client = str(r.client);
        const member = str(r.member);
        return { ref: client ? `c:${client}` : member ? `t:${member}` : "", name: str(r.name), is: str(r.is) };
      });
      const said = await teachFrom(
        c.d.db,
        c.d.s,
        c.d.t,
        c.by,
        { id: c.run.message_id, chatId: c.at.chat_id },
        { op: "teach", notes: arr(x.notes), replaces: arr(x.replaces), people },
        await taughtNotes(c.d.db),
      );
      return { said };
    },
  },
  forget: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const said = await teachFrom(c.d.db, c.d.s, c.d.t, c.by, { id: c.run.message_id, chatId: c.at.chat_id }, { op: "forget", forget: arr(x.numbers) }, await numbered(c.d.db, await taughtNotes(c.d.db)));
      c.d.s.taught = await loadTaught(c.d.db);
      return { said };
    },
  },
  // Reads and changes both (the board tool says which): not once per run, and while stopped only the reading ones (below).
  boards: {
    tiers: ALL,
    write: false,
    run: async (x, c) => {
      const name = str(x.tool);
      const args = (x.arguments && typeof x.arguments === "object" ? x.arguments : {}) as Record<string, unknown>;
      return await asThem(c.d.db, c.asker.id, async (token) => {
        const tool = (await boardTools(token)).find((t) => t.name === name);
        if (!tool) throw new Refuse(`There's no board tool ${name} (boards_tools lists them).`);
        if (c.brain.stopped && !tool.readOnly) throw new Refuse("The brain is stopped: it only reads until an admin says start.");
        // Changing a board is doing something: an admin's to ask for; the team reads.
        if (!c.by.admin && !tool.readOnly) throw new Refuse("Only an admin can ask me to change a board. You can ask me what's on it.");
        const r = await boardCall(token, name, args);
        if (r.error) throw new Refuse(r.text || "The board tool said no.");
        return { result: r.text };
      });
    },
  },

  // ---- what the bot carries on: orders, its questions to the team, clients' details
  orders: {
    tiers: ALL,
    write: false,
    run: async (x, c) => {
      const db = c.d.db;
      const chats = await chatsOf(c);
      const since = iso(Date.now() - 14 * 24 * 60 * MIN);
      const given = db.from("bot_order").select(ORDER_COLS).in("status", ["open", "blocked"]).gte("created_at", since);
      const [toMe, byMe] = await Promise.all([
        chats.length ? db.from("bot_order").select(ORDER_COLS).in("to_chat", chats).eq("status", "open").order("created_at") : Promise.resolve({ data: [] }),
        (x.all === true && c.by.admin ? given : given.eq("by_user", c.asker.id)).order("created_at", { ascending: false }).limit(30),
      ]);
      const line = (o: Order) => ({ id: o.id, kind: o.kind, task: o.task, to: o.to_name, from: o.by_name, status: o.status, reminded: o.times, given: o.created_at, outcome: o.outcome });
      return {
        to_them: (await freshNames(db, (toMe.data ?? []) as Order[])).map(line),
        given: (await freshNames(db, (byMe.data ?? []) as Order[])).map(line),
      };
    },
  },
  order_update: {
    tiers: ANYONE,
    write: true,
    run: async (x, c) => {
      const o = await orderById(c.d.db, x.order);
      if (!o.to_chat || !(await chatsOf(c)).includes(o.to_chat)) throw new Refuse("That order isn't to them.");
      if (o.status !== "open") throw new Refuse("That order is closed already.");
      const result = str(x.result) as Outcome;
      if (!["done", "answer", "blocked", "later", "question"].includes(result)) throw new Refuse("result: done, answer, blocked, later or question.");
      const back = await orderOutcome(c.d.db, c.d.s, c.d.send, o, { result, text: str(x.text), until: str(x.until) });
      if (back === null) throw new Refuse("It needs what they said (text).");
      return { said: result === "later" ? `Noted: reminded ${str(x.until) ? "after then" : "later"}.` : `Passed on to ${o.by_name ?? "the team"} where it was asked.` };
    },
  },
  order_follow: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const o = await orderById(c.d.db, x.order);
      const action = str(x.action) as Follow;
      if (!["relay", "again", "done", "stop"].includes(action)) throw new Refuse("action: relay, again, done or stop.");
      const said: string[] = [];
      await orderFollow(c.d.db, c.d.s, c.d.send, o, { action, text: str(x.text), said: [str(c.run.request)] }, async (t) => {
        said.push(t);
      });
      return { said: said.join(" ") || "Nothing changed: it was closed already." };
    },
  },
  client_details: {
    tiers: ALL,
    write: true,
    run: async (x, c) => {
      const db = c.d.db;
      const asked = (str(x.list) ? await askList(db, { chatId: c.run.chat_id, quotedId: str(x.list) }) : null) ?? (await askList(db, { chatId: c.run.chat_id, quotedId: null }));
      if (!asked) throw new Refuse("I didn't ask about any clients here.");
      const people = (Array.isArray(x.people) ? x.people : []) as Detail[];
      const done = await saveDetails(db, c.d.t, asked.list, people);
      if (!done.length) throw new Refuse(`Nothing saved: say who by their number on the list.\n${asked.lines.join("\n")}`);
      const left = await asksLeft(db);
      return { said: `Saved: ${done.join("; ")}.${left ? ` ${left} still missing something.` : " That's everyone."}` };
    },
  },
  client_chat: {
    tiers: ALL,
    write: true,
    run: async (x, c) => {
      const d = await draftById(c.d.db, x.question);
      const decision = str(x.decision);
      if (!["send", "own", "drop"].includes(decision)) throw new Refuse("decision: send (my reply as it is), own (text), or drop.");
      const text = str(x.text).replace(/[—–]/g, ", ");
      if (decision === "own") {
        if (!text) throw new Refuse("own needs the message to send them.");
        // Only what's theirs, their chat, and what the team said (guard.ts): as a relay to a client is checked.
        const reasons = await draftIssues(c.d.db, d.chat_id, text, true, [str(c.run.request)]);
        if (reasons.length) throw new Refuse(`Not sent: it has ${reasonsText(reasons)}, which isn't theirs, in their chat, or in what you were told. Say exactly what to send.`);
      }
      const said: string[] = [];
      const ok = await settleDraft(c.d.db, d, { decision, text, anyway: x.anyway === true }, c.d.send, async (t) => {
        said.push(t);
        return null;
      });
      if (!ok) throw new Refuse("Nothing to send: I have no reply of my own for them.");
      return { said: said.join(" ") || "Done." };
    },
  },

  // ---- a client's own (phase 3): their meeting, and the team when it's stuck
  client_meeting: {
    tiers: CLIENT,
    write: true,
    run: async (x, c) => {
      const who = c.who!;
      const date = str(x.date);
      const time = str(x.time);
      const m = await clientMeeting(c.d.db, c.d.s, c.d.send, who.person, { date, time });
      // What it says to them goes as it is (times, the link): the brain doesn't repeat it.
      if (m.text) await c.d.send(c.run.reply_chat, m.text, c.run.message_id);
      if (!m.stuck) return { said: m.text ? `Sent them: "${m.text}". Don't repeat it.` : "Done." };
      const place = await askPlace(c.d.db, c.d.s);
      const when = date ? ` on ${date}${time ? ` at ${time}` : ""}` : "";
      if (place) {
        await askTeam(c.d.db, c.d.s, c.d.send, place, {
          chatId: c.run.reply_chat,
          label: who.label,
          asked: str(c.run.request),
          fresh: [str(c.run.request)],
          question: `${first(who.label)} wants a call${when}, but: ${m.stuck} What should I do?`,
          draft: "",
          hold: m.text ? "" : HOLD,
        });
      }
      return { said: `${m.text ? `Sent them: "${m.text}". ` : ""}It couldn't be booked: ${m.stuck}${place ? " The team was asked." : ""}`, stuck: true };
    },
  },
  ask_team: {
    tiers: CLIENT,
    write: true,
    run: async (x, c) => {
      const who = c.who!;
      const place = await askPlace(c.d.db, c.d.s);
      if (!place) throw new Refuse("There's nobody set to ask (Alerts > Settings): tell them the team will get back to them.");
      const draft = str(x.draft).replace(/[—–]/g, ", ");
      const warn = draft ? await draftIssues(c.d.db, c.run.reply_chat, draft) : [];
      const question = str(x.question) || "What should I tell them?";
      await askTeam(c.d.db, c.d.s, c.d.send, place, {
        chatId: c.run.reply_chat,
        label: who.label,
        asked: str(c.run.request),
        fresh: [str(c.run.request)],
        question: warn.length ? `${question}\nMy reply has ${reasonsText(warn)}, which isn't theirs or in their chat.` : question,
        draft,
        hold: str(x.told_them) || HOLD,
        risky: warn.length > 0,
      });
      return { said: "The team was asked. Tell them, briefly, that you're checking and will get back to them." };
    },
  },

  // ---- only with the owner's OK
  message_client: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const outside = partnerPeople(await partners(c.d.db));
      const text = str(x.text);
      return await use(
        messageClientCapability({
          clients: new Map([...c.dir.clients, ...outside]),
          // The exact words the owner OK'd: the check (guard.ts) reads them as asked for.
          send: (to, t) => giveOrder(c.d.db, c.d.s, c.d.send, c.at, { id: c.asker.id, name: c.asker.name }, `${str(c.run.request)}\n${text}`, to, { kind: "tell", task: "a message from the team", message: t, nudge: "", wait: false }),
        }),
        x,
        c,
      );
    },
  },
  team_member: {
    tiers: ADMINS,
    write: true,
    run: (x, c) => teamMember(c, x),
  },
  bot_settings: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const patch = await settingsPatch(c, x.patch);
      const { error } = await c.d.db.from("watch_settings").update(patch).eq("id", 1);
      if (error) throw new Refuse(`Couldn't change it: ${error.message}`);
      return { said: `Changed: ${patchText(patch)}.` };
    },
  },
  // The brain's own settings: the owner's alone.
  brain_settings: {
    tiers: OWNER,
    write: true,
    run: async (x, c) => {
      const patch = brainPatch(x.patch);
      const { error } = await c.d.db.from("brain_settings").update({ ...patch, updated_at: iso(), updated_by: c.asker.id }).eq("id", 1);
      if (error) throw new Refuse(`Couldn't change it: ${error.message}`);
      return { said: `Changed: ${patchText(patch)}.` };
    },
  },
};

/**
 * Someone on the team, as the Users page changes them: role, left or back,
 * name, WhatsApp number, email. A number is one person's: taken from whoever
 * had it. Never your own role or leaving (the Users page's guard).
 */
async function teamMember(c: Ctx, x: Record<string, unknown>) {
  const id = str(x.member);
  const { data: who } = await c.d.db.from("profile").select("id, display_name, role, is_active").eq("id", id).maybeSingle();
  if (!who) throw new Refuse("No one on the team has that id (profile.id): find them first.");
  const name = str(who.display_name);
  const role = str(x.role);
  if (role && !["admin", "member", "guest"].includes(role)) throw new Refuse("The role is admin, member or guest.");
  const left = typeof x.left === "boolean" ? x.left : undefined;
  if (id === c.asker.id && ((role && role !== "admin") || left === true)) throw new Refuse("Not your own role or leaving: another admin does that on the Users page.");
  // The owner's account is theirs: only they change it.
  if (c.asker.tier !== "owner" && id !== c.asker.id && (await tierNow(c.d.db, c.brain, id))?.tier === "owner") throw new Refuse("That's the owner's account: only the owner changes it.");
  const phone = str(x.whatsapp).replace(/\D/g, "");
  if (x.whatsapp !== undefined && phone && !/^[1-9]\d{7,14}$/.test(phone)) throw new Refuse("The number is international digits, like 201001234567.");
  const email = str(x.email).trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Refuse("That isn't an email.");
  const newName = str(x.name).trim();

  const said: string[] = [];
  const p: Record<string, unknown> = {};
  if (role && role !== who.role) p.role = role;
  if (left !== undefined && left === who.is_active) p.is_active = !left;
  if (newName && newName !== name) p.display_name = newName;
  if (Object.keys(p).length) {
    const { error } = await c.d.db.from("profile").update(p).eq("id", id);
    if (error) throw new Refuse(`Couldn't change ${name}: ${error.message}`);
    if (p.role) said.push(`${name} is ${role} now`);
    if (p.is_active === false) said.push(`${name} is marked as left`);
    if (p.is_active === true) said.push(`${name} is back on the team`);
    if (p.display_name) said.push(`${name} is called ${newName} now`);
  }

  const contact: Record<string, unknown> = {};
  if (x.whatsapp !== undefined) contact.whatsapp = phone || null;
  if (x.email !== undefined) contact.email = email || null;
  if (Object.keys(contact).length) {
    if (phone) {
      const { data: had } = await c.d.db.from("profile_contact").select("user_id").eq("whatsapp", phone).neq("user_id", id);
      for (const h of (had ?? []) as { user_id: string }[]) {
        const { error } = await c.d.db.from("profile_contact").update({ whatsapp: null, updated_at: iso() }).eq("user_id", h.user_id);
        if (error) throw new Refuse(`Couldn't take the number from ${c.names.get(h.user_id) ?? "its owner"}: ${error.message}`, said.length > 0);
        said.push(`the number was taken from ${c.names.get(h.user_id) ?? "the one who had it"}`);
      }
    }
    const { error } = await c.d.db.from("profile_contact").upsert({ user_id: id, ...contact, updated_at: iso() }, { onConflict: "user_id" });
    if (error) throw new Refuse(`Couldn't save ${name}'s number or email: ${error.message}`, said.length > 0);
    // The bot knows who writes by its links (wa_member, Alerts > Groups), not the member card: the link moves too.
    if ("whatsapp" in contact) {
      const { error: linkError } = phone
        ? await c.d.db.from("wa_member").upsert({ phone, user_id: id }, { onConflict: "phone" })
        : await c.d.db.from("wa_member").delete().eq("user_id", id);
      if (linkError) throw new Refuse(`Saved ${name}'s number on their card, but the bot doesn't know them by it yet: ${linkError.message}`, true);
    }
    if ("whatsapp" in contact) said.push(phone ? `${name}'s WhatsApp is ${phone}` : `${name} has no WhatsApp number now`);
    if ("email" in contact) said.push(email ? `${name}'s email is ${email}` : `${name} has no email now`);
  }
  if (!said.length) return { said: `Nothing to change: ${name} is already like that.` };
  return { said: `Done: ${said.join("; ")}.` };
}

/** Alerts > Settings values: only columns that exist, never a secret. */
async function settingsPatch(c: Ctx, raw: unknown): Promise<Record<string, unknown>> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keys = Object.keys(p);
  if (!keys.length) throw new Refuse("Which settings, and to what?");
  const known = new Set(Object.keys(c.d.s as unknown as Record<string, unknown>));
  for (const k of keys) {
    if (SETTING_DENY.test(k)) throw new Refuse(`${k} isn't changed from WhatsApp.`);
    if (!known.has(k)) throw new Refuse(`There's no setting ${k}.`);
    const v = p[k];
    if (v !== null && !["string", "number", "boolean"].includes(typeof v)) throw new Refuse(`${k} takes one value.`);
  }
  return p;
}

/** The brain's own settings the owner may change from WhatsApp (never the owner numbers: Alerts > Brain only). */
function brainPatch(raw: unknown): Record<string, unknown> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keys = Object.keys(p);
  if (!keys.length) throw new Refuse("Which settings, and to what?");
  for (const k of keys) {
    const ok = BRAIN_KEYS[k];
    if (!ok) throw new Refuse(`${k} isn't changed from WhatsApp.`);
    if (!ok(p[k])) throw new Refuse(`${k} can't be ${JSON.stringify(p[k])}.`);
  }
  return p;
}

// ------------------------------------------------------------- the steps --

async function step(db: Db, runId: string, tool: string, input: unknown, outcome: string, detail?: string | null, approvalId?: string | null) {
  await db.from("brain_step").insert({
    run_id: runId,
    tool: tool.slice(0, 100),
    input: redact(typeof input === "string" ? input : JSON.stringify(input ?? {})).slice(0, 500),
    outcome: outcome.slice(0, 40),
    detail: detail ? redact(detail).slice(0, 500) : null,
    approval_id: approvalId ?? null,
  });
}

/** One tool call from the brain, checked from the start. */
export async function callTool(d: Deps, name: string, p: Record<string, unknown>) {
  const spec = TOOLS[name];
  if (!spec) throw new Refuse(`There's no tool ${name}.`);
  const run = await runOf(d.db, p.run_id);
  const actor = run.tier === "client" ? clientKey(run.reply_chat) : run.asker;
  if (!actor || str(p.acting_as) !== actor) throw new Refuse("That run is someone else's.");
  const c = await ctxOf(d, run);
  if (!spec.tiers.includes(c.asker.tier)) {
    // Asking the brain to do something is an admin's: the team asks it questions.
    throw new Refuse(c.asker.tier === "member" ? "Only an admin can ask me to do that. You can ask me anything, though." : `${name} isn't for ${c.asker.tier === "client" ? "clients" : "admins"}.`);
  }
  const x = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
  if (spec.write && c.brain.stopped) throw new Refuse("The brain is stopped: it only reads until an admin says start.");
  try {
    // A change: once per run, whatever is asked again (an edit redone, a retry).
    let key: string | null = null;
    if (spec.write) {
      key = `brain:${run.id}:${name}:${(await sha256(canonical(x))).slice(0, 24)}`;
      if (!(await firstTime(d.db, key))) {
        await step(d.db, run.id, name, x, "duplicate");
        return { already: true, said: "Already done for this request." };
      }
    }
    try {
      const out = await spec.run(x, c);
      await step(d.db, run.id, name, x, "ok", typeof (out as { said?: unknown })?.said === "string" ? (out as { said: string }).said : null);
      return out;
    } catch (e) {
      // Not done: asked again, it can be done.
      if (key && !(e instanceof Refuse && e.maybeDone)) await d.db.from("bot_heard").delete().eq("id", key);
      throw e;
    }
  } catch (e) {
    const m = e instanceof Refuse || e instanceof BoardsRefused ? e.message : "That failed.";
    if (!(e instanceof Refuse) && !(e instanceof BoardsRefused)) console.error(JSON.stringify({ ev: "brain.tool_error", tool: name, why: (e as Error).message }));
    await step(d.db, run.id, name, x, e instanceof Refuse && e.maybeDone ? "maybe" : "refused", m).catch(() => null);
    throw new Refuse(m, e instanceof Refuse && e.maybeDone);
  }
}

// -------------------------------------------------------- what was OK'd --

/**
 * Carries out what the owner OK'd, exactly as it was asked: once (claimed
 * from approved), as the asker now (they may have lost the tier since), not
 * while the brain is stopped. Said where it was asked. The brain's own
 * (GitHub, deploys) go to the brain, which claims them itself (_approval_claim).
 */
export async function carryOut(d: Deps, approvalId: string) {
  const { data: row } = await d.db.from("brain_approval").select("*").eq("id", approvalId).maybeSingle();
  if (!row || row.status !== "approved") return;
  if (BRAIN_HELD[row.tool]) {
    try {
      const res = await toBrainPost(d.env, "/approval", { approval_id: approvalId });
      if (!res.ok) throw new Error(`brain answered ${res.status}`);
    } catch (e) {
      await d.db.from("brain_approval").update({ status: "failed", result: `The brain couldn't be reached: ${(e as Error).message}`.slice(0, 500), done_at: iso() }).eq("id", approvalId).eq("status", "approved");
      await say(d, row, `Couldn't do it, the brain isn't answering: ${row.what}`);
    }
    return;
  }
  const { data: took } = await d.db.from("brain_approval").update({ status: "running" }).eq("id", approvalId).eq("status", "approved").select("id");
  if (!took?.length) return;
  const spec = TOOLS[row.tool];
  let ok = false;
  let result: string;
  try {
    if (!spec || !row.run_id) throw new Refuse("Nothing to do it with.");
    const run = await runOf(d.db, row.run_id, false);
    const c = await ctxOf(d, run);
    if (!spec.tiers.includes(c.asker.tier)) throw new Refuse("They can't do that anymore.");
    if (c.brain.stopped) throw new Refuse("The brain is stopped.");
    if ((await sha256(canonical(row.input))) !== row.input_hash) throw new Refuse("What was asked changed.");
    const out = (await spec.run(row.input as Record<string, unknown>, c)) as { said?: unknown } | null;
    result = str(out?.said) || "Done.";
    ok = true;
    await step(d.db, run.id, row.tool, row.input, "approved", result, approvalId);
  } catch (e) {
    result = e instanceof Refuse || e instanceof BoardsRefused ? e.message : "It failed.";
    if (!(e instanceof Refuse)) console.error(JSON.stringify({ ev: "brain.approved_error", approval: approvalId, why: (e as Error).message }));
  }
  await d.db.from("brain_approval").update({ status: ok ? "done" : "failed", result: result.slice(0, 1000), done_at: iso() }).eq("id", approvalId);
  await say(d, row, ok ? `Done, the super admin OK'd it: ${result}` : `Couldn't do it after the OK: ${result}`);
}

/** Said where the run was asked (as a reply there when it can be). */
async function say(d: Deps, row: { chat_id: string; message_id: string | null }, text: string) {
  try {
    await d.send(row.chat_id, text, row.message_id || null);
  } catch (e) {
    console.error(JSON.stringify({ ev: "brain.say_failed", why: (e as Error).message }));
  }
}

// ---------------------------------------------------------- the run itself --

/** Today, Cairo time: its day and when it started (the offset at noon is the day's: Cairo doesn't change at midnight). */
const cairoDay = (now = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(now));
const cairoMidnight = (now = Date.now()) => {
  const day = cairoDay(now);
  return Date.parse(`${day}T00:00:00${cairoOffset(new Date(`${day}T12:00:00Z`))}`);
};

const one = (t: unknown, n = 400) => str(t).replace(/\s+/g, " ").trim().slice(0, n);
const stampOf = (at: string) => cairoStamp.format(new Date(at));
const orderLine = (o: Order) => `- order ${o.id}: ${o.kind} ${o.to_name}: ${one(o.task, 200)} (from ${o.by_name ?? "the team"}, ${o.status}, reminded ${o.times}x, ${stampOf(o.created_at)})`;
const draftLine = (d: Draft) =>
  `- question ${d.id} about ${d.to_name ?? "someone"}'s private chat (asked ${stampOf(d.created_at)}): they wrote "${one(d.asked, 300)}". I asked: ${one(d.question, 300) || "what to tell them"}.${d.draft ? ` My reply would be: "${one(d.draft, 500)}"` : " I have no reply of my own."}`;

/** A private chat's last messages, oldest first. */
async function chatLines(db: Db, chatId: string, n: number) {
  const { data } = await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", chatId).order("sent_at", { ascending: false }).limit(n);
  return ((data ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[]).reverse().map((m) => `[${stampOf(m.sent_at)}] ${m.from_bot ? "BOT" : "THEM"}: ${one(m.text, 600)}`);
}

/**
 * What's going on with them, for the brain: the chat so far, the orders to
 * them and the ones they gave, what the bot asked them and is waiting on, and
 * what the message replies to when it's one of the bot's own (an order's
 * report, a question about a client, a list of clients). Information only.
 */
async function contextFor(c: Ctx): Promise<string> {
  const db = c.d.db;
  const run = c.run;
  const out: string[] = [];
  const section = (title: string, lines: string[]) => lines.length && out.push(`${title}:`, ...lines, "");

  if (c.asker.tier === "client") {
    const who = c.who!;
    const phone = phoneOfChat(run.reply_chat);
    const outside = !!phone && c.d.t.others.has(phone);
    section("Who they are to iklipse", [
      ...(outside ? ["A freelancer, or someone at a partner company: they work with us. Still nothing internal (no client's name, price or number they weren't given)."] : []),
      ...who.known,
    ]);
    const [elsewhere, waiting, orders, chat] = await Promise.all([
      historyOf(db, { phone: who.person.phone, lid: who.lid, email: who.email }, 25),
      db.from("bot_draft").select(DRAFT_COLS).eq("chat_id", run.reply_chat).eq("status", "waiting").order("created_at", { ascending: false }).limit(1),
      openTo(db, run.reply_chat),
      chatLines(db, run.reply_chat, 30),
    ]);
    section("What they said elsewhere (groups, email)", elsewhere);
    section("Waiting on the team about them", ((waiting.data ?? []) as Draft[]).map(draftLine));
    section("What the team asked them through you (order_update when they answer it)", (await freshNames(db, orders)).map(orderLine));
    section("Your private chat with them (BOT is you)", chat);
    return out.join("\n").trim();
  }

  const quoted = run.quoted_id;
  const [report, draft, list] = quoted
    ? await Promise.all([
        db.from("bot_order").select(ORDER_COLS).contains("report_ids", [quoted]).limit(1),
        db.from("bot_draft").select(`${DRAFT_COLS}, status`).contains("ask_ids", [quoted]).limit(1),
        askList(db, { chatId: run.chat_id, quotedId: quoted }),
      ])
    : [null, null, null];
  const sentTo = quoted ? (await db.from("bot_order").select(ORDER_COLS).contains("sent_ids", [quoted]).limit(1)).data : null;
  const r = ((report?.data ?? []) as Order[])[0] ?? ((sentTo ?? []) as Order[])[0];
  if (r) {
    const [o] = await freshNames(db, [r]);
    section("The message replies to the bot about this order (order_follow, or order_update when it's theirs)", [orderLine(o!), ...(o!.to_chat ? (await chatLines(db, o!.to_chat, 6)).map((l) => `  ${l}`) : [])]);
  }
  const dr = ((draft?.data ?? []) as (Draft & { status: string })[])[0];
  if (dr) section(`The message replies to the bot's question about a client's chat (client_chat${dr.status === "waiting" ? "" : `; it's ${dr.status} already`})`, [draftLine(dr)]);
  if (list) section(`The message replies to the bot's list of clients it needs details for (client_details, list ${list.id})`, list.lines);

  if (run.chat_id.endsWith("@g.us")) {
    const { data } = await db
      .from("wa_message")
      .select("sender_name, from_bot, text, sent_at")
      .eq("chat_id", run.chat_id)
      .gt("sent_at", iso(Date.now() - 60 * MIN))
      .order("sent_at", { ascending: false })
      .limit(12);
    section(
      "The group in the last hour",
      ((data ?? []) as { sender_name: string | null; from_bot: boolean; text: string | null; sent_at: string }[]).reverse().map((m) => `[${stampOf(m.sent_at)}] ${m.from_bot ? "BOT" : (m.sender_name ?? "someone")}: ${one(m.text, 400)}`),
    );
    return out.join("\n").trim();
  }

  const chats = await chatsOf(c);
  const since = iso(Date.now() - 14 * 24 * 60 * MIN);
  const [toThem, given, waiting, asked] = await Promise.all([
    chats.length ? db.from("bot_order").select(ORDER_COLS).in("to_chat", chats).eq("status", "open").order("created_at") : Promise.resolve({ data: [] }),
    db.from("bot_order").select(ORDER_COLS).eq("by_user", c.asker.id).in("status", ["open", "blocked"]).gte("created_at", since).order("created_at", { ascending: false }).limit(10),
    chats.length ? db.from("bot_draft").select(DRAFT_COLS).in("ask_chat", chats).eq("status", "waiting").order("created_at", { ascending: false }).limit(5) : Promise.resolve({ data: [] }),
    list ? Promise.resolve(null) : askList(db, { chatId: run.chat_id, quotedId: null }),
  ]);
  section("Orders to them, from the team through you (order_update when their message is about one)", (await freshNames(db, (toThem.data ?? []) as Order[])).map(orderLine));
  section("Orders they gave you, still open or stuck (order_follow)", (await freshNames(db, (given.data ?? []) as Order[])).map(orderLine));
  section("Your questions to them about clients' private chats, waiting (client_chat)", ((waiting.data ?? []) as Draft[]).map(draftLine));
  if (asked && Date.now() - Date.parse(asked.sentAt) < 3 * 24 * 60 * MIN) section(`Clients you asked them about (client_details, list ${asked.id})`, asked.lines);
  section("Your private chat with them (BOT is you; messages other parts of iklipse sent are here too)", await chatLines(db, run.chat_id, 12));
  return out.join("\n").trim();
}

/** Today's spend, Cairo day. */
async function spentToday(db: Db) {
  const day = cairoDay();
  const { data } = await db.from("brain_run").select("cost_usd").gte("created_at", iso(cairoMidnight()));
  return { day, spent: ((data ?? []) as { cost_usd: number | string }[]).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) };
}

async function control(d: Deps, name: string, p: Record<string, unknown>) {
  const { db } = d;
  switch (name) {
    case "_state": {
      const b = await brainSettings(db);
      return { stopped: !!b?.stopped, phase: b?.phase ?? 0 };
    }
    case "_start": {
      // An edit of the message a run answered opens that run again (brain.ts forwardEdit), while it lasts.
      const edit = p.edit === true;
      const run = await runOf(db, p.run_id, !edit);
      if (edit && Date.now() - Date.parse(run.created_at) > RUN_LIFE_MS) throw new Refuse("This run is over.");
      const c = await ctxOf(d, run);
      const { spent } = await spentToday(db);
      const owner = c.asker.tier === "owner" || c.asker.tier === "admin";
      const client = c.asker.tier === "client";
      const model = owner ? c.brain.model_owner : c.brain.model_member;
      await db.from("brain_run").update({ status: "running", started_at: iso(), model, ...(edit ? { finished_at: null } : {}) }).eq("id", run.id);
      // OKs decided for this chat in the last day: the brain knows what came of them.
      const { data: oks } = await db.from("brain_approval").select("what, status, result, done_at").eq("chat_id", run.reply_chat).gt("created_at", iso(Date.now() - 24 * 60 * MIN)).neq("status", "waiting").order("created_at").limit(10);
      const where = run.chat_id.endsWith("@g.us") ? await db.from("wa_group").select("name, kind").eq("chat_id", run.chat_id).maybeSingle() : { data: null };
      return {
        asker: { id: c.asker.id, name: c.asker.name, tier: c.asker.tier, admin: c.asker.admin, zone: (client ? c.who?.person.zone : c.dir.team.get(c.asker.id)?.zone) ?? TZ },
        stopped: c.brain.stopped,
        model,
        model_fast: c.brain.model_fast,
        max_turns: owner ? c.brain.max_turns : c.brain.member_turns,
        run_minutes: c.brain.run_minutes,
        run_cost_usd: c.brain.run_cost_usd,
        spent_today: Math.round(spent * 100) / 100,
        day_cost_usd: c.brain.day_cost_usd,
        over_cap: spent >= c.brain.day_cost_usd,
        now: nowText(),
        where: where.data ? { group: where.data.name, kind: where.data.kind } : { private: true },
        // A client gets neither what the team taught (it can be about anyone) nor the tables.
        taught: client ? null : (c.d.s.taught ?? null),
        // How find's tables connect, and what who_is_who means (look.ts, people.ts): one place for both.
        guide: client
          ? null
          : `${TABLE_GUIDE}

${WHO_IS_WHO}`,
        approvals: oks ?? [],
        context: await contextFor(c).catch((e) => {
          console.error(JSON.stringify({ ev: "brain.context_failed", run: run.id, why: (e as Error).message }));
          return "";
        }),
      };
    }
    case "_reply": {
      // Only in the run's own chat; long answers come in parts (the brain splits them).
      const run = await runOf(db, p.run_id, false);
      if (Date.now() - Date.parse(run.created_at) > RUN_LIFE_MS) throw new Refuse("This run is over.");
      const text = str(p.text).slice(0, 4000);
      if (!text) throw new Refuse("Nothing to say.");
      const quote = p.quote !== false && run.reply_chat === run.chat_id ? run.message_id : null;
      if (run.tier === "client") {
        // To a client, only what's theirs (guard.ts), as the bot's own replies always were: caught, they hear
        // we're checking, and the team gets the reply to OK or change.
        const reasons = await draftIssues(db, run.reply_chat, text);
        if (reasons.length) {
          await step(db, run.id, "_reply", text, "held", `caught: ${reasonsText(reasons)}`);
          if (!(await firstTime(db, `brain-hold:${run.id}`))) return { held: true };
          await d.send(run.reply_chat, HOLD, quote);
          const place = await askPlace(db, d.s);
          if (place) {
            const name = str(run.asker_name) || "Someone";
            await askTeam(db, d.s, d.send, place, {
              chatId: run.reply_chat,
              label: name,
              asked: str(run.request),
              fresh: [str(run.request)],
              question: `I didn't send my reply: it has ${reasonsText(reasons)}, which isn't theirs or in their chat.`,
              draft: text,
              hold: HOLD,
              risky: true,
            });
          }
          return { held: true };
        }
      }
      return { id: await d.send(run.reply_chat, text, quote) };
    }
    case "_step": {
      const run = await runOf(db, p.run_id, false);
      await step(db, run.id, str(p.tool) || "?", p.input, str(p.outcome) || "ok", str(p.detail) || null, str(p.approval_id) || null);
      return { ok: true };
    }
    case "_finish": {
      const run = await runOf(db, p.run_id, false);
      const status = ["done", "failed", "stopped", "timeout", "budget"].includes(str(p.status)) ? str(p.status) : "done";
      await db
        .from("brain_run")
        .update({
          status,
          turns: Math.round(Number(p.turns) || 0),
          cost_usd: Math.max(0, Number(p.cost_usd) || 0),
          ms: Math.round(Number(p.ms) || 0),
          session_id: str(p.session_id) || null,
          error: p.error ? redact(str(p.error)).slice(0, 300) : null,
          finished_at: iso(),
        })
        .eq("id", run.id);
      await spendWatch(d);
      return { ok: true };
    }
    case "_approval": {
      // The brain's own actions (GitHub, deploys): the owner asked, so it's done now. Kept (brain_approval,
      // decided by them) so the brain claims it once, does exactly this input, and what came of it is told.
      // An admin's: the system is the owner's, so it waits for the owner's OK (askOwner), then it's done.
      const run = await runOf(db, p.run_id);
      const c = await ctxOf(d, run);
      const tool = str(p.tool);
      const tiers = BRAIN_HELD[tool];
      if (!tiers) throw new Refuse(`${tool} isn't one of the brain's.`);
      if (!tiers.includes(c.asker.tier)) throw new Refuse("Only an admin can ask me to do that.");
      if (c.brain.stopped) throw new Refuse("The brain is stopped: it only reads until an admin says start.");
      // Changes to the system: only asked for privately, never in a group.
      if (run.chat_id.endsWith("@g.us") || run.reply_chat !== run.chat_id) throw new Refuse("Changes to the system are asked for privately: ask me in our private chat.");
      const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
      if (c.asker.tier !== "owner") {
        const asked = await askOwner(db, c.brain, d.send, {
          run: { id: run.id, reply_chat: run.reply_chat, message_id: run.message_id, asker_name: c.asker.name, tier: c.asker.tier },
          tool,
          input,
          what: str(p.what) || tool,
          why: str(p.why) || null,
          detail: str(p.detail) || null,
        });
        if ("error" in asked) throw new Refuse(asked.error);
        await step(db, run.id, tool, input, "waiting", str(p.what), asked.id);
        return { approval_id: asked.id, waiting: true };
      }
      const id = crypto.randomUUID();
      const { error } = await db.from("brain_approval").insert({
        id,
        run_id: run.id,
        chat_id: run.reply_chat,
        message_id: c.at.message_id,
        tool,
        input,
        input_hash: await sha256(canonical(input)),
        what: (str(p.what) || tool).slice(0, 500),
        why: str(p.why).slice(0, 500) || null,
        detail: str(p.detail).slice(0, 6000) || null,
        // No code: the admin's own request is the OK.
        code_hash: "-",
        status: "approved",
        decided_at: iso(),
        decided_by: c.asker.id,
        created_at: iso(),
        expires_at: iso(Date.now() + 30 * MIN),
      });
      if (error) throw new Refuse("Couldn't keep it to do.");
      await step(db, run.id, tool, input, "ok", str(p.what), id);
      return { approval_id: id };
    }
    case "_approval_claim": {
      const id = str(p.approval_id);
      const { data: row } = await db.from("brain_approval").select("*").eq("id", id).maybeSingle();
      if (!row || !BRAIN_HELD[row.tool]) throw new Refuse("No such OK.");
      const b = await brainSettings(db);
      if (b?.stopped) throw new Refuse("The brain is stopped.");
      const { data: took } = await db.from("brain_approval").update({ status: "running" }).eq("id", id).eq("status", "approved").select("id");
      if (!took?.length) throw new Refuse("It isn't waiting to be done.");
      const run = row.run_id ? await runOf(db, row.run_id, false) : null;
      // The asker may have lost the tier since.
      const asker = run?.asker && b ? await tierNow(db, b, run.asker) : null;
      if (!asker || !BRAIN_HELD[row.tool]!.includes(asker.tier)) {
        await db.from("brain_approval").update({ status: "failed", result: "They can't do that anymore.", done_at: iso() }).eq("id", id);
        throw new Refuse("They can't do that anymore.");
      }
      return { tool: row.tool, input: row.input, input_hash: row.input_hash, run_id: row.run_id, what: row.what };
    }
    case "_approval_done": {
      const id = str(p.approval_id);
      const ok = p.ok === true;
      const result = redact(str(p.result)).slice(0, 1000) || (ok ? "Done." : "It failed.");
      const { data: row } = await db.from("brain_approval").update({ status: ok ? "done" : "failed", result, done_at: iso() }).eq("id", id).eq("status", "running").select("*").maybeSingle();
      if (!row) throw new Refuse("It isn't running.");
      if (row.run_id) await step(db, row.run_id, row.tool, row.input, ok ? "ok" : "failed", result, id);
      // Said in the chat only when it finished later (a deploy followed to its end, the brain back up): else the brain says it.
      if (p.quiet !== true) await say(d, row, ok ? `Done: ${result}` : `It failed: ${result}`);
      return { ok: true };
    }
  }
  throw new Refuse(`There's no ${name}.`);
}

/** The day's spend: the owner hears at 80% and at 100% of the cap, once each a day. */
async function spendWatch(d: Deps) {
  const b = await brainSettings(d.db);
  if (!b?.owner_phones.length) return;
  const { day, spent } = await spentToday(d.db);
  for (const pct of [100, 80]) {
    if (spent < (b.day_cost_usd * pct) / 100) continue;
    if (await firstTime(d.db, `brain-cap:${day}:${pct}`)) {
      const text =
        pct === 100
          ? `The brain spent $${spent.toFixed(2)} today, its daily limit ($${b.day_cost_usd}). It answers nobody until tomorrow, or until the limit is raised (Alerts > Brain).`
          : `The brain spent $${spent.toFixed(2)} today, 80% of its daily limit ($${b.day_cost_usd}).`;
      for (const p of b.owner_phones) await d.send(`${p}@c.us`, text).catch(() => null);
    }
    break;
  }
}

/** POST /whatsapp-bot/brain-tools/<name>: signed by the brain, or refused. */
export async function brainApi(req: Request, name: string, deps: () => Promise<Deps>, e: BrainEnv = brainEnv()): Promise<Response> {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!brainOn(e)) return json({ error: "The brain is off." }, 404);
  const body = await req.text();
  if (!(await signedBy(e.secret, "to-bot", body, req.headers.get("x-brain-signature")))) return json({ error: "Forbidden" }, 403);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  if (!/^_?[a-z_]{2,40}$/.test(name)) return json({ error: "Unknown tool" }, 404);
  const d = await deps();
  try {
    return json({ ok: true, ...((await (name.startsWith("_") ? control(d, name, p) : callTool(d, name, p).then((data) => ({ data })))) as object) });
  } catch (err) {
    if (err instanceof Refuse || err instanceof BoardsRefused) return json({ ok: false, error: err.message, maybe_done: err instanceof Refuse && err.maybeDone });
    console.error(JSON.stringify({ ev: "brain.api_error", name, why: (err as Error).message }));
    return json({ ok: false, error: "That failed on the bot's side." }, 500);
  }
}
