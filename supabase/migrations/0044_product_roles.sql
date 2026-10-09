-- ============================================================================
-- 0044_product_roles.sql
--   Separate roles for Trello (kanban boards) and Miro (whiteboards): someone
--   can be an admin in Trello and a member in Miro, a guest in one and have
--   no access to the other, and so on.
--
--   profile.trello_role / profile.miro_role: admin | member | guest | none.
--   NULL = same as the workspace role (profile.role), so nothing changes for
--   anyone until an admin sets them. 'none' = no access to that product.
--
--   Every board check now uses the role for that board's kind instead of the
--   workspace role. The workspace role still decides who runs the workspace
--   (Users page, settings, integrations: is_admin()).
-- ============================================================================

alter table public.profile add column if not exists trello_role text;
alter table public.profile add column if not exists miro_role text;
alter table public.profile drop constraint if exists profile_trello_role_check;
alter table public.profile add constraint profile_trello_role_check check (trello_role in ('admin', 'member', 'guest', 'none'));
alter table public.profile drop constraint if exists profile_miro_role_check;
alter table public.profile add constraint profile_miro_role_check check (miro_role in ('admin', 'member', 'guest', 'none'));

-- A person's role in one product ('kanban' = Trello, 'whiteboard' = Miro).
-- NULL when inactive or with no access to that product.
create or replace function public._product_role(p_user uuid, p_kind text)
returns text language sql stable security definer set search_path = public as $$
  select nullif(coalesce(case when p_kind = 'whiteboard' then p.miro_role else p.trello_role end, p.role::text), 'none')
    from public.profile p
   where p.id = p_user and p.is_active;
$$;
revoke all on function public._product_role(uuid, text) from public, anon;
grant execute on function public._product_role(uuid, text) to authenticated;

-- The caller's role in one product (a revoked login gets nothing).
create or replace function public.my_product_role(p_kind text)
returns text language sql stable security definer set search_path = public as $$
  select public._product_role(auth.uid(), p_kind) where public._login_current();
$$;
revoke all on function public.my_product_role(text) from public, anon;
grant execute on function public.my_product_role(text) to authenticated;

-- The caller's role for the kind of board `b` is.
create or replace function public._my_board_kind_role(b uuid)
returns text language sql stable security definer set search_path = public as $$
  select public.my_product_role(bo.kind) from public.board bo where bo.id = b;
$$;
revoke all on function public._my_board_kind_role(uuid) from public, anon;
grant execute on function public._my_board_kind_role(uuid) to authenticated;

-- People can't change their own product roles.
create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role        is distinct from old.role        then raise exception 'Not authorised to change role'; end if;
    if new.trello_role is distinct from old.trello_role then raise exception 'Not authorised to change role'; end if;
    if new.miro_role   is distinct from old.miro_role   then raise exception 'Not authorised to change role'; end if;
    if new.is_active   is distinct from old.is_active   then raise exception 'Not authorised to change status'; end if;
    if new.username    is distinct from old.username    then raise exception 'Not authorised to change username'; end if;
    if new.sessions_revoked_at is distinct from old.sessions_revoked_at then
      raise exception 'Not authorised to change sign-in state';
    end if;
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ board access --
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
  from (select public._my_board_kind_role(b) as r) me;
$$;

create or replace function public.visible_board_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  with me as (
    select p.role::text as r, p.trello_role, p.miro_role
      from public.profile p
     where p.id = auth.uid() and p.is_active and public._login_current()),
  br as (
    select b.id, b.visibility,
           nullif(coalesce(case when b.kind = 'whiteboard' then me.miro_role else me.trello_role end, me.r), 'none') as r
      from public.board b, me)
  select id from br where r = 'admin'
  union
  select bm.board_id from public.board_member bm join br on br.id = bm.board_id
   where br.r is not null and bm.user_id = auth.uid()
  union
  select id from br where r = 'member' and visibility = 'workspace';
$$;

create or replace function public.editable_board_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  with me as (
    select p.role::text as r, p.trello_role, p.miro_role
      from public.profile p
     where p.id = auth.uid() and p.is_active and public._login_current()),
  br as (
    select b.id, b.kind, b.visibility, b.wb_team_access,
           nullif(coalesce(case when b.kind = 'whiteboard' then me.miro_role else me.trello_role end, me.r), 'none') as r
      from public.board b, me)
  select id from br where r = 'admin'
  union
  select bm.board_id from public.board_member bm join br on br.id = bm.board_id
   where br.r is not null and bm.user_id = auth.uid() and bm.role in ('admin', 'normal')
  union
  select id from br where r = 'member' and kind = 'whiteboard' and visibility = 'workspace' and wb_team_access = 'edit';
$$;

create or replace function public.can_edit_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.board_access(b) in ('admin', 'normal'), false)
      or exists (select 1 from public.board bo
                  where bo.id = b and bo.kind = 'whiteboard' and bo.visibility = 'workspace'
                    and bo.wb_team_access = 'edit' and public.my_product_role('whiteboard') = 'member');
$$;

