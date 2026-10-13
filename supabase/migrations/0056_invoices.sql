-- 0056_invoices.sql
--   Invoices, in iklipse instead of n8n ("Email Invoices"). Admins only.
--
--   Admins pick Gmail accounts to read (invoice_source) and Drive accounts to
--   file into (invoice_target), each one an account they connected themselves.
--   Every two minutes the database wakes the invoices function (pg_cron +
--   pg_net, like push-send). It looks in each Gmail for invoice, receipt and
--   refund emails with a file, has the AI read them (provider, number, date,
--   amount, currency, who bought it, refund or not), uploads the files to every
--   Drive (a folder per month, invoices-Jul-2026, with a refunds folder inside)
--   and keeps one row per email here (invoice). Admins get a notification for
--   each new one. The Invoices page shows a month at a time.
--
--   Nothing here is readable straight from the app: admins read and change it
--   through the functions below; the invoices function uses the service role.

-- ------------------------------------------------------------------ tables --
create table if not exists public.invoice_settings (
  id          int primary key default 1 check (id = 1),
  enabled     boolean not null default false,
  -- Emails from this day on are read (the first run reads back to it).
  start_date  date not null default (date_trunc('month', (now() at time zone 'Africa/Cairo')) - interval '1 month')::date,
  updated_by  uuid references public.profile(id) on delete set null,
  updated_at  timestamptz not null default now()
);
insert into public.invoice_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.invoice_source (
  account_id  uuid primary key references public.gmail_account(id) on delete cascade,
  added_by    uuid references public.profile(id) on delete set null,
  added_at    timestamptz not null default now(),
  last_run_at timestamptz,
  last_error  text
);

create table if not exists public.invoice_target (
  account_id  uuid primary key references public.drive_account(id) on delete cascade,
  -- The folder the month folders go in (null = the top of the Drive).
  parent_id   text,
  parent_name text,
  added_by    uuid references public.profile(id) on delete set null,
  added_at    timestamptz not null default now(),
  last_error  text
);

-- The month folders made in each Drive (and the last sheet exported there).
create table if not exists public.invoice_folder (
  account_id  uuid not null references public.drive_account(id) on delete cascade,
  month       date not null,
  folder_id   text not null,
  refunds_id  text not null,
  sheet_id    text,
  primary key (account_id, month)
);

create table if not exists public.invoice (
  id              uuid primary key default gen_random_uuid(),
  source_id       uuid references public.gmail_account(id) on delete set null,
  -- The Gmail it came to.
  mailbox         text not null,
  message_id      text not null,
  thread_id       text,
  status          text not null default 'processing' check (status in ('processing', 'done', 'skipped', 'failed')),
  attempts        int not null default 0,
  error           text,
  sender_name     text,
  sender_email    text,
  subject         text,
  received_at     timestamptz,
  is_refund       boolean not null default false,
  provider        text,
  invoice_number  text,
  description     text,
  -- The account that made the purchase (the "billed to" email).
  purchaser_email text,
  invoice_date    date,
  amount          numeric(14, 2),
  currency        text,
  -- First day of the month it's filed under.
  month           date,
  -- [{ account, email, id, name, link }]: where its files went in Drive.
  files           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (mailbox, message_id)
);
create index if not exists invoice_month_idx on public.invoice (month, status);
create index if not exists invoice_retry_idx on public.invoice (status, updated_at) where status in ('processing', 'failed');

alter table public.invoice_settings enable row level security;
alter table public.invoice_source   enable row level security;
alter table public.invoice_target   enable row level security;
alter table public.invoice_folder   enable row level security;
alter table public.invoice          enable row level security;
revoke all on public.invoice_settings, public.invoice_source, public.invoice_target, public.invoice_folder, public.invoice from anon, authenticated;

-- ---------------------------------------------------------------- reading --
-- Settings, the Gmail and Drive accounts in use, and the caller's own
-- accounts that can still be added.
create or replace function public.invoices_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return jsonb_build_object(
    'settings', (select jsonb_build_object('enabled', s.enabled, 'start_date', s.start_date, 'updated_at', s.updated_at,
                                           'updated_by', (select display_name from public.profile where id = s.updated_by))
                   from public.invoice_settings s where s.id = 1),
    'sources', coalesce((select jsonb_agg(jsonb_build_object(
                  'account_id', g.id, 'email', g.email, 'owner', p.display_name, 'mine', g.user_id = auth.uid(),
                  'added_at', s.added_at, 'last_run_at', s.last_run_at, 'last_error', s.last_error) order by s.added_at)
                 from public.invoice_source s join public.gmail_account g on g.id = s.account_id
                 left join public.profile p on p.id = g.user_id), '[]'::jsonb),
    'targets', coalesce((select jsonb_agg(jsonb_build_object(
                  'account_id', d.id, 'email', d.email, 'owner', p.display_name, 'mine', d.user_id = auth.uid(),
                  'parent_id', t.parent_id, 'parent_name', t.parent_name,
                  'added_at', t.added_at, 'last_error', t.last_error) order by t.added_at)
                 from public.invoice_target t join public.drive_account d on d.id = t.account_id
                 left join public.profile p on p.id = d.user_id), '[]'::jsonb),
    'my_gmail', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'email', g.email) order by g.connected_at)
                 from public.gmail_account g
                where g.user_id = auth.uid() and not exists (select 1 from public.invoice_source s where s.account_id = g.id)), '[]'::jsonb),
    'my_drive', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'email', d.email) order by d.connected_at)
                 from public.drive_account d
                where d.user_id = auth.uid() and not exists (select 1 from public.invoice_target t where t.account_id = d.id)), '[]'::jsonb),
    'pending', (select count(*) from public.invoice where status = 'processing')
  );
