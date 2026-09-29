-- ============================================================================
-- 0031_automation_mirror.sql
--   New automation action: mirror_to_list {target_list_id}. Creates a mirror
--   card (card.mirror_of) of the triggering card in a list on another board,
--   like Trello Butler's "mirror the card to list X on board Y". Needed to
--   rebuild the Butler rules of "iklipse - Simplified day to day":
--     1. card added to the board   -> mirror to "Clients - Active Work" / "new cards"
--     2. due date marked complete  -> move to "In Review (Internal)"
--   The acting user must be able to edit the target board; a card is mirrored
--   into the same list only once.
-- ============================================================================

create or replace function public._auto_run_action(p_card_id uuid, p_board uuid, p_action jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_kind   text := p_action->>'kind';
  v_args   jsonb := coalesce(p_action->'args', '{}'::jsonb);
  v_id     uuid;
  v_target uuid;
begin
  -- Targets named in a rule must live on the rule's board (mirrors: a board
  -- the acting user may edit).
  if v_kind = 'move_to_list' then
    v_id := (v_args->>'list_id')::uuid;
    if not exists (select 1 from public.list where id = v_id and board_id = p_board) then return; end if;
  elsif v_kind in ('add_label', 'remove_label') then
    v_id := (v_args->>'label_id')::uuid;
    if not exists (select 1 from public.label where id = v_id and board_id = p_board) then return; end if;
  elsif v_kind = 'add_member' then
    v_id := (v_args->>'user_id')::uuid;
    if not exists (select 1 from public.board_member where user_id = v_id and board_id = p_board)
       and not exists (select 1 from public.profile where id = v_id and role = 'admin' and is_active) then return; end if;
  elsif v_kind = 'mirror_to_list' then
    v_id := (v_args->>'target_list_id')::uuid;
    select board_id into v_target from public.list where id = v_id and not is_archived;
    if v_target is null or v_target = p_board then return; end if;
    if auth.uid() is not null and not public.can_edit_board(v_target) then return; end if;
  end if;
  case v_kind
    when 'move_to_list' then update public.card set list_id = v_id, updated_at = now() where id = p_card_id;
    when 'archive'      then update public.card set is_archived = true, updated_at = now() where id = p_card_id;
    when 'restore'      then update public.card set is_archived = false, updated_at = now() where id = p_card_id;
    when 'complete_due' then update public.card set due_completed = true, updated_at = now() where id = p_card_id;
    when 'add_label'    then insert into public.card_label(card_id, label_id) values (p_card_id, v_id) on conflict do nothing;
    when 'remove_label' then delete from public.card_label where card_id = p_card_id and label_id = v_id;
    when 'add_member'   then insert into public.card_member(card_id, user_id) values (p_card_id, v_id) on conflict do nothing;
    when 'remove_member' then
      delete from public.card_member where card_id = p_card_id and user_id = (v_args->>'user_id')::uuid;
    when 'add_comment' then
      insert into public.comment(card_id, author_id, body)
      values (p_card_id, coalesce(auth.uid(), (select created_by from public.card where id = p_card_id)), v_args->>'body');
    when 'rename'          then update public.card set title = v_args->>'title', updated_at = now() where id = p_card_id;
    when 'set_description' then update public.card set description = v_args->>'description', updated_at = now() where id = p_card_id;
    when 'mirror_to_list' then
      if not exists (select 1 from public.card where mirror_of = p_card_id and list_id = v_id) then
        perform set_config('app.server_write', '1', true);   -- card_integrity lets the server set mirror_of
        insert into public.card (board_id, list_id, title, position, created_by, mirror_of)
        select v_target, v_id, c.title,
               public.rank_between((select k.position from public.card k where k.list_id = v_id and not k.is_archived
                                     order by k.position collate "C" desc limit 1), null),
               coalesce(auth.uid(), c.created_by), c.id
          from public.card c where c.id = p_card_id;
        perform set_config('app.server_write', '', true);
      end if;
    else raise notice 'automation: unknown action kind %', v_kind;
  end case;
end $$;
revoke execute on function public._auto_run_action(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.card_integrity()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.list l where l.id = new.list_id and l.board_id = new.board_id) then
    raise exception 'The list is not on this board';
  end if;
  if auth.uid() is not null
     and coalesce(current_setting('app.trello_sync', true), '') <> '1'
     and coalesce(current_setting('app.server_write', true), '') <> '1' then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      new.mirror_of := null;
    else
      new.created_by := old.created_by;
      new.mirror_of := old.mirror_of;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.card_integrity() from public, anon, authenticated;
