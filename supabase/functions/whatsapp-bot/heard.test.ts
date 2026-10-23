// Meeting conversations in a group (book.ts heard): only the person the bot
// is talking with carries one on, by replying to the bot's message or, with
// no quote and in a team group, by answering what it asked them in the last
// 5 minutes. Anyone else in the group never does, and a mention or the bot's
// name first is a new message for the router, not an answer. An answer with
// no quote may be for the others (book.ts answer): Claude is told, and when
// nothing could be made of it, nothing is said back.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { answer, BOOK_SYSTEM, heard } from "./book.ts";
import { iso, MIN, type Settings } from "./kit.ts";

const GROUP = "team@g.us";
const BOT = "15555550100";
const SARA = "15555550101";
const OMAR = "15555550102";

/** A team group where Sara asked the bot for a meeting, and the bot asked her something (ago: how long ago). */
function world(ago: number, botSaid = "Which day?") {
  return fakeDb({
    watch_settings: [{ id: 1, book_enabled: true, bot_phone: BOT }],
    wa_participant: [],
    profile: [
      { id: "u-sara", is_active: true },
      { id: "u-omar", is_active: true },
    ],
    profile_contact: [
      { user_id: "u-sara", whatsapp: SARA },
      { user_id: "u-omar", whatsapp: OMAR },
    ],
    wa_member: [],
    wa_bot_thread: [{ id: "th-sara", chat_id: GROUP, chat_name: "Team", started_by: "u-sara", state: {} }],
    wa_bot_turn: [
      { id: "t-sara", thread_id: "th-sara", chat_id: GROUP, from_bot: false, user_id: "u-sara", text: "@iklipse book a call with Rabah", status: "done", created_at: iso(Date.now() - ago - MIN) },
      { id: "t-bot", thread_id: "th-sara", chat_id: GROUP, from_bot: true, user_id: null, text: botSaid, status: "done", created_at: iso(Date.now() - ago) },
    ],
  });
}

/** A message in the group from this number. */
const from = (phone: string, id: string, text: string, quotedId: string | null = null, teamGroup = true) => ({
  id,
  chatId: GROUP,
  chatName: "Team",
  teamGroup,
  text,
  quoted: quotedId ? "(the message it replies to)" : null,
  quotedId,
  sender: `${phone}@c.us`,
  phone: async () => phone,
  botPhone: BOT,
});

const kept = (f: ReturnType<typeof world>, id: string) => f.tables.wa_bot_turn.find((t) => t.id === id);

test("the person it's with replies to the bot's message: carried on", async () => {
  const f = world(30 * MIN);
  assert.equal(await heard(f.db, from(SARA, "m-1", "Sunday at 3", "t-bot")), true);
  assert.equal(kept(f, "m-1")?.thread_id, "th-sara");
  assert.equal(kept(f, "m-1")?.user_id, "u-sara");
  assert.equal(kept(f, "m-1")?.status, "new");
});

test("the person it's with answers without quoting, 2 minutes after the bot asked: carried on", async () => {
  const f = world(2 * MIN);
  assert.equal(await heard(f.db, from(SARA, "m-1", "Sunday at 3")), true);
  assert.equal(kept(f, "m-1")?.thread_id, "th-sara");
  assert.equal(kept(f, "m-1")?.user_id, "u-sara");
});

test("someone else replies to the bot's message in her conversation: not carried on", async () => {
  const f = world(2 * MIN);
  assert.equal(await heard(f.db, from(OMAR, "m-2", "Monday is better", "t-bot")), false);
  assert.equal(kept(f, "m-2"), undefined);
});

test("someone else writes, unquoted, in the same minute: not carried on", async () => {
  const f = world(MIN);
  assert.equal(await heard(f.db, from(OMAR, "m-2", "Rabah, did you send the file?")), false);
  assert.equal(kept(f, "m-2"), undefined);
});

test("the person it's with answers without quoting after 10 minutes: not carried on", async () => {
  const f = world(10 * MIN);
  assert.equal(await heard(f.db, from(SARA, "m-1", "Sunday at 3")), false);
  assert.equal(kept(f, "m-1"), undefined);
  // Nothing from the bot in the last 5 minutes: the one look, and nothing more.
  assert.deepEqual(f.calls.map((c) => c.table), ["wa_bot_turn"]);
});

test("unquoted, when the bot's last message to her asked nothing: not carried on", async () => {
  const f = world(MIN, "Booked: *Call with Rabah*\nSunday 25-10-2026, 3:00 PM, 30 min\nhttps://meet.example.com/abc?pwd=1");
  assert.equal(await heard(f.db, from(SARA, "m-1", "thanks guys")), false);
  assert.equal(kept(f, "m-1"), undefined);
});

test("unquoted, replying to someone else's message inside the 5 minutes: not carried on", async () => {
  const f = world(MIN);
  f.tables.wa_message = [{ id: "w-omar", chat_id: GROUP, from_bot: false, text: "Who has the logo?" }];
  assert.equal(await heard(f.db, from(SARA, "m-1", "I do", "w-omar")), false);
  assert.equal(kept(f, "m-1"), undefined);
});

