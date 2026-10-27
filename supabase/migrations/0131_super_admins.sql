-- 0131_super_admins.sql
--   The super admins are people, not numbers: brain_settings.owner_users.
--   Their WhatsApp numbers (owner_phones, which the bot reads) now follow by
--   themselves: every number linked to them (wa_member) and the one on their
--   card (profile_contact.whatsapp), kept up to date when either changes.
--   Only a super admin changes who the super admins are (from the app; this
--   file and the service role still can).
--   Everyone can have several WhatsApp numbers: an admin adds or removes them
--   on the Users page (member_phones to read them, watch_link to change them).

alter table public.brain_settings add column if not exists owner_users uuid[] not null default '{}';

-- Today's super admins: whoever the owner numbers belong to.
update public.brain_settings s
   set owner_users = coalesce((
     select array_agg(distinct u.user_id)
       from (
         select m.user_id from public.wa_member m where m.phone = any(s.owner_phones)
         union
         select c.user_id from public.profile_contact c where c.whatsapp = any(s.owner_phones)
       ) u
   ), '{}')
 where s.id = 1 and s.owner_users = '{}';

-- Every number of these people, in digits.
create or replace function public._phones_of(p_users uuid[])
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct x.phone order by x.phone), '{}')
    from (
      select m.phone from public.wa_member m where m.user_id = any(p_users)
      union
      select regexp_replace(c.whatsapp, '\D', '', 'g') from public.profile_contact c
       where c.user_id = any(p_users) and coalesce(c.whatsapp, '') <> ''
    ) x
   where x.phone ~ '^[1-9][0-9]{7,14}$'
$$;
revoke all on function public._phones_of(uuid[]) from public, anon, authenticated;

-- owner_phones follows owner_users.
create or replace function public._brain_owner_phones_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_phones := public._phones_of(new.owner_users);
  return new;
end $$;
revoke all on function public._brain_owner_phones_sync() from public, anon, authenticated;
drop trigger if exists owner_phones_sync on public.brain_settings;
create trigger owner_phones_sync before insert or update on public.brain_settings
  for each row execute function public._brain_owner_phones_sync();

-- ...and a super admin's numbers changing elsewhere.
create or replace function public._brain_owner_phones_refresh()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.brain_settings set owner_phones = owner_phones where id = 1;
  return null;
end $$;
revoke all on function public._brain_owner_phones_refresh() from public, anon, authenticated;
drop trigger if exists brain_owner_phones on public.wa_member;
create trigger brain_owner_phones after insert or update or delete on public.wa_member
  for each statement execute function public._brain_owner_phones_refresh();
drop trigger if exists brain_owner_phones on public.profile_contact;
create trigger brain_owner_phones after insert or update of whatsapp or delete on public.profile_contact
  for each statement execute function public._brain_owner_phones_refresh();

update public.brain_settings set owner_phones = owner_phones where id = 1;

-- Who the super admins are: changed only by a super admin (0123 guarded the numbers).
create or replace function public._brain_owner_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_users is distinct from old.owner_users and auth.uid() is not null
     and not (auth.uid() = any(old.owner_users)) then
    raise exception 'Only a super admin changes who the super admins are';
  end if;
  return new;
end;
$$;
revoke all on function public._brain_owner_guard() from public, anon, authenticated;

-- Settings: owner_users in place of owner_phones (same as 0124 otherwise).
create or replace function public.brain_settings_set(p jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_models text[] := array[
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001'
  ];
  v_users uuid[];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p ? 'model_owner' and not (p->>'model_owner' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'model_member' and not (p->>'model_member' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'model_fast' and not (p->>'model_fast' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'owner_users' then
    select coalesce(array_agg(distinct pr.id), '{}') into v_users
      from jsonb_array_elements_text(p->'owner_users') as x(v)
      join public.profile pr on pr.id::text = x.v and pr.is_active and pr.role in ('admin', 'member');
    if cardinality(v_users) = 0 then raise exception 'Keep at least one super admin'; end if;
  end if;
  update public.brain_settings s set
    phase        = coalesce((p->>'phase')::int, s.phase),
    stopped      = coalesce((p->>'stopped')::boolean, s.stopped),
    stopped_at   = case when p ? 'stopped' and (p->>'stopped')::boolean is distinct from s.stopped
                        then (case when (p->>'stopped')::boolean then now() end) else s.stopped_at end,
    stopped_by   = case when p ? 'stopped' and (p->>'stopped')::boolean is distinct from s.stopped
                        then (case when (p->>'stopped')::boolean then 'Alerts > Brain' end) else s.stopped_by end,
    owner_users  = case when p ? 'owner_users' then v_users else s.owner_users end,
    fallback_old = coalesce((p->>'fallback_old')::boolean, s.fallback_old),
    model_owner  = coalesce(p->>'model_owner', s.model_owner),
    model_member = coalesce(p->>'model_member', s.model_member),
    model_fast   = coalesce(p->>'model_fast', s.model_fast),
    max_turns    = coalesce((p->>'max_turns')::int, s.max_turns),
    member_turns = coalesce((p->>'member_turns')::int, s.member_turns),
    run_minutes  = coalesce((p->>'run_minutes')::int, s.run_minutes),
    run_cost_usd = coalesce((p->>'run_cost_usd')::numeric, s.run_cost_usd),
    day_cost_usd = coalesce((p->>'day_cost_usd')::numeric, s.day_cost_usd),
    updated_at   = now(),
    updated_by   = auth.uid()
  where s.id = 1;
end $$;

-- A member's WhatsApp numbers (the ones linked to them), for the Users page.
create or replace function public.member_phones(p_user uuid)
returns text[] language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((select array_agg(m.phone order by m.created_at) from public.wa_member m where m.user_id = p_user), '{}');
end $$;
revoke all on function public.member_phones(uuid) from public, anon;
grant execute on function public.member_phones(uuid) to authenticated;

-- Alerts > Brain: the people who can be super admins, with the rest (same as 0119 otherwise).
create or replace function public.brain_admin(p_limit int default 100)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_today timestamptz := ((now() at time zone 'Africa/Cairo')::date)::timestamp at time zone 'Africa/Cairo';
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) - 'id' from public.brain_settings s where s.id = 1),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(p.display_name, ''), p.username), 'role', p.role)
                       order by coalesce(nullif(p.display_name, ''), p.username))
        from public.profile p
       where p.is_active and p.role in ('admin', 'member')
    ), '[]'::jsonb),
    'today_cost', (select coalesce(sum(r.cost_usd), 0) from public.brain_run r where r.created_at >= v_today),
    'waiting', (select count(*) from public.brain_approval a where a.status = 'waiting' and a.expires_at > now()),
    'runs', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select r.id, r.chat_id, r.asker_name, r.tier, r.via, left(r.request, 300) as request, r.model, r.status,
               r.turns, r.cost_usd, r.ms, r.error, r.edits, r.created_at, r.finished_at,
               (select count(*) from public.brain_step st where st.run_id = r.id) as steps
          from public.brain_run r
         order by r.created_at desc
         limit greatest(1, least(coalesce(p_limit, 100), 500))
      ) x
    ), '[]'::jsonb)
  );
end $$;

notify pgrst, 'reload schema';
