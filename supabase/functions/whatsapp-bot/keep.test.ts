// What the hook keeps (keep.ts): of a team group not watched, only what the
// gate reads (the bot's messages, who wrote one that reached it), so a reply to
// the bot and an answer to what it asked still reach it, and nothing of theirs
// is searched or found; and an edit, on Green API or WAHA, kept on the message
// it changes and gone on as that one, so nothing done with it is done twice.
// Names and numbers are made up.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDb } from "./test/fake-db.ts";
import { actedOn, EDIT_NOTE, editedId, editOf, kept, keeping, type Kept } from "./keep.ts";
import { asks, viaOf } from "./gate.ts";
import { toGreen } from "./waha.ts";
import { CANT_HELP, takeOrder } from "./orders.ts";
import { indexSome } from "./search.ts";
import { find, type Me } from "./look.ts";
import type { Person, Settings, Team } from "./kit.ts";

const TEAM = "120363000000000001@g.us";
const CLIENT = "120363000000000002@g.us";
const BOT = "201000000001";
const SARA = { sender: "201000000002@c.us", phone: "201000000002", name: "Sara" };
const OMAR = { sender: "201000000003@c.us", phone: "201000000003", name: "Omar" };
const NOW = Date.parse("2026-10-23T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// Nothing here reaches Claude or WhatsApp: any call to the network is counted, and fails.
const realFetch = globalThis.fetch;
let fetched = 0;
beforeEach(() => {
  fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network here");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------- not watched (3.5) --

test("keeping: watched does it all; not watched, only a team group's message is kept; anything else nothing", () => {
  assert.equal(keeping(true, { monitored: true, kind: "client" }), "watch");
  assert.equal(keeping(true, { monitored: true, kind: "team" }), "watch");
  // A group new to it, while watching: watched (and added), as before.
  assert.equal(keeping(true, null), "watch");
  // Watching off, or the group not watched: a team group's message is still kept.
  assert.equal(keeping(false, { monitored: true, kind: "team" }), "keep");
  assert.equal(keeping(false, { monitored: false, kind: "team" }), "keep");
  assert.equal(keeping(true, { monitored: false, kind: "team" }), "keep");
  // Anyone else's: nothing, as before.
  assert.equal(keeping(false, { monitored: true, kind: "client" }), null);
  assert.equal(keeping(true, { monitored: false, kind: "client" }), null);
  assert.equal(keeping(false, { monitored: true, kind: null }), null);
  assert.equal(keeping(false, null), null);
});

test("kept: watched, all of it; not watched, the bot's own whole, and of anyone else's only who wrote one that reached the bot", () => {
  const theirs: Kept = { id: "sara-9", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, sender_name: "Sara", from_bot: false, text: "@iklipse remind Omar about the Acme files", quoted_id: "omar-9", sent_at: ago(60_000) };
  const bots: Kept = { ...theirs, id: "bot-9", sender_id: null, phone: BOT, sender_name: null, from_bot: true, text: "Which day should I remind him?", quoted_id: "sara-9" };
  // Watched: as it came, for the bot or not.
  assert.deepEqual(kept("watch", theirs, false), theirs);
  assert.deepEqual(kept("watch", theirs, true), theirs);
  // Not watched: the bot's own, whole (a reply to it, and what it asked).
  assert.deepEqual(kept("keep", bots, false), bots);
  // Their talk with each other: nothing.
  assert.equal(kept("keep", theirs, false), null);
  // One that reached the bot: who wrote it and when, no words.
  assert.deepEqual(kept("keep", theirs, true), { ...theirs, sender_name: null, text: null, quoted_id: null });
});

/** A team group and a client group, nothing kept yet; search's queue takes every message kept. */
const groups = () =>
  fakeDb(
    {
      watch_settings: [{ id: 1, bot_phone: BOT, enabled: false }],
      wa_group: [
        { chat_id: TEAM, kind: "team", monitored: false },
        { chat_id: CLIENT, kind: "client", monitored: true },
      ],
      wa_participant: [{ chat_id: TEAM, wa_id: `${BOT}@c.us`, phone: BOT, lid: null }],
      wa_message: [],
      bot_search_chunk: [],
      bot_search_queue: [],
    },
    { rpc: { _search_take: (_a, t) => t.wa_message!.map((m) => ({ source: "wa_message", source_id: m.id })) } },
  );

/** The hook keeping a message (index.ts): what keeping and kept say, watching off here. forBot: the gate let it in. */
function hookKeeps(f: ReturnType<typeof groups>, row: Kept, forBot = false) {
  const g = (f.tables.wa_group ?? []).find((x) => x.chat_id === row.chat_id) as { monitored: boolean; kind: string } | undefined;
  const keep = keeping(false, g ?? null);
  const k = keep && kept(keep, row, forBot);
  if (k) f.tables.wa_message!.push({ ...k });
}

const ask = (o: { chatId?: string; text: string; quotedId?: string | null; who: { sender: string; phone: string } }) => ({
  chatId: o.chatId ?? TEAM,
  teamGroup: (o.chatId ?? TEAM) === TEAM,
  text: o.text,
  quotedId: o.quotedId ?? null,
  sender: o.who.sender,
  senderPhone: async () => o.who.phone,
  botPhone: BOT,
  now: NOW,
});

/** Someone's message in a group, as the hook takes it: the gate first (gate.ts), then what's kept of it. How it reached the bot, or null. */
async function hookTakes(f: ReturnType<typeof groups>, o: { id: string; text: string; quotedId?: string | null; who: typeof SARA; at: number }) {
  const via = await viaOf(f.db, ask(o));
  hookKeeps(f, { id: o.id, chat_id: TEAM, sender_id: o.who.sender, phone: o.who.phone, sender_name: o.who.name, from_bot: false, text: o.text, quoted_id: o.quotedId ?? null, sent_at: ago(o.at) }, !!via);
  return via;
}

/** The bot's own message in a group, as its echo keeps it. */
const botSays = (id: string, text: string, quotedId: string | null, at: number): Kept => ({ id, chat_id: TEAM, sender_id: null, phone: BOT, sender_name: null, from_bot: true, text, quoted_id: quotedId, sent_at: ago(at) });

test("watching off, the team group not watched: a reply to the bot, and an answer to what it asked, still reach it", async () => {
  const f = groups();
  // Sara asks it something, and it asks her back (its own message, as its echo keeps it).
  assert.equal(await hookTakes(f, { id: "sara-1", text: `@${BOT} remind Omar about the files`, who: SARA, at: 3 * 60_000 }), "mention");
  hookKeeps(f, botSays("bot-1", "Which client is it for?", "sara-1", 2 * 60_000));
  assert.deepEqual(f.tables.wa_message!.map((m) => m.id), ["sara-1", "bot-1"]);
  // Her answer, unquoted, within the 5 minutes; and Omar replying to the bot's message.
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: SARA })), "conversation");
  assert.equal(await viaOf(f.db, ask({ text: "which files?", quotedId: "bot-1", who: OMAR })), "reply");
  // Omar wasn't asked anything.
  assert.equal(await viaOf(f.db, ask({ text: "Acme", who: OMAR })), null);
  // A client group not watched keeps nothing, as before, even what's for the bot.
  hookKeeps(f, { id: "c-1", chat_id: CLIENT, sender_id: SARA.sender, phone: SARA.phone, sender_name: "Sara", from_bot: false, text: `@${BOT} hello`, quoted_id: null, sent_at: ago(60_000) }, true);
  assert.ok(!f.tables.wa_message!.some((m) => m.id === "c-1"));
  assert.equal(fetched, 0);
});

