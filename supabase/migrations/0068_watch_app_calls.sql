-- ============================================================================
-- 0068_watch_app_calls.sql
--   WhatsApp watch calls happen inside iklipse, not over phone lines (no
--   Twilio). When nobody acts on an alert, Ikli "calls" each person on it:
--     - the app open: a full-screen incoming call that rings until they answer
--       or decline (WatchCall),
--     - the app closed: a push notification "Ikli is calling you" that stays on
--       screen, again every minute or so while it rings / is missed.
--   Answering plays what Ikli says (written by Claude, in the voice agent's
--   ElevenLabs voice); then Handled / Snooze. A call nobody answers within a
--   minute is missed and rings again after call_retry_min; an answered one,
--   while the alert is still open, after call_every_min.
-- ============================================================================

-- ------------------------------------------------------------------ calls --
alter table public.watch_call drop constraint if exists watch_call_status_check;
update public.watch_call set status = 'failed' where status = 'calling';
update public.watch_call set status = 'missed' where status in ('no_answer', 'busy');
alter table public.watch_call
  alter column phone drop not null,
  alter column status set default 'ringing',
  add column if not exists words text,               -- what Ikli says
  add column if not exists answered_at timestamptz,
  add constraint watch_call_status_check check (status in ('ringing', 'answered', 'declined', 'missed', 'failed'));
alter table public.watch_call drop column if exists sid;
alter table public.watch_call drop column if exists pressed;
alter table public.watch_call drop column if exists seconds;
create index if not exists watch_call_ringing_idx on public.watch_call (user_id) where status = 'ringing';

-- What a call says: only the person called can play it.
drop policy if exists watch_audio_read on storage.objects;
create policy watch_audio_read on storage.objects for select to authenticated
  using (bucket_id = 'watch-audio'
         and exists (select 1 from public.watch_call c where c.audio = storage.objects.name and c.user_id = auth.uid()));

-- ------------------------------------------------------------ no Twilio --
drop function if exists public.watch_set_twilio(text, text, text);
drop function if exists public._watch_phone(uuid);
select public._put_secret('twilio_sid', null), public._put_secret('twilio_token', null), public._put_secret('twilio_from', null);

create or replace function public._watch_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'greenapi_url', public._secret('greenapi_url'),
    'greenapi_instance', public._secret('greenapi_instance'),
    'greenapi_token', public._secret('greenapi_token'),
    'app_url', (select rtrim(app_url, '/') from public.workspace limit 1));
end $$;
revoke all on function public._watch_config() from public, anon, authenticated;
grant execute on function public._watch_config() to service_role;

-- The whatsapp-bot function rings phones through the same push as notifications.
grant execute on function public._send_push(uuid, text, text, text, text, text) to service_role;

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

-- ------------------------------------------------------------ for the app --
-- My call ringing now (the newest), with what it's about. A call missed in the
-- last few minutes still shows, for someone who opens the app from its push.
create or replace function public.watch_my_call()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', c.id, 'alert_id', c.alert_id, 'started_at', c.started_at,
           'title', coalesce(a.title, 'Test call'), 'detail', a.detail, 'group', g.name, 'priority', a.priority)
    from public.watch_call c
    left join public.watch_alert a on a.id = c.alert_id
    left join public.wa_group g on g.chat_id = a.chat_id
   where public.am_active() and c.user_id = auth.uid() and c.status in ('ringing', 'missed')
     and c.started_at > now() - interval '3 minutes'
     and (c.alert_id is null or a.status = 'open')
   order by c.started_at desc
   limit 1;
$$;

-- Picked up: what Ikli says (words, and the audio to play). Rings again later
-- while the alert is still open.
create or replace function public.watch_call_answer(p_call uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.watch_call; v_every int := (select call_every_min from public.watch_settings where id = 1);
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  update public.watch_call set status = 'answered', answered_at = now()
   where id = p_call and user_id = auth.uid() and status in ('ringing', 'missed')
  returning * into c;
  if c.id is null then
    select * into c from public.watch_call where id = p_call and user_id = auth.uid();
    if c.id is null then raise exception 'This call is over'; end if;
    return jsonb_build_object('words', c.words, 'audio', c.audio);
  end if;
  if c.alert_id is not null then
    update public.watch_recipient r
       set calling = false, answered = r.answered + 1,
           next_call_at = case when a.status = 'open' then now() + make_interval(mins => v_every) end
      from public.watch_alert a
     where r.alert_id = c.alert_id and r.user_id = auth.uid() and a.id = r.alert_id;
    insert into public.watch_event (alert_id, what, detail, user_id)
    values (c.alert_id, 'answered', (select display_name from public.profile where id = auth.uid()) || ' answered Ikli''s call', auth.uid());
  end if;
  return jsonb_build_object('words', c.words, 'audio', c.audio);
end $$;

-- Declined: rings again soon (call_retry_min).
create or replace function public.watch_call_decline(p_call uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c public.watch_call; v_retry int := (select call_retry_min from public.watch_settings where id = 1);
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  update public.watch_call set status = 'declined', ended_at = now()
   where id = p_call and user_id = auth.uid() and status = 'ringing'
  returning * into c;
  if c.id is null or c.alert_id is null then return; end if;
  update public.watch_recipient r
     set calling = false,
         next_call_at = case when a.status = 'open' then now() + make_interval(mins => v_retry) end
    from public.watch_alert a
   where r.alert_id = c.alert_id and r.user_id = auth.uid() and a.id = r.alert_id;
  insert into public.watch_event (alert_id, what, detail, user_id)
  values (c.alert_id, 'declined', (select display_name from public.profile where id = auth.uid()) || ' declined the call', auth.uid());
end $$;

-- Hung up after listening.
create or replace function public.watch_call_end(p_call uuid)
returns void language sql security definer set search_path = public as $$
  update public.watch_call set ended_at = now()
   where id = p_call and user_id = auth.uid() and ended_at is null and public.am_active();
$$;

revoke all on function public.watch_overview(), public.watch_my_call(), public.watch_call_answer(uuid),
  public.watch_call_decline(uuid), public.watch_call_end(uuid) from public, anon;
grant execute on function public.watch_overview(), public.watch_my_call(), public.watch_call_answer(uuid),
  public.watch_call_decline(uuid), public.watch_call_end(uuid) to authenticated;
