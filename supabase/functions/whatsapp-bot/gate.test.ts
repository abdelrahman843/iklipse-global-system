// Which group messages are for the bot (gate.ts): in a team group, the alerts
// group included, a mention, a reply to the bot, its name first, or an answer
// to what it just asked that same person, and nothing else; in a client
// group, a mention only.
// Everything else gets no model call and no reply. Names and numbers are made up.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDb } from "./test/fake-db.ts";
import { asks, callsBot, CONVERSATION_MS, viaOf } from "./gate.ts";

// ---------------------------------------------------------------- callsBot --

test("the bot's name first, in English: any case, any spacing", () => {
  for (const t of ["iklipse who's late today?", "Iklipse, who's late today?", "  IKLIPSE   remind me at 5", "ikli remind me at 5", "Ikli: who's late?", "iklipse", "@iklipse who's late?", "iklipse's list for today"]) {
    assert.equal(callsBot(t), true, t);
  }
});

test("the bot's name first, in Arabic: with or without يا, every alef", () => {
  for (const t of [
    "يا اكليبس فكرني بالاجتماع",
    "يا   اكليبس فكرني",
    "يااكليبس فكرني",
    "اكليبس فكرني بالاجتماع",
    "إكليبس مين متأخر النهارده؟",
    "أكليبس مين متأخر؟",
    "اكليبس؟",
    "يا بوت فين الفايل",
    "يابوت فين الفايل",
    "‏اكليبس فكرني",
  ]) {
    assert.equal(callsBot(t), true, t);
  }
});

test("ايكليبس and إيكليبس, and letters said over and over: still its name", () => {
  for (const t of [
    "ايكليبس فكرني بالاجتماع",
    "إيكليبس مين متأخر النهارده؟",
    "يا ايكليبس فكرني",
    "يا إيكليبس، فكرني",
    "ياايكليبس فكرني",
    "يااااكليبس فكرني",
    "يااااا اكليبس فكرني",
    "اكلييييبس فكرني",
    "يا بووووت فين الفايل",
    "Iklipseeee who's late?",
    "yaaa robot remind me at 5",
  ]) {
    assert.equal(callsBot(t), true, t);
  }
  for (const t of ["انا كلمت ايكليبس امبارح", "ايكليبسات", "ياااه تعبت", "ياريييت حد يبعت الفايل"]) assert.equal(callsBot(t), false, t);
});

test("a file's caption that starts with the name counts", () => {
  assert.equal(callsBot("[photo] iklipse what's on this?"), true);
  assert.equal(callsBot("[document: brief.pdf] يا اكليبس اقرا ده"), true);
  assert.equal(callsBot("[voice note]"), false);
});

test("the name later on, or only a word that starts like it, isn't calling the bot", () => {
  for (const t of [
    "انا كلمت اكليبس امبارح عن الموضوع",
    "the iklipse dashboard is down again",
    "@Rabah send it to iklipse",
    "iklipses everywhere",
    "iklip what",
    "iklix",
    "بوتات كتير في الجروب",
    "ياريت حد يبعت الفايل",
    "يا شباب حد شاف الفايل؟",
    "تمام يا شباب",
    "حد شاف الفايل؟",
    // Arabic numbers first are kept: the name after them isn't first.
    "٢٠٢٦ اكليبس كانت سنة حلوة",
    "٣ بوت",
    "",
    "   ",
  ]) {
    assert.equal(callsBot(t), false, t);
  }
});

test("robot or bot only after ya or يا, Franco too: calling the bot by name; alone, a remark about a bot", () => {
  for (const t of [
    "ya robot enta fahem ana ba2ool eh?",
    "Ya bot, who's late today?",
    "ya   robot remind me at 5",
    "ya iklipse remind me at 5",
    "يا روبوت فكرني بالاجتماع",
  ]) {
    assert.equal(callsBot(t), true, t);
  }
  for (const t of [
    "بوت الواتساب واقع تاني",
    "بوت، مين متأخر؟",
    "روبوت، مين متأخر؟",
    "robot, who's late?",
    "Bot who's late?",
    "bot is down again",
    "yalla bot",
    "yalla ya shabab",
    "robots are coming",
    "robotics class at 5",
    "bots everywhere",
    "ya shabab el bot wa2e3",
    "the bot is down again",
    "روبوتات",
  ]) {
    assert.equal(callsBot(t), false, t);
  }
});