test("watching off, the team group not watched: their talk with each other isn't kept, and nothing of theirs is searched or found", async () => {
  const f = groups();
  // Talk with each other: not for the bot, not kept.
  assert.equal(await hookTakes(f, { id: "omar-1", text: "lunch at 2? the Acme deck can wait", who: OMAR, at: 4 * 60_000 }), null);
  // Sara tags the bot, and it asks her back.
  assert.equal(await hookTakes(f, { id: "sara-1", text: `@${BOT} remind Omar about the Acme files`, who: SARA, at: 3 * 60_000 }), "mention");
  hookKeeps(f, botSays("bot-1", "Which day should I remind him?", "sara-1", 2 * 60_000));
  assert.equal(await hookTakes(f, { id: "omar-2", text: "sure, 2 works", who: OMAR, at: 100_000 }), null);
  // Her answer, unquoted, within the 5 minutes: it reaches the bot, though her first message's words weren't kept.
  assert.equal(await hookTakes(f, { id: "sara-2", text: "tomorrow", who: SARA, at: 60_000 }), "conversation");
  // A reply to the bot reaches it; a reply to Sara doesn't.
  assert.equal(await hookTakes(f, { id: "omar-3", text: "which files?", quotedId: "bot-1", who: OMAR, at: 30_000 }), "reply");
  assert.equal(await hookTakes(f, { id: "omar-4", text: "ok see you at 2", quotedId: "sara-1", who: OMAR, at: 20_000 }), null);
  // Kept: the bot's message whole; of theirs, only the ones that reached it, with no words, name or quote.
  assert.deepEqual(f.tables.wa_message!.map((m) => m.id), ["sara-1", "bot-1", "sara-2", "omar-3"]);
  for (const m of f.tables.wa_message!.filter((x) => !x.from_bot)) assert.deepEqual([m.text, m.sender_name, m.quoted_id], [null, null, null], String(m.id));
  // Search: only the bot's own words are pieces.
  await indexSome(f.db, Date.now() + 60_000, null);
  assert.deepEqual(f.tables.bot_search_chunk!.map((c) => [c.source_id, c.text]), [["bot-1", "Which day should I remind him?"]]);
  // Find, by anyone on the team: no words of theirs.
  const me: Me = { id: "u-mona", admin: false, boards: [], mail: [], dms: [], ffAccounts: [], ffMeetings: [] };
  const found = JSON.parse(await find(f.db, me, { table: "wa_message" }, new Map())) as { rows: { id: string; text?: string | null }[] };
  assert.deepEqual(found.rows.filter((r) => r.text).map((r) => r.id), ["bot-1"]);
  assert.equal(fetched, 0);
});

