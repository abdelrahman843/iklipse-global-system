// What the bot remembers about a client (memory.ts, 0112), with Claude stubbed
// and the database in memory: notes brought up to date from what they said
// since (their private chat and their group messages, never email); what
// they said only privately stays for admins and their own chat; and finding
// a client by their number without reading every client (dm.ts, 0109).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { memoryFor, rememberClients, rememberOne, type Notes } from "./memory.ts";
import { clientByPhone, readDms } from "./dm.ts";
import type { Db, Settings, Team } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude answers with this tool input; what it was asked is kept. */
function claudeSays(name: string, input: Record<string, unknown>) {
  const asked: { system: unknown; user: string }[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    const c = b.messages[0].content;
    asked.push({ system: b.system, user: typeof c === "string" ? c : JSON.stringify(c) });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name, input }], usage: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  return asked;
}

const s = { model: "claude-haiku-5-5", dm_enabled: true, ask_to: "person", ask_phone: "15550009999", ask_group: null, ask_every_min: 30, reply_quiet_sec: 60, reply_max_sec: 300 } as unknown as Settings;
const hour = 60 * 60_000;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
const notes: Notes = {
  facts: [{ text: "Runs Acme, a bakery in Maadi", private: false }],
  likes: [{ text: "Prefers calls after 6 PM", private: true }],
  open: [{ text: "Waiting on the menu designs", private: false }],
};

test("what someone reads: everything for admins and their own chat; only what was said in groups for the rest", () => {
  assert.equal(memoryFor(notes, true), "Facts:\n- Runs Acme, a bakery in Maadi\nLikes:\n- Prefers calls after 6 PM (private)\nOpen:\n- Waiting on the menu designs");
  assert.equal(memoryFor(notes, false), "Facts:\n- Runs Acme, a bakery in Maadi\nOpen:\n- Waiting on the menu designs");
  assert.equal(memoryFor({ facts: [], likes: [{ text: "x", private: true }], open: [] }, false), null);
  assert.equal(memoryFor(null, true), null);
});

function world() {
  return fakeDb({
    client: [{ id: "c1", name: "Sara Ahmed", company: "Acme", phone: "15550003001", phone_key: "15550003001" }],
    bot_client_memory: [{ client_id: "c1", notes, through_at: at(2 * hour), claimed_at: at(1000) }],
    wa_dm: [
      { chat_id: "15550003001@c.us", from_bot: false, text: "Old news, already in the notes", sent_at: at(3 * hour) },
      { chat_id: "15550003001@c.us", from_bot: false, text: "We open a second branch in Zamalek next month", sent_at: at(hour) },
      { chat_id: "15550003001@c.us", from_bot: true, text: "Congrats! We'll plan the launch posts.", sent_at: at(hour - 60_000) },
    ],
    wa_message: [{ phone: "15550003001", from_bot: false, text: "The menu designs look great, approved", sent_at: at(40 * 60_000), wa_group: { name: "Acme | iklipse" } }],
    mail_message: [{ addrs: ["sara@acme.test"], subject: "Invoice", body: "Private email", sent_at: at(30 * 60_000) }],
  });
}

