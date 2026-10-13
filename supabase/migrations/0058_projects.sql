-- 0058_projects.sql
--   Projects: the clients (name, company, email, phone, notes) and their
--   projects. A project has a priority, a status, a final delivery date and
--   more delivery dates along the way, the team working on it, notes, the
--   files (the team's work and what was sent to the client), its cost and the
--   client's invoices for it.
--   Only admins create and change projects and clients. People on a project's
--   team see it (not the money, the invoices or the client's contacts), tick
--   off deliveries, write notes and upload their work. Everyone on the team
--   (and whoever made the project) is told when a delivery is two days away
--   and when it's late, plus new notes, files and dates.
--   Every read and write goes through the functions below; the tables are
--   closed to the app. Files live in the private 'projects' bucket:
--     <project id>/files/...     the team's (everyone on the project)
--     <project id>/invoices/...  invoice files (admins)

-- ----------------------------------------------------------------- tables --
create table if not exists public.client (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 200),
  company    text,
  email      text,
  phone      text,
  notes      text,
  created_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references public.client(id) on delete set null,
  title        text not null check (length(btrim(title)) between 1 and 200),
  description  text,
  status       text not null default 'active' check (status in ('active', 'on_hold', 'delivered', 'cancelled')),
  priority     text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  start_on     date,
  due_at       timestamptz,
  cost         numeric(14,2) check (cost is null or cost >= 0),
  currency     text not null default 'USD',
  delivered_at timestamptz,
  soon_sent_at timestamptz,   -- "due in two days" went out for this due_at
  late_sent_at timestamptz,   -- "late" went out for this due_at
  created_by   uuid references public.profile(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists project_client_idx on public.project (client_id);

create table if not exists public.project_member (
  project_id uuid not null references public.project(id) on delete cascade,
  user_id    uuid not null references public.profile(id) on delete cascade,
  role       text,
  added_by   uuid references public.profile(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_member_user_idx on public.project_member (user_id);

create table if not exists public.project_delivery (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.project(id) on delete cascade,
  title        text not null check (length(btrim(title)) between 1 and 200),
  due_at       timestamptz not null,
  assignee_id  uuid references public.profile(id) on delete set null,
  done_at      timestamptz,
  done_by      uuid references public.profile(id) on delete set null,
  soon_sent_at timestamptz,
  late_sent_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists project_delivery_project_idx on public.project_delivery (project_id, due_at);
create index if not exists project_delivery_open_idx on public.project_delivery (due_at) where done_at is null;

create table if not exists public.project_note (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.project(id) on delete cascade,
  author_id  uuid references public.profile(id) on delete set null,
  body       text not null check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists project_note_project_idx on public.project_note (project_id, created_at desc);

create table if not exists public.project_file (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.project(id) on delete cascade,
  delivery_id  uuid references public.project_delivery(id) on delete set null,
  name         text not null check (length(btrim(name)) between 1 and 300),
  mime_type    text,
  size         bigint,
  storage_path text unique,
  external_url text,
  delivered    boolean not null default false,   -- sent to the client
  uploaded_by  uuid references public.profile(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (storage_path is not null or external_url is not null)
);
create index if not exists project_file_project_idx on public.project_file (project_id, created_at desc);

create table if not exists public.project_invoice (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.project(id) on delete cascade,
  number       text,
  amount       numeric(14,2) not null check (amount >= 0),
  currency     text not null default 'USD',
  issued_on    date,
  due_on       date,
  paid_on      date,
  note         text,
  storage_path text,
  file_name    text,
  created_by   uuid references public.profile(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists project_invoice_project_idx on public.project_invoice (project_id, issued_on desc);

alter table public.client           enable row level security;
alter table public.project          enable row level security;
alter table public.project_member   enable row level security;
alter table public.project_delivery enable row level security;
alter table public.project_note     enable row level security;
alter table public.project_file     enable row level security;
alter table public.project_invoice  enable row level security;
revoke all on public.client, public.project, public.project_member, public.project_delivery,
              public.project_note, public.project_file, public.project_invoice from anon, authenticated;

-- A new due date gets its own "soon" / "late" alerts.
create or replace function public._project_due_reset()
returns trigger language plpgsql as $$
begin
  if new.due_at is distinct from old.due_at then
    new.soon_sent_at := null;
    new.late_sent_at := null;
  end if;
  return new;
end $$;
drop trigger if exists project_due_reset on public.project;
create trigger project_due_reset before update on public.project
  for each row execute function public._project_due_reset();
drop trigger if exists project_delivery_due_reset on public.project_delivery;
create trigger project_delivery_due_reset before update on public.project_delivery
  for each row execute function public._project_due_reset();

-- ---------------------------------------------------------------- helpers --
create or replace function public.can_see_project(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from public.project_member m join public.profile pr on pr.id = m.user_id
                  where m.project_id = p and m.user_id = auth.uid() and pr.is_active);
$$;
revoke all on function public.can_see_project(uuid) from public, anon;
grant execute on function public.can_see_project(uuid) to authenticated;

-- Storage paths: <project>/files/... for the team, <project>/invoices/... for admins.
create or replace function public._project_path_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_pid uuid;
  v_dir text := split_part(p_name, '/', 2);
begin
  begin
    v_pid := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  if v_dir = 'invoices' then return public.is_admin() and exists (select 1 from public.project where id = v_pid); end if;
  if v_dir <> 'files' then return false; end if;
  return public.can_see_project(v_pid);
end $$;
revoke all on function public._project_path_ok(text) from public, anon;
grant execute on function public._project_path_ok(text) to authenticated;

-- Tell the team (and whoever made the project), except p_except.
create or replace function public._project_notify(p_project uuid, p_kind text, p_data jsonb, p_except uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification (user_id, kind, data)
  select x.u, p_kind,
         coalesce(p_data, '{}'::jsonb)
           || jsonb_build_object('project_id', p_project, 'project', (select title from public.project where id = p_project))
    from (select m.user_id as u from public.project_member m where m.project_id = p_project
          union
          select p.created_by from public.project p where p.id = p_project and p.created_by is not null) x
    join public.profile pr on pr.id = x.u and pr.is_active
   where p_except is null or x.u <> p_except;
end $$;
revoke all on function public._project_notify(uuid, text, jsonb, uuid) from public, anon, authenticated;

create or replace function public._me_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select display_name from public.profile where id = auth.uid()), 'Someone');
$$;
revoke all on function public._me_name() from public, anon, authenticated;

create or replace function public._when(p timestamptz)
returns text language sql stable as $$
  select to_char(p at time zone 'Africa/Cairo', 'Dy DD Mon, HH24:MI');
$$;

-- A project as the list and the page see it. The money, the client's id and
-- contacts only for admins.
create or replace function public._project_json(p public.project, p_admin boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'description', p.description, 'status', p.status, 'priority', p.priority,
    'start_on', p.start_on, 'due_at', p.due_at, 'delivered_at', p.delivered_at,
    'created_at', p.created_at, 'updated_at', p.updated_at,
    'client', (select jsonb_build_object('name', c.name, 'company', c.company) from public.client c where c.id = p.client_id),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'name', pr.display_name, 'avatar_url', pr.avatar_url)
                       order by m.added_at)
        from public.project_member m join public.profile pr on pr.id = m.user_id
       where m.project_id = p.id), '[]'::jsonb),
    'deliveries_total', (select count(*) from public.project_delivery d where d.project_id = p.id),
    'deliveries_done', (select count(*) from public.project_delivery d where d.project_id = p.id and d.done_at is not null),
    'next_due', (select jsonb_build_object('title', d.title, 'due_at', d.due_at)
                   from public.project_delivery d where d.project_id = p.id and d.done_at is null
                  order by d.due_at limit 1),
    'files_count', (select count(*) from public.project_file f where f.project_id = p.id)
  ) || case when p_admin then jsonb_build_object(
    'client_id', p.client_id, 'cost', p.cost, 'currency', p.currency,
    'invoiced', (select coalesce(sum(i.amount), 0) from public.project_invoice i where i.project_id = p.id and i.currency = p.currency),
    'paid', (select coalesce(sum(i.amount), 0) from public.project_invoice i
              where i.project_id = p.id and i.currency = p.currency and i.paid_on is not null)
  ) else '{}'::jsonb end;
$$;
revoke all on function public._project_json(public.project, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------------ reads --
-- The projects I can see (admins: all), plus for admins the clients and the
-- people to put on a team.
create or replace function public.projects_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  return jsonb_build_object(
    'admin', v_admin,
    'projects', coalesce((
      select jsonb_agg(public._project_json(p, v_admin) order by p.created_at desc)
        from public.project p
       where v_admin or public.can_see_project(p.id)), '[]'::jsonb),
    'clients', case when v_admin then coalesce((
      select jsonb_agg(to_jsonb(c) || jsonb_build_object(
               'projects', (select count(*) from public.project p where p.client_id = c.id),
               'open', (select count(*) from public.project p where p.client_id = c.id and p.status in ('active', 'on_hold')))
             order by lower(c.name))
        from public.client c), '[]'::jsonb) else '[]'::jsonb end,
    'people', case when v_admin then coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.display_name, 'avatar_url', pr.avatar_url, 'role', pr.role)
                       order by lower(pr.display_name))
        from public.profile pr where pr.is_active), '[]'::jsonb) else '[]'::jsonb end
  );
end $$;
revoke all on function public.projects_overview() from public, anon;
grant execute on function public.projects_overview() to authenticated;

-- How many projects I'm on (the sidebar shows Projects when there are any).
create or replace function public.projects_count()
returns integer language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then (select count(*) from public.project)::int
              else (select count(*) from public.project_member m where m.user_id = auth.uid())::int end;
$$;
revoke all on function public.projects_count() from public, anon;
grant execute on function public.projects_count() to authenticated;

create or replace function public.project_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin();
  p public.project;
begin
  if not public.can_see_project(p_id) then raise exception 'Project not found'; end if;
  select * into p from public.project where id = p_id;
  if not found then raise exception 'Project not found'; end if;
  return public._project_json(p, v_admin) || jsonb_build_object(
    'admin', v_admin,
    'client', case when v_admin then (select to_jsonb(c) from public.client c where c.id = p.client_id)
                   else (select jsonb_build_object('name', c.name, 'company', c.company) from public.client c where c.id = p.client_id) end,
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'title', d.title, 'due_at', d.due_at, 'done_at', d.done_at,
               'assignee_id', d.assignee_id, 'assignee', a.display_name, 'assignee_avatar', a.avatar_url,
               'done_by', b.display_name)
             order by d.due_at, d.created_at)
        from public.project_delivery d
        left join public.profile a on a.id = d.assignee_id
        left join public.profile b on b.id = d.done_by
       where d.project_id = p.id), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'body', n.body, 'created_at', n.created_at,
               'author_id', n.author_id, 'author', a.display_name, 'author_avatar', a.avatar_url)
             order by n.created_at desc)
        from public.project_note n left join public.profile a on a.id = n.author_id
       where n.project_id = p.id), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'name', f.name, 'mime_type', f.mime_type, 'size', f.size,
               'storage_path', f.storage_path, 'external_url', f.external_url, 'delivered', f.delivered,
               'delivery_id', f.delivery_id, 'delivery', d.title,
               'uploaded_by', f.uploaded_by, 'uploader', a.display_name, 'created_at', f.created_at)
             order by f.created_at desc)
        from public.project_file f
        left join public.profile a on a.id = f.uploaded_by
        left join public.project_delivery d on d.id = f.delivery_id
       where f.project_id = p.id), '[]'::jsonb),
    'invoices', case when v_admin then coalesce((
      select jsonb_agg(to_jsonb(i) order by i.issued_on desc nulls last, i.created_at desc)
        from public.project_invoice i where i.project_id = p.id), '[]'::jsonb) else '[]'::jsonb end
  );
