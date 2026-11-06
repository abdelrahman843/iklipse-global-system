// The company brain channel (bot.mjs): signing, answers matched to their task,
// OKs apart, what a worker reads built from the brain's words or, without
// them, its own log, and the list of what the brain can do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { botChannel, brainBrief, brainDetails, doneSteps, goFor, isOwnerWord, masterSignature, restoreJobs, resultText, savedJob } from "./bot.mjs";
import { nextAt, parseSchedule, sayDays } from "./schedule.mjs";

test("the signature is the bot's: HMAC over master.<seconds>.<body>", () => {
  const sig = masterSignature("s".repeat(40), '{"a":1}', 1_700_000_000_000);
  const v = createHmac("sha256", "s".repeat(40)).update('master.1700000000.{"a":1}').digest("hex");
  assert.equal(sig, `t=1700000000,v1=${v}`);
});

test("the brain's tools, as it wrote them: short for the instructions, in full on request", () => {
  const catalog = {
    tools: [
      { name: "search", about: "Search what was said. Only what they may read.", reads: true, takes: [{ name: "text", required: true, about: "What to look for" }, { name: "group", required: false }] },
      { name: "post_in_group", about: "Post in a group.", reads: false, takes: [] },
    ],
    skills: [{ name: "caveman", description: "Short answers" }],
  };
  const brief = brainBrief(catalog);
  assert.match(brief, /- search \(reads\): Search what was said\./);
  assert.match(brief, /- post_in_group: Post in a group\./);
  assert.ok(!brief.includes("Only what they may read"));
  assert.match(brief, /Its skills: caveman\./);
  const full = brainDetails(catalog);
  assert.match(full, /text: What to look for/);
  assert.match(full, /group \(optional\)/);
  assert.match(full, /caveman: Short answers/);
  // Not written yet: said, never made up.
  assert.match(brainBrief(null), /isn't there/);
  assert.match(brainDetails({ tools: [] }), /isn't there/);
});

test("a go runs only what it can only mean", () => {
  const now = 100 * 60_000;
  const asks = { a: { at: now - 60_000 } };
  // One waiting: the plain go is for it, or a reply to it.
  assert.deepEqual(goFor({ asks, now }), { key: "a", pick: false });
  assert.deepEqual(goFor({ replyKey: "a", asks, now }), { key: "a", pick: false });
  // A reply to something else is never for it.
  assert.deepEqual(goFor({ replyKey: "z", asks, now }), { key: null, pick: false });
  // A plan waits for its go too, or two wait: he picks.
  assert.deepEqual(goFor({ asks, planWaits: true, now }), { key: null, pick: true });
  assert.deepEqual(goFor({ asks: { a: asks.a, b: { at: now } }, now }), { key: null, pick: true });
  // Old, or nothing waiting: not for the brain.
  assert.deepEqual(goFor({ asks: { a: { at: 0 } }, now }), { key: null, pick: false });
  assert.deepEqual(goFor({ asks: {}, now }), { key: null, pick: false });
});

test("a restart: what waited goes on as it was, what was cut says so, and nothing goes round for ever", () => {
  const conv = { id: "c1" };
  const convs = { c1: conv };
  const job = { conv, m: { id: "m1", ref: "r1", via: "wa", from: "x", body: "do it" }, text: "do it", plan: false, approved: true, quiet: true };
  const q = [savedJob(job, false), savedJob({ ...job, text: "second" }, true)];
  // Written down as plain data.
  assert.equal(JSON.parse(JSON.stringify(q))[1].conv, "c1");
  const { jobs, dropped } = restoreJobs(q, convs);
  assert.equal(jobs[0].text, "do it");
  assert.equal(jobs[0].conv, conv);
  assert.equal(jobs[0].resumed, false);
  assert.equal(jobs[0].approved, true);
  assert.match(jobs[1].text, /server restarted[\s\S]*never repeat[\s\S]*\nsecond$/);
  assert.equal(jobs[1].resumed, true);
  assert.deepEqual(dropped, []);
  // A chat that's gone is left; a job cut again and again is stopped, and said.
  assert.equal(restoreJobs([{ ...q[0], conv: "gone" }], convs).jobs.length, 0);
  const third = restoreJobs([{ ...q[1], cuts: 2 }], convs);
  assert.deepEqual(third.jobs, []);
  assert.deepEqual(third.dropped, ["second"]);
});

test("a task followed after a restart gets its answer; old OKs and notices aren't said again", async () => {
  const f = fakeBot();
  const oks = [];
  const notes = [];
  const before = botChannel({ post: f.post });
  const id = "11111111-1111-4111-8111-111111111111";
  f.states.set(id, "running");
  f.say(null, "notice", "Old notice");
  f.say(id, "reply", "It went out.");
  await before.tick();
  const ch = botChannel({ post: f.post, onApproval: (x) => oks.push(x.text), onNotice: (x) => notes.push(x.text) });
  ch.after = before.heard;
  ch.rewind(0);
  const t = ch.adopt(id, "tell Sara", Date.now());
  await ch.tick();
  await ch.tick();
  assert.equal(resultText(await t), "It went out.");
  assert.deepEqual(notes, []);
  assert.deepEqual(oks, []);
  assert.equal(ch.heard, 2);
});

test("an answer to a task nobody follows is dropped; a notice still comes", async () => {
  const f = fakeBot();
  const notes = [];
  const ch = botChannel({ post: f.post, onNotice: (x) => notes.push(x.text) });
  f.say("22222222-2222-4222-8222-222222222222", "reply", "For a worker that's gone.");
  f.say(null, "notice", "Spent 80% today.");
  await ch.tick();
  assert.deepEqual(notes, ["Spent 80% today."]);
});

test("how the workers are goes with the poll, once a minute", async () => {
  const seen = [];
  let clock = 60_000;
  const ch = botChannel({ post: async (_, p) => (seen.push(p.health ?? null), { ok: true, replies: [], tasks: [] }), health: () => ({ claude: true }), now: () => clock });
  await ch.tick();
  await ch.tick();
  clock += 60_000;
  await ch.tick();
  assert.deepEqual(seen, [{ claude: true }, null, { claude: true }]);
});

test("only Nabil's own short OK words count, not a sentence with yes in it", () => {
  for (const w of ["yes 4821", "no", "نعم 1234", "لا", "OK 1111"]) assert.ok(isOwnerWord(w), w);
  for (const w of ["yes do it and also deploy", "approve 4821 please", ""]) assert.ok(!isOwnerWord(w), w);
});

/** A fake bot: takes tasks, says what it's told, ends them on the next poll. */
function fakeBot() {
  const seen = { tasks: [], words: [] };
  let seq = 0;
  const replies = [];
  const states = new Map();
  const post = async (op, p) => {
    if (op === "task") {
      seen.tasks.push(p);
      states.set(p.task_id, "running");
      return { ok: true, state: "sent" };
    }
    if (op === "words") {
      seen.words.push(p.text);
      return { ok: true, handled: true };
    }
    const out = { ok: true, replies: replies.filter((r) => r.seq > p.after), tasks: [] };
    for (const id of p.tasks) {
      const s = states.get(id);
      if (s === "running") {
        states.set(id, "done");
        out.tasks.push({ task_id: id, state: "running", steps: [] });
      } else out.tasks.push({ task_id: id, state: s, error: null, steps: [{ tool: "message_client", outcome: "ok" }] });
    }
    return out;
  };
  return { post, seen, say: (task_id, kind, text) => replies.push({ seq: ++seq, task_id, kind, text }), states };
}

test("a task's answer is matched to it; without words, what its log shows it did", async () => {
  const f = fakeBot();
  const ch = botChannel({ post: f.post });
  const first = ch.send("first");
  await new Promise((r) => setTimeout(r, 5));
  f.say(f.seen.tasks[0].task_id, "reply", "First done.");
  await ch.tick();
  await ch.tick();
  assert.equal(resultText(await first), "First done.");
  const second = ch.send("second");
  await new Promise((r) => setTimeout(r, 5));
  await ch.tick();
  await ch.tick();
  assert.equal(resultText(await second), "Done: message_client.");
});

test("the master's own asks are reading only (auto), and OKs and notices go apart", async () => {
  const f = fakeBot();
  const oks = [];
  const notes = [];
  const ch = botChannel({ post: f.post, onApproval: (x) => oks.push(x.text), onNotice: (x) => notes.push(x.text) });
  const t = ch.send("Who's working today?", { auto: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.seen.tasks[0].auto, true);
  f.say(null, "approval", "OK needed (code 4821)");
  f.say(null, "notice", "Spent 80% today.");
  await ch.tick();
  await ch.tick();
  await t;
  assert.deepEqual(oks, ["OK needed (code 4821)"]);
  assert.deepEqual(notes, ["Spent 80% today."]);
  assert.equal(ch.after, 2);
  assert.equal(await ch.words("yes 4821"), true);
  assert.deepEqual(f.seen.words, ["yes 4821"]);
});

test("the bot down or refusing: the task is over, said plainly, nothing invented", async () => {
  const ch = botChannel({ post: async () => ({ ok: false, error: "The brain isn't on." }) });
  const t = await ch.send("Tell Acme");
  assert.equal(t.state, "failed");
  assert.match(resultText(t), /Not finished \(The brain isn't on\.\)/);
  const thrown = botChannel({ post: async () => { throw new Error("network down"); } });
  assert.equal((await thrown.send("x")).state, "failed");
});

test("a task the bot never picks up times out", async () => {
  let clock = 0;
  const f = fakeBot();
  const ch = botChannel({ post: async (op, p) => (op === "poll" ? { ok: true, replies: [], tasks: [] } : f.post(op, p)), now: () => clock, timeoutMs: 1000 });
  const t = ch.send("x");
  await new Promise((r) => setTimeout(r, 5));
  clock = 5000;
  await ch.tick();
  assert.equal((await t).state, "timeout");
});

test("/schedule: every day, working days, some weekdays; Cairo time", () => {
  assert.deepEqual(parseSchedule("every day 9:00 summarize my mail"), { op: "add", days: "day", at: "09:00", text: "summarize my mail" });
  assert.deepEqual(parseSchedule("sun,wed 10:30 plan the week"), { op: "add", days: [0, 3], at: "10:30", text: "plan the week" });
  assert.equal(parseSchedule("weekdays 08:00 news").days, "weekdays");
  assert.deepEqual(parseSchedule("off 2"), { op: "off", n: 2 });
  assert.equal(parseSchedule("someday 10:00 x").op, "help");
  assert.equal(parseSchedule("day 25:00 x").op, "help");
  const cairo = (x) => Date.parse(`${x}+02:00`);
  const s = { days: "weekdays", at: "10:00", zone: "Africa/Cairo" };
  // Thursday 5 Nov 2026, after 10: Sunday 8 Nov at 10.
  assert.equal(nextAt(s, cairo("2026-11-05T11:00:00")), cairo("2026-11-08T10:00:00"));
  assert.equal(nextAt({ ...s, days: "day" }, cairo("2026-11-05T09:00:00")), cairo("2026-11-05T10:00:00"));
  assert.equal(sayDays({ days: [0, 3], at: "10:30" }), "Sun, Wed at 10:30");
});

test("done steps: only tools that worked, not the bot's own plumbing", () => {
  assert.deepEqual(doneSteps([{ tool: "set_reminder", outcome: "ok" }, { tool: "_reply", outcome: "ok" }, { tool: "post_in_group", outcome: "refused" }]), ["set_reminder"]);
});

test("a result that comes after its task ended (a deploy, the brain's own update) is said, once", async () => {
  const f = fakeBot();
  const notes = [];
  const ch = botChannel({ post: f.post, onNotice: (x) => notes.push(x.text) });
  const t = ch.send("update the brain");
  await new Promise((r) => setTimeout(r, 0));
  const id = ch.open()[0].id;
  f.say(id, "reply", "Brain update started.");
  f.states.set(id, "done");
  await ch.tick();
  assert.equal(resultText(await t), "Brain update started.");
  f.say(id, "reply", "Done: The brain runs abc now.");
  await ch.tick();
  await ch.tick();
  assert.deepEqual(notes, ["Done: The brain runs abc now."]);
});
