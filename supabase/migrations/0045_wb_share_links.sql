-- ============================================================================
-- 0045_wb_share_links.sql
--   Share a Miro board with clients by link, no account needed.
--
--   wb_share_link    one link: view or comment, optional expiry, optional
--                    limit on how many devices may open it (1 = one device).
--   wb_share_device  each browser that opened a link (a random id the browser
--                    keeps), so the limit holds and owners see who's in.
--   wb_comment       guests comment under a name (author_id null, guest_name).
--
--   Visitors never touch tables: wb_share_open / wb_share_comment check the
--   token, the expiry and the device limit, and return only that board.
--   Board owners and co-owners (can_manage_board_members) manage the links.
-- ============================================================================

create table if not exists public.wb_share_link (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.board(id) on delete cascade,
  token       text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  label       text check (label is null or length(label) <= 80),
  access      text not null default 'view' check (access in ('view', 'comment')),
  expires_at  timestamptz,
  max_devices integer check (max_devices is null or max_devices between 1 and 1000),
  created_by  uuid references public.profile(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index if not exists wb_share_link_board_idx on public.wb_share_link(board_id);

create table if not exists public.wb_share_device (
  link_id    uuid not null references public.wb_share_link(id) on delete cascade,
  device_id  text not null check (length(device_id) between 8 and 64),
  name       text check (name is null or length(name) <= 60),
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (link_id, device_id)
);

-- Links only for whiteboards; the token and board never change after creation.
create or replace function public.wb_share_link_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.board where id = new.board_id and kind = 'whiteboard') then
      raise exception 'Share links are for Miro boards';
    end if;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.board_id := old.board_id;
    new.token := old.token;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;
drop trigger if exists wb_share_link_guard on public.wb_share_link;
create trigger wb_share_link_guard before insert or update on public.wb_share_link
  for each row execute function public.wb_share_link_guard();

alter table public.wb_share_link enable row level security;
drop policy if exists wb_share_link_manage on public.wb_share_link;
create policy wb_share_link_manage on public.wb_share_link for all to authenticated
  using (public.can_manage_board_members(board_id))
  with check (public.can_manage_board_members(board_id));
grant select, insert, update, delete on public.wb_share_link to authenticated;

alter table public.wb_share_device enable row level security;
drop policy if exists wb_share_device_manage on public.wb_share_device;
create policy wb_share_device_manage on public.wb_share_device for select to authenticated
  using (exists (select 1 from public.wb_share_link l where l.id = link_id and public.can_manage_board_members(l.board_id)));
drop policy if exists wb_share_device_remove on public.wb_share_device;
create policy wb_share_device_remove on public.wb_share_device for delete to authenticated
  using (exists (select 1 from public.wb_share_link l where l.id = link_id and public.can_manage_board_members(l.board_id)));
grant select, delete on public.wb_share_device to authenticated;

-- ------------------------------------------------------- guest comments --
alter table public.wb_comment alter column author_id drop not null;
alter table public.wb_comment add column if not exists guest_name text;
alter table public.wb_comment add column if not exists share_link_id uuid references public.wb_share_link(id) on delete set null;
alter table public.wb_comment drop constraint if exists wb_comment_author_check;
alter table public.wb_comment add constraint wb_comment_author_check
  check (author_id is not null or (guest_name is not null and length(btrim(guest_name)) between 1 and 60));

-- Same as 0038, plus: a guest's name and link stay as written, and nobody
-- else can rewrite a guest's words.
create or replace function public.wb_comment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_root public.wb_comment;
begin
  if tg_op = 'INSERT' then
    new.author_id := coalesce(auth.uid(), new.author_id);
    new.created_at := now();
    new.resolved := false;
    if new.thread_id is not null then
      select * into v_root from public.wb_comment where id = new.thread_id;
      if v_root.id is null or v_root.board_id <> new.board_id or v_root.thread_id is not null then
        raise exception 'Reply must belong to a thread on the same board';
      end if;
      new.item_id := null; new.x := null; new.y := null;
    elsif new.x is null or new.y is null then
      raise exception 'A comment thread needs a position';
    end if;
  else
    new.board_id := old.board_id;
    new.thread_id := old.thread_id;
    new.author_id := old.author_id;
    new.guest_name := old.guest_name;
    new.share_link_id := old.share_link_id;
    new.created_at := old.created_at;
    -- Only the author edits the text; anyone who may comment moves / resolves.
    if auth.uid() is not null and new.body is distinct from old.body and old.author_id is distinct from auth.uid() then
      raise exception 'Only the author can edit a comment';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Notifications for comments: guests have no profile, so "by" is their name,
-- and the board's owners / co-owners hear about every guest comment.
create or replace function public.wb_comment_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_root uuid := coalesce(new.thread_id, new.id);
  v_title text;
  v_by text;
  v_excerpt text := left(regexp_replace(new.body, '\s+', ' ', 'g'), 140);
begin
  select title into v_title from public.board where id = new.board_id;
  if new.author_id is not null then
    select display_name into v_by from public.profile where id = new.author_id;
  else
    v_by := btrim(new.guest_name) || ' (guest)';
  end if;

  -- Mentioned people who can see the board.
  insert into public.notification (user_id, board_id, kind, data)
  select distinct p.id, new.board_id, 'wb_mention',
         jsonb_build_object('comment_id', new.id, 'thread_id', v_root, 'board_title', v_title,
                            'by', v_by, 'excerpt', v_excerpt)
    from regexp_matches(new.body, '@([A-Za-z0-9._-]{3,32})', 'g') m
    join public.profile p on lower(p.username) = lower(m[1])
   where p.is_active and p.id is distinct from new.author_id
     and public._can_see_board_as(p.id, new.board_id);

  -- Replies: everyone else already in the thread (not re-notifying mentions).
  if new.thread_id is not null then
    insert into public.notification (user_id, board_id, kind, data)
    select distinct c.author_id, new.board_id, 'wb_reply',
           jsonb_build_object('comment_id', new.id, 'thread_id', v_root, 'board_title', v_title,
                              'by', v_by, 'excerpt', v_excerpt)
      from public.wb_comment c
      join public.profile p on p.id = c.author_id and p.is_active
     where (c.id = new.thread_id or c.thread_id = new.thread_id)
       and c.author_id is distinct from new.author_id
       and public._can_see_board_as(c.author_id, new.board_id)
       and not exists (
         select 1 from regexp_matches(new.body, '@([A-Za-z0-9._-]{3,32})', 'g') m
          where lower(m[1]) = lower(p.username));
  end if;

  -- A client commented through a share link: tell the board's owners.
  if new.author_id is null then
    insert into public.notification (user_id, board_id, kind, data)
    select distinct bm.user_id, new.board_id, 'wb_guest_comment',
           jsonb_build_object('comment_id', new.id, 'thread_id', v_root, 'board_title', v_title,
                              'by', v_by, 'excerpt', v_excerpt)
      from public.board_member bm
      join public.profile p on p.id = bm.user_id and p.is_active
     where bm.board_id = new.board_id and bm.wb_role in ('owner', 'coowner')
       and not exists (select 1 from public.notification n
                        where n.user_id = bm.user_id and n.kind = 'wb_reply' and n.data->>'comment_id' = new.id::text);
  end if;
  return null;
end $$;

-- ------------------------------------------------------------- visitors --
-- The link behind a token, if it can be used right now (else a clear error).
create or replace function public._wb_share_check(p_token text, p_device text, p_name text default null)
returns public.wb_share_link language plpgsql security definer set search_path = public as $$
declare
  l public.wb_share_link;
  n integer;
begin
  if p_token is null or length(p_token) < 20 or p_device is null or length(p_device) not between 8 and 64 then
    raise exception 'This link is not valid';
  end if;
  select * into l from public.wb_share_link where token = p_token;
  if l.id is null then raise exception 'This link is not valid'; end if;
  if l.revoked_at is not null then raise exception 'This link was turned off'; end if;
  if l.expires_at is not null and l.expires_at <= now() then raise exception 'This link has expired'; end if;

  if exists (select 1 from public.wb_share_device where link_id = l.id and device_id = p_device) then
    update public.wb_share_device
       set last_seen = now(), name = coalesce(nullif(btrim(p_name), ''), name)
     where link_id = l.id and device_id = p_device;
  else
    -- New device: only while there's room (locked so two at once can't both squeeze in).
    perform 1 from public.wb_share_link where id = l.id for update;
    select count(*) into n from public.wb_share_device where link_id = l.id;
    if l.max_devices is not null and n >= l.max_devices then
      raise exception 'This link is already open on the most devices it allows';
    end if;
    insert into public.wb_share_device (link_id, device_id, name)
    values (l.id, p_device, nullif(left(btrim(coalesce(p_name, '')), 60), ''));
  end if;
  return l;
