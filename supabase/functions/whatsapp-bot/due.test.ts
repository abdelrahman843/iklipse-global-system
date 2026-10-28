// An alert's due time follows the chat (chat.ts, kit.ts updateAlert): a message
// that moves it moves it, and starts the ringing over; and what a call or a
// reminder says about it (kit.ts callTiming, pause.ts nudgeText) counts from
// that time: "due in" before it, "overdue" after, never a late that isn't.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { readChat, type ChatLine } from "./chat.ts";
import { callTiming, type Person, type Settings, type Team } from "./kit.ts";
import { nudgeText } from "./pause.ts";
import { shortId } from "./repeat.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const hour = 60 * 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const sameh: Person = { id: "sameh", name: "Sameh", username: "sameh", active: true, admin: false };
const t: Team = { people: new Map([[sameh.id, sameh]]), byPhone: new Map(), byLid: new Map(), others: new Set() };
const s = { model: "claude-haiku-5-5", reply_wait_min: 10, promise_wait_min: 60, follow_wait_min: 120, deadline_enabled: true, follow_enabled: true, cc_admins: false, deadline_before_hours: 24 } as unknown as Settings;
const chat = { source: "whatsapp" as const, col: "chat_id" as const, id: "sq@g.us", name: "Side quest" };
const PROMISE = "33333333-0000-4000-8000-000000000003";

/** Sameh promised an update 40 hours ago, due 30 hours ago: 13 alerts and calls since. */
function rung() {
  const now = Date.now();
  return fakeDb({
    watch_alert: [{ id: PROMISE, chat_id: chat.id, source: "whatsapp", kind: "promise", title: "Sameh promised an update", detail: "Monday evening update", person: "Sameh", person_key: "t:sameh", status: "open", message_id: "m1", due_at: at(now - 30 * hour), created_at: at(now - 40 * hour), alerts_sent: 13, calls_made: 13, next_alert_at: at(now - 60_000) }],
    watch_recipient: [{ alert_id: PROMISE, user_id: "sameh", calls: 13, next_call_at: at(now) }],
    watch_event: [],
  });
}
const lines = (now = Date.now()): ChatLine[] => [
  { id: "m1", sent_at: at(now - 40 * hour), isNew: false, team: true, name: "Sameh", who: "t:sameh", replyTo: null, text: "Monday evening update" },
  { id: "m2", sent_at: at(now - 30_000), isNew: true, team: true, name: "Sameh", who: "t:sameh", replyTo: null, text: "We'll get back to you EOD today" },
];
function claudeUpdates(update: Record<string, unknown>[]) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "report", input: { open: [], resolve: [], update } }], usage: {} }), { status: 200 })) as typeof fetch;
}

test("the chat says it's later: the due time moves and the ringing starts over", async () => {
  const f = rung();
  const eod = Date.now() + 5 * hour;
  claudeUpdates([{ alert: shortId(PROMISE), due_at: at(eod), detail: "Sameh now says EOD today" }]);
  await readChat(f.db, s, t, chat, lines(), new Map([[sameh.id, sameh]]));
  const p = f.tables.watch_alert.find((a) => a.id === PROMISE)!;
  assert.equal(p.due_at, at(eod));
  assert.equal(p.alerts_sent, 0);
  assert.equal(p.next_alert_at, at(eod));
  const r = f.tables.watch_recipient[0]!;
  assert.equal(r.next_call_at, null);
  assert.equal(r.calls, 0);
});

test("a detail with no new time leaves the due time and the pace alone", async () => {
  const f = rung();
  claudeUpdates([{ alert: shortId(PROMISE), detail: "Still waiting on Sameh" }]);
  await readChat(f.db, s, t, chat, lines(), new Map([[sameh.id, sameh]]));
  const p = f.tables.watch_alert.find((a) => a.id === PROMISE)!;
  assert.equal(p.alerts_sent, 13);
  assert.equal(f.tables.watch_recipient[0]!.calls, 13);
});

test("a follow-up asked again with no time restarts its wait from the latest message", async () => {
  const f = rung();
  f.tables.watch_alert[0]!.kind = "follow_up";
  const l = lines();
  claudeUpdates([{ alert: shortId(PROMISE), detail: "Asked again" }]);
  await readChat(f.db, s, t, chat, l, new Map([[sameh.id, sameh]]));
  const p = f.tables.watch_alert.find((a) => a.id === PROMISE)!;
  assert.equal(p.due_at, at(Date.parse(l[1]!.sent_at) + 120 * 60_000));
  assert.equal(p.alerts_sent, 0);
});

test("the thread moved: the alert says where it stands, who it waits on, and the wait restarts", async () => {
  const f = rung();
  f.tables.watch_alert[0]!.kind = "follow_up";
  const l = lines();
  claudeUpdates([{ alert: shortId(PROMISE), title: "Costi replied, Sameh hasn't confirmed", detail: "Costi said 9:30 works; Sameh still has to confirm the booking", waiting_on: "team" }]);
  await readChat(f.db, s, t, chat, l, new Map([[sameh.id, sameh]]));
  const p = f.tables.watch_alert.find((a) => a.id === PROMISE)!;
  assert.equal(p.title, "Costi replied, Sameh hasn't confirmed");
  assert.equal(p.kind, "unanswered");
  assert.equal(p.due_at, at(Date.parse(l[1]!.sent_at) + 10 * 60_000));
  assert.equal(p.alerts_sent, 0);
});

test("the prompt tells Claude a moved time always comes with its due_at", async () => {
  const f = rung();
  let system = "";
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    system = JSON.stringify(JSON.parse(String(init.body)).system);
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "report", input: { open: [], resolve: [] } }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  await readChat(f.db, s, t, chat, lines(), new Map([[sameh.id, sameh]]));
  assert.ok(system.includes("always goes in update with the new due_at"));
  assert.ok(system.includes('end of day\\" is 18:00'));
});

test("what a call says: due in before the time, overdue after, a waiting client from when it opened", () => {
  const now = Date.parse("2026-10-26T12:00:00+03:00");
  const alert = (kind: string, due: number) => ({ kind, created_at: at(now - 6 * hour), due_at: at(due) });
  const early = callTiming(alert("deadline", now + 3 * hour), now);
  assert.equal(early.timing, "due in 3 hours");
  assert.deepEqual(early.due, { due_in: "3 hours" });
  const late = callTiming(alert("promise", now - 90 * 60_000), now);
  assert.equal(late.timing, "1 hour 30 minutes overdue");
  assert.deepEqual(late.due, { overdue_by: "1 hour 30 minutes" });
  const waits = callTiming(alert("unanswered", now - hour), now);
  assert.equal(waits.timing, "for 6 hours now");
  assert.deepEqual(waits.due, {});
});

test("what a reminder says counts from the due time the same way", () => {
  const now = Date.parse("2026-10-26T12:00:00+03:00");
  const row = (due: number) => ({ id: "a", kind: "promise", title: "Sameh promised an update", detail: "Sameh promised an update", created_at: at(now - 40 * hour), due_at: at(due), chat_id: "sq@g.us", wa_group: { name: "Side quest" }, slack_channel: null }) as unknown as Parameters<typeof nudgeText>[2];
  assert.match(nudgeText({ name: "Sara" }, undefined, row(now + 6 * hour), now), /Due in 6 hours\./);
  assert.match(nudgeText({ name: "Sara" }, undefined, row(now - 2 * hour), now), /Overdue by 2 hours\./);
});
