-- ============================================================================
-- 0001_identity_permissions.sql
--   Phase 1: profile, role, permissions, RLS foundations.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ============================================================ Enums ========
do $$ begin
  create type public.role as enum ('admin', 'member');
exception when duplicate_object then null; end $$;

-- Permission enum — mirrors src/lib/database.types.ts::PermissionKey.
do $$ begin
  create type public.permission_key as enum (
    'pm.view',
    'pm.create_board','pm.edit_board','pm.delete_board','pm.manage_board_members',
    'pm.create_list','pm.edit_list','pm.move_list','pm.archive_list',
    'pm.create_card','pm.edit_card','pm.move_card','pm.archive_card','pm.delete_card','pm.copy_card',
    'pm.manage_labels','pm.manage_members','pm.manage_dates','pm.manage_checklists',
    'pm.manage_attachments','pm.manage_comments','pm.manage_custom_fields','pm.manage_templates',
    'pm.search','pm.calendar_view','pm.table_view','pm.timeline_view','pm.dashboard_view',
    'pm.view_automation','pm.manage_automation','pm.execute_automation',
    'pm.view_activity','pm.manage_notifications','pm.export'
  );
exception when duplicate_object then null; end $$;

-- ============================================================ Profile =====
create table if not exists public.profile (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      citext not null unique,
  display_name  text not null,
  avatar_url    text,
  role          public.role not null default 'member',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists profile_role_idx on public.profile(role);
create index if not exists profile_is_active_idx on public.profile(is_active);

-- keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profile_updated_at on public.profile;
create trigger profile_updated_at before update on public.profile
  for each row execute function public.set_updated_at();

-- ==================================================== User permissions ====
create table if not exists public.user_permission (
  user_id     uuid not null references public.profile(id) on delete cascade,
  permission  public.permission_key not null,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references public.profile(id),
  primary key (user_id, permission)
);

create index if not exists user_permission_user_idx on public.user_permission(user_id);

-- ============================================================ Helpers =====
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profile
     where id = auth.uid() and role = 'admin' and is_active
  );
$$;

create or replace function public.has_permission(p public.permission_key)
returns boolean language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from public.profile
             where id = auth.uid() and role = 'admin' and is_active)
    or exists (select 1 from public.user_permission up
                join public.profile pr on pr.id = up.user_id and pr.is_active
               where up.user_id = auth.uid() and up.permission = p);
$$;

-- ============================================== Auth signup → profile ====
-- When a new auth.users row appears, materialise a matching profile row.
-- Admin creates the auth user with user metadata (display_name/username/role),
-- and this trigger copies them across.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_username text;
  v_display  text;
  v_role     public.role;
begin
  v_username := coalesce(
    new.raw_user_meta_data ->> 'username',
    split_part(new.email, '@', 1)
  );
  v_display := coalesce(new.raw_user_meta_data ->> 'display_name', v_username);
  v_role := coalesce((new.raw_user_meta_data ->> 'role')::public.role, 'member');

  insert into public.profile (id, username, display_name, role)
  values (new.id, v_username, v_display, v_role)
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================ RLS ========
alter table public.profile enable row level security;
alter table public.user_permission enable row level security;

-- Everyone signed in can read profile rows (needed for @mentions, avatars, member pickers).
drop policy if exists profile_select_authenticated on public.profile;
create policy profile_select_authenticated on public.profile
  for select to authenticated using (true);

-- A user can update their own display_name/avatar; role/is_active are admin-only.
-- We enforce that at the RPC layer (see admin_update_member) — this policy allows the base row update
-- but a separate CHECK trigger prevents role escalation.
drop policy if exists profile_update_self on public.profile;
create policy profile_update_self on public.profile
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists profile_admin_all on public.profile;
create policy profile_admin_all on public.profile
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Prevent a member from escalating their own role or reactivating themselves via the self-update policy.
create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if not public.is_admin() then
    if new.role       is distinct from old.role       then raise exception 'Not authorised to change role'; end if;
    if new.is_active  is distinct from old.is_active  then raise exception 'Not authorised to change status'; end if;
    if new.username   is distinct from old.username   then raise exception 'Not authorised to change username'; end if;
  end if;
  return new;
end $$;

drop trigger if exists profile_guard on public.profile;
create trigger profile_guard before update on public.profile
  for each row execute function public.profile_guard_self_update();

-- user_permission: readable by the owner (for the app to load its own perm set) and by admins.
drop policy if exists user_permission_select on public.user_permission;
create policy user_permission_select on public.user_permission
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Only admins can write permissions. Members can never grant to themselves.
drop policy if exists user_permission_admin_write on public.user_permission;
create policy user_permission_admin_write on public.user_permission
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
