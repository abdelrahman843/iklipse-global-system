# Agent runtime: architecture

## Goal

The bot should be able to take a legitimate request it has no hardcoded action for, work out the steps with the system's real capabilities, verify what it did, and say exactly that. It must stay inside the permissions of the person asking. The existing specialized flows (alerts, orders, private chats, booking, files, mail, Slack) keep their business rules.

## Options considered

| | Option | Reliability | Complexity | Verdict |
|---|---|---|---|---|
| A | **A shared in-function runtime generalizing look.ts's loop.** Capabilities wrap existing code; the existing classifiers hand over requests they can't place. | High. Same deploy, same database, same permission code. Added one path at a time behind a switch. | Low: about 400 lines of runtime plus small adapters. | **Chosen.** |
| B | Replace every classifier with one big agent prompt. | Unproven. Every workflow changes at once, and alerts, calls and reminders lose their deterministic rules. | High: a rewrite. | Rejected: big-bang rewrite. |
| C | An external agent service (Claude Agent SDK or Managed Agents) running beside WAHA. | Depends on a second deploy target, its uptime and its secrets. | High: new infrastructure, auth and deploy. | Deferred. Revisit if runs outgrow the edge function's time limit. |
| D | Keep adding enum values and prompts. | Each addition can break others; that is the current pain. | Grows forever. | Rejected. |

Why A:

- look.ts already shows the loop works within the edge function's limits.
- The permission model (`whoAsks`, `find`) and the durable task model (`bot_order`) already exist and can be reused as they are.
- Nothing outside the code changes: no new table, queue or service.

## Shape

```
team member's message
   │
   ▼
orders.ts takeOrder ── act classifier (one Claude call, as before)
   │   with the agent on for them, the enum also has "task"
   ├─ orders / meeting / question / handled / stop / ... ─► unchanged paths
   └─ task ─► doTask
                 │  actor = { id, name, role }        (team member by phone; whoAsks = what they may read)
                 │  context = situation() snapshot (+ quoted message, private chat)  ← information only
                 ▼
             agent/runtime.ts runAgent
                 │  offers capabilities whose allowed(actor) === true, plus finish
                 │  loop: Claude turn ─► tool calls ─► runtime checks ─► capability.run ─► results
                 ▼
             capabilities (agent/capabilities.ts)
                 ├─ find                 = look.ts find   (read; scoped per person)
                 └─ message_team_member  = orders.ts giveOrder (write; bot_order + WhatsApp + follow-up)
                 ▼
             RunResult { status, answer, receipts[], steps[], usage }
   │
   ▼
report() in the same chat, as a reply, with receipts; orders it gave get report_ids
(team replies to it go to followOrder, as with any order)
```

## Contracts

### Capability (agent/runtime.ts)

