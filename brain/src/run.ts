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
import { allowedToolsFor, builtinsFor, DISALLOWED, WEB_HOSTS, type Tier } from "./policy.js";
import { promptFor, runInstructions, type Incoming, type Start } from "./prompt.js";
import { pick, sessionKey, type Exchange, type Sessions } from "./sessions.js";
import { arabic, noDashes, parts, progressLine } from "./text.js";
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
}

type Status = "done" | "failed" | "stopped" | "timeout" | "budget";

/** What's said when a run doesn't end with an answer, in their language. */
const ENDS: Record<Exclude<Status, "done">, [string, string]> = {
  failed: ["Something went wrong on my side before I could finish. Ask again in a minute.", "حصلت مشكلة عندي قبل ما أخلص. اطلبها تاني كمان دقيقة."],
  stopped: ["Stopped: the owner switched me off. I only read until they say start.", "وقفت: صاحب الشغل قفلني. هقرا بس لحد ما يقول شغّل."],
  timeout: ["That took too long, so I stopped. Ask for a smaller part of it.", "أخدت وقت أكتر من اللازم فوقفت. اطلب جزء أصغر منها."],
  budget: ["That hit the limit for one request before I finished. Ask for a smaller part of it.", "وصلت للحد بتاع الطلب الواحد قبل ما أخلص. اطلب جزء أصغر منها."],
};
const endText = (s: Exclude<Status, "done">, request: string) => ENDS[s][arabic(request) ? 1 : 0];
const capText = (request: string) =>
  arabic(request) ? "وصلت للحد اليومي للصرف. هرجع بكرة، أو لما صاحب الشغل يرفع الحد." : "I've reached today's spending limit. I'm back tomorrow, or once the owner raises the limit.";

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
   * A message from the function: queued behind its chat's run (one at a time
   * per chat). The same message twice is taken once; an edit stops the run it
   * corrects (if it's still going) and comes after it.
   */
  accept(m: Incoming): "accepted" | "duplicate" {
    const seen = `${m.run_id}:${m.edit ?? 0}`;
    if (this.seen.includes(seen)) return "duplicate";
    this.seen.push(seen);
    if (this.seen.length > 2000) this.seen.splice(0, 1000);
    if (m.edit) this.abort(m.run_id, "edited");
    const key = sessionKey(m);
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.slot(() => this.run(m)))
      .catch((e) => this.log({ ev: "brain.run_error", run: m.run_id, why: (e as Error).message }));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return "accepted";
  }

  /** The kill switch: every run stopped now; then only reading until it's off again. */
  setStopped(stopped: boolean) {
    this.stopped = stopped;
    if (stopped) for (const id of this.active.keys()) this.abort(id, "stopped");
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
    const staff = tier !== "member";
    const key = sessionKey(m);
    const chat = sessions.get(key);
    const p = pick(chat, this.now());
    const earlier = p.fresh ? await this.summarize(p.earlier, s.model_fast) : "";
    const run = { id: m.run_id, asker: s.asker.id, tier };

    const ac = new AbortController();
    const live = { ac, why: null as string | null };
    // Stopped (the kill switch) before it began: it still runs, reading only (hooks.ts, and the function).
    this.active.set(m.run_id, live);
    const timer = setTimeout(() => this.abort(m.run_id, "timeout"), s.run_minutes * 60_000);
    const progress = setTimeout(() => void this.d.bot.call("_reply", { run_id: m.run_id, text: progressLine(m.text), quote: true }).catch(() => null), this.d.progressMs ?? 20_000);

    let sessionId = p.resume;
    let result: SDKResultMessage | null = null;
    let error: string | null = null;
    try {
      const options: Options = {
        abortController: ac,
        model: s.model,
        maxTurns: s.max_turns,
        maxBudgetUsd: s.run_cost_usd,
        cwd: staff ? cfg.workdir : cfg.emptyDir,
        tools: builtinsFor(tier),
        allowedTools: allowedToolsFor(tier),
        disallowedTools: [...DISALLOWED, "Read(//proc/**)", "Read(//sys/**)", "Read(//etc/**)", "Read(//run/**)", "Read(//root/**)", "Read(~/.ssh/**)"],
        permissionMode: "dontAsk",
        settingSources: [],
        systemPrompt: staff ? { type: "preset", preset: "claude_code", append: runInstructions(s, m, earlier) } : runInstructions(s, m, earlier),
        mcpServers: { iklipse: iklipseServer({ bot, run, github: staff ? this.d.github : null }) },
        hooks: hooksFor({ tier, workdir: cfg.workdir, run, bot, github: staff ? this.d.github : null, stopped: () => this.stopped || s.stopped }),
        ...(staff ? { sandbox: sandboxFor(cfg) } : {}),
        env: childEnv(cfg, this.d.proxy),
        ...(p.resume ? { resume: p.resume } : {}),
        stderr: (line: string) => this.log({ ev: "claude.stderr", run: m.run_id, line: line.slice(0, 300) }),
      };
      for await (const msg of (this.d.query ?? sdkQuery)({ prompt: promptFor(m), options })) {
        if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
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
    // An edit takes over: the run it stopped says nothing.
    if (why !== "edited") await this.reply(m, answer || endText(status === "done" ? "failed" : status, m.text)).catch((e) => this.log({ ev: "brain.reply_failed", run: m.run_id, why: (e as Error).message }));

    // A resumed session's cost goes on from where it was: this run's is the difference.
    const total = result?.total_cost_usd ?? 0;
    const prior = p.resume ? (chat?.cost ?? 0) : 0;
    const cost = total >= prior ? total - prior : total;
    if (sessionId) {
      sessions.put(key, {
        session: sessionId,
        at: this.now(),
        cost: total || (p.resume ? chat?.cost : 0),
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
