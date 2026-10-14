-- ============================================================================
-- 0062_deliveries.sql
--   Deliveries: what we hand to a client, like a Drive folder with previews.
--
--   delivery_folder   one delivery (title, note, the client's project if any),
--                     its current feedback round and where that round is:
--                     open (client can comment), submitted (client sent
--                     feedback, link is read only) or approved.
--   delivery_item     an image, video, file (private 'deliveries' bucket,
--                     <folder id>/<file>) or a link. Removing one only hides
--                     it, so older rounds still show what the client had.
--   delivery_link     a link for the client: optional expiry, how many
--                     devices and how many people (by email) may open it,
--                     download on / off.
--   delivery_viewer   each browser that opened a link, under a name + email.
--   delivery_comment  comments on images and videos (videos at a second),
--                     from the client or the team, per round.
--   delivery_round    every round: what the client had, when they sent
--                     feedback or approved, their note. "Next round" closes
--                     the round and opens a clean one on the same links.
--
--   Admins and people with profile.delivery_role = 'manage' run deliveries.
--   Everyone on a project sees its deliveries and the feedback (read, reply,
--   tick off). Visitors never touch tables: the delivery_* visitor functions
--   check the token, expiry and limits and return only that delivery.
-- ============================================================================

-- ------------------------------------------------------------ permission --
alter table public.profile add column if not exists delivery_role text;
alter table public.profile drop constraint if exists profile_delivery_role_check;
alter table public.profile add constraint profile_delivery_role_check
  check (delivery_role is null or delivery_role in ('manage', 'none'));

-- Same as 0050, plus delivery_role.
create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role          is distinct from old.role          then raise exception 'Not authorised to change role'; end if;
    if new.trello_role   is distinct from old.trello_role   then raise exception 'Not authorised to change role'; end if;
    if new.miro_role     is distinct from old.miro_role     then raise exception 'Not authorised to change role'; end if;
    if new.brief_role    is distinct from old.brief_role    then raise exception 'Not authorised to change role'; end if;
    if new.delivery_role is distinct from old.delivery_role then raise exception 'Not authorised to change role'; end if;
    if new.is_active     is distinct from old.is_active     then raise exception 'Not authorised to change status'; end if;
    if new.username      is distinct from old.username      then raise exception 'Not authorised to change username'; end if;
    if new.sessions_revoked_at is distinct from old.sessions_revoked_at then
      raise exception 'Not authorised to change sign-in state';
    end if;
  end if;
  return new;
end $$;

create or replace function public.can_manage_deliveries()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (public.is_admin() or exists (
    select 1 from public.profile p where p.id = auth.uid() and p.is_active and p.delivery_role = 'manage'));
$$;
revoke all on function public.can_manage_deliveries() from public, anon;
grant execute on function public.can_manage_deliveries() to authenticated;

-- ----------------------------------------------------------------- tables --
create table if not exists public.delivery_folder (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) between 1 and 120),
  note        text check (note is null or length(note) <= 2000),
  project_id  uuid references public.project(id) on delete set null,
  round       integer not null default 1 check (round >= 1),
  state       text not null default 'open' check (state in ('open', 'submitted', 'approved')),
  created_by  uuid references public.profile(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists delivery_folder_project_idx on public.delivery_folder(project_id);

create table if not exists public.delivery_item (
  id           uuid primary key default gen_random_uuid(),
  folder_id    uuid not null references public.delivery_folder(id) on delete cascade,
  kind         text not null check (kind in ('image', 'video', 'file', 'link')),
  name         text not null check (length(btrim(name)) between 1 and 200),
  storage_path text unique check (storage_path is null or length(storage_path) <= 300),
  external_url text check (external_url is null or (external_url ~* '^https?://' and length(external_url) <= 2000)),
  mime_type    text check (mime_type is null or length(mime_type) <= 120),
  size         bigint check (size is null or size >= 0),
  position     double precision not null default extract(epoch from clock_timestamp()),
  added_round  integer not null default 1,
  removed_at   timestamptz,
  created_by   uuid references public.profile(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  constraint delivery_item_source check (
    (kind = 'link' and external_url is not null and storage_path is null)
    or (kind <> 'link' and storage_path is not null and external_url is null)),
  constraint delivery_item_path check (storage_path is null or split_part(storage_path, '/', 1) = folder_id::text)
);
create index if not exists delivery_item_folder_idx on public.delivery_item(folder_id, position);

create table if not exists public.delivery_link (
  id             uuid primary key default gen_random_uuid(),
  folder_id      uuid not null references public.delivery_folder(id) on delete cascade,
  token          text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  label          text check (label is null or length(label) <= 80),
  max_devices    integer check (max_devices is null or max_devices between 1 and 100),
  max_people     integer check (max_people is null or max_people between 1 and 100),
  expires_at     timestamptz,
  allow_download boolean not null default false,
  created_by     uuid references public.profile(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);
create index if not exists delivery_link_folder_idx on public.delivery_link(folder_id);

create table if not exists public.delivery_viewer (
  link_id     uuid not null references public.delivery_link(id) on delete cascade,
  device_id   text not null check (length(device_id) between 8 and 64),
  name        text not null check (length(btrim(name)) between 1 and 60),
  email       text not null check (length(email) <= 120 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  device_name text check (device_name is null or length(device_name) <= 80),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  opens       integer not null default 0,
  primary key (link_id, device_id)
);

create table if not exists public.delivery_comment (
  id           uuid primary key default gen_random_uuid(),
  folder_id    uuid not null references public.delivery_folder(id) on delete cascade,
  item_id      uuid references public.delivery_item(id) on delete cascade,
  round        integer not null,
  body         text not null check (length(btrim(body)) between 1 and 4000),
  at_seconds   numeric(10, 2) check (at_seconds is null or at_seconds >= 0),
  guest        boolean not null default false,
  author_id    uuid references public.profile(id) on delete set null,
  author_name  text not null check (length(btrim(author_name)) between 1 and 80),
  author_email text check (author_email is null or length(author_email) <= 120),
  link_id      uuid references public.delivery_link(id) on delete set null,
  device_id    text,
  resolved_at  timestamptz,
  resolved_by  uuid references public.profile(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists delivery_comment_folder_idx on public.delivery_comment(folder_id, round, created_at);
create index if not exists delivery_comment_item_idx on public.delivery_comment(item_id);

create table if not exists public.delivery_round (
  id              uuid primary key default gen_random_uuid(),
  folder_id       uuid not null references public.delivery_folder(id) on delete cascade,
  number          integer not null check (number >= 1),
  opened_at       timestamptz not null default now(),
  opened_by       uuid references public.profile(id) on delete set null,
  outcome         text check (outcome is null or outcome in ('feedback', 'approved')),
  submitted_at    timestamptz,
  submitted_name  text,
  submitted_email text,
  client_note     text check (client_note is null or length(client_note) <= 4000),
  closed_at       timestamptz,
  closed_by       uuid references public.profile(id) on delete set null,
  items           jsonb,
  unique (folder_id, number)
);

-- ---------------------------------------------------------------- helpers --
create or replace function public.can_see_delivery(f uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_manage_deliveries()
      or exists (select 1 from public.delivery_folder d
                  where d.id = f and d.project_id is not null and public.can_see_project(d.project_id));
$$;
revoke all on function public.can_see_delivery(uuid) from public, anon;
grant execute on function public.can_see_delivery(uuid) to authenticated;

-- Files: <folder id>/<file>. Read: whoever sees the delivery. Write: managers.
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
  return case when p_write then public.can_manage_deliveries() else public.can_see_delivery(v_fid) end;
end $$;
revoke all on function public._delivery_path_ok(text, boolean) from public, anon;
grant execute on function public._delivery_path_ok(text, boolean) to authenticated;

-- What the client has right now (kept on each round).
create or replace function public._delivery_snapshot(p_folder uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'kind', i.kind, 'name', i.name, 'mime_type', i.mime_type, 'size', i.size,
           'storage_path', i.storage_path, 'external_url', i.external_url, 'added_round', i.added_round)
           order by i.position), '[]'::jsonb)
    from public.delivery_item i where i.folder_id = p_folder and i.removed_at is null;
$$;
revoke all on function public._delivery_snapshot(uuid) from public, anon, authenticated;

-- Tell whoever made the delivery, whoever made the link and the project's
-- team (and whoever made the project).
create or replace function public._delivery_notify(p_folder uuid, p_kind text, p_data jsonb, p_link_by uuid)
returns void language plpgsql security definer set search_path = public as $$
declare f public.delivery_folder;
begin
  select * into f from public.delivery_folder where id = p_folder;
  insert into public.notification (user_id, kind, data)
  select x.u, p_kind,
         coalesce(p_data, '{}'::jsonb) || jsonb_build_object(
           'folder_id', f.id, 'title', f.title, 'round', f.round,
           'project_id', f.project_id, 'project', (select title from public.project where id = f.project_id))
    from (select f.created_by as u
          union select p_link_by
          union select m.user_id from public.project_member m where m.project_id = f.project_id
          union select p.created_by from public.project p where p.id = f.project_id) x
    join public.profile pr on pr.id = x.u and pr.is_active;
end $$;
revoke all on function public._delivery_notify(uuid, text, jsonb, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------- guards --
-- Round and state change only through the round functions below.
create or replace function public.delivery_folder_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.round := 1;
    new.state := 'open';
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if coalesce(current_setting('iklipse.delivery_sys', true), '') <> '1' then
      new.round := old.round;
      new.state := old.state;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists delivery_folder_guard on public.delivery_folder;
create trigger delivery_folder_guard before insert or update on public.delivery_folder
  for each row execute function public.delivery_folder_guard();

create or replace function public.delivery_folder_first_round() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.delivery_round (folder_id, number, opened_by) values (new.id, 1, new.created_by);
  return null;
end $$;
drop trigger if exists delivery_folder_first_round on public.delivery_folder;
create trigger delivery_folder_first_round after insert on public.delivery_folder
  for each row execute function public.delivery_folder_first_round();

-- A file must already be in the bucket under its folder; the source of an
-- item never changes (rename, reorder and remove do).
create or replace function public.delivery_item_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.storage_path is not null and not exists (
         select 1 from storage.objects where bucket_id = 'deliveries' and name = new.storage_path) then
      raise exception 'Upload the file first';
    end if;
    new.added_round := (select round from public.delivery_folder where id = new.folder_id);
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.removed_at := null;
  else
    new.folder_id := old.folder_id;
    new.kind := old.kind;
    new.storage_path := old.storage_path;
    new.external_url := old.external_url;
    new.mime_type := old.mime_type;
    new.size := old.size;
    new.added_round := old.added_round;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;
drop trigger if exists delivery_item_guard on public.delivery_item;
create trigger delivery_item_guard before insert or update on public.delivery_item
  for each row execute function public.delivery_item_guard();

create or replace function public.delivery_link_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.token := encode(extensions.gen_random_bytes(24), 'hex');
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.folder_id := old.folder_id;
    new.token := old.token;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;
drop trigger if exists delivery_link_guard on public.delivery_link;
create trigger delivery_link_guard before insert or update on public.delivery_link
  for each row execute function public.delivery_link_guard();

-- The team writes as itself into the current round; visitors only through
-- the visitor functions (which set iklipse.delivery_visitor). Afterwards only
-- the text (by its author) and the tick change.
create or replace function public.delivery_comment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_item public.delivery_item;
begin
  if tg_op = 'INSERT' then
    if coalesce(current_setting('iklipse.delivery_visitor', true), '') <> '1' then
      if auth.uid() is null then raise exception 'Not signed in'; end if;
      new.author_id := auth.uid();
      new.author_name := coalesce((select display_name from public.profile where id = auth.uid()), 'Team');
      new.author_email := null;
      new.guest := false;
      new.link_id := null;
      new.device_id := null;
    end if;
    new.round := (select round from public.delivery_folder where id = new.folder_id);
    if new.item_id is not null then
      select * into v_item from public.delivery_item where id = new.item_id;
      if v_item.id is null or v_item.folder_id <> new.folder_id then raise exception 'That file is not in this delivery'; end if;
      if v_item.kind <> 'video' then new.at_seconds := null; end if;
    else
      new.at_seconds := null;
    end if;
    new.resolved_at := null;
    new.resolved_by := null;
    new.created_at := now();
  else
    new.folder_id := old.folder_id;
    new.item_id := old.item_id;
    new.round := old.round;
    new.at_seconds := old.at_seconds;
    new.guest := old.guest;
    new.author_id := old.author_id;
    new.author_name := old.author_name;
    new.author_email := old.author_email;
    new.link_id := old.link_id;
    new.device_id := old.device_id;
    new.created_at := old.created_at;
    if new.body is distinct from old.body and (old.author_id is null or old.author_id is distinct from auth.uid()) then
      raise exception 'Only the author can edit a comment';
    end if;
    if new.resolved_at is distinct from old.resolved_at then
      new.resolved_by := case when new.resolved_at is null then null else auth.uid() end;
      new.resolved_at := case when new.resolved_at is null then null else now() end;
    else
      new.resolved_by := old.resolved_by;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists delivery_comment_guard on public.delivery_comment;
create trigger delivery_comment_guard before insert or update on public.delivery_comment
  for each row execute function public.delivery_comment_guard();

-- -------------------------------------------------------------------- RLS --
alter table public.delivery_folder enable row level security;
alter table public.delivery_item enable row level security;
alter table public.delivery_link enable row level security;
alter table public.delivery_viewer enable row level security;
alter table public.delivery_comment enable row level security;
alter table public.delivery_round enable row level security;
revoke all on public.delivery_folder, public.delivery_item, public.delivery_link,
              public.delivery_viewer, public.delivery_comment, public.delivery_round from anon;

drop policy if exists delivery_folder_read on public.delivery_folder;
create policy delivery_folder_read on public.delivery_folder for select to authenticated using (public.can_see_delivery(id));
drop policy if exists delivery_folder_write on public.delivery_folder;
create policy delivery_folder_write on public.delivery_folder for all to authenticated
  using (public.can_manage_deliveries()) with check (public.can_manage_deliveries());
grant select, insert, update, delete on public.delivery_folder to authenticated;

drop policy if exists delivery_item_read on public.delivery_item;
create policy delivery_item_read on public.delivery_item for select to authenticated using (public.can_see_delivery(folder_id));
drop policy if exists delivery_item_write on public.delivery_item;
create policy delivery_item_write on public.delivery_item for all to authenticated
  using (public.can_manage_deliveries()) with check (public.can_manage_deliveries());
grant select, insert, update, delete on public.delivery_item to authenticated;

drop policy if exists delivery_link_manage on public.delivery_link;
create policy delivery_link_manage on public.delivery_link for all to authenticated
  using (public.can_manage_deliveries()) with check (public.can_manage_deliveries());
grant select, insert, update, delete on public.delivery_link to authenticated;

drop policy if exists delivery_viewer_read on public.delivery_viewer;
create policy delivery_viewer_read on public.delivery_viewer for select to authenticated using (public.can_manage_deliveries());
drop policy if exists delivery_viewer_remove on public.delivery_viewer;
create policy delivery_viewer_remove on public.delivery_viewer for delete to authenticated using (public.can_manage_deliveries());
grant select, delete on public.delivery_viewer to authenticated;

drop policy if exists delivery_comment_read on public.delivery_comment;
create policy delivery_comment_read on public.delivery_comment for select to authenticated using (public.can_see_delivery(folder_id));
drop policy if exists delivery_comment_add on public.delivery_comment;
create policy delivery_comment_add on public.delivery_comment for insert to authenticated with check (public.can_see_delivery(folder_id));
drop policy if exists delivery_comment_edit on public.delivery_comment;
create policy delivery_comment_edit on public.delivery_comment for update to authenticated
  using (public.can_see_delivery(folder_id)) with check (public.can_see_delivery(folder_id));
drop policy if exists delivery_comment_remove on public.delivery_comment;
create policy delivery_comment_remove on public.delivery_comment for delete to authenticated
  using (public.can_manage_deliveries() or (author_id = auth.uid() and public.can_see_delivery(folder_id)));
grant select, insert, update, delete on public.delivery_comment to authenticated;

drop policy if exists delivery_round_read on public.delivery_round;
create policy delivery_round_read on public.delivery_round for select to authenticated using (public.can_see_delivery(folder_id));
grant select on public.delivery_round to authenticated;

-- ------------------------------------------------------------ team reads --
-- The deliveries list, plus (for the folder picker) the projects to file under.
create or replace function public.delivery_folders()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_manage_deliveries() then raise exception 'No access to deliveries'; end if;
  return jsonb_build_object(
    'folders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'title', f.title, 'note', f.note, 'round', f.round, 'state', f.state,
               'project_id', f.project_id, 'project', p.title, 'client', c.name,
               'created_at', f.created_at, 'updated_at', f.updated_at, 'created_by', pr.display_name,
               'items', (select count(*) from public.delivery_item i where i.folder_id = f.id and i.removed_at is null),
               'links', (select count(*) from public.delivery_link l where l.folder_id = f.id and l.revoked_at is null
                                                                     and (l.expires_at is null or l.expires_at > now())),
               'open_comments', (select count(*) from public.delivery_comment k
                                  where k.folder_id = f.id and k.round = f.round and k.guest and k.resolved_at is null),
               'last_activity', greatest(f.updated_at,
                                         (select max(k.created_at) from public.delivery_comment k where k.folder_id = f.id),
                                         (select max(r.submitted_at) from public.delivery_round r where r.folder_id = f.id)))
             order by f.updated_at desc)
        from public.delivery_folder f
        left join public.project p on p.id = f.project_id
        left join public.client c on c.id = p.client_id
        left join public.profile pr on pr.id = f.created_by), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'client', c.name, 'status', p.status)
             order by p.status = 'active' desc, p.created_at desc)
        from public.project p left join public.client c on c.id = p.client_id), '[]'::jsonb));
