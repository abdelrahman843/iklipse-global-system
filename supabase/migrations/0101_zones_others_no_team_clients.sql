-- 0101: people's time zones, people who are neither team nor clients, and
-- the team never in Clients.
--
-- 1. Time zones. A client's (client.timezone) and a team member's
--    (profile_contact.timezone), IANA names ("Asia/Dubai"). The bot works one
--    out from the number's country when the country has one time zone, and
--    asks (the client, or whoever on the team is booking) when it can't. What
--    it's told is kept here; it can be set on the client too.
-- 2. Not clients (wa_other): freelancers, partners, anyone in the groups who
--    isn't on the team (no iklipse account) and isn't a client. Set in Alerts >
--    Groups (who someone is). The bot never puts them in Clients. Everyone in
--    a team group who isn't linked to the team starts there.
-- 3. Nobody on the team (a number linked in Alerts > Groups, a member card's
--    WhatsApp, a hidden-number link) or in "not clients" is in Clients: linking
--    them later takes them out at once, and a client can't be given their
--    number.

-- ------------------------------------------------------------ 1. zones --
alter table public.client add column if not exists timezone text;
alter table public.profile_contact add column if not exists timezone text;

create or replace function public._zone_ok(z text)
returns boolean language sql stable set search_path = public as $$
  select z is null or exists (select 1 from pg_timezone_names where name = z);
$$;

-- --------------------------------------------------------- 2. not clients --
create table if not exists public.wa_other (
  id         uuid primary key default gen_random_uuid(),
  phone      text unique check (phone ~ '^[1-9][0-9]{7,14}$'),
  wa_lid     text unique check (wa_lid ~ '^[0-9]{6,20}@lid$'),
  name       text,
  note       text,
  created_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  check (phone is not null or wa_lid is not null)
);
alter table public.wa_other enable row level security;
revoke all on public.wa_other from anon, authenticated;

drop trigger if exists live_ins on public.wa_other;
drop trigger if exists live_upd on public.wa_other;
drop trigger if exists live_del on public.wa_other;
create trigger live_ins after insert on public.wa_other referencing new table as new_rows for each statement execute function public._live_ping();
create trigger live_upd after update on public.wa_other referencing new table as new_rows for each statement execute function public._live_ping();
create trigger live_del after delete on public.wa_other referencing old table as old_rows for each statement execute function public._live_ping();

