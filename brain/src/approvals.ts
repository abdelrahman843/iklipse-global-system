// What the owner OK'd of the brain's own actions (merging, deploying, rolling
// back, updating itself): the function tells the brain (POST /approval), the
// brain claims it there (once: approved, then running), checks it's the very
// input the owner saw (its hash), does it, and says what came of it
// (_approval_done: the function tells the chat). Nothing here asks the model.

import type { BotClient } from "./bot.js";
import { execute, type GitHub } from "./github.js";
import { canonical, sha256 } from "./sign.js";

export async function carryOut(o: { bot: BotClient; github: GitHub | null; approvalId: string; log?: (e: Record<string, unknown>) => void }) {
  const { bot, github, approvalId } = o;
  const log = o.log ?? ((e) => console.log(JSON.stringify(e)));
  let c: { tool: string; input: Record<string, unknown>; input_hash: string };
  try {
    c = await bot.call("_approval_claim", { approval_id: approvalId });
  } catch (e) {
    log({ ev: "brain.approval_unclaimed", approval: approvalId, why: (e as Error).message });
    return;
  }
  const done = (ok: boolean, result: string) => bot.call("_approval_done", { approval_id: approvalId, ok, result }).then(() => undefined);
  if (sha256(canonical(c.input)) !== c.input_hash) return await done(false, "What was asked isn't what the owner saw, so nothing was done.");
  if (!github) return await done(false, "GitHub isn't set up on the brain.");
  try {
    const r = await execute(github, c.tool, c.input, { approvalId, report: done });
    if (!r.later) await done(r.ok, r.result);
    log({ ev: "brain.approved", approval: approvalId, tool: c.tool, later: r.later });
  } catch (e) {
    await done(false, (e as Error).message).catch(() => null);
  }
}
