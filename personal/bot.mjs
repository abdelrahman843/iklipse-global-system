// The company bot (iklipse's whatsapp-bot function, master.ts there), driven
// from Nabil's group: the bot does each task exactly as if Nabil had written
// to it privately, and what it says comes back here. Nabil's subscriptions
// never answer anyone else: the bot works for the company on its own API key;
// this is only the channel between them.
//
// Signed with the master key (a root-only file, never handed to a worker):
// HMAC-SHA256 over "master.<seconds>.<body>", as brain.ts signature().
// Every few seconds the relay reads what the bot said since (poll); a task is
// over when its run is (done, failed, stopped, timeout, budget).
//
// Tasks go one after another (in order: the next only once the last is over)
// or together. A task the master sends by itself (auto) only reads on the bot's
// side; anything that acts waits for Nabil's go here first.

import { createHmac, randomUUID } from "node:crypto";

const FINAL = new Set(["done", "failed", "stopped", "timeout", "budget", "fallback"]);

/** The x-master-signature header for a body. */
export function masterSignature(secret, body, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`master.${t}.${body}`).digest("hex")}`;
}

/**
 * Lines of a /bot request: "1. ...", "2) ...", "- ..." each its own task;
 * anything else is one task. "together" first: all at once, else in order.
 */
/** The tools that actually ran and worked, from the bot's own log (not its words). */
export function doneSteps(steps = []) {
  return [...new Set(steps.filter((s) => s.outcome === "ok" && !String(s.tool).startsWith("_")).map((s) => s.tool))];
}

/** What Nabil reads once a task is over: the bot's words, else what its log shows. */
export function resultText(t) {
  const said = t.replies.map((r) => r.text.trim()).filter(Boolean);
  const did = doneSteps(t.steps);
  if (t.state === "done") return said.length ? said.join("\n\n") : did.length ? `Done: ${did.join(", ")}.` : "Done.";
  const why = t.error || t.state;
  return [`❌ Not finished (${why}).`, ...said].join("\n\n");
}

/**
 * Which waiting request Nabil's go is for. key: that one. pick: it could mean
 * more than one, so he replies to the one he means. Neither: it isn't for the
 * brain. A plain go counts only when it can mean nothing else.
 */
export function goFor({ replyKey, asks, planWaits, now, within = 30 * 60_000 }) {
  if (replyKey) return { key: asks[replyKey] ? replyKey : null, pick: false };
  const fresh = Object.keys(asks).filter((k) => now - (asks[k].at ?? 0) < within);
  if (fresh.length === 1 && !planWaits) return { key: fresh[0], pick: false };
  return { key: null, pick: fresh.length > 0 };
}

/** A job as it's written down: what's needed to pick it up after a restart. */
export function savedJob(j, started) {
  const { id, ref, via, from, body } = j.m ?? {};
  return { conv: j.conv.id, m: { id: id ?? null, ref: ref ?? null, via: via ?? "wa", from: from ?? "", body: body ?? "" }, text: j.text, plan: !!j.plan, team: j.team ?? null, force: !!j.force, approved: !!j.approved, quiet: !!j.quiet, started, cuts: j.cuts ?? 0 };
}

const CUT_NOTE = "[The server restarted while you were on this. Find out what's already done, finish the rest, and never repeat anything already sent or changed.]";
/** Restarts one job goes through before it's stopped (one that kills the server mustn't go round for ever). */
const MAX_CUTS = 3;

/** What was written down, as jobs again. dropped: what was cut off too many times. */
export function restoreJobs(queue, convs) {
  const jobs = [];
  const dropped = [];
  for (const j of queue ?? []) {
    const conv = convs[j.conv];
    if (!conv) continue;
    const cuts = (j.cuts ?? 0) + (j.started ? 1 : 0);
    if (cuts >= MAX_CUTS) {
      dropped.push(j.text);
      continue;
    }
    const { started, ...job } = j;
    jobs.push({ ...job, conv, cuts, resumed: started, text: started ? `${CUT_NOTE}
${j.text}` : j.text });
  }
  return { jobs, dropped };
}


/** The brain's tools in short, for a worker's instructions: what it can do, read from what the brain itself wrote. */
export function brainBrief(catalog) {
  const tools = catalog?.tools;
  if (!Array.isArray(tools) || !tools.length) return "The list of the brain's tools isn't there right now: iklipse-brain ask what it can do.";
  const first = (s) => String(s ?? "").split(/(?<=[.:])\s/)[0].slice(0, 140);
  const lines = tools.map((t) => `- ${t.name}${t.reads ? " (reads)" : ""}: ${first(t.about)}`);
  const skills = (catalog.skills ?? []).map((s) => s.name).join(", ");
  return [`The brain's tools now:\n${lines.join("\n")}`, ...(skills ? [`Its skills: ${skills}.`] : [])].join("\n");
}

