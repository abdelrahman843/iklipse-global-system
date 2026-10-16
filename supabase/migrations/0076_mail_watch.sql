-- ============================================================================
-- 0076_mail_watch.sql
--   Email watch: the WhatsApp watch's alerts (0067), from each person's own
--   Gmail.
--
--   Everyone on the team turns on watching for the Gmail accounts they
--   connected (Alerts > Email). Every minute the whatsapp-bot function asks
--   Gmail what changed in those accounts; Claude reads each conversation that
--   did and, only when it is with a client (or someone new asking about work)
--   or an ad platform, opens an alert:
--     - unanswered: a client is waiting for a reply,
--     - promise:    the person promised something in a reply,
--     - follow_up:  a client said they'd send something,
--     - ads:        an ad platform needs something done (a rejected ad, a
--                   failed payment, a restricted account).
--   It rings only the owner of that mailbox, the same way (notifications,
--   then Ikli's calls) until it's handled, and closes by itself when the
--   conversation shows it was dealt with. Emails aren't kept: only which
--   conversations changed, and their subjects.
--   Admins set it in Alerts > Settings (watch_settings.mail_*).
-- ============================================================================

-- --------------------------------------------------------------- settings --
alter table public.watch_settings
  add column if not exists mail_enabled        boolean not null default false,
  add column if not exists mail_reply_wait_min int not null default 60 check (mail_reply_wait_min between 0 and 2880),
  add column if not exists mail_clients        boolean not null default true,   -- clients and people asking about work
  add column if not exists mail_ads            boolean not null default true,   -- ad platforms
  add column if not exists mail_senders        text[] not null default '{}';    -- more client addresses / @domains

-- ------------------------------------------------------------- mailboxes --
-- A Gmail account its owner turned on.
create table if not exists public.mail_watch (
  account_id uuid primary key references public.gmail_account(id) on delete cascade,
  user_id    uuid not null references public.profile(id) on delete cascade,
  history_id text,          -- Gmail's position: what changes after it is new (null: not read yet)
  started_at timestamptz not null default now(),
  checked_at timestamptz,
  last_error text
);
create index if not exists mail_watch_user_idx on public.mail_watch (user_id);

-- A conversation that changed in a watched mailbox: waiting for Claude
-- (pending_since), and what Claude made of it last time.
create table if not exists public.mail_thread (
  account_id    uuid not null references public.gmail_account(id) on delete cascade,
  thread_id     text not null,
  subject       text,
  verdict       text check (verdict in ('client', 'ads', 'other')),
  pending_since timestamptz,
  seen_at       timestamptz,   -- the last change Gmail reported
  analyzed_at   timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  primary key (account_id, thread_id)
);
create index if not exists mail_thread_pending_idx on public.mail_thread (pending_since) where pending_since is not null;

-- Read and written by the whatsapp-bot function (service role) and the functions below.
alter table public.mail_watch  enable row level security;
alter table public.mail_thread enable row level security;
revoke all on public.mail_watch, public.mail_thread from anon, authenticated;

-- ----------------------------------------------------------------- alerts --
alter table public.watch_alert
  add column if not exists source       text not null default 'whatsapp' check (source in ('whatsapp', 'email')),
  add column if not exists mail_account uuid references public.gmail_account(id) on delete cascade,
  add column if not exists mail_thread  text,
  add column if not exists mail_subject text,
  add column if not exists mail_from    text;
alter table public.watch_alert drop constraint if exists watch_alert_kind_check;
alter table public.watch_alert add constraint watch_alert_kind_check check (kind in ('unanswered', 'promise', 'follow_up', 'ads'));
create index if not exists watch_alert_mail_idx on public.watch_alert (mail_account, mail_thread, status) where mail_account is not null;

-- ------------------------------------------------------------ for the app --
-- A mailbox's open alerts stop with it.
create or replace function public._mail_stop(p_account uuid, p_note text, p_by uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  for v_id in select id from public.watch_alert where mail_account = p_account and status = 'open' loop
    update public.watch_alert set status = 'stopped', closed_at = now(), closed_by = p_by, close_note = p_note,
           next_alert_at = null, updated_at = now()
     where id = v_id;
    update public.watch_recipient set next_call_at = null where alert_id = v_id;
    insert into public.watch_event (alert_id, what, detail, user_id) values (v_id, 'stopped', p_note, p_by);
    perform public._watch_quiet_notifications(v_id);
  end loop;
end $$;
revoke all on function public._mail_stop(uuid, text, uuid) from public, anon, authenticated;

-- Watch one of my Gmail accounts, or stop. Admins can stop anyone's (only the
-- owner turns it on: Claude reads their mail).
create or replace function public.mail_watch_set(p_account uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare a public.gmail_account;
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  select * into a from public.gmail_account where id = p_account;
  if a.id is null then raise exception 'That Gmail account isn''t connected'; end if;
  if p_on then
    if a.user_id <> auth.uid() then raise exception 'Only the owner of % can turn watching on', a.email; end if;
    insert into public.mail_watch (account_id, user_id) values (a.id, a.user_id) on conflict (account_id) do nothing;
  else
    if a.user_id <> auth.uid() and not public.is_admin() then raise exception 'That Gmail account isn''t yours'; end if;
    delete from public.mail_watch where account_id = a.id;
    delete from public.mail_thread where account_id = a.id;
    perform public._mail_stop(a.id, case when a.user_id = auth.uid() then 'The email is no longer watched'
                                         else 'An admin stopped watching this email' end, auth.uid());
  end if;
end $$;

-- Admins: everyone on the team, their Gmail accounts and which are watched.
create or replace function public.mail_watch_people()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.display_name, 'avatar_url', p.avatar_url, 'active', p.is_active,
             'accounts', coalesce((
                select jsonb_agg(jsonb_build_object(
                         'account_id', g.id, 'email', g.email, 'watching', w.account_id is not null,
                         'checked_at', w.checked_at, 'last_error', w.last_error,
                         'open_alerts', (select count(*) from public.watch_alert a where a.mail_account = g.id and a.status = 'open'))
                         order by g.connected_at)
                  from public.gmail_account g
                  left join public.mail_watch w on w.account_id = g.id
                 where g.user_id = p.id), '[]'::jsonb))
           order by p.display_name)
      from public.profile p
     where p.is_active), '[]'::jsonb);
