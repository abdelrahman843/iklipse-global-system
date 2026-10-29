-- ============================================================================
-- 0133_design_mode.sql
--   Design mode: a Figma-style UI/UX document on a whiteboard. A whiteboard
--   board gets one design document; it shares the board's members, roles,
--   sharing settings and every permission helper, and touches nothing the
--   whiteboard itself stores (wb_item, wb_comment stay as they are).
--
--   design_doc       document-wide parts (pages, colour / text styles, tokens)
--   design_node      one row per layer; the layer's properties live in `data`
--   design_save()    one round trip per client flush: puts, deletes, doc
--   design_version   saved versions (full snapshots), design_snapshot() /
--                    design_restore()
--   design_comment   comment threads pinned on design layers / canvas points
--   realtime         row changes on the three tables; live cursors use the
--                    board's existing private channel 'wb:<board id>'
--
--   Additive only: new tables and functions, no change to existing ones.
-- ============================================================================

-- ------------------------------------------------------------- design_doc --
create table if not exists public.design_doc (
  board_id   uuid primary key references public.board(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb
             check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 1048576),
  sid        text check (sid is null or length(sid) <= 64),
  updated_by uuid references public.profile(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------ design_node --
create table if not exists public.design_node (
  id         uuid primary key,
  board_id   uuid not null references public.board(id) on delete cascade,
  page       text not null check (length(page) between 1 and 64),
  parent_id  uuid,              -- soft reference: the layer this one sits in
  ord        double precision not null default 0,
  data       jsonb not null default '{}'::jsonb
             check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 2097152),
  sid        text check (sid is null or length(sid) <= 64),  -- writer's tab, for echo detection
  created_by uuid references public.profile(id) on delete set null,
  updated_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists design_node_board_idx on public.design_node(board_id);

-- Stamps rows, keeps them on their board, and only allows whiteboards.
create or replace function public.design_row_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if (select kind from public.board where id = new.board_id) is distinct from 'whiteboard' then
      raise exception 'Not a whiteboard';
    end if;
  else
    new.board_id := old.board_id;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;

create or replace function public.design_node_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists design_doc_stamp on public.design_doc;
create trigger design_doc_stamp before insert or update on public.design_doc
  for each row execute function public.design_row_stamp();
drop trigger if exists design_node_stamp on public.design_node;
create trigger design_node_stamp before insert or update on public.design_node
  for each row execute function public.design_row_stamp();
drop trigger if exists design_node_stamp_created on public.design_node;
create trigger design_node_stamp_created before insert or update on public.design_node
  for each row execute function public.design_node_stamp();

alter table public.design_doc enable row level security;
drop policy if exists design_doc_read on public.design_doc;
create policy design_doc_read on public.design_doc for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists design_doc_write on public.design_doc;
create policy design_doc_write on public.design_doc for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));
grant select, insert, update, delete on public.design_doc to authenticated;

alter table public.design_node enable row level security;
drop policy if exists design_node_read on public.design_node;
create policy design_node_read on public.design_node for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists design_node_write on public.design_node;
create policy design_node_write on public.design_node for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));
grant select, insert, update, delete on public.design_node to authenticated;

-- One flush from a client. Runs as the caller, so RLS decides every row.
--   p_put    full layers {id, page, parent_id, ord, data}, upserted
--   p_delete layer ids to remove
--   p_doc    the document-wide data, when it changed (null = unchanged)
create or replace function public.design_save(
  p_board  uuid,
  p_put    jsonb default '[]'::jsonb,
  p_delete uuid[] default '{}',
  p_doc    jsonb default null,
  p_sid    text default null
) returns void language plpgsql security invoker set search_path = public as $$
begin
  if not public.can_edit_board(p_board) then
    raise exception 'Not authorised';
  end if;
  if jsonb_array_length(coalesce(p_put, '[]')) + coalesce(array_length(p_delete, 1), 0) > 5000 then
    raise exception 'Too many changes at once';
  end if;

  if p_doc is not null then
    insert into public.design_doc as t (board_id, data, sid)
    values (p_board, p_doc, p_sid)
    on conflict (board_id) do update set data = excluded.data, sid = excluded.sid;
  end if;

  insert into public.design_node as t (id, board_id, page, parent_id, ord, data, sid)
  select (e->>'id')::uuid, p_board, e->>'page', (e->>'parent_id')::uuid,
         coalesce((e->>'ord')::float8, 0), coalesce(e->'data', '{}'::jsonb), p_sid
    from jsonb_array_elements(coalesce(p_put, '[]'::jsonb)) e
  on conflict (id) do update set
    page = excluded.page, parent_id = excluded.parent_id, ord = excluded.ord,
    data = excluded.data, sid = excluded.sid
  where t.board_id = p_board;

  if coalesce(array_length(p_delete, 1), 0) > 0 then
    delete from public.design_node where board_id = p_board and id = any(p_delete);
  end if;
end $$;
revoke all on function public.design_save(uuid, jsonb, uuid[], jsonb, text) from public, anon;
grant execute on function public.design_save(uuid, jsonb, uuid[], jsonb, text) to authenticated;