test("what asks something: a '?' of the bot's own, not one in a link or in words it passes on in quotes", () => {
  for (const t of ["Who's Ahmed? I'll tell him.", "What's Sara's email?", "لمين الفايل ده؟", 'Should I tell "Rabah"?']) assert.equal(asks(t), true, t);
  for (const t of [
    "Told Ahmed.",
    "Booked: https://calendly.com/x/y?month=2026-10",
    'Acme asked: "can you make the blue darker?"',
    "Acme asked: “can you make the blue darker?”",
    "Acme asked: «ممكن الأزرق يغمق؟»",
    "Sara said 'is it done?'",
  ]) {
    assert.equal(asks(t), false, t);
  }
});

// ------------------------------------------------------------------ viaOf --

const TEAM = "120363000000000001@g.us";
const CLIENT = "120363000000000002@g.us";
const BOT = "15550000001";
const BOT_LID = "77700000001";
const SARA = { sender: "15550000002@c.us", phone: "15550000002", lid: "88800000002@lid" };
const OMAR = { sender: "15550000003@c.us", phone: "15550000003" };
const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A team group set as the alerts group, the bot in it (number and lid), and what was said in it. */
function chat(messages: Record<string, unknown>[] = []) {
  return fakeDb({
    watch_settings: [{ id: 1, bot_phone: BOT, alert_group: TEAM }],
    wa_group: [
      { chat_id: TEAM, kind: "team" },
      { chat_id: CLIENT, kind: "client" },
    ],
    wa_participant: [
      { chat_id: TEAM, wa_id: `${BOT}@c.us`, phone: BOT, lid: `${BOT_LID}@lid` },
      { chat_id: TEAM, wa_id: SARA.sender, phone: SARA.phone, lid: SARA.lid },
      { chat_id: TEAM, wa_id: OMAR.sender, phone: OMAR.phone, lid: null },
    ],
    wa_message: messages,
  });
}

/** What viaOf is asked about a message, and how often it needed the sender's number. */
function ask(o: { chatId?: string; teamGroup?: boolean; text: string; quotedId?: string | null; who?: { sender: string; phone: string }; now?: number }) {
  const who = o.who ?? OMAR;
  const looked = { n: 0 };
  const args = {
    chatId: o.chatId ?? TEAM,
    teamGroup: o.teamGroup ?? true,
    text: o.text,
    quotedId: o.quotedId ?? null,
    sender: who.sender,
    senderPhone: async () => (looked.n++, who.phone),
    botPhone: BOT,
    now: o.now ?? NOW,
  };
  return { args, looked };
}

// Nothing in the gate reaches Claude: any call to the network fails the test.
const realFetch = globalThis.fetch;
let fetched = 0;
beforeEach(() => {
  fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in the gate");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("team chatter in the alerts group: not for the bot, a couple of small reads, no model call", async () => {
  for (const text of ["تمام يا شباب", "حد شاف الفايل؟", "Rabah send it please", "Good morning everyone"]) {
    const f = chat();
    const { args, looked } = ask({ text });
    assert.equal(await viaOf(f.db, args), null, text);
    assert.equal(looked.n, 0, "no question of the bot's open: the number isn't looked up");
    assert.ok(f.calls.length <= 2, `${f.calls.length} reads`);
    // The alerts group setting isn't read at all.
    assert.ok(!f.calls.some((c) => c.table === "watch_settings"));
  }
  assert.equal(fetched, 0);
});

test("a mention of the bot, by its number or its lid: handled", async () => {
  const f = chat();
  assert.equal(await viaOf(f.db, ask({ text: `@${BOT} who's late today?` }).args), "mention");
  assert.equal(await viaOf(f.db, ask({ text: `@${BOT_LID} tell Rabah to send the files` }).args), "mention");
  // Someone else mentioned: not the bot.
  assert.equal(await viaOf(f.db, ask({ text: `@${SARA.phone} send it please` }).args), null);
  assert.equal(fetched, 0);
});

test("a reply to a bot message: handled; a reply to someone else's: not", async () => {
  const f = chat([
    { id: "bot-1", chat_id: TEAM, from_bot: true, text: "Open alerts: 2", quoted_id: null, sent_at: ago(60 * 60_000) },
    { id: "sara-1", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, from_bot: false, text: "I'll send it", quoted_id: null, sent_at: ago(30 * 60_000) },
  ]);
  assert.equal(await viaOf(f.db, ask({ text: "which ones are mine?", quotedId: "bot-1" }).args), "reply");
  assert.equal(await viaOf(f.db, ask({ text: "thanks!", quotedId: "sara-1" }).args), null);
});

