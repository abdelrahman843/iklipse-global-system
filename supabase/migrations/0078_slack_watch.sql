-- ============================================================================
-- 0078_slack_watch.sql
--   Slack watch: the WhatsApp watch (0067), in Slack channels.
--
--   An admin makes the iklipse Slack app from the manifest on Alerts > Slack;
--   its bot token and signing secret go in the vault. The app is invited to
--   client channels, and Slack sends every message in them to the
--   whatsapp-bot function (/slack, signed). Only the channels an admin turned
--   on keep them (30 days); a channel starts off. Claude reads a channel once
--   it goes quiet, the same way as a WhatsApp group: a client left without a
--   reply, a promise, a follow-up. The same alarm and calls, to the team
--   members in that channel.
--   Admins say who on Slack is who on the team, channel by channel like the
--   groups; someone whose email is a team member's is linked by themselves.
-- ============================================================================

-- --------------------------------------------------------------- settings --
alter table public.watch_settings
  add column if not exists slack_enabled   boolean not null default false,
  add column if not exists slack_team      text,         -- the workspace's name
  add column if not exists slack_team_id   text,
  add column if not exists slack_url       text,         -- https://name.slack.com/
  add column if not exists slack_bot_user  text,         -- the app's own Slack user
  add column if not exists slack_state     text,         -- 'ok', or what's wrong (last check)
  add column if not exists slack_hook_at   timestamptz,  -- last event from Slack
  add column if not exists slack_synced_at timestamptz;  -- last full read of the channels

