// Pausing one open alert, and reminding people about it every so often, at an
// admin's word (orders.ts, action alert): "pause this alert till tomorrow at
// 2 pm, then send @Sara, @Omar and Hana a message every 20 minutes till it's
// resolved", "pause it for 2 hours", "remind Sara about it every 30 minutes",
// "resume", "stop reminding them", "every 30 minutes instead". The alert is
// the one quoted or named, else the only one it can be; else it asks which.
//
// The pause is the alert's own snooze (watch_alert.snoozed_until, the same as
// Snooze in the app): until then nothing rings for it, nobody is called about
// it, and the open alerts list in the team group leaves it out (index.ts). Its
// end is worked out like a reminder's time (reminders.ts), in the asker's time
// zone (Cairo unless iklipse knows theirs).
//
// The reminders (0116, bot_alert_nudge, one row per alert) take the place of
// the alert's usual alerts and calls: one private WhatsApp message to each of
// them, at least 10 minutes apart, at most 30 a day, in working hours, from
// the end of the pause (or right away) until the alert is closed; that's then
// said where they were asked for. Stopped by an admin, or with nobody left
// they can reach, the alert's usual alerts and calls come back. Before 0116
// runs, only the pause works.

import { iso, MIN, str, TZ, type Db, type Settings } from "./kit.ts";
import type { Send } from "./people.ts";
import type { Attendee } from "./meetings.ts";
import { nextWorkTime, offAt, resolveWhen, type When } from "./reminders.ts";
import { clockIn } from "./zones.ts";

/** Reminders about an alert never come closer together than this many minutes. */
export const MIN_EVERY = 10;
/** How often, in minutes, when they name people but not how often. */
export const DEFAULT_EVERY = 30;
/** At most this many reminders a day (Cairo) to each of them, about one alert. */
export const DAY_MAX = 30;
/** A pause is at most this long (as Snooze in the app). */
const MAX_PAUSE_MS = 7 * 24 * 60 * MIN;

/** An open alert as the router has it (orders.ts). */
export interface OpenAlert {
  id: string;
  chat_id: string | null;
  title: string;
  detail: string | null;
  source: string;
  created_at: string;
  wa_group: { name: string | null } | null;
  slack_channel: { name: string | null } | null;
}

/** An alert's reminders (0116). */
export interface Nudge {
  alert_id: string;
  /** The team members reminded (profile ids). */
  people: string[];
  every_min: number;
  /** The next round: the end of the pause, or every_min after the last. */
  next_at: string | null;
  status: "on" | "stopped" | "done";
  rounds: number;
  /** The Cairo day rounds_day counts ("2026-10-24"). */
  day: string | null;
  rounds_day: number;
  last_at: string | null;
  set_by: string | null;
  /** Where they were asked for, to say there when they end. */
  chat_id: string | null;
  message_id: string | null;
}
const COLS = "alert_id, people, every_min, next_at, status, rounds, day, rounds_day, last_at, set_by, chat_id, message_id";

/** What Claude made of the message (orders.ts, action alert). */
export interface AlertAct {
  /** The open alert's id from open_alerts ("a2"); empty when they don't say which. */
  id?: string;
  /** Pause it until: as said (reminders.ts When). */
  until_date?: string;
  until_time?: string;
  until_ampm?: string;
  /** Or for a while ("for 2 hours": 120). */
  pause_minutes?: number;
  /** End the pause now. */
  resume?: boolean;
  /** Remind them every this many minutes (0: not said). */
  every_min?: number;
  /** Who to remind (refs from people). */
  people?: string[];
  /** The people named come on top of the ones already reminded ("also Karim"). */
  also?: boolean;
  /** Stop reminding them. */
  stop?: boolean;
}

/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** "Sara, Hana and Omar" (or "... or Omar") */
const listOf = (xs: string[], and = "and") => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs.at(-1)}`);
/** Where an alert is from: the WhatsApp group, or "#channel". */
const whereOf = (a: { source: string; wa_group?: { name: string | null } | null; slack_channel?: { name: string | null } | null }) =>
  a.source === "slack" ? `#${a.slack_channel?.name ?? "channel"}` : a.wa_group?.name ?? null;
/** What an alert says, as part of a sentence: no dashes, no full stop at the end. */
const clean = (t: string) => str(t).replace(/\s*[—–]\s*/g, ", ").replace(/[.!\s]+$/, "");