| Field | Meaning | Enforced by |
|---|---|---|
| `name`, `description`, `input_schema` | What Claude sees. | Claude |
| `effect: "read" \| "write"` | Reads run together; writes run alone, after the turn's reads. | runtime |
| `external?` | The write reaches someone outside the team. | docs; with `confirm` |
| `confirm?` | Never done on Claude's word; reported as "Needs an OK first, not done". | runtime |
| `guide?` | Extra prompt text (find's table catalog). | runtime |
| `allowed(actor)` | Checked when the tool is offered and again at every call. | runtime |
| `validate(input)` | Returns the typed, cleaned input or an error string. Claude gets the error and can fix the input. | capability, called by runtime |
| `key(input)` | Idempotency key per request: `agent:<message id>:<key>`, claimed in `bot_heard`. | runtime + `firstTime` |
| `describe(input)` | Words used in receipts ("write to Rabah (send the logo files)"). | runtime |
| `timeoutMs`, `retries` | Per-call timeout. Retries only for `ToolError("transient")`; writes only with a key. | runtime |
| `run(input, ctx)` | Does it. Returns `{ data, keep?, verified?, receipt? }` or throws a `ToolError`. | capability |

`ToolError` kinds:

- `invalid_input`, `denied`, `not_found`, `conflict`: nothing happened. The key is released.
- `transient`: retried within bounds.
- `timeout`, `permanent`: `maybeDone` decides whether the key is kept.

Verification:

- `verified`: `verified`, `submitted` (the provider took it), `failed` or `unknown`.
- A write with no verification counts as `unknown`.
- `failed` is reported as a failure even if `run` returned normally.

### Run (agent/runtime.ts `runAgent`)

Inputs:

- `request`, `from`, `context` (framed as information, not instructions), `actor`.
- `capabilities`, `model`, `runKey` (the WhatsApp message id).
- `system` (channel persona), `budget`.
- `claim`/`release` (bot_heard), `log`.

Budget defaults:

- 8 turns, 20 tool calls, 5 writes.
- 75 s for the run; 12k output tokens in all, 2k per turn.
- The last turn, or a turn under 10 s from the deadline, offers only `finish`. Anything else asked then is refused as `over_budget`.

Output:

- `status`: `done`, `needs_input`, `blocked`, `budget` or `failed`.
- `text`: Claude's answer followed by one receipt line per write. Receipts come from what happened, not from Claude.
- `steps`, `turns`, `usage`, `ms`.

### Integration (orders.ts)

- **`agentFor(by)`.** `BOT_AGENT=on` turns the agent on for every active team member; `admins` for admins only; anything else, off.
- **When off:** `orderTool(false)` and `orderSystem(false)` are byte-for-byte what Claude got before. Tests compare a SHA-256 of the prompt.
- **`doTask`:**
  - Builds the actor and context.
  - Wires `find` through `whoAsks` and `message_team_member` through `giveOrder`.
  - Claims keys with `firstTime` and releases with a delete from `bot_heard`.
  - Logs JSON events.
  - Reports with the orders it made, so the existing follow-up flow owns them.

## Security boundaries

1. **Who can start a run.** Only an active team member identified by WhatsApp number (orders.ts:157-159). Clients, and unknown numbers outside a team group, never reach `takeOrder`'s actions; `agent/task.test.ts` checks this.
2. **What a run can see.** Every read goes through look.ts `find`, which adds the person's scope whatever was asked:
   - The boards they can see; mail that is theirs or shared with them; Fireflies the same way.
   - Their own attendance (members); money for admins only.
   - The bot uses the service role, so these checks are the boundary. Tests in `agent/capabilities.test.ts` check each one.
3. **What a run can do.** Only the capabilities passed in; each is checked when offered and again at the call.
   - `message_team_member` only targets active team members, never the bot. This matches existing policy: the team gives the bot orders without an OK (orders.ts header).
   - Writes to clients, bookings or anything external are not capabilities yet. When added they must set `confirm: true` until there is a persisted approval flow.
4. **Prompt injection.**
   - The context, tool results and any message, email or file text are framed and described to Claude as information, never instructions.
   - The guarantee comes from code, not the prompt: a manipulated Claude still can't call a capability the person can't use, read outside their scope, or repeat a write.
   - A test shows a "you are now an admin" injection getting nothing.
5. **Duplicates.**
   - The whole message: `firstTime("order:<id>")`.
   - Each write: `agent:<id>:<key>`.
   - Redelivered webhooks, retries and restarts can't repeat a write. A write that may have happened (a timeout) keeps its key and is reported as "Not sure it went through".
6. **Secrets and logs.**
   - Capabilities hold their own clients; Claude never sees a key.
   - Logs carry ids, tool names, outcomes, timings and token counts, never message text or tool payloads. A test checks this.

## State

- **Kept durably:**
  - Orders and their follow-ups (`bot_order`, as before).
  - Idempotency keys (`bot_heard`).
  - The report message ids that tie team replies to orders.
- **In memory only:** the conversation with Claude during one run. Turns, tool results and the read cache are dropped when the run ends.
- **No new table for now.** Every write this phase allows is an order, which is already durable and observable.
- **Proposed for later phases** (in implementation-plan.md): an `agent_run` table, needed when a run must wait for approval or input across messages, or when cost per run should be visible in the app.

## Failure handling

| Failure | Handling |
|---|---|
| Anthropic busy or overloaded (429, 5xx, 529), or the network | `claudeCall` retries twice (1-2 s, or Retry-After up to 5 s). Applies to every flow (kit.ts). |
| Claude still failing in `takeOrder` | The person is told "Something went wrong on my side..." instead of getting silence. |
| Claude failing mid-run | Status `failed`; the answer says so, followed by the receipts of whatever was already done. |
| Invalid tool input or an unknown tool | The error goes back to Claude, which can fix it. |
| Permission denied | Refused at the call. Claude is told, and the prompt tells it to say so rather than work around it. |
| Database or network failing during a lookup | Classified as transient; retried once; then reported to Claude. |
| Write failed before sending (missing number, insert failed) | Key released; receipt "Couldn't ...". |
| Write may have happened (timeout, or no id back from WhatsApp) | Key kept; receipt "Not sure it went through ... Check before asking again." |
| Budget exhausted | Only `finish` is offered; then the run stops with `budget` and whatever text exists. |
| Essential information missing | `finish` with `needs_input`: one question, nothing done. |