test("brought up to date from what they said since, in their private chat and the groups; never from email", async () => {
  const f = world();
  const asked = claudeSays("notes", {
    facts: [{ text: "Runs Acme, a bakery in Maadi", private: false }, { text: "Opening a second branch in Zamalek next month", private: true }],
    likes: [{ text: "Prefers calls after 6 PM", private: true }],
    open: [],
  });
  assert.equal(await rememberOne(f.db, s, "c1"), true);
  const user = asked[0]!.user;
  assert.match(user, /The client: Sara Ahmed \(Acme\)/);
  assert.match(user, /The notes so far:\nFacts:\n- Runs Acme, a bakery in Maadi\nLikes:\n- Prefers calls after 6 PM \(private\)\nOpen:\n- Waiting on the menu designs/);
  assert.match(user, /PRIVATE THEM: We open a second branch in Zamalek next month/);
  assert.match(user, /PRIVATE IKLIPSE: Congrats! We'll plan the launch posts\./);
  assert.match(user, /GROUP Acme \| iklipse, THEM: The menu designs look great, approved/);
  assert.doesNotMatch(user, /Old news/);
  assert.equal(f.calls.filter((c) => c.table === "mail_message").length, 0);
  const row = f.tables.bot_client_memory[0]!;
  assert.deepEqual((row.notes as Notes).facts.map((l) => l.text), ["Runs Acme, a bakery in Maadi", "Opening a second branch in Zamalek next month"]);
  assert.deepEqual((row.notes as Notes).open, []);
  // Read through the last message: the group one, 40 minutes ago.
  assert.equal(row.through_at, f.tables.wa_message[0]!.sent_at);
  assert.equal(row.claimed_at, null);
});

test("nothing new: no Claude call, the claim let go", async () => {
  const f = fakeDb({
    client: [{ id: "c1", name: "Sara Ahmed", company: "Acme", phone_key: "15550003001" }],
    bot_client_memory: [{ client_id: "c1", notes, through_at: at(0), claimed_at: at(1000) }],
    wa_dm: [],
    wa_message: [],
  });
  const asked = claudeSays("notes", {});
  assert.equal(await rememberOne(f.db, s, "c1"), false);
  assert.equal(asked.length, 0);
  assert.equal(f.tables.bot_client_memory[0]!.claimed_at, null);
});

test("the clients due are the ones the database hands out; before 0112, none", async () => {
  const f = fakeDb(world().tables, { rpc: { _bot_memory_due: () => [{ client_id: "c1" }] } });
  claudeSays("notes", { facts: [], likes: [], open: [] });
  assert.equal(await rememberClients(f.db, s, Date.now() + 60_000), 1);
  const before = { ...f.db, rpc: async () => ({ data: null, error: { message: "function _bot_memory_due does not exist" } }) } as unknown as Db;
  assert.equal(await rememberClients(before, s, Date.now() + 60_000), 0);
});

test("a client is found by their number as WhatsApp writes it, without reading every client; before 0109, as before", async () => {
  const f = fakeDb({ client: [{ id: "c1", name: "Sara Ahmed", phone: "+1 555 000 3001", phone_key: "15550003001" }] });
  assert.equal((await clientByPhone(f.db, "15550003001"))?.id, "c1");
  assert.deepEqual(f.calls.map((c) => c.ops.find(([n]) => n === "eq")?.[1]), ["phone_key"]);

  const old = fakeDb(
    { client: [{ id: "c1", name: "Sara Ahmed", phone: "+1 555 000 3001" }] },
    { fail: (c) => (c.ops.some(([n, col]) => n === "eq" && col === "phone_key") ? { message: "column client.phone_key does not exist", code: "42703" } : null) },
  );
  assert.equal((await clientByPhone(old.db, "15550003001"))?.id, "c1");
});

test("the bot answering them sees what it remembers, their private part too", async () => {
  const f = fakeDb({
    wa_dm_chat: [{ chat_id: "15550003001@c.us", phone: "15550003001", name: "Sara", pending_since: at(5 * 60_000), last_message_at: at(5 * 60_000), analyzed_at: null, sorry_at: null, away_at: null, claimed_at: null }],
    wa_dm: [{ id: "d1", chat_id: "15550003001@c.us", from_bot: false, text: "When can we talk?", sent_at: at(5 * 60_000), created_at: at(5 * 60_000) }],
    client: [{ id: "c1", name: "Sara Ahmed", company: "Acme", name_known: true, phone: "15550003001", phone_key: "15550003001", email: null, wa_lid: null, from_chat: null, timezone: null }],
    bot_client_memory: [{ client_id: "c1", notes }],
    bot_draft: [],
  });
  const asked = claudeSays("decide", { action: "none" });
  const t: Team = { people: new Map(), byPhone: new Map(), byLid: new Map(), others: new Set() };
  await readDms(f.db, s, t, async () => "m1", Date.now() + 60_000);
  assert.match(asked[0]!.user, /What you remember about them from their chats \(the chat below is newer, it wins\):\nFacts:\n- Runs Acme, a bakery in Maadi\nLikes:\n- Prefers calls after 6 PM \(private\)/);
});