-- --------------------------------------------------------------- channels --
create table if not exists public.slack_channel (
  channel_id      text primary key check (channel_id ~ '^[CG][A-Z0-9]{6,}$'),
  name            text,
  is_private      boolean not null default false,
  is_shared       boolean not null default false,   -- Slack Connect: with another company
  monitored       boolean not null default false,   -- an admin turns each one on
  size            int,
  left_at         timestamptz,       -- the app is no longer in it
  synced_at       timestamptz,       -- who is in it, last read
  last_message_at timestamptz,
  pending_since   timestamptz,       -- new messages Claude hasn't read yet
  analyzed_at     timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

-- Who Slack says someone is: names, and the email that can link them to the team.
create table if not exists public.slack_user (
  slack_id   text primary key,
  name       text,
  real_name  text,
  email      text,
  avatar     text,
  is_bot     boolean not null default false,
  external   boolean not null default false,   -- another company's (Slack Connect)
  guest      boolean not null default false,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists slack_user_email_idx on public.slack_user (lower(email)) where email is not null;

create table if not exists public.slack_participant (
  channel_id text not null references public.slack_channel(channel_id) on delete cascade,
  slack_id   text not null,
  primary key (channel_id, slack_id)
);
create index if not exists slack_participant_user_idx on public.slack_participant (slack_id);

-- A Slack person an admin said is someone on the team (user_id null: nobody,
-- even when their email matches).
create table if not exists public.slack_member (
  slack_id   text primary key check (slack_id ~ '^[UW][A-Z0-9]{6,}$'),
  user_id    uuid references public.profile(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists slack_member_user_idx on public.slack_member (user_id);

create table if not exists public.slack_message (
  channel_id text not null references public.slack_channel(channel_id) on delete cascade,
  ts         text not null,          -- Slack's id for the message
  slack_id   text,                   -- who wrote it
  thread_ts  text,                   -- the thread it's in (its first message)
  text       text,
  sent_at    timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (channel_id, ts)
);
create index if not exists slack_message_chat_idx on public.slack_message (channel_id, sent_at desc);
create index if not exists slack_message_created_idx on public.slack_message (channel_id, created_at);

-- Read and written by the whatsapp-bot function (service role) and the functions below.
alter table public.slack_channel     enable row level security;
alter table public.slack_user        enable row level security;
alter table public.slack_participant enable row level security;
alter table public.slack_member      enable row level security;
alter table public.slack_message     enable row level security;
revoke all on public.slack_channel, public.slack_user, public.slack_participant, public.slack_member, public.slack_message
  from anon, authenticated;

-- ----------------------------------------------------------------- alerts --
alter table public.watch_alert drop constraint if exists watch_alert_source_check;
alter table public.watch_alert add constraint watch_alert_source_check check (source in ('whatsapp', 'email', 'slack'));
alter table public.watch_alert
  add column if not exists channel_id text references public.slack_channel(channel_id) on delete cascade;
create index if not exists watch_alert_slack_idx on public.watch_alert (channel_id, status) where channel_id is not null;

-- -------------------------------------------------------------- helpers --
-- The team member a Slack person is: an admin's link (even "nobody"), else the
-- one with their email (member card, or a connected Gmail).
create or replace function public._slack_user(p_slack text)
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.slack_member where slack_id = p_slack)
      then (select user_id from public.slack_member where slack_id = p_slack)
    else coalesce(
      (select c.user_id from public.slack_user u
         join public.profile_contact c on lower(c.email) = lower(u.email)
        where u.slack_id = p_slack and u.email is not null limit 1),
      (select g.user_id from public.slack_user u
         join public.gmail_account g on lower(g.email) = lower(u.email)
        where u.slack_id = p_slack and u.email is not null
        order by g.connected_at limit 1))
  end;
$$;
revoke all on function public._slack_user(text) from public, anon, authenticated;

-- For the whatsapp-bot function: every Slack person who is someone on the team.
create or replace function public._slack_links()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(x.slack_id, x.user_id), '{}'::jsonb)
    from (select s.slack_id, public._slack_user(s.slack_id) as user_id
            from (select slack_id from public.slack_user union select slack_id from public.slack_member) s) x
   where x.user_id is not null;
$$;
revoke all on function public._slack_links() from public, anon, authenticated;
grant execute on function public._slack_links() to service_role;

-- A channel's (or all of Slack's) open alerts stop.
create or replace function public._slack_stop(p_channel text, p_note text, p_by uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  for v_id in select id from public.watch_alert
               where source = 'slack' and status = 'open' and (p_channel is null or channel_id = p_channel) loop
    update public.watch_alert set status = 'stopped', closed_at = now(), closed_by = p_by, close_note = p_note,
           next_alert_at = null, updated_at = now()
     where id = v_id;
    update public.watch_recipient set next_call_at = null where alert_id = v_id;
    insert into public.watch_event (alert_id, what, detail, user_id) values (v_id, 'stopped', p_note, p_by);
    perform public._watch_quiet_notifications(v_id);
  end loop;
end $$;
revoke all on function public._slack_stop(text, text, uuid) from public, anon, authenticated;

-- Green API and Slack, for the whatsapp-bot function only (as 0068, plus Slack).
create or replace function public._watch_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'greenapi_url', public._secret('greenapi_url'),
    'greenapi_instance', public._secret('greenapi_instance'),
    'greenapi_token', public._secret('greenapi_token'),
    'slack_bot_token', public._secret('slack_bot_token'),
    'slack_signing_secret', public._secret('slack_signing_secret'),
    'app_url', (select rtrim(app_url, '/') from public.workspace limit 1));
end $$;
revoke all on function public._watch_config() from public, anon, authenticated;
grant execute on function public._watch_config() to service_role;

-- ------------------------------------------------------------ for the app --
-- Admins: the Slack app's bot token and signing secret. Both empty remove
-- Slack: watching stops, its open alerts stop and its messages go.
create or replace function public.admin_set_slack(p_token text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if coalesce(btrim(p_token), '') = '' and coalesce(btrim(p_secret), '') = '' then
    perform public._put_secret('slack_bot_token', null);
    perform public._put_secret('slack_signing_secret', null);
    update public.watch_settings
       set slack_enabled = false, slack_team = null, slack_team_id = null, slack_url = null, slack_bot_user = null,
           slack_state = null, slack_hook_at = null, slack_synced_at = null, updated_at = now(), updated_by = auth.uid()
     where id = 1;
    perform public._slack_stop(null, 'Slack was removed', auth.uid());
    delete from public.slack_message;
    update public.slack_channel set pending_since = null;
    return;
  end if;
  if btrim(p_token) !~ '^xoxb-[A-Za-z0-9-]{20,250}$' then
    raise exception 'The bot token starts with xoxb- (OAuth & Permissions, Bot User OAuth Token)';
  end if;
  if btrim(p_secret) !~ '^[0-9a-f]{32}$' then
    raise exception 'The signing secret is the 32-character code under Basic Information, App Credentials';
  end if;
  perform public._put_secret('slack_bot_token', btrim(p_token));
  perform public._put_secret('slack_signing_secret', btrim(p_secret));
  update public.watch_settings set slack_state = null, updated_at = now(), updated_by = auth.uid() where id = 1;
end $$;

-- Admins: the channels the app is in, who is in each, and which of them are the team.
create or replace function public.watch_slack()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_bot text := (select slack_bot_user from public.watch_settings where id = 1);
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'channel_id', c.channel_id, 'name', c.name, 'is_private', c.is_private, 'is_shared', c.is_shared,
               'monitored', c.monitored, 'size', c.size, 'left', c.left_at is not null, 'synced_at', c.synced_at,
               'last_message_at', c.last_message_at, 'analyzed_at', c.analyzed_at, 'last_error', c.last_error,
               'open_alerts', (select count(*) from public.watch_alert a where a.channel_id = c.channel_id and a.status = 'open'),
               'participants', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'slack_id', x.slack_id, 'name', coalesce(nullif(su.name, ''), su.real_name), 'real_name', su.real_name,
                           'email', su.email, 'avatar', su.avatar, 'is_bot', coalesce(su.is_bot, false),
                           'is_app', x.slack_id = v_bot, 'external', coalesce(su.external, false), 'guest', coalesce(su.guest, false),
                           'user_id', u.id, 'user_name', u.display_name, 'avatar_url', u.avatar_url, 'user_active', u.is_active,
                           'by_email', u.id is not null and not exists (select 1 from public.slack_member m where m.slack_id = x.slack_id))
                           order by (x.slack_id = v_bot), coalesce(su.is_bot, false), (u.id is null),
                                    coalesce(u.display_name, su.name, su.real_name, x.slack_id))
                    from (select pt.slack_id, public._slack_user(pt.slack_id) as uid
                            from public.slack_participant pt where pt.channel_id = c.channel_id) x
                    left join public.slack_user su on su.slack_id = x.slack_id
                    left join public.profile u on u.id = x.uid
                   where not coalesce(su.deleted, false)), '[]'::jsonb))
             order by (c.left_at is not null), c.monitored desc, c.last_message_at desc nulls last, c.name)
        from public.slack_channel c), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'avatar_url', p.avatar_url, 'active', p.is_active)
                       order by p.is_active desc, p.display_name)
        from public.profile p), '[]'::jsonb));
