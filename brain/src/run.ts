// One message, one run: what the function says about it (_start: who asks,
// their tier's model and limits, the day's spend), the chat's session carried
// on or started fresh, Claude on the Agent SDK with only that tier's tools,
// then the answer in the chat and the run's numbers kept (_finish).
//
// Limits, in code: turns (maxTurns), the run's cost (maxBudgetUsd), its time
// (aborted after run_minutes), the day's spend (checked at the start, the
// owner warned at 80% by the function), one run at a time per chat and a few
// at once in all. The kill switch aborts every run; until "start" the brain
// only reads. A run that takes a while says so once ("On it.").

import { query as sdkQuery, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import type { BotClient } from "./bot.js";
import type { Config } from "./config.js";
import type { GitHub } from "./github.js";
import { hooksFor } from "./hooks.js";
import { allowedToolsFor, builtinsFor, devRun, DISALLOWED, WEB_HOSTS, type Tier } from "./policy.js";
import { listSkills, pluginsFor } from "./skills.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { brainInstructions, promptFor, runInstructions, runNotes, type Incoming, type Start } from "./prompt.js";
import { pick, sessionKey, type Exchange, type Sessions } from "./sessions.js";
import { noDashes, parts, progressLine } from "./text.js";
import { iklipseServer } from "./tools.js";

export type Query = (p: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface RunnerDeps {
  cfg: Config;
  bot: BotClient;
  sessions: Sessions;
  github: GitHub | null;
  /** The Anthropic key stays in this process: Claude Code reaches the API through it (proxy.ts). */
  proxy: { url: string; token: string };
  query?: Query;
  now?: () => number;
  log?: (e: Record<string, unknown>) => void;
  /** After this long a run says it's on it (20 s). */
  progressMs?: number;
  /** A chat's messages are gathered this long after the last one, then answered together (60 s; 0: each at once). */
  gatherMs?: number;
}

const GATHER_MS = 60_000;

type Status = "done" | "failed" | "stopped" | "timeout" | "budget";

/** What's said when a run doesn't end with an answer (always English). */
const ENDS: Record<Exclude<Status, "done">, string> = {
  failed: "Something went wrong on my side before I could finish. Ask again in a minute.",
  stopped: "Stopped: the super admin switched me off. I only read until they say start.",
  timeout: "That took too long, so I stopped. Ask for a smaller part of it.",
  budget: "That hit the limit for one request before I finished. Ask for a smaller part of it.",
};
/** Cut off by the brain going down for an update, not by the super admin. */
const RESTART = "I was restarting for an update and got cut off. Send it again.";
const endText = (s: Exclude<Status, "done">) => ENDS[s];
/** The answer that says nothing goes (CLAUDE.md): NO_REPLY alone. */
export const SILENT = /^\s*NO_REPLY[.!]?\s*$/;
/** How much Claude read for its last step: the conversation's size so far, in tokens. */
const contextOf = (u: { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined) =>
  (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
const capText = (_request: string) =>"I've reached today's spending limit. I'm back tomorrow, or once the super admin raises the limit.";

/**
 * What a session begins under: the instructions (CLAUDE.md), the code's
 * version and the skills there are. Any of them changed: a fresh session
 * (sessions.ts pick), so an old conversation doesn't carry old rules on.
 */
export function instructionsVersion(stateDir: string, deployDir?: string): string {
  const skills = listSkills(stateDir).map((x) => `${x.name}:${x.description}`).join("|");
  // The commit the server runs (deploy/update.sh): a new one, maybe new tools and rules.
  const release = deployDir && existsSync(join(deployDir, "current")) ? readFileSync(join(deployDir, "current"), "utf8").trim() : "";
  return createHash("sha256").update(brainInstructions()).update(VERSION).update(release).update(skills).digest("hex").slice(0, 16);
}
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

/** Claude Code's environment: no secret in it but the proxy's token (useless off this machine). */
export function childEnv(cfg: Config, proxy: { url: string; token: string }): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: join(cfg.stateDir, "home"),
    CLAUDE_CONFIG_DIR: join(cfg.stateDir, "claude"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    // A chat read from the cache for an hour, not 5 minutes: people answer minutes apart.
    ENABLE_PROMPT_CACHING_1H: "1",
    // The shell can't write to HOME (the sandbox): npm's cache in /tmp, and commits signed as the brain.
    npm_config_cache: "/tmp/brain-npm",
    XDG_CACHE_HOME: "/tmp/brain-cache",
    GIT_AUTHOR_NAME: "iklipse brain",
    GIT_AUTHOR_EMAIL: "brain@iklipse.invalid",
    GIT_COMMITTER_NAME: "iklipse brain",
    GIT_COMMITTER_EMAIL: "brain@iklipse.invalid",
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_API_KEY: proxy.token,
    CLAUDE_AGENT_SDK_CLIENT_APP: "iklipse-brain/0.1",
  };
}

/** The shell's sandbox: writes only in the working copy, the network only to these hosts, the brain's own files unread. */
export function sandboxFor(cfg: Config): NonNullable<Options["sandbox"]> {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [
        "github.com",
        "*.github.com",
        "*.githubusercontent.com",
        "registry.npmjs.org",
        "*.npmjs.org",
        "api.anthropic.com",
        cfg.supabaseHost,
        "supabase.com",
        ...(cfg.wahaHost ? [cfg.wahaHost] : []),
        ...WEB_HOSTS,
      ],
      allowLocalBinding: false,
    },
    filesystem: {
      allowWrite: [cfg.workdir, "/tmp"],
      denyRead: ["/run/credentials", "/etc/iklipse-brain", cfg.stateDir, cfg.deployDir, "~/.ssh", "/root", "/home"],
    },
  };
}

export class Runner {
  stopped = false;
  private chains = new Map<string, Promise<void>>();
  private gathering = new Map<string, { msgs: Incoming[]; timer: ReturnType<typeof setTimeout> | undefined }>();
  private active = new Map<string, { ac: AbortController; why: string | null }>();
  private seen: string[] = [];
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private d: RunnerDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private log(e: Record<string, unknown>) {
    (this.d.log ?? ((x) => console.log(JSON.stringify(x))))(e);
  }

  /** Runs going now. */
  get busy() {
    return this.active.size;
  }

  /**
   * A message from the function: gathered with the chat's others until it's
   * been quiet gatherMs, then queued behind its chat's run (one at a time per
   * chat). The same message twice is taken once; an edit stops the run it
   * corrects (if it's still going) and comes after it.
   */
  accept(m: Incoming): "accepted" | "duplicate" {
    const seen = `${m.run_id}:${m.edit ?? 0}`;
    if (this.seen.includes(seen)) return "duplicate";
    this.seen.push(seen);
    if (this.seen.length > 2000) this.seen.splice(0, 1000);
    const key = sessionKey(m);
    const waiting = this.gathering.get(key);
    if (m.edit) {
      // An edit of a message still gathering: it takes its place there.
      const i = waiting?.msgs.findIndex((x) => x.run_id === m.run_id) ?? -1;
      if (waiting && i >= 0) {
        waiting.msgs[i] = { ...m, edit: undefined };
        return "accepted";
      }
      this.abort(m.run_id, "edited");
    }
    // Several messages in a row: answered once, together, a minute after the last. A client's are
    // gathered by the function already (reply_quiet_sec).
    const wait = this.d.gatherMs ?? GATHER_MS;
    if (wait > 0 && !m.edit && m.sender.tier !== "client") {
      const g = waiting ?? { msgs: [], timer: undefined };
      clearTimeout(g.timer);
      g.msgs.push(m);
      g.timer = setTimeout(() => {
        this.gathering.delete(key);
        this.enqueue(key,this.together(g.msgs));
      }, wait);
      this.gathering.set(key, g);
      return "accepted";
    }
    this.enqueue(key,m);
    return "accepted";
  }

  /**
   * Messages gathered: one request, on the last one's run (its reply quotes it).
   * The earlier runs end there, answered by it.
   */
  private together(msgs: Incoming[]): Incoming {
    const last = msgs.at(-1)!;
    if (msgs.length === 1) return last;
    for (const e of msgs.slice(0, -1))
      void this.d.bot.call("_finish", { run_id: e.run_id, status: "done", ms: 0, error: null }).catch((err) => this.log({ ev: "brain.finish_failed", run: e.run_id, why: (err as Error).message }));
    return {
      ...last,
      text: msgs.map((x) => x.text).filter(Boolean).join("\n"),
      quoted: last.quoted ?? [...msgs].reverse().find((x) => x.quoted)?.quoted ?? null,
      files: msgs.flatMap((x) => x.files ?? []).slice(0, 10),
    };
  }

  /** After its chat's run (one at a time per chat). */
  private enqueue(key: string, m: Incoming) {
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.slot(() => this.run(m)))
      .catch((e) => this.log({ ev: "brain.run_error", run: m.run_id, why: (e as Error).message }));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** The kill switch: every run stopped now; then only reading until it's off again. */
  setStopped(stopped: boolean) {
    this.stopped = stopped;
    if (stopped) for (const id of this.active.keys()) this.abort(id, "stopped");
  }

  /** Going down (an update): every run cut off, and said as that. */
  shutdown() {
    this.stopped = true;
    for (const id of this.active.keys()) this.abort(id, "restart");
  }

  private abort(runId: string, why: string) {
    const a = this.active.get(runId);
    if (!a) return;
    a.why ??= why;
    a.ac.abort(why);
  }

  /** At most maxRuns at once, in all chats. */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.d.cfg.maxRuns) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private async reply(m: Incoming, text: string) {
    const list = parts(text);
    for (let i = 0; i < list.length; i++) await this.d.bot.call("_reply", { run_id: m.run_id, text: list[i], quote: i === 0 });
  }

  private async finish(m: Incoming, x: { status: Status; turns?: number; cost_usd?: number; ms: number; session_id?: string; error?: string | null }) {
    await this.d.bot.call("_finish", { run_id: m.run_id, ...x }).catch((e) => this.log({ ev: "brain.finish_failed", run: m.run_id, why: (e as Error).message }));
    this.log({ ev: "brain.run", run: m.run_id, status: x.status, turns: x.turns ?? 0, cost_usd: x.cost_usd ?? 0, ms: x.ms });
  }

  /** What was said last time, summed up on the quick model; the lines themselves if that fails. */
  private async summarize(earlier: Exchange[], model: string): Promise<string> {
    const plain = earlier.map((e) => `- They: ${e.q}\n  You: ${e.a}`).join("\n");
    if (!earlier.length) return "";
    try {
      const q = (this.d.query ?? sdkQuery)({
        prompt: `Sum up this WhatsApp conversation in at most 5 short lines, keeping names, dates, times and numbers:\n${plain}`,
        options: {
          model,
          maxTurns: 1,
          tools: [],
          permissionMode: "dontAsk",
          settingSources: [],
          persistSession: false,
          cwd: this.d.cfg.emptyDir,
          env: childEnv(this.d.cfg, this.d.proxy),
          systemPrompt: "You sum up conversations briefly and exactly.",
          maxBudgetUsd: 0.05,
        },
      });
      for await (const msg of q) if (msg.type === "result" && msg.subtype === "success" && msg.result.trim()) return msg.result.trim();
    } catch {
      /* the lines themselves */
    }
    return plain;
  }

  async run(m: Incoming): Promise<void> {
    const started = this.now();
    const { bot, cfg, sessions } = this.d;
    let s: Start;
    try {
      s = await bot.call<Start>("_start", { run_id: m.run_id, ...(m.edit ? { edit: true } : {}) });
    } catch (e) {
      const why = (e as Error).message;
      // Over, or someone it no longer answers: said once, plainly.
      if (!/run is over/i.test(why)) await this.reply(m, why).catch(() => null);
      return await this.finish(m, { status: "failed", ms: this.now() - started, error: why });
    }
    if (s.over_cap) {
      await this.reply(m, capText(m.text)).catch(() => null);
      return await this.finish(m, { status: "budget", ms: this.now() - started });
    }

    const tier: Tier = s.asker.tier;
    // Changing the system (files, shell, GitHub, skills): the owner or an admin, in their private chat only.
    const staff = devRun(tier, m.where === "private" && m.reply_chat === m.chat_id && !m.chat_id.endsWith("@g.us"));
    const key = sessionKey(m);
    const chat = sessions.get(key);
    const v = instructionsVersion(cfg.stateDir, cfg.deployDir);
    const p = pick(chat, this.now(), v);
    const earlier = p.fresh ? await this.summarize(p.earlier, s.model_fast) : "";
    const run = { id: m.run_id, asker: s.asker.id, tier };

    const ac = new AbortController();
    const live = { ac, why: null as string | null };
    // Stopped (the kill switch) before it began: it still runs, reading only (hooks.ts, and the function).
    this.active.set(m.run_id, live);
    const timer = setTimeout(() => this.abort(m.run_id, "timeout"), s.run_minutes * 60_000);
    // A client isn't told the bot is "on it": the answer comes, or the team's.
    const progress = tier === "client" ? undefined : setTimeout(() => void this.d.bot.call("_reply", { run_id: m.run_id, text: progressLine(m.text), quote: true }).catch(() => null), this.d.progressMs ?? 20_000);

    let sessionId = p.resume;
    let context = 0;
    let result: SDKResultMessage | null = null;
    let error: string | null = null;
    try {
      const options: Options = {
        abortController: ac,
        model: s.model,
        maxTurns: s.max_turns,
        maxBudgetUsd: s.run_cost_usd,
        cwd: staff ? cfg.workdir : cfg.emptyDir,
        tools: builtinsFor(tier, staff),
        allowedTools: allowedToolsFor(tier, staff),
        // Skills (skills.ts): the repo's, caveman always among them, and the ones added on WhatsApp.
        plugins: pluginsFor(cfg.stateDir),
        skills: "all",
        disallowedTools: [...DISALLOWED, "Read(//proc/**)", "Read(//sys/**)", "Read(//etc/**)", "Read(//run/**)", "Read(//root/**)", "Read(~/.ssh/**)"],
        permissionMode: "dontAsk",
        settingSources: [],
        systemPrompt: staff ? { type: "preset", preset: "claude_code", append: runInstructions(s, m) } : runInstructions(s, m),
        mcpServers: { iklipse: iklipseServer({ bot, run, github: staff ? this.d.github : null, dev: staff, stateDir: cfg.stateDir }) },
        hooks: hooksFor({ tier, dev: staff, workdir: cfg.workdir, run, bot, github: staff ? this.d.github : null, stopped: () => this.stopped || s.stopped }),
        ...(staff ? { sandbox: sandboxFor(cfg) } : {}),
        env: childEnv(cfg, this.d.proxy),
        ...(p.resume ? { resume: p.resume } : {}),
        stderr: (line: string) => this.log({ ev: "claude.stderr", run: m.run_id, line: line.slice(0, 300) }),
      };
      for await (const msg of (this.d.query ?? sdkQuery)({ prompt: promptFor(m, runNotes(s, earlier)), options })) {
        if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
        if (msg.type === "assistant") context = contextOf(msg.message.usage);
        if (msg.type === "result") result = msg;
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      clearTimeout(timer);
      clearTimeout(progress);
      this.active.delete(m.run_id);
    }

    const why = live.why;
    const status: Status =
      why === "timeout" ? "timeout" : why ? "stopped" : result?.subtype === "success" ? "done" : result?.subtype === "error_max_budget_usd" || result?.subtype === "error_max_turns" ? "budget" : "failed";
    const answer = status === "done" && result?.subtype === "success" ? noDashes(result.result.trim()) : "";
    // Nothing to say (it wasn't for the bot, or a tool already said it): NO_REPLY, and nothing goes.
    const silent = status === "done" && SILENT.test(answer);
    // An edit takes over: the run it stopped says nothing.
    if (why !== "edited" && !silent) await this.reply(m, answer || (why === "restart" ? RESTART : endText(status === "done" ? "failed" : status))).catch((e) => this.log({ ev: "brain.reply_failed", run: m.run_id, why: (e as Error).message }));

    // A resumed session's cost goes on from where it was: this run's is the difference.
    const total = result?.total_cost_usd ?? 0;
    const prior = p.resume ? (chat?.cost ?? 0) : 0;
    const cost = total >= prior ? total - prior : total;
    if (sessionId) {
      sessions.put(key, {
        v: p.fresh ? v : (chat?.v ?? v),
        session: sessionId,
        at: this.now(),
        cost: total || (p.resume ? chat?.cost : 0),
        context,
        log: [...(p.fresh ? [] : chat?.log ?? []), { q: m.text.slice(0, 500), a: (answer || status).slice(0, 500), at: this.now() }],
      });
    }
    await this.finish(m, {
      status,
      turns: result?.num_turns ?? 0,
      cost_usd: Math.round(cost * 10_000) / 10_000,
      ms: this.now() - started,
      ...(sessionId ? { session_id: sessionId } : {}),
      error: status === "done" ? null : (error ?? (result && result.subtype !== "success" ? result.errors?.join("; ") : null) ?? why),
    });
  }
}
