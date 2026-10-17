-- ============================================================================
-- 0080_meetings_followups_days_off.sql
--   1. Zoom meetings from WhatsApp: besides a meeting at a time, a link right
--      now, a link with no set time, and a series (wa_bot_meeting.kind; a link
--      with no set length has no minutes). Invitees get the invitation by
--      email from the host's Gmail (functions: _shared/invite.ts).
--   2. "Waiting on them" alerts (follow_up: a client said they'd send
--      something, or the team is waiting for their answer) have their own
--      settings: on or off, the first reminder when no time was given, how
--      many reminders and how far apart. They never call.
--   3. Days off: weekdays and dates (Cairo) when nothing rings at all, no
--      alerts and no calls. Alerts wait and ring the next working day.
--   4. Team members WhatsApp hides the number of (they show by their WhatsApp
--      id, "...@lid") can be linked in Alerts > Groups too.
-- ============================================================================

-- ------------------------------------------------------------ 1. meetings --
alter table public.wa_bot_meeting
  add column if not exists kind text not null default 'once' check (kind in ('once', 'instant', 'no_time', 'repeat'));
alter table public.wa_bot_meeting alter column minutes drop not null;

-- ------------------------------------------- 2 and 3. follow-ups, days off --
alter table public.watch_settings
  add column if not exists follow_enabled   boolean not null default true,
  add column if not exists follow_wait_min  int not null default 120 check (follow_wait_min between 5 and 10080),
  add column if not exists follow_every_min int not null default 240 check (follow_every_min between 5 and 10080),
  add column if not exists follow_alerts    int not null default 3 check (follow_alerts between 1 and 50),
  add column if not exists off_days         int[] not null default '{}' check (off_days <@ array[0, 1, 2, 3, 4, 5, 6]),  -- 0 Sunday .. 6 Saturday
  add column if not exists off_dates        date[] not null default '{}' check (cardinality(off_dates) <= 200);

-- As 0079, plus the follow-ups' settings and the days off.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[]; v_days int[]; v_dates date[];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins',
                 'mail_enabled', 'mail_reply_wait_min', 'mail_clients', 'mail_ads', 'mail_senders',
                 'slack_enabled', 'book_enabled', 'book_from', 'book_to',
                 'follow_enabled', 'follow_wait_min', 'follow_every_min', 'follow_alerts', 'off_days', 'off_dates') then
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
    -- Past dates are dropped as they go.
    v_dates := array(select distinct x::date from jsonb_array_elements_text(p->'off_dates') x
                      where x::date >= (now() at time zone 'Africa/Cairo')::date order by 1);
  end if;
  update public.watch_settings set
    enabled             = coalesce((p->>'enabled')::boolean, enabled),
    model               = coalesce(p->>'model', model),
    reply_wait_min      = coalesce((p->>'reply_wait_min')::int, reply_wait_min),
    promise_wait_min    = coalesce((p->>'promise_wait_min')::int, promise_wait_min),
    repeat_every_min    = coalesce((p->>'repeat_every_min')::int, repeat_every_min),
    alerts_before_call  = coalesce((p->>'alerts_before_call')::int, alerts_before_call),
    calls_enabled       = coalesce((p->>'calls_enabled')::boolean, calls_enabled),
    call_retry_min      = coalesce((p->>'call_retry_min')::int, call_retry_min),
    call_every_min      = coalesce((p->>'call_every_min')::int, call_every_min),
    max_calls           = coalesce((p->>'max_calls')::int, max_calls),
    stop_after_hours    = coalesce((p->>'stop_after_hours')::int, stop_after_hours),
    quiet_from          = case when p ? 'quiet_from' then nullif(p->>'quiet_from', '')::time else quiet_from end,
    quiet_to            = case when p ? 'quiet_to' then nullif(p->>'quiet_to', '')::time else quiet_to end,
    call_language       = coalesce(p->>'call_language', call_language),
    cc_admins           = coalesce((p->>'cc_admins')::boolean, cc_admins),
    mail_enabled        = coalesce((p->>'mail_enabled')::boolean, mail_enabled),
    mail_reply_wait_min = coalesce((p->>'mail_reply_wait_min')::int, mail_reply_wait_min),
    mail_clients        = coalesce((p->>'mail_clients')::boolean, mail_clients),
    mail_ads            = coalesce((p->>'mail_ads')::boolean, mail_ads),
    mail_senders        = case when p ? 'mail_senders' then v_senders else mail_senders end,
    slack_enabled       = coalesce((p->>'slack_enabled')::boolean, slack_enabled),
    book_enabled        = coalesce((p->>'book_enabled')::boolean, book_enabled),
    book_from           = coalesce(nullif(p->>'book_from', '')::time, book_from),
    book_to             = coalesce(nullif(p->>'book_to', '')::time, book_to),
    follow_enabled      = coalesce((p->>'follow_enabled')::boolean, follow_enabled),
    follow_wait_min     = coalesce((p->>'follow_wait_min')::int, follow_wait_min),
    follow_every_min    = coalesce((p->>'follow_every_min')::int, follow_every_min),
    follow_alerts       = coalesce((p->>'follow_alerts')::int, follow_alerts),
    off_days            = case when p ? 'off_days' then v_days else off_days end,
    off_dates           = case when p ? 'off_dates' then v_dates else off_dates end,
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
end $$;

