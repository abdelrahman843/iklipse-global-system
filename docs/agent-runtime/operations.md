# Agent runtime: operations

## Configuration

| Setting | Where | Values | Default |
|---|---|---|---|
| `BOT_AGENT` | Supabase secret on the functions | `admins`: admins' requests can become tasks. `on`: the whole team's. Anything else: off. | unset (off) |
| `watch_settings.model_agent` | Alerts > Settings > General | The Claude model the agent runs on (Sonnet or Opus, 0108). Quick decisions use `model_fast`, words people read `model_main`. | the one model set before 0108 |
| `watch_settings.orders_enabled` | Alerts > Settings | Tasks follow this switch, like orders and questions. | as set |
| Budgets | `agent/runtime.ts` `BUDGET` | 8 turns, 20 tool calls, 5 writes, 75 s, 12k output tokens (2k per turn). | code |

Turn it on (an admin, from the repo):

```bash
npx supabase secrets set BOT_AGENT=admins
```

Secrets take effect on the next invocation; no redeploy is needed. The code has to be deployed first:

```bash
npx supabase functions deploy whatsapp-bot --no-verify-jwt
```

## Checks before deploying

```bash
npm run check:bot
```

```bash
npm run test:bot
```

CI runs both on every PR, and on every push to main that touches `supabase/functions/whatsapp-bot`, `supabase/functions/_shared` or `scripts/bot` (`.github/workflows/bot.yml`).

## Monitoring

Each task logs one JSON line per event to the whatsapp-bot function logs (Supabase dashboard, Edge Functions, whatsapp-bot, Logs). No message text or tool data is logged.

- `{"ev":"agent.start","run":"<message id>","role":"admin","tools":["find","message_team_member"]}`
- `{"ev":"agent.tool","run":...,"turn":1,"tool":"find","effect":"read","outcome":"ok","ms":180}`
  - `outcome` is one of: `ok`, `cached`, `duplicate`, `needs_ok`, `over_budget`, `invalid_input`, `denied`, `not_found`, `conflict`, `transient`, `timeout`, `permanent`.
  - On writes, `verified` is `submitted`, `verified`, `unknown` or `failed`.
- `{"ev":"agent.end","run":...,"status":"done","turns":3,"tool_calls":2,"writes":1,"failed":0,"input_tokens":9100,"output_tokens":420,"ms":14200}`
- `{"ev":"agent.model_error",...}`: Claude failed during a run.
- `claude retry <n> <ms> <message>`: any bot flow retried Anthropic.

What to look for while it's on for admins only:

- `status` other than `done` or `needs_input`.
- `denied` outcomes. A few are fine: they mean someone asked for more than they may see.
- `budget` endings: requests too big for the limits.
- p95 `ms` near 75,000.
- Tokens per run, for cost: (input × input price + output × output price) per million.

Orders a task gave are ordinary `bot_order` rows: `chat_id`/`message_id` is where they were asked, and `order_text` is the request. They show in "what's left?" and are followed up, reminded and closed like any order. The keys a task claimed are `bot_heard` rows starting with `agent:<message id>:`.

## Failure recovery

| Symptom | What happened | What to do |
|---|---|---|
| "Something went wrong on my side and I couldn't read that..." | Anthropic failed three times in a row. | Wait and resend. Check status.anthropic.com and the `claude retry` logs. |
| "Something went wrong on my side before I could finish." plus lines | Claude failed mid-run; the lines show what was already done. | Resend only the parts not done. |
| "Not sure it went through: write to X..." | A timeout, or WhatsApp returned no id. The key is kept, so a repeat of the same message won't send again. | Check the person's private chat (`wa_dm`) or ask them. Then send a new message if needed. |
| "Couldn't write to X: I don't have X's WhatsApp number" | No number on their member card. | Add it on the Users page and ask again. |
| Nothing at all | The sender isn't a known team member, or orders are off. | Check the Users page number and Alerts > Settings. |

## Rollback

1. **Instant, no deploy.** The bot goes back to exactly what it did before for every request, because with the switch off Claude gets the same tool and prompt as before:

   ```bash
   npx supabase secrets unset BOT_AGENT
   ```

2. **Orders a task already gave** stay ordinary orders. To stop them, reply "stop" to the report, or say "stop asking X".
3. **Full code rollback:** revert the merge commit on main and redeploy:

   ```bash
   npx supabase functions deploy whatsapp-bot --no-verify-jwt
   ```

   Nothing else needs to change: there is no migration and no new table.
4. **Retry change only.** If the Anthropic retries in `kit.ts` ever cause trouble, revert that hunk. Every flow then calls Anthropic once, as before.