// ----------------------------------------------------------------- edits (3.4) --

/** Green API's edit: the new words, and the id of the message it changes (stanzaId). */
const greenEdit = (stanzaId: string, textMessage: string) => ({ typeMessage: "editedMessage", editedMessageData: { textMessage, stanzaId, caption: "" } });

test("an edit on Green API: linked to the message it changes; anything else isn't an edit", () => {
  assert.equal(editedId(greenEdit("omar-1", "@iklipse remind Sara at 6")), "omar-1");
  assert.equal(editedId({ typeMessage: "extendedTextMessage", extendedTextMessageData: { text: "hi", stanzaId: "omar-1" } }), null);
  assert.equal(editedId({ typeMessage: "editedMessage", editedMessageData: { textMessage: "hi" } }), null);
  assert.equal(editedId(undefined), null);
});

/** A WAHA webhook, as it comes. */
const wahaEv = (event: string, payload: Record<string, unknown>) => ({ event, me: { id: `${BOT}@c.us` }, payload: { from: TEAM, participant: SARA.sender, fromMe: false, timestamp: NOW / 1000, ...payload } });

test("an edit on WAHA: message.edited is Green API's editedMessage, linked to the message it changes", async () => {
  const f = fakeDb({ waha_msg: [] });
  const b = await toGreen(f.db, wahaEv("message.edited", { id: `false_${TEAM}_EDIT1_${SARA.sender}`, body: "@iklipse remind Omar at 6", editedMessageId: `false_${TEAM}_ORIG1_${SARA.sender}` }));
  assert.equal(b?.typeWebhook, "incomingMessageReceived");
  assert.equal(b?.idMessage, "EDIT1");
  assert.deepEqual(b?.messageData, { typeMessage: "editedMessage", editedMessageData: { textMessage: "@iklipse remind Omar at 6", stanzaId: "ORIG1" } });
  assert.equal(editedId(b?.messageData), "ORIG1");
  // No editedMessageId: the one in what WhatsApp sent.
  const raw = await toGreen(
    f.db,
    wahaEv("message.edited", { id: `false_${TEAM}_EDIT2_${SARA.sender}`, body: "at 7 then", _data: { Message: { protocolMessage: { type: "MESSAGE_EDIT", key: { ID: "ORIG2" }, editedMessage: { conversation: "at 7 then" } } } } }),
  );
  assert.equal(editedId(raw?.messageData), "ORIG2");
});

