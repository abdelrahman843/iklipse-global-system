// Email alerts across mailboxes (mail.ts readThread), with Gmail and Claude
// stubbed and the database in memory: another mailbox's copy of the same
// conversation is found by the email chain (Message-ID, In-Reply-To,
// References), even after a follow-up, and keeps a second one from opening,
// but its owner is never added to it; another mailbox's alert about anything
// else is never matched: each owner keeps their own.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { readThread, type Account, type People } from "./mail.ts";
import type { Person, Settings } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const omar: Person = { id: "omar", name: "Omar", username: "omar", active: true, admin: false };
const mona: Person = { id: "mona", name: "Mona", username: "mona", active: true, admin: false };
const box = (id: string, email: string, user: string): Account => ({ id, user_id: user, email, name: null, access_token: "tok", refresh_token: "r", token_expiry: new Date(Date.now() + 3_600_000).toISOString() });
const omarBox = box("m-omar", "omar@iklipse.test", "omar");
const monaBox = box("m-mona", "mona@iklipse.test", "mona");
const who: People = {
  team: new Map([
    ["omar@iklipse.test", omar],
    ["mona@iklipse.test", mona],
  ]),
  teamDomains: new Set(["iklipse.test"]),
  clients: new Map([["tom@lumio.test", "Tom, Lumio"]]),
  clientDomains: new Map(),
};
const s = { model: "claude-haiku-5-5", mail_clients: true, mail_ads: true, mail_reply_wait_min: 60, follow_enabled: true, follow_wait_min: 120, promise_wait_min: 60, deadline_enabled: true, deadline_before_hours: 24 } as unknown as Settings;
const b64 = (t: string) => btoa(t).replace(/\+/g, "-").replace(/\//g, "_");

interface Mail {
  id: string;
  key: string;
  replyTo?: string;
  text: string;
  ago: number;
}
/** An email from Tom to Omar and Mona, as Gmail gives it. */
const gmail = (thread: string, m: Mail) => ({
  id: `${thread}-${m.id}`,
  threadId: thread,
  labelIds: ["INBOX"],
  internalDate: String(Date.now() - m.ago),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Tom <tom@lumio.test>" },
      { name: "To", value: "omar@iklipse.test, mona@iklipse.test" },
      { name: "Subject", value: "The revised cut" },
      { name: "Message-ID", value: `<${m.key}>` },
      ...(m.replyTo ? [{ name: "In-Reply-To", value: `<${m.replyTo}>` }, { name: "References", value: `<${m.replyTo}>` }] : []),
    ],
    body: { data: b64(m.text) },
  },
});

/** Gmail has these conversations (by thread id); Claude says what opens in the one just read (about its newest email). */
function stubs(threads: Record<string, Mail[]>, open: (thread: string, newest: number) => Record<string, unknown>) {
  let read = "";
  globalThis.fetch = (async (url: string) => {
    if (url.startsWith("https://api.anthropic.com")) {
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "report", input: { category: "client", open: [open(read, threads[read]!.length)], resolve: [] } }], usage: {} }), { status: 200 });
    }
    read = /threads\/([^?]+)/.exec(url)![1]!;
    return new Response(JSON.stringify({ id: read, messages: threads[read]!.map((m) => gmail(read, m)) }), { status: 200 });
  }) as typeof fetch;
}

const row = (account: string, thread: string) => ({ account_id: account, thread_id: thread, analyzed_at: null, created_at: new Date().toISOString() });
const waiting = (_: string, newest: number) => ({ kind: "unanswered", title: "Tom is waiting for the revised cut", detail: "He asks when the revised cut comes", person: "Tom (Lumio)", message: newest, priority: "normal" });
const world = () => fakeDb({ watch_alert: [], watch_recipient: [], watch_event: [], mail_message: [], mail_thread: [] });
const ringsFor = (f: ReturnType<typeof world>, alert: unknown) => [...new Set(f.tables.watch_recipient.filter((r) => r.alert_id === alert).map((r) => r.user_id))].sort();

const FIRST: Mail = { id: "1", key: "caf1@mail.lumio.test", text: "Hi both, when can we expect the revised cut?", ago: 3 * 3_600_000 };
const AGAIN: Mail = { id: "2", key: "caf2@mail.lumio.test", replyTo: FIRST.key, text: "Any news on the revised cut?", ago: 60_000 };

