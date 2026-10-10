-- 0052_zoom_gmail.sql
--   Zoom and Gmail, each person connecting their own accounts (the same way
--   as the iklipse-system app): one Zoom account per person, any number of
--   Gmail accounts. The OAuth flows and every Zoom / Gmail call run in the
--   edge functions `zoom` and `gmail` (service role); the tokens sit in
--   tables nobody else can read. The app learns what's connected from
--   my_connections().
--
--   Notification emails: an admin can pick one of their own Gmail accounts
--   to send them (workspace.notify_gmail_account). _send_email then hands the
--   message to the gmail function (pg_net, shared secret from Vault:
--   gmail_webhook_url / gmail_webhook_secret) instead of the n8n webhook,
--   which stays as the fallback.

-- ------------------------------------------------------------------ zoom --
create table if not exists public.zoom_account (
  user_id       uuid primary key references public.profile(id) on delete cascade,
  zoom_email    text,
  zoom_user_id  text,
  access_token  text,
  refresh_token text not null,
  token_expiry  timestamptz,
  scope         text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.zoom_account enable row level security;
-- No policies on purpose: only the service role (the edge function) reads it.
revoke all on public.zoom_account from anon, authenticated;

-- ----------------------------------------------------------------- gmail --
create table if not exists public.gmail_account (
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
create index if not exists gmail_account_user_idx on public.gmail_account (user_id);
alter table public.gmail_account enable row level security;
revoke all on public.gmail_account from anon, authenticated;

-- The account that sends notification emails (null = the n8n webhook).
alter table public.workspace
  add column if not exists notify_gmail_account uuid references public.gmail_account(id) on delete set null;

-- What I have connected (never the tokens).
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
       where g.user_id = auth.uid()), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.my_connections() from public, anon;
grant execute on function public.my_connections() to authenticated;

-- Admin: send notification emails from one of my Gmail accounts (null = n8n).
create or replace function public.admin_set_notify_gmail(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_account is not null
     and not exists (select 1 from public.gmail_account where id = p_account and user_id = auth.uid()) then
    raise exception 'Pick one of your own connected Gmail accounts';
  end if;
  update public.workspace set notify_gmail_account = p_account;
end $$;
revoke all on function public.admin_set_notify_gmail(uuid) from public, anon;
grant execute on function public.admin_set_notify_gmail(uuid) to authenticated;

-- Admin status: email counts as connected through Gmail or n8n.
create or replace function public.integration_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_inst text := public._secret('greenapi_instance'); v_ws public.workspace; v_sender text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into v_ws from public.workspace limit 1;
  select email into v_sender from public.gmail_account where id = v_ws.notify_gmail_account;
  return jsonb_build_object(
    'whatsapp', jsonb_build_object(
      'configured', v_inst is not null and public._secret('greenapi_token') is not null and public._secret('greenapi_url') is not null,
      'instance', v_inst,
      'url', public._secret('greenapi_url')),
    'email', jsonb_build_object(
      'configured', (v_sender is not null and public._secret('gmail_webhook_url') is not null and public._secret('gmail_webhook_secret') is not null)
                 or (public._secret('email_webhook_url') is not null and public._secret('email_webhook_secret') is not null),
      'gmail_sender', v_sender,
      'n8n', public._secret('email_webhook_url') is not null and public._secret('email_webhook_secret') is not null),
    'inbox', jsonb_build_object(
      'list_id', v_ws.email_inbox_list_id,
      'list_title', (select title from public.list where id = v_ws.email_inbox_list_id),
      'board_title', (select b.title from public.list l join public.board b on b.id = l.board_id where l.id = v_ws.email_inbox_list_id)),
    'sent_last_hour', (select count(*) from public.outbound_message where created_at > now() - interval '1 hour' and status = 'sent'));
end $$;

-- Emails go out through the chosen Gmail account when there is one, else n8n.
create or replace function public._send_email(p_user uuid, p_subject text, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_to    text;
  v_gmail uuid := (select notify_gmail_account from public.workspace limit 1);
  v_gurl  text := public._secret('gmail_webhook_url');
  v_gsec  text := public._secret('gmail_webhook_secret');
  v_url   text := public._secret('email_webhook_url');
  v_sec   text := public._secret('email_webhook_secret');
  v_subj  text := left(coalesce(nullif(btrim(p_subject), ''), 'iklipse'), 200);
  v_req   bigint;
begin
  if coalesce(btrim(p_text), '') = '' then return false; end if;
  select c.email into v_to from public.profile_contact c join public.profile p on p.id = c.user_id
   where c.user_id = p_user and p.is_active;
  if v_to is null then
    insert into public.outbound_message (channel, user_id, status) values ('email', p_user, 'no_contact');
    return false;
  end if;
  if not (v_gmail is not null and v_gurl is not null and v_gsec is not null) and (v_url is null or v_sec is null) then
    insert into public.outbound_message (channel, user_id, status) values ('email', p_user, 'not_configured');
    return false;
  end if;
  if public._outbox_full() then
    insert into public.outbound_message (channel, user_id, status) values ('email', p_user, 'limited');
    return false;
  end if;
  if v_gmail is not null and v_gurl is not null and v_gsec is not null then
    v_req := net.http_post(
      url     := v_gurl,
      body    := jsonb_build_object('account', v_gmail, 'to', v_to, 'subject', v_subj, 'text', left(p_text, 20000)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_gsec));
  else
    v_req := net.http_post(
      url     := v_url,
      body    := jsonb_build_object('to', v_to, 'subject', v_subj, 'text', left(p_text, 20000)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec));
  end if;
  insert into public.outbound_message (channel, user_id, status, request_id) values ('email', p_user, 'sent', v_req);
  return true;
end $$;
revoke all on function public._send_email(uuid, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
