# Agent runtime: audit of the WhatsApp bot

Scope: `supabase/functions/whatsapp-bot` (15 files, 8,558 lines at `be575d9`), the shared code in `supabase/functions/_shared`, the database migrations (`supabase/migrations`, 104 files), the frontend settings that drive the bot, and CI.

Line references point at `main` as of `be575d9`, before this branch. Every finding is marked:

- **Verified:** read in the code, and reproduced by a test where one is named.
- **Hypothesis:** likely, but not proven here.

## 1. How a message moves through the system

```
WhatsApp ──► Green API or WAHA (waha.ts makes WAHA look like Green API)
               │  POST /whatsapp-bot/hook | /waha   (Bearer WATCH_HOOK_TOKEN, index.ts:436-440)
               ▼
           onHook (index.ts:462-629)
            ├─ private chat ─► keepDm (dm.ts:42) ─► fromPrivate (index.ts:955-991)
            │                     route by latest timestamp: meeting (book.ts) | order answer (orders.ts fromTarget)
            │                     | team member (orders.ts takeOrder) | details/OK answer (people.ts, dm.ts)
            ├─ group, reply to the bot's ask/draft ─► fromTeam (index.ts:1144)
            ├─ team group, reply to an order report ─► followOrder (orders.ts:815)
            ├─ meeting reply ─► heard / answer (book.ts)
            ├─ mention of the bot ─► takeOrder (orders.ts:148)
            └─ every group message kept (wa_message); files read (files.ts)
           later(...) = EdgeRuntime.waitUntil, after the 200 is returned (index.ts:936-939)

pg_cron "watch-tick" every minute ─► POST /tick (X-Iklipse-Secret) ─► tick (index.ts:1509-1574)
   tick_lock lease ─► meetings (book.ts leftovers, meetings.ts) ─► whatsappTick: group sync, people,
   order reminders (nagOrders), files, private chats (readDms), groups that went quiet (analyze ─► chat.ts readChat)
   ─► mail (mail.ts) ─► Slack (slack.ts) ─► ring alerts, digest, in-app calls
```

**Context building.** Each flow builds its own prompt:

- `whoIs` + `historyOf` + `meetingsOf` for private chats (dm.ts:127-162, 245-260).
- The `people` / `projects` / `open_orders` / `open_alerts` JSON for orders (orders.ts:169-248).
- The "what's going on" snapshot for questions (orders.ts:474-529).
- The last 60 messages of a chat for alerts (chat.ts:149-186).

**Choosing an action.** About 13 single-shot `claude()` calls each force Claude to pick one value from an enum through one tool (kit.ts:138-168). One loop, look.ts, lets Claude call a tool several times (look.ts:338-364).

**Tools.** In look.ts the only tool is `find`. Elsewhere, "tools" are the classifier's output schema, and the code acts on the chosen enum value with a `switch`.

**Results.** Everything goes out through `sendAs` (index.ts:1109-1136) to Green API or WAHA, and the message id that comes back is kept on the record that caused it: `bot_order.sent_ids` / `report_ids`, `bot_draft.ask_ids`, `wa_bot_turn`.

## 2. Inventory of what the bot can do

| Capability | Where | Reads / writes | Who may trigger |
|---|---|---|---|
| Look up any of 51 tables, scoped per person | look.ts `find` (240-329), `whoAsks` (166-192) | read | active non-guest team member |
| Order a person: tell / ask, then follow up | orders.ts takeOrder / toThem / nagOrders | write: `bot_order` + WhatsApp | any team member (anyone in a team group) |
| Close alerts as handled | orders.ts `handled` (283-290), kit.ts closeAlert | write | team |
| Book, move or cancel a Calendly meeting; free times; booking links | book.ts (7-action classifier, 458-527) | write: Calendly + WhatsApp | team (only by known number) |
| Talk to clients privately; ask the team when stuck | dm.ts readDm / askTeam / decideDraft | write: WhatsApp + `bot_draft` | clients write; team OKs |
| Open and close alerts from groups, Slack and mail | chat.ts readChat, mail.ts | write: `watch_alert` | automatic |
| Ask the team for missing client details | people.ts | write | automatic |
| Read files (voice, photo, PDF) | files.ts | write: `wa_file` | automatic |
| Ring and call the team | index.ts ring / startCall | write | automatic |

