// Locks that keep two runs apart (chat.ts claimChat, parts.ts runParts), with
// the database in memory: a run lets a lock go only while it's still its own
// claim; a part's lock outlasts any run; a part past its deadline isn't
// waited for, and keeps its lock until it ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { claimChat } from "./chat.ts";
import { runParts, type Part } from "./parts.ts";
import type { Db } from "./kit.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Date.now this far back while fn runs. */
async function back<T>(ms: number, fn: () => Promise<T>) {
  const real = Date.now;
  Date.now = () => real() - ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("a group's reader that outlasted its claim doesn't free the claim of the run that took over", async () => {
  const f = fakeDb({ wa_group: [{ chat_id: "acme@g.us", reading_at: null }] });
  // Run A claimed it 4 minutes ago and is still going; run B takes over the stale claim.
  const a = await back(4 * 60_000, () => claimChat(f.db, "wa_group", "chat_id", "acme@g.us"));
  assert.equal(a.mine, true);
  const b = await claimChat(f.db, "wa_group", "chat_id", "acme@g.us");
  assert.equal(b.mine, true);
  const bClaim = f.tables.wa_group[0]!.reading_at;
  // A ends: B's claim stays, so a third run can't read the group alongside B.
  await a.release();
  assert.equal(f.tables.wa_group[0]!.reading_at, bClaim);
  assert.equal((await claimChat(f.db, "wa_group", "chat_id", "acme@g.us")).mine, false);
  // B ends: free again.
  await b.release();
  assert.equal(f.tables.wa_group[0]!.reading_at, null);
});

/** The database handing out every part, each claim stamped with its time (as _bot_tick_claim does). */
function world() {
  let n = 0;
  const asked: number[] = [];
  const f = fakeDb(
    { bot_tick_part: [] },
    {
      rpc: {
        _bot_tick_claim: (a, tables) => {
          asked.push(a.p_stale_sec as number);
          for (const part of a.p_parts as string[]) {
            const row = tables.bot_tick_part!.find((r) => r.part === part) ?? (tables.bot_tick_part!.push({ part }), tables.bot_tick_part!.at(-1)!);
            row.locked_at = `2026-10-24T10:00:00.00${++n}Z`;
          }
          return a.p_parts;
        },
      },
    },
  );
  return { ...f, asked, lock: (part: string) => f.tables.bot_tick_part!.find((r) => r.part === part)! };
}

test("a part lets its lock go only while it's still its own claim", async () => {
  const f = world();
  const parts: Part[] = [
    // While it ran, its lock went to another run (it was taken as a dead run's).
    { name: "mail", ms: 1000, run: async () => void (f.lock("mail").locked_at = "2026-10-24T10:03:00.000Z") },
    { name: "ring", ms: 1000, run: async () => {} },
  ];
  await runParts(f.db, parts, { t0: Date.now(), runMs: 1000, errors: [] });
  assert.equal(f.lock("mail").locked_at, "2026-10-24T10:03:00.000Z", "the other run's lock stays");
  assert.equal(f.lock("ring").locked_at, null);
  assert.equal(typeof f.lock("ring").last_ms, "number");
});

test("a part's lock is a dead run's only after longer than any run can last (the function's wall clock)", async () => {
  const f = world();
  await runParts(f.db, [{ name: "ring", ms: 100_000, run: async () => {} }], { t0: Date.now(), runMs: 100_000, errors: [] });
  // Supabase stops the function by 400 seconds on any plan (150 on the free one): no part runs longer.
  assert.ok(f.asked[0]! > 400, `stale after ${f.asked[0]}s`);
});

test("a part past its deadline isn't waited for; it keeps its lock until it ends, then lets it go", { timeout: 5_000 }, async () => {
  const f = world();
  const t0 = Date.now();
  let ended = false;
  // The mail part goes on until the test lets it end (no race with the clock).
  let finish!: () => void;
  const held = new Promise<void>((r) => (finish = r));
  const parts: Part[] = [
    { name: "mail", ms: 50, run: async () => void (await held, (ended = true)) },
    { name: "ring", ms: 1000, run: async () => {} },
  ];
  const errors: string[] = [];
  await runParts(f.db, parts, { t0, runMs: 1000, errors, lateMs: 50 });
  assert.equal(ended, false);
  assert.match(errors.join("\n"), /^mail: still running \d+s after its time, left to finish$/m);
  assert.notEqual(f.lock("mail").locked_at, null, "still running: its lock stays");
  assert.equal(f.lock("ring").locked_at, null);
  finish();
  await sleep(20);
  assert.equal(ended, true);
  assert.equal(f.lock("mail").locked_at, null, "done: its lock is let go");
});

test("before 0112: the one lock is let go only while it's still this run's", async () => {
  const f = fakeDb({ watch_settings: [{ id: 1, tick_lock: null }] });
  const db = { ...f.db, rpc: async () => ({ data: null, error: { message: "function _bot_tick_claim does not exist" } }) } as unknown as Db;
  // Another run took the lock over while this one ran.
  const parts: Part[] = [{ name: "ring", ms: 1000, run: async () => void (f.tables.watch_settings[0]!.tick_lock = "2026-10-24T10:03:00.000Z") }];
  await runParts(db, parts, { t0: Date.now(), runMs: 1000, errors: [] });
  assert.equal(f.tables.watch_settings[0]!.tick_lock, "2026-10-24T10:03:00.000Z");
});