/** Paused now: the app's Snooze, or an admin to the bot. */
export const pausedNow = (a: { snoozed_until?: string | null }, now = Date.now()) => !!a.snoozed_until && Date.parse(a.snoozed_until) > now;

/** The pause's end as they said it (a reminder's time, reminders.ts), or null when they didn't say one. */
export function pauseWhenOf(q: AlertAct): When | null {
  if (!str(q.until_date) && !str(q.until_time) && !(Number(q.pause_minutes) > 0)) return null;
  return { date: str(q.until_date), time: str(q.until_time), ampm: q.until_ampm === "am" || q.until_ampm === "pm" ? q.until_ampm : "", in_minutes: Number(q.pause_minutes) || 0 };
}

/** "every 20 minutes", "every hour", "every 2 hours" */
export const everyText = (m: number) => (m % 60 === 0 ? (m === 60 ? "every hour" : `every ${m / 60} hours`) : `every ${m} minutes`);

/** "Sat 2:00 PM" (with the date a week or so ahead, and the zone when it isn't Cairo). */
export function untilText(ms: number, zone: string, now = Date.now()) {
  const c = clockIn(zone);
  const days = Math.round((c.noon(c.dayOf(ms)) - c.noon(c.dayOf(now))) / (24 * 60 * MIN));
  return `${c.weekday(ms).slice(0, 3)}${days >= 6 ? ` ${c.dmy(ms)}` : ""} ${c.time12(ms)}${zone === TZ ? "" : ` ${c.label}`}`;
}

/** "2 hours 40 minutes", "1 day 3 hours". */
function lasting(ms: number) {
  const m = Math.max(1, Math.round(ms / MIN));
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const [d, h, mm] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60];
  if (d) return [part(d, "day"), h ? part(h, "hour") : ""].filter(Boolean).join(" ");
  return [h ? part(h, "hour") : "", mm ? part(mm, "minute") : ""].filter(Boolean).join(" ");
}

// ----------------------------------------------------- for the ringing --

/** These alerts' reminders that are on; null before 0116 runs. */
async function readNudges(db: Db, ids: string[]): Promise<Map<string, Nudge> | null> {
  if (!ids.length) return new Map();
  const { data, error } = await db.from("bot_alert_nudge").select(COLS).in("alert_id", ids).eq("status", "on");
  if (error) return null;
  return new Map(((data ?? []) as Nudge[]).map((x) => [x.alert_id, x]));
}

/** Of these alerts, the ones with their own reminders on: they don't ring or call (index.ts). None before 0116. */
export async function nudgesOn(db: Db, ids: string[]): Promise<Set<string>> {
  return new Set(((await readNudges(db, ids)) ?? new Map()).keys());
}

/**
 * An alert that's due to ring or call, held back (index.ts ring, callDue):
 * paused, until the pause ends; with its own reminders on, for good (until
 * they're stopped). null: it rings.
 */
export function held(a: { id: string; snoozed_until?: string | null }, nudged: Set<string>, now = Date.now()): { until: string | null } | null {
  if (pausedNow(a, now)) return { until: a.snoozed_until! };
  if (nudged.has(a.id)) return { until: null };
  return null;
}

/** An alert due to ring, held back (index.ts ring): its next alert at the pause's end, or none. Whether it was. */
export async function holdRing(db: Db, a: { id: string; snoozed_until?: string | null }, nudged: Set<string>, now = Date.now()) {
  const hold = held(a, nudged, now);
  if (hold) await db.from("watch_alert").update({ next_alert_at: hold.until }).eq("id", a.id).eq("status", "open");
  return !!hold;
}

/** A call that's due, held back (index.ts callDue): the next call at the pause's end, or none. Whether it was. */
export async function holdCall(db: Db, r: { alert_id: string; user_id: string }, a: { id: string; snoozed_until?: string | null }, nudged: Set<string>, now = Date.now()) {
  const hold = held(a, nudged, now);
  if (hold) await db.from("watch_recipient").update({ next_call_at: hold.until }).eq("alert_id", r.alert_id).eq("user_id", r.user_id);
  return !!hold;
}