end $$;

revoke all on function public.mail_watch_set(uuid, boolean), public.mail_watch_people() from public, anon;
grant execute on function public.mail_watch_set(uuid, boolean), public.mail_watch_people() to authenticated;

-- The page's header: as 0071, plus my Gmail accounts (watched or not) and,
-- for admins, how many are watched.
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
    'my_mail', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', g.id, 'email', g.email, 'watching', w.account_id is not null,
               'checked_at', w.checked_at, 'last_error', w.last_error)
               order by g.connected_at)
        from public.gmail_account g
        left join public.mail_watch w on w.account_id = g.id
       where g.user_id = auth.uid()), '[]'::jsonb),
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
    'mail', case when v_admin then jsonb_build_object(
      'watched', (select count(*) from public.mail_watch),
      'people', (select count(distinct user_id) from public.mail_watch)) end);
end $$;

-- Open alerts (p_open) or the last 30 days of closed ones I can see; email
-- ones say which mailbox and conversation (mine: I can open it in Mail).
create or replace function public.watch_alerts(p_open boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := public.is_admin();
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  return coalesce((
    select jsonb_agg(x order by x.sort_at desc)
      from (
        select a.id, a.kind, a.source, a.title, a.detail, a.person, a.priority, a.status, a.due_at, a.next_alert_at,
               a.alerts_sent, a.last_alert_at, a.calls_made, a.snoozed_until, a.closed_at, a.close_note, a.created_at,
               coalesce(a.closed_at, a.due_at) as sort_at,
               (select display_name from public.profile where id = a.closed_by) as closed_by_name,
               jsonb_build_object('chat_id', g.chat_id, 'name', g.name) as "group",
               case when a.source = 'email' then jsonb_build_object(
                 'account_id', a.mail_account, 'email', ga.email, 'thread_id', a.mail_thread,
                 'subject', a.mail_subject, 'from', a.mail_from, 'mine', ga.user_id = auth.uid()) end as mail,
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
          left join public.gmail_account ga on ga.id = a.mail_account
         where (case when p_open then a.status = 'open'
                     else a.status <> 'open' and a.closed_at > now() - interval '30 days' end)
           and (v_admin or exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid()))
         order by coalesce(a.closed_at, a.due_at) desc
         limit 200
      ) x), '[]'::jsonb);
end $$;

-- Alerts ringing for me right now (the alarm in the app). "group": the
-- WhatsApp group, or the email's subject.
create or replace function public.watch_ringing()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'source', a.source, 'title', a.title, 'detail', a.detail, 'priority', a.priority,
           'group', coalesce(g.name, a.mail_subject), 'alerts_sent', a.alerts_sent, 'last_alert_at', a.last_alert_at)
           order by a.last_alert_at desc), '[]'::jsonb)
    from public.watch_alert a
    join public.watch_recipient r on r.alert_id = a.id and r.user_id = auth.uid()
    left join public.wa_group g on g.chat_id = a.chat_id
   where public.am_active() and a.status = 'open' and a.alerts_sent > 0
     and (a.snoozed_until is null or a.snoozed_until <= now());
