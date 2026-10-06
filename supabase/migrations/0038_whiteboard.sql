-- ============================================================================
-- 0038_whiteboard.sql
--   Whiteboards (Miro-style infinite canvas) built on the existing board model:
--   a whiteboard IS a board (kind = 'whiteboard'), so members, roles,
--   visibility, sharing and every permission helper apply unchanged.
--
--   wb_item          everything on the canvas (stickies, shapes, text, frames,
--                    images, connectors, pen strokes, cards, emoji)
--   wb_save()        one round trip per client flush: puts, patches, deletes
--   wb_comment       pinned comment threads (+ @mention / reply notifications)
--   wb_state         per-board timer
--   wb_vote_session  voting sessions, wb_vote the votes
--   storage          private 'whiteboard' bucket, folder = board id
--   realtime         private broadcast/presence channels 'wb:<board id>'
-- ============================================================================

-- ------------------------------------------------------------------ board --
alter table public.board add column if not exists kind text not null default 'kanban';
alter table public.board drop constraint if exists board_kind_check;
alter table public.board add constraint board_kind_check check (kind in ('kanban', 'whiteboard'));

-- Small thumbnail sketch for the boards grid (rects + colours), written by editors.
alter table public.board add column if not exists preview jsonb;
alter table public.board drop constraint if exists board_preview_size;
alter table public.board add constraint board_preview_size
  check (preview is null or octet_length(preview::text) <= 32768);

create index if not exists board_kind_idx on public.board(kind);

create or replace function public.board_kind_guard() returns trigger
language plpgsql as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'A board''s type can''t change';
  end if;
  return new;
end $$;
drop trigger if exists board_kind_guard on public.board;
create trigger board_kind_guard before update of kind on public.board
  for each row execute function public.board_kind_guard();

-- create_board gains p_kind. Whiteboards get no default labels.
drop function if exists public.create_board(text, text, text, public.board_visibility);
create or replace function public.create_board(
  p_title text,
  p_description text default null,
  p_background text default null,
  p_visibility public.board_visibility default 'workspace',
  p_kind text default 'kanban'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_ws uuid := '00000000-0000-0000-0000-000000000001';
  v_uid uuid := auth.uid();
  v_pos text;
  v_kind text := coalesce(p_kind, 'kanban');
begin
  if not public.can_create_board() then
    raise exception 'Not authorised';
  end if;
  if v_kind not in ('kanban', 'whiteboard') then
    raise exception 'Unknown board type';
  end if;

  insert into public.board (workspace_id, title, description, background, created_by, visibility, kind)
  values (v_ws, p_title, p_description, p_background, v_uid, coalesce(p_visibility, 'workspace'), v_kind)
  returning id into v_id;

  insert into public.board_member (board_id, user_id, role)
  values (v_id, v_uid, 'admin');

  if v_kind = 'kanban' then
    v_pos := public.rank_between(null, null);
    for i in 1..6 loop
      insert into public.label (board_id, name, color, position)
      values (
        v_id,
        '',
        (array['#61bd4f','#f2d600','#ff9f1a','#eb5a46','#c377e0','#0079bf'])[i],
        public.rank_between(v_pos, null)
      );
      v_pos := public.rank_between(v_pos, null);
    end loop;
  end if;

  perform public.log_activity(v_id, null, 'board.created', jsonb_build_object('title', p_title, 'kind', v_kind));
  return v_id;
end $$;
revoke all on function public.create_board(text, text, text, public.board_visibility, text) from public, anon;
grant execute on function public.create_board(text, text, text, public.board_visibility, text) to authenticated;

-- ---------------------------------------------------------------- wb_item --
create table if not exists public.wb_item (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.board(id) on delete cascade,
  type       text not null check (type in ('sticky', 'shape', 'text', 'frame', 'image', 'connector', 'pen', 'card', 'emoji')),
  x          double precision not null default 0 check (abs(x) <= 10000000),
  y          double precision not null default 0 check (abs(y) <= 10000000),
  w          double precision not null default 0 check (w >= 0 and w <= 1000000),
  h          double precision not null default 0 check (h >= 0 and h <= 1000000),
  rotation   double precision not null default 0 check (abs(rotation) <= 360),
  z          double precision not null default 0,
  frame_id   uuid,  -- soft reference: the frame this item sits in
  group_id   uuid,  -- soft reference: items sharing an id move together
  locked     boolean not null default false,
  data       jsonb not null default '{}'::jsonb
             check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 262144),
  sid        text check (sid is null or length(sid) <= 64),  -- writer's tab, for echo detection
  created_by uuid references public.profile(id) on delete set null,
  updated_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wb_item_board_idx on public.wb_item(board_id);

-- Stamps, keeps rows on their board, and only allows whiteboards.
create or replace function public.wb_item_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if (select kind from public.board where id = new.board_id) is distinct from 'whiteboard' then
      raise exception 'Not a whiteboard';
    end if;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.board_id   := old.board_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists wb_item_stamp on public.wb_item;
create trigger wb_item_stamp before insert or update on public.wb_item
  for each row execute function public.wb_item_stamp();

alter table public.wb_item enable row level security;
drop policy if exists wb_item_read on public.wb_item;
create policy wb_item_read on public.wb_item for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists wb_item_write on public.wb_item;
create policy wb_item_write on public.wb_item for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));
grant select, insert, update, delete on public.wb_item to authenticated;