/** The open alerts list (index.ts digest): a paused one is left out until its pause ends; with none left, what's posted instead. */
export function listable<T extends { snoozed_until?: string | null }>(all: T[], now = Date.now()): { open: T[]; none: string | null } {
  const open = all.filter((a) => !pausedNow(a, now));
  return { open, none: open.length ? null : all.length ? `No open alerts right now (${all.length} paused).` : "No open alerts right now." };
}

// ---------------------------------------------------------- the asking --

export interface AlertAsk {
  by: { id: string; name: string; admin: boolean; zone?: string | null };
  act: AlertAct;
  /** The open alerts Claude was shown, oldest first. */
  open: OpenAlert[];
  /** The one Claude said, if it said one. */
  alert?: OpenAlert;
  /** The people named on the team. */
  people: Attendee[];
  /** Named, but not on the team. */
  others: string[];
  /** Where it was asked. */
  at: { chat_id: string; message_id: string | null };
  now?: number;
}

/**
 * Pauses the alert, resumes it, or sets, changes or stops its reminders, as
 * they asked. What comes back is the one line to tell them.
 */
export async function alertAct(db: Db, s: Settings, x: AlertAsk): Promise<string> {
  if (!x.by.admin) return "Only admins can pause an alert or set its reminders.";
  const now = x.now ?? Date.now();
  const q = x.act;
  const zone = x.by.zone || TZ;
  const every = Math.max(0, Math.round(Number(q.every_min) || 0));
  const wantsPlan = x.people.length > 0 || x.others.length > 0 || every > 0;
  const pauseWhen = pauseWhenOf(q);
  if (!pauseWhen && !wantsPlan && !q.resume && !q.stop) return "What should I do with the alert: pause it until when, or remind whom and how often?";

  // The pause's end first: a question back changes nothing.
  let pauseTo: number | null = null;
  if (pauseWhen) {
    const r = resolveWhen(pauseWhen, zone, now);
    if ("ask" in r) return r.ask.replace("When should I remind you?", "Until when should I pause it?");
    if (r.at - now > MAX_PAUSE_MS) return "I can pause an alert for up to 7 days. Until when?";
    pauseTo = r.at;
  }

  // Which alert: the one said; else, carrying on ("resume", "stop reminding them", "every 30 minutes
  // instead"), the only one paused or with reminders; else the only one open.
  const ids = x.open.map((a) => a.id);
  const [{ data: rows }, nudges] = await Promise.all([
    ids.length ? db.from("watch_alert").select("id, snoozed_until").in("id", ids) : Promise.resolve({ data: [] as unknown[] }),
    readNudges(db, ids),
  ]);
  const paused = new Set(((rows ?? []) as { id: string; snoozed_until: string | null }[]).filter((r) => pausedNow(r, now)).map((r) => r.id));
  let a = x.alert;
  if (!a) {
    const busy = x.open.filter((o) => paused.has(o.id) || nudges?.has(o.id));
    const carryOn = !!q.resume || !!q.stop || !!q.also || (!pauseWhen && !x.people.length && !x.others.length);
    const pick = carryOn && busy.length ? busy : x.open;
    if (!pick.length) return "There's no open alert.";
    if (pick.length > 1) return `Which alert: ${listOf(pick.slice(-6).map((o) => `${clean(o.title)}${whereOf(o) ? ` (${whereOf(o)})` : ""}`), "or")}?`;
    a = pick[0]!;
  }
  const { data: row } = await db.from("watch_alert").select("id, status, snoozed_until, next_alert_at").eq("id", a.id).maybeSingle();
  const alert = row as { id: string; status: string; snoozed_until: string | null; next_alert_at: string | null } | null;
  if (!alert || alert.status !== "open") return "That alert is closed already.";
  const head = x.open.length > 1 && whereOf(a) ? `${whereOf(a)}: ` : "";
  let plan = nudges?.get(a.id);
  let until = pausedNow(alert, now) ? Date.parse(alert.snoozed_until!) : null;
  const by = { id: x.by.id, name: first(x.by.name) };
  const say = (ms: number) => untilText(ms, zone, now);

  if (q.stop) {
    if (!plan) {
      // Nothing of its own to stop: what still goes on, and what they can do about it.
      const usual = s.calls_enabled ? "alerts and calls" : "alerts";
      return `${head}I'm not sending any reminders of my own about it. ${
        until ? `It's paused until ${say(until)}, then its usual ${usual} start again.` : `Its usual ${usual} are still on: tell me to pause it until a time, or mark it handled.`
      }`;
    }
    // Some of them only ("stop reminding Omar"): the others go on. Someone named who isn't
    // reminded ("stop reminding me", a freelancer) changes nothing: only a stop naming nobody,
    // or all of them, stops them all.
    const named = [...x.people.map((p) => (p.id && p.id === x.by.id ? "you" : first(p.name))), ...x.others.map(first)];
    const off = x.people.map((p) => p.id).filter((id): id is string => !!id && plan!.people.includes(id));
    const left = plan.people.filter((id) => !off.includes(id));
    if (named.length && !off.length) return `${head}I'm not reminding ${listOf(named)} about it. I remind ${(await namesOf(db, plan.people)) || "them"} ${everyText(plan.every_min)}.`;
    if (off.length && left.length) {
      await db.from("bot_alert_nudge").update({ people: left, updated_at: iso(now) }).eq("alert_id", alert.id).eq("status", "on");
      await db.from("watch_event").insert({ alert_id: alert.id, what: "reminders", detail: `No more to ${await namesOf(db, off)}, said ${by.name}`, user_id: by.id });
      return `${head}I'll stop reminding ${await namesOf(db, off)}. Still ${everyText(plan.every_min)}: ${await namesOf(db, left)}, until it's resolved.`;
    }
    const names = await namesOf(db, plan.people);
    await stopNudge(db, alert.id, until, by, now);
    return `${head}Stopped reminding ${names || "them"}. ${until ? `Its usual alerts come back after the pause, ${say(until)}.` : "Its usual alerts are back on."}`;
  }

  const notes: string[] = [];
  let lead = "";
  if (q.resume && !pauseTo) {
    if (until) {
      await resumeAlert(db, alert, !!plan, by, now);
      if (plan) {
        // From now, but never closer to the last round than its pace.
        const next = iso(Math.max(now, plan.last_at ? Date.parse(plan.last_at) + plan.every_min * MIN : 0));
        await db.from("bot_alert_nudge").update({ next_at: next, updated_at: iso(now) }).eq("alert_id", alert.id).eq("status", "on");
        plan.next_at = next;
      }
      until = null;
      lead = "Resumed.";
    } else lead = "It isn't paused.";
  }

  // The reminders: who, how often, from when.
  if (wantsPlan) {
    const team = x.people.filter((p) => p.kind === "team" && p.id);
    const reach = team.filter((p) => p.phone);
    const noNumber = team.filter((p) => !p.phone).map((p) => first(p.name));
    if (noNumber.length) notes.push(`I don't have ${listOf(noNumber)}'s WhatsApp number${noNumber.length > 1 ? "s" : ""}. Add it on the Users page.`);
    if (x.others.length) notes.push(`I only remind the team this way, not ${listOf(x.others.map(first))}.`);
    const named = reach.map((p) => p.id!);
    const people = [...new Set(q.also || !team.length ? [...(plan?.people ?? []), ...named] : named)];
    const everyMin = every > 0 ? Math.min(Math.max(every, MIN_EVERY), 24 * 60) : plan?.every_min ?? DEFAULT_EVERY;
    if (every > 0 && every < MIN_EVERY) notes.unshift(`${MIN_EVERY} minutes apart is the most often I remind.`);
    // Never closer to the last round than the pace, even one of reminders stopped a moment ago.
    const lastAt = plan ? plan.last_at : await lastRound(db, alert.id);
    const start = Math.max(now, pauseTo ?? until ?? now, lastAt ? Date.parse(lastAt) + everyMin * MIN : 0);
    if (!people.length) {
      // Nobody to remind (none named, or none with a number): the rest still happens.
      if (!x.people.length && !x.others.length) notes.unshift("Who should I remind?");
    } else {
      const kept = await keepNudge(db, {
        alert_id: alert.id,
        people,
        every_min: everyMin,
        next_at: iso(start),
        status: "on",
        set_by: x.by.id,
        chat_id: x.at.chat_id || null,
        message_id: x.at.message_id,
        ended_at: null,
        updated_at: iso(now),
      });
      if (kept) {
        plan = kept;
        // They take the place of its usual alerts and calls.
        await db.from("watch_alert").update({ next_alert_at: null, updated_at: iso(now) }).eq("id", alert.id).eq("status", "open");
        await db.from("watch_recipient").update({ next_call_at: null }).eq("alert_id", alert.id);
        const often = everyText(everyMin);
        await db.from("watch_event").insert({
          alert_id: alert.id,
          what: "reminders",
          detail: `${often[0]!.toUpperCase()}${often.slice(1)} to ${await namesOf(db, people)} on WhatsApp, said ${by.name}`.slice(0, 300),
          user_id: by.id,
        });
      } else {
        notes.push(`I can't send them reminders ${everyText(everyMin)} yet: iklipse needs an update for that first.`);
      }
    }
  }

  if (pauseTo) {
    await pauseAlert(db, alert, pauseTo, !!plan, by, say(pauseTo), now);
    if (plan && Date.parse(plan.next_at ?? "") < pauseTo) {
      await db.from("bot_alert_nudge").update({ next_at: iso(pauseTo), updated_at: iso(now) }).eq("alert_id", alert.id).eq("status", "on");
      plan.next_at = iso(pauseTo);
    }
    until = pauseTo;
    lead = `Paused until ${say(pauseTo)}.`;
  } else if (!lead && until) lead = `It's paused until ${say(until)}.`;

  // What happens next.
  let next = "";
  if (plan) {
    const from = Math.max(now, until ?? now, Date.parse(plan.next_at ?? "") || now);
    const work = nextWorkTime(s, from);
    const names = await namesOf(db, plan.people);
    const often = everyText(plan.every_min);
    const what = `I'll remind ${names || "them"} until it's resolved.`;
    if (work > from) next = `From ${say(work)}, when work starts, ${often} ${what}`;
    else if (until) next = `Then ${often} ${what}`;
    else if (from - now > MIN) next = `From ${say(from)}, ${often} ${what}`;
    else next = `${often[0]!.toUpperCase()}${often.slice(1)} from now ${what}`;
  } else if (pauseTo) next = "Then its usual alerts start again.";
  else if (lead === "Resumed.") next = "Its usual alerts are back on.";
  return `${head}${[lead, next, ...notes].filter(Boolean).join(" ")}`;
}

