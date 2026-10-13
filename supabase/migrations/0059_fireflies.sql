-- 0059_fireflies.sql
--   Fireflies.ai, each person connecting any number of Fireflies accounts with
--   the account's API key (Fireflies has no sign-in flow for other apps: the
--   key is under Integrations > Fireflies API on fireflies.ai). The
--   `fireflies` edge function checks the key, then keeps a copy of every
--   meeting the account was in (organizer or attendee): title, date, length,
--   who was there, the AI summary and, once someone opens it, the transcript.
--   It syncs on connect, on "Sync now" and every 15 minutes (pg_cron ->
--   fireflies/tick, secret in Vault: fireflies_webhook_url / _secret).
--
--   Sharing a meeting:
--     with people in iklipse  fireflies_share; they get a notification and it
--                             shows on their Shared page
--     by email                a private link (fireflies_link) that opens the
--                             summary and transcript without signing in, sent
--                             from the person's own Gmail or the workspace's
--                             notification sender. The owner can turn it off.
--   The API keys never leave the server.

-- --------------------------------------------------------------- accounts --
create table if not exists public.fireflies_account (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profile(id) on delete cascade,
  ff_user_id    text not null,
  email         text,
  name          text,
  api_key       text not null,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_sync_at  timestamptz,
  last_error    text,
  backfill_done boolean not null default false,
  backfill_skip integer not null default 0,
  unique (user_id, ff_user_id)
);
create index if not exists fireflies_account_user_idx on public.fireflies_account (user_id);

create table if not exists public.fireflies_meeting (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.fireflies_account(id) on delete cascade,
  ff_id           text not null,
  title           text,
  started_at      timestamptz,
  duration        numeric,          -- minutes
  organizer_email text,
  participants    text[] not null default '{}',
  attendees       jsonb not null default '[]'::jsonb,
  speakers        jsonb not null default '[]'::jsonb,
  transcript_url  text,
  meeting_link    text,
  summary         jsonb,            -- overview, short_summary, action_items, keywords, bullet_gist, outline, topics
  sentences       jsonb,            -- [{ i, s (speaker), t (text), a (start sec), b (end sec) }], filled on first open
  sentences_at    timestamptz,
  synced_at       timestamptz not null default now(),
  unique (account_id, ff_id)
);
create index if not exists fireflies_meeting_account_idx on public.fireflies_meeting (account_id, started_at desc);

create table if not exists public.fireflies_share (
  meeting_id uuid not null references public.fireflies_meeting(id) on delete cascade,
  grantee_id uuid not null references public.profile(id) on delete cascade,
  shared_by  uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (meeting_id, grantee_id)
);
create index if not exists fireflies_share_grantee_idx on public.fireflies_share (grantee_id);

create table if not exists public.fireflies_link (
  id         uuid primary key default gen_random_uuid(),
  token      text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  meeting_id uuid not null references public.fireflies_meeting(id) on delete cascade,
  created_by uuid references public.profile(id) on delete set null,
  email      text,
  created_at timestamptz not null default now(),
  opened_at  timestamptz,
  revoked_at timestamptz
);
create index if not exists fireflies_link_meeting_idx on public.fireflies_link (meeting_id);

alter table public.fireflies_account enable row level security;
alter table public.fireflies_meeting enable row level security;
alter table public.fireflies_share   enable row level security;
alter table public.fireflies_link    enable row level security;
-- No policies: the functions below and the fireflies edge function (service role) only.
revoke all on public.fireflies_account, public.fireflies_meeting, public.fireflies_share, public.fireflies_link
  from anon, authenticated;

-- ---------------------------------------------------------------- helpers --
-- 'owner', 'shared' or null.
create or replace function public._meeting_access(p_meeting uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when not public._gmail_caller_ok() then null
    when exists (select 1 from public.fireflies_meeting m join public.fireflies_account a on a.id = m.account_id
                  where m.id = p_meeting and a.user_id = auth.uid()) then 'owner'
    when exists (select 1 from public.fireflies_share s join public.fireflies_meeting m on m.id = s.meeting_id
                   join public.fireflies_account a on a.id = m.account_id join public.profile o on o.id = a.user_id
                  where s.meeting_id = p_meeting and s.grantee_id = auth.uid() and o.is_active) then 'shared'
  end;
$$;
revoke all on function public._meeting_access(uuid) from public, anon;
grant execute on function public._meeting_access(uuid) to authenticated;

-- A meeting for lists (no transcript).
create or replace function public._meeting_row(m public.fireflies_meeting)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', m.id, 'account_id', m.account_id, 'title', m.title, 'started_at', m.started_at, 'duration', m.duration,
    'organizer_email', m.organizer_email, 'participants', to_jsonb(m.participants),
    'speakers', m.speakers,
    'short_summary', coalesce(m.summary->>'short_summary', left(m.summary->>'overview', 280)),
    'has_summary', m.summary is not null and coalesce(m.summary->>'overview', m.summary->>'short_summary', '') <> '',
    'shares', (select count(*) from public.fireflies_share s where s.meeting_id = m.id)
              + (select count(*) from public.fireflies_link l where l.meeting_id = m.id and l.revoked_at is null));
