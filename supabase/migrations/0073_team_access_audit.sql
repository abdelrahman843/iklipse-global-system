-- 0073_team_access_audit.sql
--   1. The bell: its number counts what came since I last looked, so opening
--      the notifications clears it (each one stays unread until opened).
--   2. Everyone on a project does everything in it (edit it, the team, the
--      dates, the files, the notes, the client's contacts) except the money
--      and the invoices (admins) and sending deliveries to the client (links,
--      rounds: admins and delivery managers). They make deliveries for it and
--      put the work in them.
--   3. The activity log: who made, changed or deleted what, and when, across
--      iklipse (admins read it). Bots, syncs and timers are left out; a
--      client's comments and feedback on a delivery are in, under their name.

-- ------------------------------------------------------------------ 1. bell --
create table if not exists public.notification_seen (
  user_id uuid primary key references public.profile(id) on delete cascade,
  seen_at timestamptz not null default now()
);
alter table public.notification_seen enable row level security;
revoke all on public.notification_seen from anon, authenticated;

-- I looked at my notifications.
create or replace function public.notifications_seen()
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.notification_seen (user_id, seen_at) values (auth.uid(), v)
  on conflict (user_id) do update set seen_at = excluded.seen_at;
  return v;
end $$;
revoke all on function public.notifications_seen() from public, anon;
grant execute on function public.notifications_seen() to authenticated;

-- The bell's number: unread ones that came after I last looked.
create or replace function public.notifications_badge()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.notification n
   where n.user_id = auth.uid() and n.read_at is null
     and n.created_at > coalesce((select s.seen_at from public.notification_seen s where s.user_id = auth.uid()), '-infinity');
$$;
revoke all on function public.notifications_badge() from public, anon;
grant execute on function public.notifications_badge() to authenticated;

-- ---------------------------------------------------------- 2. projects --
-- Same as 0058, with the client's contacts for the whole team.
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
    'client', (select to_jsonb(c) from public.client c where c.id = p.client_id),
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

-- Same as 0058; the people to put on a team (or on a date) for everyone.
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
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.display_name, 'avatar_url', pr.avatar_url, 'role', pr.role)
                       order by lower(pr.display_name))
        from public.profile pr where pr.is_active), '[]'::jsonb)
  );
end $$;