end $$;
revoke all on function public.delivery_folders() from public, anon;
grant execute on function public.delivery_folders() to authenticated;

-- One delivery with everything: files (removed ones too, for history),
-- links and who opened them (managers), every round and every comment.
create or replace function public._delivery_json(f public.delivery_folder, p_manage boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', f.id, 'title', f.title, 'note', f.note, 'round', f.round, 'state', f.state,
    'project_id', f.project_id, 'project', p.title, 'client', c.name,
    'created_at', f.created_at, 'updated_at', f.updated_at, 'created_by', f.created_by,
    'manage', p_manage,
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

create or replace function public.delivery_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f public.delivery_folder;
begin
  if not public.can_see_delivery(p_id) then raise exception 'Delivery not found'; end if;
  select * into f from public.delivery_folder where id = p_id;
  if not found then raise exception 'Delivery not found'; end if;
  return public._delivery_json(f, public.can_manage_deliveries());
end $$;
revoke all on function public.delivery_get(uuid) from public, anon;
grant execute on function public.delivery_get(uuid) to authenticated;

-- A project's deliveries (the project page's Deliveries and Feedback tabs).
create or replace function public.delivery_for_project(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_manage boolean := public.can_manage_deliveries();
begin
  if not (v_manage or public.can_see_project(p_project)) then raise exception 'Project not found'; end if;
  return coalesce((select jsonb_agg(public._delivery_json(f, v_manage) order by f.created_at desc)
                     from public.delivery_folder f where f.project_id = p_project), '[]'::jsonb);
end $$;
revoke all on function public.delivery_for_project(uuid) from public, anon;
grant execute on function public.delivery_for_project(uuid) to authenticated;

-- ---------------------------------------------------------------- rounds --
-- After fixing what the client asked for: close this round (keeping what they
-- had and said) and open a clean one on the same links. p_clear = false only
-- reopens the round for more comments.
create or replace function public.delivery_next_round(p_folder uuid, p_clear boolean default true)
returns integer language plpgsql security definer set search_path = public as $$
declare f public.delivery_folder;
begin
  if not public.can_manage_deliveries() then raise exception 'No access to deliveries'; end if;
  select * into f from public.delivery_folder where id = p_folder for update;
  if not found then raise exception 'Delivery not found'; end if;
  perform set_config('iklipse.delivery_sys', '1', true);
  if p_clear then
    update public.delivery_round
       set closed_at = now(), closed_by = auth.uid(), items = coalesce(items, public._delivery_snapshot(f.id))
     where folder_id = f.id and number = f.round;
    insert into public.delivery_round (folder_id, number, opened_by) values (f.id, f.round + 1, auth.uid());
    update public.delivery_folder set round = f.round + 1, state = 'open' where id = f.id;
  else
    update public.delivery_round
       set outcome = null, submitted_at = null, submitted_name = null, submitted_email = null, client_note = null, items = null
     where folder_id = f.id and number = f.round;
    update public.delivery_folder set state = 'open' where id = f.id;
  end if;
  perform set_config('iklipse.delivery_sys', '', true);
  return case when p_clear then f.round + 1 else f.round end;
end $$;
revoke all on function public.delivery_next_round(uuid, boolean) from public, anon;
grant execute on function public.delivery_next_round(uuid, boolean) to authenticated;

-- -------------------------------------------------------------- visitors --
-- The link behind a token, if it can be used right now. A new device must say
-- who it is (name + email); the device and people limits are counted here.
create or replace function public._delivery_check(p_token text, p_device text, p_name text, p_email text, p_agent text)
returns public.delivery_link language plpgsql security definer set search_path = public as $$
declare
  l public.delivery_link;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  n integer;
  v_new boolean;
begin
  if p_token is null or length(p_token) < 20 or p_device is null or length(p_device) not between 8 and 64 then
    raise exception 'This link is not valid';
  end if;
  select * into l from public.delivery_link where token = p_token;
  if l.id is null then raise exception 'This link is not valid'; end if;
  if l.revoked_at is not null then raise exception 'This link was turned off'; end if;
  if l.expires_at is not null and l.expires_at <= now() then raise exception 'This link has expired'; end if;

  if exists (select 1 from public.delivery_viewer where link_id = l.id and device_id = p_device) then
    update public.delivery_viewer set last_seen = now() where link_id = l.id and device_id = p_device;
    return l;
  end if;

  if v_name = '' or v_email = '' then raise exception 'IDENTIFY'; end if;
  if length(v_name) > 60 then raise exception 'That name is too long'; end if;
  if length(v_email) > 120 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Check your email address'; end if;

  -- New device: only while there's room (locked so two at once can't both squeeze in).
  perform 1 from public.delivery_link where id = l.id for update;
  select count(*) into n from public.delivery_viewer where link_id = l.id;
  if l.max_devices is not null and n >= l.max_devices then
    raise exception 'This link is already open on the most devices it allows';
  end if;
  if l.max_people is not null and not exists (select 1 from public.delivery_viewer where link_id = l.id and email = v_email) then
    select count(distinct email) into n from public.delivery_viewer where link_id = l.id;
    if n >= l.max_people then raise exception 'This link is already open for the most people it allows'; end if;
  end if;
  v_new := not exists (select 1 from public.delivery_viewer where link_id = l.id and email = v_email);
  insert into public.delivery_viewer (link_id, device_id, name, email, device_name)
  values (l.id, p_device, v_name, v_email, nullif(left(btrim(coalesce(p_agent, '')), 80), ''));
  -- Someone new opened it (not the same person on another device).
  if v_new then perform public._delivery_notify(l.folder_id, 'delivery_opened',
            jsonb_build_object('by', v_name, 'email', v_email, 'link', l.label), l.created_by); end if;
  return l;
