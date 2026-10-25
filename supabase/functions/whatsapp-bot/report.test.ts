// A group reported on every so often (report.ts), and recordings written out
// into one .md file (transcript.ts): the parts that need no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { everyText, reportHead, teamWrote } from "./report.ts";
import { fileNameOf, markdownOf } from "./transcript.ts";
import type { Person, Team } from "./kit.ts";

const sameh: Person = { id: "u1", name: "Sameh Mounir", username: "sameh", active: true, admin: true };
const guest: Person = { id: "u2", name: "Visitor", username: "v", active: true, admin: false, guest: true };
const t: Team = { people: new Map(), byPhone: new Map([["201000000001", sameh], ["201000000002", guest]]), byLid: new Map(), others: new Set() };
const msg = (phone: string | null, at: string, from_bot = false) => ({ sender_name: "x", phone, sender_id: null, from_bot, text: "hi", sent_at: at });

test("the team's updates: only the team's own messages, never the bot's or a guest's", () => {
  const w = teamWrote(t, [msg("201000000001", "2026-10-25T00:00:00Z"), msg("201000000002", "2026-10-25T02:00:00Z"), msg(null, "2026-10-25T03:00:00Z", true), msg("447000000000", "2026-10-25T04:00:00Z")]);
  assert.deepEqual(w.names, ["Sameh"]);
  assert.equal(w.last, Date.parse("2026-10-25T00:00:00Z"));
  assert.deepEqual(teamWrote(t, [msg("447000000000", "2026-10-25T04:00:00Z")]), { names: [], last: null });
});

test("no update from the team is said first, in bold, with the last one", () => {
  const from = Date.parse("2026-10-23T09:00:00Z");
  const to = Date.parse("2026-10-25T09:00:00Z");
  const none = reportHead({ group: "Side quest", from, to, names: [], lastTeam: Date.parse("2026-10-22T10:00:00Z"), messages: 4 });
  assert.match(none, /^\*Side quest\*: report/);
  assert.match(none, /\*No update from the team there in that time\.\* Last one: /);
  const some = reportHead({ group: "Side quest", from, to, names: ["Sameh"], lastTeam: to, messages: 4 });
  assert.match(some, /Team wrote: Sameh/);
  assert.match(reportHead({ group: "G", from, to, names: [], lastTeam: null, messages: 0 }), /Nothing was said there/);
});

test("how often is said in days or hours", () => {
  assert.equal(everyText(48), "2 days");
  assert.equal(everyText(24), "day");
  assert.equal(everyText(12), "12 hours");
});

test("the .md file: each recording under its heading, and why one has no words", () => {
  const md = markdownOf("Client calls", [
    { title: "Voice note", at: "2026-10-25T09:00:00Z", by: "Sara", text: "Hello there." },
    { title: "Audio", at: null, by: null, text: null, why: "no speech in it" },
  ]);
  assert.match(md, /^# Client calls\n/);
  assert.match(md, /## 1\. Voice note\n\*Sara, .+\(Cairo\)\*\n\nHello there\./);
  assert.match(md, /## 2\. Audio\n\n_No transcript: no speech in it\._/);
  assert.equal(fileNameOf("Client calls / 25 Oct"), "Client-calls-25-Oct.md");
  assert.equal(fileNameOf("!!!"), "transcripts.md");
});
