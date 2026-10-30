// The iklipse tools Claude sees, as one in-process MCP server ("iklipse"):
// each one of the function's tools (brain-tools.ts) called for this run and
// as its asker, and the brain's own GitHub tools (github.ts). Only the tools
// of the asker's tier are on it. What comes back is information: the
// function decides what's allowed. An admin's request is done at once.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BotClient } from "./bot.js";
import { carryOut } from "./approvals.js";
import { closePr, describe as describeHeld, installDeps, openPr, pushBranch, status, type GitHub } from "./github.js";
import { devRun, OWN_TOOLS, SERVER_TOOLS, type Tier } from "./policy.js";
import { addSkill, listSkills, removeSkill, SkillError } from "./skills.js";

export interface RunRef {
  id: string;
  asker: string;
  tier: Tier;
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const said = (v: unknown): Result => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const failed = (m: string): Result => ({ content: [{ type: "text", text: m }], isError: true });

const why = z.string().describe("Why this is needed, one line: kept with what was done.");
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
  orders: {
    about: "The orders going on: to them (from the team, through you) and the ones they gave you, open or stuck, with ids; all: true (admins) every open one.",
    shape: { all: z.boolean().optional() },
  },
  message_team_member: {
    about:
      'Write privately on WhatsApp to someone on the team: tell them to do something (or pass something on), or ask them something and bring the answer back. The bot follows up until it\'s done or answered. Once per person per request: put everything for them in one message. person "everyone": everyone on the team but the asker, each by name ({name} in message and nudge is each one\'s first name).',
    shape: {
      person: z.string().describe('Their profile.id (find them in profile, is_active true), or "everyone".'),
      kind: z.enum(["tell", "ask"]),
      task: z.string().describe("What they're to do, or asked, short, in English."),
      message: z.string().describe('The first message to them, in English: "Hi <first name>, <asker\'s first name> asks you to <task>." Never invent a date, a file, a price or a promise.'),
      nudge: z.string().describe("The reminder if they don't answer, short."),
      wait: z.boolean().describe("false when it only passes something on (no follow-up)."),
    },
  },
  set_reminder: {
    about:
      "Remind someone privately on WhatsApp at a time or after a while, once or repeating (every_minutes): the asker (person \"me\") or someone on the team. Give the time exactly as said; the day and time are worked out and said back. A repeating one with no time said starts now and goes on until cancel_reminders, its end (until_*) or its count (times).",
    shape: {
      person: z.string().describe('"me", or their profile.id.'),
      text: z.string().describe("What to remind them of, short, in English."),
      date: z.string().optional().describe("YYYY-MM-DD, only when a day was said."),
      time: z.string().optional().describe("HH:MM exactly as said (5 is 05:00)."),
      ampm: z.enum(["", "am", "pm"]).optional().describe("Only when the words say it."),
      in_minutes: z.number().int().optional().describe('"in 30 minutes": 30.'),
      any_time: z.boolean().optional().describe("Someone else's reminder may go outside working hours: only when they said so."),
      every_minutes: z.number().int().optional().describe('Repeating: how often in minutes ("every minute" 1, "every 2 hours" 120, "every day" 1440).'),
      times: z.number().int().optional().describe('Repeating: stop after this many ("5 times").'),
      until_date: z.string().optional().describe("Repeating: stop on this day, YYYY-MM-DD, only when said."),
      until_time: z.string().optional().describe("Repeating: stop at this time, HH:MM exactly as said."),
      until_ampm: z.enum(["", "am", "pm"]).optional().describe("Only when the words say it."),
      until_in_minutes: z.number().int().optional().describe('Repeating: stop after a while ("for an hour": 60).'),
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
  group_report: {
    about:
      "Report privately to someone on the team every so often, for a number of times or until stopped. About a WhatsApp group (group: what happened there, and whether the team wrote there, none said first so they can chase it), about one person's messages (sender, in one group when group is given, else in all), or about emails from someone (email: an address or name, in the mailboxes of the asker). Asked again for the same thing and person: changes it. stop: no more.",
    shape: {
      group: z.string().optional().describe("The group's name: the whole group, or only what sender wrote there."),
      sender: z.string().optional().describe("A person's name or number: report on what they write."),
      email: z.string().optional().describe("A sender's address or name: report on emails from them."),
      times: z.number().int().optional().describe("Stop after this many reports. Not said: until stopped."),
      person: z.string().describe('"me", or their profile.id.'),
      every_hours: z.number().int().optional().describe('How often in hours ("every 2 days" 48, "every day" 24). 48 when not said.'),
      first_at: z.string().optional().describe("When the first report goes, ISO 8601 with Cairo's offset, only when they said a day or time. Not said: one period from now."),
      stop: z.boolean().optional(),
    },
  },
  transcripts: {
    about:
      "Write out recordings (voice notes, audio files sent on WhatsApp; Fireflies meetings) into one .md file and send it here as a document. By wa_file ids, else the last ones (last, since) in this chat or the group named; meetings: fireflies_meeting ids.",
    shape: {
      files: z.array(z.string()).optional().describe("wa_file ids, in order."),
      group: z.string().optional().describe("A group's name: its recordings instead of this chat's."),
      last: z.number().int().optional().describe("How many of the latest recordings (10 when not said, 30 at most)."),
      since: z.string().optional().describe("Only since this time (ISO 8601, Cairo's offset)."),
      meetings: z.array(z.string()).optional().describe("fireflies_meeting ids."),
      title: z.string().optional().describe("The file's title."),
    },
  },
  post_in_group: {
    about: "Post a message in a WhatsApp group the bot is in, tagging people on the team. In a client's group the client reads it: only what's theirs.",
    shape: { group: z.string().describe("The group's name."), text: z.string(), tag: z.array(z.string()).optional().describe("profile ids to tag"), why: why.optional() },
  },
  meeting: {
    about:
      "Book, move or cancel a meeting on the asker's Calendly, or send someone the booking link (link), the way the bot does when asked (check free_times first). Team members by their profile.id; anyone else by full name. Never done on the first call: it's put to the asker, who has to say yes in their next message; then call it again with exactly the same details. Asked in a client group: only people in that group.",
    shape: {
      action: z.enum(["book", "move", "cancel", "link"]),
      with: z.array(z.string()).describe("profile ids, or full names as iklipse has them"),
      date: ymd.optional().describe("YYYY-MM-DD (not for link)"),
      time: hhmm.optional().describe("HH:MM, 24 hours (not for link)"),
      minutes: z.number().int().optional(),
      topic: z.string().optional(),
      new_date: ymd.optional(),
      new_time: hhmm.optional(),
      why: why.optional(),
    },
  },
  message_client: {
    about:
      "Write to a client (or a freelancer, or a partner's person) on WhatsApp, exactly as written. English, short, only what's theirs: never anyone else's numbers, emails, prices or names, never a promise the team didn't make.",
    shape: { client: z.string().describe("client.id, or their full name as iklipse has it."), text: z.string(), why },
  },
  remember: {
    about:
      "Remember facts or standing instructions the super admin or an admin taught (\"remember that ...\"): kept as notes for every later conversation. Someone said to be a client, a freelancer, a partner or not a client (people) is also moved where they belong in iklipse.",
    shape: {
      notes: z.array(z.string()).describe("Each one short line, people named in full."),
      replaces: z.array(z.string()).optional().describe("The numbers (from taught) of notes these change or contradict."),
      people: z
        .array(z.object({ name: z.string(), is: z.enum(["client", "freelancer", "partner", "not_client"]), client: z.string().optional().describe("client.id when they're in Clients"), member: z.string().optional().describe("profile.id when they're on the team") }))
        .optional(),
    },
  },
  forget: { about: "Forget taught notes by their numbers (see taught).", shape: { numbers: z.array(z.string()) } },
  order_update: {
    about:
      "Their own answer about an order to them (the ones listed to them in what's going on): done, an answer to an ask, what's in the way (blocked), they'll do it later, or a question back for the team. It goes to whoever gave it, where they gave it. Then answer them in a few words.",
    shape: {
      order: z.string().describe("The order's id."),
      result: z.enum(["done", "answer", "blocked", "later", "question"]),
      text: z.string().optional().describe("In English: what they said (their answer, what's in the way, their question). Needed for answer and question."),
      until: z.string().optional().describe("later: when they said, ISO 8601 with the Cairo offset."),
    },
  },
  order_follow: {
    about:
      "The team about an order the bot is carrying on (its id from orders or what's going on): relay (send the person something: an answer to their question, more details; to a client only what the team said), again (remind them now), done (close it), stop (stop following it up).",
    shape: { order: z.string(), action: z.enum(["relay", "again", "done", "stop"]), text: z.string().optional().describe("relay: the message to them, in English, exactly what the team means.") },
  },
  client_details: {
    about:
      "Save what they say about the clients on the bot's list of people it needs details for (by their number on the list): name, email, number, company; skip (stop asking about them); or team_member (that number is someone on the team).",
    shape: {
      list: z.string().optional().describe("The list's id, when what's going on gives one."),
      people: z.array(
        z.object({
          n: z.number().int().describe("Their number on the list."),
          name: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
          company: z.string().optional(),
          team_member: z.string().optional().describe("profile.id"),
          skip: z.boolean().optional(),
        }),
      ),
    },
  },
  client_chat: {
    about:
      "Answer the bot's question about someone's private chat (a client it couldn't answer alone; its id is in what's going on): send (the bot's own reply as it is; anyway: even though it was caught), own (send them this text, in English, only what the team said), or drop (don't reply).",
    shape: { question: z.string(), decision: z.enum(["send", "own", "drop"]), text: z.string().optional(), anyway: z.boolean().optional() },
  },
  client_meeting: {
    about:
      "A call with you, on the team's booking calendar: on the day and time they ask for (their own time), or, with no time, the free times and the booking link. What it says goes to them as it is; don't repeat it.",
    shape: { date: z.string().optional().describe("YYYY-MM-DD, empty when they gave no day"), time: z.string().optional().describe("HH:MM, 24 hours, their time; empty when none") },
  },
  ask_team: {
    about:
      "Ask the team when you can't answer from what you know, can't do what they ask, or it's risky (money, prices, quotes, contracts, a complaint, a date to promise). Then tell them, in a few words, that you're checking.",
    shape: {
      question: z.string().describe("What the team needs to decide, in English, short."),
      draft: z.string().optional().describe("The reply you'd send, for the team to OK; empty when you have none."),
      told_them: z.string().optional().describe("What you're telling them meanwhile."),
    },
  },
  team_member: {
    about:
      "Change someone on the team, as the Users page does: role (admin, member, guest), left (true: marked as left, false: back), name, WhatsApp number (the card's: replaces it; moved from whoever had it; empty to remove), add_whatsapp (another number next to theirs, nothing replaced), email. Never your own role or leaving.",
    shape: {
      member: z.string().describe("profile.id"),
      role: z.enum(["admin", "member", "guest"]).optional(),
      left: z.boolean().optional(),
      name: z.string().optional(),
      whatsapp: z.string().optional().describe("International digits, like 201001234567; empty to remove."),
      add_whatsapp: z.string().optional().describe("An extra number for them, kept next to the card's and the others (digits)."),
      email: z.string().optional().describe("Empty to remove."),
      why,
    },
  },
  bot_settings: {
    about: "Change values in Alerts > Settings (watch_settings columns, never a token or key).",
    shape: { patch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), why },
  },
  brain_settings: {
    about:
      "Change the brain's own settings: phase (0 owner, 1 admins too, 2 members too, 3 clients too), fallback_old (true: the old bot answers when the brain is down), model_owner, model_member, model_fast, max_turns, member_turns, run_minutes, run_cost_usd, day_cost_usd.",
    shape: { patch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), why },
  },
} satisfies Record<keyof typeof SERVER_TOOLS, { about: string; shape: Record<string, z.ZodTypeAny> }>;

