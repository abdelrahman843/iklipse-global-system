-- ============================================================================
-- 0003_rpc_ordering.sql
--   Authoritative server-side ordering RPCs plus other multi-row mutations.
-- ============================================================================

-- Fractional midpoint over the printable ASCII range 32..126.
create or replace function public.rank_between(prev text, nxt text)
returns text language plpgsql immutable as $$
declare
  a text := coalesce(prev, '');
  b text := coalesce(nxt,  '');
  out text := '';
  i int := 1;
  ac int; bc int;
begin
  loop
    ac := coalesce(ascii(substr(a, i, 1)), 32);
    bc := coalesce(nullif(ascii(substr(b, i, 1)), 0), 127);
    if bc - ac > 1 then
      out := out || chr((ac + bc) / 2);
      return out;
    end if;
    out := out || chr(ac);
    i := i + 1;
    if i > 32 then
      -- Sanity guard — shouldn't happen with real data.
      raise exception 'rank_between exhausted precision';
    end if;
  end loop;
end $$;

-- Move a card to (list, position between prev/next). Returns the computed rank.
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

  perform public.log_activity(
    v_board, p_card_id, 'card.moved',
    jsonb_build_object('from_list', v_old_list, 'to_list', p_list_id)
  );

  return v_new_pos;
end $$;

create or replace function public.reorder_list(
  p_list_id uuid,
  p_prev_position text,
  p_next_position text
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_new_pos text;
  v_board uuid;
begin
  select board_id into v_board from public.list where id = p_list_id;
  if v_board is null then raise exception 'List not found'; end if;
  if not public.is_board_member(v_board) or not public.has_permission('pm.move_list') then
    raise exception 'Not authorised';
  end if;
  v_new_pos := public.rank_between(p_prev_position, p_next_position);
  update public.list set position = v_new_pos, updated_at = now() where id = p_list_id;
  perform public.log_activity(v_board, null, 'list.moved', jsonb_build_object('list_id', p_list_id));
  return v_new_pos;
end $$;

-- Create board + add creator as board admin + seed default labels.
create or replace function public.create_board(
  p_title text,
  p_description text default null,
  p_background text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_ws uuid := '00000000-0000-0000-0000-000000000001';
  v_uid uuid := auth.uid();
  v_pos text;
begin
  if not public.has_permission('pm.create_board') then
    raise exception 'Not authorised';
  end if;

  insert into public.board (workspace_id, title, description, background, created_by)
  values (v_ws, p_title, p_description, p_background, v_uid)
  returning id into v_id;

  insert into public.board_member (board_id, user_id, role)
  values (v_id, v_uid, 'admin');

  -- Seed six standard labels.
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

  perform public.log_activity(v_id, null, 'board.created', jsonb_build_object('title', p_title));
  return v_id;
end $$;

-- Archive/restore card, single call (RLS still applies through the underlying update).
create or replace function public.set_card_archived(p_card uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null then raise exception 'Card not found'; end if;
  if p_archived and not public.has_permission('pm.archive_card') then raise exception 'Not authorised'; end if;
  if (not p_archived) and not public.has_permission('pm.edit_card') then raise exception 'Not authorised'; end if;
  update public.card set is_archived = p_archived, updated_at = now() where id = p_card;
  perform public.log_activity(v_board, p_card, case when p_archived then 'card.archived' else 'card.restored' end, '{}'::jsonb);
end $$;

-- Assign / unassign self quickly (used by the "space" shortcut).
create or replace function public.toggle_self_on_card(p_card uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_board uuid; v_now boolean;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null or not public.is_board_member(v_board) then raise exception 'Not authorised'; end if;
  select exists(select 1 from public.card_member where card_id = p_card and user_id = auth.uid()) into v_now;
  if v_now then
    delete from public.card_member where card_id = p_card and user_id = auth.uid();
    perform public.log_activity(v_board, p_card, 'card.self_unassigned', '{}'::jsonb);
    return false;
  else
    insert into public.card_member (card_id, user_id) values (p_card, auth.uid())
      on conflict do nothing;
    perform public.log_activity(v_board, p_card, 'card.self_assigned', '{}'::jsonb);
    return true;
  end if;
end $$;

-- Storage bucket for avatars + attachments (public read on avatars only).
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false)
  on conflict (id) do nothing;

-- Avatars: any signed-in user can upload their own; anyone can read.
drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select using (bucket_id = 'avatars');
drop policy if exists avatars_write on storage.objects;
create policy avatars_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and owner = auth.uid());
drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects
  for update to authenticated using (bucket_id = 'avatars' and owner = auth.uid());
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects
  for delete to authenticated using (bucket_id = 'avatars' and owner = auth.uid());

-- Attachments: read/write gated through the attachment row's board membership.
drop policy if exists attachments_read on storage.objects;
create policy attachments_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.attachment a
       join public.card c on c.id = a.card_id
      where a.storage_path = storage.objects.name
        and public.is_board_member(c.board_id)
    )
  );
drop policy if exists attachments_write on storage.objects;
create policy attachments_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attachments' and owner = auth.uid());
drop policy if exists attachments_delete on storage.objects;
create policy attachments_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (owner = auth.uid() or public.is_admin())
  );