test("calling the bot by name first: handled; the name mid-sentence: not", async () => {
  const f = chat();
  assert.equal(await viaOf(f.db, ask({ text: "يا اكليبس فكرني بالاجتماع الساعة 5" }).args), "name");
  assert.equal(await viaOf(f.db, ask({ text: "iklipse who's late today?" }).args), "name");
  assert.equal(await viaOf(f.db, ask({ text: "انا قلت لاكليبس امبارح، اكليبس ده جامد" }).args), null);
});

/** Sara wrote 3 minutes ago; the bot asked her something about it 2 minutes ago, quoting her. */
const asked = (question = "Which client is it for?") => [
  { id: "sara-1", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, from_bot: false, text: "@iklipse remind Rabah about the files", quoted_id: null, sent_at: ago(3 * 60_000) },
  { id: "bot-2", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: question, quoted_id: "sara-1", sent_at: ago(2 * 60_000) },
];

test("the bot asked Sara 2 minutes ago: her answer, unquoted, is for it; Omar's, the same minute, isn't", async () => {
  const f = chat(asked());
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: SARA }).args), "conversation");
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: OMAR }).args), null);
  assert.equal(fetched, 0);
});

test("Sara answering 10 minutes after the bot asked, unquoted: not for it any more", async () => {
  const f = chat(asked());
  const later = NOW + 8 * 60_000; // the bot asked 2 minutes before NOW: 10 minutes ago by then
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: SARA, now: later }).args), null);
  // Just inside the window, it still is.
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: SARA, now: NOW - 2 * 60_000 + CONVERSATION_MS - 1000 }).args), "conversation");
});

test("Sara known by her lid here: matched by her number instead", async () => {
  const f = chat(asked());
  const { args, looked } = ask({ text: "Acme", who: { sender: SARA.lid, phone: SARA.phone } });
  assert.equal(await viaOf(f.db, args), "conversation");
  assert.equal(looked.n, 1);
});

test("no conversation when the bot only said something, or the '?' is in a link", async () => {
  assert.equal(await viaOf(chat(asked("Done, I told Rabah.")).db, ask({ text: "great", who: SARA }).args), null);
  assert.equal(await viaOf(chat(asked("Booked: https://calendly.com/x/y?month=2026-10")).db, ask({ text: "great", who: SARA }).args), null);
  // An Arabic question mark is a question.
  assert.equal(await viaOf(chat(asked("لمين الفايل ده؟")).db, ask({ text: "Acme", who: SARA }).args), "conversation");
});

test("only what the bot last said to Sara counts: \"Told Ahmed.\" after its question closes it", async () => {
  const f = chat([
    ...asked("Who's Ahmed?"),
    { id: "sara-2", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, from_bot: false, text: "Ahmed from Acme", quoted_id: "bot-2", sent_at: ago(90_000) },
    { id: "bot-3", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: "Told Ahmed.", quoted_id: "sara-2", sent_at: ago(60_000) },
  ]);
  assert.equal(await viaOf(f.db, ask({ text: "تمام يا شباب", who: SARA }).args), null);
});

test("the bot passing on a client's question to Sara isn't asking her anything", async () => {
  const f = chat([
    { id: "sara-1", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, from_bot: false, text: "@iklipse what did Acme say?", quoted_id: null, sent_at: ago(3 * 60_000) },
    { id: "bot-2", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: 'Acme asked: "can you make the blue darker?"', quoted_id: "sara-1", sent_at: ago(2 * 60_000) },
  ]);
  assert.equal(await viaOf(f.db, ask({ text: "Rabah, can you do that?", who: SARA }).args), null);
});

test("the bot asked Omar something after Sara: Sara's answer is still hers to give", async () => {
  const f = chat([
    ...asked(),
    { id: "omar-1", chat_id: TEAM, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "iklipse remind me at 5", quoted_id: null, sent_at: ago(90_000) },
    { id: "bot-3", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: "Remind you of what?", quoted_id: "omar-1", sent_at: ago(60_000) },
  ]);
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: SARA }).args), "conversation");
  assert.equal(await viaOf(f.db, ask({ text: "the invoice", who: OMAR }).args), "conversation");
});

test("Sara quoting someone else while the bot waits on her: that's for them, not the bot", async () => {
  const f = chat([...asked(), { id: "omar-1", chat_id: TEAM, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "who has the logo?", quoted_id: null, sent_at: ago(60_000) }]);
  assert.equal(await viaOf(f.db, ask({ text: "I do", who: SARA, quotedId: "omar-1" }).args), null);
});

/** Sara wrote to the bot a minute ago (a mention); it hasn't answered yet. */
const burst = (first: Record<string, unknown> = {}) => [
  { id: "sara-1", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, from_bot: false, text: `@${BOT} send Omar a reminder in the Acme group`, quoted_id: null, sent_at: ago(60_000), ...first },
];