-- --------------------------------------------------------- design_version --
create table if not exists public.design_version (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.board(id) on delete cascade,
  label      text check (label is null or length(label) <= 200),
  auto       boolean not null default false,
  doc        jsonb not null default '{}'::jsonb,
  nodes      jsonb not null default '[]'::jsonb,
  node_count integer not null default 0,
  created_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists design_version_board_idx on public.design_version(board_id, created_at desc);

alter table public.design_version enable row level security;
drop policy if exists design_version_read on public.design_version;
create policy design_version_read on public.design_version for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists design_version_write on public.design_version;
create policy design_version_write on public.design_version for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));
grant select, insert, update, delete on public.design_version to authenticated;

-- Saves the current document as a version (built on the server, so a big
-- document isn't uploaded). Keeps the newest 100 per board.
create or replace function public.design_snapshot(p_board uuid, p_label text default null, p_auto boolean default false)
returns uuid language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  if not public.can_edit_board(p_board) then
    raise exception 'Not authorised';
  end if;
  insert into public.design_version (board_id, label, auto, doc, nodes, node_count, created_by)
  select p_board, left(p_label, 200), coalesce(p_auto, false),
         coalesce((select data from public.design_doc where board_id = p_board), '{}'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('id', id, 'page', page, 'parent_id', parent_id, 'ord', ord, 'data', data))
                     from public.design_node where board_id = p_board), '[]'::jsonb),
         (select count(*) from public.design_node where board_id = p_board),
         auth.uid()
  returning id into v_id;

  delete from public.design_version
   where board_id = p_board
     and id not in (select id from public.design_version where board_id = p_board order by created_at desc limit 100);
  return v_id;
end $$;
revoke all on function public.design_snapshot(uuid, text, boolean) from public, anon;
grant execute on function public.design_snapshot(uuid, text, boolean) to authenticated;

-- Puts a saved version back. What was there first becomes a version too.
create or replace function public.design_restore(p_version uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare v public.design_version;
begin
  select * into v from public.design_version where id = p_version;
  if v.id is null or not public.can_edit_board(v.board_id) then
    raise exception 'Not authorised';
  end if;
  perform public.design_snapshot(v.board_id, 'Before restoring a version', true);

  delete from public.design_node where board_id = v.board_id;
  insert into public.design_node (id, board_id, page, parent_id, ord, data)
  select (e->>'id')::uuid, v.board_id, e->>'page', (e->>'parent_id')::uuid,
         coalesce((e->>'ord')::float8, 0), coalesce(e->'data', '{}'::jsonb)
    from jsonb_array_elements(v.nodes) e;

  insert into public.design_doc as t (board_id, data)
  values (v.board_id, v.doc)
  on conflict (board_id) do update set data = excluded.data, sid = null;
end $$;
revoke all on function public.design_restore(uuid) from public, anon;
grant execute on function public.design_restore(uuid) to authenticated;

-- --------------------------------------------------------- design_comment --
create table if not exists public.design_comment (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.board(id) on delete cascade,
  thread_id  uuid references public.design_comment(id) on delete cascade,  -- null = thread root
  page       text check (page is null or length(page) <= 64),  -- root only
  node_id    text check (node_id is null or length(node_id) <= 400),  -- root only: pinned layer (soft reference)
  x          double precision,  -- root only: page point (offset inside the layer when node_id is set)
  y          double precision,
  author_id  uuid not null references public.profile(id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 10000),
  resolved   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists design_comment_board_idx on public.design_comment(board_id);
create index if not exists design_comment_thread_idx on public.design_comment(thread_id);

create or replace function public.design_comment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_root public.design_comment;
begin
  if tg_op = 'INSERT' then
    new.author_id := coalesce(auth.uid(), new.author_id);
    new.created_at := now();
    new.resolved := false;
    if (select kind from public.board where id = new.board_id) is distinct from 'whiteboard' then
      raise exception 'Not a whiteboard';
    end if;
    if new.thread_id is not null then
      select * into v_root from public.design_comment where id = new.thread_id;
      if v_root.id is null or v_root.board_id <> new.board_id or v_root.thread_id is not null then
        raise exception 'Reply must belong to a thread on the same board';
      end if;
      new.node_id := null; new.x := null; new.y := null; new.page := null;
    elsif new.x is null or new.y is null or new.page is null then
      raise exception 'A comment thread needs a position';
    end if;
  else
    new.board_id := old.board_id;
    new.thread_id := old.thread_id;
    new.author_id := old.author_id;
    new.created_at := old.created_at;
    if auth.uid() is not null and new.body is distinct from old.body and old.author_id <> auth.uid() then
      raise exception 'Only the author can edit a comment';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists design_comment_guard on public.design_comment;
create trigger design_comment_guard before insert or update on public.design_comment
  for each row execute function public.design_comment_guard();

alter table public.design_comment enable row level security;
drop policy if exists design_comment_read on public.design_comment;
create policy design_comment_read on public.design_comment for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists design_comment_insert on public.design_comment;
create policy design_comment_insert on public.design_comment for insert to authenticated
  with check (public.can_comment_board(board_id) and author_id = auth.uid());
drop policy if exists design_comment_update on public.design_comment;
create policy design_comment_update on public.design_comment for update to authenticated
  using (public.can_comment_board(board_id))
  with check (public.can_comment_board(board_id));
drop policy if exists design_comment_delete on public.design_comment;
create policy design_comment_delete on public.design_comment for delete to authenticated
  using ((author_id = auth.uid() and public.can_comment_board(board_id)) or public.is_board_admin(board_id));
grant select, insert, update, delete on public.design_comment to authenticated;

-- --------------------------------------------------------------- realtime --
do $$
declare t text;
begin
  foreach t in array array['design_doc', 'design_node', 'design_comment'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
