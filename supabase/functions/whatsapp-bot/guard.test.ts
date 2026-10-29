// The check before a client hears the bot (guard.ts): what isn't theirs, isn't
// in their chat and wasn't said by the team doesn't go. And the whole way in a
// private chat (dm.ts readDms), with Claude stubbed and the database in memory:
// a caught reply isn't sent, the team gets it to OK, and the catch is kept.
// Names and numbers are made up.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { forgetClients, guardIssues, otherClients, type Allowed } from "./guard.ts";
import { fakeDb } from "./test/fake-db.ts";
import { askAgain, decideDraft, draftFor, readDms, remindDrafts } from "./dm.ts";
import { EDIT_NOTE, editOf } from "./keep.ts";
import { firstTime } from "./people.ts";
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

test("Arabic-Indic and Persian digits are numbers like any other, in what's written and in what was said", () => {
  assert.deepEqual(guardIssues("الباقة ب ٥٠٠٠ جنيه", sara), ["a price (5000 جنيه)"]);
  assert.deepEqual(guardIssues("Call Rabah on ٠١٢٢٣٣٣٤٤٤٤.", sara), ["a phone number (01223334444)"]);
  assert.deepEqual(guardIssues("Call Rabah on ۰۱۲۲۳۳۳۴۴۴۴.", sara), ["a phone number (01223334444)"]);
  assert.deepEqual(guardIssues("We'll call you on ٠١٠٠١١١٢٢٢٣.", sara), []);
  assert.deepEqual(guardIssues("Yes, 5000 EGP as you said.", { ...sara, said: [...sara.said, "يعني ٥٠٠٠ جنيه؟"] }), []);
});

test("prices: pounds and dollars however they're written, and an amount right after a word for what it costs", () => {
  for (const [text, found] of [
    ["It's 5000 ج.م", "5000 ج.م"],
    ["It's EGP5000.", "EGP5000"],
    ["It's 5000LE.", "5000LE"],
    ["It's 5000 L.E. in total.", "5000 L.E"],
    ["It's $500.", "$500"],
    ["It's 500 دولار", "500 دولار"],
    ["The price 5000 covers it.", "price 5000"],
    ["The price is 5,000.", "price is 5,000"],
    ["It costs 7000 in all.", "costs 7000"],
    ["السعر ٥٠٠٠", "سعر 5000"],
  ]) {
    assert.deepEqual(guardIssues(text!, sara), [`a price (${found})`], text);
  }
  // Plain numbers still aren't prices, nor a word that only starts like a currency.
  assert.deepEqual(guardIssues("3 drafts, 2 rounds of changes, 5 levels.", sara), []);
  assert.deepEqual(guardIssues("هي 5 جمل بس", sara), []);
});

test("another client's name: an empty or partial name of theirs exempts nothing; the Arabic spelling, however it's written", () => {
  const a = { ...sara, others: ["Mona Fathy", "Rana", "منى فتحي"] };
  assert.deepEqual(guardIssues("Rana loved hers too.", a), ["another client's name (Rana)"]);
  assert.deepEqual(guardIssues("Ranaa and Branable", a), []);
  assert.deepEqual(guardIssues("Rana loved hers too.", { ...a, own: ["Ran", "Acme"] }), ["another client's name (Rana)"]);
  assert.deepEqual(guardIssues("Mona Fathy loved hers too.", { ...sara, own: ["", " "] }), ["another client's name (Mona Fathy)"]);
  // A whole name of theirs still does: her own first name is another client's one-word name.
  assert.deepEqual(guardIssues("Hi Sara!", { ...sara, others: ["Sara"] }), []);
  assert.deepEqual(guardIssues("زي ما عملنا لمنى فتحى بالظبط", a), ["another client's name (منى فتحي)"]);
  assert.deepEqual(guardIssues("Like we did for منى فتحي.", { ...a, said: [...a.said, "مني فتحى قالتلي عليكم"] }), []);
});