-- Top-level keys whose value is JSON null are removed (a patch "unsets" them).
create or replace function public._jsonb_drop_nulls(j jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(j) as e(k, v) where jsonb_typeof(v) <> 'null';
$$;

-- One flush from a client. Runs as the caller, so RLS decides every row.
--   p_put    full items (create / restore), upserted
--   p_patch  {id, <changed columns>, data: {<changed keys>}} merged into the row
--   p_delete ids to remove
create or replace function public.wb_save(
  p_board  uuid,
  p_put    jsonb default '[]'::jsonb,
  p_patch  jsonb default '[]'::jsonb,
  p_delete uuid[] default '{}',
  p_sid    text default null
) returns void language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  if not public.can_edit_board(p_board) then
    raise exception 'Not authorised';
  end if;
  if jsonb_array_length(coalesce(p_put, '[]')) + jsonb_array_length(coalesce(p_patch, '[]'))
     + coalesce(array_length(p_delete, 1), 0) > 5000 then
    raise exception 'Too many changes at once';
  end if;

  insert into public.wb_item as t (id, board_id, type, x, y, w, h, rotation, z, frame_id, group_id, locked, data, sid)
  select (e->>'id')::uuid, p_board, e->>'type',
         coalesce((e->>'x')::float8, 0), coalesce((e->>'y')::float8, 0),
         coalesce((e->>'w')::float8, 0), coalesce((e->>'h')::float8, 0),
         coalesce((e->>'rotation')::float8, 0), coalesce((e->>'z')::float8, 0),
         (e->>'frame_id')::uuid, (e->>'group_id')::uuid,
         coalesce((e->>'locked')::boolean, false),
         public._jsonb_drop_nulls(coalesce(e->'data', '{}'::jsonb)), p_sid
    from jsonb_array_elements(coalesce(p_put, '[]'::jsonb)) e
  on conflict (id) do update set
    type = excluded.type, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
    rotation = excluded.rotation, z = excluded.z, frame_id = excluded.frame_id,
    group_id = excluded.group_id, locked = excluded.locked, data = excluded.data, sid = excluded.sid
  where t.board_id = p_board;

  for r in select * from jsonb_array_elements(coalesce(p_patch, '[]'::jsonb)) loop
    update public.wb_item set
      x        = coalesce((r->>'x')::float8, x),
      y        = coalesce((r->>'y')::float8, y),
      w        = coalesce((r->>'w')::float8, w),
      h        = coalesce((r->>'h')::float8, h),
      rotation = coalesce((r->>'rotation')::float8, rotation),
      z        = coalesce((r->>'z')::float8, z),
      frame_id = case when r ? 'frame_id' then (r->>'frame_id')::uuid else frame_id end,
      group_id = case when r ? 'group_id' then (r->>'group_id')::uuid else group_id end,
      locked   = coalesce((r->>'locked')::boolean, locked),
      data     = case when jsonb_typeof(r->'data') = 'object'
                      then public._jsonb_drop_nulls(data || (r->'data')) else data end,
      sid      = p_sid
    where id = (r->>'id')::uuid and board_id = p_board;
  end loop;

  if coalesce(array_length(p_delete, 1), 0) > 0 then
    delete from public.wb_item where board_id = p_board and id = any(p_delete);
  end if;
end $$;
revoke all on function public.wb_save(uuid, jsonb, jsonb, uuid[], text) from public, anon;
grant execute on function public.wb_save(uuid, jsonb, jsonb, uuid[], text) to authenticated;

-- ------------------------------------------------------------- wb_comment --
create table if not exists public.wb_comment (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.board(id) on delete cascade,
  thread_id  uuid references public.wb_comment(id) on delete cascade,  -- null = thread root
  item_id    uuid,                -- root only: pinned to this item (soft reference)
  x          double precision,    -- root only: canvas point (offset inside the item when item_id is set)
  y          double precision,
  author_id  uuid not null references public.profile(id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 10000),
  resolved   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wb_comment_board_idx on public.wb_comment(board_id);
create index if not exists wb_comment_thread_idx on public.wb_comment(thread_id);

create or replace function public.wb_comment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_root public.wb_comment;
begin
  if tg_op = 'INSERT' then
    new.author_id := coalesce(auth.uid(), new.author_id);
    new.created_at := now();
    new.resolved := false;
    if new.thread_id is not null then
      select * into v_root from public.wb_comment where id = new.thread_id;
      if v_root.id is null or v_root.board_id <> new.board_id or v_root.thread_id is not null then
        raise exception 'Reply must belong to a thread on the same board';
      end if;
      new.item_id := null; new.x := null; new.y := null;
    elsif new.x is null or new.y is null then
      raise exception 'A comment thread needs a position';
    end if;
  else
    new.board_id := old.board_id;
    new.thread_id := old.thread_id;
    new.author_id := old.author_id;
    new.created_at := old.created_at;
    -- Only the author edits the text; anyone who may comment moves / resolves.
    if auth.uid() is not null and new.body is distinct from old.body and old.author_id <> auth.uid() then
      raise exception 'Only the author can edit a comment';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists wb_comment_guard on public.wb_comment;
create trigger wb_comment_guard before insert or update on public.wb_comment
  for each row execute function public.wb_comment_guard();

alter table public.wb_comment enable row level security;
drop policy if exists wb_comment_read on public.wb_comment;
create policy wb_comment_read on public.wb_comment for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists wb_comment_insert on public.wb_comment;
create policy wb_comment_insert on public.wb_comment for insert to authenticated
  with check (public.can_comment_board(board_id) and author_id = auth.uid());
drop policy if exists wb_comment_update on public.wb_comment;
create policy wb_comment_update on public.wb_comment for update to authenticated
  using (public.can_comment_board(board_id))
  with check (public.can_comment_board(board_id));
drop policy if exists wb_comment_delete on public.wb_comment;
create policy wb_comment_delete on public.wb_comment for delete to authenticated
  using ((author_id = auth.uid() and public.can_comment_board(board_id)) or public.is_board_admin(board_id));
grant select, insert, update, delete on public.wb_comment to authenticated;

-- @username mentions and replies notify people (in-app; 0037 mirrors to WhatsApp / email).
create or replace function public.wb_comment_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_root uuid := coalesce(new.thread_id, new.id);
  v_title text;
  v_by text;
  v_excerpt text := left(regexp_replace(new.body, '\s+', ' ', 'g'), 140);
begin
  select title into v_title from public.board where id = new.board_id;
  select display_name into v_by from public.profile where id = new.author_id;

  -- Mentioned people who can see the board.
  insert into public.notification (user_id, board_id, kind, data)
  select distinct p.id, new.board_id, 'wb_mention',
         jsonb_build_object('comment_id', new.id, 'thread_id', v_root, 'board_title', v_title,
                            'by', v_by, 'excerpt', v_excerpt)
    from regexp_matches(new.body, '@([A-Za-z0-9._-]{3,32})', 'g') m
    join public.profile p on lower(p.username) = lower(m[1])
   where p.is_active and p.id <> new.author_id
     and public._can_see_board_as(p.id, new.board_id);

  -- Replies: everyone else already in the thread (not re-notifying mentions).
  if new.thread_id is not null then
    insert into public.notification (user_id, board_id, kind, data)
    select distinct c.author_id, new.board_id, 'wb_reply',
           jsonb_build_object('comment_id', new.id, 'thread_id', v_root, 'board_title', v_title,
                              'by', v_by, 'excerpt', v_excerpt)
      from public.wb_comment c
      join public.profile p on p.id = c.author_id and p.is_active
     where (c.id = new.thread_id or c.thread_id = new.thread_id)
       and c.author_id <> new.author_id
       and public._can_see_board_as(c.author_id, new.board_id)
       and not exists (
         select 1 from regexp_matches(new.body, '@([A-Za-z0-9._-]{3,32})', 'g') m
          where lower(m[1]) = lower(p.username));
  end if;
  return null;
end $$;

-- Board visibility for an arbitrary user (same rules as visible_board_ids()).
create or replace function public._can_see_board_as(p_user uuid, p_board uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profile pr
     where pr.id = p_user and pr.is_active
       and (pr.role = 'admin'
            or exists (select 1 from public.board_member bm where bm.board_id = p_board and bm.user_id = p_user)
            or (pr.role = 'member' and exists (select 1 from public.board b where b.id = p_board and b.visibility = 'workspace'))));
$$;
revoke all on function public._can_see_board_as(uuid, uuid) from public, anon, authenticated;

drop trigger if exists wb_comment_notify on public.wb_comment;
create trigger wb_comment_notify after insert on public.wb_comment
  for each row execute function public.wb_comment_notify();

-- --------------------------------------------------------------- wb_state --
-- Timer shared by everyone on the board. Running: ends_at set. Paused: left_ms set.
create table if not exists public.wb_state (
  board_id       uuid primary key references public.board(id) on delete cascade,
  timer_ends_at  timestamptz,
  timer_left_ms  integer check (timer_left_ms is null or timer_left_ms between 0 and 86400000),
  timer_total_ms integer check (timer_total_ms is null or timer_total_ms between 0 and 86400000),
  timer_by       uuid references public.profile(id) on delete set null,
  updated_at     timestamptz not null default now()
);
alter table public.wb_state enable row level security;
drop policy if exists wb_state_read on public.wb_state;
create policy wb_state_read on public.wb_state for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists wb_state_write on public.wb_state;
create policy wb_state_write on public.wb_state for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));
grant select, insert, update, delete on public.wb_state to authenticated;

