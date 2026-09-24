-- ============================================================================
-- 0013_trello_permissions.sql
--   Replace per-user permission checkboxes with Trello's role architecture:
--
--   Workspace role (profile.role)     admin | member | guest
--   Board role     (board_member.role) admin | normal | observer
--   Board visibility                  private | workspace
--   Board settings                    commenting, who adds/removes members,
--                                     whether workspace members can self-join
--   Workspace settings                who creates / deletes boards, who can
--                                     add guests to boards
--
--   Effective access on a board (board_access):
--     admin     workspace admin (admin on every board) or board admin
--     normal    board member — edits everything on the board
--     observer  read-only; may comment if the board allows it
--     viewer    workspace member (not guest) looking at a workspace-visible
--               board they haven't joined — read-only
--     null      no access
--
--   user_permission is no longer read by anything. The table stays only so
--   already-deployed edge functions keep working; has_permission() is dropped.
-- ============================================================================

-- ------------------------------------------------------------------ enums --
do $$ begin
  create type public.board_visibility as enum ('private', 'workspace');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.comment_policy as enum ('disabled', 'members', 'observers', 'workspace');
exception when duplicate_object then null; end $$;

-- 'admins' = restricted to admins, 'members' = open to members.
do $$ begin
  create type public.member_policy as enum ('admins', 'members');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------- board settings --
alter table public.board
  add column if not exists visibility     public.board_visibility not null default 'workspace',
  add column if not exists comment_policy public.comment_policy   not null default 'members',
  add column if not exists member_policy  public.member_policy    not null default 'members',
  add column if not exists self_join      boolean                 not null default true;

-- --------------------------------------------------- workspace settings --
alter table public.workspace
  add column if not exists board_create_policy public.member_policy not null default 'members',
  add column if not exists board_delete_policy public.member_policy not null default 'members',
  add column if not exists guest_policy        public.member_policy not null default 'members';

-- --------------------------------------------------------------- helpers --
create or replace function public.my_workspace_role()
returns text language sql stable security definer set search_path = public as $$
  select role::text from public.profile where id = auth.uid() and is_active;
$$;

create or replace function public.board_access(b uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when r is null then null
    when r = 'admin' then 'admin'
    else coalesce(
      (select bm.role::text from public.board_member bm
        where bm.board_id = b and bm.user_id = auth.uid()),
      (select 'viewer' from public.board bo
        where bo.id = b and bo.visibility = 'workspace' and r <> 'guest'))
  end
  from (select public.my_workspace_role() as r) me;
$$;

-- Can see the board (kept under its old name: every read policy uses it).
create or replace function public.is_board_member(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.board_access(b) is not null;
$$;

create or replace function public.is_board_admin(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.board_access(b) = 'admin';
$$;

-- Can change lists, cards and everything on them.
create or replace function public.can_edit_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.board_access(b) in ('admin', 'normal'), false);
$$;

create or replace function public.can_comment_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case bo.comment_policy
    when 'disabled'  then false
    when 'members'   then a in ('admin', 'normal')
    when 'observers' then a in ('admin', 'normal', 'observer')
    when 'workspace' then a is not null
  end, false)
  from public.board bo, (select public.board_access(b) as a) x
  where bo.id = b;
$$;

create or replace function public.can_manage_board_members(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(a = 'admin' or (a = 'normal' and bo.member_policy = 'members'), false)
  from public.board bo, (select public.board_access(b) as a) x
  where bo.id = b;
$$;

create or replace function public.can_create_board()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    r = 'admin' or (r = 'member' and (select board_create_policy from public.workspace
                                       where id = '00000000-0000-0000-0000-000000000001') = 'members'),
    false)
  from (select public.my_workspace_role() as r) me;
$$;

create or replace function public.can_delete_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case w.board_delete_policy
    when 'admins'  then public.is_admin()
    when 'members' then public.is_board_admin(b)
  end, false)
  from public.board bo join public.workspace w on w.id = bo.workspace_id
  where bo.id = b;
$$;

-- Adding someone (or yourself) to a board.
create or replace function public.can_add_board_member(b uuid, target uuid, r public.board_role)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  a text := public.board_access(b);
  t_role text;
  bo public.board%rowtype;