end $$;

-- One month: what was read, filed under that month (skipped and failed ones
-- by the month they arrived).
create or replace function public.invoices_month(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', p_month)::date;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(i) - 'attempts' order by coalesce(i.invoice_date, (i.received_at at time zone 'Africa/Cairo')::date) desc, i.received_at desc)
      from public.invoice i
     where i.status <> 'processing'
       and (case when i.status = 'done' then i.month
                 else date_trunc('month', i.received_at at time zone 'Africa/Cairo')::date end) = v_from
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- changing --
create or replace function public.invoices_settings_set(p_enabled boolean, p_start date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_start is null or p_start < date '2015-01-01' or p_start > (now() at time zone 'Africa/Cairo')::date then
    raise exception 'Pick a start date that isn''t in the future';
  end if;
  update public.invoice_settings
     set enabled = coalesce(p_enabled, false), start_date = p_start, updated_by = auth.uid(), updated_at = now()
   where id = 1;
end $$;

create or replace function public.invoices_source_add(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if not exists (select 1 from public.gmail_account where id = p_account and user_id = auth.uid()) then
    raise exception 'Connect that Gmail account yourself first (Connections page)';
  end if;
  insert into public.invoice_source (account_id, added_by) values (p_account, auth.uid()) on conflict (account_id) do nothing;
end $$;

create or replace function public.invoices_source_remove(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  delete from public.invoice_source where account_id = p_account;
end $$;

-- (A Drive is added by the invoices function: it checks the folder picked.)
create or replace function public.invoices_target_remove(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  delete from public.invoice_target where account_id = p_account;
end $$;

-- Read an email again (the AI got it wrong, or it failed): it's forgotten
-- and picked up on the next run like a new one.
create or replace function public.invoices_reread(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  delete from public.invoice where id = p_id and status <> 'processing';
end $$;

-- Not an invoice after all: out of the list (its files stay in Drive).
create or replace function public.invoices_dismiss(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.invoice
     set status = 'skipped',
         error = 'Removed by ' || coalesce((select display_name from public.profile where id = auth.uid()), 'an admin'),
         updated_at = now()
   where id = p_id and status = 'done';
end $$;

revoke all on function public.invoices_overview(), public.invoices_month(date), public.invoices_settings_set(boolean, date),
  public.invoices_source_add(uuid), public.invoices_source_remove(uuid), public.invoices_target_remove(uuid),
  public.invoices_reread(uuid), public.invoices_dismiss(uuid) from public, anon;
grant execute on function public.invoices_overview(), public.invoices_month(date), public.invoices_settings_set(boolean, date),
  public.invoices_source_add(uuid), public.invoices_source_remove(uuid), public.invoices_target_remove(uuid),
  public.invoices_reread(uuid), public.invoices_dismiss(uuid) to authenticated;

-- ----------------------------------------------------------------- the run --
-- Wakes the invoices function (only when switched on and there's a Gmail to read).
create or replace function public._invoices_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('invoices_webhook_url');
  v_sec text := public._secret('invoices_webhook_secret');
begin
  if v_url is null or v_sec is null then return; end if;
  if not exists (select 1 from public.invoice_settings where id = 1 and enabled) then return; end if;
  if not exists (select 1 from public.invoice_source) then return; end if;
  perform net.http_post(
    url     := v_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec),
    timeout_milliseconds := 150000);
end $$;
revoke all on function public._invoices_tick() from public, anon, authenticated;
-- The invoices function reads with the AI assistant's OpenAI key.
grant execute on function public.ai_key() to service_role;

do $$ begin
  perform cron.unschedule('invoices-tick') where exists (select 1 from cron.job where jobname = 'invoices-tick');
  perform cron.schedule('invoices-tick', '*/2 * * * *', 'select public._invoices_tick()');
end $$;

-- ---------------------------------------------- notifications to channels --
-- Same as 0054, plus invoices and refunds (they open the Invoices page).
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
    when 'invoice_saved'    then 'New invoice: ' || coalesce(new.data->>'provider', 'Invoice')
                              || coalesce(' · ' || (new.data->>'amount') || coalesce(' ' || (new.data->>'currency'), ''), '')
    when 'refund_saved'     then 'New refund: ' || coalesce(new.data->>'provider', 'Refund')
                              || coalesce(' · ' || (new.data->>'amount') || coalesce(' ' || (new.data->>'currency'), ''), '')
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared?tab=mail';
  elsif new.kind like 'drive\_%' then
    v_link := v_app || '/#/shared?tab=drive';
  elsif new.kind in ('invoice_saved', 'refund_saved') then
    v_link := v_app || '/#/invoices' || coalesce('?month=' || left(new.data->>'month', 7), '');
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
    -- Shared mail, Drive and invoices go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%'
                                        or new.kind in ('invoice_saved', 'refund_saved') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

notify pgrst, 'reload schema';
