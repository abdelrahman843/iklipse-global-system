-- 0083_attendance_home.sql — the home page.
--
-- 1. Attendance: team members (not admins) log in when they start work, take
--    breaks and log out when they leave; every press is kept with the
--    server's time. Admins don't log anything; they see when each person came
--    and left, their breaks, and who's working or on a break right now.
--    A work day is a day in Cairo. A session nobody logged out of is closed at
--    5 am Cairo the next day and marked, so it shows as "didn't log out".
-- 2. Deliveries due in the next days (and late ones), from the projects I can see.
-- 3. How many open alerts I have (the number on Alerts in the sidebar).
--
-- The tables are closed to the app: everything goes through the functions.

-- ------------------------------------------------------------- 1. tables --
create table if not exists public.work_session (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profile(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  -- Closed by the system: the person didn't log out.
  auto_closed boolean not null default false,
  check (ended_at is null or ended_at >= started_at)
);
-- One open session per person.
create unique index if not exists work_session_open on public.work_session (user_id) where ended_at is null;
create index if not exists work_session_user_started on public.work_session (user_id, started_at desc);
create index if not exists work_session_started on public.work_session (started_at);

create table if not exists public.work_break (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.work_session(id) on delete cascade,
  user_id     uuid not null references public.profile(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
-- One open break per session.
create unique index if not exists work_break_open on public.work_break (session_id) where ended_at is null;
create index if not exists work_break_session on public.work_break (session_id);

alter table public.work_session enable row level security;
alter table public.work_break   enable row level security;
revoke all on public.work_session, public.work_break from anon, authenticated;

-- ------------------------------------------------------------ helpers --
-- Who logs attendance: active team members (admins and guests don't).
create or replace function public._att_tracked()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_workspace_role() = 'member', false);
$$;
revoke all on function public._att_tracked() from public, anon, authenticated;

-- A person's sessions that started in [p_from, p_to), plus their open one
-- when p_open, each with its breaks.
create or replace function public._att_sessions(p_user uuid, p_from timestamptz, p_to timestamptz, p_open boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'started_at', s.started_at, 'ended_at', s.ended_at, 'auto', s.auto_closed,
           'breaks', coalesce((select jsonb_agg(jsonb_build_object('started_at', b.started_at, 'ended_at', b.ended_at)
                                                order by b.started_at)
                                 from public.work_break b where b.session_id = s.id), '[]'::jsonb))
           order by s.started_at), '[]'::jsonb)
    from public.work_session s
   where s.user_id = p_user
     and ((s.started_at >= p_from and s.started_at < p_to) or (p_open and s.ended_at is null));
$$;
revoke all on function public._att_sessions(uuid, timestamptz, timestamptz, boolean) from public, anon, authenticated;

-- Close sessions nobody logged out of, at 5 am Cairo the day after they
-- started (p_user: one person's, null: everyone's). Their open break ends then too.
create or replace function public._attendance_close(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with due as (
    select s.id,
           (((s.started_at at time zone 'Africa/Cairo')::date + 1)::timestamp + interval '5 hours') at time zone 'Africa/Cairo' as cut
      from public.work_session s
     where s.ended_at is null and (p_user is null or s.user_id = p_user)
  ), stale as (
    select * from due where cut <= now()
  ), breaks as (
    update public.work_break b set ended_at = greatest(st.cut, b.started_at)
      from stale st where b.session_id = st.id and b.ended_at is null
  )
  update public.work_session s set ended_at = st.cut, auto_closed = true
    from stale st where s.id = st.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._attendance_close(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------- reads --
-- My attendance: whether I log it, where I am now, and today's sessions.
-- status: "out" (not working), "in" (working), "break".
create or replace function public.attendance_me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_day date := (now() at time zone 'Africa/Cairo')::date;
  v_from timestamptz := v_day::timestamp at time zone 'Africa/Cairo';
  o public.work_session;
  ob public.work_break;
begin
  if not public._att_tracked() then return jsonb_build_object('tracked', false); end if;
  select * into o from public.work_session where user_id = v_me and ended_at is null;
  if o.id is not null then
    select * into ob from public.work_break where session_id = o.id and ended_at is null;
  end if;
  return jsonb_build_object(
    'tracked', true,
    'day', v_day,
    'status', case when o.id is null then 'out' when ob.id is not null then 'break' else 'in' end,
    'since', case when o.id is null then null when ob.id is not null then ob.started_at else o.started_at end,
    'sessions', public._att_sessions(v_me, v_from, v_from + interval '1 day', true));
end $$;
revoke all on function public.attendance_me() from public, anon;
grant execute on function public.attendance_me() to authenticated;

-- Admins: everyone's day (a day in Cairo). Every active team member, plus
-- anyone else who logged in that day, with where they are right now.
create or replace function public.attendance_day(p_day date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'Africa/Cairo';
  v_to timestamptz := (p_day + 1)::timestamp at time zone 'Africa/Cairo';
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', pr.id, 'name', pr.display_name, 'avatar_url', pr.avatar_url, 'active', pr.is_active,
             'status', case when o.id is null then 'out' when ob.id is not null then 'break' else 'in' end,
             'since', case when o.id is null then null when ob.id is not null then ob.started_at else o.started_at end,
             'sessions', public._att_sessions(pr.id, v_from, v_to, false))
           order by lower(pr.display_name))
      from public.profile pr
      left join public.work_session o on o.user_id = pr.id and o.ended_at is null
      left join public.work_break ob on ob.session_id = o.id and ob.ended_at is null
     where (pr.role = 'member' and pr.is_active)
        or exists (select 1 from public.work_session s
                    where s.user_id = pr.id and s.started_at >= v_from and s.started_at < v_to)
  ), '[]'::jsonb);
