// The brain's own actions (merging, deploying, rolling back, updating itself),
// done for the admin who asked: kept first by the function (_approval: exactly
// this input, decided by them), claimed here once (approved, then running),
// checked to be that very input (its hash), done, and what came of it said
// (_approval_done). One that finishes later (a deploy running on GitHub, the
// brain restarting) is told in the chat when it does. Nothing here asks the
// model.

import type { BotClient } from "./bot.js";
import { execute, type GitHub } from "./github.js";
import { canonical, sha256 } from "./sign.js";

export type Outcome = { later: true } | { later: false; ok: boolean; result: string };

/**
 * quiet: it was asked for in this run, so the brain says what came of it (an
 * outcome that's there at once isn't also said in the chat).
 */
export async function carryOut(o: { bot: BotClient; github: GitHub | null; approvalId: string; quiet?: boolean; log?: (e: Record<string, unknown>) => void }): Promise<Outcome> {
  const { bot, github, approvalId } = o;
  const log = o.log ?? ((e) => console.log(JSON.stringify(e)));
  let c: { tool: string; input: Record<string, unknown>; input_hash: string };
  try {
    c = await bot.call("_approval_claim", { approval_id: approvalId });
  } catch (e) {
    log({ ev: "brain.approval_unclaimed", approval: approvalId, why: (e as Error).message });
    return { later: false, ok: false, result: (e as Error).message };
  }
  const told = (ok: boolean, result: string, quiet = false) =>
    bot.call("_approval_done", { approval_id: approvalId, ok, result, ...(quiet ? { quiet: true } : {}) }).then(() => undefined);
  const now = async (ok: boolean, result: string): Promise<Outcome> => {
    await told(ok, result, o.quiet).catch(() => null);
    return { later: false, ok, result };
  };
  if (sha256(canonical(c.input)) !== c.input_hash) return await now(false, "What was asked isn't what was kept, so nothing was done.");
  if (!github) return await now(false, "GitHub isn't set up on the brain.");
  try {
    // Finishing later: said in the chat then, whoever asked.
    const r = await execute(github, c.tool, c.input, { approvalId, report: (ok, result) => told(ok, result) });
    log({ ev: "brain.did", approval: approvalId, tool: c.tool, later: r.later });
    return r.later ? r : await now(r.ok, r.result);
  } catch (e) {
    return await now(false, (e as Error).message);
  }
}
