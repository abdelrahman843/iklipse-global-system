// Orders from the team (orders.ts): with the agent off, Claude is asked
// exactly what it was asked before; an order to one person (giveOrder, now
// shared with the agent) does what it did before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fakeDb } from "./test/fake-db.ts";
import { agentFor, giveOrder, orderSystem, orderTool } from "./orders.ts";
import type { Person, Settings } from "./kit.ts";
import type { Attendee } from "./meetings.ts";

// remind: reminders at a time (0110).
const ACTIONS = ["orders", "meeting", "my_order", "question", "answer", "handled", "stop", "status", "write_out", "remind", "ignore", "none"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type ActionProp = { enum: string[] };
const actions = (agent: boolean) => ((orderTool(agent).input_schema.properties as Record<string, ActionProp>).action.enum);

test("agent off: the act tool has no task, and its words don't mention one", () => {
  assert.deepEqual(actions(false), ACTIONS);
  assert.doesNotMatch(orderSystem(false), /- task:/);
});

test("agent on: only task is added, and the words around it don't change", () => {
  assert.deepEqual(actions(true), [...ACTIONS, "task"]);
  const on = orderSystem(true);
  assert.match(on, /\n- task: [^\n]+\n- ignore: /);
  assert.equal(sha(on.replace(/\n- task: [^\n]+/, "")), sha(orderSystem(false)));
  // The tool everyone else gets is untouched.
  assert.deepEqual(actions(false), ACTIONS);
});

test("who gets the agent: BOT_AGENT on (the team), admins (admins only), anything else nobody", () => {
  const admin: Person = { id: "a", name: "Omar", username: "omar", active: true, admin: true };
  const member: Person = { ...admin, id: "m", admin: false };
  const gone: Person = { ...admin, active: false };
  assert.equal(agentFor(admin, ""), false);
  assert.equal(agentFor(admin, "yes"), false);
  assert.equal(agentFor(admin, "admins"), true);
  assert.equal(agentFor(member, "admins"), false);
  assert.equal(agentFor(member, "on"), true);
  assert.equal(agentFor(gone, "on"), false);
  assert.equal(agentFor(undefined, "on"), false);
});

// --------------------------------------------------------------- giveOrder --

const s = { order_every_min: 60 } as Settings;
const at = { chat_id: "team@g.us", message_id: "m1" };
const by = { id: "u-sameh", name: "Sameh" };
const rabah: Attendee = { kind: "team", id: "u-rabah", name: "Rabah", email: null, phone: "15555550101" };
const x = { kind: "tell" as const, task: "send the logo files", message: "Hi Rabah – Sameh asks you to send the logo files.", nudge: "Rabah, a reminder.", wait: true };

function sender(fail?: string) {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    if (fail) throw new Error(fail);
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}

test("an order is kept, written to them, and stays open to follow up", async () => {
  const f = fakeDb({ bot_order: [] });
  const { send, sent } = sender();
  const g = await giveOrder(f.db, s, send, at, by, "@iklipse tell Rabah to send the logo files", rabah, x);
  assert.equal(g.problem, undefined);
  assert.equal(g.told, undefined);
  const row = f.tables.bot_order[0];
  assert.equal(row.status, "open");
  assert.equal(row.to_chat, "15555550101@c.us");
  assert.equal(row.by_user, "u-sameh");
  assert.deepEqual(row.sent_ids, ["wamid-1"]);
  assert.equal(sent[0].chat, "15555550101@c.us");
  assert.equal(sent[0].text, "Hi Rabah ,  Sameh asks you to send the logo files.");
});

test("passing something on: said once, and done", async () => {
  const f = fakeDb({ bot_order: [] });
  const g = await giveOrder(f.db, s, sender().send, at, by, "tell Rabah I'm late", rabah, { ...x, wait: false });
  assert.equal(g.told, true);
  assert.equal(f.tables.bot_order[0].status, "done");
  assert.equal(f.tables.bot_order[0].outcome, "Told");
});

test("what goes wrong is said, and where it stopped", async () => {
  const noPhone = await giveOrder(fakeDb({ bot_order: [] }).db, s, sender().send, at, by, "t", { ...rabah, phone: null }, x);
  assert.equal(noPhone.stage, "check");
  assert.match(noPhone.problem!, /I don't have Rabah's WhatsApp number/);

  const f = fakeDb({ bot_order: [] });
  const failed = await giveOrder(f.db, s, sender("WhatsApp (Green API): not authorized").send, at, by, "t", rabah, x);
  assert.equal(failed.stage, "send");
  assert.match(failed.problem!, /Couldn't send it to Rabah: WhatsApp \(Green API\): not authorized/);
  assert.equal(f.tables.bot_order[0].status, "failed");

  const down = fakeDb({ bot_order: [] }, { fail: (c) => (c.op === "insert" ? "db down" : null) });
  const kept = await giveOrder(down.db, s, sender().send, at, by, "t", rabah, x);
  assert.equal(kept.stage, "keep");
  assert.equal(kept.problem, "Couldn't keep the order for Rabah.");
});

test("to a client: what the order and their chat don't say doesn't go (guard.ts); what they say does", async () => {
  const sara: Attendee = { kind: "client", id: "c-sara", name: "Sara Ahmed", email: "sara@acme.test", phone: "15555550202" };
  const world = () =>
    fakeDb({
      bot_order: [],
      wa_dm: [{ chat_id: "15555550202@c.us", text: "Any news on the price?", sent_at: "2026-10-22T10:00:00Z" }],
      client: [
        { id: "c-sara", name: "Sara Ahmed", company: "Acme", name_known: true, email: "sara@acme.test", phone: "15555550202" },
        { id: "c-mona", name: "Mona Fathy", company: "Nile Foods", name_known: true, email: null, phone: "15555550303" },
      ],
      bot_guard_block: [],
    });
  const tell = { kind: "tell" as const, task: "tell her the price", wait: false, nudge: "" };

  const f = world();
  const { send, sent } = sender();
  const g = await giveOrder(f.db, s, send, at, by, "tell Sara the price is 500$", sara, { ...tell, message: "Hi Sara, the logo package is $500, same as Nile Foods paid." });
  assert.equal(g.stage, "check");
  assert.equal(g.problem, "I didn't send it to Sara Ahmed: the message had another client's name (Nile Foods), which isn't in your order or their chat. Tell me exactly what to send.");
  assert.deepEqual(sent, []);
  assert.equal(f.tables.bot_order.length, 0);
  assert.equal(f.tables.bot_guard_block[0].where_from, "orders.message");

  const ok = world();
  const fine = sender();
  const g2 = await giveOrder(ok.db, s, fine.send, at, by, "tell Sara the price is 500$", sara, { ...tell, message: "Hi Sara, the logo package is $500." });
  assert.equal(g2.problem, undefined);
  assert.deepEqual(fine.sent.map((m) => m.text), ["Hi Sara, the logo package is $500."]);
});