$$;
revoke all on function public._meeting_row(public.fireflies_meeting) from public, anon, authenticated;

-- ------------------------------------------------------------------ reads --
-- My Fireflies accounts and their meetings, newest first.
create or replace function public.meetings_overview()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public._gmail_caller_ok() then jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'email', a.email, 'name', a.name, 'connected_at', a.connected_at,
               'last_sync_at', a.last_sync_at, 'last_error', a.last_error, 'syncing', not a.backfill_done,
               'meetings', (select count(*) from public.fireflies_meeting m where m.account_id = a.id))
             order by a.connected_at)
        from public.fireflies_account a where a.user_id = auth.uid()), '[]'::jsonb),
    'meetings', coalesce((
      select jsonb_agg(public._meeting_row(m) order by m.started_at desc nulls last)
        from public.fireflies_meeting m join public.fireflies_account a on a.id = m.account_id
       where a.user_id = auth.uid()), '[]'::jsonb)
  ) end;
$$;

-- Meetings other people shared with me.
create or replace function public.meetings_shared_with_me()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public._gmail_caller_ok() then coalesce((
    select jsonb_agg(public._meeting_row(m) || jsonb_build_object(
             'owner_id', a.user_id, 'owner_name', o.display_name, 'owner_avatar', o.avatar_url, 'shared_at', s.created_at)
           order by m.started_at desc nulls last)
      from public.fireflies_share s
      join public.fireflies_meeting m on m.id = s.meeting_id
      join public.fireflies_account a on a.id = m.account_id
      join public.profile o on o.id = a.user_id
     where s.grantee_id = auth.uid() and o.is_active), '[]'::jsonb) end;
$$;

-- One meeting with its summary (and the transcript once it's been fetched).
-- The owner also gets who it's shared with and its email links.
create or replace function public.meeting_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_access text := public._meeting_access(p_id);
  m public.fireflies_meeting;
  a public.fireflies_account;
begin
  if v_access is null then raise exception 'Meeting not found'; end if;
  select * into m from public.fireflies_meeting where id = p_id;
  select * into a from public.fireflies_account where id = m.account_id;
  return public._meeting_row(m) || jsonb_build_object(
    'access', v_access,
    'account_email', a.email,
    'owner_name', (select display_name from public.profile where id = a.user_id),
    'attendees', m.attendees,
    'transcript_url', case when v_access = 'owner' then m.transcript_url end,
    'meeting_link', m.meeting_link,
    'summary', m.summary,
    'sentences', m.sentences,
    'people', case when v_access = 'owner' then coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.grantee_id, 'name', p.display_name, 'avatar_url', p.avatar_url,
                                          'shared_at', s.created_at) order by p.display_name)
        from public.fireflies_share s join public.profile p on p.id = s.grantee_id
       where s.meeting_id = m.id), '[]'::jsonb) else '[]'::jsonb end,
    'links', case when v_access = 'owner' then coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'token', l.token, 'email', l.email, 'created_at', l.created_at,
                                          'opened_at', l.opened_at, 'by', p.display_name) order by l.created_at desc)
        from public.fireflies_link l left join public.profile p on p.id = l.created_by
       where l.meeting_id = m.id and l.revoked_at is null), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- ---------------------------------------------------------------- sharing --
