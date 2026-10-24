// Checked in code before any tool runs (a PreToolUse hook: before the
// permission rules, and it can't be talked around): the tool is for the
// asker's tier, the brain isn't stopped for a change, a shell command or a
// file stays in the working copy and away from secrets, a page is one of the
// docs sites. The brain's own actions (merging, deploying, rolling back,
// updating itself) are an admin's to ask for, privately (policy.ts devRun),
// and done by the tool itself (tools.ts, approvals.ts). What each tool did is
// kept as a step of the run (the function's tools keep their own).

import type { HookCallbackMatcher, HookEvent, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { BotClient } from "./bot.js";
import type { GitHub } from "./github.js";
import { bashVerdict, fetchVerdict, isHeld, MCP, OWN_TOOLS, pathVerdict, toolVerdict, type Tier } from "./policy.js";
import type { RunRef } from "./tools.js";

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]);

/** What a step says about its input: never a whole file or a secret. */
export function summary(tool: string, x: Record<string, unknown>): string {
  if (tool === "Bash") return String(x.command ?? "").slice(0, 300);
  if (FILE_TOOLS.has(tool)) return String(x.file_path ?? x.notebook_path ?? x.path ?? x.pattern ?? "").slice(0, 300);
  if (tool === "WebFetch") return String(x.url ?? "").slice(0, 300);
  if (tool === "TodoWrite") return "the to-do list";
  return JSON.stringify(x).slice(0, 300);
}

const deny = (why: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });

export function hooksFor(o: {
  tier: Tier;
  /** The owner or an admin, privately: files, the shell and the brain's own tools (policy.ts devRun). */
  dev?: boolean;
  workdir: string;
  run: RunRef;
  bot: BotClient;
  github: GitHub | null;
  /** The kill switch, as the brain knows it now. */
  stopped: () => boolean;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { tier, workdir, run, bot, github } = o;
  // The function keeps its own tools' steps; these are the rest.
  const ours = (tool: string) => !tool.startsWith(MCP) || !!OWN_TOOLS[tool.slice(MCP.length)];
  const step = (tool: string, x: Record<string, unknown>, outcome: string, detail?: string) => {
    if (!ours(tool)) return;
    void bot.call("_step", { run_id: run.id, tool: tool.replace(MCP, ""), input: summary(tool, x), outcome, detail: detail?.slice(0, 300) }).catch(() => null);
  };
  const refuse = (tool: string, x: Record<string, unknown>, why: string) => {
    step(tool, x, "denied", why);
    return deny(why);
  };

  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const tool = input.tool_name;
            const x = (input.tool_input ?? {}) as Record<string, unknown>;
            const v = toolVerdict(tool, tier, o.stopped(), o.dev ?? true);
            if (!v.ok) return refuse(tool, x, v.why);
            if (tool === "Bash") {
              if (x.dangerouslyDisableSandbox === true || x.run_in_background === true) return refuse(tool, x, "Commands run in the sandbox, and in the foreground.");
              const b = bashVerdict(String(x.command ?? ""), workdir);
              if (!b.ok) return refuse(tool, x, b.why);
            }
            if (FILE_TOOLS.has(tool)) {
              const p = pathVerdict(tool, x, workdir);
              if (!p.ok) return refuse(tool, x, p.why);
            }
            if (tool === "WebFetch") {
              const f = fetchVerdict(x.url);
              if (!f.ok) return refuse(tool, x, f.why);
            }
            if (isHeld(tool) && !github) return refuse(tool, x, "GitHub isn't set up on the brain.");
            return {};
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse") step(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, "ok");
            return {};
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUseFailure") step(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, "error", String((input as { error?: unknown }).error ?? ""));
            return {};
          },
        ],
      },
    ],
  };
}