end $$;
revoke all on function public._delivery_check(text, text, text, text, text) from public, anon, authenticated;

create or replace function public._delivery_comment_json(k public.delivery_comment, p_device text)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', k.id, 'item_id', k.item_id, 'body', k.body, 'at_seconds', k.at_seconds,
                            'author', k.author_name, 'guest', k.guest, 'mine', k.guest and k.device_id = p_device,
                            'resolved', k.resolved_at is not null, 'created_at', k.created_at);
$$;
revoke all on function public._delivery_comment_json(public.delivery_comment, text) from public, anon, authenticated;

-- Open a delivery: what's in it and this round's comments.
create or replace function public.delivery_open(p_token text, p_device text, p_name text default null,
                                                p_email text default null, p_agent text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.delivery_link;
  f public.delivery_folder;
  r public.delivery_round;
  v public.delivery_viewer;
begin
  l := public._delivery_check(p_token, p_device, p_name, p_email, p_agent);
  update public.delivery_viewer set opens = opens + 1 where link_id = l.id and device_id = p_device returning * into v;
  select * into f from public.delivery_folder where id = l.folder_id;
  select * into r from public.delivery_round where folder_id = f.id and number = f.round;
  return jsonb_build_object(
    'folder', jsonb_build_object('title', f.title, 'note', f.note, 'round', f.round, 'state', f.state,
                                 'client', (select c.name from public.project p join public.client c on c.id = p.client_id
                                             where p.id = f.project_id)),
    'round', jsonb_build_object('number', r.number, 'outcome', r.outcome, 'submitted_at', r.submitted_at,
                                'submitted_name', r.submitted_name),
    'link', jsonb_build_object('label', l.label, 'allow_download', l.allow_download, 'expires_at', l.expires_at),
    'viewer', jsonb_build_object('name', v.name, 'email', v.email),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'name', i.name, 'mime_type', i.mime_type,
                                          'size', i.size, 'external_url', i.external_url,
                                          'is_new', i.added_round = f.round and f.round > 1)
             order by i.position)
        from public.delivery_item i where i.folder_id = f.id and i.removed_at is null), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(public._delivery_comment_json(k, p_device) order by k.created_at)
        from public.delivery_comment k
        join public.delivery_item i on i.id = k.item_id and i.removed_at is null
       where k.folder_id = f.id and k.round = f.round), '[]'::jsonb));