create or replace function public.wb_state_stamp() returns trigger
language plpgsql as $$
begin
  new.timer_by := coalesce(auth.uid(), new.timer_by);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists wb_state_stamp on public.wb_state;
create trigger wb_state_stamp before insert or update on public.wb_state
  for each row execute function public.wb_state_stamp();

-- ----------------------------------------------------------------- voting --
create table if not exists public.wb_vote_session (
  id             uuid primary key default gen_random_uuid(),
  board_id       uuid not null references public.board(id) on delete cascade,
  title          text not null default 'Voting' check (length(title) between 1 and 200),
  votes_per_user integer not null default 3 check (votes_per_user between 1 and 99),
  one_per_item   boolean not null default false,
  status         text not null default 'open' check (status in ('open', 'closed')),
  created_by     uuid references public.profile(id) on delete set null,
  created_at     timestamptz not null default now(),
  closed_at      timestamptz
);
create index if not exists wb_vote_session_board_idx on public.wb_vote_session(board_id);
-- At most one open session per board.
create unique index if not exists wb_vote_session_open_idx on public.wb_vote_session(board_id) where status = 'open';

create table if not exists public.wb_vote (
  session_id uuid not null references public.wb_vote_session(id) on delete cascade,
  board_id   uuid not null references public.board(id) on delete cascade,
  item_id    uuid not null,
  user_id    uuid not null references public.profile(id) on delete cascade,
  n          integer not null default 1 check (n between 1 and 99),
  primary key (session_id, item_id, user_id)
);
create index if not exists wb_vote_board_idx on public.wb_vote(board_id);