/** First names of team members, by their profile ids: "Omar, Karim and Hana". */
async function namesOf(db: Db, ids: string[]) {
  if (!ids.length) return "";
  const { data } = await db.from("profile").select("id, display_name").in("id", ids);
  const name = new Map(((data ?? []) as { id: string; display_name: string | null }[]).map((p) => [p.id, first(str(p.display_name))]));
  return listOf(ids.map((id) => name.get(id)).filter((n): n is string => !!n));
}

/** When the last round about it went, whatever became of its reminders since; null when none did (or before 0116 runs). */
async function lastRound(db: Db, id: string) {
  const { data } = await db.from("bot_alert_nudge").select("last_at").eq("alert_id", id).maybeSingle();
  return (data as { last_at: string | null } | null)?.last_at ?? null;
}

/** The reminders kept (one row per alert: set again, it's changed); null before 0116 runs. */
async function keepNudge(db: Db, row: Record<string, unknown>): Promise<Nudge | null> {
  const { data, error } = await db.from("bot_alert_nudge").upsert(row, { onConflict: "alert_id" }).select(COLS).single();
  if (error || !data) {
    if (error && !/bot_alert_nudge|does not exist|schema cache/i.test(error.message)) console.error("alert nudge", error.message);
    return null;
  }
  return data as Nudge;
}