create or replace function public.meeting_share(p_id uuid, p_users uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  m public.fireflies_meeting;
  v_new uuid[];
begin
  if public._meeting_access(p_id) is distinct from 'owner' then raise exception 'Only the meeting''s owner can share it'; end if;
  select * into m from public.fireflies_meeting where id = p_id;
  with ins as (
    insert into public.fireflies_share (meeting_id, grantee_id, shared_by)
    select p_id, p.id, auth.uid() from public.profile p
     where p.id = any(coalesce(p_users, '{}')) and p.is_active and p.id <> auth.uid()
    on conflict do nothing
    returning grantee_id)
  select array_agg(grantee_id) into v_new from ins;
  if v_new is not null then
    perform public.notify_users(v_new, null, null, 'meeting_shared',
      jsonb_build_object('by', public._gmail_me_name(), 'meeting_id', p_id, 'title', coalesce(m.title, 'A meeting'),
                         'excerpt', left(coalesce(m.summary->>'short_summary', m.summary->>'overview'), 140)));
  end if;
  return coalesce(array_length(v_new, 1), 0);
end $$;

-- The owner stops sharing, or the person removes it from their list.
create or replace function public.meeting_unshare(p_id uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._gmail_caller_ok() then raise exception 'Not signed in'; end if;
  delete from public.fireflies_share s
   where s.meeting_id = p_id and s.grantee_id = p_user
     and (p_user = auth.uid() or public._meeting_access(p_id) = 'owner');
end $$;

-- A link that opens the meeting without signing in (for someone's email).
create or replace function public.meeting_link_create(p_id uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_token text;
begin
  if public._meeting_access(p_id) is distinct from 'owner' then raise exception 'Only the meeting''s owner can share it'; end if;
  if p_email is not null and btrim(p_email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'That doesn''t look like an email'; end if;
  if (select count(*) from public.fireflies_link where created_by = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many links in the last hour. Try again later.';
  end if;
  insert into public.fireflies_link (meeting_id, created_by, email)
  values (p_id, auth.uid(), lower(nullif(btrim(p_email), '')))
  returning token into v_token;
  return v_token;
end $$;

create or replace function public.meeting_link_revoke(p_link uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.fireflies_link l set revoked_at = now()
   where l.id = p_link and l.revoked_at is null and public._meeting_access(l.meeting_id) = 'owner';
end $$;

-- Email a meeting to anyone through the workspace's notification sender (the
-- chosen Gmail account, else n8n). Makes the link; returns it.
create or replace function public.meeting_email_share(p_id uuid, p_email text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare
  m      public.fireflies_meeting;
  v_tok  text := public.meeting_link_create(p_id, p_email);
  v_app  text := (select rtrim(app_url, '/') from public.workspace limit 1);
  v_link text;
  v_by   text := coalesce(public._gmail_me_name(), 'Someone');
  v_text text;
  v_gmail uuid := (select notify_gmail_account from public.workspace limit 1);
  v_gurl text := public._secret('gmail_webhook_url');
  v_gsec text := public._secret('gmail_webhook_secret');
  v_url  text := public._secret('email_webhook_url');
  v_sec  text := public._secret('email_webhook_secret');
  v_subj text;
  v_req  bigint;
begin
  select * into m from public.fireflies_meeting where id = p_id;
  v_link := v_app || '/#/meeting/' || v_tok;
  v_subj := left(v_by || ' shared a meeting with you: ' || coalesce(m.title, 'Meeting'), 200);
  v_text := concat_ws(E'\n\n',
    nullif(btrim(p_note), ''),
    coalesce(m.title, 'Meeting') || coalesce(E'\n' || to_char(m.started_at at time zone 'Africa/Cairo', 'Dy DD Mon YYYY, HH24:MI'), '')
      || coalesce(' · ' || round(m.duration)::int || ' min', ''),
    case when coalesce(m.summary->>'overview', m.summary->>'short_summary', '') <> ''
         then E'Summary\n' || coalesce(m.summary->>'overview', m.summary->>'short_summary') end,
    case when coalesce(m.summary->>'action_items', '') <> '' then E'Action items\n' || (m.summary->>'action_items') end,
    E'The full summary and transcript:\n' || v_link);
  if not (v_gmail is not null and v_gurl is not null and v_gsec is not null) and (v_url is null or v_sec is null) then
    raise exception 'Email isn''t set up for the workspace. Send it from your own Gmail instead.';
  end if;
  if public._outbox_full() then raise exception 'Too many emails went out in the last hour. Try again later.'; end if;
  if v_gmail is not null and v_gurl is not null and v_gsec is not null then
    v_req := net.http_post(
      url     := v_gurl,
      body    := jsonb_build_object('account', v_gmail, 'to', lower(btrim(p_email)), 'subject', v_subj, 'text', left(v_text, 20000)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_gsec));
  else
    v_req := net.http_post(
      url     := v_url,
      body    := jsonb_build_object('to', lower(btrim(p_email)), 'subject', v_subj, 'text', left(v_text, 20000)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec));
  end if;
  insert into public.outbound_message (channel, user_id, status, request_id) values ('email', auth.uid(), 'sent', v_req);
  return v_tok;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'meetings_overview()', 'meetings_shared_with_me()', 'meeting_get(uuid)', 'meeting_share(uuid, uuid[])',
    'meeting_unshare(uuid, uuid)', 'meeting_link_create(uuid, text)', 'meeting_link_revoke(uuid)',
    'meeting_email_share(uuid, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ------------------------------------------------------------- auto sync --
create or replace function public._fireflies_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('fireflies_webhook_url');
  v_sec text := public._secret('fireflies_webhook_secret');
begin
  if v_url is null or v_sec is null then return; end if;
  if not exists (select 1 from public.fireflies_account) then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public._fireflies_tick() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('fireflies-tick') where exists (select 1 from cron.job where jobname = 'fireflies-tick');
  perform cron.schedule('fireflies-tick', '*/15 * * * *', 'select public._fireflies_tick()');
end $$;

-- What I have connected (never the keys or tokens): 0054 plus Fireflies.
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
       where d.user_id = auth.uid()), '[]'::jsonb),
    'fireflies', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'email', f.email, 'name', f.name, 'connected_at', f.connected_at,
                                          'last_sync_at', f.last_sync_at, 'last_error', f.last_error,
                                          'meetings', (select count(*) from public.fireflies_meeting m where m.account_id = f.id))
             order by f.connected_at)
        from public.fireflies_account f
       where f.user_id = auth.uid()), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.my_connections() from public, anon;
grant execute on function public.my_connections() to authenticated;

-- ---------------------------------------------- notifications to channels --
-- Same as 0058, plus a meeting shared with you.
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
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' or new.kind like 'project\_%'
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
