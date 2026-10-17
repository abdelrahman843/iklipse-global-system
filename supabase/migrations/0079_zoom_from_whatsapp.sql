-- ============================================================================
-- 0079_zoom_from_whatsapp.sql
--   Zoom meetings from WhatsApp: the bot as an assistant the admins talk to
--   in a group (whatsapp-bot, book.ts).
--
--   An admin mentions the bot ("@iklipse book a call Sunday at 3, an hour,
--   about ..."); after that admins carry the conversation on by replying to
--   the bot's messages. It books on that admin's own Zoom and answers with
--   the link, the date and the time; when the time is taken it offers the
--   free times (within the hours set here), and a reply picks one or asks for
--   another day. A reply about a booked meeting moves or cancels it. Only
--   admins (by the number iklipse has for them) get any answer; what goes
--   wrong reaches only that admin, as a notification (meeting_book_failed).
--
--   Zoom: a person can connect several accounts now, and picks the one the
--   bot books on (for_bot).
-- ============================================================================

-- --------------------------------------------------------------- settings --
alter table public.watch_settings
  add column if not exists book_enabled boolean not null default true,
  add column if not exists book_from    time    not null default '10:00',  -- free times offered from (Cairo)
  add column if not exists book_to      time    not null default '20:00';  -- and until
alter table public.watch_settings drop constraint if exists watch_settings_book_hours;
alter table public.watch_settings add constraint watch_settings_book_hours check (book_from < book_to);

-- ----------------------------------------------------- several Zoom accounts --
alter table public.zoom_account add column if not exists id uuid not null default gen_random_uuid();
alter table public.zoom_account add column if not exists for_bot boolean not null default false;
alter table public.zoom_account drop constraint if exists zoom_account_pkey;
alter table public.zoom_account add constraint zoom_account_pkey primary key (id);
create index if not exists zoom_account_user_idx on public.zoom_account (user_id);
create unique index if not exists zoom_account_user_zoom_uq on public.zoom_account (user_id, zoom_user_id);
-- One account per person is the bot's.
create unique index if not exists zoom_account_bot_uq on public.zoom_account (user_id) where for_bot;
update public.zoom_account z set for_bot = true
 where not exists (select 1 from public.zoom_account o where o.user_id = z.user_id and o.for_bot)
   and z.id = (select o.id from public.zoom_account o where o.user_id = z.user_id order by o.connected_at limit 1);

-- ---------------------------------------------------------- conversations --
create table if not exists public.wa_bot_thread (
  id         uuid primary key default gen_random_uuid(),
  chat_id    text not null,
  chat_name  text,
  started_by uuid references public.profile(id) on delete set null,
  state      jsonb not null default '{}'::jsonb,   -- what it's arranging between messages
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wa_bot_thread_updated_idx on public.wa_bot_thread (updated_at);

-- Each message: the admins' (answered once) and the bot's (a reply to one carries the conversation on).
create table if not exists public.wa_bot_turn (
  id         text primary key,                      -- the WhatsApp message id
  thread_id  uuid not null references public.wa_bot_thread(id) on delete cascade,
  chat_id    text not null,
  from_bot   boolean not null default false,
  user_id    uuid references public.profile(id) on delete set null,
  text       text not null,
  quoted     text,                                  -- the message it replies to, when that isn't the bot's
  status     text not null default 'done' check (status in ('new', 'working', 'done', 'failed')),
  error      text,
  started_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wa_bot_turn_thread_idx on public.wa_bot_turn (thread_id, created_at);
create index if not exists wa_bot_turn_open_idx on public.wa_bot_turn (status, created_at) where status in ('new', 'working');

-- The meetings it booked (to move or cancel them later).
create table if not exists public.wa_bot_meeting (
  zoom_id    text primary key,
  thread_id  uuid references public.wa_bot_thread(id) on delete set null,
  chat_id    text not null,
  owner      uuid not null references public.profile(id) on delete cascade,
  account    uuid references public.zoom_account(id) on delete set null,
  topic      text not null,
  start_at   timestamptz not null,
  minutes    int not null check (minutes between 1 and 1440),
  join_url   text not null,
  password   text,
  status     text not null default 'booked' check (status in ('booked', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wa_bot_meeting_chat_idx on public.wa_bot_meeting (chat_id, start_at) where status = 'booked';

alter table public.wa_bot_thread  enable row level security;
alter table public.wa_bot_turn    enable row level security;
alter table public.wa_bot_meeting enable row level security;
revoke all on public.wa_bot_thread, public.wa_bot_turn, public.wa_bot_meeting from anon, authenticated;

-- ------------------------------------------------------- what I connected --
-- As 0059; Zoom is a list now (several accounts, one the bot's).
create or replace function public.my_connections()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.uid() is not null and public._login_current() then jsonb_build_object(
    'zoom', coalesce((
      select jsonb_agg(jsonb_build_object('id', z.id, 'email', z.zoom_email, 'connected_at', z.connected_at, 'for_bot', z.for_bot)
             order by z.connected_at)
        from public.zoom_account z
       where z.user_id = auth.uid()), '[]'::jsonb),
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

-- --------------------------------------------------------------- settings --
-- As 0078, plus the bot's Zoom meetings: on or off, and the hours free times are offered in.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins',
                 'mail_enabled', 'mail_reply_wait_min', 'mail_clients', 'mail_ads', 'mail_senders',
                 'slack_enabled', 'book_enabled', 'book_from', 'book_to') then
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if p ? 'mail_senders' then
    if jsonb_typeof(p->'mail_senders') <> 'array' then raise exception 'The senders are a list'; end if;
    v_senders := public._gmail_senders(array(select jsonb_array_elements_text(p->'mail_senders')));
    if cardinality(v_senders) > 100 then raise exception 'Up to 100 senders'; end if;
  end if;
  update public.watch_settings set
    enabled             = coalesce((p->>'enabled')::boolean, enabled),
    model               = coalesce(p->>'model', model),
    reply_wait_min      = coalesce((p->>'reply_wait_min')::int, reply_wait_min),
    promise_wait_min    = coalesce((p->>'promise_wait_min')::int, promise_wait_min),
    repeat_every_min    = coalesce((p->>'repeat_every_min')::int, repeat_every_min),
    alerts_before_call  = coalesce((p->>'alerts_before_call')::int, alerts_before_call),
    calls_enabled       = coalesce((p->>'calls_enabled')::boolean, calls_enabled),
    call_retry_min      = coalesce((p->>'call_retry_min')::int, call_retry_min),
    call_every_min      = coalesce((p->>'call_every_min')::int, call_every_min),
    max_calls           = coalesce((p->>'max_calls')::int, max_calls),
    stop_after_hours    = coalesce((p->>'stop_after_hours')::int, stop_after_hours),
    quiet_from          = case when p ? 'quiet_from' then nullif(p->>'quiet_from', '')::time else quiet_from end,
    quiet_to            = case when p ? 'quiet_to' then nullif(p->>'quiet_to', '')::time else quiet_to end,
    call_language       = coalesce(p->>'call_language', call_language),
    cc_admins           = coalesce((p->>'cc_admins')::boolean, cc_admins),
    mail_enabled        = coalesce((p->>'mail_enabled')::boolean, mail_enabled),
    mail_reply_wait_min = coalesce((p->>'mail_reply_wait_min')::int, mail_reply_wait_min),
    mail_clients        = coalesce((p->>'mail_clients')::boolean, mail_clients),
    mail_ads            = coalesce((p->>'mail_ads')::boolean, mail_ads),
    mail_senders        = case when p ? 'mail_senders' then v_senders else mail_senders end,
    slack_enabled       = coalesce((p->>'slack_enabled')::boolean, slack_enabled),
    book_enabled        = coalesce((p->>'book_enabled')::boolean, book_enabled),
    book_from           = coalesce(nullif(p->>'book_from', '')::time, book_from),
    book_to             = coalesce(nullif(p->>'book_to', '')::time, book_to),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
end $$;

-- ---------------------------------------------- notifications to channels --
-- As 0078, plus "Couldn't do the Zoom meeting" (only to the admin who asked).
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
  v_text text;
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
    when 'watch_alert'      then coalesce(nullif(new.data->>'title', ''), 'Alert')
    when 'meeting_book_failed' then case when new.data ? 'join_url' then 'Zoom meeting booked, but not posted in the group'
                                         else 'Couldn''t do the Zoom meeting' end
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared?tab=mail';
  elsif new.kind like 'drive\_%' then
    v_link := v_app || '/#/shared?tab=drive';
  elsif new.kind = 'meeting_shared' then
    v_link := v_app || '/#/meetings?m=' || (new.data->>'meeting_id');
  elsif new.kind = 'meeting_book_failed' then
    v_link := coalesce(new.data->>'join_url', v_app || '/#' || coalesce(new.data->>'path', '/notifications'));
  elsif new.kind = 'invoice_needs_file' then
    v_link := v_app || '/#/invoices?tab=files';
  elsif new.kind in ('invoice_saved', 'refund_saved') then
    v_link := v_app || '/#/invoices' || coalesce('?month=' || left(new.data->>'month', 7), '');
  elsif new.kind = 'watch_alert' then
    v_link := v_app || '/#/alerts?a=' || (new.data->>'alert_id');
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
  v_text := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
            || coalesce(E'\n"' || nullif(new.data->>'excerpt', '') || '"', '');
  if new.kind = 'watch_alert' then
    v_text := v_what || coalesce(E'\n' || nullif(new.data->>'detail', ''), '') || coalesce(E'\n' || case new.data->>'source' when 'email' then 'Email: ' when 'slack' then 'Slack: ' else 'Group: ' end
                                   || nullif(new.data->>'group', ''), '');
  end if;
  if new.kind = 'meeting_book_failed' then
    v_text := v_what || coalesce(E'\n' || nullif(new.data->>'error', ''), '') || coalesce(E'\nGroup: ' || nullif(new.data->>'group', ''), '');
  end if;
  -- Email keeps the link to open it; WhatsApp (read on phones) has the words only.
  v_msg := v_text || coalesce(E'\n' || v_link, '');
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  if new.kind = 'meeting_book_failed' then
    v_body := concat_ws(E'\n', nullif(new.data->>'error', ''), nullif(new.data->>'group', ''));
  end if;
  if new.kind = 'watch_alert' then
    v_body := concat_ws(E'\n', nullif(new.data->>'detail', ''),
                        case when new.data->>'source' = 'email' then 'Email: ' else '' end || nullif(new.data->>'group', ''));
  end if;
  begin
    if c.user_id is not null and c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'iklipse: ' || v_text); end if;
    if c.user_id is not null and c.notify_email then perform public._send_email(new.user_id, 'iklipse: ' || v_what, v_msg); end if;
    -- Shared mail, Drive, meetings, invoices and projects go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' or new.kind like 'project\_%' or new.kind like 'delivery\_%'
                                        or new.kind in ('invoice_saved', 'refund_saved', 'invoice_needs_file', 'meeting_shared', 'watch_alert', 'meeting_book_failed') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link,
                              case when new.kind = 'watch_alert' then 'watch-' || (new.data->>'alert_id') else new.id::text end);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

-- Ikli's calls and the bot speak English only (the Arabic option is gone from the app).
update public.watch_settings set call_language = 'en' where call_language <> 'en';

notify pgrst, 'reload schema';