test("an edit on WAHA never comes as a new message: message.any carrying one is left to message.edited", async () => {
  const f = fakeDb({ waha_msg: [] });
  for (const _data of [
    { IsEdit: true, Message: { conversation: "remind Omar at 6" } },
    { Message: { editedMessage: { message: { protocolMessage: { key: { ID: "ORIG1" } } } } } },
    { Message: { protocolMessage: { type: "MESSAGE_EDIT", key: { ID: "ORIG1" }, editedMessage: { conversation: "remind Omar at 6" } } } },
  ]) {
    assert.equal(await toGreen(f.db, wahaEv("message.any", { id: `false_${TEAM}_EDIT1_${SARA.sender}`, body: "remind Omar at 6", _data })), null, JSON.stringify(_data));
  }
  // A plain message still is one.
  const plain = await toGreen(f.db, wahaEv("message.any", { id: `false_${TEAM}_NEW1_${SARA.sender}`, body: "hello", _data: { Message: { conversation: "hello" } } }));
  assert.equal(plain?.messageData?.typeMessage, "extendedTextMessage");
});

/** Omar asked the bot for a reminder in the team group, and it answered him (quoting it). */
const handled = (more: Record<string, unknown[]> = {}) =>
  fakeDb({
    wa_group: [
      { chat_id: TEAM, kind: "team" },
      { chat_id: CLIENT, kind: "client" },
    ],
    wa_message: [
      { id: "omar-1", chat_id: TEAM, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "@iklipse remind Sara at 5", quoted_id: null, sent_at: ago(5 * 60_000) },
      { id: "bot-1", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: "Done, I'll remind Sara at 5:00 PM.", quoted_id: "omar-1", sent_at: ago(4 * 60_000) },
    ],
    bot_heard: [{ id: "order:omar-1" }],
    wa_bot_turn: [],
    ...more,
  });

const omarOnTeam: Person = { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false };
/** Who's on the team (index.ts team): Omar, by his number, unless said otherwise. */
const crew =
  (byPhone: [string, Person][] = [[OMAR.phone, omarOnTeam]], byLid: [string, Person][] = []) =>
  async (): Promise<Team> => ({ people: new Map(), byPhone: new Map(byPhone), byLid: new Map(byLid), others: new Set() });

test("an edit of a message the bot already acted on: its words kept on that one, no second order; told once, as a reply to it", async () => {
  const f = handled();
  const md = greenEdit("omar-1", "@iklipse remind Sara at 6");
  const e = await editOf(f.db, { md, chatId: TEAM, text: "@iklipse remind Sara at 6 (edited)", mine: false, team: crew() });
  assert.deepEqual(e, { id: "omar-1", text: "@iklipse remind Sara at 6 (edited)", quotedId: null, done: true, note: EDIT_NOTE, answers: null });
  // Kept on the message it changes, not as a new one.
  assert.deepEqual(f.tables.wa_message!.map((m) => [m.id, m.text]), [
    ["omar-1", "@iklipse remind Sara at 6 (edited)"],
    ["bot-1", "Done, I'll remind Sara at 5:00 PM."],
  ]);
  assert.doesNotMatch(EDIT_NOTE, /[—–]/);
  // It asks, so their answer, unquoted, reaches it (gate.ts).
  assert.equal(asks(EDIT_NOTE), true);
  // Edited again: told only the first time.
  const again = await editOf(f.db, { md: greenEdit("omar-1", "@iklipse remind Sara at 7"), chatId: TEAM, text: "@iklipse remind Sara at 7 (edited)", mine: false, team: crew() });
  assert.equal(again?.done, true);
  assert.equal(again?.note, null);
  assert.equal(fetched, 0);
});