create or replace function public.wb_vote_session_stamp() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.status := 'open';
    new.closed_at := null;
  else
    new.board_id := old.board_id;
    new.created_by := old.created_by;
    if new.status = 'closed' and old.status = 'open' then new.closed_at := now(); end if;
    if old.status = 'closed' and new.status = 'open' then
      raise exception 'A closed voting session can''t reopen';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists wb_vote_session_stamp on public.wb_vote_session;
create trigger wb_vote_session_stamp before insert or update on public.wb_vote_session
  for each row execute function public.wb_vote_session_stamp();

alter table public.wb_vote_session enable row level security;
drop policy if exists wb_vote_session_read on public.wb_vote_session;
create policy wb_vote_session_read on public.wb_vote_session for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists wb_vote_session_write on public.wb_vote_session;
create policy wb_vote_session_write on public.wb_vote_session for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));
grant select, insert, update, delete on public.wb_vote_session to authenticated;

-- Votes: anyone who can see the board votes while the session is open, within the limit.
-- Others' votes stay hidden until the session closes (the RPC below returns totals).
alter table public.wb_vote enable row level security;
drop policy if exists wb_vote_read on public.wb_vote;
create policy wb_vote_read on public.wb_vote for select to authenticated
  using (user_id = auth.uid() and board_id in (select public.visible_board_ids()));
