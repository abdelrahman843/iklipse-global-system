// The check before a client hears the bot (guard.ts): what isn't theirs, isn't
// in their chat and wasn't said by the team doesn't go. And the whole way in a
// private chat (dm.ts readDms), with Claude stubbed and the database in memory:
// a caught reply isn't sent, the team gets it to OK, and the catch is kept.
// Names and numbers are made up.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { forgetClients, guardIssues, type Allowed } from "./guard.ts";
import { fakeDb } from "./test/fake-db.ts";
import { readDms } from "./dm.ts";
import type { Settings, Team } from "./kit.ts";

const sara: Allowed = {
  said: ["Hi, how much is the logo package?", "A client of iklipse: Sara Ahmed from Acme."],
  phone: "201001112223",
  email: "sara@acme.test",
  own: ["Sara Ahmed", "Acme"],
  others: ["Mona Fathy", "Nile Foods"],
};

test("phone numbers: theirs and ones in the chat go; anyone else's doesn't; dates aren't numbers", () => {
  assert.deepEqual(guardIssues("We'll call you on +20 100 111 2223.", sara), []);
  assert.deepEqual(guardIssues("We'll call you on 01001112223.", sara), []);
  assert.deepEqual(guardIssues("Call Rabah on +20 122 333 4444.", sara), ["a phone number (+20 122 333 4444)"]);
  assert.deepEqual(guardIssues("Call on +20 122 333 4444.", { ...sara, said: [...sara.said, "my partner's number is 01223334444"] }), []);
  assert.deepEqual(guardIssues("Booked for Sunday 25-10-2026 at 3:00 PM (Cairo time).", sara), []);
  assert.deepEqual(guardIssues("Booked: https://calendly.com/x/call/2026-10-25T15:00:00+02:00?month=2026-10", sara), []);
});

test("emails: theirs and ones in the chat go; anyone else's doesn't", () => {
  assert.deepEqual(guardIssues("Sent to sara@acme.test.", sara), []);
  assert.deepEqual(guardIssues("Write to rabah@iklipse.test for it.", sara), ["an email (rabah@iklipse.test)"]);
  assert.deepEqual(guardIssues("Sent to Ops@Acme.test.", { ...sara, said: [...sara.said, "cc ops@acme.test please"] }), []);
});

test("prices: only an amount that was said goes", () => {
  assert.deepEqual(guardIssues("The logo package is $500.", sara), ["a price ($500)"]);
  assert.deepEqual(guardIssues("It's 15,000 EGP.", sara), ["a price (15,000 EGP)"]);
  assert.deepEqual(guardIssues("It's 2k dollars.", sara), ["a price (2k dollars)"]);
  assert.deepEqual(guardIssues("الباقة ب 5000 جنيه", sara), ["a price (5000 جنيه)"]);
  // The team said it (an order: "tell Sara it's $500"): it goes.
  assert.deepEqual(guardIssues("The logo package is $500.", { ...sara, said: [...sara.said, "tell Sara the logo package is 500$"] }), []);
  assert.deepEqual(guardIssues("Is $1,500 still OK?", { ...sara, said: [...sara.said, "budget is 1500 USD"] }), []);
  // Plain numbers aren't prices.
  assert.deepEqual(guardIssues("3 drafts, 2 rounds of changes.", sara), []);
});

test("another client's name: caught, unless it's theirs or was said", () => {
  assert.deepEqual(guardIssues("Mona Fathy loved hers too.", sara), ["another client's name (Mona Fathy)"]);
  assert.deepEqual(guardIssues("Like we did for nile foods.", sara), ["another client's name (Nile Foods)"]);
  assert.deepEqual(guardIssues("Acme's logo is ready, Sara Ahmed.", sara), []);
  assert.deepEqual(guardIssues("Mona Fathy loved hers too.", { ...sara, said: [...sara.said, "Mona Fathy sent me to you"] }), []);
  // A part of a word isn't a name.
  assert.deepEqual(guardIssues("Monat Fathyy", sara), []);
});

