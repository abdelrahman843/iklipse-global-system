#!/usr/bin/env node
// iklipse-brain: a worker's way to the company brain, through the relay (bot.mjs).
//   iklipse-brain ask "question"   reading only; prints the brain's answer
//   iklipse-brain now "request"    runs at once; the bot itself refuses what needs Nabil's go
//   iklipse-brain do "request"     runs only after Nabil's go in the group
//   iklipse-brain tools            every tool it has and what each takes
// The relay gives each worker IKLIPSE_BRAIN (its address on this server),
// IKLIPSE_BRAIN_TOKEN and IKLIPSE_BRAIN_RUN; the master key never leaves the relay.
// Installed as /usr/local/bin/iklipse-brain.

const [op, ...rest] = process.argv.slice(2);
const text = rest.join(" ").trim();
const url = process.env.IKLIPSE_BRAIN;
const token = process.env.IKLIPSE_BRAIN_TOKEN;
if (!(op === "tools" || (["ask", "now", "do"].includes(op) && text))) {
  console.error('iklipse-brain ask "question" | iklipse-brain now "request" | iklipse-brain do "request" | iklipse-brain tools');
  process.exit(2);
}
if (!url || !token) {
  console.error("The company brain isn't connected here.");
  process.exit(1);
}
try {
  const r = await fetch(`${url}/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text, run: process.env.IKLIPSE_BRAIN_RUN ?? "" }),
    signal: AbortSignal.timeout(25 * 60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(j.error || `The relay answered ${r.status}.`);
    process.exit(1);
  }
  console.log(j.answer ?? "");
  process.exit(j.ok ? 0 : 1);
} catch (e) {
  console.error(`The company brain didn't answer: ${e.message}`);
  process.exit(1);
}
