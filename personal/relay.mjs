// The owner's own Claude, reached from one WhatsApp group.
//
// On the claude-vps server, next to WAHA: every 2 seconds it reads the group's
// newest messages from WAHA (on the server itself, nothing opened to the
// internet), takes the owner's only (anyone else in the group is ignored: it's
// their subscription, for them), hands each to Claude Code, the unmodified
// one, run as the claude-me user and signed in there by the owner themselves,
// and sends what Claude says back to the group. The bot (the whatsapp-bot
// function, PERSONAL_GROUP) stays out of this group.
//
// As on the desktop app: several conversations, each in its own folder, with
// its own model and effort, two at a time; a reply to one of Claude's messages
// goes on in that one's conversation; plan mode; what it's doing while it
// works; voice notes written out (the server's Whisper), photos and files
// saved where Claude works. /help lists the commands.
//
// Runs as root only to start Claude as claude-me; the WAHA key comes from
// systemd (LoadCredential) and never reaches Claude.

import { execFileSync, spawn } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEC = 1000;
const MIN = 60 * SEC;

/** WhatsApp's own formatting for what Claude writes in Markdown: *bold*, headings as bold lines, no tables. */
export function whatsappText(md) {
  const parts = String(md ?? "").split(/(```[\s\S]*?```)/g);
  return parts
    .map((p, i) =>
      i % 2
        ? p
        : p
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/\*\*(.+?)\*\*/g, "*$1*")
            .replace(/__(.+?)__/g, "_$1_")
            .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
            .replace(/^\|(.+)\|$/gm, (_, row) => row.split("|").map((c) => c.trim()).join(" · "))
            .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2"),
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A long answer in pieces WhatsApp takes, cut at a line where it can. */
export function pieces(text, max = 3500) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The owner's new messages, oldest first: not the server's own (fromMe), from
 * one of their ids only, newer than what was taken already.
 */
export function newFromOwner(messages, owners, seen) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.fromMe && owners.has(String(m.participant ?? m.author ?? "")) && !seen.has(String(m.id)))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/** The relay's own commands; anything else (a skill's "/name" too) goes to Claude as it is. */
const COMMANDS = new Set(["help", "new", "clear", "chats", "switch", "resume", "rename", "cd", "model", "effort", "plan", "status", "stop"]);

/** {name, arg} for one of the relay's commands, or null for a request. */
export function commandOf(text) {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text ?? "").trim());
  if (!m || !COMMANDS.has(m[1].toLowerCase())) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] ?? "").trim() };
}

/** WhatsApp's short id of a message ("true_<chat>_<ID>_<who>" -> "<ID>"), as a reply names it. */
export const shortId = (id) => {
  const s = typeof id === "string" ? id : (id?._serialized ?? id?.id ?? "");
  const p = String(s).split("_");
  return p.length >= 3 ? p[2] : String(s);
};

/** What a step of Claude's work is, in a few words: "Bash: npm test", "Edit: index.ts". */
export function stepOf(name, input = {}) {
  const cut = (s, n = 70) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  switch (name) {
    case "Bash":
      return `Bash: ${cut(input.description || input.command)}`;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return `${name}: ${basename(String(input.file_path ?? input.notebook_path ?? ""))}`;
    case "Grep":
    case "Glob":
      return `${name}: ${cut(input.pattern, 50)}`;
    case "WebSearch":
      return `WebSearch: ${cut(input.query)}`;
    case "WebFetch":
      try {
        return `WebFetch: ${new URL(input.url).host}`;
      } catch {
        return "WebFetch";
      }
    case "Task":
    case "Agent":
      return `Agent: ${cut(input.description)}`;
    case "TodoWrite":
      return "updating the plan";
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return mcp ? `${mcp[1].replace(/^claude_ai_/, "")}: ${mcp[2]}` : name;
    }
  }
}

/** The conversations, newest first, as /chats shows them. */
export function chatsList(convs, cur, home) {
  const list = Object.values(convs).sort((a, b) => b.at - a.at);
  if (!list.length) return "No chats yet.";
  return list
    .slice(0, 15)
    .map((c) => `${c.id === cur ? "▶" : "  "} #${c.n} ${c.title || "(untitled)"}\n     📁 ${c.cwd.startsWith(home) ? "~" + c.cwd.slice(home.length) : c.cwd}${c.model ? ` · ${c.model}` : ""}`)
    .join("\n");
}

