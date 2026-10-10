-- 0053_gmail_share.sql
--   Sharing a connected Gmail account with other people in iklipse. The owner
--   picks who and what they may do:
--     full       same as the owner: read, send, archive, star, delete
--     read_send  read everything and send
--     read       read everything
--     send       send new mail from the address (reads only emails shared below)
--     custom     only some emails: everything from the senders listed and the
--                emails the owner picks one by one, optionally replying to them
--   Emails picked one by one (gmail_share_thread) work with any access that
--   doesn't already read everything. Shared mail shows on its own page
--   (Shared mail), apart from the person's own accounts.
--
--   Tokens never leave the server: the gmail edge function checks every call
--   against these rows and writes what others did (gmail_share_log) for the
--   owner to see.

create table if not exists public.gmail_share (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.gmail_account(id) on delete cascade,
  owner_id    uuid not null references public.profile(id) on delete cascade,
  grantee_id  uuid not null references public.profile(id) on delete cascade,
  access      text not null check (access in ('full', 'read_send', 'read', 'send', 'custom')),
  senders     text[] not null default '{}',
  can_reply   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (account_id, grantee_id),
  check (grantee_id <> owner_id)
);
create index if not exists gmail_share_grantee_idx on public.gmail_share (grantee_id);
create index if not exists gmail_share_owner_idx on public.gmail_share (owner_id);

create table if not exists public.gmail_share_thread (
  share_id   uuid not null references public.gmail_share(id) on delete cascade,
  thread_id  text not null,
  subject    text,
  shared_at  timestamptz not null default now(),
  primary key (share_id, thread_id)
);

create table if not exists public.gmail_share_log (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references public.gmail_account(id) on delete cascade,
  actor_id    uuid not null references public.profile(id) on delete cascade,
  action      text not null,
  detail      text,
  at          timestamptz not null default now()
);
create index if not exists gmail_share_log_account_idx on public.gmail_share_log (account_id, at desc);

alter table public.gmail_share enable row level security;
alter table public.gmail_share_thread enable row level security;
alter table public.gmail_share_log enable row level security;
-- No policies: the functions below and the gmail edge function (service role) only.
revoke all on public.gmail_share, public.gmail_share_thread, public.gmail_share_log from anon, authenticated;

-- "a@b.com", "@b.com" or "b.com" -> lower case, domains as "@b.com"; junk dropped.
create or replace function public._gmail_senders(p text[])
returns text[] language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct s order by s), '{}')
    from (
      select case when x like '%@%' then x else '@' || x end as s
        from (select lower(btrim(v)) as x from unnest(coalesce(p, '{}')) as v) a
       where x ~ '^[^@\s<>,;]*@?[^@\s<>,;]+\.[^@\s<>,;]+$'
    ) b;
$$;

-- Signed in, session not revoked, account switched on.
create or replace function public._gmail_caller_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public._login_current()
     and exists (select 1 from public.profile where id = auth.uid() and is_active);
$$;
revoke all on function public._gmail_caller_ok() from public, anon, authenticated;

create or replace function public._gmail_owned(p_account uuid)
returns public.gmail_account language plpgsql stable security definer set search_path = public as $$
declare a public.gmail_account;
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  select * into a from public.gmail_account where id = p_account and user_id = auth.uid();
  if a.id is null then raise exception 'That Gmail account isn''t yours'; end if;
  return a;
end $$;
revoke all on function public._gmail_owned(uuid) from public, anon, authenticated;

create or replace function public._gmail_me_name()
returns text language sql stable security definer set search_path = public as $$
  select display_name from public.profile where id = auth.uid();
$$;
revoke all on function public._gmail_me_name() from public, anon, authenticated;

