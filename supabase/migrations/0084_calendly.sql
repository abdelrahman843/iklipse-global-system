-- 0084_calendly.sql — Calendly instead of Zoom.
--
-- Each person connects their own Calendly (OAuth, the calendly function), like
-- Zoom: several accounts, one of them the WhatsApp bot's, and on it the event
-- type the bot books with (its length; Calendly's own Zoom or Google Meet makes
-- the link). The bot books on Calendly now (watch_settings.book_with); the
-- Zoom tables, function and settings stay as they are, switched off, for when
-- Zoom comes back.

-- ------------------------------------------------------------- accounts --
create table if not exists public.calendly_account (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profile(id) on delete cascade,
  -- Calendly's user and organization (https://api.calendly.com/users/...).
  calendly_user      text not null,
  organization       text,
  email              text,
  name               text,
  scheduling_url     text,
  timezone           text,
  access_token       text,
  refresh_token      text not null,
  token_expiry       timestamptz,
  scope              text,
  -- The account the WhatsApp bot books on (one per person).
  for_bot            boolean not null default false,
  -- The event type the bot books with on this account (its uri, name, length).
  event_type         text,
  event_type_name    text,
  event_type_minutes int,
  -- Calendly's notifications about this account (when the plan allows them).
  webhook            text,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists calendly_account_user_uq on public.calendly_account (user_id, calendly_user);
create unique index if not exists calendly_account_bot_uq on public.calendly_account (user_id) where for_bot;
create index if not exists calendly_account_user_idx on public.calendly_account (user_id, connected_at);

alter table public.calendly_account enable row level security;
revoke all on public.calendly_account from anon, authenticated;

-- ------------------------------------------- meetings booked from WhatsApp --
-- A Calendly booking: zoom_id holds the Calendly event's id, the account is
-- calendly_account, and who it's with is kept to book them again on a move.
alter table public.wa_bot_meeting
  add column if not exists provider text not null default 'zoom' check (provider in ('zoom', 'calendly')),
  add column if not exists calendly_account uuid references public.calendly_account(id) on delete cascade,
  add column if not exists invitee_email text,
  add column if not exists invitee_name text;
-- Calendly makes the link a moment after the booking.
alter table public.wa_bot_meeting alter column join_url drop not null;

-- ------------------------------------------------------- which one books --
alter table public.watch_settings
  add column if not exists book_with text not null default 'calendly' check (book_with in ('zoom', 'calendly'));

-- ------------------------------------------------------- what I connected --
-- As 0079, plus Calendly.
create or replace function public.my_connections()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.uid() is not null and public._login_current() then jsonb_build_object(
    'zoom', coalesce((
      select jsonb_agg(jsonb_build_object('id', z.id, 'email', z.zoom_email, 'connected_at', z.connected_at, 'for_bot', z.for_bot)
             order by z.connected_at)
        from public.zoom_account z
       where z.user_id = auth.uid()), '[]'::jsonb),
    'calendly', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'email', c.email, 'name', c.name, 'scheduling_url', c.scheduling_url,
               'connected_at', c.connected_at, 'for_bot', c.for_bot,
               'event_type', c.event_type, 'event_type_name', c.event_type_name, 'event_type_minutes', c.event_type_minutes)
             order by c.connected_at)
        from public.calendly_account c
       where c.user_id = auth.uid()), '[]'::jsonb),
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