end $$;
revoke all on function public.delivery_open(text, text, text, text, text) from public;
grant execute on function public.delivery_open(text, text, text, text, text) to anon, authenticated;

-- Comment on an image or a video (videos: at a second), while the round is open.
create or replace function public.delivery_comment_add(p_token text, p_device text, p_item uuid, p_body text,
                                                       p_at numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.delivery_link;
  f public.delivery_folder;
  v public.delivery_viewer;
  i public.delivery_item;
  k public.delivery_comment;
begin
  if p_body is null or length(btrim(p_body)) not between 1 and 4000 then raise exception 'Write a comment first'; end if;
  l := public._delivery_check(p_token, p_device, null, null, null);
  select * into f from public.delivery_folder where id = l.folder_id;
  if f.state <> 'open' then raise exception 'Your feedback for this round was already sent'; end if;
  select * into i from public.delivery_item where id = p_item and folder_id = f.id and removed_at is null;
  if i.id is null or i.kind not in ('image', 'video') then raise exception 'Comments are for images and videos'; end if;
  if (select count(*) from public.delivery_comment
       where link_id = l.id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Too many comments at once. Try again in a minute.';
  end if;
  select * into v from public.delivery_viewer where link_id = l.id and device_id = p_device;
  perform set_config('iklipse.delivery_visitor', '1', true);
  insert into public.delivery_comment (folder_id, item_id, body, at_seconds, guest, author_name, author_email, link_id, device_id)
  values (f.id, i.id, btrim(p_body), case when i.kind = 'video' and p_at is not null then round(greatest(p_at, 0), 2) end,
          true, v.name, v.email, l.id, p_device)
  returning * into k;
  perform set_config('iklipse.delivery_visitor', '', true);
  return public._delivery_comment_json(k, p_device);
end $$;
revoke all on function public.delivery_comment_add(text, text, uuid, text, numeric) from public;
grant execute on function public.delivery_comment_add(text, text, uuid, text, numeric) to anon, authenticated;

-- Take back one of my comments (this round, still open).
create or replace function public.delivery_comment_remove(p_token text, p_device text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  l public.delivery_link;
  f public.delivery_folder;
begin
  l := public._delivery_check(p_token, p_device, null, null, null);
  select * into f from public.delivery_folder where id = l.folder_id;
  if f.state <> 'open' then raise exception 'Your feedback for this round was already sent'; end if;
  delete from public.delivery_comment
   where id = p_id and folder_id = f.id and round = f.round and guest and link_id = l.id and device_id = p_device;
  if not found then raise exception 'You can only remove your own comments'; end if;
end $$;
revoke all on function public.delivery_comment_remove(text, text, uuid) from public;
grant execute on function public.delivery_comment_remove(text, text, uuid) to anon, authenticated;

-- Send the round's feedback, or approve. The link turns read only until the
-- team opens the next round.
create or replace function public.delivery_submit(p_token text, p_device text, p_outcome text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  l public.delivery_link;
  f public.delivery_folder;
  v public.delivery_viewer;
  n integer;
begin
  if p_outcome not in ('feedback', 'approved') then raise exception 'Choose send feedback or approve'; end if;
  if p_note is not null and length(p_note) > 4000 then raise exception 'That note is too long'; end if;
  l := public._delivery_check(p_token, p_device, null, null, null);
  select * into f from public.delivery_folder where id = l.folder_id for update;
  if f.state <> 'open' then raise exception 'Your feedback for this round was already sent'; end if;
  select count(*) into n from public.delivery_comment where folder_id = f.id and round = f.round and guest;
  if p_outcome = 'feedback' and n = 0 and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Add a comment or a note first';
  end if;
  select * into v from public.delivery_viewer where link_id = l.id and device_id = p_device;
  update public.delivery_round
     set outcome = p_outcome, submitted_at = now(), submitted_name = v.name, submitted_email = v.email,
         client_note = nullif(btrim(coalesce(p_note, '')), ''), items = public._delivery_snapshot(f.id)
   where folder_id = f.id and number = f.round;
  perform set_config('iklipse.delivery_sys', '1', true);
  update public.delivery_folder set state = case when p_outcome = 'approved' then 'approved' else 'submitted' end where id = f.id;
  perform set_config('iklipse.delivery_sys', '', true);
  perform public._delivery_notify(f.id, case when p_outcome = 'approved' then 'delivery_approved' else 'delivery_feedback' end,
            jsonb_build_object('by', v.name, 'email', v.email, 'comments', n,
                               'excerpt', left(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g'), 140)),
            l.created_by);
end $$;
revoke all on function public.delivery_submit(text, text, text, text) from public;
grant execute on function public.delivery_submit(text, text, text, text) to anon, authenticated;

-- The media service (edge function delivery-media) asks which files a link
-- may see, and whether it may download them.
create or replace function public.delivery_media(p_token text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.delivery_link;
begin
  l := public._delivery_check(p_token, p_device, null, null, null);
  return jsonb_build_object(
    'allow_download', l.allow_download,
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'path', i.storage_path, 'name', i.name, 'kind', i.kind))
                         from public.delivery_item i
                        where i.folder_id = l.folder_id and i.removed_at is null and i.storage_path is not null), '[]'::jsonb));
end $$;
revoke all on function public.delivery_media(text, text) from public, anon, authenticated;
grant execute on function public.delivery_media(text, text) to service_role;

-- ---------------------------------------------------------------- storage --
insert into storage.buckets (id, name, public, file_size_limit)
values ('deliveries', 'deliveries', false, 5368709120)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists deliveries_read on storage.objects;
create policy deliveries_read on storage.objects for select to authenticated
  using (bucket_id = 'deliveries' and public._delivery_path_ok(name, false));
drop policy if exists deliveries_insert on storage.objects;
create policy deliveries_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'deliveries' and owner = auth.uid() and public._delivery_path_ok(name, true));
drop policy if exists deliveries_delete on storage.objects;
create policy deliveries_delete on storage.objects for delete to authenticated
  using (bucket_id = 'deliveries' and public._delivery_path_ok(name, true));

-- ---------------------------------------------- notifications to channels --
-- Same as 0059, plus deliveries (opened, feedback sent, approved).
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
    -- Shared mail, Drive, meetings, invoices and projects go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' or new.kind like 'project\_%' or new.kind like 'delivery\_%'
                                        or new.kind in ('invoice_saved', 'refund_saved', 'invoice_needs_file', 'meeting_shared') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

notify pgrst, 'reload schema';