test("an edit that went on anyway would find the order taken: no second order, no model call, nothing sent", async () => {
  const f = handled();
  const e = await editOf(f.db, { md: greenEdit("omar-1", "@iklipse remind Sara at 6"), chatId: TEAM, text: "@iklipse remind Sara at 6 (edited)", mine: false });
  const sent: string[] = [];
  const omar: Person = { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false };
  const team: Team = { people: new Map([[omar.id, omar]]), byPhone: new Map([[OMAR.phone, omar]]), byLid: new Map(), others: new Set() };
  const s = { orders_enabled: true, bot_phone: BOT } as unknown as Settings;
  await takeOrder(f.db, s, team, async (_c, text) => (sent.push(text), "wamid-1"), { id: e!.id, chatId: TEAM, where: "team", text: e!.text, quoted: null, phone: OMAR.phone, lid: null, name: "Omar", via: "mention" }, async () => {});
  assert.deepEqual(sent, []);
  assert.equal(fetched, 0);
  assert.equal((f.tables.bot_order ?? []).length, 0);
});

test("the same edit sent again (a webhook retried): nothing more, and no note about what came of it the first time", async () => {
  // Omar tags the bot by editing a message it hadn't acted on: the edit goes on, and the bot answers it.
  const f = handled({
    wa_message: [{ id: "omar-3", chat_id: TEAM, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "remind Sara at 5", quoted_id: null, sent_at: ago(60_000) }],
    bot_heard: [],
  });
  const edit = { md: greenEdit("omar-3", "@iklipse remind Sara at 5"), chatId: TEAM, text: "@iklipse remind Sara at 5 (edited)", mine: false, own: "edit-1", team: crew() };
  assert.equal((await editOf(f.db, edit))?.done, false);
  f.tables.bot_heard!.push({ id: "order:omar-3" });
  f.tables.wa_message!.push({ id: "bot-3", chat_id: TEAM, from_bot: true, text: "Done, I'll remind Sara at 5:00 PM.", quoted_id: "omar-3", sent_at: ago(30_000) });
  // The same edit again: it isn't told it was acted on "before you edited it".
  assert.deepEqual(await editOf(f.db, edit), { id: "omar-3", text: "@iklipse remind Sara at 5 (edited)", quotedId: null, done: true, note: null, answers: null });
  // Edited again after that (another edit): told once, as before.
  assert.equal((await editOf(f.db, { ...edit, md: greenEdit("omar-3", "@iklipse remind Sara at 6"), text: "@iklipse remind Sara at 6 (edited)", own: "edit-2" }))?.note, EDIT_NOTE);
  // An edit whose own id is the one it changes can't be told from the next: none is taken for a repeat.
  const g = handled({ wa_message: [{ id: "omar-4", chat_id: TEAM, from_bot: false, text: "hi", quoted_id: null }], bot_heard: [] });
  for (const words of ["hi all", "hi all!"]) {
    assert.equal((await editOf(g.db, { md: greenEdit("omar-4", words), chatId: TEAM, text: `${words} (edited)`, mine: false, own: "omar-4" }))?.done, false, words);
  }
  assert.equal(fetched, 0);
});

test("no note where the bot didn't answer it, in a client group, or for an edit from the bot's own phone", async () => {
  // Acted on, but nothing said back (the router let it be): no note.
  const quiet = handled({ wa_message: [{ id: "omar-1", chat_id: TEAM, from_bot: false, text: "@iklipse thanks", quoted_id: null, sent_at: ago(60_000) }] });
  assert.equal((await editOf(quiet.db, { md: greenEdit("omar-1", "@iklipse thanks!"), chatId: TEAM, text: "@iklipse thanks! (edited)", mine: false, team: crew() }))?.note, null);
  // A client group: never said there.
  const client = handled({
    wa_message: [
      { id: "c-1", chat_id: CLIENT, from_bot: false, text: "@iklipse book a call", quoted_id: null, sent_at: ago(60_000) },
      { id: "bot-c", chat_id: CLIENT, from_bot: true, text: "Booked.", quoted_id: "c-1", sent_at: ago(30_000) },
    ],
    bot_heard: [{ id: "order:c-1" }],
  });
  const c = await editOf(client.db, { md: greenEdit("c-1", "@iklipse book a call tomorrow"), chatId: CLIENT, text: "@iklipse book a call tomorrow (edited)", mine: false, team: crew() });
  assert.equal(c?.done, true);
  assert.equal(c?.note, null);
  // From the bot's own phone.
  assert.equal((await editOf(handled().db, { md: greenEdit("omar-1", "x"), chatId: TEAM, text: "x (edited)", mine: true, team: crew() }))?.note, null);
});

