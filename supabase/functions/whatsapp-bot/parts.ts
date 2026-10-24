// The minute's run in parts (0112): WhatsApp, email, Slack, Calendly,
// reminders, ringing, memory. Each part has its own lock (bot_tick_part) and
// its own time, and they run side by side: a slow one (email, Calendly) holds
// up only itself, never the clients' chats or the alerts ringing, and a part
// still running from the last minute is left to finish while the others go on.
// Before 0112 runs: one lock for the whole run (watch_settings.tick_lock), the
// parts one after another, as before.

import { iso, MIN, type Db } from "./kit.ts";

/** A part: its name (its lock), how long it may take from the start of the run, and what it does by then. */
export interface Part {
  name: string;
  ms: number;
  run: (deadline: number) => Promise<void>;
}

/** A part still going this long after its deadline (one last Claude call or Gmail read) isn't waited for: the run ends without it, and it lets its lock go when it's done. */
export const LATE_MS = 30_000;
/**
 * The longest a part can run: the function is stopped by then, whatever it's
 * doing (Supabase's wall clock: 150 seconds on the free plan, 400 on paid
 * ones). Only a lock older than this (and a margin) is a dead run's.
 */
export const WALL_MS = 400_000;

/** The function keeps going for it after the run's answer is sent (Supabase's EdgeRuntime). */
const keepAlive = (p: Promise<unknown>) => (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(p);

/** The parts free to run now, claimed, with each claim's time (its token); null before 0112 runs. */
async function claimParts(db: Db, names: string[], staleSec: number): Promise<Map<string, string | null> | null> {
  const { data, error } = await db.rpc("_bot_tick_claim", { p_parts: names, p_stale_sec: staleSec });
  if (error) return null;
  // A function returning a set of text comes back as the texts, or as rows named after it.
  const got = ((data ?? []) as (string | { _bot_tick_claim: string })[]).map((x) => (typeof x === "string" ? x : x._bot_tick_claim));
  const { data: rows } = got.length ? await db.from("bot_tick_part").select("part, locked_at").in("part", got) : { data: [] };
  const at = new Map(((rows ?? []) as { part: string; locked_at: string | null }[]).map((r) => [r.part, r.locked_at]));
  return new Map(got.map((p) => [p, at.get(p) ?? null]));
}

/**
 * A part done: its lock let go, with how long it took and what went wrong,
 * only while the lock is still its own claim (unknown, it can't be another
 * run's yet: none outlives the stale time). Never throws.
 */
async function releasePart(db: Db, name: string, token: string | null, ms: number, error: string | null) {
  try {
    const q = db.from("bot_tick_part").update({ locked_at: null, last_at: iso(), last_ms: ms, last_error: error }).eq("part", name);
    await (token ? q.eq("locked_at", token) : q);
  } catch (e) {
    console.error("part", name, (e as Error).message);
  }
}

/**
 * Runs the parts. What went wrong goes to errors ("mail: ..."); busy is the
 * parts left to a run still going (all of them before 0112, when the whole
 * run is still going).
 */
export async function runParts(db: Db, parts: Part[], o: { t0: number; runMs: number; errors: string[]; lateMs?: number }): Promise<{ busy: string[] }> {
  const lateMs = o.lateMs ?? LATE_MS;
  const go = async (p: Part, deadline: number) => {
    try {
      await p.run(deadline);
      return null;
    } catch (e) {
      o.errors.push(`${p.name}: ${(e as Error).message}`);
      return (e as Error).message.slice(0, 500);
    }
  };

  // A lock is a dead run's only once it's older than any run can last.
  const mine = await claimParts(db, parts.map((p) => p.name), Math.ceil(WALL_MS / 1000) + 30);
  if (mine) {
    await Promise.all(
      parts
        .filter((p) => mine.has(p.name))
        .map(async (p) => {
          const started = Date.now();
          const deadline = o.t0 + Math.min(p.ms, o.runMs);
          const done = go(p, deadline).then((error) => releasePart(db, p.name, mine.get(p.name) ?? null, Date.now() - started, error));
          // Its deadline is kept: LATE_MS after it, the run goes on without it (its lock stays until it ends).
          let timer: ReturnType<typeof setTimeout> | undefined;
          const over = new Promise<boolean>((r) => (timer = setTimeout(() => r(true), Math.max(0, deadline + lateMs - Date.now()))));
          const late = await Promise.race([done.then(() => false), over]);
          clearTimeout(timer);
          if (late) {
            o.errors.push(`${p.name}: still running ${Math.round(lateMs / 1000)}s after its time, left to finish`);
            keepAlive(done);
          }
        }),
    );
    return { busy: parts.filter((p) => !mine.has(p.name)).map((p) => p.name) };
  }

  // Before 0112: one run at a time (a slow one can outlast the minute), its lock let go only while it's still its own.
  const stamp = iso();
  const { data: lock } = await db
    .from("watch_settings")
    .update({ tick_lock: stamp })
    .eq("id", 1)
    .or(`tick_lock.is.null,tick_lock.lt."${iso(Date.parse(stamp) - 3 * MIN)}"`)
    .select("id");
  if (!lock?.length) return { busy: parts.map((p) => p.name) };
  try {
    for (const p of parts) await go(p, o.t0 + Math.min(p.ms, o.runMs));
  } finally {
    await db.from("watch_settings").update({ tick_lock: null }).eq("id", 1).eq("tick_lock", stamp);
  }
  return { busy: [] };
}
