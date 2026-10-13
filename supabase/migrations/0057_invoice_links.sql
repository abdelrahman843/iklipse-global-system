-- 0057_invoice_links.sql
--   Invoices that come as a link (Fiverr and others: no file in the email,
--   "download your invoice" instead). The invoices function now also reads
--   invoice emails without a file; when the AI says it's an invoice, the row
--   waits as 'needs_file' with the link it found (download_url). On the
--   Invoices page an admin downloads it from there and uploads it, and it's
--   read and filed in Drive like the rest. Admins get a notification for each.

alter table public.invoice drop constraint if exists invoice_status_check;
alter table public.invoice add constraint invoice_status_check
  check (status in ('processing', 'done', 'needs_file', 'skipped', 'failed'));
alter table public.invoice add column if not exists download_url text;
create index if not exists invoice_needs_file_idx on public.invoice (received_at desc) where status = 'needs_file';

-- A month (the ones waiting for a file are listed on their own, below).
create or replace function public.invoices_month(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', p_month)::date;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(i) - 'attempts' order by coalesce(i.invoice_date, (i.received_at at time zone 'Africa/Cairo')::date) desc, i.received_at desc)
      from public.invoice i
     where i.status in ('done', 'skipped', 'failed')
       and (case when i.status = 'done' then i.month
                 else date_trunc('month', i.received_at at time zone 'Africa/Cairo')::date end) = v_from
  ), '[]'::jsonb);
end $$;

-- Every invoice still waiting for its file, newest first (whatever the month).
create or replace function public.invoices_needing_files()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(i) - 'attempts' order by i.received_at desc)
      from public.invoice i where i.status = 'needs_file'
  ), '[]'::jsonb);
end $$;
revoke all on function public.invoices_needing_files() from public, anon;
grant execute on function public.invoices_needing_files() to authenticated;

create or replace function public.invoices_dismiss(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.invoice
     set status = 'skipped',
         error = 'Removed by ' || coalesce((select display_name from public.profile where id = auth.uid()), 'an admin'),
         updated_at = now()
   where id = p_id and status in ('done', 'needs_file');
end $$;

-- ---------------------------------------------- notifications to channels --
-- Same as 0056, plus "an invoice needs its file".
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
    when 'invoice_needs_file' then 'Invoice to download: ' || coalesce(new.data->>'provider', 'Invoice')
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif new.kind like 'mail\_%' then
    v_link := v_app || '/#/shared?tab=mail';
  elsif new.kind like 'drive\_%' then
    v_link := v_app || '/#/shared?tab=drive';
  elsif new.kind = 'invoice_needs_file' then
    v_link := v_app || '/#/invoices?tab=files';
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
                                        or new.kind in ('invoice_saved', 'refund_saved', 'invoice_needs_file') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

notify pgrst, 'reload schema';