/**
 * Paused until then (the same as Snooze in the app): its next alert and calls
 * wait for it. With reminders on, it has neither.
 */
async function pauseAlert(
  db: Db,
  a: { id: string; next_alert_at: string | null },
  until: number,
  nudged: boolean,
  by: { id: string; name: string },
  said: string,
  now: number,
) {
  const later = (t: string | null) => (t == null ? null : iso(Math.max(until, Date.parse(t))));
  await db
    .from("watch_alert")
    .update({ snoozed_until: iso(until), next_alert_at: nudged ? null : later(a.next_alert_at), updated_at: iso(now) })
    .eq("id", a.id)
    .eq("status", "open");
  if (!nudged) {
    const { data: rec } = await db.from("watch_recipient").select("user_id, next_call_at").eq("alert_id", a.id);
    for (const r of (rec ?? []) as { user_id: string; next_call_at: string | null }[]) {
      if (r.next_call_at) await db.from("watch_recipient").update({ next_call_at: later(r.next_call_at) }).eq("alert_id", a.id).eq("user_id", r.user_id);
    }
  }
  await db.from("watch_event").insert({ alert_id: a.id, what: "snoozed", detail: `Until ${said}, said ${by.name} on WhatsApp`, user_id: by.id });
}

/** The pause over now: its alerts and calls (or its reminders) go on from now. */
async function resumeAlert(db: Db, a: { id: string; next_alert_at: string | null }, nudged: boolean, by: { id: string; name: string }, now: number) {
  await db
    .from("watch_alert")
    .update({ snoozed_until: null, next_alert_at: !nudged && a.next_alert_at ? iso(now) : a.next_alert_at, updated_at: iso(now) })
    .eq("id", a.id)
    .eq("status", "open");
  if (!nudged) {
    const { data: rec } = await db.from("watch_recipient").select("user_id, next_call_at").eq("alert_id", a.id);
    for (const r of (rec ?? []) as { user_id: string; next_call_at: string | null }[]) {
      if (r.next_call_at && Date.parse(r.next_call_at) > now) await db.from("watch_recipient").update({ next_call_at: iso(now) }).eq("alert_id", a.id).eq("user_id", r.user_id);
    }
  }
  await db.from("watch_event").insert({ alert_id: a.id, what: "resumed", detail: `Resumed by ${by.name} on WhatsApp`, user_id: by.id });
}