end $$;
revoke all on function public.project_get(uuid) from public, anon;
grant execute on function public.project_get(uuid) to authenticated;

-- ---------------------------------------------------------- admin: clients --
create or replace function public.client_save(p_id uuid, p_name text, p_company text, p_email text, p_phone text, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_id is null then
    insert into public.client (name, company, email, phone, notes, created_by)
    values (btrim(p_name), nullif(btrim(p_company), ''), nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''),
            nullif(btrim(p_notes), ''), auth.uid())
    returning id into v_id;
  else
    update public.client
       set name = btrim(p_name), company = nullif(btrim(p_company), ''), email = nullif(btrim(p_email), ''),
           phone = nullif(btrim(p_phone), ''), notes = nullif(btrim(p_notes), ''), updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Client not found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.client_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  delete from public.client where id = p_id;   -- their projects stay, without a client
end $$;

-- --------------------------------------------------------- admin: projects --
create or replace function public.project_save(
  p_id uuid, p_client uuid, p_title text, p_description text, p_status text, p_priority text,
  p_start_on date, p_due_at timestamptz, p_cost numeric, p_currency text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id  uuid;
  v_old public.project;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_id is null then
    insert into public.project (client_id, title, description, status, priority, start_on, due_at, cost, currency,
                                delivered_at, created_by)
    values (p_client, btrim(p_title), nullif(btrim(p_description), ''), p_status, p_priority, p_start_on, p_due_at,
            p_cost, coalesce(nullif(upper(btrim(p_currency)), ''), 'USD'),
            case when p_status = 'delivered' then now() end, auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into v_old from public.project where id = p_id for update;
  if not found then raise exception 'Project not found'; end if;
  update public.project
     set client_id = p_client, title = btrim(p_title), description = nullif(btrim(p_description), ''),
         status = p_status, priority = p_priority, start_on = p_start_on, due_at = p_due_at, cost = p_cost,
         currency = coalesce(nullif(upper(btrim(p_currency)), ''), 'USD'),
         delivered_at = case when p_status = 'delivered' then coalesce(v_old.delivered_at, now()) end,
         updated_at = now()
   where id = p_id;
  if p_due_at is distinct from v_old.due_at and p_due_at is not null then
    perform public._project_notify(p_id, 'project_due_changed',
      jsonb_build_object('by', public._me_name(), 'when', public._when(p_due_at), 'due', p_due_at), auth.uid());
  end if;
  return p_id;
end $$;

-- Deletes the project; returns its stored files so the app removes them too.
create or replace function public.project_delete(p_id uuid)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_paths text[];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select coalesce(array_agg(x), '{}') into v_paths from (
    select storage_path x from public.project_file where project_id = p_id and storage_path is not null
    union all
    select storage_path from public.project_invoice where project_id = p_id and storage_path is not null) s;
  delete from public.project where id = p_id;
  return v_paths;
end $$;

-- The team: [{ user_id, role }]. New people are told they were added.
create or replace function public.project_members_set(p_id uuid, p_members jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_new boolean;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if not exists (select 1 from public.project where id = p_id) then raise exception 'Project not found'; end if;
  delete from public.project_member m
   where m.project_id = p_id
     and not exists (select 1 from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) x
                      where x->>'user_id' = m.user_id::text);
  for r in
    select distinct on (pr.id) pr.id as uid, nullif(btrim(x->>'role'), '') as role
      from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) x
      join public.profile pr on pr.id = (x->>'user_id')::uuid and pr.is_active
  loop
    insert into public.project_member (project_id, user_id, role, added_by)
    values (p_id, r.uid, left(r.role, 80), auth.uid())
    on conflict (project_id, user_id) do update set role = excluded.role
    returning (xmax = 0) into v_new;
    if v_new and r.uid <> auth.uid() then
      insert into public.notification (user_id, kind, data)
      values (r.uid, 'project_added', jsonb_build_object(
        'project_id', p_id, 'project', (select title from public.project where id = p_id),
        'by', public._me_name(), 'role', r.role));
    end if;
  end loop;
end $$;

-- A delivery date (new when p_id is null). The person must be on the team.
create or replace function public.project_delivery_save(p_id uuid, p_project uuid, p_title text, p_due_at timestamptz, p_assignee uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id  uuid;
  v_old public.project_delivery;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_due_at is null then raise exception 'Pick the date'; end if;
  if p_assignee is not null and not exists (select 1 from public.project_member where project_id = p_project and user_id = p_assignee) then
    raise exception 'Add them to the team first';
  end if;
  if p_id is null then
    insert into public.project_delivery (project_id, title, due_at, assignee_id)
    values (p_project, btrim(p_title), p_due_at, p_assignee)
    returning id into v_id;
    perform public._project_notify(p_project, 'project_due_changed',
      jsonb_build_object('by', public._me_name(), 'delivery', btrim(p_title), 'added', true,
                         'when', public._when(p_due_at), 'due', p_due_at), auth.uid());
    return v_id;
  end if;
  select * into v_old from public.project_delivery where id = p_id and project_id = p_project for update;
  if not found then raise exception 'Delivery not found'; end if;
  update public.project_delivery set title = btrim(p_title), due_at = p_due_at, assignee_id = p_assignee where id = p_id;
  if p_due_at is distinct from v_old.due_at then
    perform public._project_notify(p_project, 'project_due_changed',
      jsonb_build_object('by', public._me_name(), 'delivery', btrim(p_title),
                         'when', public._when(p_due_at), 'due', p_due_at), auth.uid());
  end if;
  return p_id;
end $$;

create or replace function public.project_delivery_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  delete from public.project_delivery where id = p_id;
end $$;

-- --------------------------------------------------------- admin: invoices --
create or replace function public.project_invoice_save(
  p_id uuid, p_project uuid, p_number text, p_amount numeric, p_currency text,
  p_issued_on date, p_due_on date, p_paid_on date, p_note text, p_path text, p_file_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Write the amount'; end if;
  if p_path is not null and p_path not like p_project::text || '/invoices/%' then raise exception 'Bad file'; end if;
  if p_id is null then
    insert into public.project_invoice (project_id, number, amount, currency, issued_on, due_on, paid_on, note,
                                        storage_path, file_name, created_by)
    values (p_project, nullif(btrim(p_number), ''), p_amount, coalesce(nullif(upper(btrim(p_currency)), ''), 'USD'),
            p_issued_on, p_due_on, p_paid_on, nullif(btrim(p_note), ''), p_path, p_file_name, auth.uid())
    returning id into v_id;
  else
    update public.project_invoice
       set number = nullif(btrim(p_number), ''), amount = p_amount,
           currency = coalesce(nullif(upper(btrim(p_currency)), ''), 'USD'),
           issued_on = p_issued_on, due_on = p_due_on, paid_on = p_paid_on, note = nullif(btrim(p_note), ''),
           storage_path = p_path, file_name = p_file_name, updated_at = now()
     where id = p_id and project_id = p_project
    returning id into v_id;
    if v_id is null then raise exception 'Invoice not found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.project_invoice_delete(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_path text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  delete from public.project_invoice where id = p_id returning storage_path into v_path;
  return v_path;
end $$;

-- ------------------------------------------------------- the whole team --
create or replace function public.project_delivery_done(p_id uuid, p_done boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  d public.project_delivery;
begin
  select * into d from public.project_delivery where id = p_id;
  if not found or not public.can_see_project(d.project_id) then raise exception 'Delivery not found'; end if;
  if p_done and d.done_at is null then
    update public.project_delivery set done_at = now(), done_by = auth.uid() where id = p_id;
    perform public._project_notify(d.project_id, 'project_delivery_done',
      jsonb_build_object('by', public._me_name(), 'delivery', d.title), auth.uid());
  elsif not p_done then
    update public.project_delivery set done_at = null, done_by = null where id = p_id;
  end if;
end $$;

create or replace function public.project_note_add(p_project uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.can_see_project(p_project) then raise exception 'Project not found'; end if;
  insert into public.project_note (project_id, author_id, body) values (p_project, auth.uid(), btrim(p_body))
  returning id into v_id;
  perform public._project_notify(p_project, 'project_note',
    jsonb_build_object('by', public._me_name(), 'excerpt', left(btrim(p_body), 200)), auth.uid());
  return v_id;
end $$;

create or replace function public.project_note_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.project_note n
   where n.id = p_id and (public.is_admin() or (n.author_id = auth.uid() and public.can_see_project(n.project_id)));
end $$;

-- Files uploaded (to <project>/files/...) or links, in one go:
-- [{ name, mime_type, size, storage_path | external_url }]. One notification.
create or replace function public.project_files_add(p_project uuid, p_delivery uuid, p_files jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  f jsonb;
  v_path text;
  v_url  text;
  v_n    integer := 0;
  v_name text;
begin
  if not public.can_see_project(p_project) then raise exception 'Project not found'; end if;
  if p_delivery is not null and not exists (select 1 from public.project_delivery where id = p_delivery and project_id = p_project) then
    raise exception 'Delivery not found';
  end if;
  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    v_path := nullif(f->>'storage_path', '');
    v_url  := nullif(btrim(f->>'external_url'), '');
    if v_path is not null then
      if v_path not like p_project::text || '/files/%'
         or not exists (select 1 from storage.objects o where o.bucket_id = 'projects' and o.name = v_path) then
        raise exception 'Bad file';
      end if;
      v_url := null;
    elsif v_url is null or v_url !~* '^https?://' then
      raise exception 'Bad link';
    end if;
    v_name := left(btrim(coalesce(nullif(f->>'name', ''), v_url, 'File')), 300);
    insert into public.project_file (project_id, delivery_id, name, mime_type, size, storage_path, external_url, uploaded_by)
    values (p_project, p_delivery, v_name, nullif(f->>'mime_type', ''), nullif(f->>'size', '')::bigint, v_path, v_url, auth.uid());
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform public._project_notify(p_project, 'project_file',
      jsonb_build_object('by', public._me_name(), 'count', v_n, 'name', v_name,
                         'delivery', (select title from public.project_delivery where id = p_delivery)), auth.uid());
  end if;
end $$;

-- Admins: mark a file as sent to the client, or move it under a delivery.
create or replace function public.project_file_update(p_id uuid, p_delivered boolean, p_delivery uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  f public.project_file;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select * into f from public.project_file where id = p_id;
  if not found then raise exception 'File not found'; end if;
  if p_delivery is not null and not exists (select 1 from public.project_delivery where id = p_delivery and project_id = f.project_id) then
    raise exception 'Delivery not found';
  end if;
  update public.project_file set delivered = p_delivered, delivery_id = p_delivery where id = p_id;
end $$;

-- Whoever uploaded it, or an admin. Returns the stored file to remove.
create or replace function public.project_file_delete(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_path text;
begin
  delete from public.project_file f
   where f.id = p_id and (public.is_admin() or (f.uploaded_by = auth.uid() and public.can_see_project(f.project_id)))
  returning storage_path into v_path;
  return v_path;
end $$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'client_save(uuid, text, text, text, text, text)', 'client_delete(uuid)',
    'project_save(uuid, uuid, text, text, text, text, date, timestamptz, numeric, text)', 'project_delete(uuid)',
    'project_members_set(uuid, jsonb)', 'project_delivery_save(uuid, uuid, text, timestamptz, uuid)',
    'project_delivery_delete(uuid)', 'project_invoice_save(uuid, uuid, text, numeric, text, date, date, date, text, text, text)',
    'project_invoice_delete(uuid)', 'project_delivery_done(uuid, boolean)', 'project_note_add(uuid, text)',
    'project_note_delete(uuid)', 'project_files_add(uuid, uuid, jsonb)', 'project_file_update(uuid, boolean, uuid)',
    'project_file_delete(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------- storage --
insert into storage.buckets (id, name, public, file_size_limit)
values ('projects', 'projects', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists projects_read on storage.objects;
create policy projects_read on storage.objects for select to authenticated
  using (bucket_id = 'projects' and public._project_path_ok(name));
drop policy if exists projects_insert on storage.objects;
create policy projects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'projects' and owner = auth.uid() and public._project_path_ok(name));
drop policy if exists projects_delete on storage.objects;
create policy projects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'projects' and public._project_path_ok(name) and (owner = auth.uid() or public.is_admin()));

-- ------------------------------------------------------------ due alerts --
-- Every 15 minutes: two days before a delivery (or the project's final date)
-- and once it's late, the team hears about it. Active projects only.
create or replace function public._projects_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  for r in
    select d.id, d.project_id, d.title, d.due_at, d.due_at <= now() as late
      from public.project_delivery d join public.project p on p.id = d.project_id
     where d.done_at is null and p.status = 'active' and d.late_sent_at is null
       and (d.due_at <= now() or (d.soon_sent_at is null and d.due_at <= now() + interval '48 hours'))
  loop
    perform public._project_notify(r.project_id, case when r.late then 'project_overdue' else 'project_due_soon' end,
      jsonb_build_object('delivery', r.title, 'when', public._when(r.due_at), 'due', r.due_at), null);
    if r.late then
      update public.project_delivery set late_sent_at = now(), soon_sent_at = coalesce(soon_sent_at, now()) where id = r.id;
    else
      update public.project_delivery set soon_sent_at = now() where id = r.id;
    end if;
  end loop;

  for r in
    select p.id, p.due_at, p.due_at <= now() as late
      from public.project p
     where p.status = 'active' and p.due_at is not null and p.late_sent_at is null
       and (p.due_at <= now() or (p.soon_sent_at is null and p.due_at <= now() + interval '48 hours'))
  loop
    perform public._project_notify(r.id, case when r.late then 'project_overdue' else 'project_due_soon' end,
      jsonb_build_object('when', public._when(r.due_at), 'due', r.due_at), null);
    if r.late then
      update public.project set late_sent_at = now(), soon_sent_at = coalesce(soon_sent_at, now()) where id = r.id;
    else
      update public.project set soon_sent_at = now() where id = r.id;
    end if;
  end loop;
end $$;
revoke all on function public._projects_tick() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('projects-tick') where exists (select 1 from cron.job where jobname = 'projects-tick');
  perform cron.schedule('projects-tick', '*/15 * * * *', 'select public._projects_tick()');
end $$;

-- ---------------------------------------------- notifications to channels --
-- Same as 0057, plus the project ones.
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
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared?tab=mail';
  elsif new.kind like 'drive\_%' then
    v_link := v_app || '/#/shared?tab=drive';
  elsif new.kind = 'invoice_needs_file' then
    v_link := v_app || '/#/invoices?tab=files';
  elsif new.kind in ('invoice_saved', 'refund_saved') then
    v_link := v_app || '/#/invoices' || coalesce('?month=' || left(new.data->>'month', 7), '');
  elsif new.kind like 'project\_%' then
    v_link := v_app || '/#/projects/' || (new.data->>'project_id') || case when new.kind = 'project_file' then '?tab=files' else '' end;
  elsif v_kind = 'whiteboard' then
    v_link := v_app || '/#/wb/' || new.board_id
              || coalesce('?doc=' || (new.data->>'doc_id'), '?comment=' || (new.data->>'thread_id'), '');
  else
    v_link := v_app || '/#/pm/boards/' || new.board_id || coalesce('/cards/' || new.card_id, '');
  end if;
  v_msg := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
           || coalesce(E'\n"' || nullif(new.data->>'excerpt', '') || '"', '')
           || coalesce(E'\n' || v_link, '');
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  begin
    if c.user_id is not null and c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'iklipse: ' || v_msg); end if;
    if c.user_id is not null and c.notify_email then perform public._send_email(new.user_id, 'iklipse: ' || v_what, v_msg); end if;
    -- Shared mail, Drive, invoices and projects go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' or new.kind like 'project\_%'
                                        or new.kind in ('invoice_saved', 'refund_saved', 'invoice_needs_file') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

notify pgrst, 'reload schema';
