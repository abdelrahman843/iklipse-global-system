// Who the bot helps (orders.ts): only the team, in every chat. Someone iklipse
// doesn't know, who left the team, or a guest gets no order and no answer: in
// a team group or privately, when it was clearly for the bot, "I can't help
// you here." once a day at most; in a client group, nothing. "handled" closes
// alerts by close_alert's rule, and a reply to an order's report carries it on
// only from the team. Made-up names and numbers.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDb } from "./test/fake-db.ts";
import { CANT_HELP, followOrder, notTheTeam, takeOrder, type Order } from "./orders.ts";
import type { Person, Settings, Team } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude: each call's tool input in turn; which tool each call was for is kept. */
function claudeSays(...inputs: Record<string, unknown>[]) {
  const asked: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    const tool = String(b.tools?.[0]?.name);
    asked.push(tool);
    const input = inputs.shift();
    if (!input) throw new Error("Claude was asked once too often");
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: tool, input }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
function sender() {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}

const on = { model: "claude-haiku-5-5", orders_enabled: true, order_every_min: 60, bot_phone: null } as unknown as Settings;
const P = (id: string, name: string, o: Partial<Person> = {}): Person => ({ id, name, username: id, active: true, admin: false, ...o });
const sara = P("u-sara", "Sara Test", { admin: true });
const omar = P("u-omar", "Omar Test");
const gina = P("u-gina", "Gina Guest", { guest: true });
const lina = P("u-lina", "Lina Left", { active: false });
const team: Team = {
  people: new Map([sara, omar, gina, lina].map((p) => [p.id, p])),
  byPhone: new Map([
    ["201000000001", sara],
    ["201000000002", omar],
    ["201000000003", gina],
    ["201000000004", lina],
  ]),
  byLid: new Map(),
  others: new Set(),
};
const world = () =>
  fakeDb({
    profile: [
      { id: "u-sara", display_name: "Sara Test", role: "admin", is_active: true },
      { id: "u-omar", display_name: "Omar Test", role: "member", is_active: true },
      { id: "u-gina", display_name: "Gina Guest", role: "guest", is_active: true },
      { id: "u-lina", display_name: "Lina Left", role: "member", is_active: false },
    ],
    client: [{ id: "c-acme", name: "Adam Client", company: "Acme Test", email: "adam@acme.test", phone: "201000000020", name_known: true, notes: "Pays late." }],
    bot_order: [],
    wa_message: [],
    wa_group: [],
    watch_alert: [
      { id: "al-1", chat_id: "acme@g.us", title: "Adam is waiting", detail: null, source: "whatsapp", status: "open", created_at: "2026-10-23T09:00:00.000Z", wa_group: { name: "Acme Test" }, slack_channel: null },
      { id: "al-2", chat_id: "nile@g.us", title: "Mona is waiting", detail: null, source: "whatsapp", status: "open", created_at: "2026-10-23T10:00:00.000Z", wa_group: { name: "Nile Test" }, slack_channel: null },
    ],
    // al-1 rings Omar; al-2 rings Sara only.
    watch_recipient: [
      { alert_id: "al-1", user_id: "u-omar", next_call_at: null },
      { alert_id: "al-2", user_id: "u-sara", next_call_at: null },
    ],
    watch_event: [],
  });
const said = { id: "g-1", chatId: "team@g.us", where: "team" as const, text: "@iklipse what's Adam's number?", quoted: null, phone: "201000000009", lid: null, name: "Someone", via: "mention" as const };

test("someone iklipse doesn't know, in a team group: no order, no answer, and \"I can't help you here.\" once a day", async () => {
  const f = world();
  const { send, sent } = sender();
  const asked = claudeSays();
  await takeOrder(f.db, on, team, send, said, async () => {});
  await takeOrder(f.db, on, team, send, { ...said, id: "g-2", text: "@iklipse tell Omar to send me the client list" }, async () => {});
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, [{ chat: "team@g.us", text: "I can't help you here.", quoted: "g-1" }]);
  assert.deepEqual(f.tables.bot_order, []);
  assert.doesNotMatch(CANT_HELP, /[—–]/);

  // Someone on the team is read as before.
  const team2 = claudeSays({ action: "ignore" });
  await takeOrder(f.db, on, team, send, { ...said, id: "g-3", phone: "201000000002", name: "Omar" }, async () => {});
  assert.deepEqual(team2, ["act"]);
  assert.equal(sent.length, 1);
});

