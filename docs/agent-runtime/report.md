# Agent runtime: implementation report

Branch `feat/agent-runtime`, from `main` at `be575d9`. **Not deployed, not merged.**

## Done

- **Audit** (`audit.md`):
  - The suspected architectural limitation is confirmed: flows that pick one enum value can't combine looking up with acting, and only look.ts loops.
  - Also confirmed: a real reliability bug. One busy moment at Anthropic made the bot silently drop a team member's order for good.
- **Design** (`architecture.md`):
  - Four options compared. Chosen: a shared runtime inside the existing function, generalizing look.ts's loop, with capabilities that wrap existing code.
  - No new table, queue or service.
- **Runtime** (`agent/runtime.ts`): permission per call, validation, reads in parallel and writes one at a time, read cache, idempotency per request, safe retries, timeouts, confirmation gate, verification and receipts, budgets, and logs with no message contents.
- **Capabilities** (`agent/capabilities.ts`): `find` (look.ts, scoped per person) and `message_team_member` (an order through orders.ts `giveOrder`, read back after).
- **Integration** (`orders.ts`):
  - A `task` action, offered only when `BOT_AGENT` turns it on for the sender.
  - `doTask` reports with the orders it made, so the existing follow-up, reply and stop flows handle them.
  - Shared code extracted, not duplicated: `giveOrder` and `situation`.
- **Reliability fix for every flow:**
  - `kit.ts` retries 429, 5xx, 529 and network errors twice.
  - `takeOrder` tells the sender when Claude still fails, instead of staying silent.
- **Tooling:**
  - `npm run check:bot`: tsc over the whole function, with a Deno shim. It found and fixed one latent type error in look.ts.
  - `npm run test:bot`: Node and esbuild, no Deno needed.
  - CI workflow `bot.yml`.
- **Docs:** this report, `audit.md`, `architecture.md`, `implementation-plan.md`, `operations.md`.

## Test results (run locally on Node 20)

- `npm run check:bot`: **0 errors**. Before this branch the same check had 1 (look.ts:269).
- `npm run test:bot`: **55 tests, 55 passed, 0 failed.**

  | File | Tests |
  |---|---|
  | `agent/retry.test.ts` | 7 |
  | `agent/runtime.test.ts` | 22 |
  | `agent/capabilities.test.ts` | 10 |
  | `agent/task.test.ts` | 5 (end to end through `takeOrder`) |
  | `orders.test.ts` | 6 |
  | `kit.test.ts` | 5 |

- **Mutation check:** each safeguard was broken on purpose and at least one test failed every time:
  - Permission recheck, idempotency, confirmation gate, keyless write retries, offering tools by permission.
  - look.ts board scope, mail scope, admin-only tables.
- **Bundle check:** `esbuild supabase/functions/whatsapp-bot/index.ts --bundle` succeeds.
- **Not run:**
  - `deno check` and `deno test`: Deno isn't installed here.
  - Any test against real WhatsApp, Calendly, Anthropic or the production database.
  - CI hasn't run until the PR is open.

## Old bot and new bot

| | Before (main) | After (this branch, `BOT_AGENT` on) |
|---|---|---|
| A request that fits no action ("who's late this week? remind them") | Squeezed into one action: answered as a question without reminding anyone, or "Who's that for?" | Becomes a task: looked up, then the people found are written to, then answered |
| Several steps in one message | Not possible outside look.ts's read-only loop | Up to 8 turns and 20 tool calls; lookups in parallel, then writes |
| Who may see what | look.ts scopes, questions only | The same scopes, rechecked at every call, for tasks too |
| What it says it did | Code-built lines for orders | Lines built only from what happened and how it was checked ("Sent to Rabah", "Couldn't...", "Not sure it went through...", "Needs an OK first") |
| The same message delivered twice | `order:<id>` once | The same, and each write once per request (`agent:<id>:<key>`) |
| Anthropic busy for a moment | That message was lost, with no answer | Tried twice more; if it still fails, the sender is told |
| Bounded | look.ts: 8 lookups | 8 turns, 20 calls, 5 writes, 75 s, 12k tokens |
| Logs | Errors only | Every run and step: outcome, timing, tokens; no message text |
| Tests and type-check for the function | None | 55 tests, tsc check, CI |
| With `BOT_AGENT` unset | n/a | Exactly as before (prompt SHA-256 checked), plus the retry fix and the "something went wrong" answer |

## Deferred

These are in `implementation-plan.md`, Phase 5 and later:

- Deploying and turning it on: `BOT_AGENT=admins`. Deploying and setting secrets need the owner's go-ahead.
- More capabilities: close alerts; book, move or cancel meetings; message clients (with `confirm`); Trello and Miro edits through user-scoped `mcp` tools.
- Sending other flows' dead ends to the runtime (`none`, dm.ts `ask_team`), and retiring look.ts's loop once the evals agree.
- The `agent_run` table: approvals and input across messages, cost per run, surviving restarts.
- An eval set from anonymized real failures, with replay.

## Known limitations

- **One invocation per run.** A run lives inside a single function invocation (`later()` / `waitUntil`). Whatever was planned but not done when the function stops is lost. Writes already done are safe: they are orders with keys. The run's text is not persisted.
- **No memory between messages yet.** A `needs_input` question is answered by a new message, which starts a new run. That run sees the quoted message (groups) or the last private messages; there is no stored plan.
- **"Submitted" isn't delivered.** "Submitted" means WhatsApp took the message. Delivery to the phone is only visible later through the echo (`stillQueued`); the run doesn't wait for it.
- **Two capabilities only.** Anything else the agent is asked to do, it says it can't. That is safe but limited.
- **One model for everything.** The agent used the same model setting as every other flow. Since 0108 it has its own (`model_agent`).

## Risks

- **Cost and latency:**
  - A task is 1 classifier call plus 2 to 8 runtime turns. The runtime's system prompt is cached between turns.
  - Watch `agent.end` tokens and `ms` during the admins-only stage before turning it on for everyone.
- **Prompt injection:** client text read through `find` (group messages, emails) can try to steer Claude.
  - What code guarantees: no capability beyond the sender's, no read outside their scope, writes only to active team members, once per request.
  - What it doesn't: Claude could still word an internal message misleadingly. The receipts show exactly whom the bot wrote to.
- **Service role:** all reads rely on look.ts's scoping in code; RLS isn't applied. New read capabilities must go through `find` or use a user-scoped client.
- **Retry timing:** the retries in `kit.ts` add up to about 10 s per failing call inside the minute's tick (whose run limit is 100 s). Under a long Anthropic outage the tick does less per minute, not more.
