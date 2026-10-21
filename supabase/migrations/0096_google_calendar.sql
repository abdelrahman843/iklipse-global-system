-- 0096: Google Calendar, connected like Drive (edge function calendar, the same
-- Google OAuth client). Each person uses Calendly or Google Calendar, not both:
-- the calendly and calendar functions refuse the second one. The sidebar names
-- the page after the one they use (Calendly or Calendar).

create table if not exists public.calendar_account (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profile(id) on delete cascade,
  email         text not null,
  name          text,
  access_token  text,
  refresh_token text not null,
  token_expiry  timestamptz,
  scope         text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, email)
);
create index if not exists calendar_account_user_idx on public.calendar_account (user_id);
alter table public.calendar_account enable row level security;
-- No policies on purpose: only the service role (the edge function) reads it.
revoke all on public.calendar_account from anon, authenticated;

-- Live updates (0094): Connected accounts and the sidebar follow it.
drop trigger if exists live_ins on public.calendar_account;
drop trigger if exists live_upd on public.calendar_account;
drop trigger if exists live_del on public.calendar_account;
create trigger live_ins after insert on public.calendar_account referencing new table as new_rows for each statement execute function public._live_ping();
create trigger live_upd after update on public.calendar_account referencing new table as new_rows for each statement execute function public._live_ping();
create trigger live_del after delete on public.calendar_account referencing old table as old_rows for each statement execute function public._live_ping();

create or replace function public.my_connections()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.uid() is not null and public._login_current() then jsonb_build_object(
    'calendly', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'email', c.email, 'name', c.name, 'scheduling_url', c.scheduling_url,
               'connected_at', c.connected_at, 'for_bot', c.for_bot,
               'event_type', c.event_type, 'event_type_name', c.event_type_name, 'event_type_minutes', c.event_type_minutes)
             order by c.connected_at)
        from public.calendly_account c
       where c.user_id = auth.uid()), '[]'::jsonb),
    'calendar', coalesce((
      select jsonb_agg(jsonb_build_object('id', k.id, 'email', k.email, 'name', k.name, 'connected_at', k.connected_at)
             order by k.connected_at)
        from public.calendar_account k
       where k.user_id = auth.uid()), '[]'::jsonb),
    'gmail', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'email', g.email, 'name', g.name, 'connected_at', g.connected_at,
               'sends_notifications', g.id is not distinct from w.notify_gmail_account)
             order by g.connected_at)
        from public.gmail_account g
        cross join (select notify_gmail_account from public.workspace limit 1) w
       where g.user_id = auth.uid()), '[]'::jsonb),
    'drive', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'email', d.email, 'name', d.name, 'connected_at', d.connected_at)
             order by d.connected_at)
        from public.drive_account d
       where d.user_id = auth.uid()), '[]'::jsonb),
    'fireflies', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'email', f.email, 'name', f.name, 'connected_at', f.connected_at,
                                          'last_sync_at', f.last_sync_at, 'last_error', f.last_error,
                                          'meetings', (select count(*) from public.fireflies_meeting m where m.account_id = f.id))
             order by f.connected_at)
        from public.fireflies_account f
       where f.user_id = auth.uid()), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.my_connections() from public, anon;
grant execute on function public.my_connections() to authenticated;

notify pgrst, 'reload schema';