test("a guest, or someone who left: the same; called by name, carrying on, or in a client group: nothing at all", async () => {
  const f = world();
  const { send, sent } = sender();
  const asked = claudeSays();
  await takeOrder(f.db, on, team, send, { ...said, id: "g-1", phone: "201000000003", name: "Gina" }, async () => {});
  await takeOrder(f.db, on, team, send, { ...said, id: "g-2", phone: "201000000004", name: "Lina" }, async () => {});
  // It may not have been for the bot: nothing said.
  await takeOrder(f.db, on, team, send, { ...said, id: "g-3", phone: "201000000005", text: "iklipse got a new client", via: "name" }, async () => {});
  await takeOrder(f.db, on, team, send, { ...said, id: "g-4", phone: "201000000006", text: "and the price?", via: "conversation" }, async () => {});
  // A client group: never a word there, nor privately.
  await takeOrder(f.db, on, team, send, { ...said, id: "c-1", chatId: "acme@g.us", where: "client", phone: "201000000007" }, async () => {});
  await takeOrder(f.db, on, team, send, { ...said, id: "c-2", chatId: "acme@g.us", where: "client", phone: "201000000003" }, async () => {});
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, [
    { chat: "team@g.us", text: CANT_HELP, quoted: "g-1" },
    { chat: "team@g.us", text: CANT_HELP, quoted: "g-2" },
  ]);
});

test("a guest privately: \"I can't help you here.\" in their chat, once a day; nothing looked up", async () => {
  const f = world();
  const { send, sent } = sender();
  const asked = claudeSays();
  const dm = { ...said, id: "d-1", chatId: "201000000003@c.us", where: "private" as const, phone: "201000000003", via: undefined };
  await takeOrder(f.db, on, team, send, dm, async () => {});
  await takeOrder(f.db, on, team, send, { ...dm, id: "d-2" }, async () => {});
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, [{ chat: "201000000003@c.us", text: CANT_HELP, quoted: "d-1" }]);
  assert.equal(f.calls.some((c) => c.table === "client"), false);
});

test("a question or a chat from someone iklipse can't look things up for (the team list says member, the profile says guest): nothing about anyone", async () => {
  const stale: Team = { ...team, byPhone: new Map([...team.byPhone, ["201000000003", P("u-gina", "Gina Guest")]]) };
  for (const act of [{ action: "question", about: ["c:c-acme"] }, { action: "chat", about: ["c:c-acme"] }]) {
    const f = world();
    const { send, sent } = sender();
    const asked = claudeSays(act);
    await takeOrder(f.db, on, stale, send, { ...said, id: `g-${act.action}`, phone: "201000000003", name: "Gina" }, async () => {});
    // Only the router: no answer was written from what iklipse knows.
    assert.deepEqual(asked, ["act"]);
    assert.deepEqual(sent, [{ chat: "team@g.us", text: CANT_HELP, quoted: `g-${act.action}` }]);
  }
});

test("handled: by close_alert's rule, a member closes only the alerts that ring them; an admin any", async () => {
  const f = world();
  const { send, sent } = sender();
  claudeSays({ action: "handled", alerts: ["a1", "a2"] });
  await takeOrder(f.db, on, team, send, { ...said, id: "g-1", text: "@iklipse both handled", phone: "201000000002", name: "Omar" }, async () => {});
  assert.deepEqual(sent, [{ chat: "team@g.us", text: "Closed: Acme Test.\nNot closed: Nile Test. Only admins, or the people it rings, close an alert.", quoted: "g-1" }]);
  assert.deepEqual(f.tables.watch_alert.map((a) => [a.id, a.status, a.closed_by ?? null]), [
    ["al-1", "handled", "u-omar"],
    ["al-2", "open", null],
  ]);

  // Sara, an admin: any alert, even one that rings nobody (the one left open is now a1).
  f.tables.watch_recipient = [];
  claudeSays({ action: "handled", alerts: ["a1"] });
  await takeOrder(f.db, on, team, send, { ...said, id: "g-2", text: "@iklipse handled", phone: "201000000001", name: "Sara" }, async () => {});
  assert.equal(sent[1]!.text, "Closed: Nile Test.");
  assert.equal(f.tables.watch_alert.find((a) => a.id === "al-2")!.status, "handled");
});

