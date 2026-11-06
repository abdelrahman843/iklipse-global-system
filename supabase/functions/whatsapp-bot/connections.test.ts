// The connections (connections.ts): logged, fixed when they can be, said after
// two checks, again every 6 hours, and when they're back. Names are made up.
//   npm run test:bot

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { resumeRuns } from "./brain.ts";
import { AGAIN_MS, googleLogin, note, reachable, workerChecks, type Check } from "./connections.ts";
import type { Db } from "./kit.ts";

const MIN = 60_000;
const down = (over: Partial<Check> = {}): Check => ({ service: "whatsapp", label: "WhatsApp", ok: false, error: "session failed", how: "Scan the code in Alerts.", ...over });
const up = (over: Partial<Check> = {}): Check => ({ service: "whatsapp", label: "WhatsApp", ok: true, ...over });

function world() {
  const f = fakeDb({ connection_state: [], connection_event: [] });
  const said: string[] = [];
  return { db: f.db as Db, f, said, tell: async (t: string) => void said.push(t) };
}

test("down: logged at once, said at the second check, once; said again after 6 hours; said when it's back", async () => {
  const w = world();
  let now = 1_800_000_000_000;
  await note(w.db, up(), w.tell, now);
  now += 5 * MIN;
  await note(w.db, down(), w.tell, now);
  assert.deepEqual(w.said, []);
  assert.equal(w.f.tables.connection_event!.length, 1);
  now += 5 * MIN;
  await note(w.db, down(), w.tell, now);
  assert.equal(w.said.length, 1);
  assert.match(w.said[0]!, /⚠️ WhatsApp is down, 5 min now: session failed\.\nScan the code in Alerts\./);
  now += 5 * MIN;
  await note(w.db, down(), w.tell, now);
  assert.equal(w.said.length, 1);
  now += AGAIN_MS;
  await note(w.db, down(), w.tell, now);
  assert.equal(w.said.length, 2);
  now += 5 * MIN;
  await note(w.db, up(), w.tell, now);
  assert.match(w.said[2]!, /✅ WhatsApp is back, after \d+ min\./);
  assert.equal(w.f.tables.connection_event!.length, 2);
  assert.equal(w.f.tables.connection_state![0]!.ok, true);
});

test("back before it was said: logged, nobody bothered", async () => {
  const w = world();
  await note(w.db, up(), w.tell, 1000);
  await note(w.db, down(), w.tell, 2000);
  await note(w.db, up(), w.tell, 3000);
  assert.deepEqual(w.said, []);
  assert.equal(w.f.tables.connection_event!.length, 2);
});

test("a fix is tried at most 3 times, and logged; one that throws is logged too", async () => {
  const w = world();
  let tries = 0;
  const c = down({ fix: async () => { tries++; if (tries === 2) throw new Error("no answer"); } });
  for (let i = 0; i < 5; i++) await note(w.db, c, w.tell, 1_000_000 + i * 5 * MIN);
  assert.equal(tries, 3);
  const fixed = w.f.tables.connection_event!.map((e) => e.fixed_by).filter(Boolean);
  assert.deepEqual(fixed, ["tried by itself", "tried by itself, failed: no answer", "tried by itself"]);
  assert.match(w.said[0]!, /Tried to fix it 2 times\./);
});

test("a worker never signed in isn't down; one that was, is", async () => {
  const w = world();
  const [gpt] = workerChecks({ gpt: false });
  await note(w.db, gpt!, w.tell, 1000);
  await note(w.db, gpt!, w.tell, 2000);
  await note(w.db, gpt!, w.tell, 3000);
  assert.deepEqual(w.said, []);
  const [claude] = workerChecks({ claude: true });
  const [out] = workerChecks({ claude: false });
  await note(w.db, claude!, w.tell, 1000);
  await note(w.db, out!, w.tell, 2000);
  await note(w.db, out!, w.tell, 3000);
  assert.match(w.said[0]!, /Claude on the server is down.*not signed in/);
});

test("what the master says of its workers: only the ones known", () => {
  assert.deepEqual(workerChecks(null), []);
  assert.deepEqual(workerChecks({ other: true }), []);
  assert.equal(workerChecks({ jev: true })[0]!.service, "worker:jev");
});