end $$;
revoke all on function public._wb_share_check(text, text, text) from public, anon, authenticated;

-- Open a shared board: the board, what's on it and (comment links) the comments.
create or replace function public.wb_share_open(p_token text, p_device text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.wb_share_link;
  b public.board;
begin
  l := public._wb_share_check(p_token, p_device, p_name);
  select * into b from public.board where id = l.board_id;
  return jsonb_build_object(
    'board', jsonb_build_object('id', b.id, 'title', b.title),
    'link', jsonb_build_object('access', l.access, 'label', l.label, 'expires_at', l.expires_at),
    'items', coalesce((select jsonb_agg(to_jsonb(i) - 'created_by' - 'updated_by') from public.wb_item i where i.board_id = b.id), '[]'::jsonb),
    'comments', case when l.access = 'comment' then coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', c.id, 'thread_id', c.thread_id, 'item_id', c.item_id, 'x', c.x, 'y', c.y,
                 'body', c.body, 'resolved', c.resolved, 'created_at', c.created_at,
                 'author', coalesce(p.display_name, btrim(c.guest_name)),
                 'guest', c.author_id is null)
                 order by c.created_at)
          from public.wb_comment c left join public.profile p on p.id = c.author_id
         where c.board_id = b.id
           -- Open threads only (a reply follows its thread).
           and not coalesce((select r.resolved from public.wb_comment r where r.id = coalesce(c.thread_id, c.id)), false)), '[]'::jsonb)
      else '[]'::jsonb end);
