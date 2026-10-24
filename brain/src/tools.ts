// The iklipse tools Claude sees, as one in-process MCP server ("iklipse"):
// each one of the function's tools (brain-tools.ts) called for this run and
// as its asker, and the brain's own GitHub tools (github.ts). Only the tools
// of the asker's tier are on it. What comes back is information: the
// function decides what's allowed and what waits for the owner's OK.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BotClient } from "./bot.js";
import { describe as describeHeld, openPr, pushBranch, status, type GitHub } from "./github.js";
import { OWN_TOOLS, SERVER_TOOLS, type Tier } from "./policy.js";

export interface RunRef {
  id: string;
  asker: string;
  tier: Tier;
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const said = (v: unknown): Result => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const failed = (m: string): Result => ({ content: [{ type: "text", text: m }], isError: true });

const why = z.string().describe("Why this is needed, one line: the owner reads it with the OK request.");
const person = z.string().describe("Their profile.id (find them in profile, is_active true).");
const ymd = z.string().describe("YYYY-MM-DD");
const hhmm = z.string().describe("HH:MM, 24 hours");

/** The function's tools: name, what Claude reads, what it takes. */
const SERVER = {
  find: {
    about: "Read rows from one table of iklipse (the tables and how they connect are in your instructions). Several finds in one turn run together. Only what this person may read comes back.",
    shape: {
      table: z.string(),
      columns: z.array(z.string()).optional().describe("The columns to get; all when empty."),
      where: z
        .array(z.object({ column: z.string(), op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "in", "is"]), value: z.any() }))
        .optional()
        .describe("Filters, all must hold. ilike: contains. in: a list. is: null, true or false."),
      search: z.object({ columns: z.array(z.string()), text: z.string() }).optional().describe("Words in any of these columns."),
      order: z.object({ column: z.string(), desc: z.boolean().optional() }).optional(),
      limit: z.number().int().optional().describe("At most 100; 30 when not given."),
      count: z.boolean().optional().describe("Only how many rows match."),
    },
  },
  search: {
    about:
      "What people said, by meaning and words, in any language (a question in English finds Egyptian Arabic and Franco-Arabic too), in the WhatsApp groups, the bot's private chats, email, Slack, files and recorded meetings this person may read. For exact lookups use find.",
    shape: {
      text: z.string().describe("What to look for, in a few words."),
      in: z.array(z.enum(["groups", "private", "email", "slack", "files", "meetings"])).optional().describe("Where; everywhere when empty."),
      since: z.string().optional().describe("Only since this day or time (ISO 8601, Cairo's offset)."),
      limit: z.number().int().optional().describe("Up to 30 (12 when not given)."),
    },
  },
  overview: { about: "What's going on now: open alerts, meetings, orders, deliveries due soon, who's working today, and who's who (the team, freelancers, partners).", shape: {} },
  free_times: {
    about: "The free times on the asker's calendar inside Calendly, on the days given, or the earliest. Only reads; meeting books.",
    shape: {
      days: z.array(ymd).optional().describe("At most 7. Empty: the earliest free time."),
      minutes: z.number().int().optional(),
      search: z.enum(["", "earliest", "nearest_day"]).optional(),
    },
  },
  reminders: { about: "The asker's open reminders (set by them or for them), numbered, in their time zone.", shape: {} },
  boards_tools: { about: "The Trello and Miro board tools there are (names, what they do, what they take), as the asker sees them. Then use boards.", shape: {} },
  boards: {
    about: "Use one Trello or Miro board tool (see boards_tools) as the asker, with exactly their permissions in the app. Nothing can be deleted through them.",
    shape: { tool: z.string().describe("The board tool's name."), arguments: z.record(z.string(), z.any()).optional() },
  },
  taught: { about: "What the team taught the bot (notes), numbered for good.", shape: {} },
  brain_log: { about: "What the brain did: its runs (who asked what, the outcome, the cost) and the tools each used, today or the last few days.", shape: { days: z.number().int().optional().describe("1 to 7, 1 when not given (today).") } },
  message_team_member: {
    about:
      "Write privately on WhatsApp to someone on the team: tell them to do something (or pass something on), or ask them something and bring the answer back. The bot follows up until it's done or answered. Once per person per request: put everything for them in one message.",
    shape: {
      person,
      kind: z.enum(["tell", "ask"]),
      task: z.string().describe("What they're to do, or asked, short, in English."),
      message: z.string().describe('The first message to them, in English: "Hi <first name>, <asker\'s first name> asks you to <task>." Never invent a date, a file, a price or a promise.'),
      nudge: z.string().describe("The reminder if they don't answer, short."),
      wait: z.boolean().describe("false when it only passes something on (no follow-up)."),
    },
  },
  set_reminder: {
    about: "Remind someone privately on WhatsApp at a time or after a while: the asker (person \"me\") or someone on the team. Give the time exactly as said; the day and time are worked out and said back.",
    shape: {
      person: z.string().describe('"me", or their profile.id.'),
      text: z.string().describe("What to remind them of, short, in English."),
      date: z.string().optional().describe("YYYY-MM-DD, only when a day was said."),
      time: z.string().optional().describe("HH:MM exactly as said (5 is 05:00)."),
      ampm: z.enum(["", "am", "pm"]).optional().describe("Only when the words say it."),
      in_minutes: z.number().int().optional().describe('"in 30 minutes": 30.'),
      any_time: z.boolean().optional().describe("Someone else's reminder may go outside working hours: only when they said so."),
    },
  },
  cancel_reminders: { about: "Cancel the asker's reminders by their numbers in reminders, or all.", shape: { which: z.array(z.string()).describe('Numbers ("1", "3"), or ["all"].') } },
  close_alert: {
    about: "Close an open alert as handled, when what it's about was dealt with (admins any; members the ones that ring them; an email alert only with its mailbox). Find it first in watch_alert.",
    shape: { alert: z.string().describe("watch_alert.id"), note: z.string().optional().describe("How it was dealt with, short.") },
  },
  alert_pause: {
    about: "Pause an open WhatsApp or Slack alert until a time or for a while, resume it, or remind people about it every so often (or stop that).",
    shape: {
      alert: z.string().describe("watch_alert.id"),
      until_date: z.string().optional(),
      until_time: z.string().optional(),
      until_ampm: z.string().optional(),
      pause_minutes: z.number().int().optional(),
      resume: z.boolean().optional(),
      every_min: z.number().int().optional(),
      people: z.array(z.string()).optional().describe("profile ids to remind"),
      also: z.boolean().optional().describe("The people named come on top of the ones already reminded."),
      stop: z.boolean().optional(),
    },
  },
  post_in_group: {
    about: "Post a message in a WhatsApp group the bot is in, tagging people on the team. A client's group waits for the owner's OK.",
    shape: { group: z.string().describe("The group's name."), text: z.string(), tag: z.array(z.string()).optional().describe("profile ids to tag"), why: why.optional() },
  },
  meeting: {
    about:
      "Book, move or cancel a meeting on the asker's Calendly, the way the bot does when asked (check free_times first). Team members by their profile.id; anyone else by full name. With a client, and any cancelling, it waits for the owner's OK.",
    shape: {
      action: z.enum(["book", "move", "cancel"]),
      with: z.array(z.string()).describe("profile ids, or full names as iklipse has them"),
      date: ymd,
      time: hhmm,
      minutes: z.number().int().optional(),
      topic: z.string().optional(),
      new_date: ymd.optional(),
      new_time: hhmm.optional(),
      why: why.optional(),
    },
  },
  message_client: {
    about:
      "Write to a client (or a freelancer, or a partner's person) on WhatsApp. It always waits for the owner's OK, then goes exactly as written. English, short, only what's theirs: never anyone else's numbers, emails, prices or names, never a promise the team didn't make.",
    shape: { client: z.string().describe("client.id, or their full name as iklipse has it."), text: z.string(), why },
  },
  remember: { about: "Remember facts or standing instructions the owner or an admin taught (\"remember that ...\"): kept as notes for every later conversation.", shape: { notes: z.array(z.string()).describe("Each one short line.") } },
  forget: { about: "Forget taught notes by their numbers (see taught).", shape: { numbers: z.array(z.string()) } },
  bot_settings: {
    about: "Change values in Alerts > Settings (watch_settings columns, never a token or key). Waits for the owner's OK.",
    shape: { patch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), why },
  },
  brain_settings: {
    about: "Change the brain's own settings: phase (0 owner, 1 admins too, 2 members too), model_owner, model_member, model_fast, max_turns, member_turns, run_minutes, run_cost_usd, day_cost_usd. Waits for the owner's OK.",
    shape: { patch: z.record(z.string(), z.union([z.string(), z.number()])), why },
  },
} satisfies Record<keyof typeof SERVER_TOOLS, { about: string; shape: Record<string, z.ZodTypeAny> }>;