$$;

-- Admins: every number and switch (only the keys sent change), email's too.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins',
                 'mail_enabled', 'mail_reply_wait_min', 'mail_clients', 'mail_ads', 'mail_senders') then
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if p ? 'mail_senders' then
    if jsonb_typeof(p->'mail_senders') <> 'array' then raise exception 'The senders are a list'; end if;
    v_senders := public._gmail_senders(array(select jsonb_array_elements_text(p->'mail_senders')));
    if cardinality(v_senders) > 100 then raise exception 'Up to 100 senders'; end if;
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
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
end $$;

-- The run every minute: WhatsApp or email (either on).
create or replace function public._watch_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('watch_webhook_url');
  v_sec text := public._secret('watch_webhook_secret');
begin
  if v_url is null or v_sec is null then return; end if;
  if not exists (select 1 from public.watch_settings where id = 1 and (enabled or mail_enabled)) then return; end if;
  perform net.http_post(
    url     := v_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public._watch_tick() from public, anon, authenticated;

-- Turning email watching on or off is in the activity log (0073).
drop trigger if exists zz_audit on public.mail_watch;
create trigger zz_audit after insert or delete on public.mail_watch
  for each row execute function public._audit('alerts', 'email watch');

-- Ikli calling me: as 0071; "group" is the WhatsApp group or the email's subject.
create or replace function public.watch_my_call()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', c.id, 'alert_id', c.alert_id, 'started_at', c.started_at,
           'title', coalesce(a.title, 'Test call'), 'detail', a.detail, 'group', coalesce(g.name, a.mail_subject), 'priority', a.priority,
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

-- The Android app's buttons on a call: as 0071, same "group".
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
                                 'title', coalesce(a.title, 'Test call'), 'group', coalesce(g.name, a.mail_subject))
    into r
    from public.watch_call w
    left join public.watch_alert a on a.id = w.alert_id
    left join public.wa_group g on g.chat_id = a.chat_id
   where w.id = p_call;
  return r;
end $$;

revoke all on function public._watch_call_act(uuid, text) from public, anon, authenticated;
grant execute on function public._watch_call_act(uuid, text) to service_role;

-- ---------------------------------------------- notifications to channels --
-- Same as 0067; an email alert names its subject ("Email: ...") where a
-- WhatsApp one names its group.
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
    v_text := v_what || coalesce(E'\n' || nullif(new.data->>'detail', ''), '') || coalesce(E'\n' || case when new.data->>'source' = 'email' then 'Email: ' else 'Group: ' end
                                   || nullif(new.data->>'group', ''), '');
  end if;
  -- Email keeps the link to open it; WhatsApp (read on phones) has the words only.
  v_msg := v_text || coalesce(E'\n' || v_link, '');
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  if new.kind = 'watch_alert' then
    v_body := concat_ws(E'\n', nullif(new.data->>'detail', ''),
                        case when new.data->>'source' = 'email' then 'Email: ' else '' end || nullif(new.data->>'group', ''));
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