end $$;

-- Admins: watch a channel, or stop (its open alerts stop with it).
create or replace function public.watch_slack_set(p_channel text, p_monitored boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.slack_channel set monitored = p_monitored,
         pending_since = case when p_monitored then pending_since end
   where channel_id = p_channel;
  if not found then raise exception 'That channel isn''t in the list'; end if;
  if not p_monitored then perform public._slack_stop(p_channel, 'The channel is no longer watched', auth.uid()); end if;
end $$;

-- Admins: this Slack person is this team member (p_user null: not anyone on
-- the team, even if their email matches).
create or replace function public.watch_slack_link(p_slack text, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if coalesce(p_slack, '') !~ '^[UW][A-Z0-9]{6,}$' then raise exception 'That is not a Slack person'; end if;
  if p_user is not null and not exists (select 1 from public.profile where id = p_user) then raise exception 'No such member'; end if;
  insert into public.slack_member (slack_id, user_id) values (p_slack, p_user)
  on conflict (slack_id) do update set user_id = excluded.user_id;
end $$;

revoke all on function public.admin_set_slack(text, text), public.watch_slack(), public.watch_slack_set(text, boolean),
  public.watch_slack_link(text, uuid) from public, anon;
grant execute on function public.admin_set_slack(text, text), public.watch_slack(), public.watch_slack_set(text, boolean),
  public.watch_slack_link(text, uuid) to authenticated;

-- The page's header: as 0076, plus the Slack app (admins). Its state isn't a setting.
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
    'settings', case when v_admin then to_jsonb(s) - 'id' - 'tick_lock' - 'bot_state' - 'bot_phone' - 'hook_at' - 'synced_at'
                                       - 'slack_team' - 'slack_team_id' - 'slack_url' - 'slack_bot_user' - 'slack_state'
                                       - 'slack_hook_at' - 'slack_synced_at' end,
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
      'people', (select count(distinct user_id) from public.mail_watch)) end,
    'slack', case when v_admin then jsonb_build_object(
      'configured', public._secret('slack_bot_token') is not null and public._secret('slack_signing_secret') is not null,
      'team', s.slack_team,
      'url', s.slack_url,
      'state', s.slack_state,
      'hook_at', s.slack_hook_at,
      'synced_at', s.slack_synced_at,
      'channels', (select count(*) from public.slack_channel where left_at is null),
      'monitored', (select count(*) from public.slack_channel where left_at is null and monitored)) end);
end $$;

