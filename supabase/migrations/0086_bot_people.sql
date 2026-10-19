-- ============================================================================
-- 0086_bot_people.sql
--   The people in the bot's WhatsApp groups (the bot as the team's first line,
--   part 1).
--   1. Each group is a client group or a team group. A team group is ours: the
--      bot asks there (and later posts alerts and takes orders there); nobody
--      in it is a client and Claude doesn't read it for alerts. A client group
--      can be tied to a project.
--   2. Everyone in a client group who isn't on the team is a client: the bot
--      adds them to Clients by itself (their name on WhatsApp and their
--      number) and asks for what's missing (a name, the number WhatsApp hides,
--      the email) from one person by WhatsApp or in a team group, again every
--      so often until it's all there. Filled in on the Projects page, or told
--      "skip", it stops. Told the person is on the team, it links their number
--      to that member instead.
--   3. The settings for it (off until an admin turns it on).
--   4. The team's numbers and emails at a glance, for the Users page.
--   Group and Slack messages are now kept for good (the bot stopped deleting
--   them after 30 days).
-- ============================================================================

-- ------------------------------------------------------------- 1. groups --
alter table public.wa_group
  add column if not exists kind       text not null default 'client' check (kind in ('client', 'team')),
  add column if not exists project_id uuid references public.project(id) on delete set null,
  add column if not exists people_at  timestamptz;   -- its people last checked against Clients

-- ------------------------------------------------------------ 2. clients --
-- A number as WhatsApp writes it: digits with the country code ("01001234567",
-- an Egyptian number written the local way, is "201001234567").
create or replace function public._phone_key(p text)
returns text language sql immutable set search_path = public as $$
  select case
    when d = '' then null
    when d ~ '^00' then nullif(substr(d, 3), '')
    when d ~ '^0[0-9]{10}$' then '20' || substr(d, 2)
    else d end
    from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

alter table public.client
  add column if not exists wa_lid     text check (wa_lid ~ '^[0-9]{6,20}@lid$'),   -- WhatsApp hides their number
  add column if not exists name_known boolean not null default true,                -- false: named after their number
  add column if not exists from_chat  text references public.wa_group(chat_id) on delete set null,  -- the bot found them there
  add column if not exists ask_skip   boolean not null default false;               -- don't ask about them
create index if not exists client_phone_key_idx on public.client (public._phone_key(phone));
create unique index if not exists client_lid_uq on public.client (wa_lid) where wa_lid is not null;

-- What the bot still needs to know about a client (asked until it's there).
create table if not exists public.bot_ask (
  client_id  uuid primary key references public.client(id) on delete cascade,
  chat_id    text references public.wa_group(chat_id) on delete set null,   -- where they are
  times      int not null default 0,
  next_at    timestamptz not null default now(),
  last_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bot_ask_next_idx on public.bot_ask (next_at);

-- The bot's messages asking: a reply to one answers the people in it, by their numbers in it.
create table if not exists public.bot_ask_message (
  id      text primary key,           -- the WhatsApp message
  chat_id text not null,              -- where it went
  clients uuid[] not null,            -- 1, 2, 3... in it
  sent_at timestamptz not null default now()
);
create index if not exists bot_ask_message_chat_idx on public.bot_ask_message (chat_id, sent_at desc);

-- Messages the bot already acted on (WhatsApp can send one again).
create table if not exists public.bot_heard (
  id text primary key,
  at timestamptz not null default now()
);

alter table public.bot_ask enable row level security;
alter table public.bot_ask_message enable row level security;
alter table public.bot_heard enable row level security;
revoke all on public.bot_ask, public.bot_ask_message, public.bot_heard from anon, authenticated;

-- As 0073; whoever saves a client from the app has named them.
create or replace function public.client_save(p_id uuid, p_name text, p_company text, p_email text, p_phone text, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.is_admin() and (p_id is null or not exists (
       select 1 from public.project p where p.client_id = p_id and public.can_see_project(p.id))) then
    raise exception 'Admins only';
  end if;
  if p_id is null then
    insert into public.client (name, company, email, phone, notes, created_by)
    values (btrim(p_name), nullif(btrim(p_company), ''), nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''),
            nullif(btrim(p_notes), ''), auth.uid())
    returning id into v_id;
  else
    update public.client
       set name = btrim(p_name), company = nullif(btrim(p_company), ''), email = nullif(btrim(p_email), ''),
           phone = nullif(btrim(p_phone), ''), notes = nullif(btrim(p_notes), ''), name_known = true, updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Client not found'; end if;
  end if;
  return v_id;
end $$;

-- ----------------------------------------------------------- 3. settings --
alter table public.watch_settings
  add column if not exists ask_enabled   boolean not null default false,
  add column if not exists ask_to        text not null default 'person' check (ask_to in ('person', 'group')),
  add column if not exists ask_phone     text check (ask_phone ~ '^[1-9][0-9]{7,14}$'),
  add column if not exists ask_group     text references public.wa_group(chat_id) on delete set null,
  add column if not exists ask_every_min int not null default 60 check (ask_every_min between 5 and 1440);

-- As 0085, plus who the bot asks for clients' details, and how often.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[]; v_days int[]; v_dates date[]; v_phone text; v_group text;
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
                 'ask_enabled', 'ask_to', 'ask_phone', 'ask_group', 'ask_every_min') then
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
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  -- Asking needs somewhere to ask.
  if exists (select 1 from public.watch_settings where id = 1 and ask_enabled
               and ((ask_to = 'person' and ask_phone is null) or (ask_to = 'group' and ask_group is null))) then
    raise exception 'Say who the bot asks: a WhatsApp number, or a team group';
  end if;
end $$;

-- ------------------------------------------------------- groups for admins --
-- A client in a group: by their number, else by the WhatsApp id of a hidden number.
create or replace function public._wa_client(p_phone text, p_lid text)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.client where p_phone is not null and public._phone_key(phone) = p_phone order by created_at limit 1),
    (select id from public.client where p_lid is not null and wa_lid = p_lid limit 1));