test("internal words: caught, unless they said them", () => {
  assert.deepEqual(guardIssues("Claude says it's ready.", sara), ["an internal word (Claude)"]);
  assert.deepEqual(guardIssues("It's in our database.", sara), ["an internal word (database)"]);
  assert.deepEqual(guardIssues("Yes, the database is set up.", { ...sara, said: [...sara.said, "is the database ready?"] }), []);
  assert.deepEqual(guardIssues("Your logo is ready.", sara), []);
});

// ------------------------------------------------------- the whole way --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => forgetClients());

/** Claude decides this about the private chat (the decide tool). */
function claudeDecides(input: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decide", input }], usage: {} }), { status: 200 })) as unknown as typeof fetch;
}

const CHAT = "201001112223@c.us";
const TEAM_ASKS = "201000000099@c.us";
const s = { dm_enabled: true, ask_to: "person", ask_phone: "201000000099", ask_group: null, ask_every_min: 30, reply_quiet_sec: 60, reply_max_sec: 300, model: "claude-sonnet-5-5" } as unknown as Settings;
const t: Team = { people: new Map(), byPhone: new Map(), byLid: new Map(), others: new Set() };

function world(text = "Hi, how much is the logo package?") {
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  return fakeDb({
    wa_dm_chat: [{ chat_id: CHAT, phone: "201001112223", name: "Sara", pending_since: old, last_message_at: old, analyzed_at: null, sorry_at: null, away_at: null, claimed_at: null }],
    wa_dm: [{ id: "d1", chat_id: CHAT, from_bot: false, sender_name: "Sara", text, sent_at: old, created_at: old }],
    client: [
      { id: "c1", name: "Sara Ahmed", company: "Acme", name_known: true, phone: "201001112223", email: "sara@acme.test", wa_lid: null, from_chat: null, timezone: null },
      { id: "c2", name: "Mona Fathy", company: "Nile Foods", name_known: true, phone: "201009998887", email: null, wa_lid: null, from_chat: null, timezone: null },
    ],
    bot_draft: [],
    bot_guard_block: [],
  });
}
function sender() {
  const sent: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (sent.push({ chat, text }), `m${sent.length}`);
  return { sent, send };
}

test("a reply with another client's name and a price nobody said doesn't go: they hear we're on it, the team gets it", async () => {
  const f = world();
  const { sent, send } = sender();
  claudeDecides({ action: "reply", text: "The logo package is $500. Mona Fathy took it too." });
  await readDms(f.db, s, t, send, Date.now() + 60_000);
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), ["Checking on that. I'll get back to you."]);
  const toTeam = sent.find((m) => m.chat === TEAM_ASKS)!;
  assert.match(toTeam.text, /I didn't send my reply: it has a price \(\$500\) and another client's name \(Mona Fathy\)/);
  assert.match(toTeam.text, /I'd reply:\n"The logo package is \$500\. Mona Fathy took it too\."/);
  assert.equal(f.tables.bot_draft.length, 1);
  assert.equal(f.tables.bot_draft[0]!.draft, "The logo package is $500. Mona Fathy took it too.");
  assert.equal(f.tables.bot_guard_block.length, 1);
  assert.equal(f.tables.bot_guard_block[0]!.where_from, "dm.reply");
  assert.deepEqual(f.tables.bot_guard_block[0]!.reasons, ["a price ($500)", "another client's name (Mona Fathy)"]);
});

test("a reply with only what's theirs goes as it is", async () => {
  const f = world("Is it still $500 like you said?");
  const { sent, send } = sender();
  claudeDecides({ action: "reply", text: "Yes, still $500, Sara." });
  await readDms(f.db, s, t, send, Date.now() + 60_000);
  assert.deepEqual(sent, [{ chat: CHAT, text: "Yes, still $500, Sara." }]);
  assert.equal(f.tables.bot_draft.length, 0);
  assert.equal(f.tables.bot_guard_block.length, 0);
});

test("asking the team: a hold line with something caught becomes the plain one", async () => {
  const f = world();
  const { sent, send } = sender();
  claudeDecides({ action: "ask_team", text: "Checking with Rabah on +20 122 333 4444 now.", question: "She asks the price of the logo package.", draft: "" });
  await readDms(f.db, s, t, send, Date.now() + 60_000);
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), ["Checking on that. I'll get back to you."]);
  assert.equal(f.tables.bot_guard_block[0]!.where_from, "dm.hold");
});
