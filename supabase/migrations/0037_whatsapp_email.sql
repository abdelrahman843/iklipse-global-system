-- ============================================================================
-- 0037_whatsapp_email.sql
--   WhatsApp (Green API) and email (Gmail through n8n) for each person.
--   - profile_contact: a person's WhatsApp number and email, plus whether
--     their in-app notifications are also sent there. Visible to the person
--     and admins only.
--   - Secrets live in Vault: Green API (set by an admin from the Users page)
--     and the n8n email webhook + its shared secret.
--   - Automation actions notify_whatsapp {text} and notify_email {subject,
--     text} message every member of the card.
--   - email_ingest(): called by the n8n "email in" workflow; an email from a
--     team member's registered address becomes a card in the chosen list.
--   - Every outgoing message is logged; 300 per hour for the workspace.
-- ============================================================================

-- ------------------------------------------------------------- settings --
alter table public.workspace
  add column if not exists app_url text not null default 'https://abdelrahman843.github.io/iklipse-global-system/',
  add column if not exists email_inbox_list_id uuid references public.list(id) on delete set null;

-- -------------------------------------------------------------- contacts --
create table if not exists public.profile_contact (
  user_id         uuid primary key references public.profile(id) on delete cascade,
  whatsapp        text check (whatsapp ~ '^[1-9][0-9]{7,14}$'),            -- international digits, e.g. 201001234567
  email           text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notify_whatsapp boolean not null default false,
  notify_email    boolean not null default false,
  updated_at      timestamptz not null default now()
);
create unique index if not exists profile_contact_email_uq on public.profile_contact (lower(email)) where email is not null;
alter table public.profile_contact enable row level security;
drop policy if exists contact_rw on public.profile_contact;
create policy contact_rw on public.profile_contact for all to authenticated
  using ((user_id = auth.uid() and public.am_active()) or public.is_admin())
  with check ((user_id = auth.uid() and public.am_active()) or public.is_admin());
grant select, insert, update, delete on public.profile_contact to authenticated;

-- --------------------------------------------------------------- outbox --
create table if not exists public.outbound_message (
  id          bigserial primary key,
  channel     text not null check (channel in ('whatsapp', 'email')),
  user_id     uuid references public.profile(id) on delete set null,
  status      text not null check (status in ('sent', 'limited', 'not_configured', 'no_contact')),
  request_id  bigint,
  created_at  timestamptz not null default now()
);
create index if not exists outbound_message_created_idx on public.outbound_message (created_at desc);
alter table public.outbound_message enable row level security;
drop policy if exists outbound_admin_read on public.outbound_message;
create policy outbound_admin_read on public.outbound_message for select to authenticated using (public.is_admin());
grant select on public.outbound_message to authenticated;

create table if not exists public.email_ingest_log (
  message_id  text primary key,
  card_id     uuid references public.card(id) on delete set null,
  sender      text,
  accepted    boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);
alter table public.email_ingest_log enable row level security;
drop policy if exists ingest_admin_read on public.email_ingest_log;
create policy ingest_admin_read on public.email_ingest_log for select to authenticated using (public.is_admin());
grant select on public.email_ingest_log to authenticated;

-- ---------------------------------------------------------------- vault --
create or replace function public._secret(p_name text)
returns text language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;
revoke all on function public._secret(text) from public, anon, authenticated;

