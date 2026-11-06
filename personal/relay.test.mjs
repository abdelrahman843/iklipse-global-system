// relay.mjs's own rules, without WAHA or Claude: whose messages are taken,
// the commands, and what Claude writes made fit for WhatsApp. Ids are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatsList, commandOf, newFromOwner, pieces, shortId, stepOf, whatsappText } from "./relay.mjs";

const owners = new Set(["900000000001@lid", "15550001001@c.us"]);

test("the owner's new messages only, oldest first: not the server's own, not anyone else's, not ones taken", () => {
  const msgs = [
    { id: "m3", timestamp: 30, fromMe: false, participant: "900000000001@lid", body: "third" },
    { id: "m1", timestamp: 10, fromMe: false, participant: "15550001001@c.us", body: "first" },
    { id: "m2", timestamp: 20, fromMe: true, participant: "900000000001@lid", body: "Claude's answer" },
    { id: "m4", timestamp: 40, fromMe: false, participant: "900000000077@lid", body: "someone else" },
    { id: "m5", timestamp: 50, fromMe: false, participant: "900000000001@lid", body: "taken" },
  ];
  assert.deepEqual(newFromOwner(msgs, owners, new Set(["m5"])).map((m) => m.id), ["m1", "m3"]);
  assert.deepEqual(newFromOwner({ error: "x" }, owners, new Set()), []);
});

test("the relay's commands with what follows them; a skill's /name and plain words go to Claude", () => {
  assert.deepEqual(commandOf(" /NEW "), { name: "new", arg: "" });
  assert.deepEqual(commandOf("/new Acme logo"), { name: "new", arg: "Acme logo" });
  assert.deepEqual(commandOf("/switch #3"), { name: "switch", arg: "#3" });
  assert.deepEqual(commandOf("/plan build the\nreport"), { name: "plan", arg: "build the\nreport" });
  assert.equal(commandOf("/caveman"), null);
  assert.equal(commandOf("hello /new"), null);
});

test("a message's short id, as a reply names it", () => {
  assert.equal(shortId("true_120363000000000000@g.us_3EB0ABC_900000000001@lid"), "3EB0ABC");
  assert.equal(shortId({ _serialized: "false_1@g.us_AC6E_2@lid" }), "AC6E");
  assert.equal(shortId("AC6E"), "AC6E");
});

test("what Claude is doing, in a few words", () => {
  assert.equal(stepOf("Bash", { command: "npm test", description: "Run tests" }), "Bash: Run tests");
  assert.equal(stepOf("Edit", { file_path: "/home/claude-me/work/app/src/index.ts" }), "Edit: index.ts");
  assert.equal(stepOf("WebFetch", { url: "https://example.com/a" }), "WebFetch: example.com");
  assert.equal(stepOf("mcp__claude_ai_Google_Drive__create_file", {}), "Google_Drive: create_file");
  assert.equal(stepOf("Skill", {}), "Skill");
});

test("the conversations, newest first, the current one marked", () => {
  const home = "/home/claude-me";
  const convs = {
    c1: { id: "c1", n: 1, title: "Logo", cwd: "/home/claude-me/work", model: null, at: 1 },
    c2: { id: "c2", n: 2, title: "", cwd: "/home/claude-me/work/site", model: "opus", at: 2 },
  };
  assert.equal(chatsList(convs, "c1", home), "   #2 (untitled)\n     📁 ~/work/site · opus\n▶ #1 Logo\n     📁 ~/work");
  assert.equal(chatsList({}, null, home), "No chats yet.");
});

test("Markdown as WhatsApp writes it: bold, headings, tables as lines, links, code left alone", () => {
  const md = "# Plan\n\n**Done**: two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[repo](https://github.com/x/y)\n\n```\n**not bold**\n```";
  assert.equal(whatsappText(md), "*Plan*\n\n*Done*: two\n\na · b\n\n1 · 2\n\nrepo: https://github.com/x/y\n\n```\n**not bold**\n```");
});

test("a long answer cut at lines, every piece within the limit", () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const p = pieces(long, 1000);
  assert.ok(p.length > 1);
  assert.ok(p.every((x) => x.length <= 1000));
  assert.equal(p.join("\n"), long);
  assert.deepEqual(pieces("short"), ["short"]);
});