-- ------------------------------------------------------------ activity log --
-- As 0074, plus Gmail accounts by their address.
create or replace function public.audit_log_page(
  p_before timestamptz default null,
  p_area   text default null,
  p_actor  uuid default null,
  p_q      text default null,
  p_limit  int default 100,
  p_action text default null,
  p_entity text default null,
  p_from   timestamptz default null,
  p_to     timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q      text := nullif(btrim(coalesce(p_q, '')), '');
  v_area   text := nullif(btrim(coalesce(p_area, '')), '');
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
  v_entity text := nullif(btrim(coalesce(p_entity, '')), '');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    with page as (
      select l.id, l.at, l.actor_id, coalesce(pr.display_name, l.actor_name) as actor_name, pr.avatar_url as actor_avatar,
             l.action, l.area, l.entity, l.row_id, l.label, l.ref, l.changes
        from public.audit_log l
        left join public.profile pr on pr.id = l.actor_id
       where (p_before is null or l.at < p_before)
         and (p_from is null or l.at >= p_from)
         and (p_to is null or l.at < p_to)
         and (v_area is null or l.area = v_area)
         and (p_actor is null or l.actor_id = p_actor)
         and (v_action is null or l.action = v_action)
         and (v_entity is null or l.entity = v_entity)
         and (v_q is null or l.label ilike '%' || v_q || '%' or l.ref::text ilike '%' || v_q || '%'
              or l.actor_name ilike '%' || v_q || '%' or l.entity ilike '%' || v_q || '%')
       order by l.at desc, l.id desc
       limit least(greatest(coalesce(p_limit, 100), 1), 300)
    ),
    -- The ids each row uses: in what changed, in ref, and its own id (a joined
    -- id like "<board>:<card>" counts each part).
    used as (
      select distinct p.id, u.s
        from page p
        cross join lateral (
          select x.s from public._audit_uuids(p.changes) as x(s)
          union all
          select x.s from public._audit_uuids(p.ref) as x(s)
          union all
          select x.s from public._audit_uuids(to_jsonb(string_to_array(p.row_id, ':'))) as x(s)
        ) u
    ),
    -- Each id of the page once.
    ids as (
      select distinct u.s::uuid as id from used u
    ),
    -- Looked up once, by primary key; the first table that has it wins.
    known as (
      select distinct on (f.id) f.id::text as s, f.name
        from (
          select 1 as o, t.id, t.display_name as name from public.profile t where t.id in (select id from ids)
          union all select 2, t.id, t.title from public.board t where t.id in (select id from ids)
          union all select 3, t.id, t.title from public.list t where t.id in (select id from ids)
          union all select 4, t.id, t.title from public.card t where t.id in (select id from ids)
          union all select 5, t.id, t.name from public.label t where t.id in (select id from ids)
          union all select 6, t.id, t.name from public.checklist t where t.id in (select id from ids)
          union all select 7, t.id, t.title from public.project t where t.id in (select id from ids)
          union all select 8, t.id, t.name from public.client t where t.id in (select id from ids)
          union all select 9, t.id, t.title from public.project_delivery t where t.id in (select id from ids)
          union all select 10, t.id, t.title from public.delivery_folder t where t.id in (select id from ids)
          union all select 11, t.id, t.name from public.delivery_item t where t.id in (select id from ids)
          union all select 12, t.id, t.name from public.attachment t where t.id in (select id from ids)
          union all select 13, t.id, t.name from public.custom_field_def t where t.id in (select id from ids)
          union all select 14, t.id, t.name from public.automation_rule t where t.id in (select id from ids)
          union all select 15, t.id, left(t.body, 80) from public.comment t where t.id in (select id from ids)
          union all select 16, t.id, left(t.text, 80) from public.checklist_item t where t.id in (select id from ids)
          union all select 17, t.id, left(t.body, 80) from public.delivery_comment t where t.id in (select id from ids)
          union all select 18, t.id, 'Round ' || t.number from public.delivery_round t where t.id in (select id from ids)
          union all select 19, t.id, coalesce(t.label, 'Link') from public.delivery_link t where t.id in (select id from ids)
          union all select 20, t.id, left(t.body, 80) from public.project_note t where t.id in (select id from ids)
          union all select 21, t.id, t.name from public.project_file t where t.id in (select id from ids)
          union all select 22, t.id, coalesce('No. ' || t.number, 'Invoice') from public.project_invoice t where t.id in (select id from ids)
          union all select 23, t.id, t.title from public.watch_alert t where t.id in (select id from ids)
          union all select 24, t.id, coalesce(t.label, 'Brief') from public.brief_link t where t.id in (select id from ids)
          union all select 25, t.id, coalesce(t.label, 'Share link') from public.wb_share_link t where t.id in (select id from ids)
          union all select 26, t.id, left(t.body, 80) from public.wb_comment t where t.id in (select id from ids)
          union all select 27, t.id, coalesce(t.subject, 'Invoice') from public.invoice t where t.id in (select id from ids)
          union all select 28, t.id, t.email from public.gmail_account t where t.id in (select id from ids)
        ) f
       order by f.id, f.o
    ),
    -- Per row, only the ids it uses.
    named as (
      select u.id, jsonb_object_agg(f.s, f.name) as names
        from used u
        join known f on f.s = u.s
       group by u.id
    )
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'at', p.at, 'actor_id', p.actor_id, 'actor_name', p.actor_name, 'actor_avatar', p.actor_avatar,
             'action', p.action, 'area', p.area, 'entity', p.entity, 'row_id', p.row_id, 'label', p.label,
             'ref', p.ref, 'changes', p.changes, 'names', coalesce(n.names, '{}'::jsonb))
           order by p.at desc, p.id desc)
      from page p
      left join named n on n.id = p.id), '[]'::jsonb);
end $$;

revoke all on function public.audit_log_page(timestamptz, text, uuid, text, int, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.audit_log_page(timestamptz, text, uuid, text, int, text, text, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
