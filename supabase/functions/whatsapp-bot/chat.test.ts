// Reading a group for alerts (chat.ts readChat), with Claude stubbed and the
// database in memory: what's already open isn't opened again; said again, or
// with a new time, it's updated instead.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { personKey, readChat, type ChatLine } from "./chat.ts";
import { shortId } from "./repeat.ts";
import type { Person, Settings, Team } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude reports this about the chat (the report tool). */
function claudeReports(report: Record<string, unknown>) {
  const asked: { system: unknown; user: string }[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push({ system: b.system, user: b.messages[0].content });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "report", input: { open: [], resolve: [], ...report } }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}

const omar: Person = { id: "omar", name: "Omar", username: "omar", active: true, admin: false };
const t: Team = { people: new Map([[omar.id, omar]]), byPhone: new Map(), byLid: new Map(), others: new Set() };
const s = { model: "claude-haiku-5-5", reply_wait_min: 10, promise_wait_min: 60, follow_wait_min: 120, deadline_enabled: true, follow_enabled: true, cc_admins: false, deadline_before_hours: 24 } as unknown as Settings;
const chat = { source: "whatsapp" as const, col: "chat_id" as const, id: "acme@g.us", name: "Acme" };
const SARA_WAITS = "11111111-0000-4000-8000-000000000001";
const OMAR_PROMISED = "22222222-0000-4000-8000-000000000002";
const hour = 60 * 60_000;
const at = (ms: number) => new Date(ms).toISOString();

function world() {
  const now = Date.now();
  return fakeDb({
    watch_alert: [
      { id: SARA_WAITS, chat_id: chat.id, source: "whatsapp", kind: "unanswered", title: "Sara is waiting for a reply", detail: null, person: "Sara Ahmed", person_key: "c:sara", status: "open", message_id: "m0", due_at: at(now - hour), created_at: at(now - 2 * hour), alerts_sent: 2 },
      { id: OMAR_PROMISED, chat_id: chat.id, source: "whatsapp", kind: "promise", title: "Omar promised the final cut", detail: "The final cut today", person: "Omar", person_key: "t:omar", status: "open", message_id: "m1", due_at: at(now + hour), created_at: at(now - hour), alerts_sent: 0 },
    ],
    watch_recipient: [],
    watch_event: [],
  });
}
const lines = (now = Date.now()): ChatLine[] => [
  { id: "m0", sent_at: at(now - 3 * hour), isNew: false, team: false, name: "Sara Ahmed", who: "c:sara", replyTo: null, text: "Hi, any news on the logo?" },
  { id: "m1", sent_at: at(now - 2 * hour), isNew: false, team: true, name: "Omar", who: "t:omar", replyTo: null, text: "I'll send the final cut today" },
  { id: "m2", sent_at: at(now - 60_000), isNew: true, team: false, name: "سارة", who: "c:sara", replyTo: null, text: "؟؟" },
  { id: "m3", sent_at: at(now - 30_000), isNew: true, team: true, name: "Omar", who: "t:omar", replyTo: null, text: "Tomorrow at 1 for the final cut, sorry" },
];
const opened = (f: ReturnType<typeof world>) => f.tables.watch_alert.filter((a) => ![SARA_WAITS, OMAR_PROMISED].includes(a.id as string));

test("Claude sees the open alerts by stable ids, and who they're about", async () => {
  const asked = claudeReports({});
  await readChat(world().db, s, t, chat, lines(), new Map([[omar.id, omar]]));
  assert.match(asked[0]!.user, new RegExp(`${shortId(SARA_WAITS)}: unanswered; Sara is waiting for a reply; ; about Sara Ahmed`));
  assert.match(asked[0]!.user, new RegExp(`${shortId(OMAR_PROMISED)}: promise; Omar promised the final cut`));
});

test("a client who writes again while waiting, under another name: no second alert", async () => {
  const f = world();
  claudeReports({ open: [{ kind: "unanswered", title: "Sarah is chasing", detail: "Chasing the logo", person: "سارة", for: [], message: 3, priority: "normal" }] });
  const r = await readChat(f.db, s, t, chat, lines(), new Map([[omar.id, omar]]));
  assert.equal(r.opened, 0);
  assert.deepEqual(opened(f), []);
});

test("a promise said again with a new time: the open one moves, nothing new opens", async () => {
  const f = world();
  const tomorrow = Date.now() + 20 * hour;
  claudeReports({ open: [{ kind: "promise", title: "Omar will send the final cut", detail: "The final cut tomorrow at 1", person: "Omar", for: ["Omar"], message: 4, due_at: at(tomorrow), priority: "normal" }] });
  await readChat(f.db, s, t, chat, lines(), new Map([[omar.id, omar]]));
  assert.deepEqual(opened(f), []);
  const p = f.tables.watch_alert.find((a) => a.id === OMAR_PROMISED)!;
  assert.equal(p.due_at, at(tomorrow));
  assert.equal(p.detail, "The final cut tomorrow at 1");
  // Not rung yet: it rings at the new time.
  assert.equal(p.next_alert_at, at(tomorrow));
  assert.equal(f.tables.watch_event.at(-1)!.what, "updated");
});

test("Claude's update, by the alert's id, changes it the same way", async () => {
  const f = world();
  const later = Date.now() + 5 * hour;
  claudeReports({ update: [{ alert: shortId(OMAR_PROMISED), due_at: at(later), detail: "Moved to tonight" }] });
  await readChat(f.db, s, t, chat, lines(), new Map([[omar.id, omar]]));
  const p = f.tables.watch_alert.find((a) => a.id === OMAR_PROMISED)!;
  assert.equal(p.due_at, at(later));
  assert.equal(p.detail, "Moved to tonight");
});

test("something else by the same person opens its own alert, with who it's about", async () => {
  const f = world();
  claudeReports({ open: [{ kind: "follow_up", title: "Waiting on Sara for the brand colours", detail: "Sara said she'd send the colours", person: "Sara", for: [], message: 3, due_at: null, priority: "normal" }] });
  const r = await readChat(f.db, s, t, chat, lines(), new Map([[omar.id, omar]]));
  assert.equal(r.opened, 1);
  assert.equal(opened(f)[0]!.person_key, "c:sara");
});

test("the database refusing a second one (two runs at once, the unique index) isn't an error", async () => {
  const f = fakeDb({ watch_alert: [], watch_recipient: [], watch_event: [] }, { fail: (c) => (c.table === "watch_alert" && c.op === "insert" ? "duplicate key value violates unique constraint" : null) });
  claudeReports({ open: [{ kind: "unanswered", title: "Sara is waiting", detail: "", person: "Sara", for: [], message: 3, priority: "normal" }] });
  const r = await readChat(f.db, s, t, chat, lines(), new Map([[omar.id, omar]]));
  assert.equal(r.opened, 0);
});

test("who an alert is about: the client who wrote, the teammate who promised, else the name", () => {
  const ls = lines();
  const inChat = new Map([[omar.id, omar]]);
  assert.equal(personKey({ kind: "unanswered", person: "Sarah" }, ls[2]!, ls, inChat), "c:sara");
  assert.equal(personKey({ kind: "promise", person: "Omar" }, ls[3]!, ls, inChat), "t:omar");
  // The team asked them: the client named, by a message of theirs here.
  assert.equal(personKey({ kind: "follow_up", person: "Sara Ahmed" }, ls[1]!, ls, inChat), "c:sara");
  assert.equal(personKey({ kind: "follow_up", person: "Karim" }, ls[1]!, ls, inChat), "n:karim");
});