/** The brain's own tools: what Claude reads, what it takes. */
const OWN = {
  github_status: {
    about: "GitHub: open PRs (default), one PR with its checks (pr), the latest Actions runs (runs), or the deploys (deploys).",
    shape: { what: z.enum(["prs", "pr", "runs", "deploys"]).optional(), number: z.number().int().optional() },
  },
  push_branch: { about: "Push what's checked out in the working copy to a branch of its own (never main, never forced).", shape: { branch: z.string() } },
  install_deps: {
    about: "npm ci in the working copy (and brain/), by its lockfiles: before check and test, and after changing package.json (run npm install --package-lock-only first). The shell's own npm can't reach the registry.",
    shape: {},
  },
  open_pr: {
    about: "Open a PR from a pushed branch into main. Then tell them in plain words what it will do once it's live.",
    shape: { branch: z.string(), title: z.string(), body: z.string().describe("What changed and why, what was tested and what wasn't.") },
  },
  merge_pr: { about: "Merge a PR into main once its checks pass.", shape: { number: z.number().int(), why } },
  deploy: {
    about: "Deploy main to Supabase through GitHub Actions: the functions (whatsapp-bot by default), the database migrations (db), or both (all).",
    shape: { target: z.enum(["functions", "db", "all"]), functions: z.array(z.string()).optional(), why },
  },
  rollback: { about: "Deploy the functions as they were at the deploy before the last one.", shape: { functions: z.array(z.string()).optional(), why } },
  deploy_brain: { about: "Update the brain itself to main, with a health check and a rollback if it fails.", shape: { why } },
  close_pr: { about: "Give up on a change they asked for: close its PR (never merged) and delete its branch.", shape: { number: z.number().int() } },
  skills_list: { about: "The skills you have: the repo's own (caveman among them) and the ones added on WhatsApp, with what each is for.", shape: {} },
  skill_add: {
    about:
      "Add a skill (or replace an added one) from the .md file they sent: the file's whole text as content, exactly as it is. Its name comes from the file's front matter, else give one. It's in every run from the next message on.",
    shape: {
      content: z.string().describe("The .md file's text, exactly as it came."),
      name: z.string().optional().describe("lower-case-with-dashes, when the file has no front matter name"),
      description: z.string().optional().describe("What it's for, when the file doesn't say"),
    },
  },
  skill_remove: { about: "Remove a skill that was added on WhatsApp (the repo's own are removed with a PR).", shape: { name: z.string() } },
} satisfies Record<keyof typeof OWN_TOOLS, { about: string; shape: Record<string, z.ZodTypeAny> }>;

