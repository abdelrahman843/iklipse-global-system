-- ============================================================================
-- 0088_bot_meetings.sql
--   Meetings from WhatsApp, the bot as the team's first line (part 3).
--   1. In the group, the bot only says what was booked (moved, cancelled) and
--      the link. Anything else (a question, a full day, Calendly saying no)
--      it tells the admin who asked privately, and carries on there.
--   2. When it's on, everyone on a meeting iklipse knows (the team, clients
--      in Clients) gets its details privately, and a reminder an hour before. That's
--      every meeting on the team's Calendly: the ones the bot books, and the
--      ones people book themselves from a link (Calendly tells us, or the bot
--      looks every few minutes).
--   3. A client's email missing for a meeting is asked where the bot asks
--      (Settings), and the meeting is booked once it's in.
--   4. A client asking for a meeting in a group where the bot replies gets the
--      booking link of the Calendly picked in Settings.
--   Conversations with the bot and the meetings are kept for good.
-- ============================================================================

-- --------------------------------------------------------------- meetings --
alter table public.wa_bot_meeting alter column chat_id drop not null;   -- booked from a link: no group
alter table public.wa_bot_meeting
  add column if not exists source      text not null default 'bot' check (source in ('bot', 'link')),
  add column if not exists attendees   jsonb,          -- [{ kind, id, name, email, phone, host }]
  add column if not exists told_at     timestamptz,    -- its details went to them privately
  add column if not exists reminded_at timestamptz;    -- the reminder an hour before went
-- The ones booked before this aren't told or reminded now.
update public.wa_bot_meeting set told_at = coalesce(told_at, now()), reminded_at = coalesce(reminded_at, now());
create index if not exists wa_bot_meeting_tell_idx on public.wa_bot_meeting (start_at) where status = 'booked' and (told_at is null or reminded_at is null);

alter table public.calendly_account
  add column if not exists polled_at timestamptz;   -- its meetings last read by the bot

-- A client's email asked for a meeting waiting on it (that conversation).
alter table public.bot_ask
  add column if not exists meeting uuid references public.wa_bot_thread(id) on delete set null;

-- ----------------------------------------------------------- settings --
alter table public.watch_settings
  add column if not exists book_link_account uuid references public.calendly_account(id) on delete set null,   -- clients' booking link
  add column if not exists meet_tell boolean not null default false;   -- meetings' details and reminders, privately