begin
  select role::text into t_role from public.profile where id = target and is_active;
  if t_role is null then return false; end if;
  select * into bo from public.board where id = b;
  if not found then return false; end if;

  -- Joining a workspace-visible board yourself (Trello "Join board").
  if target = auth.uid() and a = 'viewer' then
    return bo.self_join and r = 'normal';
  end if;

  if not public.can_manage_board_members(b) then return false; end if;
  if r = 'admin' and a <> 'admin' then return false; end if;
  if t_role = 'guest' and not public.is_admin()
     and (select guest_policy from public.workspace where id = bo.workspace_id) = 'admins' then
    return false;
  end if;
  return true;
end $$;

-- Everything the client needs to render one board's controls, in one call.
create or replace function public.my_board_access(b uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'access',         public.board_access(b),
    'can_edit',       public.can_edit_board(b),
    'can_comment',    public.can_comment_board(b),
    'manage_members', public.can_manage_board_members(b),
    'delete_board',   public.can_delete_board(b)
  );
$$;

grant execute on function public.my_workspace_role(), public.board_access(uuid),
  public.can_edit_board(uuid), public.can_comment_board(uuid),
  public.can_manage_board_members(uuid), public.can_create_board(),
  public.can_delete_board(uuid), public.can_add_board_member(uuid, uuid, public.board_role),
  public.my_board_access(uuid) to authenticated;

-- ------------------------------------------------------------ workspace --
drop policy if exists workspace_admin_update on public.workspace;
create policy workspace_admin_update on public.workspace
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant update on public.workspace to authenticated;

-- ---------------------------------------------------------------- board --
drop policy if exists board_insert on public.board;
create policy board_insert on public.board
  for insert to authenticated
  with check (public.can_create_board() and created_by = auth.uid());

-- Members may rename / redescribe; settings are admin-only (guard trigger).
drop policy if exists board_update on public.board;
create policy board_update on public.board
  for update to authenticated
  using (public.can_edit_board(id))
  with check (public.can_edit_board(id));

drop policy if exists board_delete on public.board;
create policy board_delete on public.board
  for delete to authenticated
  using (public.can_delete_board(id));

create or replace function public.board_settings_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if; -- service role / migrations
  if not public.is_board_admin(new.id) and (
       new.visibility     is distinct from old.visibility
    or new.comment_policy is distinct from old.comment_policy
    or new.member_policy  is distinct from old.member_policy
    or new.self_join      is distinct from old.self_join
    or new.is_archived    is distinct from old.is_archived
    or new.workspace_id   is distinct from old.workspace_id
    or new.created_by     is distinct from old.created_by) then
    raise exception 'Only board admins can change board settings';
  end if;
  return new;
end $$;

drop trigger if exists board_settings_guard on public.board;
create trigger board_settings_guard before update on public.board
  for each row execute function public.board_settings_guard();

-- --------------------------------------------------------- board_member --
drop policy if exists board_member_write  on public.board_member;
drop policy if exists board_member_insert on public.board_member;
drop policy if exists board_member_update on public.board_member;
drop policy if exists board_member_delete on public.board_member;

create policy board_member_insert on public.board_member
  for insert to authenticated
  with check (public.can_add_board_member(board_id, user_id, role));

-- Only board admins change roles.
create policy board_member_update on public.board_member
  for update to authenticated
  using (public.is_board_admin(board_id))
  with check (public.is_board_admin(board_id));

-- Leave yourself; admins remove anyone; members remove non-admins when the
-- board lets members manage membership.
create policy board_member_delete on public.board_member
  for delete to authenticated
  using (user_id = auth.uid()
         or public.is_board_admin(board_id)
         or (public.can_manage_board_members(board_id) and role <> 'admin'));

grant insert, update, delete on public.board_member to authenticated;

-- A board always keeps at least one admin (skipped when the board or the
-- user itself is being deleted).
create or replace function public.board_member_last_admin_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role <> 'admin' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then return new; end if;
  if not exists (select 1 from public.board where id = old.board_id) then return coalesce(new, old); end if;
  if not exists (select 1 from public.profile where id = old.user_id) then return coalesce(new, old); end if;
  if not exists (select 1 from public.board_member
                  where board_id = old.board_id and role = 'admin' and user_id <> old.user_id) then
    raise exception 'A board needs at least one admin. Make someone else admin first.';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists board_member_last_admin on public.board_member;