const HELP = [
  "*Commands*",
  "/new [name] a new chat (/clear does the same)",
  "/chats your chats",
  "/switch number go back to a chat (/resume does the same)",
  "/rename name name this chat",
  "/cd folder a new chat in a folder (inside ~/work, or a full path in ~)",
  "/model name the model (opus, sonnet, haiku, fable, or the full name). No name: the default",
  "/effort low|medium|high|xhigh|max",
  "/plan request makes a plan first without doing anything; then say go",
  "/status what's running",
  "/stop stops what's running in this chat",
  "",
  "Reply to one of Claude's messages to go on in that chat. Voice notes are written out; photos and files are saved in the inbox. Any other /command (a skill) goes to Claude as it is.",
].join("\n");

const SYSTEM = [
  "Your owner reaches you from a WhatsApp group on their phone; every message is theirs.",
  "What you answer is sent back to them as WhatsApp messages: readable on a phone, short paragraphs, plain lists, no tables.",
  "You can't ask questions with a picker here: ask in plain text and they answer in their next message.",
  "Files they send are saved under ~/work/inbox and named in their message: look at photos and documents with the Read tool.",
  "Voice notes come already written out.",
  "Always write your replies in English, whatever language the message is in.",
  "Nothing you write to disk reaches them by itself: to give them a file, put it on their Google Drive (or GitHub for code) and send the link.",
  "Their code and folders live on GitHub (gh is signed in as them); images and videos go to their Google Drive.",
].join(" ");

// ------------------------------------------------------------------ the service --