-- New projects: admins. Changes: the team too, but the client and the cost
-- stay with admins.
create or replace function public.project_save(
  p_id uuid, p_client uuid, p_title text, p_description text, p_status text, p_priority text,
  p_start_on date, p_due_at timestamptz, p_cost numeric, p_currency text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_old   public.project;
  v_admin boolean := public.is_admin();
begin
  if p_id is null then
    if not v_admin then raise exception 'Admins only'; end if;
    insert into public.project (client_id, title, description, status, priority, start_on, due_at, cost, currency,
                                delivered_at, created_by)
    values (p_client, btrim(p_title), nullif(btrim(p_description), ''), p_status, p_priority, p_start_on, p_due_at,
            p_cost, coalesce(nullif(upper(btrim(p_currency)), ''), 'USD'),
            case when p_status = 'delivered' then now() end, auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  if not public.can_see_project(p_id) then raise exception 'Project not found'; end if;
  select * into v_old from public.project where id = p_id for update;
  if not found then raise exception 'Project not found'; end if;
  update public.project
     set client_id = case when v_admin then p_client else v_old.client_id end,
         title = btrim(p_title), description = nullif(btrim(p_description), ''),
         status = p_status, priority = p_priority, start_on = p_start_on, due_at = p_due_at,
         cost = case when v_admin then p_cost else v_old.cost end,
         currency = case when v_admin then coalesce(nullif(upper(btrim(p_currency)), ''), 'USD') else v_old.currency end,
         delivered_at = case when p_status = 'delivered' then coalesce(v_old.delivered_at, now()) end,
         updated_at = now()
   where id = p_id;
  if p_due_at is distinct from v_old.due_at and p_due_at is not null then
    perform public._project_notify(p_id, 'project_due_changed',
      jsonb_build_object('by', public._me_name(), 'when', public._when(p_due_at), 'due', p_due_at), auth.uid());
  end if;
  return p_id;
end $$;

-- The team: [{ user_id, role }]. New people are told they were added.
create or replace function public.project_members_set(p_id uuid, p_members jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_new boolean;
begin
  if not public.can_see_project(p_id) then raise exception 'Project not found'; end if;
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
  if not public.can_see_project(p_project) then raise exception 'Project not found'; end if;
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
  delete from public.project_delivery d where d.id = p_id and public.can_see_project(d.project_id);
end $$;

create or replace function public.project_note_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.project_note n where n.id = p_id and public.can_see_project(n.project_id);
end $$;

-- Mark a file as sent to the client, or move it under a date.
create or replace function public.project_file_update(p_id uuid, p_delivered boolean, p_delivery uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  f public.project_file;
begin
  select * into f from public.project_file where id = p_id;
  if not found or not public.can_see_project(f.project_id) then raise exception 'File not found'; end if;
  if p_delivery is not null and not exists (select 1 from public.project_delivery where id = p_delivery and project_id = f.project_id) then
    raise exception 'Delivery not found';
  end if;
  update public.project_file set delivered = p_delivered, delivery_id = p_delivery where id = p_id;
end $$;

-- Anyone on the project. Returns the stored file to remove.
create or replace function public.project_file_delete(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_path text;
begin
  delete from public.project_file f
   where f.id = p_id and public.can_see_project(f.project_id)
  returning storage_path into v_path;
  return v_path;
end $$;

-- The project's client, from its page: name and contacts (new clients: admins).
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
           phone = nullif(btrim(p_phone), ''), notes = nullif(btrim(p_notes), ''), updated_at = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Client not found'; end if;
  end if;
  return v_id;
end $$;

drop policy if exists projects_delete on storage.objects;
create policy projects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'projects' and public._project_path_ok(name));

-- -------------------------------------------------------- 2. deliveries --
-- Everyone on the delivery's project puts work in it (files, links, Drive,
-- names, order); the links to the client and the rounds stay with managers.
-- Read by the row's own project: a delivery just made is readable at once
-- (insert ... returning), before can_see_delivery() could look it up.
drop policy if exists delivery_folder_read on public.delivery_folder;
create policy delivery_folder_read on public.delivery_folder for select to authenticated
  using (public.can_manage_deliveries() or (project_id is not null and public.can_see_project(project_id)));
drop policy if exists delivery_folder_write on public.delivery_folder;
drop policy if exists delivery_folder_add on public.delivery_folder;
create policy delivery_folder_add on public.delivery_folder for insert to authenticated
  with check (public.can_manage_deliveries() or (project_id is not null and public.can_see_project(project_id)));
drop policy if exists delivery_folder_edit on public.delivery_folder;
create policy delivery_folder_edit on public.delivery_folder for update to authenticated
  using (public.can_see_delivery(id))
  with check (public.can_manage_deliveries() or (project_id is not null and public.can_see_project(project_id)));
drop policy if exists delivery_folder_remove on public.delivery_folder;
create policy delivery_folder_remove on public.delivery_folder for delete to authenticated
  using (public.can_manage_deliveries());

drop policy if exists delivery_item_write on public.delivery_item;
create policy delivery_item_write on public.delivery_item for all to authenticated
  using (public.can_see_delivery(folder_id)) with check (public.can_see_delivery(folder_id));

-- Files: <folder id>/<file>. Whoever sees the delivery reads and writes them.
create or replace function public._delivery_path_ok(p_name text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_fid uuid;
begin
  begin
    v_fid := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  if not exists (select 1 from public.delivery_folder where id = v_fid) then return false; end if;
  return public.can_see_delivery(v_fid);
end $$;

-- Same as 0062, plus work: whether I can put work in it.
create or replace function public._delivery_json(f public.delivery_folder, p_manage boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', f.id, 'title', f.title, 'note', f.note, 'round', f.round, 'state', f.state,
    'project_id', f.project_id, 'project', p.title, 'client', c.name,
    'created_at', f.created_at, 'updated_at', f.updated_at, 'created_by', f.created_by,
    'manage', p_manage,
    'work', p_manage or (f.project_id is not null and public.can_see_project(f.project_id)),
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.position) from public.delivery_item i where i.folder_id = f.id), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(to_jsonb(r) || jsonb_build_object('opened_by_name', a.display_name, 'closed_by_name', b.display_name)
             order by r.number desc)
        from public.delivery_round r
        left join public.profile a on a.id = r.opened_by
        left join public.profile b on b.id = r.closed_by
       where r.folder_id = f.id), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(to_jsonb(k) - 'device_id' || jsonb_build_object('resolved_by_name', b.display_name, 'author_avatar', a.avatar_url)
             order by k.created_at)
        from public.delivery_comment k
        left join public.profile a on a.id = k.author_id
        left join public.profile b on b.id = k.resolved_by
       where k.folder_id = f.id), '[]'::jsonb),
    'links', case when p_manage then coalesce((
      select jsonb_agg(to_jsonb(l) || jsonb_build_object(
               'created_by_name', a.display_name,
               'viewers', coalesce((select jsonb_agg(to_jsonb(v) order by v.first_seen)
                                      from public.delivery_viewer v where v.link_id = l.id), '[]'::jsonb))
             order by l.created_at desc)
        from public.delivery_link l left join public.profile a on a.id = l.created_by
       where l.folder_id = f.id), '[]'::jsonb) else '[]'::jsonb end)
  from (select 1) _
  left join public.project p on p.id = f.project_id
  left join public.client c on c.id = p.client_id;
