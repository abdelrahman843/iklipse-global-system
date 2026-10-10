-- 0051_create_board_id.sql
--   Offline mode: create_board takes the new board's id from the app (p_id),
--   so a board made with no network can be opened and filled at once; the
--   call is queued on the device and sent later (src/lib/offline/outbox.ts).
--   Sending the same call twice (a retry whose answer got lost) returns the
--   board made the first time instead of failing or making a second one.
--   Callers that don't pass p_id (MCP server, older apps) work as before.

drop function if exists public.create_board(text, text, text, public.board_visibility, text);

CREATE OR REPLACE FUNCTION public.create_board(
  p_title text,
  p_description text DEFAULT NULL::text,
  p_background text DEFAULT NULL::text,
  p_visibility board_visibility DEFAULT 'workspace'::board_visibility,
  p_kind text DEFAULT 'kanban'::text,
  p_id uuid DEFAULT NULL::uuid
)
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
  v_owner uuid;
begin
  if not public.can_create_board_kind(coalesce(p_kind, 'kanban')) then
    raise exception 'Not authorised';
  end if;
  if v_kind not in ('kanban', 'whiteboard') then
    raise exception 'Unknown board type';
  end if;

  if p_id is not null then
    select created_by into v_owner from public.board where id = p_id;
    if found then
      -- Already made by this same call: done.
      if v_owner = v_uid then return p_id; end if;
      raise exception 'Board id already in use';
    end if;
  end if;

  insert into public.board (id, workspace_id, title, description, background, created_by, visibility, kind)
  values (coalesce(p_id, gen_random_uuid()), v_ws, p_title, p_description, p_background, v_uid, coalesce(p_visibility, 'workspace'), v_kind)
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
end $function$;

revoke all on function public.create_board(text, text, text, public.board_visibility, text, uuid) from public, anon;
grant execute on function public.create_board(text, text, text, public.board_visibility, text, uuid) to authenticated;

notify pgrst, 'reload schema';