create or replace function public.can_comment_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(case
    when bo.kind = 'whiteboard' then
         x.a in ('admin', 'normal')
      or exists (select 1 from public.board_member bm
                  where bm.board_id = b and bm.user_id = auth.uid() and bm.wb_role = 'commenter')
      or (x.a is not null and public.my_product_role('whiteboard') = 'member' and bo.visibility = 'workspace'
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

-- Creating a board: by the role in that product.
create or replace function public.can_create_board_kind(p_kind text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    r = 'admin' or (r = 'member' and (select board_create_policy from public.workspace
                                       where id = '00000000-0000-0000-0000-000000000001') = 'members'),
    false)
  from (select public.my_product_role(coalesce(p_kind, 'kanban')) as r) me;
$$;
revoke all on function public.can_create_board_kind(text) from public, anon;
grant execute on function public.can_create_board_kind(text) to authenticated;

-- Kept for older callers: either product.
create or replace function public.can_create_board()
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_create_board_kind('kanban') or public.can_create_board_kind('whiteboard');
$$;

drop policy if exists board_insert on public.board;
create policy board_insert on public.board for insert to authenticated
  with check (public.can_create_board_kind(kind::text) and created_by = auth.uid());

create or replace function public.can_delete_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public._my_board_kind_role(b) = 'admin', false);
$$;

create or replace function public.can_add_board_member(b uuid, target uuid, r board_role)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  a text := public.board_access(b);
  t_role text;
  bo public.board%rowtype;
begin
  select * into bo from public.board where id = b;
  if not found then return false; end if;
  -- The person's role in this product (none / inactive = can't be added).
  t_role := public._product_role(target, bo.kind);
  if t_role is null then return false; end if;

  if target = auth.uid() and a = 'viewer' then
    if bo.kind = 'whiteboard' then
      return r = public._wb_board_role(case bo.wb_team_access when 'edit' then 'editor' when 'comment' then 'commenter' else 'viewer' end);
    end if;
    return bo.self_join and r = 'normal';
  end if;

  if not public.can_manage_board_members(b) then return false; end if;
  if r = 'admin' and a <> 'admin' then return false; end if;
  if t_role = 'guest' and coalesce(public.my_product_role(bo.kind), '') <> 'admin'
     and (select guest_policy from public.workspace where id = bo.workspace_id) = 'admins' then
    return false;
  end if;
  return true;
end $$;

-- Notifications, mentions: what another person may see / edit.
create or replace function public._can_see_board_as(p_user uuid, p_board uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select r = 'admin'
        or exists (select 1 from public.board_member bm where bm.board_id = p_board and bm.user_id = p_user)
        or (r = 'member' and b.visibility = 'workspace')
      from public.board b, (select public._product_role(p_user, b2.kind) as r from public.board b2 where b2.id = p_board) x
     where b.id = p_board and x.r is not null), false);
$$;

create or replace function public._can_edit_board_as(p_user uuid, p_board uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select r = 'admin'
        or exists (select 1 from public.board_member bm
                    where bm.user_id = p_user and bm.board_id = p_board and bm.role in ('admin', 'normal'))
      from (select public._product_role(p_user, b.kind) as r from public.board b where b.id = p_board) x
     where x.r is not null), false);
$$;

-- Miro board roles: the workspace-admin shortcuts become Miro-admin ones.
create or replace function public.board_member_wb_role()
returns trigger language plpgsql security definer set search_path = public as $$
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
    if new.user_id = auth.uid() and coalesce(public.my_product_role('whiteboard'), '') <> 'admin'
       and not public.can_manage_board_members(new.board_id) then
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

create or replace function public.wb_transfer_ownership(p_board uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_kind text;
begin
  select kind into v_kind from public.board where id = p_board;
  if v_kind is distinct from 'whiteboard' then raise exception 'Not a whiteboard'; end if;
  if coalesce(public.my_product_role('whiteboard'), '') <> 'admin' and not exists (
       select 1 from public.board_member
        where board_id = p_board and user_id = auth.uid() and wb_role = 'owner')
     or not public.am_active() then
    raise exception 'Only the owner can transfer ownership';
  end if;
  if coalesce(public._product_role(p_user, 'whiteboard'), '') not in ('admin', 'member') then
    raise exception 'Ownership can go to an active Miro member only';
  end if;
  perform set_config('iklipse.wb_owner', 'on', true);
  update public.board_member set wb_role = 'coowner' where board_id = p_board and wb_role = 'owner' and user_id <> p_user;
  insert into public.board_member (board_id, user_id, role, wb_role)
  values (p_board, p_user, 'admin', 'owner')
  on conflict (board_id, user_id) do update set wb_role = 'owner';
  perform set_config('iklipse.wb_owner', 'off', true);
end $$;

-- Who sees the people list: anyone who is a member or admin somewhere.
drop policy if exists profile_select_authenticated on public.profile;
create policy profile_select_authenticated on public.profile for select to authenticated
  using ((id = auth.uid())
         or (public.am_active()
             and ((public.my_workspace_role() = any (array['admin', 'member']))
                  or public.my_product_role('kanban') in ('admin', 'member')
                  or public.my_product_role('whiteboard') in ('admin', 'member')
                  or (id in (select bm.user_id from public.board_member bm
                              where bm.board_id in (select public.visible_board_ids()))))));