create or replace function public._put_secret(p_name text, p_value text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if p_value is null or btrim(p_value) = '' then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
  elsif v_id is null then
    perform vault.create_secret(btrim(p_value), p_name, 'Iklipse integration');
  else
    perform vault.update_secret(v_id, btrim(p_value));
  end if;
end $$;
revoke all on function public._put_secret(text, text) from public, anon, authenticated;

-- Admin: Green API connection. Empty values remove it.
create or replace function public.admin_set_greenapi(p_url text, p_instance text, p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if coalesce(btrim(p_url), '') = '' and coalesce(btrim(p_instance), '') = '' and coalesce(btrim(p_token), '') = '' then
    perform public._put_secret('greenapi_url', null);
    perform public._put_secret('greenapi_instance', null);
    perform public._put_secret('greenapi_token', null);
    return;
  end if;
  -- The database only ever calls Green API hosts.
  if rtrim(btrim(p_url), '/') !~ '^https://([a-z0-9-]+\.)*(greenapi|green-api)\.com$' then
    raise exception 'The API URL should look like https://7103.api.greenapi.com';
  end if;
  if btrim(p_instance) !~ '^[0-9]{6,15}$' then raise exception 'The instance ID is the number shown as idInstance'; end if;
  if btrim(p_token) !~ '^[A-Za-z0-9]{20,100}$' then raise exception 'The API token is the long code shown as apiTokenInstance'; end if;
  perform public._put_secret('greenapi_url', rtrim(btrim(p_url), '/'));
  perform public._put_secret('greenapi_instance', btrim(p_instance));
  perform public._put_secret('greenapi_token', btrim(p_token));
end $$;
revoke all on function public.admin_set_greenapi(text, text, text) from public, anon;
grant execute on function public.admin_set_greenapi(text, text, text) to authenticated;

-- Admin: the list that "email to card" drops cards into (null turns it off).
create or replace function public.admin_set_email_inbox(p_list uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_list is not null and not exists (select 1 from public.list where id = p_list and not is_archived) then
    raise exception 'That list does not exist';
  end if;
  update public.workspace set email_inbox_list_id = p_list;
end $$;
revoke all on function public.admin_set_email_inbox(uuid) from public, anon;
grant execute on function public.admin_set_email_inbox(uuid) to authenticated;

-- What the Users page shows (never the secrets themselves).
create or replace function public.integration_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_inst text := public._secret('greenapi_instance'); v_ws public.workspace;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into v_ws from public.workspace limit 1;
  return jsonb_build_object(
    'whatsapp', jsonb_build_object(
      'configured', v_inst is not null and public._secret('greenapi_token') is not null and public._secret('greenapi_url') is not null,
      'instance', v_inst,
      'url', public._secret('greenapi_url')),
    'email', jsonb_build_object(
      'configured', public._secret('email_webhook_url') is not null and public._secret('email_webhook_secret') is not null),
    'inbox', jsonb_build_object(
      'list_id', v_ws.email_inbox_list_id,
      'list_title', (select title from public.list where id = v_ws.email_inbox_list_id),
      'board_title', (select b.title from public.list l join public.board b on b.id = l.board_id where l.id = v_ws.email_inbox_list_id)),
    'sent_last_hour', (select count(*) from public.outbound_message where created_at > now() - interval '1 hour' and status = 'sent'));
end $$;
revoke all on function public.integration_status() from public, anon;
grant execute on function public.integration_status() to authenticated;

-- ---------------------------------------------------------------- send --
create or replace function public._outbox_full()
returns boolean language sql stable security definer set search_path = public as $$
  select (select count(*) from public.outbound_message where created_at > now() - interval '1 hour' and status = 'sent') >= 300;
$$;
revoke all on function public._outbox_full() from public, anon, authenticated;

create or replace function public._send_whatsapp(p_user uuid, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_to  text;
  v_url text := public._secret('greenapi_url');
  v_id  text := public._secret('greenapi_instance');
  v_tok text := public._secret('greenapi_token');
  v_req bigint;
begin
  if coalesce(btrim(p_text), '') = '' then return false; end if;
  select c.whatsapp into v_to from public.profile_contact c join public.profile p on p.id = c.user_id
   where c.user_id = p_user and p.is_active;
  if v_to is null then
    insert into public.outbound_message (channel, user_id, status) values ('whatsapp', p_user, 'no_contact');
    return false;
  end if;
  if v_url is null or v_id is null or v_tok is null then
    insert into public.outbound_message (channel, user_id, status) values ('whatsapp', p_user, 'not_configured');
    return false;
  end if;
  if public._outbox_full() then
    insert into public.outbound_message (channel, user_id, status) values ('whatsapp', p_user, 'limited');
    return false;
  end if;
  v_req := net.http_post(
    url     := v_url || '/waInstance' || v_id || '/sendMessage/' || v_tok,
    body    := jsonb_build_object('chatId', v_to || '@c.us', 'message', left(p_text, 4000)),
    headers := '{"Content-Type": "application/json"}'::jsonb);
  insert into public.outbound_message (channel, user_id, status, request_id) values ('whatsapp', p_user, 'sent', v_req);
  return true;
end $$;
revoke all on function public._send_whatsapp(uuid, text) from public, anon, authenticated;

create or replace function public._send_email(p_user uuid, p_subject text, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_to  text;
  v_url text := public._secret('email_webhook_url');
  v_sec text := public._secret('email_webhook_secret');
  v_req bigint;
begin
  if coalesce(btrim(p_text), '') = '' then return false; end if;
  select c.email into v_to from public.profile_contact c join public.profile p on p.id = c.user_id
   where c.user_id = p_user and p.is_active;
  if v_to is null then
    insert into public.outbound_message (channel, user_id, status) values ('email', p_user, 'no_contact');
    return false;
  end if;
  if v_url is null or v_sec is null then
    insert into public.outbound_message (channel, user_id, status) values ('email', p_user, 'not_configured');
    return false;
  end if;
  if public._outbox_full() then
    insert into public.outbound_message (channel, user_id, status) values ('email', p_user, 'limited');
    return false;
  end if;
  v_req := net.http_post(
    url     := v_url,
    body    := jsonb_build_object('to', v_to, 'subject', left(coalesce(nullif(btrim(p_subject), ''), 'Iklipse'), 200),
                                  'text', left(p_text, 20000)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec));
  insert into public.outbound_message (channel, user_id, status, request_id) values ('email', p_user, 'sent', v_req);
  return true;
end $$;
revoke all on function public._send_email(uuid, text, text) from public, anon, authenticated;

-- Admin tests: a message to your own number / address.
create or replace function public.admin_test_whatsapp()
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if not exists (select 1 from public.profile_contact where user_id = auth.uid() and whatsapp is not null) then
    raise exception 'Add your own WhatsApp number on your member card first';
  end if;
  return public._send_whatsapp(auth.uid(), 'Iklipse: WhatsApp messages are working.');
end $$;
revoke all on function public.admin_test_whatsapp() from public, anon;
grant execute on function public.admin_test_whatsapp() to authenticated;

create or replace function public.admin_test_email()
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if not exists (select 1 from public.profile_contact where user_id = auth.uid() and email is not null) then
    raise exception 'Add your own email on your member card first';
  end if;
  return public._send_email(auth.uid(), 'Iklipse test', 'Email messages from Iklipse are working.');
end $$;
revoke all on function public.admin_test_email() from public, anon;
grant execute on function public.admin_test_email() to authenticated;

-- ------------------------------------------- notifications to channels --
-- A person who turned it on also gets their in-app notifications on
-- WhatsApp / email (Trello-synced changes never notify: notify_users skips them).
create or replace function public.on_notification_channels()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c      public.profile_contact;
  v_card text;
  v_brd  text;
  v_what text;
  v_link text;
  v_msg  text;
begin
  select * into c from public.profile_contact where user_id = new.user_id;
  if not found or not (c.notify_whatsapp or c.notify_email) then return new; end if;
  select title into v_card from public.card where id = new.card_id;
  select title into v_brd from public.board where id = new.board_id;
  v_what := case new.kind
    when 'mention'       then 'You were mentioned'
    when 'assigned'      then 'You were added to a card'
    when 'comment'       then 'New comment'
    when 'due_changed'   then 'Due date changed'
    when 'due_completed' then 'Marked complete'
    when 'board_invited' then 'You were added to a board'
    when 'automation'    then coalesce(nullif(new.data->>'text', ''), 'Rule')
    else new.kind end;
  v_link := (select rtrim(app_url, '/') from public.workspace limit 1) || '/#/pm/boards/' || new.board_id
            || coalesce('/cards/' || new.card_id, '');
  v_msg := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
           || case when new.board_id is not null then E'\n' || v_link else '' end;
  begin
    if c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'Iklipse: ' || v_msg); end if;
    if c.notify_email then perform public._send_email(new.user_id, 'Iklipse: ' || v_what, v_msg); end if;
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
revoke execute on function public.on_notification_channels() from public, anon, authenticated;
drop trigger if exists notification_channels on public.notification;
create trigger notification_channels after insert on public.notification
  for each row execute function public.on_notification_channels();

-- ------------------------------------------------------- email to card --
-- Called by the n8n "email in" workflow (database role, not the app).
create or replace function public.email_ingest(p_from text, p_subject text, p_body text, p_message_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_addr  text := lower(btrim(coalesce(substring(p_from from '<([^>]+)>'), p_from)));
  v_user  uuid;
  v_list  uuid;
  v_board uuid;
  v_card  uuid;
  v_n     int;
begin
  if coalesce(btrim(p_message_id), '') = '' then return jsonb_build_object('accepted', false, 'reason', 'no message id'); end if;
  insert into public.email_ingest_log (message_id, sender, accepted) values (p_message_id, v_addr, false)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('accepted', false, 'reason', 'duplicate'); end if;

  -- Only team members' registered addresses can make cards.
  select c.user_id into v_user from public.profile_contact c join public.profile p on p.id = c.user_id
   where lower(c.email) = v_addr and p.is_active;
  if v_user is null then
    update public.email_ingest_log set reason = 'unknown sender' where message_id = p_message_id;
    return jsonb_build_object('accepted', false, 'reason', 'unknown sender');
  end if;
  select w.email_inbox_list_id, l.board_id into v_list, v_board
    from public.workspace w join public.list l on l.id = w.email_inbox_list_id and not l.is_archived limit 1;
  if v_list is null then
    update public.email_ingest_log set reason = 'no inbox list' where message_id = p_message_id;
    return jsonb_build_object('accepted', false, 'reason', 'no inbox list');
  end if;
  if not public._can_edit_board_as(v_user, v_board) then
    update public.email_ingest_log set reason = 'sender cannot edit the board' where message_id = p_message_id;
    return jsonb_build_object('accepted', false, 'reason', 'sender cannot edit the board');
  end if;

  insert into public.card (board_id, list_id, title, description, position, created_by)
  values (v_board, v_list,
          left(coalesce(nullif(btrim(regexp_replace(coalesce(p_subject, ''), '^\s*(re|fwd?):\s*', '', 'i')), ''), 'Email from ' || v_addr), 500),
          nullif(left(btrim(coalesce(p_body, '')), 20000), ''),
          public.rank_between((select k.position from public.card k where k.list_id = v_list and not k.is_archived
                                order by k.position collate "C" desc limit 1), null),
          v_user)
  returning id into v_card;
  update public.email_ingest_log set accepted = true, card_id = v_card where message_id = p_message_id;
  return jsonb_build_object('accepted', true, 'card_id', v_card,
    'link', (select rtrim(app_url, '/') from public.workspace limit 1) || '/#/pm/boards/' || v_board || '/cards/' || v_card);
end $$;
revoke all on function public.email_ingest(text, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------- automation actions --
-- {link} = the card in the app (for WhatsApp / email / Slack text).
create or replace function public._auto_fill(p_text text, p_card uuid, p_board uuid)
returns text language sql stable set search_path = public as $$
  select replace(replace(replace(replace(replace(coalesce(p_text, ''),
           '{card}',  coalesce(c.title, '')),
           '{list}',  coalesce(l.title, '')),
           '{board}', coalesce(b.title, '')),
           '{due}',   coalesce(to_char(c.due_date at time zone 'Africa/Cairo', 'Mon DD, HH24:MI'), 'no due date')),
           '{link}',  (select rtrim(w.app_url, '/') from public.workspace w limit 1) || '/#/pm/boards/' || b.id
                      || coalesce('/cards/' || c.id, ''))
    from public.board b
    left join public.card c on c.id = p_card
    left join public.list l on l.id = c.list_id
   where b.id = p_board
$$;
revoke execute on function public._auto_fill(text, uuid, uuid) from public, anon, authenticated;

-- Same as 0034 plus notify_whatsapp / notify_email (every member of the card).
CREATE OR REPLACE FUNCTION public._auto_run_action(p_card_id uuid, p_board uuid, p_action jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_kind   text := p_action->>'kind';
  v_args   jsonb := coalesce(p_action->'args', '{}'::jsonb);
  v_id     uuid;
  v_target uuid;
  v_owner  uuid := coalesce(auth.uid(), nullif(current_setting('iklipse.automation_owner', true), '')::uuid);
begin
  -- Targets named in a rule must live on the rule's board (mirrors: a board
  -- the acting user may edit).
  if v_kind = 'move_to_list' then
    v_id := (v_args->>'list_id')::uuid;
    if not exists (select 1 from public.list where id = v_id and board_id = p_board) then return; end if;
  elsif v_kind in ('add_label', 'remove_label') then
    v_id := (v_args->>'label_id')::uuid;
    if not exists (select 1 from public.label where id = v_id and board_id = p_board) then return; end if;
  elsif v_kind = 'add_member' then
    v_id := (v_args->>'user_id')::uuid;
    if not exists (select 1 from public.board_member where user_id = v_id and board_id = p_board)
       and not exists (select 1 from public.profile where id = v_id and role = 'admin' and is_active) then return; end if;
  elsif v_kind = 'mirror_to_list' then
    v_id := (v_args->>'target_list_id')::uuid;
    select board_id into v_target from public.list where id = v_id and not is_archived;
    if v_target is null or v_target = p_board then return; end if;
    if auth.uid() is not null then
      if not public.can_edit_board(v_target) then return; end if;
    elsif v_owner is null or not public._can_edit_board_as(v_owner, v_target) then
      return;
    end if;
  elsif v_kind = 'create_card' then
    v_id := (v_args->>'list_id')::uuid;
    if not exists (select 1 from public.list where id = v_id and board_id = p_board and not is_archived) then return; end if;
  elsif v_kind = 'notify_slack' then
    -- Only Slack incoming webhooks: the database never calls arbitrary URLs.
    if coalesce(v_args->>'webhook_url', '') !~ '^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+$' then
      raise exception 'Slack webhook URL is not valid';
    end if;
  end if;
  case v_kind
    when 'move_to_list' then update public.card set list_id = v_id, updated_at = now() where id = p_card_id;
    when 'archive'      then update public.card set is_archived = true, updated_at = now() where id = p_card_id;
    when 'restore'      then update public.card set is_archived = false, updated_at = now() where id = p_card_id;
    when 'complete_due' then update public.card set due_completed = true, updated_at = now() where id = p_card_id;
    when 'add_label'    then
      if p_card_id is not null then
        insert into public.card_label(card_id, label_id) values (p_card_id, v_id) on conflict do nothing;
      end if;
    when 'remove_label' then delete from public.card_label where card_id = p_card_id and label_id = v_id;
    when 'add_member'   then
      if p_card_id is not null then
        insert into public.card_member(card_id, user_id) values (p_card_id, v_id) on conflict do nothing;
      end if;
    when 'remove_member' then
      delete from public.card_member where card_id = p_card_id and user_id = (v_args->>'user_id')::uuid;
    when 'add_comment' then
      if p_card_id is not null then
        insert into public.comment(card_id, author_id, body)
        values (p_card_id, coalesce(v_owner, (select created_by from public.card where id = p_card_id)),
                public._auto_fill(v_args->>'body', p_card_id, p_board));
      end if;
    when 'rename'          then update public.card set title = public._auto_fill(v_args->>'title', p_card_id, p_board), updated_at = now() where id = p_card_id;
    when 'set_description' then update public.card set description = v_args->>'description', updated_at = now() where id = p_card_id;
    when 'mirror_to_list' then
      if p_card_id is not null and not exists (select 1 from public.card where mirror_of = p_card_id and list_id = v_id) then
        perform set_config('app.server_write', '1', true);   -- card_integrity lets the server set mirror_of
        insert into public.card (board_id, list_id, title, position, created_by, mirror_of)
        select v_target, v_id, c.title,
               public.rank_between((select k.position from public.card k where k.list_id = v_id and not k.is_archived
                                     order by k.position collate "C" desc limit 1), null),
               coalesce(auth.uid(), c.created_by), c.id
          from public.card c where c.id = p_card_id;
        perform set_config('app.server_write', '', true);
      end if;
    when 'create_card' then
      if v_owner is not null then
        insert into public.card (board_id, list_id, title, position, created_by)
        values (p_board, v_id,
                left(coalesce(nullif(btrim(public._auto_fill(v_args->>'title', p_card_id, p_board)), ''), 'New card'), 500),
                public.rank_between((select k.position from public.card k where k.list_id = v_id and not k.is_archived
                                      order by k.position collate "C" desc limit 1), null),
                v_owner);
      end if;
    when 'notify_members' then
      if p_card_id is not null then
        perform public.notify_users(
          array(select cm.user_id from public.card_member cm where cm.card_id = p_card_id),
          p_board, p_card_id, 'automation',
          jsonb_build_object('text', left(public._auto_fill(v_args->>'text', p_card_id, p_board), 500)));
      end if;
    when 'notify_slack' then
      -- Queued by pg_net and sent after commit (a rolled back run sends nothing).
      perform net.http_post(
        url     := v_args->>'webhook_url',
        body    := jsonb_build_object('text', left(public._auto_fill(v_args->>'text', p_card_id, p_board), 3000)),
        headers := '{"Content-Type": "application/json"}'::jsonb);
    when 'notify_whatsapp' then
      if p_card_id is not null then
        perform public._send_whatsapp(cm.user_id, left(public._auto_fill(v_args->>'text', p_card_id, p_board), 4000))
           from public.card_member cm where cm.card_id = p_card_id;
      end if;
    when 'notify_email' then
      if p_card_id is not null then
        perform public._send_email(cm.user_id,
                                   public._auto_fill(coalesce(nullif(v_args->>'subject', ''), '{card}'), p_card_id, p_board),
                                   public._auto_fill(v_args->>'text', p_card_id, p_board))
           from public.card_member cm where cm.card_id = p_card_id;
      end if;
    else raise notice 'automation: unknown action kind %', v_kind;
  end case;
end $function$;
revoke execute on function public._auto_run_action(uuid, uuid, jsonb) from public, anon, authenticated;
