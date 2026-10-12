-- 0054_drive.sql
--   Google Drive, the same way as Gmail (0052, 0053): each person connects any
--   number of Drive accounts, browses them in iklipse (the Drive page), and can
--   share one with other people in iklipse:
--     full    same as the owner: open, download, upload, rename, star, delete
--     edit    open and download everything, upload, make folders, rename
--     read    open and download everything
--     custom  only the files and folders the owner picks (a folder brings
--             everything in it), optionally with upload and rename inside
--   Files and folders picked one by one (drive_share_item) work with any access
--   that doesn't already open everything. What's shared with a person shows on
--   their Shared page, next to shared mail.
--
--   Tokens never leave the server: the drive edge function checks every call
--   against these rows and writes what others did (drive_share_log) for the
--   owner to see.

-- --------------------------------------------------------------- accounts --
create table if not exists public.drive_account (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profile(id) on delete cascade,
  email         text not null,
  name          text,
  access_token  text,
  refresh_token text not null,
  token_expiry  timestamptz,
  scope         text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, email)
);
create index if not exists drive_account_user_idx on public.drive_account (user_id);
alter table public.drive_account enable row level security;
-- No policies on purpose: only the service role (the edge function) reads it.
revoke all on public.drive_account from anon, authenticated;

-- ---------------------------------------------------------------- sharing --
create table if not exists public.drive_share (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.drive_account(id) on delete cascade,
  owner_id    uuid not null references public.profile(id) on delete cascade,
  grantee_id  uuid not null references public.profile(id) on delete cascade,
  access      text not null check (access in ('full', 'edit', 'read', 'custom')),
  can_edit    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (account_id, grantee_id),
  check (grantee_id <> owner_id)
);
create index if not exists drive_share_grantee_idx on public.drive_share (grantee_id);
create index if not exists drive_share_owner_idx on public.drive_share (owner_id);

create table if not exists public.drive_share_item (
  share_id   uuid not null references public.drive_share(id) on delete cascade,
  file_id    text not null,
  name       text,
  mime       text,
  shared_at  timestamptz not null default now(),
  primary key (share_id, file_id)
);

create table if not exists public.drive_share_log (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references public.drive_account(id) on delete cascade,
  actor_id    uuid not null references public.profile(id) on delete cascade,
  action      text not null,
  detail      text,
  at          timestamptz not null default now()
);
create index if not exists drive_share_log_account_idx on public.drive_share_log (account_id, at desc);

alter table public.drive_share enable row level security;
alter table public.drive_share_item enable row level security;
alter table public.drive_share_log enable row level security;
-- No policies: the functions below and the drive edge function (service role) only.
revoke all on public.drive_share, public.drive_share_item, public.drive_share_log from anon, authenticated;

create or replace function public._drive_owned(p_account uuid)
returns public.drive_account language plpgsql stable security definer set search_path = public as $$
declare a public.drive_account;
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  select * into a from public.drive_account where id = p_account and user_id = auth.uid();
  if a.id is null then raise exception 'That Drive account isn''t yours'; end if;
  return a;
end $$;
revoke all on function public._drive_owned(uuid) from public, anon, authenticated;