Trello and Miro in this app are the app's own tables (`board`, `card`, `wb_item`). There is no external Trello or Miro API. The `mcp` function exposes 19 tools on them to outside AI clients through OAuth and RLS (`supabase/functions/mcp`). The bot uses none of them.

## 3. The diagnosis, checked

| # | Suspected limitation | Verdict | Evidence |
|---|---|---|---|
| 1 | Fixed action classifications | **Confirmed.** | See below. |
| 2 | Separate flows that can't hand work to each other | **Confirmed.** | See below. |
| 3 | Tool discovery | **Confirmed, partly.** | Only look.ts exposes a tool (`find`). No flow can see or call another flow's action as a tool. |
| 4 | Multi-step planning and execution | **Confirmed outside look.ts.** | look.ts is bounded and read-only (8 steps, 14k characters per result). Nothing can plan look-up-then-act. |
| 5 | Verification after actions | **Partly.** | See below. |
| 6 | Error recovery and retries | **Confirmed gap.** | See below. |
| 7 | Context retrieval | **Partly.** | Good builders exist (`whoIs`, `historyOf`, the situation snapshot) but each flow gets a fixed slice. Sameh's "check with the client" failed because `meeting_talk` was missing from the order classifier until `b0170cc`. |
| 8 | Unclear ownership of side effects | **Not confirmed as a bug.** | Every send goes through `sendAs`; `bot_order` is written by `takeOrder` and `linkOrders` the same way. The real risk is the recency router (row 12 in the next table). |
| 9 | Persistence for long tasks | **Partly.** | Follow-ups are durable (`bot_order`, `bot_draft`, `wa_bot_turn` with `new→working→done/failed` and stuck recovery, book.ts:1397-1411). A plan in progress is not: it lives in one invocation. |
| 10 | Prompts, model, tokens, schemas | **Partly.** | One model setting for everything (`watch_settings.model`). Small `max_tokens` per call (800-6000). Large enums with long prose rules: the order prompt is 5.4k characters (orders.ts:125-137). |
| 11 | Authorization, integrations | **Holds, but at the application level.** | See below. |
| 12 | Other | **Found.** | See below. |

**1. Fixed action classifications.** Each flow forces one enum value:

- orders.ts:98: 11 actions.
- book.ts:464: 7.
- dm.ts:77: 5.
- dm.ts:355: 5.
- orders.ts:699: 6.
- orders.ts:795: 6.

A request outside the list ends as `none`, `ignore`, or the nearest wrong action.

**2. Flows can't hand work to each other.** `takeOrder` acts on exactly one action per message (switch at orders.ts:255-312).

- `question` goes to `answerQuestion` and then `lookUp`, which is read-only (orders.ts:530-537).
- `orders` needs refs from a `people` list that carries no deliveries, cards or attendance (orders.ts:182-194).
- So "see who's late and remind them" can't be done.
- The only hand-off is to re-enter as new text: `decideDraft`, then `order(text)`, then `orderNow` (dm.ts:431-433, index.ts:1155-1165); and `followOrder`, then `order` (orders.ts:845-847).

**5. Verification.** A send counts as done once the provider returns an id (`toThem` orders.ts:72-78, `sendAs`). Delivery to the phone is seen later through the Green API echo (`stillQueued` kit.ts:211-222), but that is only used to pace reminders. The reports ("Sent to X") come from code, not from Claude. That is good. But the meaning ("WhatsApp took it") is never stated.

