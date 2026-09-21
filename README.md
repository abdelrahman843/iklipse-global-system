# Iklipse — Internal System

Internal-only company system. First module: Trello-class project management.
Built with **React + TypeScript + Vite + Tailwind** on **Supabase** (Postgres + Auth + Realtime + Storage + Edge Functions).

- **English UI only.** No landing page, no public sign-up, no billing.
- **Two application roles:** `admin` (full access) and `member` (permissioned).
- **Board membership** gates every list, card, comment, attachment via RLS.

---

## 1. Prerequisites

- Node 20+
- npm 10+
- A Supabase project (URL, `anon` key, and `service_role` key)
- (Optional) [Supabase CLI](https://supabase.com/docs/guides/cli) for local migrations & function deploys

## 2. First-time setup

```bash
# 1) install deps
npm install

# 2) fill in the env
cp .env.example .env.local
# then edit .env.local:
#   VITE_SUPABASE_URL="https://<PROJECT_REF>.supabase.co"
#   VITE_SUPABASE_ANON_KEY="<anon or publishable key>"

# 3) apply the DB migrations to your Supabase project
#    (via CLI) — from the repo root:
supabase link --project-ref <PROJECT_REF>
supabase db push
# OR paste the SQL files under supabase/migrations/ into the Supabase SQL Editor,
# in the order 0001 → 0002 → 0003.

# 4) deploy the admin edge functions
supabase functions deploy admin-create-member
supabase functions deploy admin-update-member

# 5) create the first admin (one-time bootstrap):
#    Supabase Studio → Authentication → Add user
#      email:    admin@iklipse.local
#      password: <strong password>
#      user metadata: { "username": "admin", "display_name": "Admin", "role": "admin" }
#    (The `handle_new_user` trigger will materialise the profile row automatically.)

# 6) run
npm run dev
```

Then open http://localhost:5173/login and sign in with the username you set (`admin`) and your password.

## 3. What's in the box

### Routes

| Path                                       | Access             | Description                        |
| ------------------------------------------ | ------------------ | ---------------------------------- |
| `/login`                                   | public             | Sign in                            |
| `/users`                                   | admin only         | Create / edit / activate members   |
| `/pm/boards`                               | permissioned       | Boards home                        |
| `/pm/boards/:boardId`                      | board members      | Kanban view                        |
| `/pm/boards/:boardId/cards/:cardId`        | board members      | Card detail modal on top of board  |

### Roles & permissions

Application role is `admin` or `member`. Members receive a **granular permission set** from `PermissionKey` (see `src/lib/database.types.ts` and `src/lib/permissions.ts`). The `has_permission()` SQL function is the authoritative check — RLS policies call it directly.

### Ordering

Cards and lists use **fractional/lexicographic ranking** via `public.rank_between(prev, next)`. Moves go through the `move_card` / `reorder_list` **SECURITY DEFINER RPCs** which enforce authorization, compute the new rank server-side, and log an activity entry — no sibling rewrites, no drifting positions under concurrent moves.

### Realtime

Board changes stream via Supabase Realtime channels scoped per-board (`board:<id>`). See `src/lib/pm/useBoardRealtime.ts`.

### Security

- Every table has RLS on. Board-scoped tables gate on `is_board_member(board_id)`.
- Members can never grant themselves permissions — the `user_permission` write policy checks `is_admin()`.
- The `profile_guard` trigger blocks self-updates to `role`, `is_active`, and `username`.
- Admin CRUD (create user, reset password, replace permissions) goes through **Edge Functions** that verify the caller is admin *and* run the privileged operation with `service_role` internally. The `service_role` key stays server-side.

## 4. Project layout

```
supabase/
  migrations/                 SQL migrations (apply in order)
    0001_identity_permissions.sql
    0002_pm_core.sql
    0003_rpc_ordering.sql
    0004_notifications_search.sql   (Phase 4)
    0005_custom_fields_templates.sql (Phase 5)
    0006_automation.sql              (Phase 6)
  functions/                  Edge Functions (deploy with `supabase functions deploy <name>`)
    _shared/admin.ts          Admin JWT check + service client helpers
    admin-create-member/
    admin-update-member/

src/
  App.tsx                     Route table
  main.tsx                    Providers (React Query, Router, Auth, Toasts)
  lib/
    supabase.ts               Supabase client
    auth.tsx                  AuthProvider, useAuth, session hydration, permission set
    permissions.ts            Grouped permissions for the Users page
    lexorank.ts               Fractional-index helper
    format.ts, cn.ts          Small utilities
    database.types.ts         Row/RPC/enum types
    pm/
      boardApi.ts             Board / list / card / comment queries + mutations
      useBoardRealtime.ts     Realtime channel hooks
    adminApi.ts               Wrapper around admin-* edge functions
  components/
    routing.tsx               ProtectedRoute, AdminOnlyRoute
    AppShell.tsx              Sidebar + header + Outlet
    ui/                       Button, Input, Modal, Toast, Menu, Avatar, Badge, Spinner, EmptyState
    pm/CardDetailModal.tsx    Card view (members, labels, dates, comments)
  pages/
    LoginPage.tsx
    UsersPage.tsx             Admin CRUD
    BoardsHomePage.tsx        Boards list + create
    BoardPage.tsx             Kanban + drag & drop
    NotFoundPage.tsx
```

## 5. What's implemented (Phase status)

- **Phase 0 (audit).** No pre-existing app to audit; the scaffold in this repo *is* the app.
- **Phase 1 (auth + users + permissions).** ✅ Login, session, sign-out with cache clear, admin-only routing, `/users` CRUD (create/edit/reset password/toggle active), `role` + granular permission set, RLS + guard trigger, admin edge functions.
- **Phase 2 (PM DB foundation).** ✅ Workspace, board, board_member, list, card, label, card_label, card_member, checklist, checklist_item, attachment, comment, activity, notification, subscription. RLS on all. Ordering RPCs. Storage buckets.
- **Phase 3 (board core).** ✅ Boards home, board Kanban view, drag/drop (dnd-kit), card composer, card detail modal (members, labels, dates, description, checklists, comments, activity feed, archive). Archive/restore for cards (`set_card_archived` RPC).
- **Phase 4 (realtime + notifications + search).** ✅ Board + card + notifications realtime channels. Fan-out DB triggers for `@mentions`, assignments, due-date changes, board invites. Notification bell + `/pm/notifications` page. Watch/unwatch on cards. `/pm/search` (Postgres FTS via `search_cards` RPC). `/pm/my-cards` for the caller's assigned cards.
- **Phase 5 (complete).** ✅ Board filters (keyword / members / labels / due / mine), keyboard shortcuts (`?` help modal), Calendar / Table / Timeline / Dashboard views (per-permission), custom fields (text/number/date/checkbox/select), templates (make/unmark + copy into any list via `clone_card` RPC).
- **Phase 6 (advanced).** ✅ Automation engine: `automation_rule` + `automation_run` tables, editor at `/pm/boards/:id/automation`, trigger-based execution with a depth cap of 3 to prevent runaway cascades. Timeline + Dashboard views delivered under Phase 5. **Deferred (requires external infra):** webhooks, external API, n8n integration, email-to-card.

Each phase can be extended on top of the existing model and RLS.

## 6. Testing checklist (per spec §58)

The spec's multi-user security test **must** be run before declaring any release:

1. **User A** (admin) creates User B (member with `pm.view` etc.) and User C (member with no PM perms).
2. **User A** creates a board and adds User B as `normal`.
3. Verify:
   - User C cannot list the board, cannot fetch its cards, cannot post comments — even with hand-crafted PostgREST URLs.
   - User B cannot escalate their own role (attempt `PATCH /rest/v1/profile?id=eq.<self>` with `{role:"admin"}` → RLS/trigger denies).
   - User B cannot insert into `user_permission` for themselves (RLS denies).
   - Deactivating User B via `/users` invalidates their live sessions and blocks new sign-ins.

## 7. Attribution

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