test("no note to someone the bot doesn't help: a guest, someone who left or someone it doesn't know heard \"I can't help you here\", and that's all", async () => {
  // Their message for the bot, answered with that line (orders.ts cantHelp, quoting it); then they edit it.
  const cant = () =>
    handled({
      wa_message: [
        { id: "omar-1", chat_id: TEAM, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "@iklipse remind Sara at 5", quoted_id: null, sent_at: ago(5 * 60_000) },
        { id: "bot-1", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: CANT_HELP, quoted_id: "omar-1", sent_at: ago(4 * 60_000) },
      ],
    });
  const edit = { md: greenEdit("omar-1", "@iklipse remind Sara at 6"), chatId: TEAM, text: "@iklipse remind Sara at 6 (edited)", mine: false };
  for (const [who, team] of [
    ["a guest", crew([[OMAR.phone, { ...omarOnTeam, guest: true }]])],
    ["someone who left", crew([[OMAR.phone, { ...omarOnTeam, active: false }]])],
    ["someone it doesn't know", crew([])],
  ] as const) {
    const f = cant();
    const e = await editOf(f.db, { ...edit, team });
    assert.equal(e?.done, true, who);
    assert.equal(e?.note, null, who);
    // What the hook would say back, kept as sendAs keeps it: nothing. So their next message, unquoted, isn't an answer to the bot (gate.ts).
    if (e?.note) f.tables.wa_message!.push({ id: "bot-2", chat_id: TEAM, sender_id: null, phone: BOT, from_bot: true, text: e.note, quoted_id: "omar-1", sent_at: ago(10_000) });
    assert.equal(await viaOf(f.db, ask({ text: "remind Sara at 6", who: OMAR })), null, who);
  }
  // Someone on the team is told, by their number or (WhatsApp hiding it) their WhatsApp id.
  assert.equal((await editOf(cant().db, { ...edit, team: crew() }))?.note, EDIT_NOTE);
  const hidden = cant();
  Object.assign(hidden.tables.wa_message![0]!, { sender_id: "90000000000001@lid", phone: null });
  assert.equal((await editOf(hidden.db, { ...edit, team: crew([], [["90000000000001@lid", omarOnTeam]]) }))?.note, EDIT_NOTE);
  assert.equal(fetched, 0);
});

test("an edit of a message the bot didn't act on: it goes on as that one, by its id, with what it quoted", async () => {
  // Omar replied to the bot without a tag, then edited it; the edit itself doesn't say what it quoted.
  const f = handled({
    wa_message: [
      { id: "bot-0", chat_id: TEAM, from_bot: true, text: "Open alerts: 2", quoted_id: null, sent_at: ago(60 * 60_000) },
      { id: "omar-2", chat_id: TEAM, sender_id: OMAR.sender, phone: OMAR.phone, from_bot: false, text: "which ones r mine", quoted_id: "bot-0", sent_at: ago(60_000) },
    ],
    bot_heard: [],
  });
  const e = await editOf(f.db, { md: greenEdit("omar-2", "which ones are mine?"), chatId: TEAM, text: "which ones are mine? (edited)", mine: false });
  assert.deepEqual(e, { id: "omar-2", text: "which ones are mine? (edited)", quotedId: "bot-0", done: false, note: null, answers: null });
  // As the hook passes it on: a reply to the bot.
  assert.equal(await viaOf(f.db, ask({ text: e!.text, quotedId: e!.quotedId, who: OMAR })), "reply");
  // Not kept anywhere yet: it goes on as that one all the same, and is kept by the hook as it.
  const fresh = await editOf(fakeDb({ wa_message: [] }).db, { md: greenEdit("gone-1", "hello"), chatId: TEAM, text: "hello (edited)", mine: false });
  assert.deepEqual(fresh, { id: "gone-1", text: "hello (edited)", quotedId: null, done: false, note: null, answers: null });
});