-- Open alerts (p_open) or the last 30 days of closed ones I can see: as 0076,
-- and Slack ones say their channel, with a link to the message in Slack.
create or replace function public.watch_alerts(p_open boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin();
  v_slack text := (select slack_url from public.watch_settings where id = 1);
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
               case when a.source = 'slack' then jsonb_build_object(
                 'channel_id', a.channel_id, 'name', sc.name,
                 'url', case when v_slack is not null and a.channel_id is not null then
                          v_slack || 'archives/' || a.channel_id || coalesce('/p' || replace(a.message_id, '.', ''), '')
                          || case when sm.thread_ts is not null and sm.thread_ts <> sm.ts
                                  then '?thread_ts=' || sm.thread_ts || '&cid=' || a.channel_id else '' end
                        end) end as slack,
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
          left join public.slack_channel sc on sc.channel_id = a.channel_id
          left join public.slack_message sm on sm.channel_id = a.channel_id and sm.ts = a.message_id
         where (case when p_open then a.status = 'open'
                     else a.status <> 'open' and a.closed_at > now() - interval '30 days' end)
           and (v_admin or exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid()))
         order by coalesce(a.closed_at, a.due_at) desc
         limit 200
      ) x), '[]'::jsonb);
end $$;

-- Alerts ringing for me right now (the alarm in the app). "group": the
-- WhatsApp group, "#channel", or the email's subject.
create or replace function public.watch_ringing()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'source', a.source, 'title', a.title, 'detail', a.detail, 'priority', a.priority,
           'group', coalesce(g.name, '#' || sc.name, a.mail_subject), 'alerts_sent', a.alerts_sent, 'last_alert_at', a.last_alert_at)
           order by a.last_alert_at desc), '[]'::jsonb)
    from public.watch_alert a
    join public.watch_recipient r on r.alert_id = a.id and r.user_id = auth.uid()
    left join public.wa_group g on g.chat_id = a.chat_id
    left join public.slack_channel sc on sc.channel_id = a.channel_id
   where public.am_active() and a.status = 'open' and a.alerts_sent > 0
     and (a.snoozed_until is null or a.snoozed_until <= now());
$$;

-- Admins: every number and switch (only the keys sent change): as 0076, plus Slack's.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins',
                 'mail_enabled', 'mail_reply_wait_min', 'mail_clients', 'mail_ads', 'mail_senders',
                 'slack_enabled') then
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
    slack_enabled       = coalesce((p->>'slack_enabled')::boolean, slack_enabled),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
end $$;

-- The run every minute: WhatsApp, email or Slack (any of them on).
create or replace function public._watch_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('watch_webhook_url');
  v_sec text := public._secret('watch_webhook_secret');
begin
  if v_url is null or v_sec is null then return; end if;
  if not exists (select 1 from public.watch_settings where id = 1 and (enabled or mail_enabled or slack_enabled)) then return; end if;
  perform net.http_post(
    url     := v_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public._watch_tick() from public, anon, authenticated;

-- Ikli calling me: as 0076; "group" is the WhatsApp group, "#channel" or the email's subject.
create or replace function public.watch_my_call()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', c.id, 'alert_id', c.alert_id, 'started_at', c.started_at,
           'title', coalesce(a.title, 'Test call'), 'detail', a.detail, 'group', coalesce(g.name, '#' || sc.name, a.mail_subject), 'priority', a.priority,
           'words', c.words, 'audio', c.audio)
    from public.watch_call c
    left join public.watch_alert a on a.id = c.alert_id
    left join public.wa_group g on g.chat_id = a.chat_id
    left join public.slack_channel sc on sc.channel_id = a.channel_id
   where public.am_active() and c.user_id = auth.uid() and c.status in ('ringing', 'missed')
     and c.started_at > now() - interval '3 minutes'
     and (c.alert_id is null or a.status = 'open')
   order by c.started_at desc
   limit 1;
$$;

-- The Android app's buttons on a call: as 0076, same "group".
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
                                 'title', coalesce(a.title, 'Test call'), 'group', coalesce(g.name, '#' || sc.name, a.mail_subject))
    into r
    from public.watch_call w
    left join public.watch_alert a on a.id = w.alert_id
    left join public.wa_group g on g.chat_id = a.chat_id
    left join public.slack_channel sc on sc.channel_id = a.channel_id
   where w.id = p_call;
  return r;
end $$;

revoke all on function public._watch_call_act(uuid, text) from public, anon, authenticated;
grant execute on function public._watch_call_act(uuid, text) to service_role;

-- ---------------------------------------------- notifications to channels --
-- Same as 0076; a Slack alert names its channel ("Slack: #channel").
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
    v_text := v_what || coalesce(E'\n' || nullif(new.data->>'detail', ''), '') || coalesce(E'\n' || case new.data->>'source' when 'email' then 'Email: ' when 'slack' then 'Slack: ' else 'Group: ' end
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

notify pgrst, 'reload schema';