test("reachable: an answer that isn't ok, or none, is down", async () => {
  assert.equal((await reachable("a", "A", "x", async () => new Response("", { status: 200 }))).ok, true);
  const bad = await reachable("a", "A", "x", async () => new Response("", { status: 503 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "answered 503");
  assert.equal((await reachable("a", "A", "x", async () => { throw new Error("refused"); })).error, "refused");
});

test("a Google login: revoked is down; Google not answering isn't its fault", async () => {
  const revoked = await googleLogin("drive:a", "Drive: a@example.test", "r", "i", "s", (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token revoked" }), { status: 400 })) as typeof fetch);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error, "Token revoked");
  assert.equal(revoked.how, "Connect a@example.test again in Apps.");
  const net = await googleLogin("drive:a", "Drive: a@example.test", "r", "i", "s", (async () => { throw new Error("no network"); }) as typeof fetch);
  assert.equal(net.ok, true);
});

const ENV = { url: "http://brain.test", secret: "s".repeat(40), enabled: true };

function cut(run: Record<string, unknown>, steps: { tool: string; outcome: string }[] = []) {
  const base = { id: "r1", status: "running", chat_id: "1@c.us", reply_chat: "1@c.us", message_id: "m1", request: "Tell Sara the files are late", tier: "owner", payload: { run_id: "r1", text: "Tell Sara the files are late" }, resumes: 0, created_at: new Date(1_800_000_000_000).toISOString() };
  const f = fakeDb({ brain_run: [{ ...base, ...run }], brain_step: steps.map((s) => ({ run_id: "r1", ...s })), wa_file: [] });
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const told: string[] = [];
  const post = (async (url: string, init?: RequestInit) => (posted.push({ url, body: JSON.parse(String(init?.body)) }), new Response("{}", { status: 200 }))) as typeof fetch;
  return { db: f.db as Db, f, posted, told, post, send: (async (_: string, t: string) => (told.push(t), null)) as never };
}
const wrote = (t: string) => t !== "search";
const NOW = 1_800_000_000_000 + 60_000;

test("a run cut off before it did anything is sent again, as it was, and nobody bothered", async () => {
  const w = cut({}, [{ tool: "search", outcome: "ok" }]);
  assert.equal(await resumeRuns(w.db, ENV, w.send, wrote, w.post, NOW), 1);
  assert.equal(w.posted[0]!.url, "http://brain.test/message");
  assert.equal(w.posted[0]!.body.run_id, "r1");
  assert.equal(w.posted[0]!.body.text, "Tell Sara the files are late");
  assert.deepEqual(w.told, []);
  const run = w.f.tables.brain_run![0]!;
  assert.equal(run.status, "queued");
  assert.equal(run.resumes, 1);
});

test("a run that had already done something isn't done twice: closed, and what was done said", async () => {
  const w = cut({}, [{ tool: "message_client", outcome: "ok" }]);
  assert.equal(await resumeRuns(w.db, ENV, w.send, wrote, w.post, NOW), 0);
  assert.deepEqual(w.posted, []);
  assert.equal(w.f.tables.brain_run![0]!.status, "failed");
  assert.match(w.told[0]!, /Not finished: "Tell Sara.*Done: message_client\. The rest wasn't done\./);
});

test("a step that failed changed nothing; a run sent twice already, or from before payloads, is closed and said", async () => {
  const refused = cut({}, [{ tool: "message_client", outcome: "refused" }]);
  assert.equal(await resumeRuns(refused.db, ENV, refused.send, wrote, refused.post, NOW), 1);
  for (const over of [{ resumes: 2 }, { payload: null }]) {
    const w = cut(over);
    assert.equal(await resumeRuns(w.db, ENV, w.send, wrote, w.post, NOW), 0);
    assert.match(w.told[0]!, /couldn't be sent again/);
  }
});

test("its answer already went: closed, nothing said twice; a client isn't told", async () => {
  const w = cut({}, [{ tool: "_reply", outcome: "ok" }]);
  await resumeRuns(w.db, ENV, w.send, wrote, w.post, NOW);
  assert.deepEqual(w.posted, []);
  assert.deepEqual(w.told, []);
  const c = cut({ tier: "client" }, [{ tool: "message_client", outcome: "ok" }]);
  await resumeRuns(c.db, ENV, c.send, wrote, c.post, NOW);
  assert.deepEqual(c.told, []);
});
