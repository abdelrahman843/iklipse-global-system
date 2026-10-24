// Tags in a post (post.ts) are real tags on WAHA too: the numbers tagged go
// with the message (Send's mentions), index.ts sendAs hands them to WAHA, and
// WAHA's sendText gets them (waha.ts sendTextBody); WAHA shows "@2010..." in
// the text as a tag only then. Names and numbers are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeDb } from "./test/fake-db.ts";
import { postInGroup } from "./post.ts";
import { sendTextBody } from "./waha.ts";
import type { Attendee } from "./meetings.ts";

const sara: Attendee = { kind: "team", id: "u-sara", name: "Sara Test", email: null, phone: "201000000002" };
const omar: Attendee = { kind: "team", id: "u-omar", name: "Omar Test", email: null, phone: "201000000003" };

const world = () =>
  fakeDb({
    wa_group: [
      { chat_id: "key@g.us", name: "iklipse Key Team", kind: "team", left_at: null },
      { chat_id: "ops@g.us", name: "iklipse Ops", kind: "team", left_at: null },
    ],
    // Both in the Key Team; only Sara in Ops.
    wa_participant: [
      { chat_id: "key@g.us", phone: "201000000002" },
      { chat_id: "key@g.us", phone: "201000000003" },
      { chat_id: "ops@g.us", phone: "201000000002" },
    ],
  });

function sender() {
  const sent: { chat: string; text: string; mentions: string[] | undefined }[] = [];
  const send = async (chat: string, text: string, _quoted?: string | null, mentions?: string[]) => {
    sent.push({ chat, text, mentions });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}

test("a post's tags go with it as mentions: the numbers tagged in the text, once; someone written by name isn't one", async () => {
  const f = world();
  const { send, sent } = sender();
  await postInGroup(f.db, send, { admin: true }, { group: "key team", text: "@Sara a reminder: the launch post is due today.", tag: [sara, omar], said: [] });
  assert.deepEqual(sent[0], { chat: "key@g.us", text: "@201000000003 @201000000002 a reminder: the launch post is due today.", mentions: ["201000000002", "201000000003"] });
  // Omar isn't in Ops: by name, and no mention for him.
  await postInGroup(f.db, send, { admin: true }, { group: "ops", text: "@Sara and @Omar please check the brief.", tag: [sara, omar], said: [] });
  assert.deepEqual(sent[1], { chat: "ops@g.us", text: "@201000000002 and Omar please check the brief.", mentions: ["201000000002"] });
  // Nobody tagged: none.
  await postInGroup(f.db, send, { admin: true }, { group: "ops", text: "Standup in 5.", tag: [], said: [] });
  assert.deepEqual(sent[2]!.mentions, []);
});

test("WAHA's sendText gets the numbers as mentions; none, no mentions at all", () => {
  assert.deepEqual(sendTextBody("key@g.us", "@201000000002 standup in 5", null, ["201000000002"]), {
    session: "default",
    chatId: "key@g.us",
    text: "@201000000002 standup in 5",
    linkPreview: false,
    mentions: ["201000000002@c.us"],
  });
  assert.deepEqual(sendTextBody("key@g.us", "on it", "false_key@g.us_ID1", undefined), { session: "default", chatId: "key@g.us", text: "on it", linkPreview: false, reply_to: "false_key@g.us_ID1" });
  assert.equal("mentions" in sendTextBody("key@g.us", "on it", null, []), false);
  // The same number once; what isn't a number left out.
  assert.deepEqual(sendTextBody("key@g.us", "hi", null, ["201000000002", "201000000002", "Sara Test", 42]).mentions, ["201000000002@c.us"]);
});

// index.ts can't be loaded here (it serves): its source is read instead.
test("index.ts and waha.ts: the bot's message hands the numbers tagged to WAHA's sendText (only on WAHA)", () => {
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  assert.match(index, /async \(chatId, said, quotedId, mentions\) => \{/);
  assert.match(index, /const tags = cfg\.provider === "waha" && mentions\?\.length \? \{ mentions \} : \{\};/);
  assert.match(index, /green<\{ idMessage\?: string \}>\(cfg, "sendMessage", \{ chatId, message: text, [^\n]*linkPreview: false, \.\.\.tags \}\)/);
  const waha = readFileSync("supabase/functions/whatsapp-bot/waha.ts", "utf8");
  assert.match(waha, /waha<\{ id\?: unknown \}>\("POST", "\/api\/sendText", sendTextBody\(chatId, text, reply_to, body\?\.mentions\)\)/);
});
