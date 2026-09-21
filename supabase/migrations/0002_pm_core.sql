-- ============================================================================
-- 0002_pm_core.sql
--   Phase 2: workspace/board/list/card and their satellites.
--   All tables live in the `public` schema so PostgREST exposes them, but every
--   protected table has RLS gated on board membership.
-- ============================================================================

-- ============================================================ Enums ======
do $$ begin
  create type public.board_role as enum ('admin', 'normal', 'observer');
exception when duplicate_object then null; end $$;

-- ============================================================ Workspace ==
create table if not exists public.workspace (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        citext not null unique,
  created_at  timestamptz not null default now()
);

-- Bootstrap the single company workspace.
insert into public.workspace (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'Company', 'company')
on conflict (slug) do nothing;

-- ============================================================ Board ======
create table if not exists public.board (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspace(id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  description   text,
  background    text,
  is_archived   boolean not null default false,
  created_by    uuid not null references public.profile(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists board_workspace_idx on public.board(workspace_id);
create index if not exists board_archived_idx  on public.board(is_archived);

drop trigger if exists board_updated_at on public.board;
create trigger board_updated_at before update on public.board
  for each row execute function public.set_updated_at();

-- ================================================= Board membership =====
create table if not exists public.board_member (
  board_id    uuid not null references public.board(id) on delete cascade,
  user_id     uuid not null references public.profile(id) on delete cascade,
  role        public.board_role not null default 'normal',
  created_at  timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index if not exists board_member_user_idx on public.board_member(user_id);

-- Helpers used by RLS everywhere below.
create or replace function public.is_board_member(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from public.board_member
                  where board_id = b and user_id = auth.uid());
$$;

create or replace function public.is_board_admin(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from public.board_member
                  where board_id = b and user_id = auth.uid() and role = 'admin');
$$;

-- ============================================================ List =======
create table if not exists public.list (
  id            uuid primary key default gen_random_uuid(),
  board_id      uuid not null references public.board(id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  position      text not null,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists list_board_idx on public.list(board_id, position);

drop trigger if exists list_updated_at on public.list;
create trigger list_updated_at before update on public.list
  for each row execute function public.set_updated_at();

-- ============================================================ Card =======
create sequence if not exists public.card_short_id_seq;

create table if not exists public.card (
  id                  uuid primary key default gen_random_uuid(),
  board_id            uuid not null references public.board(id) on delete cascade,
  list_id             uuid not null references public.list(id)  on delete cascade,
  short_id            bigint not null default nextval('public.card_short_id_seq'),
  title               text not null check (length(trim(title)) > 0),
  description         text,
  position            text not null,
  start_date          date,
  due_date            timestamptz,
  due_completed       boolean not null default false,
  is_archived         boolean not null default false,
  is_template         boolean not null default false,
  cover_color         text,
  cover_attachment_id uuid,
  created_by          uuid not null references public.profile(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists card_short_id_uk on public.card(short_id);
create index if not exists card_list_idx      on public.card(list_id, position);
create index if not exists card_board_idx     on public.card(board_id);
create index if not exists card_due_idx       on public.card(due_date) where due_date is not null;
create index if not exists card_archived_idx  on public.card(is_archived);

-- Full-text search vector.
alter table public.card add column if not exists search tsvector
  generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))) stored;
create index if not exists card_search_idx on public.card using gin(search);

drop trigger if exists card_updated_at on public.card;
create trigger card_updated_at before update on public.card
  for each row execute function public.set_updated_at();

-- ============================================================ Label ======
create table if not exists public.label (
  id        uuid primary key default gen_random_uuid(),
  board_id  uuid not null references public.board(id) on delete cascade,
  name      text not null default '',
  color     text not null,
  position  text not null
);
create index if not exists label_board_idx on public.label(board_id);

create table if not exists public.card_label (
  card_id  uuid not null references public.card(id)  on delete cascade,
  label_id uuid not null references public.label(id) on delete cascade,
  primary key (card_id, label_id)
);

create table if not exists public.card_member (
  card_id uuid not null references public.card(id) on delete cascade,
  user_id uuid not null references public.profile(id) on delete cascade,
  primary key (card_id, user_id)
);
create index if not exists card_member_user_idx on public.card_member(user_id);

-- ============================================================ Checklist ==
create table if not exists public.checklist (
  id       uuid primary key default gen_random_uuid(),
  card_id  uuid not null references public.card(id) on delete cascade,
  name     text not null default 'Checklist',
  position text not null
);
create index if not exists checklist_card_idx on public.checklist(card_id);

create table if not exists public.checklist_item (
  id            uuid primary key default gen_random_uuid(),
  checklist_id  uuid not null references public.checklist(id) on delete cascade,
  text          text not null,
  completed     boolean not null default false,
  position      text not null,
  assignee_id   uuid references public.profile(id),
  due_date      timestamptz
);
create index if not exists checklist_item_checklist_idx on public.checklist_item(checklist_id, position);

-- ============================================================ Attachment =
create table if not exists public.attachment (
  id            uuid primary key default gen_random_uuid(),
  card_id       uuid not null references public.card(id) on delete cascade,
  name          text not null,
  mime_type     text,
  size          bigint,
  storage_path  text,
  external_url  text,
  uploaded_by   uuid not null references public.profile(id),
  created_at    timestamptz not null default now(),
  check (storage_path is not null or external_url is not null)
);
create index if not exists attachment_card_idx on public.attachment(card_id);

alter table public.card
  add constraint card_cover_attachment_fk
  foreign key (cover_attachment_id) references public.attachment(id) on delete set null
  not valid;
alter table public.card validate constraint card_cover_attachment_fk;

-- ============================================================ Comment ====
create table if not exists public.comment (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references public.card(id) on delete cascade,
  author_id  uuid not null references public.profile(id),
  body       text not null,
  edited_at  timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists comment_card_idx on public.comment(card_id, created_at);

-- ============================================================ Activity ===
create table if not exists public.activity (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.board(id) on delete cascade,
  card_id    uuid references public.card(id) on delete set null,
  actor_id   uuid not null references public.profile(id),
  action     text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_board_idx on public.activity(board_id, created_at desc);
create index if not exists activity_card_idx  on public.activity(card_id, created_at desc);

-- Log helper — used by RPCs.
create or replace function public.log_activity(
  p_board uuid,
  p_card  uuid,
  p_action text,
  p_data jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.activity(board_id, card_id, actor_id, action, data)
  values (p_board, p_card, auth.uid(), p_action, p_data);
$$;

-- ============================================================ Notifs =====
create table if not exists public.notification (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profile(id) on delete cascade,
  board_id   uuid references public.board(id) on delete cascade,
  card_id    uuid references public.card(id) on delete cascade,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notif_user_unread_idx on public.notification(user_id, read_at nulls first, created_at desc);

create table if not exists public.subscription (
  user_id     uuid not null references public.profile(id) on delete cascade,
  entity_type text not null check (entity_type in ('board','list','card')),
  entity_id   uuid not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

-- ============================================================ RLS ========
alter table public.workspace       enable row level security;
alter table public.board           enable row level security;
alter table public.board_member    enable row level security;
alter table public.list            enable row level security;
alter table public.card            enable row level security;
alter table public.label           enable row level security;
alter table public.card_label      enable row level security;
alter table public.card_member     enable row level security;
alter table public.checklist       enable row level security;
alter table public.checklist_item  enable row level security;
alter table public.attachment      enable row level security;
alter table public.comment         enable row level security;
alter table public.activity        enable row level security;
alter table public.notification    enable row level security;
alter table public.subscription    enable row level security;

-- Every signed-in user can see the workspace row (single-workspace app).
create policy workspace_read on public.workspace
  for select to authenticated using (true);

-- Board: read if member, write if board admin (or global admin) with the right permission.
create policy board_read on public.board
  for select to authenticated
  using (public.is_board_member(id));

create policy board_insert on public.board
  for insert to authenticated
  with check (public.has_permission('pm.create_board') and created_by = auth.uid());

create policy board_update on public.board
  for update to authenticated
  using (public.is_board_admin(id) and public.has_permission('pm.edit_board'))
  with check (public.is_board_admin(id) and public.has_permission('pm.edit_board'));

create policy board_delete on public.board
  for delete to authenticated
  using (public.is_board_admin(id) and public.has_permission('pm.delete_board'));

-- Board membership: readable by any member, managed by board admins.
create policy board_member_read on public.board_member
  for select to authenticated
  using (public.is_board_member(board_id));

create policy board_member_write on public.board_member
  for all to authenticated
  using (public.is_board_admin(board_id) and public.has_permission('pm.manage_board_members'))
  with check (public.is_board_admin(board_id) and public.has_permission('pm.manage_board_members'));

-- List / card / satellites share the same shape: gated on board membership,
-- writes additionally require the matching permission.
create policy list_read on public.list
  for select to authenticated using (public.is_board_member(board_id));
create policy list_write on public.list
  for all to authenticated
  using (public.is_board_member(board_id))
  with check (public.is_board_member(board_id));

create policy card_read on public.card
  for select to authenticated using (public.is_board_member(board_id));
create policy card_write on public.card
  for all to authenticated
  using (public.is_board_member(board_id))
  with check (public.is_board_member(board_id));

create policy label_read on public.label
  for select to authenticated using (public.is_board_member(board_id));
create policy label_write on public.label
  for all to authenticated
  using (public.is_board_member(board_id) and public.has_permission('pm.manage_labels'))
  with check (public.is_board_member(board_id) and public.has_permission('pm.manage_labels'));

create policy card_label_read on public.card_label
  for select to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)));
create policy card_label_write on public.card_label
  for all to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)
                    and public.has_permission('pm.manage_labels')))
  with check (exists (select 1 from public.card c
                       where c.id = card_id and public.is_board_member(c.board_id)
                         and public.has_permission('pm.manage_labels')));

create policy card_member_read on public.card_member
  for select to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)));
create policy card_member_write on public.card_member
  for all to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)
                    and public.has_permission('pm.manage_members')))
  with check (exists (select 1 from public.card c
                       where c.id = card_id and public.is_board_member(c.board_id)
                         and public.has_permission('pm.manage_members')));