test("two conversations in the group: each answer, unquoted, goes to the one the bot is having with that person", async () => {
  const f = world(3 * MIN);
  f.tables.wa_bot_thread.push({ id: "th-omar", chat_id: GROUP, chat_name: "Team", started_by: "u-omar", state: {} });
  f.tables.wa_bot_turn.push(
    { id: "t-omar", thread_id: "th-omar", chat_id: GROUP, from_bot: false, user_id: "u-omar", text: "@iklipse a call with Sara", status: "done", created_at: iso(Date.now() - 2 * MIN) },
    { id: "t-bot-2", thread_id: "th-omar", chat_id: GROUP, from_bot: true, user_id: null, text: "What time?", status: "done", created_at: iso(Date.now() - MIN) },
  );
  assert.equal(await heard(f.db, from(SARA, "m-1", "Sunday")), true);
  assert.equal(kept(f, "m-1")?.thread_id, "th-sara");
  assert.equal(await heard(f.db, from(OMAR, "m-2", "5 PM")), true);
  assert.equal(kept(f, "m-2")?.thread_id, "th-omar");
});

test("the person it's with mentions the bot, or calls it by name, inside the 5 minutes: a new message for the router, not an answer", async () => {
  for (const [id, text] of [
    ["m-1", `@${BOT} tell Omar to send the invoice`],
    ["m-2", "iklipse who's late today?"],
    ["m-3", "يا اكليبس فكرني بالفايل"],
  ]) {
    const f = world(MIN);
    assert.equal(await heard(f.db, from(SARA, id, text)), false, text);
    assert.equal(kept(f, id), undefined, text);
  }
});

test("a client group: only a reply to the bot's message carries it on, never an answer with no quote", async () => {
  const f = world(MIN);
  assert.equal(await heard(f.db, from(SARA, "m-1", "Sunday at 3", null, false)), false);
  assert.equal(kept(f, "m-1"), undefined);
  // Nothing was even looked up.
  assert.equal(f.calls.length, 0);
  assert.equal(await heard(f.db, from(SARA, "m-2", "Sunday at 3", "t-bot", false)), true);
});

// ----------------------------------------------------------------- answer --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** Claude deciding (the act tool's input; null: the call fails). What it was given is read back. */
function claudeSays(act: Record<string, unknown> | null) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    asked.push(JSON.parse(String(JSON.parse(String(init.body)).messages[0].content)));
    if (!act) return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
const s = { model: "claude-haiku-5-5", book_enabled: true, bot_phone: BOT } as unknown as Settings;

/** Sara's message, carried on (quoted or not), answered: what Claude was told, and what was said back. */
async function answered(act: Record<string, unknown> | null, quotedId: string | null) {
  const f = world(MIN);
  assert.equal(await heard(f.db, from(SARA, "m-1", "Sunday", quotedId)), true);
  kept(f, "m-1")!.created_at = iso(Date.now());
  const asked = claudeSays(act);
  const sent: { chat: string; text: string }[] = [];
  const send = async (chat: string, text: string) => (sent.push({ chat, text }), `w-${sent.length}`);
  await answer(f.db, s, "m-1", send, !quotedId);
  return { asked, sent, turn: kept(f, "m-1")! };
}

test("an answer with no quote: Claude is told it's unquoted; a reply isn't", async () => {
  assert.equal((await answered({ action: "ignore" }, null)).asked[0]!.unquoted, true);
  assert.equal("unquoted" in (await answered({ action: "ignore" }, "t-bot")).asked[0]!, false);
});

test("an answer with no quote and Claude failing: nothing said back; a reply to the bot is asked again as before", async () => {
  const quiet = await answered(null, null);
  assert.deepEqual(quiet.sent, []);
  assert.equal(quiet.turn.status, "failed");

  const back = await answered(null, "t-bot");
  assert.deepEqual(back.sent, [{ chat: `${SARA}@c.us`, text: "That didn't go through. Try again in a minute." }]);
});

test("an answer with no quote: ignore says nothing; none (Claude judging it's for the bot, something missing) asks back", async () => {
  assert.deepEqual((await answered({ action: "ignore" }, null)).sent, []);
  assert.deepEqual((await answered({ action: "none", problem: "What time on Sunday?" }, null)).sent, [{ chat: `${SARA}@c.us`, text: "What time on Sunday?" }]);
});

test("the words: an unquoted message may be for the others; talk that isn't for the bot is ignore, never a question back", () => {
  assert.match(BOOK_SYSTEM, /"unquoted" true: /);
  for (const x of ["@Rabah send it", "حد شاف الفايل؟", "تمام يا شباب"]) assert.ok(BOOK_SYSTEM.includes(`"${x}"`), x);
  assert.match(BOOK_SYSTEM, /is ignore, and so is anything you're not sure is for you\./);
  assert.match(BOOK_SYSTEM, /Never answer talk that wasn't for you with a question \(none\)\./);
});
