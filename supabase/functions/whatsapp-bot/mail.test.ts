// Email alerts (mail.ts readThread), with Gmail and Claude stubbed and the
// database in memory: one client email that reached two team members'
// mailboxes is one alert, not one per mailbox, and it stays its mailbox
// owner's: the other owner is never added to it.

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

/** Gmail has the same email in each mailbox (its own ids there, the same Message-ID); Claude says it's waiting for a reply. */
function stubs() {
  const claude: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://api.anthropic.com")) {
      claude.push(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "report", input: { category: "client", open: [{ kind: "unanswered", title: "Tom is waiting for the revised cut", detail: "He asks when the revised cut comes", person: "Tom (Lumio)", message: 1, priority: "normal" }], resolve: [] } }],
          usage: {},
        }),
        { status: 200 },
      );
    }
    const thread = /threads\/([^?]+)/.exec(url)![1]!;
    return new Response(
      JSON.stringify({
        id: thread,
        messages: [
          {
            id: `g-${thread}`,
            threadId: thread,
            labelIds: ["INBOX"],
            internalDate: String(Date.now() - 60_000),
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "Tom <tom@lumio.test>" },
                { name: "To", value: "omar@iklipse.test, mona@iklipse.test" },
                { name: "Subject", value: "The revised cut" },
                { name: "Message-ID", value: "<CAF123@mail.lumio.test>" },
              ],
              body: { data: b64("Hi both, when can we expect the revised cut?") },
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return claude;
}

const row = (account: string, thread: string) => ({ account_id: account, thread_id: thread, analyzed_at: null, created_at: new Date().toISOString() });

test("the same client email in two mailboxes: one alert, and it rings only its own mailbox's owner", async () => {
  stubs();
  const f = fakeDb({ watch_alert: [], watch_recipient: [], watch_event: [], mail_message: [], mail_thread: [] });
  const first = await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"));
  assert.equal(first.opened, 1);
  const second = await readThread(f.db, s, monaBox, mona, who, row("m-mona", "t-mona"));
  assert.equal(second.opened, 0);

  assert.equal(f.tables.watch_alert.length, 1);
  const a = f.tables.watch_alert[0]!;
  assert.equal(a.mail_key, "caf123@mail.lumio.test");
  assert.equal(a.person_key, "e:tom@lumio.test");
  assert.deepEqual(f.tables.watch_recipient.map((r) => r.user_id), ["omar"]);
  assert.ok(!f.tables.watch_event.some((e) => /Also in Mona's mailbox/.test(String(e.detail))));
});

test("read again in the same mailbox: still the one alert, and Claude is shown it by its id", async () => {
  const claude = stubs();
  const f = fakeDb({ watch_alert: [], watch_recipient: [], watch_event: [], mail_message: [], mail_thread: [] });
  await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"));
  await readThread(f.db, s, omarBox, omar, who, row("m-omar", "t-omar"));
  assert.equal(f.tables.watch_alert.length, 1);
  assert.match(claude.at(-1)!, /Open alerts:\\nA\w+: unanswered; Tom is waiting for the revised cut/);
});
