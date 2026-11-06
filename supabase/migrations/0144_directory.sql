-- 0144: one searchable directory of everyone iklipse deals with.
--
-- The people already live in their own tables and stay there: the team
-- (profile, profile_contact), clients (client), freelancers and partner
-- companies (partner), other people on WhatsApp (wa_other). A card adds what
-- those don't hold (department, role, team, responsibilities, language) and is
-- the whole record for someone who is in none of them (a vendor, a contact).
-- Everyone is addressed by a ref: staff:<id>, client:<id>, partner:<id>,
-- other:<id>, card:<id>.
--
-- A record here gives nobody anything: no account, no group, no permission.
-- What someone may do stays in profile.role and bot_grant, and the "access" a
-- record shows is read from there, never typed in.
--
-- The bot and the dashboard go through the same two functions, so a rule holds
-- whichever way a change comes:
--   _directory_read / _directory_do (service role: the bot, it says who asked)
--   directory_read / directory_do   (the dashboard: the team reads, admins change)

create extension if not exists pg_trgm with schema extensions;

create table if not exists public.directory_card (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid unique references public.profile(id) on delete cascade,
  client_id        uuid unique references public.client(id) on delete cascade,
  partner_id       uuid unique references public.partner(id) on delete cascade,
  other_id         uuid unique references public.wa_other(id) on delete cascade,
  -- Only for someone in none of the tables above.
  kind             text check (kind in ('vendor', 'contact')),
  name             text,
  company          text,
  email            text,
  phone            text,
  department       text,
  role_title       text,
  team             text,
  is_manager       boolean not null default false,
  responsibilities text,
  language         text,
  notes            text,
  archived_at      timestamptz,
  created_by       uuid references public.profile(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (num_nonnulls(profile_id, client_id, partner_id, other_id) <= 1),
  check (num_nonnulls(profile_id, client_id, partner_id, other_id) = 1 or (kind is not null and btrim(coalesce(name, '')) <> ''))
);

-- Who's tied to what, beyond what iklipse shows by itself. A note of the tie, not access.
create table if not exists public.directory_link (
  id         uuid primary key default gen_random_uuid(),
  ref        text not null,
  kind       text not null check (kind in ('client', 'project', 'slack', 'group')),
  target     text not null,
  label      text not null,
  created_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (ref, kind, target)
);

-- Every change, whichever way it came. Kept after a record is deleted.
create table if not exists public.directory_history (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  ref        text not null,
  label      text,
  action     text not null,
  actor_id   uuid references public.profile(id) on delete set null,
  actor_name text,
  via        text not null,
  changes    jsonb
);
create index if not exists directory_history_ref_idx on public.directory_history (ref, at desc);

alter table public.directory_card enable row level security;
alter table public.directory_link enable row level security;
alter table public.directory_history enable row level security;
revoke all on public.directory_card, public.directory_link, public.directory_history from anon, authenticated;

-- ------------------------------------------------------------ the records --

create or replace function public._directory_access(p_user uuid, p_phone text, p_base text)
returns text language sql stable security definer set search_path = public as $$
  select p_base || coalesce(' + ' || string_agg(distinct s.name, ', '), '')
    from public.bot_grant g
    join public.bot_skill s on s.key = g.skill
   where g.allowed and g.skill <> 'talk'
     and ((p_user is not null and g.user_id = p_user) or (p_phone is not null and g.phone = p_phone));
$$;

create or replace function public._directory_rows()
returns table (ref text, kind text, name text, company text, department text, role_title text, team text,
               is_manager boolean, responsibilities text, email text, phone text, language text, notes text,
               status text, access text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select 'staff:' || p.id, 'staff', p.display_name, coalesce(d.company, 'iklipse'), d.department, d.role_title, d.team,
         coalesce(d.is_manager, false), d.responsibilities, c.email::text, c.whatsapp, d.language, d.notes,
         case when p.is_active then 'active' else 'left' end,
         public._directory_access(p.id, c.whatsapp, case
           when not p.is_active then 'None (left the team)'
           when p.id = (select super_admin from public.brain_settings where id = 1) then 'Super admin'
           when p.role = 'admin' then 'Admin'
           else 'Team member' end),
         greatest(p.updated_at, c.updated_at, d.updated_at)
    from public.profile p
    left join public.profile_contact c on c.user_id = p.id
    left join public.directory_card d on d.profile_id = p.id
  union all
  select 'client:' || c.id, 'client', c.name, coalesce(d.company, c.company), d.department, d.role_title, d.team,
         coalesce(d.is_manager, false), d.responsibilities, c.email::text, c.phone_key, d.language, c.notes,
         case when d.archived_at is null then 'active' else 'archived' end,
         public._directory_access(null, c.phone_key, 'Client: their own chat and meetings'),
         greatest(c.updated_at, d.updated_at)
    from public.client c
    left join public.directory_card d on d.client_id = c.id
  union all
  select 'partner:' || a.id, case when a.kind = 'freelancer' then 'freelancer' else 'partner' end, a.name, coalesce(d.company, case when a.kind = 'company' then a.name end),
         d.department, d.role_title, d.team, coalesce(d.is_manager, false), d.responsibilities, d.email, coalesce(n.phone, d.phone), d.language, a.note,
         case when a.is_active and d.archived_at is null then 'active' else 'archived' end,
         public._directory_access(null, coalesce(n.phone, d.phone), 'None'),
         greatest(a.updated_at, d.updated_at)
    from public.partner a
    left join public.directory_card d on d.partner_id = a.id
    -- A freelancer is one person: their number on WhatsApp is theirs, not someone else's record.
    left join lateral (select o.phone from public.wa_other o where o.partner_id = a.id and a.kind = 'freelancer' and o.phone is not null order by o.created_at limit 1) n on true
  union all
  select 'other:' || o.id, case when o.partner_id is null then 'contact' else 'partner' end, coalesce(o.name, '+' || o.phone, 'Someone'),
         coalesce(d.company, a.name), d.department, d.role_title, d.team, coalesce(d.is_manager, false), d.responsibilities, d.email, o.phone, d.language, o.note,
         case when d.archived_at is null then 'active' else 'archived' end,
         public._directory_access(null, o.phone, 'None'),
         greatest(o.created_at, d.updated_at)
    from public.wa_other o
    left join public.partner a on a.id = o.partner_id
    left join public.directory_card d on d.other_id = o.id
   where a.kind is distinct from 'freelancer'
  union all
  select 'card:' || d.id, d.kind, d.name, d.company, d.department, d.role_title, d.team, d.is_manager, d.responsibilities, d.email, d.phone, d.language, d.notes,
         case when d.archived_at is null then 'active' else 'archived' end,
         public._directory_access(null, d.phone, 'None'),
         d.updated_at
    from public.directory_card d
   where num_nonnulls(d.profile_id, d.client_id, d.partner_id, d.other_id) = 0;
$$;

create or replace function public._directory_row(p_ref text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(r) from public._directory_rows() r where r.ref = p_ref;
$$;

/** Who a new or changed record is probably already: the same number, the same email or a name very like it. */
create or replace function public._directory_dupes(p_name text, p_email text, p_phone text, p_except text default null)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  with a as (
    select lower(btrim(coalesce(p_name, ''))) as nm, lower(btrim(coalesce(p_email, ''))) as em, public._phone_key(p_phone) as ph
  )
  select coalesce(jsonb_agg(x order by x.why, x.name), '[]'::jsonb)
    from (
      select r.ref, r.kind, r.name, r.company, r.email, r.phone, r.status,
             case when a.ph is not null and right(r.phone, 9) = right(a.ph, 9) then 'same number'
                  when a.em <> '' and lower(r.email) = a.em then 'same email'
                  else 'similar name' end as why
        from public._directory_rows() r, a
       where r.ref is distinct from p_except
         and ((a.ph is not null and right(r.phone, 9) = right(a.ph, 9))
           or (a.em <> '' and lower(r.email) = a.em)
           or (length(a.nm) >= 3 and (
                 lower(r.name) = a.nm
                 or similarity(lower(r.name), a.nm) >= 0.55
                 or ' ' || lower(r.name) || ' ' like '% ' || a.nm || ' %'
                 or ' ' || a.nm || ' ' like '% ' || lower(r.name) || ' %')))
    ) x;
$$;

/** The fields as given, tidied. Only keys given are in it; an empty one means clear it. */
create or replace function public._directory_clean(f jsonb)
returns jsonb language plpgsql immutable security definer set search_path = public as $$
declare
  k text;
  v text;
  out jsonb := '{}'::jsonb;
begin
  for k in select jsonb_object_keys(coalesce(f, '{}'::jsonb)) loop
    if k not in ('kind', 'name', 'company', 'department', 'role_title', 'team', 'is_manager', 'responsibilities', 'email', 'phone', 'language', 'notes') then
      raise exception 'There''s no field %. What someone may do isn''t set here: it''s their role and their permissions.', k;
    end if;
    if k = 'is_manager' then
      out := out || jsonb_build_object(k, coalesce((f ->> k)::boolean, false));
      continue;
    end if;
    v := nullif(btrim(coalesce(f ->> k, '')), '');
    if length(v) > 2000 then raise exception '% is too long.', k; end if;
    if k = 'email' and v is not null then
      if v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'That isn''t an email: %', v; end if;
      v := lower(v);
    end if;
    if k = 'phone' and v is not null then
      v := public._phone_key(v);
      if v is null or v !~ '^[1-9][0-9]{7,14}$' then raise exception 'That isn''t a full number with its country code: %', f ->> k; end if;
    end if;
    out := out || jsonb_build_object(k, v);
  end loop;
  return out;
end $$;

/** The card of a ref, made if it has none yet. */
create or replace function public._directory_card_of(p_ref text, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_part text := split_part(p_ref, ':', 1);
  v_id uuid := split_part(p_ref, ':', 2)::uuid;
  v_card uuid;
begin
  if v_part = 'card' then return v_id; end if;
  select id into v_card from public.directory_card
   where case v_part when 'staff' then profile_id when 'client' then client_id when 'partner' then partner_id else other_id end = v_id;
  if v_card is not null then return v_card; end if;
  insert into public.directory_card (profile_id, client_id, partner_id, other_id, created_by)
  values (case when v_part = 'staff' then v_id end, case when v_part = 'client' then v_id end,
          case when v_part = 'partner' then v_id end, case when v_part = 'other' then v_id end, p_actor)
  returning id into v_card;
  return v_card;
end $$;

create or replace function public._directory_log(p_ref text, p_action text, p_before jsonb, p_after jsonb, p_actor uuid, p_via text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_changes jsonb;
begin
  if p_before is not null and p_after is not null then
    select jsonb_object_agg(a.key, jsonb_build_array(p_before -> a.key, a.value)) into v_changes
      from jsonb_each(p_after) a
     where a.key not in ('updated_at', 'access') and a.value is distinct from p_before -> a.key;
    if v_changes is null then return; end if;
  else
    v_changes := coalesce(p_after, p_before) - 'updated_at' - 'access';
  end if;
  insert into public.directory_history (ref, label, action, actor_id, actor_name, via, changes)
  values (p_ref, coalesce(p_after ->> 'name', p_before ->> 'name'), p_action, p_actor,
          (select display_name from public.profile where id = p_actor), p_via, v_changes);
end $$;

-- ------------------------------------------------------------- the changes --

create or replace function public._directory_save(p jsonb, p_actor uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_ref text := nullif(btrim(coalesce(p ->> 'ref', '')), '');
  v_force boolean := coalesce((p ->> 'force')::boolean, false);
  f jsonb := public._directory_clean(p -> 'fields');
  v_part text;
  v_id uuid;
  v_kind text;
  v_before jsonb;
  v_after jsonb;
  v_dupes jsonb;
  v_card uuid;
begin
  if f = '{}'::jsonb then raise exception 'Nothing to save.'; end if;

  if v_ref is null then
    v_kind := coalesce(f ->> 'kind', 'contact');
    if v_kind = 'staff' then raise exception 'Someone on the team gets an account on the Users page, by an admin.'; end if;
    if v_kind not in ('vendor', 'contact', 'client', 'freelancer', 'partner') then raise exception 'A record is a vendor, a contact, a client, a freelancer or a partner.'; end if;
    if f ->> 'name' is null then raise exception 'A record needs a name.'; end if;
    if not v_force then
      v_dupes := public._directory_dupes(f ->> 'name', f ->> 'email', f ->> 'phone');
      if jsonb_array_length(v_dupes) > 0 then return jsonb_build_object('status', 'duplicates', 'matches', v_dupes); end if;
    end if;
    if v_kind = 'client' then
      insert into public.client (name, company, email, phone, notes, name_known, created_by)
      values (f ->> 'name', f ->> 'company', f ->> 'email', f ->> 'phone', f ->> 'notes', true, p_actor) returning id into v_id;
      v_ref := 'client:' || v_id;
    elsif v_kind in ('freelancer', 'partner') then
      insert into public.partner (name, kind, note, created_by)
      values (f ->> 'name', case when v_kind = 'freelancer' then 'freelancer' else 'company' end, f ->> 'notes', p_actor) returning id into v_id;
      v_ref := 'partner:' || v_id;
    else
      insert into public.directory_card (kind, name, company, email, phone, notes, created_by)
      values (v_kind, f ->> 'name', f ->> 'company', f ->> 'email', f ->> 'phone', f ->> 'notes', p_actor) returning id into v_id;
      v_ref := 'card:' || v_id;
    end if;
    v_before := null;
    f := f - 'kind' - 'name' - case when v_kind in ('vendor', 'contact') then 'email' else '' end - case when v_kind in ('vendor', 'contact') then 'phone' else '' end
           - 'notes' - case when v_kind in ('client', 'vendor', 'contact') then 'company' else '' end;
    if v_kind = 'client' then f := f - 'email' - 'phone'; end if;
  else
    v_before := public._directory_row(v_ref);
    if v_before is null then raise exception 'No such record: %', v_ref; end if;
    if f ? 'kind' and split_part(v_ref, ':', 1) <> 'card' then raise exception 'What kind of person they are changes only on a vendor or a contact.'; end if;
    if f ? 'kind' and f ->> 'kind' not in ('vendor', 'contact') then raise exception 'A card is a vendor or a contact.'; end if;
    if not v_force and (f ? 'phone' or f ? 'email') then
      v_dupes := public._directory_dupes(null, f ->> 'email', f ->> 'phone', v_ref);
      if jsonb_array_length(v_dupes) > 0 then return jsonb_build_object('status', 'duplicates', 'matches', v_dupes); end if;
    end if;
  end if;

  v_part := split_part(v_ref, ':', 1);
  v_id := split_part(v_ref, ':', 2)::uuid;

  if v_part = 'staff' and (f ? 'name' or f ? 'email' or f ? 'phone') then
    raise exception 'The name, number and email of someone on the team are changed on the Users page or with team_member.';
  end if;
  if f ? 'name' and f ->> 'name' is null then raise exception 'A record needs a name.'; end if;

  if v_part = 'client' then
    update public.client set
      name = coalesce(f ->> 'name', name), name_known = name_known or f ? 'name',
      email = case when f ? 'email' then f ->> 'email' else email end,
      phone = case when f ? 'phone' then f ->> 'phone' else phone end,
      notes = case when f ? 'notes' then f ->> 'notes' else notes end,
      company = case when f ? 'company' then f ->> 'company' else company end,
      updated_at = now()
     where id = v_id;
    f := f - 'name' - 'email' - 'phone' - 'notes' - 'company';
  elsif v_part = 'partner' then
    update public.partner set
      name = coalesce(f ->> 'name', name),
      note = case when f ? 'notes' then f ->> 'notes' else note end,
      updated_at = now()
     where id = v_id;
    f := f - 'name' - 'notes';
    -- A freelancer's number is how the bot writes to them: kept where it looks (people.ts partners).
    if f ? 'phone' and exists (select 1 from public.partner where id = v_id and kind = 'freelancer') then
      if f ->> 'phone' is null then
        delete from public.wa_other where partner_id = v_id;
      else
        update public.wa_other set phone = f ->> 'phone' where partner_id = v_id;
        if not found then
          insert into public.wa_other (phone, name, partner_id, created_by)
          select f ->> 'phone', a.name, a.id, p_actor from public.partner a where a.id = v_id
          on conflict (phone) do update set partner_id = excluded.partner_id;
        end if;
      end if;
      f := f - 'phone';
    end if;
  elsif v_part = 'other' then
    update public.wa_other set
      name = case when f ? 'name' then f ->> 'name' else name end,
      phone = case when f ? 'phone' then f ->> 'phone' else phone end,
      note = case when f ? 'notes' then f ->> 'notes' else note end
     where id = v_id;
    f := f - 'name' - 'phone' - 'notes';
  end if;

  if f <> '{}'::jsonb then
    v_card := public._directory_card_of(v_ref, p_actor);
    update public.directory_card set
      kind             = case when f ? 'kind' then f ->> 'kind' else kind end,
      name             = case when f ? 'name' then f ->> 'name' else name end,
      company          = case when f ? 'company' then f ->> 'company' else company end,
      email            = case when f ? 'email' then f ->> 'email' else email end,
      phone            = case when f ? 'phone' then f ->> 'phone' else phone end,
      department       = case when f ? 'department' then f ->> 'department' else department end,
      role_title       = case when f ? 'role_title' then f ->> 'role_title' else role_title end,
      team             = case when f ? 'team' then f ->> 'team' else team end,
      is_manager       = case when f ? 'is_manager' then (f ->> 'is_manager')::boolean else is_manager end,
      responsibilities = case when f ? 'responsibilities' then f ->> 'responsibilities' else responsibilities end,
      language         = case when f ? 'language' then f ->> 'language' else language end,
      notes            = case when f ? 'notes' then f ->> 'notes' else notes end,
      updated_at       = now()
     where id = v_card;
  end if;

  v_after := public._directory_row(v_ref);
  perform public._directory_log(v_ref, case when v_before is null then 'add' else 'change' end, v_before, v_after, p_actor, p_via);
  return jsonb_build_object('status', case when v_before is null then 'added' else 'saved' end, 'ref', v_ref, 'record', v_after);
end $$;

create or replace function public._directory_archive(p jsonb, p_actor uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ref text := p ->> 'ref';
  v_on boolean := coalesce((p ->> 'archived')::boolean, true);
  v_part text := split_part(v_ref, ':', 1);
  v_before jsonb := public._directory_row(v_ref);
  v_after jsonb;
  v_card uuid;
begin
  if v_before is null then raise exception 'No such record: %', v_ref; end if;
  if v_part = 'staff' then raise exception 'Someone on the team isn''t archived: they''re marked as left on the Users page or with team_member.'; end if;
  if v_part = 'partner' then update public.partner set is_active = not v_on, updated_at = now() where id = split_part(v_ref, ':', 2)::uuid; end if;
  v_card := public._directory_card_of(v_ref, p_actor);
  update public.directory_card set archived_at = case when v_on then now() end, updated_at = now() where id = v_card;
  v_after := public._directory_row(v_ref);
  perform public._directory_log(v_ref, case when v_on then 'archive' else 'restore' end, v_before, v_after, p_actor, p_via);
  return jsonb_build_object('status', 'saved', 'ref', v_ref, 'record', v_after);
end $$;

create or replace function public._directory_delete(p jsonb, p_actor uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ref text := p ->> 'ref';
  v_part text := split_part(v_ref, ':', 1);
  v_before jsonb := public._directory_row(v_ref);
begin
  if v_before is null then raise exception 'No such record: %', v_ref; end if;
  if v_part = 'staff' then raise exception 'Someone on the team is never deleted: they''re marked as left, so their work stays.'; end if;
  if v_part = 'client' then raise exception 'A client is deleted on the Projects page, where their projects show. Archive them here instead.'; end if;
  if v_part <> 'card' then raise exception 'Only a vendor or a contact added here is deleted. Archive this one instead.'; end if;
  delete from public.directory_link where ref = v_ref;
  delete from public.directory_card where id = split_part(v_ref, ':', 2)::uuid;
  perform public._directory_log(v_ref, 'delete', v_before, null, p_actor, p_via);
  return jsonb_build_object('status', 'deleted', 'ref', v_ref);
end $$;

/** The second one folds into the first: what the first lacks is filled, what differs goes in its notes, nothing is lost. */
create or replace function public._directory_merge(p jsonb, p_actor uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_keep text := p ->> 'keep';
  v_drop text := p ->> 'drop';
  a jsonb := public._directory_row(v_keep);
  b jsonb := public._directory_row(v_drop);
  f jsonb := '{}'::jsonb;
  v_also text[] := '{}';
  k text;
  v_base boolean;
begin
  if a is null or b is null then raise exception 'One of those records doesn''t exist.'; end if;
  if v_keep = v_drop then raise exception 'That''s the same record.'; end if;
  if split_part(v_drop, ':', 1) <> 'card' then raise exception 'Only a vendor or a contact added here folds into another. Keep % and fold the other into it, or archive one.', b ->> 'name'; end if;
  foreach k in array array['company', 'department', 'role_title', 'team', 'responsibilities', 'language', 'email', 'phone'] loop
    continue when nullif(b ->> k, '') is null or lower(coalesce(a ->> k, '')) = lower(b ->> k);
    v_base := k in ('email', 'phone') and split_part(v_keep, ':', 1) = 'staff';
    if nullif(a ->> k, '') is null and not v_base then f := f || jsonb_build_object(k, b ->> k);
    else v_also := v_also || (k || ': ' || (b ->> k)); end if;
  end loop;
  if lower(a ->> 'name') <> lower(b ->> 'name') then v_also := v_also || ('name: ' || (b ->> 'name')); end if;
  if nullif(b ->> 'notes', '') is not null then v_also := v_also || (b ->> 'notes'); end if;
  if (b ->> 'is_manager')::boolean then f := f || '{"is_manager": true}'::jsonb; end if;
  if array_length(v_also, 1) > 0 then
    f := f || jsonb_build_object('notes', concat_ws(E'\n', nullif(a ->> 'notes', ''), 'Merged in: ' || array_to_string(v_also, '; ')));
  end if;
  if f <> '{}'::jsonb then perform public._directory_save(jsonb_build_object('ref', v_keep, 'fields', f, 'force', true), p_actor, p_via); end if;
  update public.directory_link l set ref = v_keep
   where l.ref = v_drop and not exists (select 1 from public.directory_link x where x.ref = v_keep and x.kind = l.kind and x.target = l.target);
  delete from public.directory_link where ref = v_drop;
  delete from public.directory_card where id = split_part(v_drop, ':', 2)::uuid;
  perform public._directory_log(v_drop, 'merged', b, null, p_actor, p_via);
  perform public._directory_log(v_keep, 'merged', null, jsonb_build_object('name', a ->> 'name', 'merged_in', b ->> 'name'), p_actor, p_via);
  return jsonb_build_object('status', 'merged', 'ref', v_keep, 'record', public._directory_row(v_keep));
end $$;

/** Ties someone to a client, a project, a Slack channel or a WhatsApp group, found by id or name. */
create or replace function public._directory_link_set(p jsonb, p_actor uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ref text := p ->> 'ref';
  v_kind text := p ->> 'kind';
  v_to text := btrim(coalesce(p ->> 'to', ''));
  v_on boolean := coalesce((p ->> 'on')::boolean, true);
  v_before jsonb := public._directory_row(v_ref);
  v_hits jsonb;
  v_exact jsonb;
  v_target text;
  v_label text;
begin
  if v_before is null then raise exception 'No such record: %', v_ref; end if;
  if v_to = '' then raise exception 'Tied to what?'; end if;
  if v_kind = 'project' then
    select jsonb_agg(jsonb_build_object('id', id::text, 'label', title)) into v_hits from public.project where id::text = v_to or title ilike '%' || v_to || '%';
  elsif v_kind = 'client' then
    select jsonb_agg(jsonb_build_object('id', id::text, 'label', name)) into v_hits from public.client where id::text = v_to or name ilike '%' || v_to || '%' or company ilike '%' || v_to || '%';
  elsif v_kind = 'slack' then
    select jsonb_agg(jsonb_build_object('id', channel_id, 'label', name)) into v_hits from public.slack_channel where channel_id = v_to or name ilike '%' || v_to || '%';
  elsif v_kind = 'group' then
    select jsonb_agg(jsonb_build_object('id', chat_id, 'label', name)) into v_hits from public.wa_group where left_at is null and (chat_id = v_to or name ilike '%' || v_to || '%');
  else
    raise exception 'They''re tied to a client, a project, a slack channel or a group.';
  end if;
  if v_hits is null then raise exception 'No % like "%".', v_kind, v_to; end if;
  select jsonb_agg(h) into v_exact from jsonb_array_elements(v_hits) h where lower(h ->> 'label') = lower(v_to);
  if jsonb_array_length(v_exact) = 1 then v_hits := v_exact; end if;
  if jsonb_array_length(v_hits) > 1 then
    raise exception 'Which one: %?', (select string_agg(h ->> 'label', ', ') from (select h from jsonb_array_elements(v_hits) h limit 6) x);
  end if;
  v_target := v_hits -> 0 ->> 'id';
  v_label := v_hits -> 0 ->> 'label';
  if v_on then
    insert into public.directory_link (ref, kind, target, label, created_by) values (v_ref, v_kind, v_target, v_label, p_actor)
    on conflict (ref, kind, target) do nothing;
  else
    delete from public.directory_link where ref = v_ref and kind = v_kind and target = v_target;
    if not found then raise exception 'They aren''t tied to %.', v_label; end if;
  end if;
  perform public._directory_log(v_ref, case when v_on then 'link' else 'unlink' end, null, jsonb_build_object('name', v_before ->> 'name', v_kind, v_label), p_actor, p_via);
  return jsonb_build_object('status', 'saved', 'ref', v_ref, 'label', v_label);
end $$;

create or replace function public._directory_do(p_op text, p jsonb, p_actor uuid, p_via text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return case p_op
    when 'save' then public._directory_save(p, p_actor, p_via)
    when 'archive' then public._directory_archive(p, p_actor, p_via)
    when 'delete' then public._directory_delete(p, p_actor, p_via)
    when 'merge' then public._directory_merge(p, p_actor, p_via)
    when 'link' then public._directory_link_set(p, p_actor, p_via)
  end;
end $$;

-- ------------------------------------------------------------- the reading --

/** Where someone is: what iklipse shows by itself, plus the ties made here. */
create or replace function public._directory_places(p_ref text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb := public._directory_row(p_ref);
  v_part text := split_part(p_ref, ':', 1);
  v_id text := split_part(p_ref, ':', 2);
  v_phone text := r ->> 'phone';
  v_email text := lower(nullif(r ->> 'email', ''));
  v_lids text[] := '{}';
begin
  if r is null then raise exception 'No such record: %', p_ref; end if;
  if v_part = 'staff' then
    select coalesce(array_agg(lid), '{}') into v_lids from public.wa_member_lid where user_id = v_id::uuid;
  elsif v_part = 'client' then
    select coalesce(array_agg(wa_lid), '{}') into v_lids from public.client where id = v_id::uuid and wa_lid is not null;
  elsif v_part = 'other' then
    select coalesce(array_agg(wa_lid), '{}') into v_lids from public.wa_other where id = v_id::uuid and wa_lid is not null;
  end if;
  return jsonb_build_object(
    'projects', (select coalesce(jsonb_agg(distinct t), '[]'::jsonb) from (
        select p.title as t from public.project_member m join public.project p on p.id = m.project_id where v_part = 'staff' and m.user_id = v_id::uuid
        union select p.title from public.project p where v_part = 'client' and p.client_id = v_id::uuid
        union select label from public.directory_link where ref = p_ref and kind = 'project') x),
    'clients', (select coalesce(jsonb_agg(distinct t), '[]'::jsonb) from (
        select c.name as t from public.project_member m join public.project p on p.id = m.project_id join public.client c on c.id = p.client_id where v_part = 'staff' and m.user_id = v_id::uuid
        union select label from public.directory_link where ref = p_ref and kind = 'client') x),
    'groups', (select coalesce(jsonb_agg(distinct t), '[]'::jsonb) from (
        select g.name as t from public.wa_participant w join public.wa_group g on g.chat_id = w.chat_id
         where g.left_at is null and ((v_phone is not null and w.phone = v_phone) or w.lid = any (v_lids)
           or (v_part = 'staff' and w.phone in (select phone from public.wa_member where user_id = v_id::uuid)))
        union select g.name from public.wa_group g where v_part = 'partner' and g.left_at is null and g.partner_id = v_id::uuid
        union select label from public.directory_link where ref = p_ref and kind = 'group') x),
    'slack', (select coalesce(jsonb_agg(distinct t), '[]'::jsonb) from (
        select c.name as t from public.slack_participant s join public.slack_channel c on c.channel_id = s.channel_id
         where s.slack_id in (
           select slack_id from public.slack_user where v_email is not null and lower(email) = v_email
           union select slack_id from public.slack_member where v_part = 'staff' and user_id = v_id::uuid)
        union select label from public.directory_link where ref = p_ref and kind = 'slack') x));
end $$;

create or replace function public._directory_read(p_what text, p jsonb, p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_what = 'list' then
    return coalesce((
      select jsonb_agg(case when p_full then to_jsonb(r) else to_jsonb(r) - 'notes' - 'access' end order by lower(r.name))
        from public._directory_rows() r), '[]'::jsonb);
  end if;
  if not p_full then raise exception 'Admins only.'; end if;
  if p_what = 'places' then return public._directory_places(p ->> 'ref'); end if;
  if p_what = 'dupes' then return public._directory_dupes(p ->> 'name', p ->> 'email', p ->> 'phone', p ->> 'except'); end if;
  if p_what = 'history' then
    return coalesce((
      select jsonb_agg(to_jsonb(h) - 'id' - 'actor_id' order by h.at desc)
        from (select * from public.directory_history where ref = p ->> 'ref' order by at desc limit 50) h), '[]'::jsonb);
  end if;
  raise exception 'Nothing called %.', p_what;
end $$;

-- The dashboard: anyone on the team reads, admins read everything and change.
create or replace function public.directory_read(p_what text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profile where id = auth.uid() and is_active and role in ('admin', 'member')) or not public.am_active() then
    raise exception 'Not allowed.';
  end if;
  return public._directory_read(p_what, p, public.is_admin());
end $$;

create or replace function public.directory_do(p_op text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return public._directory_do(p_op, p, auth.uid(), 'dashboard');
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    '_directory_access(uuid, text, text)', '_directory_rows()', '_directory_row(text)', '_directory_dupes(text, text, text, text)',
    '_directory_clean(jsonb)', '_directory_card_of(text, uuid)', '_directory_log(text, text, jsonb, jsonb, uuid, text)',
    '_directory_save(jsonb, uuid, text)', '_directory_archive(jsonb, uuid, text)', '_directory_delete(jsonb, uuid, text)',
    '_directory_merge(jsonb, uuid, text)', '_directory_link_set(jsonb, uuid, text)', '_directory_do(text, jsonb, uuid, text)',
    '_directory_places(text)', '_directory_read(text, jsonb, boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public._directory_do(text, jsonb, uuid, text), public._directory_read(text, jsonb, boolean) to service_role;
revoke all on function public.directory_read(text, jsonb), public.directory_do(text, jsonb) from public, anon;
grant execute on function public.directory_read(text, jsonb), public.directory_do(text, jsonb) to authenticated;

-- What the bot may do with it: the team reads, admins change.
insert into public.bot_skill (key, name, about, area, grantable, sort) values
  ('directory',        'See the directory',    'Search the directory and find who holds a role.',                          'read', true, 39),
  ('directory_change', 'Change the directory', 'Add, change, archive, delete, merge, link, import and export records.',    'do',   true, 40)
on conflict (key) do nothing;

insert into public.bot_default (kind, skill, allowed)
select k.kind, s.key, k.kind <> 'client' and (s.key = 'directory' or k.kind = 'admin')
  from (values ('directory'), ('directory_change')) s(key)
 cross join (values ('admin'), ('member'), ('client')) k(kind)
on conflict do nothing;

-- Open pages see a change at once (0094).
do $$
declare
  t text;
begin
  foreach t in array array['directory_card', 'directory_link', 'directory_history', 'partner', 'wa_other', 'profile'] loop
    execute format('drop trigger if exists live_ins on public.%I', t);
    execute format('drop trigger if exists live_upd on public.%I', t);
    execute format('drop trigger if exists live_del on public.%I', t);
    execute format('create trigger live_ins after insert on public.%I referencing new table as new_rows for each statement execute function public._live_ping()', t);
    execute format('create trigger live_upd after update on public.%I referencing new table as new_rows for each statement execute function public._live_ping()', t);
    execute format('create trigger live_del after delete on public.%I referencing old table as old_rows for each statement execute function public._live_ping()', t);
  end loop;
end $$;
