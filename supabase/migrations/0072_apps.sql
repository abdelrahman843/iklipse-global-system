-- ============================================================================
-- 0072: the iklipse apps (Android, Windows) come from inside iklipse only.
--
-- The builds (android.yml, desktop.yml) upload to the private "apps" bucket
-- through the apps function, and record the newest version here. Signed-in
-- team members download them with a link that works for a few minutes; the
-- apps find their updates the same way.
-- ============================================================================

insert into storage.buckets (id, name, public) values ('apps', 'apps', false)
on conflict (id) do update set public = false;
-- No storage policies: files go out only as signed links from the apps function.

create table if not exists public.app_release (
  platform   text primary key check (platform in ('android', 'windows', 'mac')),
  code       int not null,
  name       text not null,               -- "1.0.12"
  file       text not null,               -- in the apps bucket
  updated_at timestamptz not null default now()
);
alter table public.app_release enable row level security;
drop policy if exists app_release_read on public.app_release;
create policy app_release_read on public.app_release for select to authenticated using (public.am_active());
grant select on public.app_release to authenticated;
