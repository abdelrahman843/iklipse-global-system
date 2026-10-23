import { test } from "node:test";
import assert from "node:assert/strict";
import { retryAfterMs, transientStatus, withRetry } from "./retry.ts";

const quick = { baseMs: 100, maxMs: 1000, random: () => 0.5 };

test("a passing error is tried again, further apart each time, then it works", async () => {
  const waits: number[] = [];
  let calls = 0;
  const v = await withRetry(
    async () => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { status: 529 });
      return "ok";
    },
    { ...quick, retries: 2, transient: () => true, sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(v, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("an error that isn't passing fails at once", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("bad request");
      },
      { ...quick, retries: 3, transient: () => false, sleep: async () => {} },
    ),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test("it stops after its retries and gives the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        throw new Error(`try ${++calls}`);
      },
      { ...quick, retries: 2, transient: () => true, sleep: async () => {} },
    ),
    /try 3/,
  );
});

test("it never waits past the deadline", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("busy");
      },
      { ...quick, retries: 5, transient: () => true, deadline: 1050, now: () => 1000, sleep: async () => {} },
    ),
  );
  assert.equal(calls, 1);
});

test("a Retry-After is waited, up to the most", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      if (++calls < 3) throw new Error("busy");
    },
    { ...quick, retries: 2, transient: () => true, waitHint: () => (calls === 1 ? 300 : 60_000), sleep: async (ms) => void waits.push(ms) },
  );
  assert.deepEqual(waits, [300, 1000]);
});

test("which HTTP answers are passing", () => {
  for (const s of [0, 408, 425, 429, 500, 502, 503, 504, 529]) assert.equal(transientStatus(s), true, String(s));
  for (const s of [200, 400, 401, 403, 404, 409, 413, 422, 501, 505]) assert.equal(transientStatus(s), false, String(s));
});

test("Retry-After in seconds or as a date", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("0.5"), 500);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs(""), null);
  assert.equal(retryAfterMs("soon"), null);
});
