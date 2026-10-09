-- 0046_notification_texts.sql
--   WhatsApp / email texts for the split Trello / Miro notifications:
--   client comments from share links (0045) and "added to a Trello / Miro
--   board". Same as 0041 otherwise.

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
  begin
    if c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'Iklipse: ' || v_msg); end if;
    if c.notify_email then perform public._send_email(new.user_id, 'Iklipse: ' || v_what, v_msg); end if;
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;
revoke execute on function public.on_notification_channels() from public, anon, authenticated;

-- Trello notifications only reach people who can see the board (with separate
-- Trello / Miro roles, being mentioned is not enough).
create or replace function public.notify_users(p_user_ids uuid[], p_board uuid, p_card uuid, p_kind text, p_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if coalesce(current_setting('app.trello_sync', true), '') = '1' then return; end if;
  if p_user_ids is null or cardinality(p_user_ids) = 0 then return; end if;
  insert into public.notification (user_id, board_id, card_id, kind, data)
  select distinct u, p_board, p_card, p_kind, coalesce(p_data, '{}'::jsonb)
    from unnest(p_user_ids) as u
   where u is not null
     and u is distinct from v_actor
     and (p_board is null or public._can_see_board_as(u, p_board));
end $$;
