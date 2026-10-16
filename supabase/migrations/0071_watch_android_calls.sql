-- ============================================================================
-- 0071: Ikli's calls on the iklipse Android app.
--
-- A web app can only show a notification. The Android app (android/) rings
-- like a phone call: full screen over the lock screen, the ringtone until it's
-- answered or declined. A phone links to a person once, with a code from
-- Alerts > My phone, and gets Ikli's calls through Firebase (the whatsapp-bot
-- function sends them). Its buttons act on the call with the call's signed
-- link, like Decline on the web notification (0068).
-- ============================================================================

create table if not exists public.native_device (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profile(id) on delete cascade,
  token        text not null unique,              -- Firebase (FCM) registration token
  key_hash     text not null,                     -- sha256 of the key the app keeps (lets it check in)
  device       text,                              -- "Samsung SM-A546E · Android 14"
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists native_device_user_idx on public.native_device (user_id);
alter table public.native_device enable row level security;
-- No policies: read through native_devices(), written by the whatsapp-bot function.

create table if not exists public.native_pair (
  code       text primary key,
  user_id    uuid not null references public.profile(id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
alter table public.native_pair enable row level security;

-- A code that links my phone (10 minutes, once).
create or replace function public.native_pair_start()
returns text language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  delete from public.native_pair where created_at < now() - interval '1 day';
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + get_byte(x.b, i) % 32, 1), '' order by i)
    into v_code
    from (select extensions.gen_random_bytes(8) as b) x, generate_series(0, 7) i;
  insert into public.native_pair (code, user_id) values (v_code, auth.uid());
  return v_code;
end $$;

-- My linked phones.
create or replace function public.native_devices()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'device', device, 'app_version', app_version, 'created_at', created_at, 'last_seen_at', last_seen_at)
           order by created_at desc), '[]'::jsonb)
    from public.native_device
   where user_id = auth.uid() and public.am_active();
$$;

create or replace function public.native_device_remove(p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.native_device where id = p_id and user_id = auth.uid();
$$;

revoke all on function public.native_pair_start(), public.native_devices(), public.native_device_remove(uuid) from public, anon;
grant execute on function public.native_pair_start(), public.native_devices(), public.native_device_remove(uuid) to authenticated;

-- Signed out everywhere, or turned off: their phones stop getting calls.
create or replace function public._native_device_signout()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sessions_revoked_at is distinct from old.sessions_revoked_at or (old.is_active and not new.is_active) then
    delete from public.native_device where user_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists native_device_signout on public.profile;
create trigger native_device_signout after update of sessions_revoked_at, is_active on public.profile
  for each row execute function public._native_device_signout();

-- The app's buttons on a call. It has no login: the whatsapp-bot function
-- checks the call's signature, then this acts as the person called, through
-- the same functions the web app uses.
create or replace function public._watch_call_act(p_call uuid, p_act text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.watch_call; r jsonb := '{}'::jsonb;
begin
  select * into c from public.watch_call where id = p_call;
  if c.id is null then raise exception 'This call is over'; end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', c.user_id, 'role', 'authenticated', 'iat', extract(epoch from now()))::text, true);
  perform set_config('request.jwt.claim.sub', c.user_id::text, true);
  case p_act
    when 'answer' then r := public.watch_call_answer(p_call);
    when 'decline' then perform public.watch_call_decline(p_call);
    when 'end' then perform public.watch_call_end(p_call);
    when 'handled' then
      if c.alert_id is not null then perform public.watch_alert_close(c.alert_id, null); end if;
      perform public.watch_call_end(p_call);
    when 'snooze' then
      if c.alert_id is not null then perform public.watch_alert_snooze(c.alert_id, 15); end if;
      perform public.watch_call_end(p_call);
    when 'state' then r := jsonb_build_object('words', c.words, 'audio', c.audio); -- ready before it's answered
    else raise exception 'Unknown action';
  end case;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  select r || jsonb_build_object('status', w.status, 'open', coalesce(a.status = 'open', false),
                                 'title', coalesce(a.title, 'Test call'), 'group', g.name)
    into r
    from public.watch_call w
    left join public.watch_alert a on a.id = w.alert_id
    left join public.wa_group g on g.chat_id = a.chat_id
   where w.id = p_call;
  return r;
end $$;
revoke all on function public._watch_call_act(uuid, text) from public, anon, authenticated;
grant execute on function public._watch_call_act(uuid, text) to service_role;

-- Alerts > My phone: is a phone linked (it rings like a call).
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
    -- Calls reach a phone that's closed only as push notifications.
    'my_push', exists (select 1 from public.push_subscription where user_id = auth.uid()),
    'my_phone', exists (select 1 from public.native_device where user_id = auth.uid()),
    'settings', case when v_admin then to_jsonb(s) - 'id' - 'tick_lock' - 'bot_state' - 'bot_phone' - 'hook_at' - 'synced_at' end,
    'bot', case when v_admin then jsonb_build_object(
      'configured', public._secret('greenapi_instance') is not null and public._secret('greenapi_token') is not null,
      'instance', public._secret('greenapi_instance'),
      'state', s.bot_state,
      'phone', s.bot_phone,
      'hook_at', s.hook_at,
      'synced_at', s.synced_at,
      'groups', (select count(*) from public.wa_group where left_at is null),
      'monitored', (select count(*) from public.wa_group where left_at is null and monitored)) end);
end $$;

-- Answered but still open: ring again as soon as a minute later.
alter table public.watch_settings drop constraint if exists watch_settings_call_every_min_check;
alter table public.watch_settings add constraint watch_settings_call_every_min_check check (call_every_min between 1 and 1440);

-- My call, with what Ikli says and its voice: the app fetches them while it
-- rings, so Ikli speaks the moment it's answered.
create or replace function public.watch_my_call()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', c.id, 'alert_id', c.alert_id, 'started_at', c.started_at,
           'title', coalesce(a.title, 'Test call'), 'detail', a.detail, 'group', g.name, 'priority', a.priority,
           'words', c.words, 'audio', c.audio)
    from public.watch_call c
    left join public.watch_alert a on a.id = c.alert_id
    left join public.wa_group g on g.chat_id = a.chat_id
   where public.am_active() and c.user_id = auth.uid() and c.status in ('ringing', 'missed')
     and c.started_at > now() - interval '3 minutes'
     and (c.alert_id is null or a.status = 'open')
   order by c.started_at desc
   limit 1;
$$;