create trigger board_member_last_admin before update or delete on public.board_member
  for each row execute function public.board_member_last_admin_guard();

-- No "you were added" notification when you join a board yourself.
create or replace function public.on_board_member_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is distinct from auth.uid() then
    perform public.notify_users(
      array[new.user_id], new.board_id, null, 'board_invited',
      jsonb_build_object('role', new.role)
    );
  end if;
  insert into public.subscription(user_id, entity_type, entity_id)
  values (new.user_id, 'board', new.board_id) on conflict do nothing;
  return new;
end $$;

-- -------------------------------------------------- content write policies --
drop policy if exists list_write on public.list;
create policy list_write on public.list
  for all to authenticated
  using (public.can_edit_board(board_id)) with check (public.can_edit_board(board_id));

drop policy if exists card_write on public.card;
create policy card_write on public.card
  for all to authenticated
  using (public.can_edit_board(board_id)) with check (public.can_edit_board(board_id));

drop policy if exists label_write on public.label;
create policy label_write on public.label
  for all to authenticated
  using (public.can_edit_board(board_id)) with check (public.can_edit_board(board_id));

drop policy if exists card_label_write on public.card_label;
create policy card_label_write on public.card_label
  for all to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)))
  with check (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)));

drop policy if exists card_member_write on public.card_member;
create policy card_member_write on public.card_member
  for all to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)))
  with check (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)));

drop policy if exists checklist_write on public.checklist;
create policy checklist_write on public.checklist
  for all to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)))
  with check (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)));

drop policy if exists checklist_item_write on public.checklist_item;
create policy checklist_item_write on public.checklist_item
  for all to authenticated
  using (exists (select 1 from public.checklist cl join public.card c on c.id = cl.card_id
                  where cl.id = checklist_id and public.can_edit_board(c.board_id)))
  with check (exists (select 1 from public.checklist cl join public.card c on c.id = cl.card_id
                       where cl.id = checklist_id and public.can_edit_board(c.board_id)));

drop policy if exists attachment_write on public.attachment;
create policy attachment_write on public.attachment
  for all to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)))
  with check (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)));

drop policy if exists custom_field_def_write on public.custom_field_def;
create policy custom_field_def_write on public.custom_field_def
  for all to authenticated
  using (public.can_edit_board(board_id)) with check (public.can_edit_board(board_id));

drop policy if exists custom_field_value_write on public.custom_field_value;
create policy custom_field_value_write on public.custom_field_value
  for all to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)))
  with check (exists (select 1 from public.card c where c.id = card_id and public.can_edit_board(c.board_id)));

-- Comments follow the board's commenting setting; board admins moderate.
drop policy if exists comment_insert on public.comment;
create policy comment_insert on public.comment
  for insert to authenticated
  with check (author_id = auth.uid()
              and exists (select 1 from public.card c
                           where c.id = card_id and public.can_comment_board(c.board_id)));

drop policy if exists comment_delete_self_or_admin on public.comment;
create policy comment_delete_self_or_admin on public.comment
  for delete to authenticated
  using (author_id = auth.uid()
         or exists (select 1 from public.card c where c.id = card_id and public.is_board_admin(c.board_id)));

drop policy if exists comment_reaction_insert on public.comment_reaction;
create policy comment_reaction_insert on public.comment_reaction
  for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.comment cm join public.card c on c.id = cm.card_id
                           where cm.id = comment_id and public.can_comment_board(c.board_id)));

-- Automation: anyone on the board sees rules; editors build them (Trello Butler).
drop policy if exists rule_read on public.automation_rule;
create policy rule_read on public.automation_rule
  for select to authenticated using (public.is_board_member(board_id));
drop policy if exists rule_write on public.automation_rule;
create policy rule_write on public.automation_rule
  for all to authenticated
  using (public.can_edit_board(board_id)) with check (public.can_edit_board(board_id));
drop policy if exists run_read on public.automation_run;
create policy run_read on public.automation_run
  for select to authenticated using (public.is_board_member(board_id));

-- ------------------------------------------------------------------ RPCs --
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

  if not public.can_edit_board(v_board)
     or not exists (select 1 from public.list where id = p_list_id and board_id = v_board) then
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
  if not public.can_edit_board(v_board) then
    raise exception 'Not authorised';
  end if;
  v_new_pos := public.rank_between(p_prev_position, p_next_position);
  update public.list set position = v_new_pos, updated_at = now() where id = p_list_id;
  perform public.log_activity(v_board, null, 'list.moved', jsonb_build_object('list_id', p_list_id));
  return v_new_pos;