/** The brain's own tools: what Claude reads, what it takes. */
const OWN = {
  github_status: {
    about: "GitHub: open PRs (default), one PR with its checks (pr), the latest Actions runs (runs), or the deploys (deploys).",
    shape: { what: z.enum(["prs", "pr", "runs", "deploys"]).optional(), number: z.number().int().optional() },
  },
  push_branch: { about: "Push what's checked out in the working copy to a branch of its own (never main, never forced).", shape: { branch: z.string() } },
  open_pr: {
    about: "Open a PR from a pushed branch into main. Then tell the owner the summary, the files changed and the link.",
    shape: { branch: z.string(), title: z.string(), body: z.string().describe("What changed and why, what was tested and what wasn't.") },
  },
  merge_pr: { about: "Merge a PR into main once its checks pass. Waits for the owner's OK.", shape: { number: z.number().int(), why } },
  deploy: {
    about: "Deploy main to Supabase through GitHub Actions: the functions (whatsapp-bot by default), the database migrations (db), or both (all). Waits for the owner's OK.",
    shape: { target: z.enum(["functions", "db", "all"]), functions: z.array(z.string()).optional(), why },
  },
  rollback: { about: "Deploy the functions as they were at the deploy before the last one. Waits for the owner's OK.", shape: { functions: z.array(z.string()).optional(), why } },
  deploy_brain: { about: "Update the brain itself to main, with a health check and a rollback if it fails. Waits for the owner's OK.", shape: { why } },
} satisfies Record<keyof typeof OWN_TOOLS, { about: string; shape: Record<string, z.ZodTypeAny> }>;