$$;
revoke all on function public._delivery_json(public.delivery_folder, boolean) from public, anon, authenticated;

-- ------------------------------------------------------- 3. activity log --
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid references public.profile(id) on delete set null,
  actor_name text,
  action     text not null check (action in ('create', 'edit', 'delete')),
  area       text not null,
  entity     text not null,
  row_id     text,
  label      text,
  ref        jsonb not null default '{}'::jsonb,
  changes    jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id, at desc);
create index if not exists audit_log_area_idx on public.audit_log (area, at desc);
create index if not exists audit_log_row_idx on public.audit_log (row_id, at desc);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;

-- Columns that say nothing about what someone did (or must never be copied).
create or replace function public._audit_skip(k text)
returns boolean language sql immutable as $$
  select k in ('id', 'created_at', 'updated_at', 'search', 'preview', 'last_seen_at', 'soon_sent_at', 'late_sent_at',
               'tick_lock', 'hook_at', 'synced_at', 'edited_at', 'updated_by', 'opened_at', 'progress',
               'download_url', 'message_id', 'thread_id')
      or k ~* '(token|secret|password|api_key|key_hash|device)';
$$;

-- A value as the log keeps it: long text and big objects cut short.
create or replace function public._audit_val(v jsonb)
returns jsonb language sql immutable as $$
  select case
    when v is null then 'null'::jsonb
    when jsonb_typeof(v) = 'string' and length(v #>> '{}') > 240 then to_jsonb(left(v #>> '{}', 240) || '…')
    when jsonb_typeof(v) in ('object', 'array') and length(v::text) > 240 then to_jsonb(left(v::text, 240) || '…')
    else v end;
$$;

-- AFTER trigger: tg_argv[0] = area ('board' = Trello or Miro by the board),
-- tg_argv[1] = what it is.
create or replace function public._audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_new     jsonb;
  v_old     jsonb;
  v_row     jsonb;
  v_changes jsonb;
  v_name    text;
  v_area    text := tg_argv[0];
  v_label   text;
  v_ref     jsonb;
  v_kind    text;
begin
  -- People only: bots, syncs and timers (nobody signed in) are left out,
  -- except a client's comment or feedback (they have no account).
  if v_uid is null and tg_table_name not in ('delivery_comment', 'delivery_round', 'wb_comment') then
    return null;
  end if;
  v_new := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row := coalesce(v_new, v_old);

  -- Deleted along with what it belongs to (a card, a board, a project…): the
  -- delete of that one is enough.
  if tg_op = 'DELETE' then
    if tg_table_name <> 'card' and v_row ? 'card_id' and v_row->>'card_id' is not null
       and not exists (select 1 from public.card where id = (v_row->>'card_id')::uuid) then return null; end if;
    if tg_table_name <> 'board' and v_row ? 'board_id' and v_row->>'board_id' is not null
       and not exists (select 1 from public.board where id = (v_row->>'board_id')::uuid) then return null; end if;
    if tg_table_name <> 'project' and v_row ? 'project_id' and v_row->>'project_id' is not null
       and not exists (select 1 from public.project where id = (v_row->>'project_id')::uuid) then return null; end if;
    if v_row ? 'folder_id' and v_row->>'folder_id' is not null
       and not exists (select 1 from public.delivery_folder where id = (v_row->>'folder_id')::uuid) then return null; end if;
    if tg_table_name = 'checklist_item'
       and not exists (select 1 from public.checklist where id = (v_row->>'checklist_id')::uuid) then return null; end if;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(e.key, jsonb_build_array(public._audit_val(v_old -> e.key), public._audit_val(e.value)))
      into v_changes
      from jsonb_each(v_new) e
     where e.value is distinct from v_old -> e.key and not public._audit_skip(e.key);
    if v_changes is null then return null; end if;
  else
    select jsonb_object_agg(e.key, public._audit_val(e.value))
      into v_changes
      from jsonb_each(v_row) e
     where not public._audit_skip(e.key) and e.value <> 'null'::jsonb;
  end if;

  -- Trello or Miro: by the board.
  if v_area = 'board' then
    v_kind := case when tg_table_name = 'board' then v_row->>'kind'
                   else (select kind from public.board where id = (v_row->>'board_id')::uuid) end;
    v_area := case when v_kind = 'whiteboard' then 'miro' else 'trello' end;
  end if;

  if v_uid is not null then select display_name into v_name from public.profile where id = v_uid; end if;
  v_name := coalesce(v_name, v_row->>'author_name', v_row->>'guest_name', v_row->>'submitted_name');

  -- What it's about, to show and to open it.
  v_ref := jsonb_strip_nulls(jsonb_build_object(
    'board_id', v_row->>'board_id', 'card_id', v_row->>'card_id', 'project_id', v_row->>'project_id',
    'folder_id', v_row->>'folder_id', 'kind', v_kind,
    'board', case when tg_table_name <> 'board' and v_row->>'board_id' is not null
                  then (select title from public.board where id = (v_row->>'board_id')::uuid) end,
    'card', case when tg_table_name <> 'card' and v_row->>'card_id' is not null
                 then (select title from public.card where id = (v_row->>'card_id')::uuid) end,
    'project', case when tg_table_name <> 'project' and v_row->>'project_id' is not null
                    then (select title from public.project where id = (v_row->>'project_id')::uuid) end,
    'folder', case when v_row->>'folder_id' is not null
                   then (select title from public.delivery_folder where id = (v_row->>'folder_id')::uuid) end,
    'person', case when v_row->>'user_id' is not null and tg_table_name <> 'profile'
                   then (select display_name from public.profile where id = (v_row->>'user_id')::uuid) end,
    'label_name', case when tg_table_name = 'card_label'
                       then (select name from public.label where id = (v_row->>'label_id')::uuid) end));

  v_label := left(coalesce(v_row->>'title', v_row->>'name', v_row->>'display_name', v_row->>'text',
                           v_row->>'body', v_row->>'label', v_row->>'number', v_ref->>'person'), 160);

  insert into public.audit_log (actor_id, actor_name, action, area, entity, row_id, label, ref, changes)
  values (v_uid, v_name,
          case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'edit' else 'delete' end,
          v_area, coalesce(tg_argv[1], tg_table_name),
          coalesce(v_row->>'id', concat_ws(':', v_row->>'board_id', v_row->>'card_id', v_row->>'project_id',
                                           v_row->>'label_id', v_row->>'user_id')),
          v_label, v_ref, v_changes);
  return null;
end $$;
revoke all on function public._audit() from public, anon, authenticated;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('board', 'board', 'board', true),
      ('list', 'trello', 'list', true),
      ('card', 'trello', 'card', true),
      ('comment', 'trello', 'comment', true),
      ('attachment', 'trello', 'attachment', true),
      ('checklist', 'trello', 'checklist', true),
      ('checklist_item', 'trello', 'checklist item', true),
      ('label', 'board', 'label', true),
      ('card_label', 'trello', 'card label', true),
      ('card_member', 'trello', 'card member', true),
      ('board_member', 'board', 'board member', true),
      ('automation_rule', 'trello', 'automation', true),
      ('custom_field_def', 'trello', 'custom field', true),
      ('wb_comment', 'miro', 'comment', true),
      ('wb_share_link', 'miro', 'share link', true),
      ('client', 'projects', 'client', true),
      ('project', 'projects', 'project', true),
      ('project_member', 'projects', 'team member', true),
      ('project_delivery', 'projects', 'delivery date', true),
      ('project_note', 'projects', 'note', true),
      ('project_file', 'projects', 'file', true),
      ('project_invoice', 'projects', 'invoice', true),
      ('delivery_folder', 'deliveries', 'delivery', true),
      ('delivery_item', 'deliveries', 'file', true),
      ('delivery_link', 'deliveries', 'link', true),
      ('delivery_comment', 'deliveries', 'comment', true),
      ('delivery_round', 'deliveries', 'round', false),
      ('profile', 'users', 'person', true),
      ('brief_link', 'briefs', 'brief', true),
      ('watch_alert', 'alerts', 'alert', true),
      ('watch_settings', 'alerts', 'settings', false),
      ('gmail_share', 'sharing', 'mail sharing', true),
      ('drive_share', 'sharing', 'Drive sharing', true),
      ('invoice', 'invoices', 'invoice', true),
      ('workspace', 'workspace', 'settings', false)
    ) v(tbl, area, entity, all_ops)
  loop
    execute format('drop trigger if exists zz_audit on public.%I', t.tbl);
    execute format('create trigger zz_audit after %s on public.%I for each row execute function public._audit(%L, %L)',
                   case when t.all_ops then 'insert or update or delete' else 'update' end, t.tbl, t.area, t.entity);
  end loop;