test("other clients: one-word names of 3 letters or more, and the Arabic name WhatsApp shows for one kept in English", async () => {
  forgetClients();
  const f = fakeDb({
    client: [
      { id: "c1", name: "Sara Ahmed", company: "Acme", name_known: true, phone: "201001112223" },
      { id: "c2", name: "Mona Fathy", company: null, name_known: true, phone: "+20 100 999 8887" },
      { id: "c3", name: "Rana", company: "Nil", name_known: true, phone: null },
      { id: "c4", name: "Al", company: null, name_known: true, phone: null },
      { id: "c5", name: "+201005556667", company: null, name_known: false, phone: "201005556667" },
    ],
    wa_dm_chat: [
      { chat_id: "201009998887@c.us", phone: "201009998887", name: "منى فتحي" },
      { chat_id: "201005556667@c.us", phone: "201005556667", name: "هالة" },
    ],
    wa_participant: [
      { chat_id: "acme@g.us", phone: "201009998887", name: "Mona 🌸" },
      { chat_id: "acme@g.us", phone: "201001112223", name: "سارة" },
    ],
  });
  assert.deepEqual((await otherClients(f.db, "c1")).sort(), ["Mona Fathy", "Rana", "منى فتحي"].sort());
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
const s = { dm_enabled: true, ask_phones: ["201000000099"], ask_group: null, ask_every_min: 30, reply_quiet_sec: 60, reply_max_sec: 300, model: "claude-sonnet-5-5" } as unknown as Settings;
const t: Team = { people: new Map(), byPhone: new Map(), byLid: new Map(), others: new Set() };

function world(text = "Hi, how much is the logo package?") {
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  return fakeDb({
    wa_dm_chat: [{ chat_id: CHAT, phone: "201001112223", name: "Sara", pending_since: old, last_message_at: old, analyzed_at: null, sorry_at: null, away_at: null, claimed_at: null }],
    wa_dm: [{ id: "d1", chat_id: CHAT, from_bot: false, sender_name: "Sara", text, sent_at: old, created_at: old }],
    client: [
      { id: "c1", name: "Sara Ahmed", company: "Acme", name_known: true, phone: "201001112223", phone_key: "201001112223", email: "sara@acme.test", wa_lid: null, from_chat: null, timezone: null },
      { id: "c2", name: "Mona Fathy", company: "Nile Foods", name_known: true, phone: "201009998887", phone_key: "201009998887", email: null, wa_lid: null, from_chat: null, timezone: null },
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
  assert.match(toTeam.text, /I'd reply:\n"The logo package is \$500\. Mona Fathy took it too\."\n\nReply with "send anyway" to send it as it is/);
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

// ------------------------------------------------- drafts for the team --

const RISKY = "It's 7000 EGP, like Mona Fathy paid.";

test("asking the team: the reply it'd send is checked too; caught, the team sees why, and is told a plain OK won't do", async () => {
  const f = world();
  const { sent, send } = sender();
  claudeDecides({ action: "ask_team", text: "", question: "She asks the price of the logo package.", draft: RISKY });
  await readDms(f.db, s, t, send, Date.now() + 60_000);
  const toTeam = sent.find((m) => m.chat === TEAM_ASKS)!;
  assert.match(toTeam.text, /My reply has a price \(7000 EGP\) and another client's name \(Mona Fathy\), which isn't theirs or in their chat\./);
  assert.match(toTeam.text, /I'd reply:\n"It's 7000 EGP, like Mona Fathy paid\."/);
  assert.match(toTeam.text, /Reply with "send anyway" to send it as it is, what to tell them instead, or what to do\./);
  assert.doesNotMatch(toTeam.text, /OK to send it/);
  assert.equal(f.tables.bot_guard_block[0]!.where_from, "dm.draft");
});

test("with the agent on for clients (stuck.ts): its draft is checked before the team sees it, and nothing the team taught is in the client's calls", async () => {
  const f = world();
  const { sent, send } = sender();
  const taught = { ...s, taught: "What the team taught you...\n- Nile Foods is late paying us." } as Settings;
  const systems: string[] = [];
  let turn = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { system: { text: string }[]; tools?: { name: string }[] };
    systems.push(body.system.map((b) => b.text).join("\n"));
    const tools = (body.tools ?? []).map((x) => x.name);
    const content = tools.includes("decide")
      ? [{ type: "tool_use", id: "d", name: "decide", input: { action: "ask_team", text: "", question: "She asks the price.", draft: "" } }]
      : turn++ === 0
        ? [{ type: "tool_use", id: "a1", name: "message_client", input: { client: "c1", text: RISKY } }]
        : [{ type: "tool_use", id: "a2", name: "finish", input: { status: "done", text: "Her project is the logo package." } }];
    return new Response(JSON.stringify({ content, usage: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const realGet = Deno.env.get;
  Deno.env.get = (k: string) => (k === "BOT_AGENT" ? "on" : realGet(k));
  try {
    await readDms(f.db, taught, t, send, Date.now() + 60_000);
  } finally {
    Deno.env.get = realGet;
  }
  const toTeam = sent.find((m) => m.chat === TEAM_ASKS)!;
  assert.match(toTeam.text, /What I found: Her project is the logo package\./);
  assert.match(toTeam.text, /My reply has a price \(7000 EGP\) and another client's name \(Mona Fathy\)/);
  assert.match(toTeam.text, /I'd reply:\n"It's 7000 EGP, like Mona Fathy paid\."\n\nReply with "send anyway"/);
  assert.equal(systems.length, 3);
  assert.ok(systems.every((x) => !x.includes("late paying")));
});

/** The team's answer, as Claude reads it (the decision tool). */
function claudeSays(input: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decision", input }], usage: {} }), { status: 200 })) as unknown as typeof fetch;
}
function waiting(f: ReturnType<typeof world>, draft: string) {
  f.tables.bot_draft!.push({ id: "b1", chat_id: CHAT, to_name: "Sara Ahmed (Acme)", asked: "How much is it?", draft, question: "She asks the price.", ask_ids: ["m1"], ask_chat: TEAM_ASKS, times: 1, status: "waiting", created_at: new Date().toISOString() });
  return f.tables.bot_draft![0] as unknown as Parameters<typeof decideDraft>[2];
}

test("the team's plain OK doesn't send a reply the guard catches; \"send anyway\" does", async () => {
  const f = world();
  const d = waiting(f, RISKY);
  const { sent, send } = sender();
  claudeSays({ decision: "send" });
  assert.equal(await decideDraft(f.db, s, d, { id: "t1", chatId: TEAM_ASKS, text: "ok" }, send, async () => {}), true);
  assert.deepEqual(sent.filter((m) => m.chat === CHAT), []);
  assert.match(sent[0]!.text, /I didn't send it: my reply has a price \(7000 EGP\) and another client's name \(Mona Fathy\), which isn't theirs or in their chat\./);
  assert.match(sent[0]!.text, /Say "send anyway" to send it as it is/);
  assert.equal(f.tables.bot_draft![0]!.status, "waiting");
  assert.equal(f.tables.bot_guard_block!.at(-1)!.where_from, "dm.ok");

  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, d, { id: "t2", chatId: TEAM_ASKS, text: "send anyway" }, send, async () => {});
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), [RISKY]);
  assert.equal(f.tables.bot_draft![0]!.status, "sent");
});

test("a reply with nothing caught goes on a plain OK, as before", async () => {
  const f = world();
  const d = waiting(f, "Your logo is ready, Sara.");
  const { sent, send } = sender();
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, d, { id: "t1", chatId: TEAM_ASKS, text: "ok" }, send, async () => {});
  assert.deepEqual(sent.map((m) => m.text), ["Your logo is ready, Sara.", "Sent to Sara Ahmed (Acme)."]);
  assert.equal(f.tables.bot_guard_block!.length, 0);
});

const TEAM_GROUP = "120363000000000001@g.us";

test("in the team's group, the answer to \"I didn't send it\" is a reply to it: it counts as the answer, and \"send anyway\" sends", async () => {
  const f = world();
  const d = waiting(f, RISKY);
  Object.assign(d, { ask_chat: TEAM_GROUP, ask_ids: ["a1"] });
  const { sent, send } = sender();
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, d, { id: "t1", chatId: TEAM_GROUP, text: "ok" }, send, async () => {});
  assert.match(sent[0]!.text, /Reply to this message with "send anyway" to send it as it is/);
  assert.deepEqual(f.tables.bot_draft![0]!.ask_ids, ["a1", "m1"]);
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, d, { id: "t2", chatId: TEAM_GROUP, text: "send anyway" }, send, async () => {});
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), [RISKY]);
});

/** An edit of a message (keep.ts), as Green API sends it. */
const edited = (stanzaId: string, textMessage: string) => ({ typeMessage: "editedMessage", editedMessageData: { textMessage, stanzaId } });
const OMAR = { sender: "201000000003@c.us", phone: "201000000003" };
const crew = async (): Promise<Team> => ({ ...t, byPhone: new Map([[OMAR.phone, { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false }]]) });

test("an OK the guard caught, edited into \"send anyway\": that's the answer now, and the reply goes once; no \"I'd already acted on this\"", async () => {
  const f = world();
  const d = waiting(f, RISKY);
  Object.assign(d, { ask_chat: TEAM_GROUP, ask_ids: ["a1"] });
  // Omar's plain OK in the team group, a reply to the bot's question (index.ts fromTeam marked it, once per message).
  Object.assign(f.tables, {
    wa_group: [{ chat_id: TEAM_GROUP, kind: "team" }],
    wa_message: [{ id: "ok-1", chat_id: TEAM_GROUP, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "ok", quoted_id: "a1" }],
    bot_heard: [{ id: "ok-1" }],
    wa_bot_turn: [],
  });
  const { sent, send } = sender();
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, d, { id: "ok-1", chatId: TEAM_GROUP, text: "ok" }, send, async () => {});
  // Not sent: the bot says so, quoting the OK (kept as sendAs keeps it).
  assert.match(sent[0]!.text, /^I didn't send it: .* Reply to this message with "send anyway"/);
  f.tables.wa_message!.push({ id: "m1", chat_id: TEAM_GROUP, from_bot: true, text: sent[0]!.text, quoted_id: "ok-1" });

  // He edits the OK into "send anyway": the answer to the question still waiting, once, by the edit's own id.
  const edit = { md: edited("ok-1", "send anyway"), chatId: TEAM_GROUP, text: "send anyway (edited)", mine: false, own: "edit-1", team: crew };
  const e = (await editOf(f.db, edit))!;
  assert.deepEqual([e.done, e.note, e.answers], [true, null, { chatId: TEAM_GROUP, quotedId: "a1", phone: OMAR.phone, lid: null, once: "ok-1:edit:edit-1" }]);
  // As index.ts fromTeam takes it: by that mark (the OK's is taken), the question it answers, then the decision.
  const a = e.answers!;
  assert.equal(await firstTime(f.db, "ok-1"), false);
  assert.equal(await firstTime(f.db, a.once), true);
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, (await draftFor(f.db, a.chatId, a.quotedId))!, { id: e.id, chatId: a.chatId, text: e.text }, send, async () => {});
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), [RISKY]);
  assert.equal(sent.at(-1)!.text, "Sent to Sara Ahmed (Acme).");
  assert.equal(f.tables.bot_draft![0]!.status, "sent");

  // The same edit again: nothing. Edited once more: the reply went already, so it isn't sent again, and he's told so.
  assert.deepEqual(await editOf(f.db, edit), { id: "ok-1", text: "send anyway (edited)", quotedId: "a1", done: true, note: null, answers: null });
  const more = (await editOf(f.db, { ...edit, md: edited("ok-1", "send anyway!"), text: "send anyway! (edited)", own: "edit-2" }))!;
  assert.deepEqual([more.note, more.answers], [EDIT_NOTE, null]);
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), [RISKY]);
});

test("privately too: the person the bot asks edits their OK into \"send anyway\", and the reply goes once", async () => {
  const f = world();
  const d = waiting(f, RISKY);
  Object.assign(d, { ask_ids: ["a1"] });
  // Their plain OK, not a reply to anything (index.ts fromTeam marked it).
  f.tables.wa_dm!.push({ id: "ok-1", chat_id: TEAM_ASKS, from_bot: false, text: "ok", quoted_id: null });
  Object.assign(f.tables, { bot_heard: [{ id: "ok-1" }], wa_bot_turn: [] });
  const { sent, send } = sender();
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, d, { id: "ok-1", chatId: TEAM_ASKS, text: "ok" }, send, async () => {});
  assert.match(sent[0]!.text, /^I didn't send it: .* Say "send anyway"/);
  f.tables.wa_dm!.push({ id: "m1", chat_id: TEAM_ASKS, from_bot: true, text: sent[0]!.text, quoted_id: "ok-1" });
  // The question it answers: the bot's answer to it is one of the question's messages.
  const edit = { md: edited("ok-1", "send anyway"), chatId: TEAM_ASKS, text: "send anyway (edited)", mine: false, own: "edit-1" };
  const a = (await editOf(f.db, edit))!.answers!;
  assert.deepEqual(a, { chatId: TEAM_ASKS, quotedId: "m1", phone: null, lid: null, once: "ok-1:edit:edit-1" });
  // An edit with the id of the one it changes (Green API may send it so): once per its words.
  assert.equal((await editOf(f.db, { ...edit, own: "ok-1" }))?.answers?.once, "ok-1:edit:send anyway (edited)");
  claudeSays({ decision: "send" });
  await decideDraft(f.db, s, (await draftFor(f.db, a.chatId, a.quotedId))!, { id: "ok-1", chatId: a.chatId, text: edit.text }, send, async () => {});
  assert.deepEqual(sent.filter((m) => m.chat === CHAT).map((m) => m.text), [RISKY]);
  // Edited again: the question isn't waiting any more, so nothing more goes.
  assert.equal((await editOf(f.db, { ...edit, md: edited("ok-1", "send anyway now"), text: "send anyway now (edited)", own: "edit-2" }))?.answers, null);
});

test("still waiting: a reply the guard catches is asked about with \"send anyway\", one it doesn't with OK", async () => {
  for (const [draft, ok] of [
    [RISKY, `"send anyway"`],
    ["Your logo is ready, Sara.", "OK"],
  ]) {
    const f = world();
    const d = waiting(f, draft!);
    Object.assign(d, { ask_chat: TEAM_GROUP, next_at: new Date(Date.now() - 60_000).toISOString() });
    const { sent, send } = sender();
    assert.equal(await remindDrafts(f.db, s, send), 1);
    assert.equal(sent[0]!.text, `Sara Ahmed (Acme) is still waiting. Say ${ok} to send my reply, what to tell them instead, or what to do.`);
    assert.equal(f.tables.bot_guard_block!.length, 0);
  }
});

test("several people asked: each gets the question privately, any of them answers it, and each is reminded", async () => {
  const SECOND = "201000000088@c.us";
  const two = { ...s, ask_phones: ["201000000099", "201000000088"] } as Settings;
  const f = world();
  const { sent, send } = sender();
  claudeDecides({ action: "reply", text: "The logo package is $500. Mona Fathy took it too." });
  await readDms(f.db, two, t, send, Date.now() + 60_000);
  assert.deepEqual(sent.filter((m) => m.chat !== CHAT).map((m) => m.chat), [TEAM_ASKS, SECOND]);
  assert.equal(f.tables.bot_draft.length, 1);
  assert.deepEqual(f.tables.bot_draft[0]!.ask_chats, [TEAM_ASKS, SECOND]);
  assert.equal((f.tables.bot_draft[0]!.ask_ids as string[]).length, 2);
  f.tables.bot_draft[0]!.status = "waiting"; // the table's default
  // The second one answers in their private chat, not replying to anything.
  assert.equal((await draftFor(f.db, SECOND, null))?.id, f.tables.bot_draft[0]!.id);

  // The asks went out (WhatsApp shows them), and it's time to remind.
  for (const id of f.tables.bot_draft[0]!.ask_ids as string[]) f.tables.wa_dm.push({ id, chat_id: SECOND, from_bot: true });
  Object.assign(f.tables.bot_draft[0]!, { created_at: new Date().toISOString(), next_at: new Date(Date.now() - 60_000).toISOString() });
  const later = sender();
  assert.equal(await remindDrafts(f.db, two, later.send), 1);
  assert.deepEqual(later.sent.map((m) => m.chat), [TEAM_ASKS, SECOND]);
  assert.equal((f.tables.bot_draft[0]!.ask_ids as string[]).length, 4);
});

test("the team's answer isn't clear: for a reply the guard catches, a plain OK won't send it and \"send anyway\" will; one it doesn't, OK sends it", async () => {
  for (const [draft, ok] of [
    [RISKY, `A plain OK won't send my reply: "send anyway" sends it as it is. `],
    ["Your logo is ready, Sara.", "OK sends my reply. "],
    ["", ""],
  ]) {
    const f = world();
    const d = waiting(f, draft!);
    assert.equal(await askAgain(f.db, d), `What should I tell Sara Ahmed (Acme), or do? ${ok}"No" leaves it.`);
    assert.equal(f.tables.bot_guard_block!.length, 0);
  }
  // index.ts (it serves, so its source is read): fromTeam says that, not its own "OK sends my reply".
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  assert.match(index, /if \(await decideDraft\(db, s, d, o, send, order\)\) return true;\s*if \(o\.quotedId\) \{\s*await send\(o\.chatId, await askAgain\(db, d\), o\.id\);/);
  assert.doesNotMatch(index, /OK sends my reply/);
});

test("another client's name: a name of theirs that's only a part of it exempts nothing", () => {
  const mona = { ...sara, own: ["Mona", "Mona (+201000000001)"], others: ["Mona Fathy", "Rana"] };
  assert.deepEqual(guardIssues("Mona Fathy loved hers too.", mona), ["another client's name (Mona Fathy)"]);
  // The other way round it does: "Rana" is a whole name inside "Rana Test", theirs.
  assert.deepEqual(guardIssues("Hi Rana!", { ...mona, own: ["Rana Test"] }), []);
});

test("prices: ج.م is a currency only on its own, not the end of an Arabic word", () => {
  assert.deepEqual(guardIssues("حجم 5 ميجا بس", sara), []);
  assert.deepEqual(guardIssues("It's 5000ج.م", sara), ["a price (5000ج.م)"]);
});