end $$;
revoke all on function public.attendance_day(date) from public, anon;
grant execute on function public.attendance_day(date) to authenticated;

-- ------------------------------------------------------------ writes --
-- Log in ("in"), start a break ("break"), end it ("back"), log out ("out").
-- Pressing twice (two devices, a double tap) changes nothing. Returns my
-- attendance as attendance_me() does.
create or replace function public.attendance_act(p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  o public.work_session;
  v_break uuid;
begin
  if not public._att_tracked() then raise exception 'Admins don''t log attendance'; end if;
  if p_action not in ('in', 'break', 'back', 'out') then raise exception 'Unknown action'; end if;
  perform pg_advisory_xact_lock(hashtext('attendance:' || v_me::text));
  perform public._attendance_close(v_me);
  select * into o from public.work_session where user_id = v_me and ended_at is null;
  if o.id is not null then
    select id into v_break from public.work_break where session_id = o.id and ended_at is null;
  end if;

  if p_action = 'in' then
    if o.id is null then
      insert into public.work_session (user_id) values (v_me);
    end if;
  elsif p_action = 'break' then
    if o.id is null then raise exception 'Log in first'; end if;
    if v_break is null then
      insert into public.work_break (session_id, user_id) values (o.id, v_me);
    end if;
  elsif p_action = 'back' then
    if v_break is not null then
      update public.work_break set ended_at = now() where id = v_break;
    end if;
  else
    if o.id is not null then
      update public.work_break set ended_at = now() where id = v_break;
      update public.work_session set ended_at = now() where id = o.id;
    end if;
  end if;
  return public.attendance_me();
end $$;
revoke all on function public.attendance_act(text) from public, anon;
grant execute on function public.attendance_act(text) to authenticated;

-- Every hour: close the sessions nobody logged out of.
do $$
begin
  perform cron.unschedule('attendance-tick') where exists (select 1 from cron.job where jobname = 'attendance-tick');
  perform cron.schedule('attendance-tick', '7 * * * *', 'select public._attendance_close(null)');
end $$;

-- ------------------------------------------------- 2. deliveries due soon --
-- What's due from now to p_days ahead, and anything late, on the active
-- projects I can see (admins: all): each open delivery date and each
-- project's final date. "projects": how many active projects I can see.
create or replace function public.home_deliveries(p_days integer default 3)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin();
  v_until timestamptz := now() + make_interval(days => least(greatest(coalesce(p_days, 3), 1), 30));
begin
  if not public.am_active() then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'projects', (select count(*) from public.project p
                  where p.status in ('active', 'on_hold') and (v_admin or public.can_see_project(p.id))),
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.due_at, x.project)
        from (
          select p.id as project_id, p.title as project, c.name as client, p.priority, p.status,
                 null::uuid as delivery_id, 'Final delivery' as title, p.due_at,
                 null::text as assignee, null::text as assignee_avatar
            from public.project p
            left join public.client c on c.id = p.client_id
           where p.status in ('active', 'on_hold') and p.due_at is not null and p.due_at <= v_until
             and (v_admin or public.can_see_project(p.id))
          union all
          select p.id, p.title, c.name, p.priority, p.status,
                 d.id, d.title, d.due_at,
                 a.display_name, a.avatar_url
            from public.project_delivery d
            join public.project p on p.id = d.project_id
            left join public.client c on c.id = p.client_id
            left join public.profile a on a.id = d.assignee_id
           where d.done_at is null and p.status in ('active', 'on_hold') and d.due_at <= v_until
             and (v_admin or public.can_see_project(p.id))
        ) x), '[]'::jsonb));
end $$;
revoke all on function public.home_deliveries(integer) from public, anon;
grant execute on function public.home_deliveries(integer) to authenticated;

-- ------------------------------------------------------ 3. alerts count --
-- Open alerts I can see (admins: all of them), as on the Alerts page.
create or replace function public.watch_open_count()
returns integer language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := public.is_admin();
begin
  if not public.am_active() then return 0; end if;
  return (select count(*) from public.watch_alert a
           where a.status = 'open'
             and (v_admin or exists (select 1 from public.watch_recipient r where r.alert_id = a.id and r.user_id = auth.uid())));
end $$;
revoke all on function public.watch_open_count() from public, anon;
grant execute on function public.watch_open_count() to authenticated;
