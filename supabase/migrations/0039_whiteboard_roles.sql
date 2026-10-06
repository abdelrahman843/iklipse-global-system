-- ============================================================================
-- 0039_whiteboard_roles.sql
--   Miro's access model for whiteboards, the way 0013 did Trello's for boards.
--
--   Board roles (board_member.wb_role):
--     owner      one per board; everything; hands the board on with
--                wb_transfer_ownership()
--     coowner    manages content, people and sharing settings
--     editor     edits content, comments; invites if the board allows it
--     commenter  views and comments
--     viewer     views only
--   Each maps onto the shared board_role (owner / coowner -> admin,
--   editor -> normal, commenter / viewer -> observer), so every existing
--   helper and RLS policy keeps working; a trigger keeps the two in step.
--
--   Sharing (board columns):
--     wb_team_access  what any workspace member (not guests) gets without an
--                     invite: none | view | comment | edit. 'none' = private.
--                     The higher of this and someone's own role applies.
--     wb_allow_copy   viewers and commenters may copy and export content
--     member_policy   (existing) who can invite: owners and co-owners, or
--                     editors too
-- ============================================================================

alter table public.board add column if not exists wb_team_access text not null default 'edit';
alter table public.board drop constraint if exists board_wb_team_access_check;
alter table public.board add constraint board_wb_team_access_check
  check (wb_team_access in ('none', 'view', 'comment', 'edit'));
alter table public.board add column if not exists wb_allow_copy boolean not null default true;

alter table public.board_member add column if not exists wb_role text;
alter table public.board_member drop constraint if exists board_member_wb_role_check;
alter table public.board_member add constraint board_member_wb_role_check
  check (wb_role is null or wb_role in ('owner', 'coowner', 'editor', 'commenter', 'viewer'));

-- Existing whiteboards keep the access they had: private stays private, a
-- workspace board stays view-only for people who weren't added.
update public.board
   set wb_team_access = case when visibility = 'private' then 'none' else 'view' end
 where kind = 'whiteboard';

update public.board_member bm
   set wb_role = case
     when bm.user_id = b.created_by and bm.role = 'admin' then 'owner'
     when bm.role = 'admin' then 'coowner'
     when bm.role = 'normal' then 'editor'
     else 'viewer' end
  from public.board b
 where b.id = bm.board_id and b.kind = 'whiteboard' and bm.wb_role is null;

-- ------------------------------------------------------------ role sync --
create or replace function public._wb_board_role(r text) returns public.board_role
language sql immutable as $$
  select (case r when 'owner' then 'admin' when 'coowner' then 'admin' when 'editor' then 'normal' else 'observer' end)::public.board_role;
$$;

-- Runs before the other board_member triggers (name sorts first), so the
-- last-admin guard and RLS see the final role.
create or replace function public.board_member_wb_role() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  b public.board%rowtype;
  v_owner_ok boolean := auth.uid() is null or coalesce(current_setting('iklipse.wb_owner', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.wb_role = 'owner' and not v_owner_ok
       and exists (select 1 from public.board where id = old.board_id)
       and exists (select 1 from public.profile where id = old.user_id) then
      raise exception 'Transfer ownership before removing the owner';
    end if;
    return old;
  end if;

  select * into b from public.board where id = new.board_id;
  if b.kind is distinct from 'whiteboard' then
    new.wb_role := null;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.wb_role is null then
      new.wb_role := case new.role when 'admin' then 'coowner' when 'normal' then 'editor' else 'viewer' end;
    end if;
    -- Joining by yourself gets what the workspace already has, nothing more.
    if new.user_id = auth.uid() and not public.is_admin() and not public.can_manage_board_members(new.board_id) then
      new.wb_role := case b.wb_team_access when 'edit' then 'editor' when 'comment' then 'commenter' else 'viewer' end;
    end if;
  elsif new.wb_role is not distinct from old.wb_role and new.role is distinct from old.role then
    -- Changed through the board-role controls (Users page): translate.
    new.wb_role := case new.role
      when 'admin' then case when old.wb_role = 'owner' then 'owner' else 'coowner' end
      when 'normal' then 'editor'
      else case when old.wb_role = 'commenter' then 'commenter' else 'viewer' end end;
  end if;

  if new.wb_role = 'owner' and (tg_op = 'INSERT' or old.wb_role is distinct from 'owner') and not v_owner_ok then
    raise exception 'Use "Transfer ownership" to change the owner';
  end if;
  if tg_op = 'UPDATE' and old.wb_role = 'owner' and new.wb_role is distinct from 'owner' and not v_owner_ok then
    raise exception 'The owner keeps their role. Transfer ownership first.';
  end if;

  new.role := public._wb_board_role(new.wb_role);
  return new;
end $$;

drop trigger if exists board_member_aa_wb_role on public.board_member;
create trigger board_member_aa_wb_role before insert or update or delete on public.board_member
  for each row execute function public.board_member_wb_role();

-- ---------------------------------------------------- sharing settings --
-- For whiteboards, team access and visibility describe the same thing.
create or replace function public.board_wb_access_sync() returns trigger
language plpgsql as $$
begin
  if new.kind <> 'whiteboard' then return new; end if;
  if tg_op = 'INSERT' then
    if new.visibility = 'private' then new.wb_team_access := 'none';
    elsif new.wb_team_access = 'none' then new.visibility := 'private';
    end if;
  elsif new.wb_team_access is distinct from old.wb_team_access then
    new.visibility := case when new.wb_team_access = 'none' then 'private' else 'workspace' end;
  elsif new.visibility is distinct from old.visibility then
    new.wb_team_access := case
      when new.visibility = 'private' then 'none'
      when old.wb_team_access = 'none' then 'view'
      else old.wb_team_access end;
  end if;
  return new;
end $$;
drop trigger if exists board_wb_access_sync on public.board;
create trigger board_wb_access_sync before insert or update on public.board
  for each row execute function public.board_wb_access_sync();

-- Sharing settings are for board admins (owners and co-owners) only.
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
    or new.created_by     is distinct from old.created_by
    or new.wb_team_access is distinct from old.wb_team_access
    or new.wb_allow_copy  is distinct from old.wb_allow_copy) then
    raise exception 'Only board admins can change board settings';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------- access --
-- Team access "edit" lets any workspace member edit a whiteboard.
create or replace function public.editable_board_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  with me as (select public.my_workspace_role() as r)
  select b.id from public.board b, me
   where me.r = 'admin'
  union
  select bm.board_id from public.board_member bm, me
   where me.r is not null and bm.user_id = auth.uid() and bm.role in ('admin', 'normal')
  union
  select b.id from public.board b, me
   where me.r = 'member' and b.kind = 'whiteboard' and b.visibility = 'workspace' and b.wb_team_access = 'edit';
$$;

create or replace function public.can_edit_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.board_access(b) in ('admin', 'normal'), false)
      or exists (select 1 from public.board bo
                  where bo.id = b and bo.kind = 'whiteboard' and bo.visibility = 'workspace'
                    and bo.wb_team_access = 'edit' and public.my_workspace_role() = 'member');