/** Its reminders stopped: its usual alerts come back (after the pause, if it's paused), and the calls to whoever was being called. */
async function stopNudge(db: Db, id: string, until: number | null, by: { id: string; name: string }, now: number) {
  await db.from("bot_alert_nudge").update({ status: "stopped", next_at: null, ended_at: iso(now), updated_at: iso(now) }).eq("alert_id", id).eq("status", "on");
  await usualBack(db, id, until, now);
  await db.from("watch_event").insert({ alert_id: id, what: "reminders", detail: `Stopped by ${by.name} on WhatsApp; its usual alerts are back`, user_id: by.id });
}

/** Its usual alerts back (after the pause, if it's paused), and the calls to whoever was being called. */
async function usualBack(db: Db, id: string, until: number | null, now: number) {
  const back = iso(Math.max(now, until ?? now));
  await db.from("watch_alert").update({ next_alert_at: back, updated_at: iso(now) }).eq("id", id).eq("status", "open");
  const { data: rec } = await db.from("watch_recipient").select("user_id, calls").eq("alert_id", id);
  for (const r of (rec ?? []) as { user_id: string; calls: number }[]) {
    if (r.calls > 0) await db.from("watch_recipient").update({ next_call_at: back }).eq("alert_id", id).eq("user_id", r.user_id);
  }
}

// --------------------------------------------------------- the sending --

type AlertRow = {
  id: string;
  kind: string;
  status: string;
  title: string;
  detail: string | null;
  source: string;
  snoozed_until: string | null;
  created_at: string;
  due_at: string;
  wa_group: { name: string | null } | null;
  slack_channel: { name: string | null } | null;
};

/** One reminder to one of them: what it is, where, how long, and how it ends. */
export function nudgeText(to: { name: string }, by: { id?: string | null; name: string } | undefined, a: AlertRow, now = Date.now()) {
  const where = whereOf(a);
  const due = Date.parse(a.due_at);
  const since =
    a.kind === "unanswered" || a.kind === "follow_up"
      ? `Waiting ${lasting(now - Date.parse(a.created_at))}.`
      : due > now
        ? `Due in ${lasting(due - now)}.`
        : `Overdue by ${lasting(now - due)}.`;
  return `Hi ${first(to.name)}, a reminder${by ? ` from ${first(by.name)}` : ""} about an open alert${where ? ` in ${where}` : ""}: ${clean(a.detail || a.title)}. ${since} Once it's dealt with, tap Handled on it in iklipse, or tell me here.`;
}

/**
 * The reminders that are due, in working hours: one private message to each
 * of them, then the next set. Each round is claimed by one run only (the next
 * time it was read with). A closed alert ends them, said where they were asked
 * for; a paused one waits for the pause; the day's most waits for the next
 * working day. How many rounds went out.
 */
