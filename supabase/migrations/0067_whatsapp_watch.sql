-- ============================================================================
-- 0067_whatsapp_watch.sql
--   WhatsApp watch (the whatsapp-bot function).
--
--   The bot's WhatsApp (Green API, the vault keys from 0037) sits in client
--   groups. Every group message is kept for 30 days; Claude reads each group's
--   new messages once it goes quiet and opens an alert when:
--     - unanswered: a client wrote something that needs a reply and the team
--       hasn't answered,
--     - promise:    someone on the team promised something or to get back
--       ("I'll send it in an hour", "give me 10 minutes"),
--     - follow_up:  a client promised something (files, feedback, payment)
--       the team should chase if it doesn't come.
--   It closes alerts by itself when the chat shows they were dealt with.
--
--   An open alert rings like an alarm: a notification to the team members in
--   that group (only the person it's about, when it's about one person), again
--   every few minutes; after that many, a phone call to each of them, again
--   and again until they pick up, then every so often while it's still open.
--   It stops when someone marks it handled (the app, or 1 on the call), when
--   the chat shows it was dealt with, or after the hours set (if any).
--   Every number and time lives in watch_settings (Alerts > Settings, admins).
-- ============================================================================

-- --------------------------------------------------------------- settings --
create table if not exists public.watch_settings (
  id                 int primary key default 1 check (id = 1),
  enabled            boolean not null default false,
  model              text not null default 'claude-sonnet-5-5'
                       check (model in ('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5')),
  reply_wait_min     int not null default 10 check (reply_wait_min between 0 and 1440),
  promise_wait_min   int not null default 60 check (promise_wait_min between 5 and 2880),
  repeat_every_min   int not null default 15 check (repeat_every_min between 1 and 1440),
  alerts_before_call int not null default 4 check (alerts_before_call between 1 and 100),
  calls_enabled      boolean not null default false,
  call_retry_min     int not null default 2 check (call_retry_min between 1 and 120),
  call_every_min     int not null default 30 check (call_every_min between 5 and 1440),
  max_calls          int not null default 0 check (max_calls between 0 and 500),        -- 0: no limit
  stop_after_hours   int not null default 0 check (stop_after_hours between 0 and 720), -- 0: until handled
  quiet_from         time,                                                              -- Cairo; both or neither
  quiet_to           time,
  call_language      text not null default 'en' check (call_language in ('en', 'ar')),
  cc_admins          boolean not null default false,
  bot_state          text,         -- Green API instance state (last check / state webhook)
  bot_phone          text,
  hook_at            timestamptz,  -- last webhook from Green API
  synced_at          timestamptz,  -- last full read of the bot's groups
  tick_lock          timestamptz,  -- a run in progress (one at a time)
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.profile(id) on delete set null,
  check ((quiet_from is null) = (quiet_to is null))
);
insert into public.watch_settings (id) values (1) on conflict do nothing;