-- ------------------------------------------------------ 3. never clients --
-- Out of Clients (and, for the team, out of "not clients"): this number or hidden-number id.
create or replace function public._not_client(p_phone text, p_lid text, p_team boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.client c
   where (p_phone is not null and public._phone_key(c.phone) = p_phone)
      or (p_lid is not null and c.wa_lid = p_lid);
  if p_team then
    delete from public.wa_other o where (p_phone is not null and o.phone = p_phone) or (p_lid is not null and o.wa_lid = p_lid);
  end if;
end $$;
revoke all on function public._not_client(text, text, boolean) from public, anon, authenticated;

create or replace function public._not_client_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'wa_member' then
    perform public._not_client(new.phone, null, true);
  elsif tg_table_name = 'wa_member_lid' then
    perform public._not_client(null, new.lid, true);
  elsif tg_table_name = 'profile_contact' then
    if new.whatsapp is not null then perform public._not_client(new.whatsapp, null, true); end if;
  elsif tg_table_name = 'wa_other' then
    perform public._not_client(new.phone, new.wa_lid, false);
  end if;
  return null;
end $$;

drop trigger if exists not_client on public.wa_member;
drop trigger if exists not_client on public.wa_member_lid;
drop trigger if exists not_client on public.profile_contact;
drop trigger if exists not_client on public.wa_other;
create trigger not_client after insert or update on public.wa_member for each row execute function public._not_client_trg();
create trigger not_client after insert or update on public.wa_member_lid for each row execute function public._not_client_trg();
create trigger not_client after insert or update of whatsapp on public.profile_contact for each row execute function public._not_client_trg();
create trigger not_client after insert or update on public.wa_other for each row execute function public._not_client_trg();

-- A client can't be given a number that's the team's or someone's who isn't a client.
create or replace function public._client_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v text := public._phone_key(new.phone);
begin
  if (v is not null and public._wa_user(v) is not null) or (new.wa_lid is not null and public._wa_user(new.wa_lid) is not null) then
    raise exception 'That number is someone on the team, not a client';
  end if;
  if exists (select 1 from public.wa_other o where (v is not null and o.phone = v) or (new.wa_lid is not null and o.wa_lid = new.wa_lid)) then
    raise exception 'That number is marked as not a client (Alerts > Groups)';
  end if;
  if not public._zone_ok(new.timezone) then
    raise exception 'That isn''t a time zone';
  end if;
  return new;
end $$;
drop trigger if exists client_guard on public.client;
create trigger client_guard before insert or update of phone, wa_lid, timezone on public.client
  for each row execute function public._client_guard();

-- Everyone in a team group who isn't on the team and isn't a client: not a client (the bot runs it too).
create or replace function public.others_from_team_groups()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_bot text := (select bot_phone from public.watch_settings where id = 1);
  v_n int;
begin
  insert into public.wa_other (phone, wa_lid, name, note)
  select distinct on (coalesce(x.phone, x.lid)) x.phone, x.lid, x.name, 'In a team group'
    from (
      select p.phone, coalesce(p.lid, case when p.wa_id like '%@lid' then p.wa_id end) lid, p.name
        from public.wa_participant p join public.wa_group g using (chat_id)
       where g.kind = 'team' and g.left_at is null
    ) x
   where (x.phone is not null or x.lid is not null)
     and x.phone is distinct from v_bot
     and (x.phone is null or public._wa_user(x.phone) is null)
     and (x.lid is null or public._wa_user(x.lid) is null)
     and not exists (select 1 from public.client c where (x.phone is not null and public._phone_key(c.phone) = x.phone and c.created_by is not null))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.others_from_team_groups() from public, anon, authenticated;
grant execute on function public.others_from_team_groups() to service_role;

-- As 0099, and not for someone who isn't a client.
create or replace function public.client_from_booking(p_phone text, p_name text, p_email text, p_from_link boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_phone text := public._phone_key(p_phone);
  v_name  text := left(nullif(btrim(coalesce(p_name, '')), ''), 200);
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_id    uuid;
begin
  if v_phone is null or v_phone !~ '^[1-9][0-9]{7,14}$' then return null; end if;
  -- The team's own numbers, and people who aren't clients.
  if public._wa_user(v_phone) is not null or exists (select 1 from public.wa_other where phone = v_phone) then
    return null;
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  if v_name ~ '^\+?[0-9 ()-]+$' then v_name := null; end if;

  select id into v_id from public.client where public._phone_key(phone) = v_phone order by created_at limit 1;
  if v_id is null and v_email is not null then
    select id into v_id from public.client where lower(email) = v_email and phone is null order by created_at limit 1;
  end if;

  if v_id is not null then
    update public.client
       set phone      = coalesce(phone, '+' || v_phone),
           email      = coalesce(email, v_email),
           name       = case when not name_known and v_name is not null then v_name else name end,
           name_known = name_known or v_name is not null,
           updated_at = now()
     where id = v_id;
    return v_id;
  end if;

  if not p_from_link then return null; end if;
  insert into public.client (name, email, phone, name_known, notes)
  values (coalesce(v_name, '+' || v_phone), v_email, '+' || v_phone, v_name is not null, 'Booked a call from the WhatsApp bot''s link')
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.client_from_booking(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.client_from_booking(text, text, text, boolean) to service_role;

-- --------------------------------------------- admins: who someone is --
-- In Alerts > Groups: this number (or hidden-number id) is someone on the team
-- (p_as 'team', p_user), a client ('client': the bot adds them to Clients on
-- its next look at their groups), or not a client ('other').
create or replace function public.watch_person_set(p_phone text, p_as text, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lid   text := case when coalesce(p_phone, '') ~ '^[0-9]{6,20}@lid$' then p_phone end;
  v_phone text := case when v_lid is null then nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '') end;
  v_name  text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_as not in ('team', 'client', 'other') then raise exception 'Team, client or not a client'; end if;
  if v_lid is null and coalesce(v_phone, '') !~ '^[1-9][0-9]{7,14}$' then raise exception 'That is not a WhatsApp number'; end if;
  if p_as = 'team' then
    if p_user is null then raise exception 'Who on the team?'; end if;
    perform public.watch_link(p_phone, p_user);
    return;
  end if;
  -- Not the team any more (a member card's number stays: change it on the Users page).
  if v_lid is not null then delete from public.wa_member_lid where lid = v_lid;
  else delete from public.wa_member where phone = v_phone; end if;
  if p_as = 'other' then
    select coalesce(
             (select c.name from public.client c where c.name_known and ((v_phone is not null and public._phone_key(c.phone) = v_phone) or (v_lid is not null and c.wa_lid = v_lid)) limit 1),
             (select p.name from public.wa_participant p
               where ((v_phone is not null and p.phone = v_phone) or (v_lid is not null and (p.lid = v_lid or p.wa_id = v_lid))) and p.name is not null limit 1))
      into v_name;
    insert into public.wa_other (phone, wa_lid, name, created_by)
    values (v_phone, v_lid, v_name, auth.uid())
    on conflict do nothing;
  else
    delete from public.wa_other where (v_phone is not null and phone = v_phone) or (v_lid is not null and wa_lid = v_lid);
    -- The bot looks at their groups again soon and adds them to Clients.
    update public.wa_group g set people_at = null
     where exists (select 1 from public.wa_participant p where p.chat_id = g.chat_id
                     and ((v_phone is not null and p.phone = v_phone) or (v_lid is not null and (p.lid = v_lid or p.wa_id = v_lid))));
  end if;
end $$;
revoke all on function public.watch_person_set(text, text, uuid) from public, anon;
grant execute on function public.watch_person_set(text, text, uuid) to authenticated;

-- As 0087, plus whether each person in a group isn't a client.
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
                           'other', u.id is null and exists (
                              select 1 from public.wa_other o
                               where (pt.phone is not null and o.phone = pt.phone)
                                  or o.wa_lid = coalesce(pt.lid, case when pt.wa_id like '%@lid' then pt.wa_id end)),
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

-- A client's time zone, from the app (null: worked out from their number).
drop function if exists public.client_save(uuid, text, text, text, text, text);
create or replace function public.client_save(p_id uuid, p_name text, p_company text, p_email text, p_phone text, p_notes text, p_timezone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_zone text := nullif(btrim(coalesce(p_timezone, '')), '');
begin
  if not public.is_admin() and (p_id is null or not exists (
       select 1 from public.project p where p.client_id = p_id and public.can_see_project(p.id))) then
    raise exception 'Admins only';
  end if;
  if not public._zone_ok(v_zone) then raise exception 'That isn''t a time zone'; end if;
  if p_id is null then
    insert into public.client (name, company, email, phone, notes, timezone, created_by)
    values (btrim(p_name), nullif(btrim(p_company), ''), nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''),
            nullif(btrim(p_notes), ''), v_zone, auth.uid())
    returning id into v_id;
  else
    update public.client
       set name = btrim(p_name), company = nullif(btrim(p_company), ''), email = nullif(btrim(p_email), ''),
           phone = nullif(btrim(p_phone), ''), notes = nullif(btrim(p_notes), ''), timezone = v_zone,
           name_known = true, updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Client not found'; end if;
  end if;
  return v_id;
end $$;
revoke all on function public.client_save(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.client_save(uuid, text, text, text, text, text, text) to authenticated;

-- ------------------------------------------------------------- now --
-- The team out of Clients today, and the team groups' other people noted.
delete from public.client c
 where public._wa_user(public._phone_key(c.phone)) is not null
    or (c.wa_lid is not null and public._wa_user(c.wa_lid) is not null);
select public.others_from_team_groups();
delete from public.client c
 where c.created_by is null
   and exists (select 1 from public.wa_other o where (o.phone is not null and public._phone_key(c.phone) = o.phone) or (o.wa_lid is not null and c.wa_lid = o.wa_lid));

notify pgrst, 'reload schema';
