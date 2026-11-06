-- 0145_master_switches.sql
-- Stop buttons on the dashboard for what didn't have one, and the master's
-- work where it can be seen without WhatsApp.
--
-- The master (the relay on the server) reads master_stopped on every poll, and
-- the master channel refuses its tasks while it's set, so stopping doesn't
-- depend on the server listening. schedules_stopped holds the repeating jobs.
-- The jobs themselves are the super admin's own chats: only they read them.

alter table public.brain_settings
  add column if not exists master_stopped boolean not null default false,
  add column if not exists master_stopped_at timestamptz,
  add column if not exists schedules_stopped boolean not null default false,
  add column if not exists schedules_stopped_at timestamptz;

create table if not exists public.master_board (
  id    int primary key default 1 check (id = 1),
  jobs  jsonb not null default '[]'::jsonb,
  at    timestamptz not null default now()
);
insert into public.master_board (id) values (1) on conflict (id) do nothing;
alter table public.master_board enable row level security;
revoke all on public.master_board from anon, authenticated;

/** p_on: it runs. Any admin may stop or start these, as with the brain's switch. */
create or replace function public.brain_switch_set(p_what text, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_what = 'master' then
    update public.brain_settings set
      master_stopped = not p_on,
      master_stopped_at = case when p_on then null else now() end,
      updated_at = now(), updated_by = auth.uid()
    where id = 1;
  elsif p_what = 'schedules' then
    update public.brain_settings set
      schedules_stopped = not p_on,
      schedules_stopped_at = case when p_on then null else now() end,
      updated_at = now(), updated_by = auth.uid()
    where id = 1;
  else
    raise exception 'Nothing called %.', p_what;
  end if;
end $$;
revoke all on function public.brain_switch_set(text, boolean) from public, anon;
grant execute on function public.brain_switch_set(text, boolean) to authenticated;

/** The master's jobs as it last said them. Null for anyone but the super admin. */
create or replace function public.master_board_read()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() is distinct from public._super_admin() then return null; end if;
  return (select jsonb_build_object('jobs', b.jobs, 'at', b.at) from public.master_board b where b.id = 1);
end $$;
revoke all on function public.master_board_read() from public, anon;
grant execute on function public.master_board_read() to authenticated;

-- Open pages see a change at once (0094).
do $$
declare
  t text;
begin
  foreach t in array array['master_board', 'brain_settings'] loop
    execute format('drop trigger if exists live_ins on public.%I', t);
    execute format('drop trigger if exists live_upd on public.%I', t);
    execute format('drop trigger if exists live_del on public.%I', t);
    execute format('create trigger live_ins after insert on public.%I referencing new table as new_rows for each statement execute function public._live_ping()', t);
    execute format('create trigger live_upd after update on public.%I referencing new table as new_rows for each statement execute function public._live_ping()', t);
    execute format('create trigger live_del after delete on public.%I referencing old table as old_rows for each statement execute function public._live_ping()', t);
  end loop;
end $$;