test("a file's caption edited: its tag, and what's in it, stays first; other words in brackets aren't a tag", async () => {
  const f = fakeDb({
    wa_message: [
      { id: "p-1", chat_id: TEAM, from_bot: false, text: "[photo: a red logo on white] the old one", quoted_id: null },
      { id: "t-1", chat_id: TEAM, from_bot: false, text: "[urgent] call Acme", quoted_id: null },
    ],
  });
  assert.equal((await editOf(f.db, { md: { typeMessage: "editedMessage", editedMessageData: { caption: "the new one", stanzaId: "p-1" } }, chatId: TEAM, text: "the new one (edited)", mine: false }))?.text, "[photo: a red logo on white] the new one (edited)");
  assert.equal((await editOf(f.db, { md: greenEdit("t-1", "call Acme now"), chatId: TEAM, text: "call Acme now (edited)", mine: false }))?.text, "call Acme now (edited)");
  assert.deepEqual(f.tables.wa_message!.map((m) => m.text), ["[photo: a red logo on white] the new one (edited)", "call Acme now (edited)"]);
  // A new caption in brackets of its own: the file's tag still comes first.
  const caption = { md: { typeMessage: "editedMessage", editedMessageData: { caption: "[final] the logo", stanzaId: "p-1" } }, chatId: TEAM, text: "[final] the logo (edited)", mine: false };
  assert.equal((await editOf(f.db, caption))?.text, "[photo: a red logo on white] [final] the logo (edited)");
});

test("an edit of one kept without its words (a team group not watched): still without them", async () => {
  const f = handled({
    wa_message: [{ id: "sara-1", chat_id: TEAM, sender_id: SARA.sender, phone: SARA.phone, sender_name: null, from_bot: false, text: null, quoted_id: null, sent_at: ago(60_000) }],
    bot_heard: [{ id: "order:sara-1" }],
  });
  const e = await editOf(f.db, { md: greenEdit("sara-1", "@iklipse remind Omar about the Acme logo files"), chatId: TEAM, text: "@iklipse remind Omar about the Acme logo files (edited)", mine: false });
  assert.equal(e?.done, true);
  assert.deepEqual(f.tables.wa_message!.map((m) => [m.id, m.text]), [["sara-1", null]]);
});

test("privately: kept on the message in the private chat; acted on by any of the bot's marks, or a meeting turn", async () => {
  const f = fakeDb({
    wa_dm: [{ id: "dm-1", chat_id: `${OMAR.phone}@c.us`, from_bot: false, text: "send me the invoice", quoted_id: null }],
    bot_heard: [{ id: "order:dm-1" }],
    wa_bot_turn: [{ id: "turn-1" }],
    wa_message: [],
  });
  const e = await editOf(f.db, { md: greenEdit("dm-1", "send me the Acme invoice"), chatId: `${OMAR.phone}@c.us`, text: "send me the Acme invoice (edited)", mine: false });
  assert.deepEqual(e, { id: "dm-1", text: "send me the Acme invoice (edited)", quotedId: null, done: true, note: null, answers: null });
  assert.equal(f.tables.wa_dm![0]!.text, "send me the Acme invoice (edited)");
  for (const [mark, id] of [["x-1", "x-1"], ["follow:x-2", "x-2"], ["target:x-3", "x-3"]]) {
    assert.equal(await actedOn(fakeDb({ bot_heard: [{ id: mark }], wa_bot_turn: [] }).db, id!), true, mark);
  }
  assert.equal(await actedOn(f.db, "turn-1"), true);
  assert.equal(await actedOn(f.db, "other-1"), false);
  // Another of the bot's marks (a digest, a link) isn't about the message.
  assert.equal(await actedOn(fakeDb({ bot_heard: [{ id: "link:x-4" }], wa_bot_turn: [] }).db, "x-4"), false);
});

// ------------------------------------------------------------- index.ts --
// index.ts can't be loaded here (it serves): its source is read instead.

const index = () => readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
/** The hook's own code (onHook), to the next function. */
const onHook = () => /async function onHook\([\s\S]*?\r?\n}\r?\n/.exec(index())![0];

