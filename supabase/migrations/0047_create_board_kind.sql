-- 0047_create_board_kind.sql
--   create_board checks the role for the kind of board being made (0044):
--   no Miro access means no new Miro boards, even through this function.

CREATE OR REPLACE FUNCTION public.create_board(p_title text, p_description text DEFAULT NULL::text, p_background text DEFAULT NULL::text, p_visibility board_visibility DEFAULT 'workspace'::board_visibility, p_kind text DEFAULT 'kanban'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_ws uuid := '00000000-0000-0000-0000-000000000001';
  v_uid uuid := auth.uid();
  v_pos text;
  v_kind text := coalesce(p_kind, 'kanban');
begin
  if not public.can_create_board_kind(coalesce(p_kind, 'kanban')) then
    raise exception 'Not authorised';
  end if;
  if v_kind not in ('kanban', 'whiteboard') then
    raise exception 'Unknown board type';
  end if;

  insert into public.board (workspace_id, title, description, background, created_by, visibility, kind)
  values (v_ws, p_title, p_description, p_background, v_uid, coalesce(p_visibility, 'workspace'), v_kind)
  returning id into v_id;

  if v_kind = 'whiteboard' then
    perform set_config('iklipse.wb_owner', 'on', true);
    insert into public.board_member (board_id, user_id, role, wb_role) values (v_id, v_uid, 'admin', 'owner');
    perform set_config('iklipse.wb_owner', 'off', true);
  else
    insert into public.board_member (board_id, user_id, role) values (v_id, v_uid, 'admin');
    v_pos := public.rank_between(null, null);
    for i in 1..6 loop
      insert into public.label (board_id, name, color, position)
      values (
        v_id,
        '',
        (array['#61bd4f','#f2d600','#ff9f1a','#eb5a46','#c377e0','#0079bf'])[i],
        public.rank_between(v_pos, null)
      );
      v_pos := public.rank_between(v_pos, null);
    end loop;
  end if;

  perform public.log_activity(v_id, null, 'board.created', jsonb_build_object('title', p_title, 'kind', v_kind));
  return v_id;
end $function$

;
