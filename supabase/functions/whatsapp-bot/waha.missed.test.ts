// The catch-up (waha.ts wahaMissed): what the bridge has from the last hour
// that the bot never got, as its webhook would have sent it. One the bot got
// (waha_msg) or kept (wa_dm, wa_message) isn't sent again. WAHA is stubbed;
// numbers are made up.
//   npm run test:bot

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import type { Db } from "./kit.ts";

const BASE = "https://waha.example.test";
const realGet = Deno.env.get;
const realFetch = globalThis.fetch;
let asked: string[] = [];
let status = "WORKING";

const msg = (id: string, ts: number, hasMedia = false) => ({ id: `false_15555550001@c.us_${id}`, timestamp: ts, hasMedia, body: id, fromMe: false, from: "15555550001@c.us" });
const LIST = [msg("GOT", 100), msg("KEPT", 300), msg("NEW2", 400, true), msg("NEW1", 200)];

beforeEach(() => {
  asked = [];
  status = "WORKING";
  Deno.env.get = (k: string) => ({ WAHA_URL: BASE, WAHA_API_KEY: "test-waha-key" })[k] ?? realGet(k);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url.replace(BASE, ""));
    if (url.endsWith("/api/sessions/default")) return Response.json({ name: "default", status, me: { id: "15555550000@c.us" } });
    if (url.includes("/chats/all/messages?")) return Response.json(LIST);
    if (url.includes("/messages/false_")) return Response.json({ ...msg("NEW2", 400, true), media: { url: `${BASE}/api/files/x.jpg`, mimetype: "image/jpeg" } });
    throw new Error(`no network: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Deno.env.get = realGet;
});

test("only the ones the bot never got, oldest first, a file's with its file", async () => {
  const { wahaMissed } = await import("./waha.ts");
  const { db } = fakeDb({ waha_msg: [{ id: "GOT", full_id: "x" }], wa_dm: [{ id: "KEPT", chat_id: "15555550001@c.us" }], wa_message: [] });
  const now = 10_000_000_000;
  const out = await wahaMissed(db as Db, now);
  assert.deepEqual(
    out.map((e) => (e.payload as { id: string }).id.split("_")[2]),
    ["NEW1", "NEW2"],
  );
  assert.equal(out[0].event, "message.any");
  assert.deepEqual(out[0].me, { id: "15555550000@c.us" });
  assert.equal((out[1].payload as { media?: { url: string } }).media?.url, `${BASE}/api/files/x.jpg`);
  // The last hour, less the two minutes left to the webhook.
  const list = asked.find((u) => u.includes("/chats/all/messages?"))!;
  assert.match(list, new RegExp(`filter\\.timestamp\\.gte=${(now - 3_600_000) / 1000}`));
  assert.match(list, new RegExp(`filter\\.timestamp\\.lte=${(now - 120_000) / 1000}`));
  assert.match(list, /downloadMedia=false/);
});

test("nothing asked while the number isn't working", async () => {
  const { wahaMissed } = await import("./waha.ts");
  status = "SCAN_QR_CODE";
  const { db } = fakeDb({ waha_msg: [], wa_dm: [], wa_message: [] });
  assert.deepEqual(await wahaMissed(db as Db), []);
  assert.equal(asked.some((u) => u.includes("/messages")), false);
});