$$;

-- Whiteboards comment by role (Miro); boards keep their comment policy (Trello).
create or replace function public.can_comment_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case
    when bo.kind = 'whiteboard' then
         x.a in ('admin', 'normal')
      or exists (select 1 from public.board_member bm
                  where bm.board_id = b and bm.user_id = auth.uid() and bm.wb_role = 'commenter')
      or (x.a is not null and public.my_workspace_role() = 'member' and bo.visibility = 'workspace'
          and bo.wb_team_access in ('comment', 'edit'))
    else case bo.comment_policy
      when 'disabled'  then false
      when 'members'   then x.a in ('admin', 'normal')
      when 'observers' then x.a in ('admin', 'normal', 'observer')
      when 'workspace' then x.a is not null
    end end, false)
  from public.board bo, (select public.board_access(b) as a) x
  where bo.id = b;
$$;

-- Joining a whiteboard yourself gets the team's level (see the role trigger).
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

  if target = auth.uid() and a = 'viewer' then
    if bo.kind = 'whiteboard' then
      return r = public._wb_board_role(case bo.wb_team_access when 'edit' then 'editor' when 'comment' then 'commenter' else 'viewer' end);
    end if;
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

-- The client's view of its access; whiteboards add the Miro fields.
create or replace function public.my_board_access(b uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'access',         public.board_access(b),
    'can_edit',       public.can_edit_board(b),
    'can_comment',    public.can_comment_board(b),
    'manage_members', public.can_manage_board_members(b),
    'delete_board',   public.can_delete_board(b),
    'wb_role',        (select bm.wb_role from public.board_member bm where bm.board_id = b and bm.user_id = auth.uid()),
    'team_access',    (select bo.wb_team_access from public.board bo where bo.id = b and bo.kind = 'whiteboard'),
    'allow_copy',     (select bo.wb_allow_copy from public.board bo where bo.id = b and bo.kind = 'whiteboard')
  );
$$;

-- ------------------------------------------------------------ ownership --
create or replace function public.wb_transfer_ownership(p_board uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_kind text;
begin
  select kind into v_kind from public.board where id = p_board;
  if v_kind is distinct from 'whiteboard' then raise exception 'Not a whiteboard'; end if;
  if not public.is_admin() and not exists (
       select 1 from public.board_member
        where board_id = p_board and user_id = auth.uid() and wb_role = 'owner')
     or not public.am_active() then
    raise exception 'Only the owner can transfer ownership';
  end if;
  if not exists (select 1 from public.profile where id = p_user and is_active and role <> 'guest') then
    raise exception 'Ownership can go to an active workspace member only';
  end if;
  perform set_config('iklipse.wb_owner', 'on', true);
  update public.board_member set wb_role = 'coowner' where board_id = p_board and wb_role = 'owner' and user_id <> p_user;
  insert into public.board_member (board_id, user_id, role, wb_role)
  values (p_board, p_user, 'admin', 'owner')
  on conflict (board_id, user_id) do update set wb_role = 'owner';
  perform set_config('iklipse.wb_owner', 'off', true);
end $$;
revoke all on function public.wb_transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.wb_transfer_ownership(uuid, uuid) to authenticated;

-- create_board: the creator owns a new whiteboard.
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

  if v_kind = 'whiteboard' then
    perform set_config('iklipse.wb_owner', 'on', true);
    insert into public.board_member (board_id, user_id, role, wb_role) values (v_id, v_uid, 'admin', 'owner');
    perform set_config('iklipse.wb_owner', 'off', true);
  else
    insert into public.board_member (board_id, user_id, role) values (v_id, v_uid, 'admin');
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
