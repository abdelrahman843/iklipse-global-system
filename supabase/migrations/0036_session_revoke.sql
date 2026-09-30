-- ============================================================================
-- 0036_session_revoke.sql
--   Sign people out everywhere, effective at once.
--   profile.sessions_revoked_at: a login made before this moment no longer
--   counts. The check uses the login time carried in the token ("amr"
--   timestamp), which a token refresh keeps, so a revoked device can't just
--   refresh its way back in: it has to sign in again with the password.
--   Enforced in the database (every permission helper) and mirrored in the
--   app, which signs the device out as soon as it sees the change.
--   admin_sign_out(p_user) signs out one person, or everyone when null.
-- ============================================================================

alter table public.profile add column if not exists sessions_revoked_at timestamptz;

-- When the caller signed in (seconds). amr carries the sign-in time and
-- survives refreshes; iat is the fallback.
create or replace function public._auth_time()
returns double precision language sql stable set search_path = public as $$
  select coalesce(
    (select max((m->>'timestamp')::double precision)
       from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) m
      where m ? 'timestamp'),
    (auth.jwt()->>'iat')::double precision,
    0);
$$;

-- False when the caller's login predates an admin "sign out".
create or replace function public._login_current()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select extract(epoch from p.sessions_revoked_at) <= public._auth_time()
       from public.profile p where p.id = auth.uid() and p.sessions_revoked_at is not null),
    true);
$$;
revoke all on function public._login_current() from public, anon;
grant execute on function public._login_current() to authenticated;

-- The app asks this on start, focus and when its profile row changes.
create or replace function public.session_is_current()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public._login_current();
$$;
revoke all on function public.session_is_current() from public, anon;
grant execute on function public.session_is_current() to authenticated;

-- Every permission check runs through these three: a revoked login gets nothing.
create or replace function public.my_workspace_role()
returns text language sql stable security definer set search_path = public as $$
  select role::text from public.profile where id = auth.uid() and is_active and public._login_current();
$$;

create or replace function public.am_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profile where id = auth.uid() and is_active) and public._login_current();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profile where id = auth.uid() and role = 'admin' and is_active)
         and public._login_current();
$$;

-- People can't clear their own revocation.
create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role       is distinct from old.role       then raise exception 'Not authorised to change role'; end if;
    if new.is_active  is distinct from old.is_active  then raise exception 'Not authorised to change status'; end if;
    if new.username   is distinct from old.username   then raise exception 'Not authorised to change username'; end if;
    if new.sessions_revoked_at is distinct from old.sessions_revoked_at then
      raise exception 'Not authorised to change sign-in state';
    end if;
  end if;
  return new;
end $$;

create or replace function public.admin_sign_out(p_user uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only admins can sign people out';
  end if;
  update public.profile set sessions_revoked_at = now()
   where p_user is null or id = p_user;
  get diagnostics n = row_count;
  -- Also drop the stored refresh tokens where this role may (tidy, not required:
  -- the check above already blocks refreshed tokens).
  begin
    if p_user is null then delete from auth.sessions;
    else delete from auth.sessions where user_id = p_user; end if;
  exception when insufficient_privilege or undefined_table then null;
  end;
  return n;
end $$;
revoke all on function public.admin_sign_out(uuid) from public, anon;
grant execute on function public.admin_sign_out(uuid) to authenticated;
