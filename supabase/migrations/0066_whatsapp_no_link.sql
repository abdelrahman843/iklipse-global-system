-- 0066: WhatsApp notifications without the system link.
--
-- Messages on the phone shouldn't show the app's address. WhatsApp now gets
-- what happened and where (card, board, the words said) only; email keeps the
-- link so it can be opened; push opens the page on tap and never showed it.
-- Same function as 0062 otherwise.

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
  -- Email keeps the link to open it; WhatsApp (read on phones) has the words only.
  v_msg := v_text || coalesce(E'\n' || v_link, '');
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  begin
    if c.user_id is not null and c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'iklipse: ' || v_text); end if;
    if c.user_id is not null and c.notify_email then perform public._send_email(new.user_id, 'iklipse: ' || v_what, v_msg); end if;
    -- Shared mail, Drive, meetings, invoices and projects go to every device (push product 'mail').
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when new.kind like 'mail\_%' or new.kind like 'drive\_%' or new.kind like 'project\_%' or new.kind like 'delivery\_%'
                                        or new.kind in ('invoice_saved', 'refund_saved', 'invoice_needs_file', 'meeting_shared') then 'mail'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