export async function sendNudges(db: Db, s: Settings, send: Send, team: Map<string, Attendee>, deadline: number, now = Date.now()) {
  if (offAt(s, now)) return 0;
  const { data, error } = await db.from("bot_alert_nudge").select(COLS).eq("status", "on").lte("next_at", iso(now)).order("next_at").limit(10);
  // Before 0116 runs there are none.
  if (error) return 0;
  const c = clockIn(TZ);
  let n = 0;
  for (const x of (data ?? []) as Nudge[]) {
    if (Date.now() > deadline) break;
    // As read: a round is claimed only while it's still this one (another run may have taken it).
    const was = x.next_at!;
    const round = (x.rounds ?? 0) + 1;
    const claim = async (patch: Record<string, unknown>) => {
      const { data: hit } = await db
        .from("bot_alert_nudge")
        .update({ ...patch, updated_at: iso(now) })
        .eq("alert_id", x.alert_id)
        .eq("status", "on")
        .eq("next_at", was)
        .select("alert_id");
      return !!hit?.length;
    };
    const { data: row } = await db
      .from("watch_alert")
      .select("id, kind, status, title, detail, source, snoozed_until, created_at, due_at, wa_group(name), slack_channel(name)")
      .eq("id", x.alert_id)
      .maybeSingle();
    const a = row as AlertRow | null;
    const names = listOf(x.people.map((id) => team.get(id)).filter((p): p is Attendee => !!p).map((p) => first(p.name)));
    if (!a || a.status !== "open") {
      if ((await claim({ status: "done", next_at: null, ended_at: iso(now) })) && a && x.chat_id) {
        const where = whereOf(a);
        await send(x.chat_id, `The alert${where ? ` in ${where}` : ""} is closed, so I stopped reminding ${names || "them"}.`, x.message_id).catch((e) => console.error("alert nudge", (e as Error).message));
      }
      continue;
    }
    // Nobody of them can be reached anymore (they left the team, or have no number): they end,
    // and its usual alerts and calls come back, said where they were asked for, once. Never on
    // a team read with nobody's number (a directory that couldn't be read says nothing).
    if (!x.people.some((id) => !!team.get(id)?.phone) && [...team.values()].some((p) => !!p.phone)) {
      if (await claim({ status: "stopped", next_at: null, ended_at: iso(now) })) {
        const until = pausedNow(a, now) ? Date.parse(a.snoozed_until!) : null;
        await usualBack(db, a.id, until, now);
        await db.from("watch_event").insert({ alert_id: a.id, what: "reminders", detail: "Stopped: nobody they were for can be reached; its usual alerts are back", user_id: x.set_by });
        const where = whereOf(a);
        const back = until ? `come back after the pause, ${untilText(until, TZ, now)}` : "are back on";
        if (x.chat_id) {
          await send(x.chat_id, `Nobody I was reminding about the alert${where ? ` in ${where}` : ""} is reachable, so its usual alerts ${back}.`, x.message_id).catch((e) =>
            console.error("alert nudge", (e as Error).message),
          );
        }
      }
      continue;
    }
    if (pausedNow(a, now)) {
      await claim({ next_at: a.snoozed_until });
      continue;
    }
    const day = c.dayOf(now);
    const today = x.day === day ? x.rounds_day ?? 0 : 0;
    if (today >= DAY_MAX) {
      await claim({ next_at: iso(nextWorkTime(s, c.at(c.dayOf(now + 24 * 60 * MIN), "00:00"))) });
      continue;
    }
    if (!(await claim({ next_at: iso(now + x.every_min * MIN), rounds: round, day, rounds_day: today + 1, last_at: iso(now) }))) continue;
    const by = x.set_by ? team.get(x.set_by) : undefined;
    const sent: string[] = [];
    const missed: string[] = [];
    for (const id of x.people) {
      const p = team.get(id);
      // No longer on the team: nothing.
      if (!p) continue;
      if (!p.phone) {
        missed.push(first(p.name));
        continue;
      }
      try {
        await send(`${p.phone}@c.us`, nudgeText(p, by && by.id !== p.id ? by : undefined, a, now));
        sent.push(first(p.name));
      } catch (e) {
        console.error("alert nudge", (e as Error).message);
        missed.push(first(p.name));
      }
    }
    await db.from("watch_event").insert({
      alert_id: a.id,
      what: "reminder",
      detail: `Reminder ${round} to ${listOf(sent) || "nobody"} on WhatsApp${missed.length ? `; couldn't reach ${listOf(missed)}` : ""}`.slice(0, 300),
      user_id: x.set_by,
    });
    n++;
  }
  return n;
}
