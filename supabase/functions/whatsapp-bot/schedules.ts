// Scheduled tasks (0139): "every Sunday at 10, do X", for any task the bot can
// do. Each time it comes, it runs in the brain exactly as if the one who set
// it had written it to the bot privately then, with their permissions as they
// are then (permissions.ts): someone who lost a permission since doesn't get
// it done. What it says goes to their private chat (the super admin's: the
// master group, once it's set up). Runs on the bot's own API key, never
// anyone's subscription.

import { iso, MIN, str, TZ, type Db } from "./kit.ts";
import { localAt } from "./reminders.ts";
import { clockIn } from "./zones.ts";
import { brainEnv, brainOn, brainSettings, forward, tierNow } from "./brain.ts";
import { MASTER_CHAT, masterOn } from "./master-env.ts";

export type Every = "once" | "day" | "weekdays" | "week" | "month";

export interface Schedule {
  id: string;
  user_id: string;
  text: string;
  every: Every;
  /** week: the days (0 Sunday .. 6 Saturday); month: the day of the month (1..31); once: unused. */
  days: number[];
  /** "HH:MM", their time. */
  at: string;
  /** once: the day ("YYYY-MM-DD"). */
  on_date: string | null;
  zone: string;
  enabled: boolean;
  next_at: string | null;
  runs: number;
}

const DAY = 24 * 60 * MIN;
const WEEKDAYS_EG = [0, 1, 2, 3, 4]; // Sunday to Thursday: Egypt's working week.

/** The next time after `after`, or null when there's none (a one-off that's gone). */
export function nextRun(s: Pick<Schedule, "every" | "days" | "at" | "on_date" | "zone">, after = Date.now()): number | null {
  if (!/^\d{2}:\d{2}$/.test(s.at)) return null;
  const zone = s.zone || TZ;
  if (s.every === "once") {
    if (!s.on_date) return null;
    const t = localAt(zone, s.on_date, s.at);
    return Number.isFinite(t) && t > after ? t : null;
  }
  const c = clockIn(zone);
  for (let i = 0; i < 400; i++) {
    const date = c.dayOf(after + i * DAY);
    const d = new Date(`${date}T12:00:00Z`);
    const dow = d.getUTCDay();
    const dom = d.getUTCDate();
    const ok =
      s.every === "day" ||
      (s.every === "weekdays" && WEEKDAYS_EG.includes(dow)) ||
      (s.every === "week" && s.days.includes(dow)) ||
      (s.every === "month" && s.days.includes(dom));
    if (!ok) continue;
    const t = localAt(zone, date, s.at);
    if (Number.isFinite(t) && t > after) return t;
  }
  return null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "every Sun, Wed at 10:00 (Africa/Cairo)". */
export function sayRule(s: Pick<Schedule, "every" | "days" | "at" | "on_date" | "zone">) {
  const when =
    s.every === "once"
      ? `on ${s.on_date}`
      : s.every === "day"
        ? "every day"
        : s.every === "weekdays"
          ? "every working day (Sun to Thu)"
          : s.every === "week"
            ? `every ${s.days.map((d) => DAY_NAMES[d]).join(", ")}`
            : `every month on day ${s.days.join(", ")}`;
  return `${when} at ${s.at} (${s.zone || TZ})`;
}

/** Their schedules, numbered. */
export async function schedulesOf(db: Db, userId: string): Promise<Schedule[]> {
  const { data } = await db.from("brain_schedule").select("*").eq("user_id", userId).order("created_at");
  return (data ?? []) as Schedule[];
}

/** A new one, checked: something to do, a rule that has a next time. */
export async function addSchedule(db: Db, userId: string, x: { text: string; every: Every; days?: number[]; at: string; on_date?: string | null; zone?: string | null }) {
  const s = { every: x.every, days: (x.days ?? []).map(Number).filter((n) => Number.isInteger(n)), at: str(x.at), on_date: x.on_date ?? null, zone: str(x.zone) || TZ };
  if (!str(x.text).trim()) throw new Error("What should it do?");
  if (!["once", "day", "weekdays", "week", "month"].includes(s.every)) throw new Error("every: once, day, weekdays, week or month.");
  if (s.every === "week" && !s.days.every((d) => d >= 0 && d <= 6)) throw new Error("days for week: 0 (Sunday) to 6 (Saturday).");
  if (s.every === "month" && !s.days.every((d) => d >= 1 && d <= 31)) throw new Error("days for month: 1 to 31.");
  if ((s.every === "week" || s.every === "month") && !s.days.length) throw new Error("Which days?");
  const next = nextRun(s);
  if (!next) throw new Error("That time has no next time (a day that's gone, or a time like 25:00).");
  const { data, error } = await db
    .from("brain_schedule")
    .insert({ user_id: userId, text: str(x.text).trim().slice(0, 2000), ...s, enabled: true, next_at: iso(next) })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as Schedule;
}

/**
 * The ones that are due, each run once (claimed by moving next_at on first):
 * as their owner now, privately. Not while the brain is off (they wait).
 */
export async function runSchedules(db: Db, deadline: number, now = Date.now()): Promise<number> {
  const e = brainEnv();
  if (!brainOn(e)) return 0;
  const bs = await brainSettings(db);
  if (!bs || bs.stopped || bs.schedules_stopped) return 0;
  const { data } = await db.from("brain_schedule").select("*").eq("enabled", true).lte("next_at", iso(now)).order("next_at").limit(20);
  let ran = 0;
  for (const s of (data ?? []) as Schedule[]) {
    if (Date.now() > deadline) break;
    const due = Date.parse(str(s.next_at));
    const next = nextRun(s, Math.max(now, due));
    // Claimed: another tick that read the same row finds next_at moved and leaves it.
    const { data: took } = await db
      .from("brain_schedule")
      .update({ next_at: next ? iso(next) : null, enabled: next !== null, last_at: iso(now), runs: (s.runs ?? 0) + 1 })
      .eq("id", s.id)
      .eq("next_at", s.next_at)
      .select("id");
    if (!took?.length) continue;
    // Long overdue (the bot was off for hours): skipped, not run late.
    if (now - due > 6 * 60 * MIN) continue;
    const asker = await tierNow(db, bs, s.user_id);
    if (!asker) {
      await db.from("brain_schedule").update({ enabled: false }).eq("id", s.id);
      continue;
    }
    let chat: string | null = null;
    if (asker.tier === "owner" && masterOn()) chat = MASTER_CHAT;
    else {
      const { data: w } = await db.from("wa_member").select("phone").eq("user_id", s.user_id).order("created_at").limit(1);
      const phone = str((w as { phone: string }[] | null)?.[0]?.phone);
      chat = phone ? `${phone}@c.us` : null;
    }
    if (!chat) continue;
    const r = await forward(db, e, {
      id: `schedule:${s.id}:${due}`,
      chatId: chat,
      where: "private",
      text: `[Their scheduled task, ${sayRule(s)}: do it now as if they just asked]\n${s.text}`,
      quoted: null,
      quotedId: null,
      asker,
      replyChat: chat,
    });
    if (r !== "fallback") ran++;
  }
  return ran;
}