export const OWN_ABOUT = OWN;

/** skills_list, skill_add, skill_remove (skills.ts). */
function skillTool(stateDir: string, name: string, a: Record<string, any>) {
  try {
    if (name === "skills_list") return { skills: listSkills(stateDir) };
    if (name === "skill_add") {
      const s = addSkill(stateDir, { content: String(a.content ?? ""), name: a.name, description: a.description });
      return { added: s.name, description: s.description, said: `Skill ${s.name} is in, from the next message on.` };
    }
    removeSkill(stateDir, String(a.name ?? ""));
    return { removed: String(a.name), said: "Removed, from the next message on." };
  } catch (e) {
    if (e instanceof SkillError) return { error: e.message };
    throw e;
  }
}

/** The brain's own tools that need no GitHub (skills.ts). */
const LOCAL = new Set(["skills_list", "skill_add", "skill_remove"]);

/**
 * The "iklipse" MCP server for one run: the tools of the asker's tier only;
 * the brain's own (GitHub, skills) only in a dev run (the owner or an admin,
 * privately).
 */
export function iklipseServer(o: { bot: BotClient; run: RunRef; github: GitHub | null; dev?: boolean; stateDir?: string }) {
  const { bot, run, github } = o;
  const dev = o.dev ?? true;
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
    if (!rule.tiers.includes(run.tier) || !devRun(run.tier, dev)) continue;
    if (LOCAL.has(name) ? !o.stateDir : !github) continue;
    tools.push(
      tool(
        name,
        def.about,
        def.shape,
        async (args) => {
          try {
            const a = args as Record<string, any>;
            if (LOCAL.has(name)) {
              const r = skillTool(o.stateDir!, name, a);
              return "error" in r ? failed(String(r.error)) : said(r);
            }
            if (!github) return failed("GitHub isn't set up on the brain.");
            if (name === "github_status") return said(await status(github, a));
            if (name === "close_pr") return said(await closePr(github, a as { number: number }));
            if (name === "push_branch") return said(await pushBranch(github, a as { branch: string }));
            if (name === "install_deps") return said(await installDeps(github));
            if (name === "open_pr") return said(await openPr(github, a as { branch: string; title: string; body: string }));
            // Merging, deploying, rolling back, updating itself: kept exactly (the function, as the admin's), then done.
            const d = await describeHeld(github, name, a);
            const kept = await bot.call<{ approval_id: string; waiting?: boolean }>("_approval", { run_id: run.id, tool: name, input: d.input, what: d.what, why: typeof a.why === "string" ? a.why : "", detail: d.detail });
            // An admin's: the owner was asked for the OK; it's done once they say yes, and said in this chat.
            if (kept.waiting) return said(`Not done yet: the super admin was asked to OK it (${d.what}). Once they say yes it's done and said in this chat; if they say no, that's said here too.`);
            const r = await carryOut({ bot, github, approvalId: kept.approval_id, quiet: true });
            if (r.later) return said(`Started: ${d.what}. It runs on its own now; what comes of it is said in this chat when it ends.`);
            return r.ok ? said(r.result) : failed(r.result);
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