test("right after her own message to the bot, before it answers, Sara's next one, unquoted, isn't for it: only the four ways in are", async () => {
  // Her message to it: a mention, its name first, or a reply to it.
  const replied = [
    { id: "bot-0", chat_id: TEAM, from_bot: true, text: "Open alerts: 2", quoted_id: null, sent_at: ago(60 * 60_000) },
    ...burst({ text: "which ones are mine?", quoted_id: "bot-0" }),
  ];
  for (const before of [burst(), burst({ text: "iklipse send Omar a reminder" }), replied]) {
    const f = chat(before);
    assert.equal(await viaOf(f.db, ask({ text: "Can you send messages in other groups?", who: SARA }).args), null);
    // Known by her lid here: the same.
    assert.equal(await viaOf(f.db, ask({ text: "and tag him", who: { sender: SARA.lid, phone: SARA.phone } }).args), null);
    assert.equal(await viaOf(f.db, ask({ text: "lunch?", who: OMAR }).args), null);
  }
  // Said one of the four ways, it is.
  const f = chat(burst());
  assert.equal(await viaOf(f.db, ask({ text: "iklipse can you send messages in other groups?", who: SARA }).args), "name");
  assert.equal(await viaOf(f.db, ask({ text: `@${BOT} and tag him`, who: SARA }).args), "mention");
  assert.equal(fetched, 0);
});

test("once the bot answers her, her next one, unquoted, is for it only when that answer asked her something", async () => {
  const answered = (text: string) => chat([...burst(), { id: "bot-1", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text, quoted_id: "sara-1", sent_at: ago(30_000) }]);
  assert.equal(await viaOf(answered("Posted in Acme.").db, ask({ text: "thanks guys", who: SARA }).args), null);
  assert.equal(await viaOf(answered("Which Acme group: the main one or the ads one?").db, ask({ text: "the main one", who: SARA }).args), "conversation");
  assert.equal(await viaOf(answered("Which Acme group: the main one or the ads one?").db, ask({ text: "the main one", who: OMAR }).args), null);
});

test("a question the bot asked in another group doesn't carry over here", async () => {
  const f = chat(asked().map((m) => ({ ...m, chat_id: "120363000000000009@g.us" })));
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: SARA }).args), null);
});

test("a client group: a mention only", async () => {
  const f = chat([
    { id: "bot-c", chat_id: CLIENT, from_bot: true, text: "Which day works?", quoted_id: "c-1", sent_at: ago(60_000) },
    { id: "c-1", chat_id: CLIENT, sender_id: SARA.sender, phone: SARA.phone, from_bot: false, text: "can we meet?", quoted_id: null, sent_at: ago(2 * 60_000) },
  ]);
  const client = { chatId: CLIENT, teamGroup: false };
  assert.equal(await viaOf(f.db, ask({ ...client, text: "iklipse who's late today?" }).args), null);
  assert.equal(await viaOf(f.db, ask({ ...client, text: "Sunday", quotedId: "bot-c", who: SARA }).args), null);
  assert.equal(await viaOf(f.db, ask({ ...client, text: "Sunday", who: SARA }).args), null);
  assert.equal(await viaOf(f.db, ask({ ...client, text: `@${BOT} book a call with Sara` }).args), "mention");
});

// ------------------------------------------------------------- index.ts --
// index.ts can't be loaded here (it serves): its source is read instead.

test("index.ts: no 'no mention needed' in the alerts group; group messages go through viaOf", () => {
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  assert.doesNotMatch(index, /alert_group\s*===\s*chatId/);
  assert.doesNotMatch(index, /select\("bot_phone, alert_group"\)/);
  assert.match(index, /viaOf\(db, \{ chatId, teamGroup, text: m\.text, quotedId: m\.quoted, sender, senderPhone, botPhone:/);
  // Only a message the gate lets through is handed to the router, with how it came.
  assert.match(index, /else if \(via\) \{[\s\S]*?orderNow\(db, \{[\s\S]*?via,[\s\S]*?\}\),/);
  // To the brain first when it takes it (brain.ts), else the router, as before.
  assert.match(index, /chatName\?: string \| null;\s*\},?\s*\) \{\s*if \(o\.told !== undefined && \(await brainNow\(db, o\)\)\) return;\s*const \[s, cfg, t\] = await Promise\.all\(\[settings\(db\), config\(db\), team\(db\)\]\);\s*await takeOrder\(db, s, t, sendAs\(cfg\), o,/);
  // The old gate is gone.
  assert.doesNotMatch(index, /mentionsBot\(db, m\.text/);
});
