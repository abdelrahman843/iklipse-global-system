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

/** The parts free to run now, claimed; null before 0112 runs. */
async function claimParts(db: Db, names: string[], staleSec: number): Promise<Set<string> | null> {
  const { data, error } = await db.rpc("_bot_tick_claim", { p_parts: names, p_stale_sec: staleSec });
  if (error) return null;
  // A function returning a set of text comes back as the texts, or as rows named after it.
  return new Set(((data ?? []) as (string | { _bot_tick_claim: string })[]).map((x) => (typeof x === "string" ? x : x._bot_tick_claim)));
}

/** A part done: its lock let go, with how long it took and what went wrong. Never throws. */
async function releasePart(db: Db, name: string, ms: number, error: string | null) {
  try {
    await db.from("bot_tick_part").update({ locked_at: null, last_at: iso(), last_ms: ms, last_error: error }).eq("part", name);
  } catch (e) {
    console.error("part", name, (e as Error).message);
  }
}

/**
 * Runs the parts. What went wrong goes to errors ("mail: ..."); busy is the
 * parts left to a run still going (all of them before 0112, when the whole
 * run is still going).
 */
export async function runParts(db: Db, parts: Part[], o: { t0: number; runMs: number; errors: string[] }): Promise<{ busy: string[] }> {
  const go = async (p: Part, deadline: number) => {
    try {
      await p.run(deadline);
      return null;
    } catch (e) {
      o.errors.push(`${p.name}: ${(e as Error).message}`);
      return (e as Error).message.slice(0, 500);
    }
  };

  const mine = await claimParts(db, parts.map((p) => p.name), Math.round(o.runMs / 1000) + 50);
  if (mine) {
    await Promise.all(
      parts
        .filter((p) => mine.has(p.name))
        .map(async (p) => {
          const started = Date.now();
          const error = await go(p, o.t0 + Math.min(p.ms, o.runMs));
          await releasePart(db, p.name, Date.now() - started, error);
        }),
    );
    return { busy: parts.filter((p) => !mine.has(p.name)).map((p) => p.name) };
  }

  // Before 0112: one run at a time (a slow one can outlast the minute).
  const { data: lock } = await db
    .from("watch_settings")
    .update({ tick_lock: iso() })
    .eq("id", 1)
    .or(`tick_lock.is.null,tick_lock.lt."${iso(Date.now() - 3 * MIN)}"`)
    .select("id");
  if (!lock?.length) return { busy: parts.map((p) => p.name) };
  try {
    for (const p of parts) await go(p, o.t0 + Math.min(p.ms, o.runMs));
  } finally {
    await db.from("watch_settings").update({ tick_lock: null }).eq("id", 1);
  }
  return { busy: [] };
}
