// What the agent (runtime.ts) can use from WhatsApp, made from what the bot
// already does, nothing new: find is look.ts's lookup (the same tables and
// columns, and who may read what), message_team_member is an order from
// orders.ts (kept in bot_order, written to them, followed up until it's done,
// reported where it was given). Here is only what each one is, who may use
// it, what it takes, and how it's checked after it ran.

import { find, FIND_TOOL, Refused, TABLE_GUIDE, type Find, type Me } from "../look.ts";
import { str, type Db } from "../kit.ts";
import type { Attendee } from "../meetings.ts";
import { ToolError, type Actor, type Capability } from "./runtime.ts";

const notGuest = (a: Actor) => (a.role === "guest" ? "Guests can't use the bot." : true);
/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** The database or the network failed, not what was asked. */
const passing = (m: string) => /fetch failed|network|timed? ?out|ECONNRESET|connection|50[234]|Service Unavailable/i.test(m);

// ------------------------------------------------------------------ find --

/** Reading iklipse, as the one asking may (look.ts adds who may see what to every lookup). */
export function findCapability(db: Db, me: Me, names: Map<string, string>): Capability<Find> {
  return {
    name: "find",
    description: FIND_TOOL.description,
    input_schema: FIND_TOOL.input_schema,
    effect: "read",
    guide: TABLE_GUIDE,
    allowed: notGuest,
    validate: (x) => {
      const f = (x ?? {}) as Find;
      return typeof f.table === "string" && f.table ? f : "find needs a table.";
    },
    timeoutMs: 15_000,
    retries: 1,
    run: async (f) => {
      try {
        return { data: await find(db, me, f, names) };
      } catch (e) {
        const m = (e as Error).message;
        if (!(e instanceof Refused)) throw new ToolError("transient", "That lookup failed.");
        if (/admins only|aren't on|isn't shared/.test(m)) throw new ToolError("denied", m);
        throw new ToolError(passing(m) ? "transient" : "invalid_input", m);
      }
    },
  };
}

// ----------------------------------------------------- a team member --

export interface TeamMessage {
  /** Their profile id. */
  person: string;
  kind: "tell" | "ask";
  task: string;
  message: string;
  nudge: string;
  /** false: it only passes something on, nothing to follow up. */
  wait: boolean;
}

/** What giving the order did (orders.ts giveOrder). stage: where it stopped (checking them, keeping it, sending it). */
export interface Given {
  order?: { id: string };
  told?: boolean;
  problem?: string;
  stage?: "check" | "keep" | "send";
}

/**
 * Writing to someone on the team, as an order the bot follows up (orders.ts).
 * Anyone on the team may: the team gives the bot orders without an OK (0090).
 * Once per person per request. Checked after: the order is read back, and
 * WhatsApp has to have taken the message (submitted; WhatsApp tells later
 * whether it reached their phone).
 */
export function messageTeamCapability(o: {
  /** The active team (meetings.ts directory). */
  team: Map<string, Attendee>;
  botPhone: string | null;
  /** Where the answer is brought: "here" (the group), or "to you" (privately). */
  answerTo: string;
  give: (to: Attendee, x: TeamMessage) => Promise<Given>;
  /** The order as it is now. */
  check: (orderId: string) => Promise<{ status: string; sent: number } | null>;
}): Capability<TeamMessage & { to: Attendee }> {
  return {
    name: "message_team_member",
    description:
      "Write privately on WhatsApp to someone on the team: tell them to do something (or pass something on), or ask them something and bring the answer back. The bot follows up until it's done or answered, and says what they answer where this request was made. Once per person per request: put everything for them in one message.",
    input_schema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Their id: profile.id (find it in profile, is_active true)." },
        kind: { type: "string", enum: ["tell", "ask"], description: "tell: they're to do something, or be told something; ask: a question whose answer is brought back." },
        task: { type: "string", description: "What they're to do, or what they're asked, short, in English (\"send the final logo files to Acme\")." },
        message: {
          type: "string",
          description:
            "The first message to them, in English, the way a person texts: \"Hi <first name>, <first name of who asked> asks you to <task>.\" with what they need to know. For tell with wait true, end with \"Reply here when it's done, or tell me what's in the way.\" Never invent a date, a file, a price or a promise.",
        },
        nudge: { type: "string", description: "The reminder if they don't answer, short (\"Rabah, a reminder: Sameh asked you to send the logo files to Acme. Is it done?\")." },
        wait: { type: "boolean", description: "false when it only passes something on and nothing is needed back (no follow-up); else true." },
      },
      required: ["person", "kind", "task", "message", "nudge", "wait"],
    },
    effect: "write",
    allowed: notGuest,
    validate: (x) => {
      const i = (x ?? {}) as Partial<TeamMessage>;
      const to = o.team.get(str(i.person));
      if (!to?.id) return "No one active on the team has that id: find them in profile (is_active true) first.";
      if (o.botPhone && to.phone === o.botPhone) return "That's the bot's own number.";
      const task = str(i.task);
      const message = str(i.message);
      if (!task || !message) return "It needs the task and the message.";
      if (task.length > 500 || message.length > 2000) return "Too long: the task under 500 characters, the message under 2000.";
      return { person: to.id, kind: i.kind === "ask" ? "ask" : "tell", task, message: message.replace(/\s*[—–]\s*/g, ", "), nudge: str(i.nudge).slice(0, 1000), wait: i.wait !== false, to };
    },
    key: (x) => `team:${x.person}`,
    describe: (x) => `${x.kind === "ask" ? "ask" : "write to"} ${first(x.to.name)} (${x.task})`,
    timeoutMs: 20_000,
    retries: 1,
    run: async (x) => {
      const r = await o.give(x.to, x);
      if (r.problem) throw new ToolError(r.stage === "check" ? "not_found" : r.stage === "keep" ? "transient" : "permanent", r.problem);
      const name = first(x.to.name);
      const data = { person: x.to.name, kind: x.kind, follow_up: !r.told };
      const now = r.order ? await o.check(r.order.id).catch(() => null) : null;
      if (!now) return { data, keep: r, verified: { status: "unknown" as const, detail: "the order couldn't be read back" } };
      if (now.status === "failed") return { data, keep: r, verified: { status: "failed" as const, detail: "WhatsApp didn't take the message" } };
      // Sent, but WhatsApp gave no id back: it may not have gone out.
      if (!now.sent) return { data, keep: r, verified: { status: "unknown" as const, detail: "WhatsApp didn't confirm it took the message" } };
      return {
        data,
        keep: r,
        verified: { status: "submitted" as const, detail: "WhatsApp took the message" },
        receipt: r.told ? `Told ${name}.` : x.kind === "ask" ? `Asked ${name}. I'll bring the answer ${o.answerTo}.` : `Sent to ${name}. I'll follow up until it's done.`,
      };
    },
  };
}