end $$;

drop function if exists public.create_board(text, text, text);
create or replace function public.create_board(
  p_title text,
  p_description text default null,
  p_background text default null,
  p_visibility public.board_visibility default 'workspace'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_ws uuid := '00000000-0000-0000-0000-000000000001';
  v_uid uuid := auth.uid();
  v_pos text;
begin
  if not public.can_create_board() then
    raise exception 'Not authorised';
  end if;

  insert into public.board (workspace_id, title, description, background, created_by, visibility)
  values (v_ws, p_title, p_description, p_background, v_uid, coalesce(p_visibility, 'workspace'))
  returning id into v_id;

  insert into public.board_member (board_id, user_id, role)
  values (v_id, v_uid, 'admin');

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
grant execute on function public.create_board(text, text, text, public.board_visibility) to authenticated;

create or replace function public.set_card_archived(p_card uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null then raise exception 'Card not found'; end if;
  if not public.can_edit_board(v_board) then raise exception 'Not authorised'; end if;
  update public.card set is_archived = p_archived, updated_at = now() where id = p_card;
  perform public.log_activity(v_board, p_card, case when p_archived then 'card.archived' else 'card.restored' end, '{}'::jsonb);
end $$;

create or replace function public.set_card_template(p_card uuid, p_template boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null or not public.can_edit_board(v_board) then
    raise exception 'Not authorised';
  end if;
  update public.card set is_template = p_template, updated_at = now() where id = p_card;
  perform public.log_activity(v_board, p_card,
    case when p_template then 'card.templated' else 'card.untemplated' end, '{}'::jsonb);
end $$;

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
  if v_board is null or not public.can_edit_board(v_board) then
    raise exception 'Not authorised';
  end if;
  if not exists (select 1 from public.card where id = p_source_card
                  and public.is_board_member(board_id)) then
    raise exception 'Not authorised';
  end if;

  perform set_config('app.bulk_activity', '1', true);

  v_pos := public.rank_between(p_after_position, null);

  insert into public.card (board_id, list_id, title, description, position, created_by)
  select v_board, p_target_list, title, description, v_pos, v_uid
    from public.card where id = p_source_card
    returning id into v_new_id;

  -- Labels only carry over inside the same board.
  insert into public.card_label (card_id, label_id)
  select v_new_id, cl.label_id from public.card_label cl
    join public.label l on l.id = cl.label_id and l.board_id = v_board
   where cl.card_id = p_source_card;

  insert into public.checklist (id, card_id, name, position)
  select gen_random_uuid(), v_new_id, name, position from public.checklist where card_id = p_source_card;

  insert into public.checklist_item (checklist_id, text, completed, position, assignee_id, due_date)
  select new_cl.id, ci.text, false, ci.position, ci.assignee_id, ci.due_date
    from public.checklist_item ci
    join public.checklist old_cl on old_cl.id = ci.checklist_id
    join public.checklist new_cl on new_cl.card_id = v_new_id and new_cl.name = old_cl.name;

  insert into public.custom_field_value (card_id, field_id, value)
  select v_new_id, v.field_id, v.value from public.custom_field_value v
    join public.custom_field_def d on d.id = v.field_id and d.board_id = v_board
   where v.card_id = p_source_card;

  perform set_config('app.bulk_activity', '', true);

  perform public.log_activity(v_board, v_new_id, 'card.cloned',
    jsonb_build_object('source', p_source_card,
                       'source_title', (select title from public.card where id = p_source_card),
                       'list_title',   (select title from public.list where id = p_target_list)));

  return v_new_id;
end $$;

create or replace function public.toggle_self_on_card(p_card uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_board uuid; v_now boolean;
begin
  select board_id into v_board from public.card where id = p_card;
  if v_board is null or not public.can_edit_board(v_board) then raise exception 'Not authorised'; end if;
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

-- --------------------------------------------------------------- cleanup --
drop function if exists public.has_permission(public.permission_key);
comment on table public.user_permission is
  'Legacy per-user permissions (pre-0013). Not read anywhere; access comes from workspace + board roles.';

notify pgrst, 'reload schema';