test("index.ts: an edit goes on as the message it changes, before anything else; one acted on goes no further", () => {
  const hook = onHook();
  const at = (s: string) => hook.indexOf(s);
  // By the edit's own id too (before it becomes the one it changes): the same edit again does nothing. Who's on the team, for the note.
  assert.ok(at("const edit = await editOf(db, { md: b.messageData, chatId, text: m.text, mine: type.startsWith(\"outgoing\"), own: b.idMessage, team: () => team(db) });") > 0);
  assert.ok(at("const edit = await editOf(") < at('if (!chatId.endsWith("@g.us")) {'), "before private chats and groups");
  // Acted on: the brain's gets the edit as a correction (brain.ts); an answer to the bot's question that's still waiting is taken as it is now
  // (fromTeam, marked by the edit's own); else the note, if any.
  assert.match(
    hook,
    /if \(edit\?\.done\) \{\s*\/\/ The brain had it[^\n]*\n\s*if \(!type\.startsWith\("outgoing"\) && \(await brainEditNow\(db, edit\.id, edit\.text, b\.idMessage\)\)\) return json\(\{ ok: true \}\);\s*const \{ note, answers: a \} = edit;\s*if \(a\) later\(fromTeam\(db, \{ id: edit\.id, chatId: a\.chatId, text: edit\.text, quotedId: a\.quotedId, phone: a\.phone, lid: a\.lid \}, a\.once\)\);\s*else if \(note\) later\(config\(db\)\.then\(\(cfg\) => sendAs\(cfg\)\(chatId, note, edit\.id\)\)\);\s*return json\(\{ ok: true \}\);\s*\}/,
  );
  assert.match(index(), /async function fromTeam\(db: Db, o: \{[^\n]*\}, once = o\.id\) \{\s*if \(!\(await firstTime\(db, once\)\)\) return true;/);
  assert.match(hook, /if \(edit\) \{\s*b\.idMessage = edit\.id;\s*m\.text = edit\.text;\s*m\.quoted \?\?= edit\.quotedId;\s*\}/);
  // An edit's words: its text, or a file's new caption; none, nothing.
  assert.match(index(), /case "editedMessage": \{[\s\S]*?editedMessageData\?\.textMessage\) \|\| str\(md\?\.editedMessageData\?\.caption\)[\s\S]*?return words \? \{ text: `\$\{words\} \(edited\)`, quoted \} : null;/);
});

test("index.ts: watching off, or the group not watched, what the gate reads of a team group is still kept, and nothing more", () => {
  const hook = onHook();
  assert.doesNotMatch(hook, /if \(!on\?\.enabled\) return/);
  assert.doesNotMatch(hook, /!g\.monitored/);
  assert.match(hook, /const keep = keeping\(!!on\?\.enabled, g\);\s*if \(!keep\) return json\(\{ ok: true \}\);/);
  const keptAt = hook.indexOf('await db.from("wa_message").upsert(');
  const only = hook.indexOf('if (keep === "keep") return json({ ok: true });');
  assert.ok(hook.indexOf("const keep = keeping(") < keptAt && keptAt < only, "kept, then only that");
  assert.ok(only < hook.indexOf("const file = type === \"outgoingAPIMessageReceived\" ? null : fileOf(b.messageData);"), "before files and alerts");
  // What's kept is what kept says: not watched, theirs only when it reached the bot (forBot), with no words.
  assert.match(hook, /const row = kept\(keep, \{ id: b\.idMessage, chat_id: chatId, [^}]*text: m\.text\.slice\(0, 4000\)[^}]*\}, forBot\);\s*if \(row\) await db\.from\("wa_message"\)\.upsert\(row, \{ onConflict: "id", ignoreDuplicates: true \}\);/);
  assert.equal(hook.match(/\.from\("wa_message"\)\.upsert\(/g)?.length, 1, "kept only there");
  // forBot: the gate let it in (any of its ways), decided before anything is kept.
  assert.ok(hook.indexOf("let forBot = false;") < hook.indexOf('if (type === "incomingMessageReceived") {'));
  assert.equal(hook.match(/\n\s*forBot = true;/g)?.length, 2, "a reply to the bot's ask or draft, and to its report on an order");
  assert.match(hook, /const via = asked\s*\?\s*null\s*: await viaOf\([^;]*\);\s*forBot = !!\(asked \|\| via\);/);
  assert.ok(hook.indexOf("forBot = !!(asked || via);") < hook.indexOf("const row = kept("));
});
