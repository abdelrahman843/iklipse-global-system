-- 0041_wb_doc_mentions.sql
--   @mentions inside Miro docs. The doc text is a Yjs log the server can't
--   read, so the editor reports a mention the moment it is inserted; the
--   server checks the caller may edit the board and the person can see it,
--   and holds back repeats (same author, person and doc within 10 minutes).
--   Images in docs reuse the private 'whiteboard' bucket (0038) as is.

create or replace function public.wb_doc_mention(p_board uuid, p_doc uuid, p_user uuid, p_excerpt text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := auth.uid();
  v_by    text;
  v_title text;
  v_doc   text;
begin
  if v_me is null or not public.can_edit_board(p_board) then
    raise exception 'Not authorised';
  end if;
  if p_user is null or p_user = v_me or not public._can_see_board_as(p_user, p_board) then
    return false;
  end if;
  select coalesce(nullif(trim(data->>'title'), ''), 'Untitled doc') into v_doc
    from public.wb_item where id = p_doc and board_id = p_board and type = 'doc';
  if not found then return false; end if;  -- not saved yet, or not a doc on this board
  if exists (
    select 1 from public.notification
     where user_id = p_user and board_id = p_board and kind = 'wb_mention'
       and data->>'doc_id' = p_doc::text and data->>'by_id' = v_me::text
       and created_at > now() - interval '10 minutes') then
    return false;
  end if;
  select title into v_title from public.board where id = p_board;
  select display_name into v_by from public.profile where id = v_me;
  insert into public.notification (user_id, board_id, kind, data)
  values (p_user, p_board, 'wb_mention', jsonb_build_object(
    'doc_id', p_doc, 'doc_title', v_doc, 'board_title', v_title, 'by', v_by, 'by_id', v_me,
    'excerpt', left(regexp_replace(coalesce(p_excerpt, ''), '\s+', ' ', 'g'), 140)));
  return true;
end $$;
revoke all on function public.wb_doc_mention(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.wb_doc_mention(uuid, uuid, uuid, text) to authenticated;

-- ------------------------------------------- notifications to channels --
-- Same as 0038, plus doc mentions ("mentioned you in <doc>") that open the doc.
create or replace function public.on_notification_channels()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c      public.profile_contact;
  v_card text;
  v_brd  text;
  v_kind text;
  v_what text;
  v_link text;
  v_msg  text;
begin
  select * into c from public.profile_contact where user_id = new.user_id;
  if not found or not (c.notify_whatsapp or c.notify_email) then return new; end if;
  select title into v_card from public.card where id = new.card_id;
  select title, kind into v_brd, v_kind from public.board where id = new.board_id;
  v_what := case new.kind
    when 'mention'       then 'You were mentioned'
    when 'assigned'      then 'You were added to a card'
    when 'comment'       then 'New comment'
    when 'due_changed'   then 'Due date changed'
    when 'due_completed' then 'Marked complete'
    when 'board_invited' then 'You were added to a board'
    when 'automation'    then coalesce(nullif(new.data->>'text', ''), 'Rule')
    when 'wb_mention'    then coalesce(new.data->>'by', 'Someone') || ' mentioned you'
                              || coalesce(' in ' || (new.data->>'doc_title'), '')
    when 'wb_reply'      then coalesce(new.data->>'by', 'Someone') || ' replied'
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
  begin
    if c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'Iklipse: ' || v_msg); end if;
    if c.notify_email then perform public._send_email(new.user_id, 'Iklipse: ' || v_what, v_msg); end if;
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
revoke execute on function public.on_notification_channels() from public, anon, authenticated;
