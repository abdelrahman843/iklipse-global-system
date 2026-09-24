-- ============================================================================
-- 0010_card_activity.sql — Trello-style card activity.
--
-- Triggers write an activity row for every meaningful change to a card, so the
-- card's "Comments and activity" feed reads like Trello's ("set this card to be
-- due tomorrow at 3:35 PM", "added the Bug label", "completed Deploy on this
-- card"…). Names (list, label, member, field, checklist, file) are copied into
-- activity.data at write time so history still reads right after renames or
-- deletes.
--
-- Quiet cases (no row written):
--   * no signed-in user (service / import jobs, e.g. ingest_trello_board);
--   * bulk operations that set app.bulk_activity = '1' (clone_card), which log
--     one summary row themselves instead of dozens of detail rows;
--   * child rows removed by a cascade from a deleted card (card already gone).
-- ============================================================================

create or replace function public.activity_quiet() returns boolean
language sql stable set search_path = public as $$
  select auth.uid() is null
      or coalesce(current_setting('app.bulk_activity', true), '') = '1';
$$;

-- Like log_activity, but a repeat of the same action (same actor, same card,
-- same data->>'key') within 2 minutes updates the earlier row instead of adding
-- a new one. Keeps autosave / date-picker keystrokes to a single entry.
create or replace function public.log_activity_folded(
  p_board uuid, p_card uuid, p_action text, p_data jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.activity
   where card_id = p_card and actor_id = auth.uid() and action = p_action
     and coalesce(data->>'key', '') = coalesce(p_data->>'key', '')
     and created_at > now() - interval '2 minutes'
   order by created_at desc limit 1;
  if v_id is not null then
    update public.activity set data = p_data, created_at = now() where id = v_id;
  else
    perform public.log_activity(p_board, p_card, p_action, p_data);
  end if;
end $$;

-- ------------------------------------------------------------------ card ----

create or replace function public.trg_card_insert_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.activity_quiet() then return new; end if;
  perform public.log_activity(new.board_id, new.id, 'card.created',
    jsonb_build_object('list_id', new.list_id,
                       'list_title', (select title from public.list where id = new.list_id)));
  return new;
end $$;

drop trigger if exists card_activity_insert on public.card;
create trigger card_activity_insert after insert on public.card
  for each row execute function public.trg_card_insert_activity();

create or replace function public.trg_card_update_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  b uuid := new.board_id;
  c uuid := new.id;
  v_set uuid;
begin
  if public.activity_quiet() then return new; end if;

  if new.title is distinct from old.title then
    perform public.log_activity(b, c, 'card.renamed',
      jsonb_build_object('from', old.title, 'to', new.title));
  end if;

  if coalesce(new.description, '') is distinct from coalesce(old.description, '') then
    perform public.log_activity_folded(b, c, 'card.description_changed', '{}'::jsonb);
  end if;

  if new.due_date is distinct from old.due_date then
    -- A due date "set" moments ago by the same person absorbs follow-up edits.
    select id into v_set from public.activity
     where card_id = c and actor_id = auth.uid() and action = 'card.due_set'
       and created_at > now() - interval '2 minutes'
     order by created_at desc limit 1;
    if new.due_date is null then
      if v_set is not null then
        delete from public.activity where id = v_set;   -- set then cleared: no-op
      else
        perform public.log_activity(b, c, 'card.due_removed', '{}'::jsonb);
      end if;
    elsif v_set is not null then
      update public.activity set data = jsonb_build_object('due', new.due_date), created_at = now()
       where id = v_set;
    elsif old.due_date is null then
      perform public.log_activity(b, c, 'card.due_set', jsonb_build_object('due', new.due_date));
    else
      perform public.log_activity_folded(b, c, 'card.due_changed', jsonb_build_object('due', new.due_date));
    end if;
  end if;

  if new.start_date is distinct from old.start_date then
    if new.start_date is null then
      perform public.log_activity(b, c, 'card.start_removed', '{}'::jsonb);
    else
      perform public.log_activity_folded(b, c, 'card.start_set', jsonb_build_object('start', new.start_date));
    end if;
  end if;

  if new.due_completed is distinct from old.due_completed then
    perform public.log_activity(b, c,
      case when new.due_completed then 'card.completed' else 'card.uncompleted' end, '{}'::jsonb);
  end if;

  if new.cover_color is distinct from old.cover_color then
    perform public.log_activity(b, c,
      case when new.cover_color is null then 'card.cover_removed' else 'card.cover_changed' end,
      jsonb_build_object('color', new.cover_color));
  end if;

  return new;
end $$;

drop trigger if exists card_activity_update on public.card;
create trigger card_activity_update after update on public.card
  for each row execute function public.trg_card_update_activity();

-- ------------------------------------------------------------ members -------

create or replace function public.trg_card_member_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_board uuid;
begin
  if tg_op = 'INSERT' then r := new; else r := old; end if;
  if public.activity_quiet() then return r; end if;
  select board_id into v_board from public.card where id = r.card_id;
  if v_board is null then return r; end if;
  perform public.log_activity(v_board, r.card_id,
    case when tg_op = 'INSERT' then 'card.member_added' else 'card.member_removed' end,
    jsonb_build_object('user_id', r.user_id,
                       'name', (select display_name from public.profile where id = r.user_id)));
  return r;
end $$;

drop trigger if exists card_member_activity on public.card_member;
create trigger card_member_activity after insert or delete on public.card_member
  for each row execute function public.trg_card_member_activity();

-- ------------------------------------------------------------- labels -------

create or replace function public.trg_card_label_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_board uuid; l record;
begin
  if tg_op = 'INSERT' then r := new; else r := old; end if;
  if public.activity_quiet() then return r; end if;
  select board_id into v_board from public.card where id = r.card_id;
  select name, color into l from public.label where id = r.label_id;
  if v_board is null or l is null then return r; end if;   -- card or label itself deleted
  perform public.log_activity(v_board, r.card_id,
    case when tg_op = 'INSERT' then 'card.label_added' else 'card.label_removed' end,
    jsonb_build_object('label_id', r.label_id, 'name', l.name, 'color', l.color));
  return r;
end $$;

drop trigger if exists card_label_activity on public.card_label;
create trigger card_label_activity after insert or delete on public.card_label
  for each row execute function public.trg_card_label_activity();

-- ---------------------------------------------------------- checklists ------

create or replace function public.trg_checklist_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_board uuid;
begin
  if tg_op = 'INSERT' then r := new; else r := old; end if;
  if public.activity_quiet() then return r; end if;
  select board_id into v_board from public.card where id = r.card_id;
  if v_board is null then return r; end if;
  perform public.log_activity(v_board, r.card_id,
    case when tg_op = 'INSERT' then 'checklist.added' else 'checklist.removed' end,
    jsonb_build_object('name', r.name));
  return r;
end $$;

drop trigger if exists checklist_activity on public.checklist;
create trigger checklist_activity after insert or delete on public.checklist
  for each row execute function public.trg_checklist_activity();

create or replace function public.trg_checklist_item_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_card uuid; v_board uuid; v_list text;
begin
  if public.activity_quiet() or new.completed is not distinct from old.completed then return new; end if;
  select cl.card_id, c.board_id, cl.name into v_card, v_board, v_list
    from public.checklist cl join public.card c on c.id = cl.card_id
   where cl.id = new.checklist_id;
  if v_board is null then return new; end if;
  perform public.log_activity(v_board, v_card,
    case when new.completed then 'checklist.item_completed' else 'checklist.item_uncompleted' end,
    jsonb_build_object('text', new.text, 'checklist', v_list));
  return new;
end $$;

drop trigger if exists checklist_item_activity on public.checklist_item;
create trigger checklist_item_activity after update on public.checklist_item
  for each row execute function public.trg_checklist_item_activity();

-- --------------------------------------------------------- attachments ------

create or replace function public.trg_attachment_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_board uuid;
begin
  if tg_op = 'INSERT' then r := new; else r := old; end if;
  if public.activity_quiet() then return r; end if;
  select board_id into v_board from public.card where id = r.card_id;
  if v_board is null then return r; end if;
  perform public.log_activity(v_board, r.card_id,
    case when tg_op = 'INSERT' then 'attachment.added' else 'attachment.removed' end,
    jsonb_build_object('name', r.name));
  return r;
end $$;

drop trigger if exists attachment_activity on public.attachment;
create trigger attachment_activity after insert or delete on public.attachment
  for each row execute function public.trg_attachment_activity();

-- ------------------------------------------------------- custom fields ------

create or replace function public.trg_custom_field_value_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_board uuid; v_name text;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if public.activity_quiet() then return r; end if;
  if tg_op = 'UPDATE' then
    if new.value is not distinct from old.value then return r; end if;
  end if;
  select board_id into v_board from public.card where id = r.card_id;
  select name into v_name from public.custom_field_def where id = r.field_id;
  if v_board is null or v_name is null then return r; end if;  -- card or field deleted
  perform public.log_activity_folded(v_board, r.card_id, 'custom_field.updated',
    jsonb_build_object('key', r.field_id, 'name', v_name));
  return r;
end $$;

drop trigger if exists custom_field_value_activity on public.custom_field_value;
create trigger custom_field_value_activity after insert or update or delete on public.custom_field_value
  for each row execute function public.trg_custom_field_value_activity();

-- ------------------------------------------------ RPCs that log themselves ---

-- move_card: log only real list changes (not same-list reorders), with titles.
create or replace function public.move_card(
  p_card_id uuid,
  p_list_id uuid,
  p_prev_position text,
  p_next_position text
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_new_pos text;
  v_board uuid;
  v_old_list uuid;
begin
  select board_id, list_id into v_board, v_old_list from public.card where id = p_card_id;
  if v_board is null then raise exception 'Card not found'; end if;

  if not public.is_board_member(v_board) or not public.has_permission('pm.move_card') then
    raise exception 'Not authorised';
  end if;

  v_new_pos := public.rank_between(p_prev_position, p_next_position);

  update public.card
     set list_id = p_list_id,
         position = v_new_pos,
         updated_at = now()
   where id = p_card_id;

  if v_old_list is distinct from p_list_id then
    perform public.log_activity(
      v_board, p_card_id, 'card.moved',
      jsonb_build_object('from_list', v_old_list, 'to_list', p_list_id,
                         'from_title', (select title from public.list where id = v_old_list),
                         'to_title',   (select title from public.list where id = p_list_id))
    );
  end if;

  return v_new_pos;
end $$;

-- clone_card: detail triggers stay quiet during the copy; one summary row.
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

  perform set_config('app.bulk_activity', '1', true);

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

  perform set_config('app.bulk_activity', '', true);

  perform public.log_activity(v_board, v_new_id, 'card.cloned',
    jsonb_build_object('source', p_source_card,
                       'source_title', (select title from public.card where id = p_source_card),
                       'list_title',   (select title from public.list where id = p_target_list)));

  return v_new_id;
end $$;

-- toggle_self_on_card: the card_member trigger now logs join/leave.
create or replace function public.toggle_self_on_card(p_card uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_board uuid; v_now boolean;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null or not public.is_board_member(v_board) then raise exception 'Not authorised'; end if;
  select exists(select 1 from public.card_member where card_id = p_card and user_id = auth.uid()) into v_now;
  if v_now then
    delete from public.card_member where card_id = p_card and user_id = auth.uid();
    return false;
  else
    insert into public.card_member (card_id, user_id) values (p_card, auth.uid())
      on conflict do nothing;
    return true;
  end if;
end $$;

notify pgrst, 'reload schema';