export const OWN_ABOUT = OWN;

/** The "iklipse" MCP server for one run: the tools of the asker's tier only. */
export function iklipseServer(o: { bot: BotClient; run: RunRef; github: GitHub | null }) {
  const { bot, run, github } = o;
  const tools = [];
  for (const [name, def] of Object.entries(SERVER)) {
    const rule = SERVER_TOOLS[name]!;
    if (!rule.tiers.includes(run.tier)) continue;
    tools.push(
      tool(
        name,
        def.about,
        def.shape,
        async (args) => {
          try {
            const r = await bot.call<{ data: unknown }>(name, { run_id: run.id, acting_as: run.asker, input: args });
            return said(r.data);
          } catch (e) {
            return failed((e as Error).message);
          }
        },
        { annotations: { readOnlyHint: rule.readOnly }, alwaysLoad: true },
      ),
    );
  }
  for (const [name, def] of Object.entries(OWN)) {
    const rule = OWN_TOOLS[name]!;
    if (!rule.tiers.includes(run.tier) || !github) continue;
    tools.push(
      tool(
        name,
        def.about,
        def.shape,
        async (args) => {
          try {
            const a = args as Record<string, any>;
            if (name === "github_status") return said(await status(github, a));
            if (name === "push_branch") return said(await pushBranch(github, a as { branch: string }));
            if (name === "open_pr") return said(await openPr(github, a as { branch: string; title: string; body: string }));
            // Held: hooks.ts asks the owner before this is ever reached; here it's never done.
            await describeHeld(github, name, a);
            return failed("This waits for the owner's OK: it was asked for, and nothing was done yet.");
          } catch (e) {
            return failed((e as Error).message);
          }
        },
        { annotations: { readOnlyHint: rule.readOnly }, alwaysLoad: true },
      ),
    );
  }
  return createSdkMcpServer({ name: "iklipse", version: "0.1.0", tools });
}
