-- 0122_restore_0001_replay.sql
--   The first `supabase db push` from CI (2026-10-24) found an empty migration
--   history on the live database (migrations had been applied by hand), so it
--   ran 0001 again before failing on 0002. 0001 is re-runnable, which means it
--   put back its original versions of a few functions and one policy that
--   later migrations had replaced. This puts the latest ones back, exactly as
--   those migrations left them. Safe to run again.

-- 0013: has_permission is gone (0001 brought it back).
drop function if exists public.has_permission(public.permission_key);

-- 0036: an admin's session must be current.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profile where id = auth.uid() and role = 'admin' and is_active)
         and public._login_current();
$$;

-- 0055: only accounts the admin function made start active.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_username text;
  v_display  text;
  v_role     public.role;
  v_by_admin boolean;
begin
  v_username := coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1));
  v_display  := coalesce(new.raw_user_meta_data ->> 'display_name', v_username);
  -- Only the service role can write app metadata; user metadata is the signer's.
  v_by_admin := coalesce(new.raw_app_meta_data ->> 'provisioned', '') = 'admin';
  v_role     := case when v_by_admin then coalesce((new.raw_app_meta_data ->> 'role')::public.role, 'member') else 'member' end;
  insert into public.profile (id, username, display_name, role, is_active)
  values (new.id, v_username, v_display, v_role, v_by_admin and new.email_confirmed_at is not null)
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- 0062: members can't change their own roles, status or sign-in state.
create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role          is distinct from old.role          then raise exception 'Not authorised to change role'; end if;
    if new.trello_role   is distinct from old.trello_role   then raise exception 'Not authorised to change role'; end if;
    if new.miro_role     is distinct from old.miro_role     then raise exception 'Not authorised to change role'; end if;
    if new.brief_role    is distinct from old.brief_role    then raise exception 'Not authorised to change role'; end if;
    if new.delivery_role is distinct from old.delivery_role then raise exception 'Not authorised to change role'; end if;
    if new.is_active     is distinct from old.is_active     then raise exception 'Not authorised to change status'; end if;
    if new.username      is distinct from old.username      then raise exception 'Not authorised to change username'; end if;
    if new.sessions_revoked_at is distinct from old.sessions_revoked_at then
      raise exception 'Not authorised to change sign-in state';
    end if;
  end if;
  return new;
end $$;

-- 0044: who sees the people list.
drop policy if exists profile_select_authenticated on public.profile;
create policy profile_select_authenticated on public.profile for select to authenticated
  using ((id = auth.uid())
         or (public.am_active()
             and ((public.my_workspace_role() = any (array['admin', 'member']))
                  or public.my_product_role('kanban') in ('admin', 'member')
                  or public.my_product_role('whiteboard') in ('admin', 'member')
                  or (id in (select bm.user_id from public.board_member bm
                              where bm.board_id in (select public.visible_board_ids()))))));
