-- ============================================================================
-- 0025_board_mirrors.sql
--   board_mirrors(board): for every mirror card on a board, what the board
--   should show in its place: the real card's title, dates, cover, labels,
--   members and where it lives. Only real cards the caller can see come back;
--   a mirror of a card on a board they can't open keeps showing its link.
-- ============================================================================

drop function if exists public.board_mirrors(uuid);
create function public.board_mirrors(p_board uuid)
returns table (
  card_id uuid, target_id uuid, board_id uuid, board_title text, list_title text,
  title text, has_description boolean, due_date timestamptz, due_completed boolean,
  start_date date, cover_color text, is_archived boolean, labels jsonb, members jsonb
)
language sql stable security definer set search_path = public as $$
  select k.id, t.id, t.board_id, b.title, l.title,
         t.title, t.description is not null and t.description <> '', t.due_date, t.due_completed,
         t.start_date, t.cover_color, t.is_archived,
         coalesce((select jsonb_agg(jsonb_build_object('name', lb.name, 'color', lb.color) order by lb.position)
                     from public.card_label cl join public.label lb on lb.id = cl.label_id
                    where cl.card_id = t.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'avatar_url', p.avatar_url))
                     from public.card_member cm join public.profile p on p.id = cm.user_id
                    where cm.card_id = t.id), '[]'::jsonb)
    from public.card k
    join public.card t on t.id = k.mirror_of
    join public.board b on b.id = t.board_id
    join public.list l on l.id = t.list_id
   where k.board_id = p_board
     and p_board in (select public.visible_board_ids())
     and t.board_id in (select public.visible_board_ids());
$$;

revoke all on function public.board_mirrors(uuid) from public, anon;
grant execute on function public.board_mirrors(uuid) to authenticated;