create policy checklist_read on public.checklist
  for select to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.is_board_member(c.board_id)));
create policy checklist_write on public.checklist
  for all to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)
                    and public.has_permission('pm.manage_checklists')))
  with check (exists (select 1 from public.card c
                       where c.id = card_id and public.is_board_member(c.board_id)
                         and public.has_permission('pm.manage_checklists')));

create policy checklist_item_read on public.checklist_item
  for select to authenticated
  using (exists (select 1 from public.checklist cl
                  join public.card c on c.id = cl.card_id
                  where cl.id = checklist_id and public.is_board_member(c.board_id)));
create policy checklist_item_write on public.checklist_item
  for all to authenticated
  using (exists (select 1 from public.checklist cl
                  join public.card c on c.id = cl.card_id
                  where cl.id = checklist_id and public.is_board_member(c.board_id)
                    and public.has_permission('pm.manage_checklists')))
  with check (exists (select 1 from public.checklist cl
                       join public.card c on c.id = cl.card_id
                       where cl.id = checklist_id and public.is_board_member(c.board_id)
                         and public.has_permission('pm.manage_checklists')));

create policy attachment_read on public.attachment
  for select to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.is_board_member(c.board_id)));
create policy attachment_write on public.attachment
  for all to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)
                    and public.has_permission('pm.manage_attachments')))
  with check (exists (select 1 from public.card c
                       where c.id = card_id and public.is_board_member(c.board_id)
                         and public.has_permission('pm.manage_attachments')));

create policy comment_read on public.comment
  for select to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.is_board_member(c.board_id)));
create policy comment_insert on public.comment
  for insert to authenticated
  with check (exists (select 1 from public.card c
                        where c.id = card_id and public.is_board_member(c.board_id)
                          and public.has_permission('pm.manage_comments'))
              and author_id = auth.uid());
create policy comment_update_self on public.comment
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());
create policy comment_delete_self_or_admin on public.comment
  for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

create policy activity_read on public.activity
  for select to authenticated using (public.is_board_member(board_id));
-- writes only through log_activity() (security definer); block direct inserts.
create policy activity_no_direct on public.activity
  for insert to authenticated with check (false);

create policy notification_read on public.notification
  for select to authenticated using (user_id = auth.uid());
create policy notification_update on public.notification
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy notification_delete on public.notification
  for delete to authenticated using (user_id = auth.uid());

create policy subscription_all on public.subscription
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