test("a follow-up that reached the second mailbox alone: the first email is in its References, so it's the one alert, still only its owner's", async () => {
  // Omar has the whole conversation; Mona was only on the follow-up (Gmail gives her just that email).
  stubs({ "t-omar": [FIRST], "t-mona": [AGAIN] }, waiting);
  const f = world();
  assert.equal((await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"))).opened, 1);
  assert.equal((await readThread(f.db, s, monaBox, mona, who, row("m-mona", "t-mona"))).opened, 0);
  assert.equal(f.tables.watch_alert.length, 1);
  assert.deepEqual(ringsFor(f, f.tables.watch_alert[0]!.id), ["omar"]);
  assert.ok(!f.tables.watch_event.some((e) => /Also in Mona's mailbox/.test(String(e.detail))));
});

test("the second mailbox reading the conversation again after a follow-up: no second waiting alert", async () => {
  const threads: Record<string, Mail[]> = { "t-omar": [FIRST], "t-mona": [FIRST] };
  stubs(threads, waiting);
  const f = world();
  await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"));
  await readThread(f.db, s, monaBox, mona, who, row("m-mona", "t-mona"));
  assert.equal(f.tables.watch_alert.length, 1);
  // Tom chases; Mona's mailbox reads it first, and Claude says the follow-up is what waits.
  threads["t-mona"] = [FIRST, AGAIN];
  const again = await readThread(f.db, s, monaBox, mona, who, { ...row("m-mona", "t-mona"), analyzed_at: new Date(Date.now() - 30 * 60_000).toISOString() });
  assert.equal(again.opened, 0);
  assert.equal(f.tables.watch_alert.length, 1);
  assert.deepEqual(ringsFor(f, f.tables.watch_alert[0]!.id), ["omar"]);
});

test("a promise said again in another mailbox's copy of the conversation: no second one, and the first mailbox's alert isn't changed or shared", async () => {
  const promised = (_: string, newest: number) => ({ kind: "promise", title: "Send Tom the revised cut", detail: newest > 1 ? "Moved by Mona" : "The revised cut", person: "Omar", message: newest, due_at: null, priority: "normal" });
  stubs({ "t-omar": [FIRST], "t-mona": [FIRST, AGAIN] }, promised);
  const f = world();
  assert.equal((await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"))).opened, 1);
  const before = { ...f.tables.watch_alert[0]! };
  assert.equal((await readThread(f.db, s, monaBox, mona, who, row("m-mona", "t-mona"))).opened, 0);
  assert.equal(f.tables.watch_alert.length, 1);
  assert.deepEqual(f.tables.watch_alert[0], before);
  assert.deepEqual(ringsFor(f, before.id), ["omar"]);
});

test("another mailbox's alert about the same person and matter, in another conversation: not joined, each owner keeps their own", async () => {
  const OMARS: Mail = { id: "1", key: "lumio-a@mail.lumio.test", text: "I'll send the logo files to Omar this week", ago: 3_600_000 };
  const MONAS: Mail = { id: "1", key: "lumio-b@mail.lumio.test", text: "Mona, the logo files are coming this week", ago: 60_000 };
  const OMARS_NEXT: Mail = { id: "1", key: "lumio-c@mail.lumio.test", text: "Omar, still on the logo files this week", ago: 30_000 };
  const waitOn = (_: string, newest: number) => ({ kind: "follow_up", title: "Waiting on Tom for the logo files", detail: "Tom said he'd send the logo files", person: "Tom (Lumio)", message: newest, priority: "normal" });
  stubs({ "t-omar": [OMARS], "t-mona": [MONAS], "t-omar-2": [OMARS_NEXT] }, waitOn);
  const f = world();
  await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"));
  assert.equal((await readThread(f.db, s, monaBox, mona, who, row("m-mona", "t-mona"))).opened, 1);
  assert.equal(f.tables.watch_alert.length, 2);
  const [o, m] = f.tables.watch_alert;
  assert.equal(o!.mail_account, "m-omar");
  assert.equal(m!.mail_account, "m-mona");
  assert.deepEqual(ringsFor(f, o!.id), ["omar"]);
  assert.deepEqual(ringsFor(f, m!.id), ["mona"]);
  // In the same mailbox, another conversation about the same thing is still the one alert.
  assert.equal((await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar-2"))).opened, 0);
  assert.equal(f.tables.watch_alert.length, 2);
  assert.deepEqual(ringsFor(f, o!.id), ["omar"]);
});
