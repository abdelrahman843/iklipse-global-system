-- =============================================================================
-- 0016 — Realtime coverage.
--
-- 1. Denormalised parent ids so the app can subscribe with simple realtime
--    filters (Supabase filters on one column of the changed row):
--      checklist_item.card_id          → card modal listens by card_id
--      card_label.board_id / card_member.board_id → board listens by board_id
--    Filled by triggers, like comment_reaction.card_id (0011).
-- 2. Add every table the UI shows live to the supabase_realtime publication.
--    Realtime still applies each table's RLS SELECT policy per subscriber.
-- =============================================================================

-- ------------------------------------------------------ checklist_item.card_id
alter table public.checklist_item add column if not exists card_id uuid references public.card(id) on delete cascade;
update public.checklist_item i set card_id = c.card_id
  from public.checklist c where c.id = i.checklist_id and i.card_id is distinct from c.card_id;
create index if not exists checklist_item_card_idx on public.checklist_item(card_id);

create or replace function public.trg_checklist_item_card() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select card_id into new.card_id from public.checklist where id = new.checklist_id;
  return new;
end $$;
drop trigger if exists checklist_item_card on public.checklist_item;
create trigger checklist_item_card before insert or update of checklist_id on public.checklist_item
  for each row execute function public.trg_checklist_item_card();

-- ------------------------------------------- card_label / card_member.board_id
alter table public.card_label  add column if not exists board_id uuid references public.board(id) on delete cascade;
alter table public.card_member add column if not exists board_id uuid references public.board(id) on delete cascade;
update public.card_label  x set board_id = c.board_id from public.card c where c.id = x.card_id and x.board_id is distinct from c.board_id;
update public.card_member x set board_id = c.board_id from public.card c where c.id = x.card_id and x.board_id is distinct from c.board_id;
create index if not exists card_label_board_idx  on public.card_label(board_id);
create index if not exists card_member_board_idx on public.card_member(board_id);

create or replace function public.trg_card_child_board() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select board_id into new.board_id from public.card where id = new.card_id;
  return new;
end $$;
drop trigger if exists card_label_board on public.card_label;
create trigger card_label_board before insert or update of card_id on public.card_label
  for each row execute function public.trg_card_child_board();
drop trigger if exists card_member_board on public.card_member;
create trigger card_member_board before insert or update of card_id on public.card_member
  for each row execute function public.trg_card_child_board();

-- A card moved to another board carries its label/member rows along.
create or replace function public.trg_card_board_moved() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.board_id is distinct from old.board_id then
    update public.card_label  set board_id = new.board_id where card_id = new.id;
    update public.card_member set board_id = new.board_id where card_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists card_board_moved on public.card;
create trigger card_board_moved after update of board_id on public.card
  for each row execute function public.trg_card_board_moved();

-- ------------------------------------------------------------- publication --
do $$
declare t text;
begin
  foreach t in array array[
    'board', 'checklist', 'checklist_item', 'attachment',
    'custom_field_def', 'custom_field_value',
    'automation_rule', 'automation_run',
    'profile', 'workspace'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
