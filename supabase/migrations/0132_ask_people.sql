-- 0132_ask_people.sql
--   Who the bot asks (clients' missing details, OKs for replies to clients'
--   private messages): people on the team, each in their private chat, and a
--   team group, any mix of them, instead of one number typed in or one group.
--   Every one of them gets the question; whoever answers first, it counts.
--   ask_phones (what the bot reads) follows ask_people by itself: one number
--   each, the first linked to them (wa_member), else the one on their card
--   (profile_contact.whatsapp); someone with neither isn't asked.
--   ask_to and ask_phone are no longer read.
--   bot_draft.ask_chats: every chat a question went to (ask_chat: the first).

alter table public.watch_settings add column if not exists ask_people uuid[] not null default '{}';
alter table public.watch_settings add column if not exists ask_phones text[] not null default '{}';
alter table public.bot_draft add column if not exists ask_chats text[] not null default '{}';

update public.bot_draft set ask_chats = array[ask_chat] where ask_chat is not null and ask_chats = '{}';

-- The number the bot writes to someone on.
create or replace function public._ask_phone_of(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select x.phone
    from (
      select m.phone, 0 as rank, m.created_at from public.wa_member m where m.user_id = p_user
      union all
      select regexp_replace(c.whatsapp, '\D', '', 'g'), 1, null from public.profile_contact c
       where c.user_id = p_user and coalesce(c.whatsapp, '') <> ''
    ) x
   where x.phone ~ '^[1-9][0-9]{7,14}$'
   order by x.rank, x.created_at
   limit 1
$$;
revoke all on function public._ask_phone_of(uuid) from public, anon, authenticated;

-- ask_phones follows ask_people, in the same order.
create or replace function public._watch_ask_phones_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.ask_phones := coalesce((
    select array_agg(x.phone order by x.n)
      from (select public._ask_phone_of(u.id) as phone, u.n from unnest(new.ask_people) with ordinality as u(id, n)) x
     where x.phone is not null), '{}');
  return new;
end $$;
revoke all on function public._watch_ask_phones_sync() from public, anon, authenticated;
drop trigger if exists ask_phones_sync on public.watch_settings;
create trigger ask_phones_sync before insert or update on public.watch_settings
  for each row execute function public._watch_ask_phones_sync();

-- ...and their numbers changing elsewhere (Users page, Alerts > Groups).
create or replace function public._watch_ask_phones_refresh()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.watch_settings set ask_phones = ask_phones where id = 1;
  return null;
end $$;
revoke all on function public._watch_ask_phones_refresh() from public, anon, authenticated;
drop trigger if exists watch_ask_phones on public.wa_member;
create trigger watch_ask_phones after insert or update or delete on public.wa_member
  for each statement execute function public._watch_ask_phones_refresh();
drop trigger if exists watch_ask_phones on public.profile_contact;
create trigger watch_ask_phones after insert or update of whatsapp or delete on public.profile_contact
  for each statement execute function public._watch_ask_phones_refresh();

-- Today's choice: the person whose number it was (a group only when the group was picked).
update public.watch_settings s
   set ask_people = coalesce((
         select array_agg(distinct u.user_id)
           from (
             select m.user_id from public.wa_member m where m.phone = s.ask_phone
             union
             select c.user_id from public.profile_contact c where regexp_replace(c.whatsapp, '\D', '', 'g') = s.ask_phone
           ) u
           join public.profile pr on pr.id = u.user_id and pr.is_active and pr.role in ('admin', 'member')
       ), '{}'),
       ask_group = case when s.ask_to = 'group' then s.ask_group end
 where s.id = 1 and s.ask_people = '{}';

-- --------------------------------------------------------------- settings --
-- As 0108, with ask_people in place of ask_to and ask_phone.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[]; v_days int[]; v_dates date[]; v_people uuid[]; v_group text; v_link uuid; v_alerts text;
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
                 'ask_enabled', 'ask_people', 'ask_group', 'ask_every_min', 'dm_enabled', 'book_link_account', 'meet_tell',
                 'orders_enabled', 'order_every_min', 'order_client_max', 'alert_group', 'read_files',
                 'model_fast', 'model_main', 'model_agent') then
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if (p ? 'model_fast' and p->>'model_fast' not in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'))
     or (p ? 'model_main' and p->>'model_main' not in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5')) then
    raise exception 'Pick Haiku, Sonnet or Opus';
  end if;
  if p ? 'model_agent' and p->>'model_agent' not in ('claude-sonnet-5-5', 'claude-opus-5-5') then
    raise exception 'Tasks run on Sonnet or Opus';
  end if;
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
  if p ? 'ask_people' then
    if jsonb_typeof(p->'ask_people') <> 'array' then raise exception 'The people are a list'; end if;
    -- In the order picked, people on the team only (no guests, nobody who left).
    select coalesce(array_agg(pr.id order by x.n), '{}') into v_people
      from jsonb_array_elements_text(p->'ask_people') with ordinality as x(v, n)
      join public.profile pr on pr.id::text = x.v and pr.is_active and pr.role in ('admin', 'member');
    if cardinality(v_people) > 20 then raise exception 'Up to 20 people'; end if;
  end if;
  if p ? 'ask_group' then
    v_group := nullif(p->>'ask_group', '');
    if v_group is not null and not exists (select 1 from public.wa_group where chat_id = v_group and kind = 'team') then
      raise exception 'Pick one of the team groups';
    end if;
  end if;
  if p ? 'alert_group' then
    v_alerts := nullif(p->>'alert_group', '');
    if v_alerts is not null and not exists (select 1 from public.wa_group where chat_id = v_alerts and kind = 'team') then
      raise exception 'Pick one of the team groups for the alerts';
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
    model_fast            = coalesce(p->>'model_fast', model_fast),
    model_main            = coalesce(p->>'model_main', model_main),
    model_agent           = coalesce(p->>'model_agent', model_agent),
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
    ask_people            = case when p ? 'ask_people' then v_people else ask_people end,
    ask_group             = case when p ? 'ask_group' then v_group else ask_group end,
    ask_every_min         = coalesce((p->>'ask_every_min')::int, ask_every_min),
    dm_enabled            = coalesce((p->>'dm_enabled')::boolean, dm_enabled),
    book_link_account     = case when p ? 'book_link_account' then v_link else book_link_account end,
    meet_tell             = coalesce((p->>'meet_tell')::boolean, meet_tell),
    orders_enabled        = coalesce((p->>'orders_enabled')::boolean, orders_enabled),
    order_every_min       = coalesce((p->>'order_every_min')::int, order_every_min),
    order_client_max      = coalesce((p->>'order_client_max')::int, order_client_max),
    alert_group           = case when p ? 'alert_group' then v_alerts else alert_group end,
    read_files            = coalesce((p->>'read_files')::boolean, read_files),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  -- Asking needs somewhere to ask.
  if exists (select 1 from public.watch_settings where id = 1 and (ask_enabled or dm_enabled)
               and cardinality(ask_phones) = 0 and ask_group is null) then
    raise exception 'Say who the bot asks: someone on the team with a WhatsApp number, a team group, or both';
  end if;
end $$;

-- ----------------------------------------------------------------- groups --
-- As 0086: a group that stops being a team group stops being asked.
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
    update public.watch_settings set ask_enabled = false where id = 1 and ask_group is null and cardinality(ask_phones) = 0;
  end if;
end $$;
revoke all on function public.watch_group_edit(text, text, uuid) from public, anon;
grant execute on function public.watch_group_edit(text, text, uuid) to authenticated;

-- ------------------------------------------------------ the team's contacts --
-- As 0086, plus each one's role (who the bot asks is picked from the team, not guests).
create or replace function public.team_contacts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', p.id, 'name', p.display_name, 'username', p.username, 'avatar_url', p.avatar_url,
             'active', p.is_active, 'role', p.role,
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
