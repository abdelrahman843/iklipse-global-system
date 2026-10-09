-- ============================================================================
-- 0049_web_push.sql
--   Push notifications on people's phones and computers (Web Push).
--   - push_subscription: one row per device that turned notifications on,
--     with that device's Trello / Miro switches. Each person sees and manages
--     only their own devices.
--   - on_notification_channels(): besides WhatsApp / email, every new
--     notification is handed to the push-send edge function (URL and shared
--     secret in Vault), which delivers it to the person's devices.
-- ============================================================================

create table if not exists public.push_subscription (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references public.profile(id) on delete cascade,
  endpoint     text not null unique check (endpoint ~ '^https://'),
  p256dh       text not null,
  auth         text not null,
  device       text,                       -- "Android · Chrome", shown in settings
  trello       boolean not null default true,
  miro         boolean not null default true,
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz
);
create index if not exists push_subscription_user_idx on public.push_subscription (user_id);
alter table public.push_subscription enable row level security;
drop policy if exists push_own on public.push_subscription;
create policy push_own on public.push_subscription for all to authenticated
  using (user_id = auth.uid() and public.am_active())
  with check (user_id = auth.uid() and public.am_active());
grant select, insert, update, delete on public.push_subscription to authenticated;

-- A device moving to another account on the same browser: the endpoint is
-- unique, so the new owner takes it over.
create or replace function public.push_register(p_endpoint text, p_p256dh text, p_auth text, p_device text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.am_active() then raise exception 'not signed in'; end if;
  insert into public.push_subscription (user_id, endpoint, p256dh, auth, device)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_device, 80))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.push_register(text, text, text, text) from public;
grant execute on function public.push_register(text, text, text, text) to authenticated;

alter table public.outbound_message drop constraint if exists outbound_message_channel_check;
alter table public.outbound_message add constraint outbound_message_channel_check check (channel in ('whatsapp', 'email', 'push'));

-- Hands one notification to the push-send function (it looks up the devices).
create or replace function public._send_push(p_user uuid, p_product text, p_title text, p_body text, p_url text, p_tag text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('push_webhook_url');
  v_sec text := public._secret('push_webhook_secret');
  v_req bigint;
begin
  if v_url is null or v_sec is null then return false; end if;
  if not exists (
    select 1 from public.push_subscription s join public.profile p on p.id = s.user_id
     where s.user_id = p_user and p.is_active and (case when p_product = 'miro' then s.miro else s.trello end)
  ) then return false; end if;
  v_req := net.http_post(
    url     := v_url,
    body    := jsonb_build_object('user_id', p_user, 'product', p_product, 'title', left(p_title, 120),
                                  'body', left(coalesce(p_body, ''), 400), 'url', p_url, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec));
  insert into public.outbound_message (channel, user_id, status, request_id) values ('push', p_user, 'sent', v_req);
  return true;
end $$;
revoke all on function public._send_push(uuid, text, text, text, text, text) from public;

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
    else new.kind end;
  if v_kind = 'whiteboard' then
    v_link := (select rtrim(app_url, '/') from public.workspace limit 1) || '/#/wb/' || new.board_id
              || coalesce('?doc=' || (new.data->>'doc_id'), '?comment=' || (new.data->>'thread_id'), '');
  else
    v_link := (select rtrim(app_url, '/') from public.workspace limit 1) || '/#/pm/boards/' || new.board_id
              || coalesce('/cards/' || new.card_id, '');
  end if;
  v_msg := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
           || coalesce(E'\n"' || nullif(new.data->>'excerpt', '') || '"', '')
           || case when new.board_id is not null then E'\n' || v_link else '' end;
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  begin
    if c.user_id is not null and c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'iklipse: ' || v_msg); end if;
    if c.user_id is not null and c.notify_email then perform public._send_email(new.user_id, 'iklipse: ' || v_what, v_msg); end if;
    perform public._send_push(new.user_id, case when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro' else 'trello' end,
                              v_what, v_body, case when new.board_id is not null then v_link end, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

-- "Send a test" in the device notification settings.
create or replace function public.push_test()
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_url text := (select app_url from public.workspace limit 1);
begin
  if auth.uid() is null or not public.am_active() then raise exception 'not signed in'; end if;
  return public._send_push(auth.uid(), 'trello', 'Notifications are on', 'This is how iklipse notifications look.', v_url, 'test')
      or public._send_push(auth.uid(), 'miro', 'Notifications are on', 'This is how iklipse notifications look.', v_url, 'test');
end $$;
revoke all on function public.push_test() from public;
grant execute on function public.push_test() to authenticated;