/** Every tool in full, with what it takes (iklipse-brain tools). */
export function brainDetails(catalog) {
  const tools = catalog?.tools;
  if (!Array.isArray(tools) || !tools.length) return "The list of the brain's tools isn't there right now.";
  const said = (p) => `  ${p.name}${p.required ? "" : " (optional)"}${p.about ? `: ${p.about}` : ""}`;
  const parts = tools.map((t) => [`${t.name}${t.reads ? " (reads)" : ""}: ${t.about}`, ...(t.takes ?? []).map(said)].join("\n"));
  const skills = (catalog.skills ?? []).map((s) => `${s.name}: ${s.description ?? ""}`);
  return [...parts, ...(skills.length ? [`Skills:\n${skills.join("\n")}`] : [])].join("\n\n");
}

/** Nabil's own OK or no for the bot ("yes 4821", "no", "نعم 4821", "لا"). */
export const isOwnerWord = (text) => /^\s*(yes|ok|no|نعم|ايوه|أيوه|لا)(\s+\d{4})?\s*$/i.test(String(text ?? ""));

/**
 * The channel. post: (op, payload) => JSON (signed fetch; given for tests).
 * onApproval / onNotice: what the bot says that isn't a task's answer.
 */
export function botChannel({ url, secret, fetchImpl = fetch, post, onApproval = () => {}, onNotice = () => {}, health = null, log = console, now = () => Date.now(), timeoutMs = 20 * 60_000 }) {
  const call =
    post ??
    (async (op, payload) => {
      const body = JSON.stringify(payload);
      const r = await fetchImpl(`${url}/master/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-master-signature": masterSignature(secret, body, now()) },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) throw new Error("the bot refused the master key");
      if (r.status === 404) throw new Error("the bot's master channel isn't set up (MASTER_SECRET)");
      return j;
    });
  /** task id -> { text, auto, state, replies, steps, error, at, done(resolve) } */
  const tasks = new Map();
  let after = 0;
  // The furthest read: after a rewind, what's before it only fills in its tasks' answers.
  let heard = 0;
  let healthAt = 0;

  /** One task, sent now; resolves with it once it's over. */
  const send = async (text, { auto = false, light = false, quoted = null, id = randomUUID() } = {}) => {
    const t = { id, text, auto, state: "sending", replies: [], steps: [], error: null, at: now() };
    tasks.set(id, t);
    const over = new Promise((res) => (t.done = res));
    try {
      const r = await call("task", { task_id: id, text, auto: auto || light, ...(light ? { light: true } : {}), ...(quoted ? { quoted } : {}) });
      if (!r.ok) {
        t.state = "failed";
        t.error = r.error || "the bot didn't take it";
        t.done(t);
      } else t.state = "sent";
    } catch (e) {
      t.state = "failed";
      t.error = e.message;
      t.done(t);
    }
    return await over;
  };

  /** What the bot said since, and how the open tasks are doing. */
  const tick = async () => {
    const open = [...tasks.values()].filter((t) => !FINAL.has(t.state) && t.state !== "sending");
    // How the workers are, once a minute: being here at all says the server is up.
    const report = health && now() - healthAt >= 60_000 ? health() : null;
    if (report) healthAt = now();
    const r = await call("poll", { after, tasks: open.map((t) => t.id), ...(report ? { health: report } : {}) });
    if (!r.ok) throw new Error(r.error || "poll failed");
    for (const x of r.replies ?? []) {
      const seq = Number(x.seq) || 0;
      const old = seq <= heard;
      after = Math.max(after, seq);
      heard = Math.max(heard, seq);
      const t = x.task_id ? tasks.get(x.task_id) : null;
      if (t && x.kind === "reply") t.replies.push(x);
      else if (old) continue;
      else if (x.kind === "approval") await onApproval(x);
      // An answer to a task nobody follows any more (a restart cut its worker off) is nobody's news.
      else if (!t && !x.task_id) await onNotice(x);
    }
    for (const s of r.tasks ?? []) {
      const t = tasks.get(s.task_id);
      if (!t) continue;
      t.state = s.state;
      t.error = s.error ?? null;
      t.steps = s.steps ?? [];
      if (FINAL.has(t.state)) {
        tasks.delete(t.id);
        t.done(t);
      }
    }
    // A task the bot never picked up: over, said plainly.
    for (const t of open) {
      if (tasks.has(t.id) && now() - t.at > timeoutMs) {
        tasks.delete(t.id);
        t.state = "timeout";
        t.error = "no answer from the bot";
        t.done(t);
      }
    }
  };

  return {
    send,
    tick,
    /** A task sent before a restart, followed again; resolves with it once it's over. */
    adopt: (id, text, at) =>
      new Promise((done) => {
        tasks.set(id, { id, text, auto: false, state: "sent", replies: [], steps: [], error: null, at, done });
      }),
    /** Read again from here: a task followed again gets the answers it missed. */
    rewind: (v) => {
      after = Math.min(after, Number(v) || 0);
    },
    /** Nabil's own words for the bot: an OK, a no, stop, start. handled: the bot took them. */
    words: async (text) => (await call("words", { id: randomUUID(), text })).handled === true,
    open: () => [...tasks.values()],
    get after() {
      return after;
    },
    set after(v) {
      after = heard = Number(v) || 0;
    },
    get heard() {
      return heard;
    },
  };
}