-- ----------------------------------------------------------------- groups --
create table if not exists public.wa_group (
  chat_id         text primary key check (chat_id ~ '@g\.us$'),
  name            text,
  monitored       boolean not null default true,
  size            int,
  left_at         timestamptz,       -- the bot is no longer in it
  synced_at       timestamptz,       -- who is in it, last read
  last_message_at timestamptz,
  pending_since   timestamptz,       -- new messages Claude hasn't read yet
  analyzed_at     timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

create table if not exists public.wa_participant (
  chat_id  text not null references public.wa_group(chat_id) on delete cascade,
  wa_id    text not null,            -- 2010...@c.us or ...@lid
  phone    text,                     -- digits, when WhatsApp shows it
  lid      text,
  name     text,
  is_admin boolean not null default false,
  primary key (chat_id, wa_id)
);
create index if not exists wa_participant_phone_idx on public.wa_participant (phone);
create index if not exists wa_participant_lid_idx on public.wa_participant (lid);

-- A WhatsApp number that belongs to someone on the team (a person can have a few).
-- The number on a member card (profile_contact.whatsapp) counts too.
create table if not exists public.wa_member (
  phone      text primary key check (phone ~ '^[1-9][0-9]{7,14}$'),
  user_id    uuid not null references public.profile(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists wa_member_user_idx on public.wa_member (user_id);

create table if not exists public.wa_message (
  id          text primary key,
  chat_id     text not null references public.wa_group(chat_id) on delete cascade,
  sender_id   text,
  phone       text,
  sender_name text,
  from_bot    boolean not null default false,
  text        text,
  quoted_id   text,
  sent_at     timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists wa_message_chat_idx on public.wa_message (chat_id, sent_at desc);
create index if not exists wa_message_created_idx on public.wa_message (chat_id, created_at);

-- ----------------------------------------------------------------- alerts --
create table if not exists public.watch_alert (
  id            uuid primary key default gen_random_uuid(),
  chat_id       text references public.wa_group(chat_id) on delete cascade,
  kind          text not null check (kind in ('unanswered', 'promise', 'follow_up')),
  title         text not null,
  detail        text,
  person        text,
  priority      text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  message_id    text,
  status        text not null default 'open' check (status in ('open', 'handled', 'resolved', 'stopped')),
  due_at        timestamptz not null,
  next_alert_at timestamptz,
  alerts_sent   int not null default 0,
  last_alert_at timestamptz,
  calls_made    int not null default 0,
  snoozed_until timestamptz,
  closed_at     timestamptz,
  closed_by     uuid references public.profile(id) on delete set null,
  close_note    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists watch_alert_due_idx on public.watch_alert (status, next_alert_at);
create index if not exists watch_alert_chat_idx on public.watch_alert (chat_id, status);

create table if not exists public.watch_recipient (
  alert_id     uuid not null references public.watch_alert(id) on delete cascade,
  user_id      uuid not null references public.profile(id) on delete cascade,
  calls        int not null default 0,
  answered     int not null default 0,
  next_call_at timestamptz,
  calling      boolean not null default false,
  last_call_at timestamptz,
  primary key (alert_id, user_id)
);
create index if not exists watch_recipient_user_idx on public.watch_recipient (user_id);
create index if not exists watch_recipient_call_idx on public.watch_recipient (next_call_at) where next_call_at is not null;

create table if not exists public.watch_call (
  id         uuid primary key default gen_random_uuid(),
  alert_id   uuid references public.watch_alert(id) on delete cascade,   -- null: a test call
  user_id    uuid references public.profile(id) on delete set null,
  phone      text not null,
  sid        text,
  audio      text,               -- storage path of what the call says
  status     text not null default 'calling'
               check (status in ('calling', 'answered', 'no_answer', 'busy', 'failed')),
  pressed    text,
  error      text,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  seconds    int
);
create index if not exists watch_call_alert_idx on public.watch_call (alert_id, started_at desc);

create table if not exists public.watch_event (
  id       bigserial primary key,
  alert_id uuid not null references public.watch_alert(id) on delete cascade,
  at       timestamptz not null default now(),
  what     text not null,   -- opened, alert, call, answered, no_answer, handled, resolved, snoozed, stopped, reopened
  detail   text,
  user_id  uuid references public.profile(id) on delete set null
);
create index if not exists watch_event_alert_idx on public.watch_event (alert_id, at);

-- What a call says (a few seconds of audio, removed when the call ends).
insert into storage.buckets (id, name, public) values ('watch-audio', 'watch-audio', false) on conflict (id) do nothing;

-- ------------------------------------------------------------------- RLS --
-- Everything goes through the functions below (and the whatsapp-bot function,
-- service role). Group messages are never readable from the app.
alter table public.watch_settings  enable row level security;
alter table public.wa_group        enable row level security;
alter table public.wa_participant  enable row level security;
alter table public.wa_member       enable row level security;
alter table public.wa_message      enable row level security;
alter table public.watch_alert     enable row level security;
alter table public.watch_recipient enable row level security;
alter table public.watch_call      enable row level security;
alter table public.watch_event     enable row level security;

-- -------------------------------------------------------------- helpers --
-- The team member a WhatsApp number belongs to: a link from Alerts > Groups,
-- else the number on their member card.
create or replace function public._wa_user(p_phone text)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select user_id from public.wa_member where phone = p_phone),
    (select user_id from public.profile_contact where whatsapp = p_phone limit 1));
$$;
revoke all on function public._wa_user(text) from public, anon, authenticated;

-- The number calls go to: the member card's, else a linked one.
create or replace function public._watch_phone(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select whatsapp from public.profile_contact where user_id = p_user and whatsapp is not null),
    (select phone from public.wa_member where user_id = p_user order by created_at limit 1));
$$;
revoke all on function public._watch_phone(uuid) from public, anon, authenticated;

create or replace function public._watch_can(p_alert uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.am_active() and (public.is_admin()
    or exists (select 1 from public.watch_recipient where alert_id = p_alert and user_id = auth.uid()));
$$;
revoke all on function public._watch_can(uuid) from public, anon, authenticated;

-- Its notifications stop looking urgent once it's closed (same as 0061).
create or replace function public._watch_quiet_notifications(p_alert uuid)
returns void language sql security definer set search_path = public as $$
  update public.notification
     set data = data || '{"resolved": true}'::jsonb
   where kind = 'watch_alert' and data->>'alert_id' = p_alert::text and coalesce((data->>'resolved')::boolean, false) = false;
$$;
revoke all on function public._watch_quiet_notifications(uuid) from public, anon, authenticated;

-- Green API and Twilio, for the whatsapp-bot function only.
create or replace function public._watch_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'greenapi_url', public._secret('greenapi_url'),
    'greenapi_instance', public._secret('greenapi_instance'),
    'greenapi_token', public._secret('greenapi_token'),
    'twilio_sid', public._secret('twilio_sid'),
    'twilio_token', public._secret('twilio_token'),
    'twilio_from', public._secret('twilio_from'));
end $$;
revoke all on function public._watch_config() from public, anon, authenticated;
grant execute on function public._watch_config() to service_role;
grant execute on function public._watch_phone(uuid) to service_role;
grant execute on function public._wa_user(text) to service_role;
grant execute on function public._watch_quiet_notifications(uuid) to service_role;

-- ------------------------------------------------------------ for the app --
-- The page's header: who I am here, the bot, the settings (admins), counts.
create or replace function public.watch_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.watch_settings; v_admin boolean := public.is_admin();
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  select * into s from public.watch_settings where id = 1;
  return jsonb_build_object(
    'is_admin', v_admin,
    'open', (select count(*) from public.watch_alert a where a.status = 'open'
               and (v_admin or exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid()))),
    'mine', (select count(*) from public.watch_alert a join public.watch_recipient r on r.alert_id = a.id
              where a.status = 'open' and r.user_id = auth.uid()),
    'my_phone', public._watch_phone(auth.uid()),
    'settings', case when v_admin then to_jsonb(s) - 'id' - 'tick_lock' - 'bot_state' - 'bot_phone' - 'hook_at' - 'synced_at' end,
    'bot', case when v_admin then jsonb_build_object(
      'configured', public._secret('greenapi_instance') is not null and public._secret('greenapi_token') is not null,
      'instance', public._secret('greenapi_instance'),
      'state', s.bot_state,
      'phone', s.bot_phone,
      'hook_at', s.hook_at,
      'synced_at', s.synced_at,
      'groups', (select count(*) from public.wa_group where left_at is null),
      'monitored', (select count(*) from public.wa_group where left_at is null and monitored)) end,
    'twilio', case when v_admin then jsonb_build_object(
      'configured', public._secret('twilio_sid') is not null and public._secret('twilio_token') is not null and public._secret('twilio_from') is not null,
      'from', public._secret('twilio_from')) end);
end $$;

-- Open alerts (p_open) or the last 30 days of closed ones I can see.
create or replace function public.watch_alerts(p_open boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := public.is_admin();
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  return coalesce((
    select jsonb_agg(x order by x.sort_at desc)
      from (
        select a.id, a.kind, a.title, a.detail, a.person, a.priority, a.status, a.due_at, a.next_alert_at,
               a.alerts_sent, a.last_alert_at, a.calls_made, a.snoozed_until, a.closed_at, a.close_note, a.created_at,
               coalesce(a.closed_at, a.due_at) as sort_at,
               (select display_name from public.profile where id = a.closed_by) as closed_by_name,
               jsonb_build_object('chat_id', g.chat_id, 'name', g.name) as "group",
               exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid()) as mine,
               coalesce((select jsonb_agg(jsonb_build_object(
                          'user_id', r.user_id, 'name', p.display_name, 'avatar_url', p.avatar_url,
                          'calls', r.calls, 'answered', r.answered, 'calling', r.calling, 'next_call_at', r.next_call_at)
                          order by p.display_name)
                   from public.watch_recipient r join public.profile p on p.id = r.user_id
                  where r.alert_id = a.id), '[]'::jsonb) as recipients,
               coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'what', e.what, 'detail', e.detail,
                                                             'by', (select display_name from public.profile where id = e.user_id))
                                          order by e.at desc)
                   from (select * from public.watch_event where alert_id = a.id order by at desc limit 12) e), '[]'::jsonb) as events
          from public.watch_alert a
          left join public.wa_group g on g.chat_id = a.chat_id
         where (case when p_open then a.status = 'open'
                     else a.status <> 'open' and a.closed_at > now() - interval '30 days' end)
           and (v_admin or exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid()))
         order by coalesce(a.closed_at, a.due_at) desc
         limit 200
      ) x), '[]'::jsonb);
