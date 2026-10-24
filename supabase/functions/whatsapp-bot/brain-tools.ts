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
// - While the brain is stopped (the kill switch) only reading works.
// - A change is done once per run (bot_heard), whatever is asked again.
// - What can't be undone (a message to a client or a client group, a meeting
//   with a client or cancelling one, the settings) isn't done here: it's kept
//   for the owner's OK (brain.ts askOwner) and done only when the owner
//   answers its code (carryOut), exactly as it was asked.
// Underscored names are the run itself: start, reply, steps, finish, and the
// OKs of what the brain does on its own side (GitHub, deploys).

import { cairoOffset, closeAlert, iso, MIN, str, TZ, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { firstTime, partnerPeople, partners, WHO_IS_WHO, type Send } from "./people.ts";
import { directory, type Attendee } from "./meetings.ts";
import { TABLE_GUIDE, whoAsks, type Me } from "./look.ts";
import { answer as answerTurn, freeTimesOf, orderedMeeting } from "./book.ts";
import { giveOrder, nowText, situation } from "./orders.ts";
import { cancelReminders, listText, openReminders, setReminder } from "./reminders.ts";
import { alertAct, type AlertAct, type OpenAlert } from "./pause.ts";
import { groupNamed, groupsIn, postInGroup } from "./post.ts";
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

export interface Deps {
  db: Db;
  s: Settings;
  t: Team;
  send: Send;
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
  created_at: string;
}
const RUN_COLS = "id, message_id, chat_id, reply_chat, asker, asker_name, tier, status, request, created_at";

/** A run's tools work this long after it came in (the longest run is 60 minutes). */
const RUN_LIFE_MS = 90 * MIN;

interface Ctx {
  d: Deps;
  run: Run;
  brain: BrainSettings;
  asker: Asker;
  me: Me;
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

/** Held for the owner: what they're shown. null: it goes ahead now. */
type Hold = { what: string; detail?: string } | null;

interface Spec {
  tiers: Tier[];
  /** Changes something: refused while stopped, done once per run. */
  write: boolean;
  hold?: (x: Record<string, unknown>, c: Ctx) => Promise<Hold> | Hold;
  run: (x: Record<string, unknown>, c: Ctx) => Promise<unknown>;
}

const ALL: Tier[] = ["owner", "admin", "member"];
const ADMINS: Tier[] = ["owner", "admin"];
const OWNER: Tier[] = ["owner"];

/** The brain's own tools that wait for the owner (brain/src/github.ts): asked and claimed through _approval. */
const BRAIN_HELD: Record<string, Tier[]> = { merge_pr: ADMINS, deploy: OWNER, rollback: OWNER, deploy_brain: OWNER };

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

/** Who the run is for now, what they may read, and where things are said. */
async function ctxOf(d: Deps, run: Run): Promise<Ctx> {
  const brain = await brainSettings(d.db);
  if (!brain) throw new Refuse("The brain isn't set up.");
  const asker = run.asker ? await tierNow(d.db, brain, run.asker) : null;
  if (!asker) throw new Refuse("They aren't someone the brain answers anymore.");
  if (!reaches(brain, asker.tier)) throw new Refuse("The brain isn't on for them yet.");
  const me = await whoAsks(d.db, asker.id);
  if (!me) throw new Refuse("They can't use iklipse.");
  // The owner reads as an admin does; their mail stays theirs.
  if (asker.tier === "owner") me.admin = true;
  const dir = await directory(d.db);
  const names = new Map([...dir.team.entries()].map(([id, a]) => [id, a.name]));
  const by: Person = d.t.people.get(asker.id) ?? { id: asker.id, name: asker.name, username: "", active: true, admin: asker.admin };
  return {
    d,
    run,
    brain,
    asker,
    me,
    dir,
    names,
    by: { ...by, admin: asker.admin || asker.tier === "owner" },
    at: { chat_id: run.reply_chat, message_id: run.reply_chat === run.chat_id ? run.message_id : null },
  };
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

/** The team by id; a guest isn't on it (booked by name, and held: bookMeetingCapability). */
const teamOf = (c: Ctx) => new Map([...c.dir.team].map(([id, a]): [string, Attendee] => [id, c.d.t.people.get(id)?.guest ? { ...a, kind: "guest" } : a]));

/** The people named by their profile ids, on the team now. */
const teamNamed = (c: Ctx, ids: string[]) => ids.map((id) => c.dir.team.get(id.replace(/^t:/, ""))).filter((a): a is Attendee => !!a);

/** The watch_settings columns the brain may change, with the owner's OK: never a token, a key or the WhatsApp line itself. */
const SETTING_DENY = /^(id|bot_phone|bot_state|hook_at|wa_provider|taught)$|token|secret|key|password|instance/i;
const BRAIN_KEYS: Record<string, (v: unknown) => boolean> = {
  phase: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 2,
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
  find: { tiers: ALL, write: false, run: (x, c) => use(findCapability(c.d.db, c.me, c.names), x, c) },
  search: { tiers: ALL, write: false, run: (x, c) => use(searchCapability(c.d.db, c.me), x, c) },
  overview: {
    tiers: ALL,
    write: false,
    run: async (_x, c) => await situation(c.d.db, c.d.t, c.dir, c.me.mail),
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
    tiers: ALL,
    write: true,
    run: (x, c) =>
      use(
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
    tiers: ALL,
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
              sourceId: `brain:${c.run.id}:${q.person}:${q.date}${q.time}${q.ampm}${q.in_minutes}`,
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
    tiers: ALL,
    write: true,
    run: async (x, c) => {
      const list = await openReminders(c.d.db, c.asker.id);
      const which = arr(x.which);
      const ids = which.includes("all") ? list.map((_r, i) => String(i + 1)) : which;
      return { said: await cancelReminders(c.d.db, list, ids, { zone: c.dir.team.get(c.asker.id)?.zone }) };
    },
  },
  close_alert: {
    tiers: ALL,
    write: true,
    run: (x, c) =>
      use(
        closeAlertCapability({
          me: c.me,
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
  post_in_group: {
    tiers: ADMINS,
    write: true,
    // A client's group reads it: the owner OKs it first.
    hold: async (x, c) => {
      const { group, fits } = groupNamed(await groupsIn(c.d.db), str(x.group));
      if (!group) throw new Refuse(fits.length > 1 ? `Which group: ${fits.slice(0, 6).map((g) => g.name).join(", ")}?` : `I'm not in a group called "${str(x.group)}".`);
      return group.kind === "team" ? null : { what: `post in ${group.name} (a client group): "${str(x.text).slice(0, 300)}"`, detail: str(x.text) };
    },
    run: async (x, c) => {
      const text = str(x.text);
      const said = await postInGroup(c.d.db, c.d.send, { admin: true }, { group: str(x.group), text, tag: teamNamed(c, arr(x.tag)), said: [str(c.run.request), text] });
      return { said };
    },
  },
  meeting: {
    tiers: ALL,
    write: true,
    // With a client, or cancelling one: the owner OKs it first.
    hold: (x, c) => {
      const action = str(x.action) || "book";
      const team = teamOf(c);
      const people = arr(x.with);
      const outside = people.some((p) => team.get(p.replace(/^t:/, ""))?.kind !== "team");
      const names = people.map((p) => team.get(p.replace(/^t:/, ""))?.name ?? p);
      if (action === "cancel") return { what: `cancel the meeting with ${listOf(names)} on ${str(x.date)} at ${str(x.time)}` };
      if (!outside) return null;
      return action === "move"
        ? { what: `move the meeting with ${listOf(names)} on ${str(x.date)} at ${str(x.time)} to ${str(x.new_date)} at ${str(x.new_time)}` }
        : { what: `book a call with ${listOf(names)} on ${str(x.date)} at ${str(x.time)}${str(x.topic) ? ` (${str(x.topic)})` : ""}` };
    },
    run: async (x, c) => {
      const action = str(x.action) || "book";
      const team = teamOf(c);
      const names = arr(x.with).map((p) => team.get(p.replace(/^t:/, ""))?.name ?? p);
      if (action === "book") {
        // The OK came already when it needed one (hold): booked as asked.
        const cap = bookMeetingCapability({ team, book: (q, key) => meetingSaid(c, `Book a ${q.minutes ? `${q.minutes}-minute ` : ""}call with ${listOf(q.with)} on ${q.date} at ${q.time}${q.topic ? ` about ${q.topic}` : ""}.`, key) });
        return await use({ ...cap, confirm: false }, x, c);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str(x.date)) || !/^\d{2}:\d{2}$/.test(str(x.time))) throw new Refuse("It needs the meeting's day (YYYY-MM-DD) and time (HH:MM).");
      const text =
        action === "cancel"
          ? `Cancel the call with ${listOf(names)} on ${str(x.date)} at ${str(x.time)}.`
          : `Move the call with ${listOf(names)} on ${str(x.date)} at ${str(x.time)} to ${str(x.new_date)} at ${str(x.new_time)}.`;
      const r = await meetingSaid(c, text, `${action}:${str(x.date)}:${str(x.time)}`);
      if (r.status === "failed") throw new Refuse(r.said ?? "It didn't go through.");
      return { status: r.status, said: r.said };
    },
  },
  remember: {
    tiers: ADMINS,
    write: true,
    run: async (x, c) => {
      const said = await teachFrom(c.d.db, c.d.s, c.d.t, c.by, { id: c.run.message_id, chatId: c.at.chat_id }, { op: "teach", notes: arr(x.notes) }, await taughtNotes(c.d.db));
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
        if (c.brain.stopped && !tool.readOnly) throw new Refuse("The brain is stopped: it only reads until the owner says start.");
        const r = await boardCall(token, name, args);
        if (r.error) throw new Refuse(r.text || "The board tool said no.");
        return { result: r.text };
      });
    },
  },

  // ---- only with the owner's OK
  message_client: {
    tiers: ALL,
    write: true,
    // Always: whoever it is (a client, a freelancer, a partner's person), it's held.
    hold: async (x, c) => {
      const clients = new Map([...c.dir.clients, ...partnerPeople(await partners(c.d.db))]);
      const said = str(x.client);
      const to = clients.get(said) ?? [...clients.values()].find((a) => a.name.toLowerCase() === said.toLowerCase());
      if (!to) throw new Refuse("No client in iklipse has that id or name: find them in client first.");
      return { what: `send ${to.name} on WhatsApp: "${str(x.text).slice(0, 300)}"`, detail: str(x.text) };
    },
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
  bot_settings: {
    tiers: ADMINS,
    write: true,
    hold: async (x, c) => {
      const patch = await settingsPatch(c, x.patch);
      return { what: `change Alerts > Settings: ${patchText(patch)}` };
    },
    run: async (x, c) => {
      const patch = await settingsPatch(c, x.patch);
      const { error } = await c.d.db.from("watch_settings").update(patch).eq("id", 1);
      if (error) throw new Refuse(`Couldn't change it: ${error.message}`);
      return { said: `Changed: ${patchText(patch)}.` };
    },
  },
  brain_settings: {
    tiers: OWNER,
    write: true,
    hold: (x) => ({ what: `change the brain's settings: ${patchText(brainPatch(x.patch))}` }),
    run: async (x, c) => {
      const patch = brainPatch(x.patch);
      const { error } = await c.d.db.from("brain_settings").update({ ...patch, updated_at: iso(), updated_by: c.asker.id }).eq("id", 1);
      if (error) throw new Refuse(`Couldn't change it: ${error.message}`);
      return { said: `Changed: ${patchText(patch)}.` };
    },
  },
};

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
  if (!run.asker || str(p.acting_as) !== run.asker) throw new Refuse("That run is someone else's.");
  const c = await ctxOf(d, run);
  if (!spec.tiers.includes(c.asker.tier)) throw new Refuse(`${name} isn't for ${c.asker.tier === "member" ? "members" : "admins"}.`);
  const x = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
  if (spec.write && c.brain.stopped) throw new Refuse("The brain is stopped: it only reads until the owner says start.");
  try {
    const hold = spec.hold ? await spec.hold(x, c) : null;
    if (hold) {
      const asked = await askOwner(d.db, c.brain, d.send, {
        run: { id: run.id, reply_chat: run.reply_chat, message_id: c.at.message_id ?? "", asker_name: run.asker_name, tier: c.asker.tier },
        tool: name,
        input: x,
        what: hold.what,
        why: str(x.why) || null,
        detail: hold.detail ?? null,
      });
      if ("error" in asked) throw new Refuse(asked.error);
      await step(d.db, run.id, name, x, "held", hold.what, asked.id);
      return { held: true, approval_id: asked.id, said: `Waiting for the owner's OK (a code went to them): ${hold.what}. Nothing was done yet.` };
    }
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
  await say(d, row, ok ? `Done, the owner OK'd it: ${result}` : `Couldn't do it after the OK: ${result}`);
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
      const owner = c.asker.tier !== "member";
      const model = owner ? c.brain.model_owner : c.brain.model_member;
      await db.from("brain_run").update({ status: "running", started_at: iso(), model, ...(edit ? { finished_at: null } : {}) }).eq("id", run.id);
      // OKs decided for this chat in the last day: the brain knows what came of them.
      const { data: oks } = await db.from("brain_approval").select("what, status, result, done_at").eq("chat_id", run.reply_chat).gt("created_at", iso(Date.now() - 24 * 60 * MIN)).neq("status", "waiting").order("created_at").limit(10);
      const where = run.chat_id.endsWith("@g.us") ? await db.from("wa_group").select("name, kind").eq("chat_id", run.chat_id).maybeSingle() : { data: null };
      return {
        asker: { id: c.asker.id, name: c.asker.name, tier: c.asker.tier, admin: c.asker.admin, zone: c.dir.team.get(c.asker.id)?.zone ?? TZ },
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
        taught: c.d.s.taught ?? null,
        // How find's tables connect, and what who_is_who means (look.ts, people.ts): one place for both.
        guide: `${TABLE_GUIDE}

${WHO_IS_WHO}`,
        approvals: oks ?? [],
      };
    }
    case "_reply": {
      // Only in the run's own chat; long answers come in parts (the brain splits them).
      const run = await runOf(db, p.run_id, false);
      if (Date.now() - Date.parse(run.created_at) > RUN_LIFE_MS) throw new Refuse("This run is over.");
      const text = str(p.text).slice(0, 4000);
      if (!text) throw new Refuse("Nothing to say.");
      const quote = p.quote !== false && run.reply_chat === run.chat_id ? run.message_id : null;
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
      // The brain's own actions (GitHub, deploys): kept for the owner like the rest.
      const run = await runOf(db, p.run_id);
      const c = await ctxOf(d, run);
      const tool = str(p.tool);
      const tiers = BRAIN_HELD[tool];
      if (!tiers) throw new Refuse(`${tool} isn't one the brain asks for.`);
      if (!tiers.includes(c.asker.tier)) throw new Refuse(`${tool} is for the owner only.`);
      const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>;
      const asked = await askOwner(db, c.brain, d.send, {
        run: { id: run.id, reply_chat: run.reply_chat, message_id: c.at.message_id ?? "", asker_name: run.asker_name, tier: c.asker.tier },
        tool,
        input,
        what: str(p.what) || tool,
        why: str(p.why) || null,
        detail: str(p.detail) || null,
      });
      if ("error" in asked) throw new Refuse(asked.error);
      await step(db, run.id, tool, input, "held", str(p.what), asked.id);
      return { approval_id: asked.id };
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
      if (row.run_id) await step(db, row.run_id, row.tool, row.input, ok ? "approved" : "failed", result, id);
      await say(d, row, ok ? `Done, the owner OK'd it: ${result}` : `Couldn't do it after the OK: ${result}`);
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
