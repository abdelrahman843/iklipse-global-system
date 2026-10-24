// The bot's voice (voice.ts): every prompt that writes words people read has
// the one block, and ten golden examples, before and after, read right by the
// same rules in code (voiceIssues): the after ones clean, the before ones not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VOICE, voiceIssues } from "./voice.ts";
import { OK_SYSTEM, READ_SYSTEM } from "./dm.ts";
import { ANSWER_SYSTEM, FOLLOW_SYSTEM, orderSystem, REPLY_SYSTEM, TASK_SYSTEM } from "./orders.ts";
import { LOOK_SYSTEM } from "./look.ts";
import { BOOK_SYSTEM } from "./book.ts";

test("every prompt that writes words people read has the voice block", () => {
  const prompts = { READ_SYSTEM, OK_SYSTEM, ANSWER_SYSTEM, FOLLOW_SYSTEM, REPLY_SYSTEM, TASK_SYSTEM, LOOK_SYSTEM, BOOK_SYSTEM, order: orderSystem(false), order_with_agent: orderSystem(true) };
  for (const [name, p] of Object.entries(prompts)) assert.ok(p.includes(VOICE), `${name} has no voice block`);
  // The call words live in index.ts, which can't be loaded here (it serves).
  const index = readFileSync("supabase/functions/whatsapp-bot/index.ts", "utf8");
  assert.match(index, /const CALL_SYSTEM = `[^`]*\$\{VOICE\}/);
  assert.match(index, /claude\(\s*s,\s*\{ name: "call\.words"[^}]*\},\s*CALL_SYSTEM,/);
});

test("the old scattered style lines are gone", () => {
  for (const p of [READ_SYSTEM, OK_SYSTEM, ANSWER_SYSTEM, FOLLOW_SYSTEM, TASK_SYSTEM, LOOK_SYSTEM, orderSystem(false)]) {
    assert.ok(!p.includes("the way a person texts"), p.slice(0, 80));
  }
});

/** Ten replies, the way a bot writes them and the way a sharp person on the team does. Names are made up. */
const GOLDEN: { before: string; after: string; lines?: number }[] = [
  {
    before: "Hello Sara! Thank you so much for reaching out. Let me check on that for you. Based on what I can see, your logo is in the final review stage and the team expects to deliver it on Sunday. Please don't hesitate to reach out if you need anything else! 😊🙏",
    after: "The logo's in final review. You'll have it Sunday.",
  },
  {
    before: "Hello and welcome to iklipse! We are a creative and marketing agency offering branding, social media and video production. How may I assist you today?",
    after: "Hey Omar, good to hear from you. What's on your mind?",
  },
  {
    before: "Sure! After checking the deliveries, it seems that two people are late this week. Rabah is late on the Acme logo files, which were due on Tuesday, and Sara is late on the content calendar, which was due on Wednesday. Let me know if you want me to remind them!",
    after: "Rabah's late on the Acme logo files (due Tuesday) and Sara on the content calendar (due Wednesday).",
  },
  {
    before: "I understand your concern about the invoice. I'll pass this to the team and someone will get back to you as soon as possible. Thank you for your patience!",
    after: "Checking the invoice now. I'll get back to you today.",
  },
  {
    before: "Great news! I have successfully booked your meeting with Sara for Sunday. I hope it goes well!",
    after: "Booked: call with Sara, Sunday 25-10-2026 at 3:00 PM (Cairo time).",
  },
  {
    before: "Hi Sameh! Just a quick update: the files are ready. Let me know if you need anything else.",
    after: "The files aren't ready yet. Rabah needs the brand colors first.",
  },
  {
    before: "Based on the chat, the client seems upset about the delay, so I should apologize first. Sorry for the delay, the video will be ready Thursday.",
    after: "Sorry for the wait. The video will be ready Thursday.",
  },
  {
    before: "Dear Rabah,\nI hope this message finds you well. Sameh has kindly requested that you send the logo files to Acme at your earliest convenience.\nBest regards,\niklipse",
    after: "Hi Rabah, Sameh asks you to send the logo files to Acme. Reply here when it's done, or tell me what's in the way.",
  },
  {
    before: "Here are the free times I found on the calendar for Thursday: — 2:00 PM — 4:00 PM — 6:00 PM. Feel free to choose whichever works best for you!",
    after: "Thursday's free 2:00 PM to 6:00 PM (Cairo time). Which time works?",
  },
  {
    before: "Thanks a lot!!! 🙏🙏🎉 Your feedback means so much to us and we're really happy that you liked it 😊",
    after: "Glad you like it 🙌",
  },
];

test("the golden examples: after reads right, before doesn't", () => {
  assert.equal(GOLDEN.length, 10);
  for (const g of GOLDEN) {
    assert.deepEqual(voiceIssues(g.after, { lines: g.lines }), [], g.after);
    assert.notDeepEqual(voiceIssues(g.before), [], g.before);
  }
});

test("each rule, alone", () => {
  assert.deepEqual(voiceIssues("Dear Sara, it's ready."), ["greeting"]);
  assert.deepEqual(voiceIssues("Hi Sara, it's ready."), []);
  assert.deepEqual(voiceIssues("It's ready. Feel free to ask."), ["filler"]);
  assert.deepEqual(voiceIssues("It's ready.\nBest regards"), ["sign-off"]);
  assert.deepEqual(voiceIssues("Based on the chat, it's ready."), ["reasoning"]);
  assert.deepEqual(voiceIssues("It's ready — Sunday."), ["dash"]);
  assert.deepEqual(voiceIssues("Ready 🎉🎉"), ["emoji"]);
  assert.deepEqual(voiceIssues("a\nb\nc\nd"), ["long"]);
  assert.deepEqual(voiceIssues("a\nb\nc\nd", { lines: 5 }), []);
  assert.deepEqual(voiceIssues("word ".repeat(61)), ["long"]);
  // A question back about what time works is fine; "let me check" isn't.
  assert.deepEqual(voiceIssues("Let me know what time works."), []);
  assert.deepEqual(voiceIssues("Let me check."), ["filler"]);
});