end $$;
revoke all on function public.wb_share_open(text, text, text) from public;
grant execute on function public.wb_share_open(text, text, text) to anon, authenticated;

-- Comment as a guest (comment links only): a new thread at (x, y), or a reply.
create or replace function public.wb_share_comment(
  p_token text, p_device text, p_name text, p_body text,
  p_thread uuid default null, p_item uuid default null, p_x double precision default null, p_y double precision default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  l public.wb_share_link;
  v_id uuid;
begin
  if p_name is null or length(btrim(p_name)) not between 1 and 60 then raise exception 'Add your name first'; end if;
  if p_body is null or length(btrim(p_body)) not between 1 and 4000 then raise exception 'Write a comment first'; end if;
  l := public._wb_share_check(p_token, p_device, p_name);
  if l.access <> 'comment' then raise exception 'This link is view only'; end if;
  -- A little brake on floods: 30 comments a minute per device.
  if (select count(*) from public.wb_comment
       where share_link_id = l.id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Too many comments at once. Try again in a minute.';
  end if;
  insert into public.wb_comment (board_id, thread_id, item_id, x, y, author_id, guest_name, share_link_id, body)
  values (l.board_id, p_thread, case when p_thread is null then p_item end,
          case when p_thread is null then p_x end, case when p_thread is null then p_y end,
          null, btrim(p_name), l.id, btrim(p_body))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.wb_share_comment(text, text, text, text, uuid, uuid, double precision, double precision) from public;
grant execute on function public.wb_share_comment(text, text, text, text, uuid, uuid, double precision, double precision) to anon, authenticated;

-- The media service (edge function wb-share-media) asks which board a link opens.
create or replace function public.wb_share_board(p_token text, p_device text)
returns uuid language plpgsql security definer set search_path = public as $$
declare l public.wb_share_link;
begin
  l := public._wb_share_check(p_token, p_device, null);
  return l.board_id;
end $$;
revoke all on function public.wb_share_board(text, text) from public, anon, authenticated;
grant execute on function public.wb_share_board(text, text) to service_role;