end $$;

-- Alerts ringing for me right now (the alarm in the app).
create or replace function public.watch_ringing()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'title', a.title, 'detail', a.detail, 'priority', a.priority,
           'group', g.name, 'alerts_sent', a.alerts_sent, 'last_alert_at', a.last_alert_at)
           order by a.last_alert_at desc), '[]'::jsonb)
    from public.watch_alert a
    join public.watch_recipient r on r.alert_id = a.id and r.user_id = auth.uid()
    left join public.wa_group g on g.chat_id = a.chat_id
   where public.am_active() and a.status = 'open' and a.alerts_sent > 0
     and (a.snoozed_until is null or a.snoozed_until <= now());
$$;

create or replace function public.watch_alert_close(p_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._watch_can(p_id) then raise exception 'Not allowed'; end if;
  update public.watch_alert
     set status = 'handled', closed_at = now(), closed_by = auth.uid(),
         close_note = nullif(btrim(left(p_note, 300)), ''), next_alert_at = null, updated_at = now()
   where id = p_id and status = 'open';
  if not found then return; end if;
  update public.watch_recipient set next_call_at = null where alert_id = p_id;
  insert into public.watch_event (alert_id, what, detail, user_id) values (p_id, 'handled', nullif(btrim(left(p_note, 300)), ''), auth.uid());
  perform public._watch_quiet_notifications(p_id);
end $$;

-- Quiet for a while (alerts and calls), then it rings again.
create or replace function public.watch_alert_snooze(p_id uuid, p_minutes int)
returns void language plpgsql security definer set search_path = public as $$
declare v_until timestamptz := now() + make_interval(mins => greatest(1, least(p_minutes, 7 * 24 * 60)));
begin
  if not public._watch_can(p_id) then raise exception 'Not allowed'; end if;
  update public.watch_alert
     set snoozed_until = v_until, next_alert_at = greatest(coalesce(next_alert_at, v_until), v_until), updated_at = now()
   where id = p_id and status = 'open';
  if not found then return; end if;
  update public.watch_recipient set next_call_at = greatest(next_call_at, v_until) where alert_id = p_id and next_call_at is not null;
  insert into public.watch_event (alert_id, what, detail, user_id)
  values (p_id, 'snoozed', 'Until ' || to_char(v_until at time zone 'Africa/Cairo', 'Dy HH12:MI am'), auth.uid());
end $$;

create or replace function public.watch_alert_reopen(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.watch_alert
     set status = 'open', closed_at = null, closed_by = null, close_note = null, snoozed_until = null,
         next_alert_at = now(), updated_at = now()
   where id = p_id and status <> 'open';
  if not found then return; end if;
  insert into public.watch_event (alert_id, what, user_id) values (p_id, 'reopened', auth.uid());
end $$;

-- Admins: every number and switch (only the keys sent change).
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins') then
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  update public.watch_settings set
    enabled            = coalesce((p->>'enabled')::boolean, enabled),
    model              = coalesce(p->>'model', model),
    reply_wait_min     = coalesce((p->>'reply_wait_min')::int, reply_wait_min),
    promise_wait_min   = coalesce((p->>'promise_wait_min')::int, promise_wait_min),
    repeat_every_min   = coalesce((p->>'repeat_every_min')::int, repeat_every_min),
    alerts_before_call = coalesce((p->>'alerts_before_call')::int, alerts_before_call),
    calls_enabled      = coalesce((p->>'calls_enabled')::boolean, calls_enabled),
    call_retry_min     = coalesce((p->>'call_retry_min')::int, call_retry_min),
    call_every_min     = coalesce((p->>'call_every_min')::int, call_every_min),
    max_calls          = coalesce((p->>'max_calls')::int, max_calls),
    stop_after_hours   = coalesce((p->>'stop_after_hours')::int, stop_after_hours),
    quiet_from         = case when p ? 'quiet_from' then nullif(p->>'quiet_from', '')::time else quiet_from end,
    quiet_to           = case when p ? 'quiet_to' then nullif(p->>'quiet_to', '')::time else quiet_to end,
    call_language      = coalesce(p->>'call_language', call_language),
    cc_admins          = coalesce((p->>'cc_admins')::boolean, cc_admins),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
end $$;

-- Admins: the bot's groups, who is in each, and which of them are the team.
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
                           'wa_id', pt.wa_id, 'phone', pt.phone, 'name', pt.name, 'is_admin', pt.is_admin,
                           'user_id', u.id, 'user_name', u.display_name, 'avatar_url', u.avatar_url, 'user_active', u.is_active)
                           order by (u.id is null), coalesce(u.display_name, pt.name, pt.phone))
                    from public.wa_participant pt
                    left join public.profile u on u.id = public._wa_user(pt.phone)
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