grant select on public.wb_vote to authenticated;

create or replace function public.wb_cast_vote(p_session uuid, p_item uuid, p_delta integer)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.wb_vote_session;
  v_used integer;
  v_now integer;
begin
  select * into s from public.wb_vote_session where id = p_session for update;
  if s.id is null or s.status <> 'open' then raise exception 'Voting is closed'; end if;
  if not exists (select 1 from public.visible_board_ids() b where b = s.board_id) then
    raise exception 'Not authorised';
  end if;
  if not exists (select 1 from public.wb_item where id = p_item and board_id = s.board_id) then
    raise exception 'Item not found';
  end if;
  if p_delta not in (-1, 1) then raise exception 'Bad vote'; end if;

  select coalesce(sum(n), 0) into v_used from public.wb_vote where session_id = p_session and user_id = auth.uid();
  select coalesce(n, 0) into v_now from public.wb_vote where session_id = p_session and user_id = auth.uid() and item_id = p_item;
  v_now := coalesce(v_now, 0);

  if p_delta = 1 then
    if v_used >= s.votes_per_user then raise exception 'No votes left'; end if;
    if s.one_per_item and v_now >= 1 then raise exception 'One vote per item'; end if;
    insert into public.wb_vote (session_id, board_id, item_id, user_id, n)
    values (p_session, s.board_id, p_item, auth.uid(), 1)
    on conflict (session_id, item_id, user_id) do update set n = public.wb_vote.n + 1;
    return v_now + 1;
  end if;

  if v_now <= 1 then
    delete from public.wb_vote where session_id = p_session and user_id = auth.uid() and item_id = p_item;
    return 0;
  end if;
  update public.wb_vote set n = n - 1 where session_id = p_session and user_id = auth.uid() and item_id = p_item;
  return v_now - 1;
end $$;
revoke all on function public.wb_cast_vote(uuid, uuid, integer) from public, anon;
grant execute on function public.wb_cast_vote(uuid, uuid, integer) to authenticated;

