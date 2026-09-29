-- ============================================================================
-- 0026_security_hardening.sql
--   Fixes from the security review.
--   1. Self sign-up could create a workspace admin: handle_new_user read the
--      role from user metadata, which the signer controls. Role now comes only
--      from app metadata (service role), and accounts that were not created
--      confirmed by an admin start deactivated.
--   2. Trello auto-link on signup is removed (anyone choosing a suggested
--      username inherited that person's boards). Linking is admin-only.
--   3. Automation internals and notification/activity helpers were callable
--      by any user through the API (SECURITY DEFINER, no checks). Revoked;
--      rules can only touch cards on their own board, lists/labels of it.
--   4. Comment update could move a comment to any card; subscriptions to
--      invisible boards/cards; storage read via forged attachment rows;
--      board_member rows re-pointed; forged authorship / cross-board lists;
--      javascript: attachment URLs. All closed below.
-- ============================================================================

-- 1 ------------------------------------------------------------ sign-up ----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_username text;
  v_display  text;
  v_role     public.role;
begin
  v_username := coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1));
  v_display  := coalesce(new.raw_user_meta_data ->> 'display_name', v_username);
  -- Only the service role can write app metadata; user metadata is the signer's.
  v_role     := coalesce((new.raw_app_meta_data ->> 'role')::public.role, 'member');
  -- Admin-created accounts arrive already confirmed; open sign-ups do not.
  insert into public.profile (id, username, display_name, role, is_active)
  values (new.id, v_username, v_display, v_role, new.email_confirmed_at is not null)
  on conflict (id) do nothing;
  return new;
end $$;

-- 2 ------------------------------------------------------- trello link ----
drop trigger if exists profile_trello_autolink on public.profile;
drop function if exists public._trello_profile_autolink();

-- 3 ----------------------------------------------------- internal helpers --
do $$
declare r record; keep regprocedure[];
begin
  keep := array(select p.oid::regprocedure from pg_proc p
                 where p.pronamespace = 'public'::regnamespace
                   and has_function_privilege('authenticated', p.oid, 'execute'));
  -- Nothing in public is for anonymous callers (every policy is TO authenticated).
  for r in
    select p.oid::regprocedure as f from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', r.f);
    if r.f = any(keep) then execute format('grant execute on function %s to authenticated', r.f); end if;
  end loop;
  -- Signed-in users keep only what policies and the app call.
  for r in
    select p.oid::regprocedure as f from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (p.prorettype = 'trigger'::regtype
            or p.proname in ('_auto_run_for', '_auto_run_action', '_auto_condition_matches', '_automation_depth',
                             '_set_automation_depth', 'notify_users', 'log_activity', 'log_activity_folded',
                             'card_audience', '_trello_color', '_trello_created', '_trello_pos'))
  loop
    execute format('revoke execute on function %s from authenticated', r.f);
  end loop;
end $$;
-- Future functions are private until a migration grants them explicitly.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- rules only run on cards of their own board
create or replace function public._auto_run_for(p_trigger_kind text, p_card_id uuid, p_board uuid, p_trigger_data jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_depth int := public._automation_depth();
  r record;
  cond jsonb;
  matched bool;
  act jsonb;
begin
  -- The card must belong to the board whose rules run (and exist at all).
  if not exists (select 1 from public.card where id = p_card_id and board_id = p_board) then return; end if;
  if v_depth >= 3 then return; end if;
  perform public._set_automation_depth(v_depth + 1);

  for r in
    select id, actions, conditions, trigger
      from public.automation_rule
     where board_id = p_board and is_enabled = true
       and trigger->>'kind' = p_trigger_kind
  loop
    -- Filter matches (extra trigger constraints, e.g. to_list_id)
    matched := true;
    if r.trigger ? 'filter' then
      for cond in select * from jsonb_array_elements(coalesce(r.trigger->'filter'->'checks', '[]'::jsonb))
      loop
        if not public._auto_condition_matches(p_card_id, cond) then matched := false; exit; end if;
      end loop;
    end if;
    if not matched then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'skipped', v_depth,
              jsonb_build_object('reason','trigger_filter'));
      continue;
    end if;

    -- Conditions
    for cond in select * from jsonb_array_elements(coalesce(r.conditions, '[]'::jsonb))
    loop
      if not public._auto_condition_matches(p_card_id, cond) then matched := false; exit; end if;
    end loop;
    if not matched then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'skipped', v_depth, jsonb_build_object('reason','condition'));
      continue;
    end if;

    -- Actions
    begin
      for act in select * from jsonb_array_elements(coalesce(r.actions, '[]'::jsonb))
      loop
        perform public._auto_run_action(p_card_id, p_board, act);
      end loop;
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'ok', v_depth, coalesce(p_trigger_data,'{}'::jsonb));
    exception when others then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'error', v_depth,
              jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  perform public._set_automation_depth(v_depth);
end $function$;