function main() {
  const conf = {
    waha: process.env.WAHA_URL || "http://127.0.0.1:3000",
    session: process.env.WAHA_SESSION || "default",
    group: process.env.GROUP || "",
    owners: new Set((process.env.OWNERS || "").split(",").map((s) => s.trim()).filter(Boolean)),
    user: process.env.CLAUDE_USER || "claude-me",
    claude: process.env.CLAUDE_BIN || "/usr/local/bin/claude",
    state: join(process.env.STATE_DIRECTORY || "/var/lib/claude-me-relay", "state.json"),
    maxRun: Number(process.env.MAX_RUN_MIN || 60) * MIN,
    parallel: Number(process.env.MAX_PARALLEL || 2),
    whisper: process.env.WHISPER_PY || "/opt/whisper/venv/bin/python",
    whisperModels: process.env.WHISPER_MODELS || "/opt/whisper/models",
  };
  const key = readFileSync(join(process.env.CREDENTIALS_DIRECTORY || "/etc/claude-me", "waha.key"), "utf8").trim();
  if (!/@g\.us$/.test(conf.group) || !conf.owners.size || !key) {
    console.error("relay: GROUP, OWNERS and the WAHA key are needed");
    process.exit(1);
  }
  const uid = Number(execFileSync("id", ["-u", conf.user]).toString().trim());
  const gid = Number(execFileSync("id", ["-g", conf.user]).toString().trim());
  const home = `/home/${conf.user}`;
  const work = join(home, "work");
  const inbox = join(work, "inbox");
  const mine = (path) => chownSync(path, uid, gid);

  // ------------------------------------------------------------ what's kept --

  /** Where reading got to, the conversations, which one is current, and which conversation each of Claude's messages was. */
  let st = { since: Math.floor(Date.now() / SEC), seen: [], convs: {}, cur: null, n: 0, sent: {} };
  try {
    st = { ...st, ...JSON.parse(readFileSync(conf.state, "utf8")) };
  } catch {}
  // The one conversation before there were several.
  if (st.session && !Object.keys(st.convs).length) {
    st.convs.c1 = { id: "c1", n: 1, title: "First", cwd: work, model: null, effort: null, session: st.session, at: Date.now() };
    st.cur = "c1";
    st.n = 1;
  }
  delete st.session;
  const save = () => {
    st.seen = st.seen.slice(-200);
    const sent = Object.entries(st.sent);
    if (sent.length > 400) st.sent = Object.fromEntries(sent.slice(-400));
    writeFileSync(`${conf.state}.new`, JSON.stringify(st));
    renameSync(`${conf.state}.new`, conf.state);
  };

  const newConv = (cwd = work, title = "") => {
    const n = ++st.n;
    const c = { id: `c${n}`, n, title, cwd, model: null, effort: null, session: null, at: Date.now() };
    st.convs[c.id] = c;
    st.cur = c.id;
    save();
    return c;
  };
  const current = () => st.convs[st.cur] ?? newConv();

  // ------------------------------------------------------------------- WAHA --

  const waha = async (method, path, body) => {
    const r = await fetch(conf.waha + path, {
      method,
      headers: { "X-Api-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60 * SEC),
    });
    if (!r.ok) throw new Error(`WAHA ${method} ${path.split("?")[0]}: ${r.status}`);
    return r;
  };
  /** Sent to the group, as a reply to replyTo; each message remembered as the conversation's. */
  const say = async (text, replyTo, conv) => {
    for (const [i, p] of pieces(whatsappText(text)).entries()) {
      const r = await waha("POST", "/api/sendText", { session: conf.session, chatId: conf.group, text: p, linkPreview: false, ...(i === 0 && replyTo ? { reply_to: replyTo } : {}) });
      const sent = await r.json().catch(() => null);
      const id = shortId(sent?.id ?? sent?.key?.id ?? "");
      if (conv && id) st.sent[id] = conv.id;
    }
    if (conv) save();
  };
  const typing = (on) => waha("POST", on ? "/api/startTyping" : "/api/stopTyping", { session: conf.session, chatId: conf.group }).catch(() => {});

  // ------------------------------------------------------- what they send --

  /** A file they sent, saved where Claude works: its path, or null. */
  const keep = async (m) => {
    const url = m.media?.url;
    if (!url) return null;
    const u = new URL(url);
    const r = await waha("GET", u.pathname + u.search);
    const name = String(m.media.filename || u.pathname.split("/").pop() || "file").replace(/[^\w.\-]+/g, "_").slice(-80);
    if (!existsSync(inbox)) {
      mkdirSync(inbox, { recursive: true });
      mine(inbox);
    }
    const file = join(inbox, `${m.timestamp}-${name}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    mine(file);
    return file;
  };

  /** A voice note written out with the server's Whisper (on the server, nothing sent anywhere). */
  const transcribe = (file) =>
    new Promise((done) => {
      const py = [
        "import sys",
        "from faster_whisper import WhisperModel",
        `m = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=2, download_root=${JSON.stringify(conf.whisperModels)}, local_files_only=True)`,
        // The language is found by Whisper; the hint keeps these words spelled as they are.
        `segs, info = m.transcribe(sys.argv[1], vad_filter=True, beam_size=5, initial_prompt=${JSON.stringify("Claude, skills, GitHub, Google Drive, code, VPS, chat.")})`,
        "print(' '.join(s.text.strip() for s in segs))",
      ].join("\n");
      const child = spawn("nice", [conf.whisper, "-c", py, file], { env: { HF_HUB_OFFLINE: "1", PATH: "/usr/bin:/bin" } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => done(null));
      child.on("close", (code) => done(code === 0 ? out.trim() : null));
    });

  /** Their message as Claude gets it: the words, what it replies to, a voice note written out, a file's path. */
  const words = async (m) => {
    let text = String(m.body ?? "").trim();
    if (m.hasMedia) {
      const full = await waha("GET", `/api/${conf.session}/chats/${encodeURIComponent(conf.group)}/messages?limit=30&downloadMedia=true`)
        .then((r) => r.json())
        .then((all) => all.find((x) => x.id === m.id));
      const file = full ? await keep(full).catch((e) => (console.error("relay file", e.message), null)) : null;
      const type = String(full?.media?.mimetype ?? "");
      if (file && /^audio\//.test(type)) {
        const said = await transcribe(file);
        text = said ? `[voice note, written out by machine: a word may be wrong, read it for what they mean] ${said}${text ? `\n${text}` : ""}` :`${text}\n[a voice note that couldn't be written out, saved at ${file}]`;
      } else if (file) {
        text += `\n[they sent ${/^image\//.test(type) ? "a photo" : "a file"}, saved at ${file}${type ? ` (${type})` : ""}]`;
      } else text += "\n[they sent a file that couldn't be saved]";
    }
    if (m.replyTo?.body) text = `[replying to: "${String(m.replyTo.body).slice(0, 800)}"]\n${text}`;
    return text.trim();
  };

  // ----------------------------------------------------------------- Claude --

  const runs = new Map(); // conversation id -> {child, started, step}
  const waiting = []; // [{conv, m, text, plan}]

  /** One request to Claude in a conversation: its answer, or why there's none. Its latest step kept on the run. */
  const ask = (conv, text, plan) =>
    new Promise((done) => {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        plan ? "plan" : "bypassPermissions",
        "--append-system-prompt",
        SYSTEM,
        ...(conv.model ? ["--model", conv.model] : []),
        ...(conv.effort ? ["--settings", JSON.stringify({ effortLevel: conv.effort })] : []),
        ...(conv.session ? ["--resume", conv.session] : []),
      ];
      const child = spawn(conf.claude, args, {
        cwd: conv.cwd,
        uid,
        gid,
        env: { HOME: home, USER: conf.user, LOGNAME: conf.user, LANG: "C.UTF-8", PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin` },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const run = { child, started: Date.now(), step: null };
      runs.set(conv.id, run);
      let buf = "";
      let err = "";
      let result = null;
      let session = conv.session;
      child.stdout.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.session_id) session = ev.session_id;
          if (ev.type === "result") result = ev;
          if (ev.type === "assistant") {
            for (const c of ev.message?.content ?? []) {
              if (c.type === "tool_use") run.step = stepOf(c.name, c.input);
            }
          }
        }
      });
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), conf.maxRun);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        runs.delete(conv.id);
        if (result && typeof result.result === "string" && !result.is_error) return done({ text: result.result, session });
        const why = String(result?.result || err || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
        done({ failed: signal ? `stopped (${run.stopped ? "/stop" : signal === "SIGTERM" ? "it took too long" : signal})` : why || `exited with code ${code}`, session });
      });
      child.stdin.end(text);
    });

  /** A request in its conversation, start to answer: typing, a word on what it's doing when it's long, the answer. */
  const handle = async ({ conv, m, text, plan }) => {
    const tag = () => (st.cur !== conv.id ? `[#${conv.n} ${conv.title || ""}]\n`.replace(" ]", "]") : "");
    let told = 0;
    let last = null;
    const tick = setInterval(() => {
      void typing(true);
      const run = runs.get(conv.id);
      if (!run) return;
      const secs = (Date.now() - run.started) / SEC;
      // A word at 45 seconds, then every 3 minutes when the step changed.
      if ((told === 0 && secs >= 45) || (told > 0 && Date.now() - told >= 3 * MIN && run.step !== last)) {
        told = Date.now();
        last = run.step;
        void say(`${tag()}⏳ Working (${Math.round(secs / 60) || "<1"} min)${run.step ? `: ${run.step}` : ""}`, m.id, conv).catch(() => {});
      }
    }, 15 * SEC);
    void typing(true);
    if (!conv.title) conv.title = text.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").slice(0, 40);
    let r = await ask(conv, text, plan);
    // A conversation Claude no longer has: a new one, in the same folder.
    if (r.failed && conv.session && /no conversation found/i.test(r.failed)) {
      conv.session = null;
      r = await ask(conv, text, plan);
    }
    clearInterval(tick);
    void typing(false);
    conv.session = r.session ?? conv.session;
    conv.at = Date.now();
    save();
    const after = plan && !r.failed ? "\n\n(This is only a plan. Say go to start.)" : "";
    await say(`${tag()}${r.failed ? `❌ Didn't finish: ${r.failed}` : (r.text || "(no reply)") + after}`, m.id, conv);
  };

  /** What's waiting starts as soon as its conversation is free and fewer than the limit are running. */
  const drain = () => {
    for (let i = 0; i < waiting.length && runs.size < conf.parallel; i++) {
      const job = waiting[i];
      if (runs.has(job.conv.id) || waiting.slice(0, i).some((w) => w.conv.id === job.conv.id)) continue;
      waiting.splice(i--, 1);
      // Taken now, so drain doesn't start it twice before ask has.
      runs.set(job.conv.id, { child: null, started: Date.now(), step: null });
      handle(job)
        .catch(async (e) => {
          console.error("relay", e.message);
          await say(`❌ Something went wrong: ${e.message}`, job.m.id, job.conv).catch(() => {});
        })
        .finally(() => {
          runs.delete(job.conv.id);
          drain();
        });
    }
  };

  // --------------------------------------------------------------- commands --

  const inHome = (arg) => {
    const p = resolve(isAbsolute(arg) || arg.startsWith("~") ? arg.replace(/^~/, home) : join(work, arg));
    return p === home || !relative(home, p).startsWith("..") ? p : null;
  };

  const command = async ({ name, arg }, m) => {
    const conv = current();
    switch (name) {
      case "help":
        return say(HELP, m.id);
      case "new":
      case "clear": {
        const c = newConv(conv.cwd, arg);
        c.model = conv.model;
        c.effort = conv.effort;
        save();
        return say(`✅ New chat #${c.n}${arg ? ` ${arg}` : ""}\n📁 ${c.cwd.replace(home, "~")}`, m.id, c);
      }
      case "chats":
        return say(chatsList(st.convs, st.cur, home), m.id);
      case "switch":
      case "resume": {
        const c = Object.values(st.convs).find((x) => String(x.n) === arg.replace(/^#/, ""));
        if (!c) return say(`No chat #${arg}. /chats lists them.`, m.id);
        st.cur = c.id;
        save();
        return say(`▶ #${c.n} ${c.title || ""}\n📁 ${c.cwd.replace(home, "~")}`, m.id, c);
      }
      case "rename":
        if (!arg) return say("/rename name", m.id);
        conv.title = arg.slice(0, 60);
        save();
        return say(`✅ #${conv.n} is now: ${conv.title}`, m.id, conv);
      case "cd": {
        if (!arg) return say(`📁 ${conv.cwd.replace(home, "~")}`, m.id, conv);
        const p = inHome(arg);
        if (!p) return say("The folder must be inside ~", m.id);
        if (existsSync(p) && !statSync(p).isDirectory()) return say("That's a file, not a folder.", m.id);
        if (!existsSync(p)) {
          mkdirSync(p, { recursive: true });
          for (let d = p; d !== home && d.startsWith(home); d = resolve(d, "..")) mine(d);
        }
        const c = newConv(p);
        c.model = conv.model;
        c.effort = conv.effort;
        save();
        return say(`📁 ${p.replace(home, "~")}\n✅ New chat #${c.n} in this folder`, m.id, c);
      }
      case "model":
        conv.model = arg || null;
        save();
        return say(`✅ Model in #${conv.n}: ${conv.model ?? "the default"}`, m.id, conv);
      case "effort":
        if (arg && !/^(low|medium|high|xhigh|max)$/.test(arg)) return say("/effort low | medium | high | xhigh | max", m.id);
        conv.effort = arg || null;
        save();
        return say(`✅ Effort in #${conv.n}: ${conv.effort ?? "the default"}`, m.id, conv);
      case "plan":
        if (!arg) return say("/plan then your request", m.id);
        waiting.push({ conv, m, text: await words({ ...m, body: arg }), plan: true });
        return drain();
      case "status": {
        const lines = Object.values(st.convs)
          .filter((c) => runs.has(c.id) || waiting.some((w) => w.conv.id === c.id))
          .map((c) => {
            const r = runs.get(c.id);
            const q = waiting.filter((w) => w.conv.id === c.id).length;
            return `#${c.n} ${c.title || ""}: ${r ? `working ${Math.round((Date.now() - r.started) / MIN)} min${r.step ? ` · ${r.step}` : ""}` : "waiting"}${q ? ` · ${q} queued` : ""}`;
          });
        return say(`▶ #${conv.n} ${conv.title || ""}\n📁 ${conv.cwd.replace(home, "~")}\n🧠 ${conv.model ?? "the default model"}${conv.effort ? ` · effort ${conv.effort}` : ""}\n\n${lines.join("\n") || "Nothing running."}`, m.id);
      }
      case "stop": {
        const before = waiting.length;
        for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].conv.id === conv.id) waiting.splice(i, 1);
        const r = runs.get(conv.id);
        if (r?.child) {
          r.stopped = true;
          r.child.kill("SIGTERM");
          return;
        }
        return say(before !== waiting.length ? "✅ Removed what was waiting." : "Nothing running in this chat.", m.id);
      }
    }
  };

  // ------------------------------------------------------------------- loop --

  const poll = async () => {
    try {
      const r = await waha("GET", `/api/${conf.session}/chats/${encodeURIComponent(conf.group)}/messages?limit=20&downloadMedia=false`);
      const seen = new Set(st.seen);
      const fresh = newFromOwner(await r.json(), conf.owners, seen).filter((m) => (m.timestamp ?? 0) >= st.since);
      if (!fresh.length) return;
      for (const m of fresh) st.seen.push(String(m.id));
      st.since = Math.max(st.since, ...fresh.map((m) => m.timestamp ?? 0));
      save();
      for (const m of fresh) {
        try {
          const c = commandOf(m.body);
          if (c) {
            await command(c, m);
            continue;
          }
          // A reply to one of Claude's messages goes on in that conversation.
          const to = m.replyTo?.id ? st.convs[st.sent[shortId(m.replyTo.id)] ?? ""] : null;
          const conv = to ?? current();
          const text = await words(m);
          if (!text) continue;
          waiting.push({ conv, m, text, plan: false });
          drain();
        } catch (e) {
          console.error("relay", e.message);
          await say(`❌ Something went wrong: ${e.message}`, m.id).catch(() => {});
        }
      }
    } catch (e) {
      console.error("relay poll", e.message);
    }
  };

  if (!existsSync(work)) {
    mkdirSync(work, { recursive: true });
    mine(work);
  }
  save();
  console.log(JSON.stringify({ ev: "relay.start", group: conf.group, owners: conf.owners.size, convs: Object.keys(st.convs).length }));
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    await poll();
    busy = false;
  }, 2 * SEC);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