-- Totals per item: open sessions show only how many people have voted.
create or replace function public.wb_vote_results(p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.wb_vote_session;
begin
  select * into s from public.wb_vote_session where id = p_session;
  if s.id is null or not exists (select 1 from public.visible_board_ids() b where b = s.board_id) then
    raise exception 'Not found';
  end if;
  return jsonb_build_object(
    'voters', (select count(distinct user_id) from public.wb_vote where session_id = p_session),
    'items', case when s.status = 'closed' then
      coalesce((select jsonb_object_agg(item_id, total) from (
        select item_id, sum(n) as total from public.wb_vote where session_id = p_session group by item_id) t), '{}'::jsonb)
      else '{}'::jsonb end);
end $$;
revoke all on function public.wb_vote_results(uuid) from public, anon;
grant execute on function public.wb_vote_results(uuid) to authenticated;

-- --------------------------------------------------------------- realtime --
do $$
declare t text;
begin
  foreach t in array array['wb_item', 'wb_comment', 'wb_state', 'wb_vote_session'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Private broadcast / presence channels: topic 'wb:<board id>', board viewers only.
drop policy if exists wb_realtime_read on realtime.messages;
create policy wb_realtime_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'wb:%'
    and substr(realtime.topic(), 4) in (select b::text from public.visible_board_ids() b)
  );
drop policy if exists wb_realtime_write on realtime.messages;
create policy wb_realtime_write on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'wb:%'
    and substr(realtime.topic(), 4) in (select b::text from public.visible_board_ids() b)
  );

-- ---------------------------------------------------------------- storage --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('whiteboard', 'whiteboard', false, 15728640,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists wb_media_read on storage.objects;
create policy wb_media_read on storage.objects for select to authenticated
  using (bucket_id = 'whiteboard'
         and (storage.foldername(name))[1] in (select b::text from public.visible_board_ids() b));
drop policy if exists wb_media_insert on storage.objects;
create policy wb_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'whiteboard' and owner = auth.uid()
              and (storage.foldername(name))[1] in (select b::text from public.editable_board_ids() b));
drop policy if exists wb_media_delete on storage.objects;
create policy wb_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'whiteboard' and owner = auth.uid());

-- ------------------------------------------- notifications to channels --
-- Same as 0037, plus whiteboard kinds and links that open the whiteboard.
create or replace function public.on_notification_channels()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c      public.profile_contact;
  v_card text;
  v_brd  text;
  v_kind text;
  v_what text;
  v_link text;
  v_msg  text;
begin
  select * into c from public.profile_contact where user_id = new.user_id;
  if not found or not (c.notify_whatsapp or c.notify_email) then return new; end if;
  select title into v_card from public.card where id = new.card_id;
  select title, kind into v_brd, v_kind from public.board where id = new.board_id;
  v_what := case new.kind
    when 'mention'       then 'You were mentioned'
    when 'assigned'      then 'You were added to a card'
    when 'comment'       then 'New comment'
    when 'due_changed'   then 'Due date changed'
    when 'due_completed' then 'Marked complete'
    when 'board_invited' then 'You were added to a board'
    when 'automation'    then coalesce(nullif(new.data->>'text', ''), 'Rule')
    when 'wb_mention'    then coalesce(new.data->>'by', 'Someone') || ' mentioned you'
    when 'wb_reply'      then coalesce(new.data->>'by', 'Someone') || ' replied'
    else new.kind end;
  if v_kind = 'whiteboard' then
    v_link := (select rtrim(app_url, '/') from public.workspace limit 1) || '/#/wb/' || new.board_id
              || coalesce('?comment=' || (new.data->>'thread_id'), '');
  else
    v_link := (select rtrim(app_url, '/') from public.workspace limit 1) || '/#/pm/boards/' || new.board_id
              || coalesce('/cards/' || new.card_id, '');
  end if;
  v_msg := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
           || coalesce(E'\n"' || (new.data->>'excerpt') || '"', '')
           || case when new.board_id is not null then E'\n' || v_link else '' end;
  begin
    if c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'Iklipse: ' || v_msg); end if;
    if c.notify_email then perform public._send_email(new.user_id, 'Iklipse: ' || v_what, v_msg); end if;
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
revoke execute on function public.on_notification_channels() from public, anon, authenticated;
