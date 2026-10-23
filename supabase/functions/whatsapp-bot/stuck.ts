// A client's private chat the bot is stuck on (dm.ts ask_team), with the
// agent on for everyone (BOT_AGENT "on", not "admins"): before the team is
// asked, the agent looks into it (find and search, reading only what a team
// member would, plus this client's own chat; never email) and writes the
// reply it would send. Nothing reaches the client from here: message_client
// always needs a person's OK, so the reply goes to the team as the draft to
// OK, with what the agent found, the way the bot asks the team today.

import { runAgent, type Model, type Step } from "./agent/runtime.ts";
import { findCapability, messageClientCapability, searchCapability } from "./agent/capabilities.ts";
import { claudeStep, env, str, type Db, type Settings } from "./kit.ts";
import type { Me } from "./look.ts";
import type { Attendee } from "./meetings.ts";
import { VOICE } from "./voice.ts";

/** Only with the agent on for everyone: "admins" keeps it to the admins' own requests. */
export const agentForClients = (mode = env("BOT_AGENT")) => mode === "on";

const SYSTEM = `You are iklipse's assistant, working for the team (iklipse is a creative and marketing agency). A client wrote privately and the bot couldn't answer alone (stuck_on says why). Look into it: what iklipse knows about them, their projects and deliveries, what was said in their groups, with find and search. Then, when you can answer from what you found, write the reply you'd send them with message_client: it isn't sent, it goes to the team to OK. Money, prices, quotes, contracts, dates to promise and complaints are the team's to decide: say what you found, don't promise. Finish with what you found, in a few words, for the team.
The reply: English, only what's theirs (never other clients, anyone's numbers or emails, money that isn't theirs, the team's own matters), never a promise the team didn't make.
${VOICE}`;

/** What the agent found, and the reply it would send (null: none). */
export interface Looked {
  draft: string | null;
  found: string;
  steps: Step[];
}

export async function lookIntoIt(
  db: Db,
  s: Settings,
  o: { runKey: string; chatId: string; client: Attendee; label: string; known: string[]; chat: string[]; stuck: string },
  model: Model = async (req) => await claudeStep(s, { name: "agent.client", role: "agent" }, req.system, req.messages, req.tools, req.maxTokens, { timeoutMs: req.timeoutMs }),
): Promise<Looked> {
  // As a team member who isn't an admin, plus this client's own chat: no email, nobody else's private chat.
  const me: Me = { id: "bot", admin: false, boards: [], mail: [], dms: [o.chatId], ffAccounts: [], ffMeetings: [] };
  const clients = new Map(o.client.id ? [[o.client.id, o.client]] : []);
  const run = await runAgent({
    request: o.chat.slice(-6).join("\n"),
    from: `${o.label}, a client, privately (you work for the team: nothing reaches them without the team's OK)`,
    context: JSON.stringify({ about_them: o.known, chat: o.chat, stuck_on: o.stuck }),
    actor: { id: "bot", name: "iklipse", role: "member" },
    capabilities: [
      findCapability(db, me, new Map()),
      searchCapability(db, me),
      messageClientCapability({ clients, send: async () => ({ stage: "check", problem: "Not sent: the team OKs it first." }) }),
    ],
    model,
    runKey: `client:${o.runKey}`,
    system: SYSTEM,
    budget: { steps: 4, toolCalls: 8, writes: 1, ms: 45_000 },
    log: (e) => console.log(JSON.stringify(e)),
  });
  const asked = run.steps.find((x) => x.tool === "message_client" && x.outcome === "needs_ok")?.keep as { text?: string } | undefined;
  return { draft: str(asked?.text) || null, found: run.answer.trim(), steps: run.steps };
}