-- Give someone access to one of my accounts, or change what they can do.
create or replace function public.gmail_share_set(p_account uuid, p_grantee uuid, p_access text, p_senders text[] default '{}', p_can_reply boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a        public.gmail_account := public._gmail_owned(p_account);
  v_send   text[] := public._gmail_senders(p_senders);
  v_id     uuid;
  v_new    boolean;
begin
  if p_access not in ('full', 'read_send', 'read', 'send', 'custom') then raise exception 'Pick what they can do'; end if;
  if p_grantee = auth.uid() then raise exception 'That''s you'; end if;
  if not exists (select 1 from public.profile where id = p_grantee and is_active) then raise exception 'Pick someone from the team'; end if;
  if cardinality(v_send) > 50 then raise exception 'Up to 50 senders'; end if;
  select id into v_id from public.gmail_share where account_id = a.id and grantee_id = p_grantee;
  v_new := v_id is null;
  insert into public.gmail_share as s (account_id, owner_id, grantee_id, access, senders, can_reply)
  values (a.id, a.user_id, p_grantee, p_access,
          case when p_access in ('send', 'custom') then v_send else '{}' end,
          coalesce(p_can_reply, false) and p_access in ('send', 'custom'))
  on conflict (account_id, grantee_id) do update
     set access = excluded.access, senders = excluded.senders, can_reply = excluded.can_reply, updated_at = now()
  returning s.id into v_id;
  -- Reading everything makes the hand-picked emails pointless.
  if p_access in ('full', 'read_send', 'read') then delete from public.gmail_share_thread where share_id = v_id; end if;
  if v_new then
    perform public.notify_users(array[p_grantee], null, null, 'mail_shared',
      jsonb_build_object('by', public._gmail_me_name(), 'account_email', a.email, 'access', p_access, 'share_id', v_id));
  end if;
  return v_id;
end $$;

-- The owner stops sharing, or the person gives the access back.
create or replace function public.gmail_share_remove(p_share uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  delete from public.gmail_share where id = p_share and (owner_id = auth.uid() or grantee_id = auth.uid());
end $$;

-- Share one conversation with someone. 'already' when they read everything anyway.
create or replace function public.gmail_share_thread_add(p_account uuid, p_grantee uuid, p_thread text, p_subject text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  a     public.gmail_account := public._gmail_owned(p_account);
  s     public.gmail_share;
begin
  if p_thread is null or p_thread !~ '^[0-9a-zA-Z]{6,40}$' then raise exception 'Pick an email'; end if;
  if p_grantee = auth.uid() then raise exception 'That''s you'; end if;
  if not exists (select 1 from public.profile where id = p_grantee and is_active) then raise exception 'Pick someone from the team'; end if;
  select * into s from public.gmail_share where account_id = a.id and grantee_id = p_grantee;
  if s.id is not null and s.access in ('full', 'read_send', 'read') then return 'already'; end if;
  if s.id is null then
    insert into public.gmail_share (account_id, owner_id, grantee_id, access)
    values (a.id, a.user_id, p_grantee, 'custom') returning * into s;
  end if;
  insert into public.gmail_share_thread (share_id, thread_id, subject)
  values (s.id, p_thread, left(nullif(btrim(p_subject), ''), 300))
  on conflict (share_id, thread_id) do nothing;
  if not found then return 'already'; end if;
  perform public.notify_users(array[p_grantee], null, null, 'mail_thread_shared',
    jsonb_build_object('by', public._gmail_me_name(), 'account_email', a.email, 'share_id', s.id,
                       'thread_id', p_thread, 'excerpt', left(nullif(btrim(p_subject), ''), 140)));
  return 'added';
end $$;

create or replace function public.gmail_share_thread_remove(p_share uuid, p_thread text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  delete from public.gmail_share_thread t
   using public.gmail_share s
   where t.share_id = s.id and s.id = p_share and s.owner_id = auth.uid() and t.thread_id = p_thread;
end $$;

-- My accounts: who has access, what they can do, and what they did lately.
create or replace function public.gmail_shares_mine()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public._gmail_caller_ok() then coalesce((
    select jsonb_agg(jsonb_build_object(
      'account_id', g.id,
      'email', g.email,
      'shares', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'grantee_id', s.grantee_id, 'name', p.display_name, 'username', p.username,
          'avatar_url', p.avatar_url, 'access', s.access, 'senders', to_jsonb(s.senders), 'can_reply', s.can_reply,
          'created_at', s.created_at,
          'threads', coalesce((
            select jsonb_agg(jsonb_build_object('thread_id', t.thread_id, 'subject', t.subject, 'shared_at', t.shared_at)
                             order by t.shared_at desc)
              from public.gmail_share_thread t where t.share_id = s.id), '[]'::jsonb))
          order by p.display_name)
          from public.gmail_share s join public.profile p on p.id = s.grantee_id
         where s.account_id = g.id), '[]'::jsonb),
      'log', coalesce((
        select jsonb_agg(jsonb_build_object('action', l.action, 'detail', l.detail, 'at', l.at,
                                            'actor_id', l.actor_id, 'actor_name', p.display_name) order by l.at desc)
          from (select * from public.gmail_share_log where account_id = g.id order by at desc limit 30) l
          join public.profile p on p.id = l.actor_id), '[]'::jsonb))
      order by g.connected_at)
      from public.gmail_account g where g.user_id = auth.uid()), '[]'::jsonb) end;
$$;

-- Gmail accounts other people shared with me.
create or replace function public.gmail_shared_with_me()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public._gmail_caller_ok() then coalesce((
    select jsonb_agg(jsonb_build_object(
      'share_id', s.id, 'account_id', g.id, 'email', g.email,
      'owner_id', s.owner_id, 'owner_name', p.display_name, 'owner_avatar', p.avatar_url,
      'access', s.access, 'senders', to_jsonb(s.senders), 'can_reply', s.can_reply,
      'threads', (select count(*) from public.gmail_share_thread t where t.share_id = s.id),
      'created_at', s.created_at)
      order by p.display_name, g.email)
      from public.gmail_share s
      join public.gmail_account g on g.id = s.account_id
      join public.profile p on p.id = s.owner_id
     where s.grantee_id = auth.uid() and p.is_active), '[]'::jsonb) end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'gmail_share_set(uuid, uuid, text, text[], boolean)', 'gmail_share_remove(uuid)',
    'gmail_share_thread_add(uuid, uuid, text, text)', 'gmail_share_thread_remove(uuid, text)',
    'gmail_shares_mine()', 'gmail_shared_with_me()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------- notifications to channels --
-- Same as 0050, plus mail shared with you (no board: it links to Shared mail).
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
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared-mail';
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
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