-- As 0087, plus the Calendly whose booking link clients get, and telling people about meetings.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[]; v_days int[]; v_dates date[]; v_phone text; v_group text; v_link uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins',
                 'mail_enabled', 'mail_reply_wait_min', 'mail_clients', 'mail_ads', 'mail_senders',
                 'slack_enabled', 'book_enabled',
                 'follow_enabled', 'follow_wait_min', 'follow_every_min', 'follow_alerts', 'off_days', 'off_dates',
                 'deadline_enabled', 'deadline_before_hours', 'deadline_every_min',
                 'ask_enabled', 'ask_to', 'ask_phone', 'ask_group', 'ask_every_min', 'dm_enabled', 'book_link_account', 'meet_tell') then
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if p ? 'mail_senders' then
    if jsonb_typeof(p->'mail_senders') <> 'array' then raise exception 'The senders are a list'; end if;
    v_senders := public._gmail_senders(array(select jsonb_array_elements_text(p->'mail_senders')));
    if cardinality(v_senders) > 100 then raise exception 'Up to 100 senders'; end if;
  end if;
  if p ? 'off_days' then
    if jsonb_typeof(p->'off_days') <> 'array' then raise exception 'The days off are a list'; end if;
    v_days := array(select distinct x::int from jsonb_array_elements_text(p->'off_days') x order by 1);
  end if;
  if p ? 'off_dates' then
    if jsonb_typeof(p->'off_dates') <> 'array' then raise exception 'The dates off are a list'; end if;
    v_dates := array(select distinct x::date from jsonb_array_elements_text(p->'off_dates') x
                      where x::date >= (now() at time zone 'Africa/Cairo')::date order by 1);
  end if;
  if p ? 'ask_phone' then
    v_phone := public._phone_key(p->>'ask_phone');
    if v_phone is not null and v_phone !~ '^[1-9][0-9]{7,14}$' then raise exception 'That is not a WhatsApp number'; end if;
  end if;
  if p ? 'ask_group' then
    v_group := nullif(p->>'ask_group', '');
    if v_group is not null and not exists (select 1 from public.wa_group where chat_id = v_group and kind = 'team') then
      raise exception 'Pick one of the team groups';
    end if;
  end if;
  if p ? 'book_link_account' then
    v_link := nullif(p->>'book_link_account', '')::uuid;
    if v_link is not null and not exists (select 1 from public.calendly_account where id = v_link) then
      raise exception 'That Calendly account isn''t connected';
    end if;
  end if;
  update public.watch_settings set
    enabled               = coalesce((p->>'enabled')::boolean, enabled),
    model                 = coalesce(p->>'model', model),
    reply_wait_min        = coalesce((p->>'reply_wait_min')::int, reply_wait_min),
    promise_wait_min      = coalesce((p->>'promise_wait_min')::int, promise_wait_min),
    repeat_every_min      = coalesce((p->>'repeat_every_min')::int, repeat_every_min),
    alerts_before_call    = coalesce((p->>'alerts_before_call')::int, alerts_before_call),
    calls_enabled         = coalesce((p->>'calls_enabled')::boolean, calls_enabled),
    call_retry_min        = coalesce((p->>'call_retry_min')::int, call_retry_min),
    call_every_min        = coalesce((p->>'call_every_min')::int, call_every_min),
    max_calls             = coalesce((p->>'max_calls')::int, max_calls),
    stop_after_hours      = coalesce((p->>'stop_after_hours')::int, stop_after_hours),
    quiet_from            = case when p ? 'quiet_from' then nullif(p->>'quiet_from', '')::time else quiet_from end,
    quiet_to              = case when p ? 'quiet_to' then nullif(p->>'quiet_to', '')::time else quiet_to end,
    call_language         = coalesce(p->>'call_language', call_language),
    cc_admins             = coalesce((p->>'cc_admins')::boolean, cc_admins),
    mail_enabled          = coalesce((p->>'mail_enabled')::boolean, mail_enabled),
    mail_reply_wait_min   = coalesce((p->>'mail_reply_wait_min')::int, mail_reply_wait_min),
    mail_clients          = coalesce((p->>'mail_clients')::boolean, mail_clients),
    mail_ads              = coalesce((p->>'mail_ads')::boolean, mail_ads),
    mail_senders          = case when p ? 'mail_senders' then v_senders else mail_senders end,
    slack_enabled         = coalesce((p->>'slack_enabled')::boolean, slack_enabled),
    book_enabled          = coalesce((p->>'book_enabled')::boolean, book_enabled),
    follow_enabled        = coalesce((p->>'follow_enabled')::boolean, follow_enabled),
    follow_wait_min       = coalesce((p->>'follow_wait_min')::int, follow_wait_min),
    follow_every_min      = coalesce((p->>'follow_every_min')::int, follow_every_min),
    follow_alerts         = coalesce((p->>'follow_alerts')::int, follow_alerts),
    off_days              = case when p ? 'off_days' then v_days else off_days end,
    off_dates             = case when p ? 'off_dates' then v_dates else off_dates end,
    deadline_enabled      = coalesce((p->>'deadline_enabled')::boolean, deadline_enabled),
    deadline_before_hours = coalesce((p->>'deadline_before_hours')::int, deadline_before_hours),
    deadline_every_min    = coalesce((p->>'deadline_every_min')::int, deadline_every_min),
    ask_enabled           = coalesce((p->>'ask_enabled')::boolean, ask_enabled),
    ask_to                = coalesce(p->>'ask_to', ask_to),
    ask_phone             = case when p ? 'ask_phone' then v_phone else ask_phone end,
    ask_group             = case when p ? 'ask_group' then v_group else ask_group end,
    ask_every_min         = coalesce((p->>'ask_every_min')::int, ask_every_min),
    dm_enabled            = coalesce((p->>'dm_enabled')::boolean, dm_enabled),
    book_link_account     = case when p ? 'book_link_account' then v_link else book_link_account end,
    meet_tell             = coalesce((p->>'meet_tell')::boolean, meet_tell),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  -- Asking needs somewhere to ask.
  if exists (select 1 from public.watch_settings where id = 1 and (ask_enabled or dm_enabled)
               and ((ask_to = 'person' and ask_phone is null) or (ask_to = 'group' and ask_group is null))) then
    raise exception 'Say who the bot asks: a WhatsApp number, or a team group';
  end if;
end $$;

-- Admins: every connected Calendly (whose, which event type), for the booking link clients get.
create or replace function public.watch_calendly_accounts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'owner', p.display_name, 'email', a.email, 'name', a.name,
             'event_type', a.event_type_name, 'minutes', a.event_type_minutes)
           order by p.display_name, a.email)
      from public.calendly_account a
      join public.profile p on p.id = a.user_id), '[]'::jsonb);
end $$;
revoke all on function public.watch_calendly_accounts() from public, anon;
grant execute on function public.watch_calendly_accounts() to authenticated;

notify pgrst, 'reload schema';
