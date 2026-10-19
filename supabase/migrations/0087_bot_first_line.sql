-- ============================================================================
-- 0087_bot_first_line.sql
--   The bot as the team's first line on WhatsApp, part 2.
--   1. In the client groups an admin turns it on for, a client left without a
--      reply (an "unanswered" alert, once it's due) gets the bot's reply:
--      "Thanks Sara, we got your message and we'll get back to you shortly."
--      The alert rings as before; the bot's words never count as an answer.
--   2. Private chats with the bot are kept. When it's on, a message there gets
--      a reply the bot writes, sent only once the team says OK: the person in
--      Settings by WhatsApp, or anyone in the team group. They can OK it,
--      write the reply instead, or say no. Off topic, the bot says by itself
--      it only helps with work. The team's own private messages aren't
--      answered.
-- ============================================================================

-- --------------------------------------------------------- 1. groups --
alter table public.wa_group
  add column if not exists bot_replies boolean not null default false;   -- the bot answers clients here

alter table public.watch_alert
  add column if not exists held_at timestamptz;   -- the bot told them we'll get back to them

-- ------------------------------------------------------ 2. private chats --
create table if not exists public.wa_dm_chat (
  chat_id         text primary key,      -- "2010...@c.us"
  phone           text,
  name            text,                  -- their name on WhatsApp
  last_message_at timestamptz,
  pending_since   timestamptz,           -- new messages the bot hasn't read yet
  analyzed_at     timestamptz,
  sorry_at        timestamptz,           -- the last "I only help with work"
  last_error      text,
  created_at      timestamptz not null default now()
);

create table if not exists public.wa_dm (
  id          text primary key,
  chat_id     text not null references public.wa_dm_chat(chat_id) on delete cascade,
  from_bot    boolean not null default false,
  sender_name text,
  text        text,
  quoted_id   text,
  sent_at     timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists wa_dm_chat_idx on public.wa_dm (chat_id, sent_at desc);

-- A reply the bot wrote, waiting for the team's OK.
create table if not exists public.bot_draft (
  id         uuid primary key default gen_random_uuid(),
  chat_id    text not null,          -- where it goes
  to_name    text,
  asked      text not null,          -- what they wrote
  draft      text not null,
  status     text not null default 'waiting' check (status in ('waiting', 'sent', 'dropped', 'replaced', 'expired')),
  ask_ids    text[] not null default '{}',   -- the bot's messages asking for the OK (and reminding)
  ask_chat   text,                   -- where it asked
  times      int not null default 0,
  next_at    timestamptz,
  sent_text  text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bot_draft_wait_idx on public.bot_draft (status, next_at);
create index if not exists bot_draft_ask_idx on public.bot_draft using gin (ask_ids);

alter table public.wa_dm_chat enable row level security;
alter table public.wa_dm enable row level security;
alter table public.bot_draft enable row level security;
revoke all on public.wa_dm_chat, public.wa_dm, public.bot_draft from anon, authenticated;

-- ------------------------------------------------------------ settings --
alter table public.watch_settings
  add column if not exists dm_enabled boolean not null default false;   -- answer private messages, after an OK

-- As 0086, plus answering private messages (it needs somewhere to ask for the OK).
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
                 'ask_enabled', 'ask_to', 'ask_phone', 'ask_group', 'ask_every_min', 'dm_enabled') then
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
    dm_enabled            = coalesce((p->>'dm_enabled')::boolean, dm_enabled),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  -- Asking needs somewhere to ask.
  if exists (select 1 from public.watch_settings where id = 1 and (ask_enabled or dm_enabled)
               and ((ask_to = 'person' and ask_phone is null) or (ask_to = 'group' and ask_group is null))) then
    raise exception 'Say who the bot asks: a WhatsApp number, or a team group';
  end if;
end $$;

-- ------------------------------------------------------- groups for admins --
-- As 0086, plus whether the bot replies in each group.
create or replace function public.watch_groups()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'chat_id', g.chat_id, 'name', g.name, 'monitored', g.monitored, 'size', g.size,
               'left', g.left_at is not null, 'synced_at', g.synced_at, 'last_message_at', g.last_message_at,
               'analyzed_at', g.analyzed_at, 'last_error', g.last_error, 'kind', g.kind, 'bot_replies', g.bot_replies,
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

-- Admins: the bot replies to clients in this group (client groups only).
create or replace function public.watch_group_replies(p_chat text, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update public.wa_group set bot_replies = p_on and kind = 'client' where chat_id = p_chat;
  if not found then raise exception 'No such group'; end if;
end $$;
revoke all on function public.watch_group_replies(text, boolean) from public, anon;
grant execute on function public.watch_group_replies(text, boolean) to authenticated;

-- A team group never has the bot replying to clients.
update public.wa_group set bot_replies = false where kind = 'team';

notify pgrst, 'reload schema';