end $$;

-- Admins: a page of the log, newest first. Before: the last row's time of the
-- page before; area / person / words narrow it.
create or replace function public.audit_log_page(p_before timestamptz default null, p_area text default null,
                                                 p_actor uuid default null, p_q text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.at desc, x.id desc)
      from (select l.id, l.at, l.actor_id, coalesce(pr.display_name, l.actor_name) as actor_name, pr.avatar_url as actor_avatar,
                   l.action, l.area, l.entity, l.row_id, l.label, l.ref, l.changes
              from public.audit_log l
              left join public.profile pr on pr.id = l.actor_id
             where (p_before is null or l.at < p_before)
               and (p_area is null or l.area = p_area)
               and (p_actor is null or l.actor_id = p_actor)
               and (v_q is null or l.label ilike '%' || v_q || '%' or l.ref::text ilike '%' || v_q || '%'
                    or l.actor_name ilike '%' || v_q || '%' or l.entity ilike '%' || v_q || '%')
             order by l.at desc, l.id desc
             limit least(greatest(coalesce(p_limit, 100), 1), 300)) x), '[]'::jsonb);
end $$;
revoke all on function public.audit_log_page(timestamptz, text, uuid, text, int) from public, anon;
grant execute on function public.audit_log_page(timestamptz, text, uuid, text, int) to authenticated;

-- A year of history is kept.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'audit-cleanup') then
    perform cron.unschedule('audit-cleanup');
  end if;
  perform cron.schedule('audit-cleanup', '17 3 * * *', $c$delete from public.audit_log where at < now() - interval '365 days'$c$);
end $$;
