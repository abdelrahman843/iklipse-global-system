# Agent runtime: implementation plan

Status key: **done** (on branch `feat/agent-runtime`), **next**, **later**.

## Phase 1: audit (done)

`docs/agent-runtime/audit.md`.

## Phase 2: design (done)

`docs/agent-runtime/architecture.md`.

## Phase 3: proof of concept (done)

1. **done:** `agent/retry.ts`. Bounded exponential retries, plus the transient-status and Retry-After helpers.
2. **done:** `kit.ts`. `claudeCall` retries 429, 5xx, 529 and network errors twice. `claude` and `claudeTurn` keep their signatures and their request bodies; a test checks the bodies.
3. **done:** `agent/runtime.ts`. Covers:
   - Capability contract and offering by permission, rechecked at every call.
   - Validation; reads run in parallel, writes one at a time.
   - Read cache; per-request idempotency keys; retries only when safe; timeouts.
   - The confirmation gate; verification and receipts.
   - Budgets; finish rules; JSON events with no message contents.
4. **done:** `agent/capabilities.ts`. `find` (look.ts) and `message_team_member` (orders.ts `giveOrder`), each with validation, verification and receipts.
5. **done:** `orders.ts`:
   - `giveOrder` extracted from `takeOrder`.
   - `situation` extracted from `answerQuestion`.
   - The `task` action, offered only when `agentFor(by)` is true.
   - `doTask` wires the runtime in.
   - A Claude failure now gets an answer instead of silence.
6. **done:** `look.ts`. Exports `find`, `whoAsks` and `TABLE_GUIDE`; the prompt text is unchanged. Fixed the latent type error.

## Phase 4: tests (done)

- `npm run test:bot` runs Node with esbuild, no Deno needed.
- `npm run check:bot` runs tsc with a Deno shim.
- CI: `.github/workflows/bot.yml` runs both on PRs and on pushes to main that touch the bot.

## Phase 5: gradual integration (next)

Each step: turn it on, watch it, widen.

1. **next:** Deploy `whatsapp-bot` from main after merge. Nothing changes while `BOT_AGENT` is unset.
2. **next:** Set `BOT_AGENT=admins`. Admins try real multi-step requests in the team group. Watch `agent.end` events (operations.md): status, turns, tokens, failures.
3. **next:** Collect the requests that went wrong into anonymized fixtures under `agent/evals/`. Replay them with a scripted or recorded model, and decide changes by the results.
4. **later:** `BOT_AGENT=on` for the whole team.
5. **later:** More capabilities, each wrapping code that already exists, one at a time, each with its own tests:
   - `close_alerts`: kit.ts `closeAlert`, read back.
   - `book_meeting`, `move_meeting`, `cancel_meeting`: book.ts `bookFor` and `cancelEvent`. These need `confirm`, or the existing admin check, plus a Calendly read-back.
   - `message_client`: orders.ts `giveOrder` for clients. This needs `confirm` until approval is persisted.
   - Trello or Miro edits: reuse `supabase/functions/mcp` tools with a user-scoped client so RLS applies. The bot's service role must not be used for them.
6. **later:** Route other flows' dead ends to the runtime:
   - `none` in takeOrder.
   - `ask_team` in dm.ts, for team-side research before asking the team.
   - The `question` path, once the runtime matches look.ts's answers on the eval set. Then look.ts's loop can retire.
7. **later:** An `agent_run` table, once any of these exists: a run that waits for approval or input across messages, cost per run shown in the app, or runs that must survive restarts. Draft:

   ```sql
   create table public.agent_run (
     id uuid primary key default gen_random_uuid(),
     message_id text not null unique,            -- one run per message (the idempotency boundary)
     by_user uuid references public.profile(id),
     chat_id text not null,
     status text not null check (status in ('running','waiting_for_input','waiting_for_approval','done','blocked','budget','failed','cancelled')),
     steps jsonb not null default '[]',           -- the runtime's Step[]: tools, outcomes, timings; no message text
     pending jsonb,                               -- the capability call awaiting an OK, if any
     input_tokens int not null default 0,
     output_tokens int not null default 0,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     expires_at timestamptz not null default now() + interval '1 day'
   );
   alter table public.agent_run enable row level security;  -- service role only, like the bot's other tables
   ```

   Rules for it:
   - Delete rows after 30 days.
   - Prune `bot_heard` `agent:*` keys older than 7 days in the same cron job.

## Phase 6: evaluation (later)

What to measure from `agent.end` events and the fixtures:

- Completion rate and verified-outcome correctness.
- Tool-selection accuracy (expected tools against the steps actually taken).
- Unauthorized-action prevention: denied steps when there should be none.
- Recovery rate: transient followed by ok.
- Duplicate side-effect rate (`duplicate` outcomes), escalation rate (`needs_input` and `blocked`).
- p50 and p95 latency, tokens per run, and regressions in the existing tests.

The rule: a new failure is fixed by improving a capability, its description or validation, or the context. It is not fixed by adding an enum value.

## Acceptance criteria and their tests

| # | Criterion | Test (`supabase/functions/whatsapp-bot/...`) |
|---|---|---|
| 1 | Handles a legitimate request no hardcoded action fits | `agent/task.test.ts` "a task: looked up, the late one written to..." (real takeOrder → classifier → runtime → find → giveOrder → report); `agent/runtime.test.ts` "a request no action fits" |
| 2 | Uses several tools in sequence | the same two tests; "lookups of one turn run together; changes run after them" |
| 3 | Adapts to tool errors or unexpected results | "a passing lookup error is tried again; a wrong input goes back to Claude, which fixes it"; "a tool that hangs times out" |
| 4 | No success claimed without verification | "a change that failed is said as failed, whatever Claude's answer says"; "a change that couldn't be checked says so"; "Claude's answer isn't taken as proof"; `agent/capabilities.test.ts` "not claimed as sent when the check says otherwise" |
| 5 | Respects the requester's permissions | "a capability the person may not use isn't offered..."; "permission is checked again at the call"; "words in a looked-up message can't make it do what the person may not"; `capabilities.test.ts`: boards, mail, attendance, money, guests; `task.test.ts` "someone not on the team gets nothing" and "admins only" |
| 6 | No duplicate non-idempotent side effects | "a change is done once per request..."; "a change with a key is tried again...; without a key, never"; "a change that didn't happen lets its key go..."; `task.test.ts` redelivery of the same message |
| 7 | Stops safely when information, permission or approval is missing | "when something essential is missing it asks"; "a change that needs an OK isn't done"; "Claude failing midway ends safely"; `task.test.ts` "Claude down" |
| 8 | Existing workflows keep passing | `orders.test.ts`: the act tool and prompt are unchanged when off (SHA-256); `giveOrder` behaves as before; `kit.test.ts`: request bodies and parsing unchanged |
| 9 | Bounded and observable | "bounded: after its turns it can only answer"; "bounded: tool calls, changes and time"; "observable: every step is logged, with no message contents" |
| 10 | Documented rollback | operations.md, "Rollback" |