**6. Error recovery and retries.**

- `claude()` and `claudeTurn()` call `fetch` once. A 429, 5xx or 529 throws (kit.ts:138-190).
- In `takeOrder`, `firstTime(order:<id>)` is used up before the Claude call (orders.ts:156). An error then goes up to `later()`, which only logs it (index.ts:936-939).
- **So one busy moment at Anthropic means the team member gets no answer, and the message is never retried.** Reproduced: `agent/task.test.ts` "Claude down even after trying again" (fixed on this branch).
- Private chats do retry: `pending_since` stays set and `last_error` is written (dm.ts:197-204).

**11. Authorization.** The bot uses the service role (`serviceClient`, `_shared/oauth.ts`), so RLS doesn't apply to it. Authorization is in code:

- Team membership by phone (orders.ts:157-159).
- Admin actions (index.ts:1752-1753).
- What `find` may read (look.ts:244-310: board visibility, own or shared mail, Fireflies, own attendance for members, money for admins).

**12. Other problems found.**

- No tests.
- No type-checking of the edge functions: `tsconfig.json` only includes `src`.
- CI never touches the functions.
- A latent type error at look.ts:269.
- Private chats are routed by "whichever the bot wrote about last" (index.ts:955-991). That is fragile when several conversations overlap.
- `audit_log` skips writes with no signed-in user (migration 0073:423-427), so nothing the bot does is in the audit log. Its own records (`watch_event`, `bot_order`, `bot_draft`) are the only trail.

## 4. Reusable parts

- **`look.ts`:**
  - `find` and `whoAsks`: the permission model a general agent needs. It is reused as is, as the agent's `find` capability.
  - The loop itself is specific to read-only questions. It is kept as it is; the new runtime generalizes it (see architecture.md).
- **`orders.ts`:**
  - The order lifecycle (`bot_order`, `toThem`, `nagOrders`, `fromTarget`, `followOrder`, `report`) is a durable task with follow-ups, replies and outcomes. It is reused as the agent's only write capability.
  - On this branch the per-person body of `takeOrder` was extracted as `giveOrder`, so both paths share it.
- **`situation`:** the "what's going on now" snapshot from `answerQuestion` (orders.ts:474-529), extracted unchanged.
- **Dedupe and locks:**
  - `bot_heard` with `firstTime` (people.ts:327-331).
  - Primary-key upserts with `ignoreDuplicates` on message ids.
  - `tick_lock` (index.ts:1515-1521).
  - `wa_dm_chat.claimed_at` (dm.ts:189-196).
  - Together these cover idempotency without a new table.
- **Logs:** `watch_event`, `bot_order.outcome` and `wa_dm_chat.last_error` hold per-record state; `console.log` goes to the function logs.

## 5. Gaps

- **Not built:**
  - A general write path for the agent beyond orders: closing alerts, Trello or Miro changes, bookings, client messages.
  - Persisted approval for consequential actions.
  - A persisted plan or run record that survives a restart.
  - Cost and latency metrics per run.
- **Hypotheses, not verified:**
  - `bot_heard` and `waha_msg` are never pruned.
  - `calendly/index.ts:243-246` lets an account's owner set `use_for_bot` without an admin check (the UI hides it from non-admins). Outside this scope; noted for review.
  - Client text that reaches the private-chat prompt (`historyOf`, "Elsewhere") could steer `dm.ts` replies. Its actions are limited to reply, meeting and ask_team, so the impact is bounded; not tested.

## 6. Tests and deployment before this branch

- No `*.test.*` files.
- No eslint config: `npm run lint` fails because eslint isn't installed.
- No `deno.json`.
- Functions are deployed by hand with `npx supabase functions deploy <name> --no-verify-jwt`.
- CI builds the web app and the desktop and Android apps only.
- Deno isn't installed on the dev machine. Type-checking with `tsc` and a Deno shim found exactly one existing error (look.ts:269).
