// Voice notes in a team group (files.ts): one that replies to the bot, or
// answers what it just asked, is written out and read as what was said; any
// other is for the bot only when what was said starts with its name, and is
// only written out when it would be anyway (a watched group, reading files on).
// The writing-out (ElevenLabs) is stubbed. Names and numbers are made up.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDb } from "./test/fake-db.ts";
import { keepFile, noteFile, spoken, voiceToBot, wordsOf, type SentFile } from "./files.ts";
import type { Db, Settings } from "./kit.ts";

const TEAM = "120363000000000001@g.us";
const ID = "VOICE-1";
const URL_OF = "https://files.example.test/voice-1.ogg";
const VOICE: SentFile = { kind: "voice", url: URL_OF, mime: "audio/ogg; codecs=opus", name: null };
const ON = { enabled: true, read_files: true } as unknown as Settings;

/** What the stubbed writing-out says, and how often it was asked. */
let words = "";
let failWriting = false;
let wrote = 0;
let fetched = 0;
const realFetch = globalThis.fetch;
const realGet = Deno.env.get;

beforeEach(() => {
  words = "";
  failWriting = false;
  wrote = 0;
  fetched = 0;
  Deno.env.get = (k: string) => (k === "ELEVEN_API_KEY" ? "test-eleven-key" : realGet(k));
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched++;
    const url = String(input instanceof Request ? input.url : input);
    if (url === URL_OF) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    if (url.startsWith("https://api.elevenlabs.io/")) {
      wrote++;
      return failWriting ? new Response(JSON.stringify({ detail: "busy" }), { status: 500 }) : new Response(JSON.stringify({ text: words }), { status: 200 });
    }
    throw new Error(`no network: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Deno.env.get = realGet;
});

/** A team group (watched or not), the voice note kept in it as the hook keeps it, and storage that takes the file. */
function group(o: { watched?: boolean; file?: Record<string, unknown> | null; turn?: boolean } = {}) {
  const f = fakeDb({
    wa_group: [{ chat_id: TEAM, kind: "team", monitored: o.watched ?? true }],
    wa_message: [{ id: ID, chat_id: TEAM, from_bot: false, text: "[voice note]", quoted_id: null }],
    wa_file: o.file === null || o.file === undefined ? [] : [{ id: ID, chat_id: TEAM, kind: "voice", mime: VOICE.mime, name: null, url: URL_OF, path: null, tries: 0, status: "new", ...o.file }],
    wa_bot_turn: o.turn ? [{ id: ID, chat_id: TEAM, from_bot: false, text: "[voice note]", status: "new" }] : [],
  });
  (f.db as unknown as { storage: unknown }).storage = {
    from: () => ({ download: async () => ({ data: null }), upload: async () => ({ error: null }) }),
  };
  return f;
}

/** The hook's own run for a watched group's file (index.ts: noteFile, then readFileNow). */
async function hookReads(db: Db, s: Settings = ON) {
  await noteFile(db, { id: ID, chatId: TEAM, ...VOICE });
  return await keepFile(db, s, ID);
}

const ask = (via: "reply" | "conversation" | null) => ({ id: ID, chatId: TEAM, file: VOICE, text: "[voice note]", via });

// ------------------------------------------------------------------ spoken --

test("voice notes and audio are what's written out; photos, documents and no file aren't", () => {
  assert.equal(spoken(VOICE), true);
  assert.equal(spoken({ ...VOICE, kind: "audio", mime: "audio/mpeg" }), true);
  for (const kind of ["photo", "video", "document", "sticker"] as const) assert.equal(spoken({ ...VOICE, kind }), false, kind);
  assert.equal(spoken(null), false);
});

// -------------------------------------------------------------- voiceToBot --

test("a voice note replying to the bot, in a group the watch doesn't read: written out here, routed by what was said (reply)", async () => {
  words = "Remind Omar about the Acme files tonight";
  const f = group({ watched: false });
  const v = await voiceToBot(f.db, ON, ask("reply"), 0);
  assert.deepEqual(v, { text: "[voice note, written out] Remind Omar about the Acme files tonight", via: "reply" });
  assert.equal(wrote, 1);
  assert.equal(f.tables.wa_file?.[0]?.status, "read");
});

test("a voice note replying to the bot in a team group not watched: its message, kept without words (keep.ts kept), stays so once written out", async () => {
  words = "Remind Omar about the Acme files tonight";
  const f = group({ watched: false });
  Object.assign(f.tables.wa_message![0]!, { text: null });
  const v = await voiceToBot(f.db, ON, ask("reply"), 0);
  assert.deepEqual(v, { text: "[voice note, written out] Remind Omar about the Acme files tonight", via: "reply" });
  assert.equal(f.tables.wa_message![0]!.text, null);
});

test("an answer to what the bot asked, in the watched alerts group: the hook's run writes it out, once, and that's what's routed (conversation)", async () => {
  words = "Acme, the logo one";
  const f = group({ watched: true });
  const [v, hook] = await Promise.all([voiceToBot(f.db, ON, ask("conversation"), 10_000), hookReads(f.db)]);
  assert.equal(hook, "[voice note, written out] Acme, the logo one");
  assert.deepEqual(v, { text: "[voice note, written out] Acme, the logo one", via: "conversation" });
  assert.equal(wrote, 1, "written out once, not twice");
  // The kept message says it too (Claude reading the group).
  assert.equal(f.tables.wa_message?.[0]?.text, "[voice note, written out] Acme, the logo one");
});

test("already written out by the time the bot looks: no waiting, no second writing-out", async () => {
  const f = group({ file: { status: "read", tries: 1, text: "Send it to Sara" } });
  const at = Date.now();
  assert.deepEqual(await voiceToBot(f.db, ON, ask("reply"), 10_000), { text: "[voice note, written out] Send it to Sara", via: "reply" });
  assert.ok(Date.now() - at < 1000);
  assert.equal(fetched, 0);
});

test("calling the bot by name in a voice note, the way it's written out: for the bot (name)", async () => {
  for (const [said, routed] of [
    ["Iklipse, remind Sara about the invoice at 5", "iklipse, remind Sara about the invoice at 5"],
    ["Eclipse, who's late today?", "iklipse, who's late today?"],
    ["Hey Eclipse remind Omar to call Acme", "iklipse remind Omar to call Acme"],
    ["يا إيكليبس فكر سارة بالفاتورة", "iklipse فكر سارة بالفاتورة"],
    ["يا اكليبس مين متأخر النهارده؟", "iklipse مين متأخر النهارده؟"],
    ["يا بوت فين الفايل؟", "يا بوت فين الفايل؟"],
    // Robot, or bot, the way the team calls it.
    ["Ya robot, who's late today?", "iklipse, who's late today?"],
    ["Hey bot remind Omar to call Acme", "iklipse remind Omar to call Acme"],
    ["يا روبوت فكر سارة بالفاتورة", "iklipse فكر سارة بالفاتورة"],
  ] as const) {
    words = said;
    const f = group({ watched: true });
    await hookReads(f.db);
    assert.deepEqual(await voiceToBot(f.db, ON, ask(null), 10_000), { text: `[voice note, written out] ${routed}`, via: "name" }, said);
  }
  assert.equal(wrote, 9, "each written out once, by the hook's run");
});

test("the team's voice notes to each other: not for the bot, written out only as files.ts does anyway", async () => {
  // Bot or robot with no "hey" or "ya" before it: about a bot, not to it ("ok" isn't calling it either).
  for (const said of ["Guys the client called, I'll send it tonight", "I told iklipse yesterday", "Eclipses are rare this year", "Robots will do our jobs", "تمام يا شباب هبعته بالليل", "Bot is down again", "Robot, who's late today?", "OK bot is down again", "Okay, robot's broken"]) {
    words = said;
    const f = group({ watched: true });
    await hookReads(f.db);
    assert.equal(await voiceToBot(f.db, ON, ask(null), 10_000), null, said);
  }
  assert.equal(wrote, 9);
});

test("no way to the bot and nothing written out anyway (group not watched, watch off, reading files off): nothing written out, nothing read", async () => {
  for (const [s, watched] of [
    [ON, false],
    [{ ...ON, enabled: false }, true],
    [{ ...ON, read_files: false }, true],
  ] as const) {
    const f = group({ watched });
    assert.equal(await voiceToBot(f.db, s as Settings, ask(null), 10_000), null);
    assert.equal(f.tables.wa_file?.length ?? 0, 0, "not even kept");
  }
  assert.equal(fetched, 0);
});

test("reading files off: a reply to the bot still reaches it, as \"[voice note]\", with nothing written out", async () => {
  const f = group({ watched: false });
  assert.deepEqual(await voiceToBot(f.db, { ...ON, read_files: false } as Settings, ask("reply"), 0), { text: "[voice note]", via: "reply" });
  assert.equal(fetched, 0);
});

test("the writing-out fails: a reply to the bot still reaches it, as \"[voice note]\"", async () => {
  failWriting = true;
  const f = group({ watched: false });
  assert.deepEqual(await voiceToBot(f.db, ON, ask("reply"), 0), { text: "[voice note]", via: "reply" });
  assert.equal(f.tables.wa_file?.[0]?.status, "failed");
});

test("the hook's run takes too long: the bot stops waiting, and a voice note that only might have called it is left", async () => {
  // The hook's run is on it (moved on, not done) and never finishes here.
  const f = group({ file: { status: "kept", tries: 1, path: "x/voice.ogg" } });
  assert.deepEqual(await voiceToBot(f.db, ON, ask("conversation"), 0), { text: "[voice note]", via: "conversation" });
  assert.equal(await voiceToBot(f.db, ON, ask(null), 0), null);
  assert.equal(wrote, 0);
});

// ----------------------------------------------------------------- wordsOf --

test("wordsOf: text as it came; a voice note's words, and the meeting conversation's turn for it says them too", async () => {
  const f = group({ watched: false, turn: true });
  assert.equal(await wordsOf(f.db, ON, { id: "T-1", chatId: TEAM, file: null, text: "Sunday works" }), "Sunday works");
  assert.equal(f.calls.length, 0, "text: nothing read");
  words = "Sunday at 3 works for Acme";
  assert.equal(await wordsOf(f.db, ON, { id: ID, chatId: TEAM, file: VOICE, text: "[voice note]" }, 0), "[voice note, written out] Sunday at 3 works for Acme");
  assert.equal(f.tables.wa_bot_turn?.[0]?.text, "[voice note, written out] Sunday at 3 works for Acme");
});

// ------------------------------------------------------------- index.ts --
// index.ts can't be loaded here (it serves): its source is read instead.

test("index.ts: a team group's voice note goes through voiceToBot, then orderNow with the via it came back with", () => {
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  assert.match(index, /const voice = teamGroup \? fileOf\(b\.messageData\) : null;/);
  assert.match(index, /else if \(spoken\(voice\)\) \{[\s\S]*?voiceToBot\(db, await settings\(db\), \{ id: ask\.id, chatId, file: voice, text: m\.text, via \}\)[\s\S]*?if \(v\) await orderNow\(db, \{[^}]*text: v\.text,[^}]*via: v\.via,[^}]*\}\)/);
  // A reply to the bot about an order, its question about clients, or a meeting it's on: by what was said too.
  assert.match(index, /said\(\)\.then\(async \(text\) => followNow\(db, x, \{ \.\.\.ask, text,/);
  assert.match(index, /said\(\)\.then\(async \(text\) => fromTeam\(db, \{ \.\.\.ask, text,/);
  assert.match(index, /if \(asked\) later\(said\(\)\.then\(\(\) => answerNow\(/);
  // Private chats as they were: the file kept and read before the message is.
  assert.match(index, /if \(noted\) \{\s*await keepFile\(db, await settings\(db\), id\);/);
});