-- Give someone access to one of my Drive accounts, or change what they can do.
create or replace function public.drive_share_set(p_account uuid, p_grantee uuid, p_access text, p_can_edit boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a      public.drive_account := public._drive_owned(p_account);
  v_id   uuid;
  v_new  boolean;
begin
  if p_access not in ('full', 'edit', 'read', 'custom') then raise exception 'Pick what they can do'; end if;
  if p_grantee = auth.uid() then raise exception 'That''s you'; end if;
  if not exists (select 1 from public.profile where id = p_grantee and is_active) then raise exception 'Pick someone from the team'; end if;
  select id into v_id from public.drive_share where account_id = a.id and grantee_id = p_grantee;
  v_new := v_id is null;
  insert into public.drive_share as s (account_id, owner_id, grantee_id, access, can_edit)
  values (a.id, a.user_id, p_grantee, p_access, coalesce(p_can_edit, false) and p_access = 'custom')
  on conflict (account_id, grantee_id) do update
     set access = excluded.access, can_edit = excluded.can_edit, updated_at = now()
  returning s.id into v_id;
  -- Opening everything makes the hand-picked files pointless.
  if p_access <> 'custom' then delete from public.drive_share_item where share_id = v_id; end if;
  if v_new then
    perform public.notify_users(array[p_grantee], null, null, 'drive_shared',
      jsonb_build_object('by', public._gmail_me_name(), 'account_email', a.email, 'access', p_access, 'share_id', v_id));
  end if;
  return v_id;
end $$;

-- The owner stops sharing, or the person gives the access back.
create or replace function public.drive_share_remove(p_share uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  delete from public.drive_share where id = p_share and (owner_id = auth.uid() or grantee_id = auth.uid());
end $$;

-- Share one file or folder with someone. 'already' when they open everything anyway.
-- Any id works: the owner's own token can only reach what their account can.
create or replace function public.drive_share_item_add(p_account uuid, p_grantee uuid, p_file text, p_name text default null, p_mime text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  a  public.drive_account := public._drive_owned(p_account);
  s  public.drive_share;
begin
  if p_file is null or p_file !~ '^[0-9A-Za-z_-]{6,120}$' then raise exception 'Pick a file'; end if;
  if p_grantee = auth.uid() then raise exception 'That''s you'; end if;
  if not exists (select 1 from public.profile where id = p_grantee and is_active) then raise exception 'Pick someone from the team'; end if;
  select * into s from public.drive_share where account_id = a.id and grantee_id = p_grantee;
  if s.id is not null and s.access <> 'custom' then return 'already'; end if;
  if s.id is null then
    insert into public.drive_share (account_id, owner_id, grantee_id, access)
    values (a.id, a.user_id, p_grantee, 'custom') returning * into s;
  end if;
  insert into public.drive_share_item (share_id, file_id, name, mime)
  values (s.id, p_file, left(nullif(btrim(p_name), ''), 300), left(nullif(btrim(p_mime), ''), 200))
  on conflict (share_id, file_id) do nothing;
  if not found then return 'already'; end if;
  perform public.notify_users(array[p_grantee], null, null, 'drive_item_shared',
    jsonb_build_object('by', public._gmail_me_name(), 'account_email', a.email, 'share_id', s.id,
                       'file_id', p_file, 'folder', p_mime = 'application/vnd.google-apps.folder',
                       'excerpt', left(nullif(btrim(p_name), ''), 140)));
  return 'added';
end $$;

create or replace function public.drive_share_item_remove(p_share uuid, p_file text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  delete from public.drive_share_item i
   using public.drive_share s
   where i.share_id = s.id and s.id = p_share and s.owner_id = auth.uid() and i.file_id = p_file;
end $$;

-- My Drive accounts: who has access, what they can do, and what they did lately.
create or replace function public.drive_shares_mine()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public._gmail_caller_ok() then coalesce((
    select jsonb_agg(jsonb_build_object(
      'account_id', d.id,
      'email', d.email,
      'shares', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'grantee_id', s.grantee_id, 'name', p.display_name, 'username', p.username,
          'avatar_url', p.avatar_url, 'access', s.access, 'can_edit', s.can_edit, 'created_at', s.created_at,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object('file_id', i.file_id, 'name', i.name, 'mime', i.mime, 'shared_at', i.shared_at)
                             order by i.shared_at desc)
              from public.drive_share_item i where i.share_id = s.id), '[]'::jsonb))
          order by p.display_name)
          from public.drive_share s join public.profile p on p.id = s.grantee_id
         where s.account_id = d.id), '[]'::jsonb),
      'log', coalesce((
        select jsonb_agg(jsonb_build_object('action', l.action, 'detail', l.detail, 'at', l.at,
                                            'actor_id', l.actor_id, 'actor_name', p.display_name) order by l.at desc)
          from (select * from public.drive_share_log where account_id = d.id order by at desc limit 30) l
          join public.profile p on p.id = l.actor_id), '[]'::jsonb))
      order by d.connected_at)
      from public.drive_account d where d.user_id = auth.uid()), '[]'::jsonb) end;
$$;

-- Drive accounts other people shared with me.
create or replace function public.drive_shared_with_me()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public._gmail_caller_ok() then coalesce((
    select jsonb_agg(jsonb_build_object(
      'share_id', s.id, 'account_id', d.id, 'email', d.email,
      'owner_id', s.owner_id, 'owner_name', p.display_name, 'owner_avatar', p.avatar_url,
      'access', s.access, 'can_edit', s.can_edit,
      'items', (select count(*) from public.drive_share_item i where i.share_id = s.id),
      'created_at', s.created_at)
      order by p.display_name, d.email)
      from public.drive_share s
      join public.drive_account d on d.id = s.account_id
      join public.profile p on p.id = s.owner_id
     where s.grantee_id = auth.uid() and p.is_active), '[]'::jsonb) end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'drive_share_set(uuid, uuid, text, boolean)', 'drive_share_remove(uuid)',
    'drive_share_item_add(uuid, uuid, text, text, text)', 'drive_share_item_remove(uuid, text)',
    'drive_shares_mine()', 'drive_shared_with_me()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- What I have connected (never the tokens): 0052 plus Drive.
create or replace function public.my_connections()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.uid() is not null and public._login_current() then jsonb_build_object(
    'zoom', (select jsonb_build_object('email', z.zoom_email, 'connected_at', z.connected_at)
               from public.zoom_account z where z.user_id = auth.uid()),
    'gmail', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'email', g.email, 'name', g.name, 'connected_at', g.connected_at,
               'sends_notifications', g.id is not distinct from w.notify_gmail_account)
             order by g.connected_at)
        from public.gmail_account g
        cross join (select notify_gmail_account from public.workspace limit 1) w
       where g.user_id = auth.uid()), '[]'::jsonb),
    'drive', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'email', d.email, 'name', d.name, 'connected_at', d.connected_at)
             order by d.connected_at)
        from public.drive_account d
       where d.user_id = auth.uid()), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.my_connections() from public, anon;
grant execute on function public.my_connections() to authenticated;

-- ---------------------------------------------- notifications to channels --
-- Same as 0053, plus Drive shared with you; both now open the Shared page.
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
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared?tab=mail';
  elsif new.kind like 'drive\_%' then
    v_link := v_app || '/#/shared?tab=drive';
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
    -- Shared mail and Drive both go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

notify pgrst, 'reload schema';