create or replace function public.watch_group_set(p_chat text, p_monitored boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.wa_group set monitored = p_monitored where chat_id = p_chat;
  if not p_monitored then
    -- Its alerts stop with it.
    for v_id in select id from public.watch_alert where chat_id = p_chat and status = 'open' loop
      update public.watch_alert set status = 'stopped', closed_at = now(), closed_by = auth.uid(),
             close_note = 'The group is no longer watched', next_alert_at = null, updated_at = now()
       where id = v_id;
      update public.watch_recipient set next_call_at = null where alert_id = v_id;
      insert into public.watch_event (alert_id, what, detail, user_id) values (v_id, 'stopped', 'The group is no longer watched', auth.uid());
      perform public._watch_quiet_notifications(v_id);
    end loop;
  end if;
end $$;

-- Admins: this WhatsApp number is this team member (p_user null: not anyone).
create or replace function public.watch_link(p_phone text, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if v_phone !~ '^[1-9][0-9]{7,14}$' then raise exception 'That is not a WhatsApp number'; end if;
  if p_user is null then
    delete from public.wa_member where phone = v_phone;
  else
    if not exists (select 1 from public.profile where id = p_user) then raise exception 'No such member'; end if;
    insert into public.wa_member (phone, user_id) values (v_phone, p_user)
    on conflict (phone) do update set user_id = excluded.user_id;
  end if;
end $$;

-- Admins: the Twilio account calls go out from. Empty values remove it.
create or replace function public.watch_set_twilio(p_sid text, p_token text, p_from text)
returns void language plpgsql security definer set search_path = public as $$
declare v_from text := regexp_replace(coalesce(p_from, ''), '[^0-9+]', '', 'g');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if coalesce(btrim(p_sid), '') = '' and coalesce(btrim(p_token), '') = '' and v_from = '' then
    perform public._put_secret('twilio_sid', null);
    perform public._put_secret('twilio_token', null);
    perform public._put_secret('twilio_from', null);
    update public.watch_settings set calls_enabled = false where id = 1;
    return;
  end if;
  if btrim(p_sid) !~ '^AC[0-9a-f]{32}$' then raise exception 'The Account SID starts with AC and has 34 characters'; end if;
  if btrim(p_token) !~ '^[0-9a-f]{32}$' then raise exception 'The Auth token is the 32-character code under the Account SID'; end if;
  if v_from !~ '^\+?[1-9][0-9]{7,14}$' then raise exception 'The phone number should be your Twilio number with its country code'; end if;
  perform public._put_secret('twilio_sid', btrim(p_sid));
  perform public._put_secret('twilio_token', btrim(p_token));
  perform public._put_secret('twilio_from', '+' || ltrim(v_from, '+'));
end $$;

revoke all on function public.watch_overview(), public.watch_alerts(boolean), public.watch_ringing(),
  public.watch_alert_close(uuid, text), public.watch_alert_snooze(uuid, int), public.watch_alert_reopen(uuid),
  public.watch_settings_set(jsonb), public.watch_groups(), public.watch_group_set(text, boolean),
  public.watch_link(text, uuid), public.watch_set_twilio(text, text, text) from public, anon;
grant execute on function public.watch_overview(), public.watch_alerts(boolean), public.watch_ringing(),
  public.watch_alert_close(uuid, text), public.watch_alert_snooze(uuid, int), public.watch_alert_reopen(uuid),
  public.watch_settings_set(jsonb), public.watch_groups(), public.watch_group_set(text, boolean),
  public.watch_link(text, uuid), public.watch_set_twilio(text, text, text) to authenticated;

-- ---------------------------------------------------------------- the run --
-- Every minute: read quiet groups, ring due alerts, place calls.
create or replace function public._watch_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('watch_webhook_url');
  v_sec text := public._secret('watch_webhook_secret');
begin
  if v_url is null or v_sec is null then return; end if;
  if not exists (select 1 from public.watch_settings where id = 1 and enabled) then return; end if;
  perform net.http_post(
    url     := v_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public._watch_tick() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('watch-tick') where exists (select 1 from cron.job where jobname = 'watch-tick');
  perform cron.schedule('watch-tick', '* * * * *', 'select public._watch_tick()');
end $$;


-- ---------------------------------------------- notifications to channels --
-- Same as 0066, plus WhatsApp watch alerts: what it is, what it's about and
-- the group; they open the Alerts page; push goes to every device with one
-- notification per alert (tag watch-<id>) that stays on screen and rings again.
create or replace function public.on_notification_channels()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c      public.profile_contact;
  v_card text;
  v_brd  text;
  v_kind text;
  v_what text;
  v_link text;
  v_msg  text;
  v_text text;
  v_body text;
  v_app  text := (select rtrim(app_url, '/') from public.workspace limit 1);
  v_proj text := new.data->>'project';
  v_dlv  text := nullif(new.data->>'delivery', '');
begin
  select * into c from public.profile_contact where user_id = new.user_id;
  select title into v_card from public.card where id = new.card_id;
  select title, kind into v_brd, v_kind from public.board where id = new.board_id;
  v_what := case new.kind
    when 'mention'       then 'You were mentioned'
    when 'assigned'      then 'You were added to a card'
    when 'comment'       then 'New comment'
    when 'due_changed'   then 'Due date changed'
    when 'due_completed' then 'Marked complete'
    when 'board_invited' then case when v_kind = 'whiteboard' then 'You were added to a Miro board' else 'You were added to a Trello board' end
    when 'automation'    then coalesce(nullif(new.data->>'text', ''), 'Rule')
    when 'wb_mention'    then coalesce(new.data->>'by', 'Someone') || ' mentioned you'
                              || coalesce(' in ' || (new.data->>'doc_title'), '')
    when 'wb_reply'      then coalesce(new.data->>'by', 'Someone') || ' replied'
    when 'wb_guest_comment' then coalesce(new.data->>'by', 'A client') || ' commented'
    when 'brief_submitted'  then coalesce(nullif(new.data->>'label', ''), 'Someone') || ' sent their brief'
    when 'mail_shared'      then coalesce(new.data->>'by', 'Someone') || ' shared ' || coalesce(new.data->>'account_email', 'a Gmail account') || ' with you'
    when 'mail_thread_shared' then coalesce(new.data->>'by', 'Someone') || ' shared an email with you'
    when 'drive_shared'     then coalesce(new.data->>'by', 'Someone') || ' shared the Drive ' || coalesce(new.data->>'account_email', '') || ' with you'
    when 'drive_item_shared' then coalesce(new.data->>'by', 'Someone') || ' shared a '
                              || case when (new.data->>'folder')::boolean then 'folder' else 'file' end || ' with you'
    when 'meeting_shared'   then coalesce(new.data->>'by', 'Someone') || ' shared a meeting with you: ' || coalesce(new.data->>'title', '')
    when 'invoice_saved'    then 'New invoice: ' || coalesce(new.data->>'provider', 'Invoice')
                              || coalesce(' · ' || (new.data->>'amount') || coalesce(' ' || (new.data->>'currency'), ''), '')
    when 'refund_saved'     then 'New refund: ' || coalesce(new.data->>'provider', 'Refund')
                              || coalesce(' · ' || (new.data->>'amount') || coalesce(' ' || (new.data->>'currency'), ''), '')
    when 'invoice_needs_file' then 'Invoice to download: ' || coalesce(new.data->>'provider', 'Invoice')
    when 'project_added'    then 'You were added to the project ' || coalesce(v_proj, '')
                              || coalesce(' as ' || nullif(new.data->>'role', ''), '')
    when 'project_due_soon' then 'Due soon: ' || coalesce(v_dlv || ' · ', '') || coalesce(v_proj, '')
                              || coalesce(' (' || (new.data->>'when') || ')', '')
    when 'project_overdue'  then 'Late: ' || coalesce(v_dlv || ' · ', '') || coalesce(v_proj, '')
                              || coalesce(' (was due ' || (new.data->>'when') || ')', '')
    when 'project_due_changed' then case when (new.data->>'added')::boolean
                                      then 'New delivery on ' || coalesce(v_proj, '') || ': ' || coalesce(v_dlv, '')
                                      else 'New date for ' || coalesce(v_dlv || ' · ', '') || coalesce(v_proj, '') end
                              || coalesce(' (' || (new.data->>'when') || ')', '')
    when 'project_delivery_done' then coalesce(new.data->>'by', 'Someone') || ' delivered ' || coalesce(v_dlv, 'a delivery')
                              || ' on ' || coalesce(v_proj, '')
    when 'project_note'     then coalesce(new.data->>'by', 'Someone') || ' wrote a note on ' || coalesce(v_proj, 'a project')
    when 'project_file'     then coalesce(new.data->>'by', 'Someone') || ' uploaded '
                              || case when coalesce((new.data->>'count')::int, 1) > 1 then (new.data->>'count') || ' files'
                                      else coalesce(new.data->>'name', 'a file') end
                              || ' to ' || coalesce(v_proj, 'a project')
    when 'delivery_opened'  then coalesce(new.data->>'by', 'A client') || ' opened ' || coalesce(new.data->>'title', 'a delivery')
    when 'delivery_feedback' then coalesce(new.data->>'by', 'A client') || ' sent feedback on ' || coalesce(new.data->>'title', 'a delivery')
                              || coalesce(' (' || nullif(new.data->>'comments', '0') || ' comments)', '')
    when 'delivery_approved' then coalesce(new.data->>'by', 'A client') || ' approved ' || coalesce(new.data->>'title', 'a delivery')
    when 'watch_alert'      then coalesce(nullif(new.data->>'title', ''), 'Alert')
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared?tab=mail';
  elsif new.kind like 'drive\_%' then
    v_link := v_app || '/#/shared?tab=drive';
  elsif new.kind = 'meeting_shared' then
    v_link := v_app || '/#/meetings?m=' || (new.data->>'meeting_id');
  elsif new.kind = 'invoice_needs_file' then
    v_link := v_app || '/#/invoices?tab=files';
  elsif new.kind in ('invoice_saved', 'refund_saved') then
    v_link := v_app || '/#/invoices' || coalesce('?month=' || left(new.data->>'month', 7), '');
  elsif new.kind = 'watch_alert' then
    v_link := v_app || '/#/alerts?a=' || (new.data->>'alert_id');
  elsif new.kind like 'delivery\_%' then
    v_link := v_app || '/#/deliveries/' || (new.data->>'folder_id');
  elsif new.kind like 'project\_%' then
    v_link := v_app || '/#/projects/' || (new.data->>'project_id') || case when new.kind = 'project_file' then '?tab=files' else '' end;
  elsif v_kind = 'whiteboard' then
    v_link := v_app || '/#/wb/' || new.board_id
              || coalesce('?doc=' || (new.data->>'doc_id'), '?comment=' || (new.data->>'thread_id'), '');
  else
    v_link := v_app || '/#/pm/boards/' || new.board_id || coalesce('/cards/' || new.card_id, '');
  end if;
  v_text := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
            || coalesce(E'\n"' || nullif(new.data->>'excerpt', '') || '"', '');
  if new.kind = 'watch_alert' then
    v_text := v_what || coalesce(E'\n' || nullif(new.data->>'detail', ''), '') || coalesce(E'\n' || 'Group: ' || nullif(new.data->>'group', ''), '');
  end if;
  -- Email keeps the link to open it; WhatsApp (read on phones) has the words only.
  v_msg := v_text || coalesce(E'\n' || v_link, '');
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  if new.kind = 'watch_alert' then
    v_body := concat_ws(E'\n', nullif(new.data->>'detail', ''), nullif(new.data->>'group', ''));
  end if;
  begin
    if c.user_id is not null and c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'iklipse: ' || v_text); end if;
    if c.user_id is not null and c.notify_email then perform public._send_email(new.user_id, 'iklipse: ' || v_what, v_msg); end if;
    -- Shared mail, Drive, meetings, invoices and projects go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' or new.kind like 'project\_%' or new.kind like 'delivery\_%'
                                        or new.kind in ('invoice_saved', 'refund_saved', 'invoice_needs_file', 'meeting_shared', 'watch_alert') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link,
                              case when new.kind = 'watch_alert' then 'watch-' || (new.data->>'alert_id') else new.id::text end);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