-- ------------------------------------------------------ 4. hidden numbers --
-- A WhatsApp id ("1234...@lid") that belongs to someone on the team: for
-- people WhatsApp doesn't show the number of.
create table if not exists public.wa_member_lid (
  lid        text primary key check (lid ~ '^[0-9]{6,20}@lid$'),
  user_id    uuid not null references public.profile(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists wa_member_lid_user_idx on public.wa_member_lid (user_id);
alter table public.wa_member_lid enable row level security;
revoke all on public.wa_member_lid from anon, authenticated;

-- The team member a WhatsApp number (or hidden-number id) belongs to: a link
-- from Alerts > Groups, else the number on their member card.
create or replace function public._wa_user(p_phone text)
returns uuid language sql stable security definer set search_path = public as $$
  select case when p_phone like '%@lid'
    then (select user_id from public.wa_member_lid where lid = p_phone)
    else coalesce(
      (select user_id from public.wa_member where phone = p_phone),
      (select user_id from public.profile_contact where whatsapp = p_phone limit 1))
  end;
$$;
revoke all on function public._wa_user(text) from public, anon, authenticated;
grant execute on function public._wa_user(text) to service_role;

-- Admins: this WhatsApp number, or hidden-number id, is this team member (p_user null: not anyone).
create or replace function public.watch_link(p_phone text, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lid   text := case when coalesce(p_phone, '') ~ '^[0-9]{6,20}@lid$' then p_phone end;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_user is not null and not exists (select 1 from public.profile where id = p_user) then raise exception 'No such member'; end if;
  if v_lid is not null then
    if p_user is null then
      delete from public.wa_member_lid where lid = v_lid;
    else
      insert into public.wa_member_lid (lid, user_id) values (v_lid, p_user)
      on conflict (lid) do update set user_id = excluded.user_id;
    end if;
    return;
  end if;
  if v_phone !~ '^[1-9][0-9]{7,14}$' then raise exception 'That is not a WhatsApp number'; end if;
  if p_user is null then
    delete from public.wa_member where phone = v_phone;
  else
    insert into public.wa_member (phone, user_id) values (v_phone, p_user)
    on conflict (phone) do update set user_id = excluded.user_id;
  end if;
end $$;

-- As 0069, with hidden numbers linked by their WhatsApp id (lid).
create or replace function public.watch_groups()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'chat_id', g.chat_id, 'name', g.name, 'monitored', g.monitored, 'size', g.size,
               'left', g.left_at is not null, 'synced_at', g.synced_at, 'last_message_at', g.last_message_at,
               'analyzed_at', g.analyzed_at, 'last_error', g.last_error,
               'open_alerts', (select count(*) from public.watch_alert a where a.chat_id = g.chat_id and a.status = 'open'),
               'participants', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'wa_id', pt.wa_id, 'phone', pt.phone, 'lid', pt.lid, 'name', pt.name, 'is_admin', pt.is_admin,
                           'user_id', u.id, 'user_name', u.display_name, 'avatar_url', u.avatar_url, 'user_active', u.is_active,
                           'is_bot', pt.phone is not null and pt.phone = (select bot_phone from public.watch_settings where id = 1))
                           order by (u.id is null), coalesce(u.display_name, pt.name, pt.phone))
                    from public.wa_participant pt
                    left join public.profile u on u.id = public._wa_user(coalesce(pt.phone, pt.lid))
                   where pt.chat_id = g.chat_id), '[]'::jsonb))
             order by (g.left_at is not null), g.last_message_at desc nulls last, g.name)
        from public.wa_group g), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.display_name, 'avatar_url', p.avatar_url, 'active', p.is_active,
               'phones', (select coalesce(jsonb_agg(m.phone order by m.created_at), '[]'::jsonb) from public.wa_member m where m.user_id = p.id),
               'card_phone', (select whatsapp from public.profile_contact c where c.user_id = p.id))
             order by p.is_active desc, p.display_name)
        from public.profile p), '[]'::jsonb));
end $$;