$$;
revoke all on function public._wa_client(text, text) from public, anon, authenticated;
grant execute on function public._wa_client(text, text) to service_role;

-- As 0080, plus each group's kind and project, each client's details as
-- Clients has them (and what the bot still asks), and the open projects.
create or replace function public.watch_groups()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'chat_id', g.chat_id, 'name', g.name, 'monitored', g.monitored, 'size', g.size,
               'left', g.left_at is not null, 'synced_at', g.synced_at, 'last_message_at', g.last_message_at,
               'analyzed_at', g.analyzed_at, 'last_error', g.last_error, 'kind', g.kind,
               'project', (select jsonb_build_object('id', pj.id, 'title', pj.title) from public.project pj where pj.id = g.project_id),
               'open_alerts', (select count(*) from public.watch_alert a where a.chat_id = g.chat_id and a.status = 'open'),
               'participants', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'wa_id', pt.wa_id, 'phone', pt.phone, 'lid', pt.lid, 'name', pt.name, 'is_admin', pt.is_admin,
                           'user_id', u.id, 'user_name', u.display_name, 'avatar_url', u.avatar_url, 'user_active', u.is_active,
                           'is_bot', pt.phone is not null and pt.phone = (select bot_phone from public.watch_settings where id = 1),
                           'client', case when u.id is null then (
                              select jsonb_build_object('id', c.id, 'name', c.name, 'name_known', c.name_known, 'email', c.email,
                                                        'phone', c.phone, 'company', c.company, 'skip', c.ask_skip,
                                                        'asked', (select k.times from public.bot_ask k where k.client_id = c.id))
                                from public.client c
                               where c.id = public._wa_client(pt.phone, coalesce(pt.lid, case when pt.wa_id like '%@lid' then pt.wa_id end)))
                           end)
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
        from public.profile p), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', pj.id, 'title', pj.title,
                                          'client', (select c.name from public.client c where c.id = pj.client_id))
                       order by lower(pj.title))
        from public.project pj where pj.status in ('active', 'on_hold')), '[]'::jsonb));
end $$;

-- Admins: a client group or a team group, and the project a client group is for.
-- A team group isn't read for alerts: its open alerts stop.
create or replace function public.watch_group_edit(p_chat text, p_kind text, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_kind not in ('client', 'team') then raise exception 'A group is a client group or a team group'; end if;
  if p_project is not null and not exists (select 1 from public.project where id = p_project) then raise exception 'No such project'; end if;
  update public.wa_group
     set kind = p_kind,
         project_id = case when p_kind = 'team' then null else p_project end,
         pending_since = case when p_kind = 'team' then null else pending_since end,
         people_at = null
   where chat_id = p_chat;
  if not found then raise exception 'No such group'; end if;
  if p_kind = 'team' then
    for v_id in select id from public.watch_alert where chat_id = p_chat and status = 'open' loop
      update public.watch_alert set status = 'stopped', closed_at = now(), closed_by = auth.uid(),
             close_note = 'It is a team group now', next_alert_at = null, updated_at = now()
       where id = v_id;
      update public.watch_recipient set next_call_at = null where alert_id = v_id;
      insert into public.watch_event (alert_id, what, detail, user_id) values (v_id, 'stopped', 'It is a team group now', auth.uid());
      perform public._watch_quiet_notifications(v_id);
    end loop;
    -- Nobody in it is asked about as a client.
    delete from public.bot_ask where chat_id = p_chat;
  else
    update public.watch_settings set ask_group = null where id = 1 and ask_group = p_chat;
    update public.watch_settings set ask_enabled = false where id = 1 and ask_to = 'group' and ask_group is null;
  end if;
end $$;
revoke all on function public.watch_group_edit(text, text, uuid) from public, anon;
grant execute on function public.watch_group_edit(text, text, uuid) to authenticated;

-- ------------------------------------------------------ 4. the team's contacts --
-- Admins: everyone's WhatsApp number and email, so the missing ones can be filled in.
create or replace function public.team_contacts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', p.id, 'name', p.display_name, 'username', p.username, 'avatar_url', p.avatar_url,
             'active', p.is_active,
             'whatsapp', c.whatsapp, 'email', c.email,
             'notify_whatsapp', coalesce(c.notify_whatsapp, false), 'notify_email', coalesce(c.notify_email, false),
             'linked', (select coalesce(jsonb_agg(m.phone order by m.created_at), '[]'::jsonb) from public.wa_member m where m.user_id = p.id))
           order by lower(p.display_name))
      from public.profile p
      left join public.profile_contact c on c.user_id = p.id), '[]'::jsonb);
end $$;
revoke all on function public.team_contacts() from public, anon;
grant execute on function public.team_contacts() to authenticated;

notify pgrst, 'reload schema';
