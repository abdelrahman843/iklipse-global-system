-- ============================================================================
-- 0005_custom_fields_templates.sql
--   Board-scoped custom fields + template cloning helpers.
-- ============================================================================

-- Field types supported.
do $$ begin
  create type public.custom_field_type as enum ('text','number','date','checkbox','select');
exception when duplicate_object then null; end $$;

create table if not exists public.custom_field_def (
  id             uuid primary key default gen_random_uuid(),
  board_id       uuid not null references public.board(id) on delete cascade,
  name           text not null,
  type           public.custom_field_type not null,
  options        jsonb, -- array of {id,label,color} for select
  show_on_front  boolean not null default false,
  position       text not null,
  created_at     timestamptz not null default now()
);
create index if not exists custom_field_def_board_idx on public.custom_field_def(board_id, position);

create table if not exists public.custom_field_value (
  card_id  uuid not null references public.card(id) on delete cascade,
  field_id uuid not null references public.custom_field_def(id) on delete cascade,
  value    jsonb,
  primary key (card_id, field_id)
);
create index if not exists custom_field_value_card_idx on public.custom_field_value(card_id);

alter table public.custom_field_def   enable row level security;
alter table public.custom_field_value enable row level security;

create policy custom_field_def_read on public.custom_field_def
  for select to authenticated using (public.is_board_member(board_id));
create policy custom_field_def_write on public.custom_field_def
  for all to authenticated
  using (public.is_board_member(board_id) and public.has_permission('pm.manage_custom_fields'))
  with check (public.is_board_member(board_id) and public.has_permission('pm.manage_custom_fields'));

create policy custom_field_value_read on public.custom_field_value
  for select to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)));
create policy custom_field_value_write on public.custom_field_value
  for all to authenticated
  using (exists (select 1 from public.card c
                  where c.id = card_id and public.is_board_member(c.board_id)))
  with check (exists (select 1 from public.card c
                       where c.id = card_id and public.is_board_member(c.board_id)));

-- ============================================================ Templates =

-- Clone a template card into a target list. Returns the new card id.
create or replace function public.clone_card(
  p_source_card uuid,
  p_target_list uuid,
  p_after_position text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_new_id uuid;
  v_pos    text;
  v_board  uuid;
  v_uid    uuid := auth.uid();
begin
  select board_id into v_board from public.list where id = p_target_list;
  if v_board is null or not public.is_board_member(v_board) then
    raise exception 'Not authorised';
  end if;
  if not public.has_permission('pm.copy_card') then raise exception 'Not authorised'; end if;

  v_pos := public.rank_between(p_after_position, null);

  insert into public.card (board_id, list_id, title, description, position, created_by)
  select v_board, p_target_list, title, description, v_pos, v_uid
    from public.card where id = p_source_card
    returning id into v_new_id;

  -- Copy labels + checklists + custom values.
  insert into public.card_label (card_id, label_id)
  select v_new_id, label_id from public.card_label where card_id = p_source_card;

  insert into public.checklist (id, card_id, name, position)
  select gen_random_uuid(), v_new_id, name, position from public.checklist where card_id = p_source_card;

  insert into public.checklist_item (checklist_id, text, completed, position, assignee_id, due_date)
  select new_cl.id, ci.text, false, ci.position, ci.assignee_id, ci.due_date
    from public.checklist_item ci
    join public.checklist old_cl on old_cl.id = ci.checklist_id
    join public.checklist new_cl on new_cl.card_id = v_new_id and new_cl.name = old_cl.name;

  insert into public.custom_field_value (card_id, field_id, value)
  select v_new_id, field_id, value from public.custom_field_value where card_id = p_source_card;

  perform public.log_activity(v_board, v_new_id, 'card.cloned',
    jsonb_build_object('source', p_source_card));

  return v_new_id;
end $$;

-- Toggle template flag on a card.
create or replace function public.set_card_template(p_card uuid, p_template boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null or not public.has_permission('pm.manage_templates') then
    raise exception 'Not authorised';
  end if;
  update public.card set is_template = p_template, updated_at = now() where id = p_card;
  perform public.log_activity(v_board, p_card,
    case when p_template then 'card.templated' else 'card.untemplated' end, '{}'::jsonb);
end $$;
