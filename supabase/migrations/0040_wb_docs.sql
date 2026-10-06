-- 0040_wb_docs.sql
--   Miro Docs on whiteboards: a 'doc' item on the canvas whose rich text is a
--   Yjs document, stored as an append-only log of updates (base64). Clients
--   merge the log on open; editors compact it now and then.
--
--   live edits   private broadcast topic 'wbe:<board id>': only people who can
--                edit the board may send on it, so receivers can apply what
--                arrives straight away. The log is the source of truth.
--   Slides need no schema: they are frames (notes live in frame data).

-- ------------------------------------------------------------ item type --
alter table public.wb_item drop constraint if exists wb_item_type_check;
alter table public.wb_item add constraint wb_item_type_check
  check (type in ('sticky', 'shape', 'text', 'frame', 'image', 'connector', 'pen', 'card', 'emoji', 'doc'));

-- ---------------------------------------------------------- update log --
create table if not exists public.wb_doc_update (
  id         bigint generated always as identity primary key,
  board_id   uuid not null references public.board(id) on delete cascade,
  doc_id     uuid not null,  -- the 'doc' wb_item (soft: undo can bring a deleted doc back)
  u          text not null check (length(u) between 1 and 4000000),
  created_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists wb_doc_update_doc_idx on public.wb_doc_update(doc_id, id);
create index if not exists wb_doc_update_board_idx on public.wb_doc_update(board_id);

create or replace function public.wb_doc_update_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select kind from public.board where id = new.board_id) is distinct from 'whiteboard' then
    raise exception 'Not a whiteboard';
  end if;
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  return new;
end $$;
drop trigger if exists wb_doc_update_stamp on public.wb_doc_update;
create trigger wb_doc_update_stamp before insert on public.wb_doc_update
  for each row execute function public.wb_doc_update_stamp();
revoke execute on function public.wb_doc_update_stamp() from public, anon, authenticated;

alter table public.wb_doc_update enable row level security;
drop policy if exists wb_doc_update_read on public.wb_doc_update;
create policy wb_doc_update_read on public.wb_doc_update for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists wb_doc_update_insert on public.wb_doc_update;
create policy wb_doc_update_insert on public.wb_doc_update for insert to authenticated
  with check (board_id in (select public.editable_board_ids()));
drop policy if exists wb_doc_update_delete on public.wb_doc_update;
create policy wb_doc_update_delete on public.wb_doc_update for delete to authenticated
  using (board_id in (select public.editable_board_ids()));
revoke all on public.wb_doc_update from anon;
grant select, insert, delete on public.wb_doc_update to authenticated;

-- Replace everything up to p_upto with one merged update, in one step.
create or replace function public.wb_doc_compact(p_board uuid, p_doc uuid, p_upto bigint, p_u text)
returns bigint language plpgsql security invoker set search_path = public as $$
declare v_id bigint;
begin
  insert into public.wb_doc_update (board_id, doc_id, u) values (p_board, p_doc, p_u) returning id into v_id;
  delete from public.wb_doc_update where doc_id = p_doc and board_id = p_board and id <= p_upto;
  return v_id;
end $$;
revoke all on function public.wb_doc_compact(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.wb_doc_compact(uuid, uuid, bigint, text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wb_doc_update') then
    alter publication supabase_realtime add table public.wb_doc_update;
  end if;
end $$;

-- ------------------------------------------------- live edit channel --
drop policy if exists wb_doc_realtime_read on realtime.messages;
create policy wb_doc_realtime_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'wbe:%'
    and substr(realtime.topic(), 5) in (select b::text from public.visible_board_ids() b)
  );
drop policy if exists wb_doc_realtime_write on realtime.messages;
create policy wb_doc_realtime_write on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'wbe:%'
    and substr(realtime.topic(), 5) in (select b::text from public.editable_board_ids() b)
  );