create or replace function public._auto_run_action(p_card_id uuid, p_board uuid, p_action jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_kind text := p_action->>'kind';
  v_args jsonb := coalesce(p_action->'args', '{}'::jsonb);
  v_id   uuid;
begin
  -- Targets named in a rule must live on the rule's board.
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
    else raise notice 'automation: unknown action kind %', v_kind;
  end case;
end $$;
revoke execute on function public._auto_run_action(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public._auto_run_for(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- 4 ------------------------------------------------------------ comments --
drop policy if exists comment_update_self on public.comment;
create policy comment_update_self on public.comment for update to authenticated
  using (author_id = auth.uid() and card_id in (select public.visible_card_ids()))
  with check (author_id = auth.uid() and exists (select 1 from public.card c where c.id = card_id and public.can_comment_board(c.board_id)));

create or replace function public.comment_keep_place()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and coalesce(current_setting('app.trello_sync', true), '') <> '1'
     and (new.card_id <> old.card_id or new.parent_id is distinct from old.parent_id
                                 or new.author_id <> old.author_id) then
    raise exception 'A comment cannot be moved or re-attributed';
  end if;
  return new;
end $$;
drop trigger if exists comment_keep_place on public.comment;
create trigger comment_keep_place before update on public.comment for each row execute function public.comment_keep_place();

-- subscriptions: only to things you can see
create or replace function public.set_subscription(p_entity_type text, p_entity_id uuid, p_watch boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_entity_type not in ('board', 'list', 'card') then raise exception 'bad entity_type'; end if;
  if p_watch then
    if not (   (p_entity_type = 'board' and p_entity_id in (select public.visible_board_ids()))
            or (p_entity_type = 'card'  and p_entity_id in (select public.visible_card_ids()))
            or (p_entity_type = 'list'  and exists (select 1 from public.list l where l.id = p_entity_id
                                                     and l.board_id in (select public.visible_board_ids())))) then
      raise exception 'Not found';
    end if;
    insert into public.subscription(user_id, entity_type, entity_id)
    values (auth.uid(), p_entity_type, p_entity_id) on conflict do nothing;
  else
    delete from public.subscription where user_id = auth.uid() and entity_type = p_entity_type and entity_id = p_entity_id;
  end if;
  return p_watch;
end $$;
grant execute on function public.set_subscription(text, uuid, boolean) to authenticated;

drop policy if exists subscription_all on public.subscription;
create policy subscription_all on public.subscription for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (
       (entity_type = 'board' and entity_id in (select public.visible_board_ids()))
    or (entity_type = 'card'  and entity_id in (select public.visible_card_ids()))
    or (entity_type = 'list'  and exists (select 1 from public.list l where l.id = entity_id
                                          and l.board_id in (select public.visible_board_ids())))));

-- mirrored rows must not auto-subscribe the fallback admin to everything
create or replace function public.subscription_skip_sync()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.trello_sync', true), '') = '1' then return null; end if;
  return new;
end $$;
drop trigger if exists subscription_skip_sync on public.subscription;
create trigger subscription_skip_sync before insert on public.subscription for each row execute function public.subscription_skip_sync();

-- storage: a file is readable only through its own card folder
drop policy if exists attachments_read on storage.objects;
create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments'
         and (storage.foldername(name))[1] in (select v::text from public.visible_card_ids() v)
         and exists (select 1 from public.attachment a where a.storage_path = objects.name
                        and a.card_id::text = (storage.foldername(name))[1]));
update storage.buckets set file_size_limit = 26214400 where id = 'attachments';

alter table public.attachment drop constraint if exists attachment_path_card_chk;
alter table public.attachment add constraint attachment_path_card_chk
  check (storage_path is null or storage_path like card_id::text || '/%') not valid;
alter table public.attachment drop constraint if exists attachment_url_chk;
alter table public.attachment add constraint attachment_url_chk
  check (external_url is null or external_url ~* '^https?://') not valid;

-- board_member rows cannot be re-pointed to another board or person
create or replace function public.board_member_keep_keys()
returns trigger language plpgsql as $$
begin
  if new.board_id <> old.board_id or new.user_id <> old.user_id then
    raise exception 'Change the role, or remove and re-add the member';
  end if;
  return new;
end $$;
drop trigger if exists board_member_keep_keys on public.board_member;
create trigger board_member_keep_keys before update on public.board_member for each row execute function public.board_member_keep_keys();

-- cards: list on the same board; authorship and mirror links are server-owned
create or replace function public.card_integrity()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.list l where l.id = new.list_id and l.board_id = new.board_id) then
    raise exception 'The list is not on this board';
  end if;
  if auth.uid() is not null and coalesce(current_setting('app.trello_sync', true), '') <> '1' then
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
drop trigger if exists card_integrity on public.card;
create trigger card_integrity before insert or update on public.card for each row execute function public.card_integrity();

create or replace function public.attachment_integrity()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and coalesce(current_setting('app.trello_sync', true), '') <> '1' then
    new.uploaded_by := case when tg_op = 'INSERT' then auth.uid() else old.uploaded_by end;
  end if;
  return new;
end $$;
drop trigger if exists attachment_integrity on public.attachment;
create trigger attachment_integrity before insert or update on public.attachment for each row execute function public.attachment_integrity();

revoke execute on function public.comment_keep_place(), public.subscription_skip_sync(), public.board_member_keep_keys(),
  public.card_integrity(), public.attachment_integrity() from public, anon, authenticated;
