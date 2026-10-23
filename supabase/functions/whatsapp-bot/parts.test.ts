// The minute's run in parts (parts.ts, 0112), with the database in memory:
// side by side, a slow part holds up only itself, each by its own deadline;
// a part still running is left to it; one failing doesn't stop the rest;
// before 0112, one lock and one part after another, as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { runParts, type Part } from "./parts.ts";
import type { Db } from "./kit.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The database handing out the parts not in busy. */
function world(busy: string[] = []) {
  return fakeDb(
    { bot_tick_part: ["slow", "fast", "boom"].map((part) => ({ part, locked_at: "now" })), watch_settings: [{ id: 1, tick_lock: null }] },
    { rpc: { _bot_tick_claim: (a) => (a.p_parts as string[]).filter((p) => !busy.includes(p)) } },
  );
}

test("side by side: a slow part holds up only itself, each by its own deadline; locks let go", async () => {
  const f = world();
  const t0 = Date.now();
  const seen: Record<string, { deadline: number; done: number }> = {};
  const parts: Part[] = [
    { name: "slow", ms: 300, run: async (d) => void (await sleep(d - Date.now()), (seen.slow = { deadline: d, done: Date.now() })) },
    { name: "fast", ms: 1000, run: async (d) => void (seen.fast = { deadline: d, done: Date.now() }) },
  ];
  const errors: string[] = [];
  const r = await runParts(f.db, parts, { t0, runMs: 1000, errors });
  assert.deepEqual(r.busy, []);
  assert.deepEqual(errors, []);
  assert.equal(seen.slow!.deadline, t0 + 300);
  assert.equal(seen.fast!.deadline, t0 + 1000);
  assert.ok(seen.fast!.done < seen.slow!.done, "the fast part didn't wait for the slow one");
  for (const p of ["slow", "fast"]) {
    const row = f.tables.bot_tick_part.find((x) => x.part === p)!;
    assert.equal(row.locked_at, null);
    assert.equal(typeof row.last_ms, "number");
  }
});

test("a part still running from the last minute is left to it; the others go on", async () => {
  const f = world(["slow"]);
  const ran: string[] = [];
  const parts: Part[] = ["slow", "fast"].map((name) => ({ name, ms: 1000, run: async () => void ran.push(name) }));
  const r = await runParts(f.db, parts, { t0: Date.now(), runMs: 1000, errors: [] });
  assert.deepEqual(ran, ["fast"]);
  assert.deepEqual(r.busy, ["slow"]);
});

test("one part failing doesn't stop the rest; what went wrong is kept", async () => {
  const f = world();
  const ran: string[] = [];
  const parts: Part[] = [
    { name: "boom", ms: 1000, run: async () => { throw new Error("Gmail said no"); } },
    { name: "fast", ms: 1000, run: async () => void ran.push("fast") },
  ];
  const errors: string[] = [];
  await runParts(f.db, parts, { t0: Date.now(), runMs: 1000, errors });
  assert.deepEqual(ran, ["fast"]);
  assert.deepEqual(errors, ["boom: Gmail said no"]);
  const row = f.tables.bot_tick_part.find((x) => x.part === "boom")!;
  assert.equal(row.last_error, "Gmail said no");
  assert.equal(row.locked_at, null);
});

test("before 0112: one lock for the whole run, the parts one after another, as before", async () => {
  const before = (tickLock: string | null) => {
    const f = fakeDb({ watch_settings: [{ id: 1, tick_lock: tickLock }] });
    return { f, db: { ...f.db, rpc: async () => ({ data: null, error: { message: "function _bot_tick_claim does not exist" } }) } as unknown as Db };
  };
  const order: string[] = [];
  const parts: Part[] = ["meetings", "whatsapp", "ring"].map((name) => ({ name, ms: 1000, run: async () => void (await sleep(5), order.push(name)) }));

  const free = before(null);
  const r = await runParts(free.db, parts, { t0: Date.now(), runMs: 1000, errors: [] });
  assert.deepEqual(order, ["meetings", "whatsapp", "ring"]);
  assert.deepEqual(r.busy, []);
  assert.equal(free.f.tables.watch_settings[0]!.tick_lock, null);

  // The last run is still going (it took the lock a minute ago): nothing runs.
  order.length = 0;
  const taken = before(new Date(Date.now() - 60_000).toISOString());
  const r2 = await runParts(taken.db, parts, { t0: Date.now(), runMs: 1000, errors: [] });
  assert.deepEqual(order, []);
  assert.deepEqual(r2.busy, ["meetings", "whatsapp", "ring"]);
});
