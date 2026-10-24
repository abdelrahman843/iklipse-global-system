// The brain's door: signed by the function or refused; signatures made the
// same way as whatsapp-bot brain.ts makes them (sign.ts, server.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { brainServer } from "../src/server.js";
import { canonical, signature, signedBy } from "../src/sign.js";
import type { Incoming } from "../src/prompt.js";

const SECRET = "b".repeat(40);
const RUN = "11111111-1111-4111-8111-111111111111";

test("a signature is HMAC-SHA256 of direction.time.body, the function's way", () => {
  const now = 1_800_000_000_000;
  const body = '{"a":1}';
  const want = createHmac("sha256", SECRET).update(`to-brain.${now / 1000}.${body}`).digest("hex");
  assert.equal(signature(SECRET, "to-brain", body, now), `t=${now / 1000},v1=${want}`);
  assert.equal(signedBy(SECRET, "to-brain", body, signature(SECRET, "to-brain", body, now), now), true);
  assert.equal(signedBy(SECRET, "to-bot", body, signature(SECRET, "to-brain", body, now), now), false);
  assert.equal(signedBy(SECRET, "to-brain", body, signature(SECRET, "to-brain", body, now), now + 301_000), false);
});

test("canonical JSON matches the function's (sorted keys, no undefined)", () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: undefined }], e: null }), '{"a":[{"d":2}],"b":1,"e":null}');
});

async function up() {
  const got: { messages: Incoming[]; approvals: string[]; control: boolean[] } = { messages: [], approvals: [], control: [] };
  const seen = new Set<string>();
  const server = brainServer({
    secret: SECRET,
    version: "test",
    message: (m) => (seen.has(m.run_id) ? "duplicate" : (seen.add(m.run_id), got.messages.push(m), "accepted")),
    approval: (id) => void got.approvals.push(id),
    control: (s) => void got.control.push(s),
    state: () => ({ busy: 0, stopped: false }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, payload: unknown, o: { dir?: "to-brain" | "to-bot"; secret?: string; sign?: boolean } = {}) => {
    const body = JSON.stringify(payload);
    return fetch(`${url}${path}`, {
      method: "POST",
      body,
      headers: o.sign === false ? {} : { "x-brain-signature": signature(o.secret ?? SECRET, o.dir ?? "to-brain", body) },
    });
  };
  return { got, url, post, close: () => server.close() };
}

const message = { run_id: RUN, message_id: "m1", chat_id: "201000000003@c.us", reply_chat: "201000000003@c.us", sender: { id: "u1", name: "Rabah", tier: "member" }, text: "what's late?" };

test("unsigned, signed for the other way, or another secret: 403", async () => {
  const s = await up();
  try {
    assert.equal((await s.post("/message", message, { sign: false })).status, 403);
    assert.equal((await s.post("/message", message, { dir: "to-bot" })).status, 403);
    assert.equal((await s.post("/message", message, { secret: "c".repeat(40) })).status, 403);
    assert.equal(s.got.messages.length, 0);
  } finally {
    s.close();
  }
});

test("a message: 202 at once, the same one twice taken once", async () => {
  const s = await up();
  try {
    const a = await s.post("/message", message);
    assert.equal(a.status, 202);
    assert.deepEqual(await a.json(), { accepted: true });
    assert.deepEqual(await (await s.post("/message", message)).json(), { duplicate: true });
    assert.equal(s.got.messages.length, 1);
    assert.equal((await s.post("/message", { ...message, sender: { id: "u1", tier: "client" } })).status, 400, "no other tier");
  } finally {
    s.close();
  }
});

test("the kill switch and OKs come signed too; health is open", async () => {
  const s = await up();
  try {
    assert.equal((await s.post("/control", { stopped: true })).status, 200);
    assert.deepEqual(s.got.control, [true]);
    assert.equal((await s.post("/approval", { approval_id: RUN })).status, 202);
    assert.equal((await s.post("/approval", { approval_id: "x" })).status, 400);
    assert.deepEqual(s.got.approvals, [RUN]);
    const h = await fetch(`${s.url}/health`);
    assert.equal(h.status, 200);
    assert.equal(((await h.json()) as { ok: boolean }).ok, true);
  } finally {
    s.close();
  }
});