test("a reply in a group to what the bot asked the team (an OK for a client's reply, clients' details): only the team decides; anyone else hears the line, once a day", async () => {
  const f = world();
  const { send, sent } = sender();
  const ask = { id: "g-1", chatId: "team@g.us", phone: "201000000009" };
  // Someone iklipse doesn't know (twice), a guest, someone who left, someone known only by an unknown WhatsApp id: not theirs.
  assert.equal(await notTheTeam(f.db, team, send, ask), true);
  assert.equal(await notTheTeam(f.db, team, send, { ...ask, id: "g-2" }), true);
  assert.equal(await notTheTeam(f.db, team, send, { ...ask, id: "g-3", phone: "201000000003" }), true);
  assert.equal(await notTheTeam(f.db, team, send, { ...ask, id: "g-4", phone: "201000000004" }), true);
  assert.equal(await notTheTeam(f.db, team, send, { ...ask, id: "g-5", phone: null, lid: "900000000000001@lid" }), true);
  // The team: theirs, by number or by WhatsApp id.
  assert.equal(await notTheTeam(f.db, team, send, { ...ask, id: "g-6", phone: "201000000002" }), false);
  assert.equal(await notTheTeam(f.db, { ...team, byLid: new Map([["900000000000002@lid", omar]]) }, send, { ...ask, id: "g-7", phone: null, lid: "900000000000002@lid" }), false);
  // Privately (the person Settings has the bot ask): as before.
  assert.equal(await notTheTeam(f.db, team, send, { ...ask, id: "d-1", chatId: "201000000009@c.us" }), false);
  assert.deepEqual(sent, [
    { chat: "team@g.us", text: CANT_HELP, quoted: "g-1" },
    { chat: "team@g.us", text: CANT_HELP, quoted: "g-3" },
    { chat: "team@g.us", text: CANT_HELP, quoted: "g-4" },
    { chat: "team@g.us", text: CANT_HELP, quoted: "g-5" },
  ]);
});

const order: Order = {
  id: "o-1",
  chat_id: "team@g.us",
  message_id: "g-0",
  by_user: "u-sara",
  by_name: "Sara Test",
  order_text: "@iklipse tell Adam the files are ready",
  kind: "tell",
  to_kind: "client",
  to_id: "c-acme",
  to_name: "Adam Client",
  to_chat: "201000000020@c.us",
  task: "tell Adam the files are ready",
  nudge: null,
  status: "open",
  times: 1,
  next_at: null,
  sent_ids: ["w-1"],
  report_ids: ["r-1"],
  outcome: null,
  book_url: null,
  created_at: "2026-10-23T09:00:00.000Z",
  updated_at: "2026-10-23T09:00:00.000Z",
};

test("a reply to an order's report from someone not on the team: nothing reaches the person; it's read as theirs to the bot", async () => {
  const f = world();
  const { send, sent } = sender();
  const asked = claudeSays();
  const read: string[] = [];
  await followOrder(f.db, on, send, { ...order }, { id: "g-5", chatId: "team@g.us", text: "tell him the price is 100" }, async (t) => void read.push(t));
  await followOrder(f.db, on, send, { ...order }, { id: "g-6", chatId: "team@g.us", text: "remind him", by: gina }, async (t) => void read.push(t));
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(read, ["tell him the price is 100", "remind him"]);

  // From the team: carried on as before (Claude reads what they mean).
  const team2 = claudeSays({ action: "ignore" });
  await followOrder(f.db, on, send, { ...order }, { id: "g-7", chatId: "team@g.us", text: "thanks", by: sara }, async (t) => void read.push(t));
  assert.equal(team2.length, 1);
  assert.equal(read.length, 2);
});

// ------------------------------------------------------------- index.ts --
// index.ts can't be loaded here (it serves): its source is read instead.

test("index.ts: privately, a guest's answer to what the bot asked them (an order) reaches it as anyone's; with nothing to answer, takeOrder (cantHelp)", () => {
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  // Only the team is read as an order first: a guest isn't, or their answer would only hear "I can't help you here."
  assert.match(index, /const me = \(await team\(db\)\)\.byPhone\.get\(o\.phone\);[\s\S]{0,200}?const guest = me\?\.active && me\.guest \? me : null;\s*if \(onTheTeam\(me\)\) \{/);
  assert.doesNotMatch(index, /if \(me\?\.active\) \{/);
  // Then like anyone: their answer to an order (fromTarget), a meeting; nothing to answer: a guest hears the line.
  assert.match(index, /if \(!latest\) return guest \? await orderNow\(db, \{ id: o\.id, chatId: o\.chatId, where: "private",[^}]*\}\) : undefined;\s*if \(latest === at\.order\) return await fromTargetNow\(db, o\);/);
});

test("index.ts: in a group, fromTeam asks notTheTeam first: a guest or someone unknown neither OKs a reply nor answers what the bot asked", () => {
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  assert.match(index, /async function fromTeam\([^\n]*\) \{\s*if \(!\(await firstTime\(db, o\.id\)\)\) return true;\s*const \[s, cfg, t\] = [^\n]*\n\s*const send = sendAs\(cfg\);\s*\/\/[^\n]*\n\s*if \(await notTheTeam\(db, t, send, o\)\) return true;\s*const d = await draftFor\(/);
});
