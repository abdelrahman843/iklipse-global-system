-- ============================================================================
-- 0020_trello_author_names.sql
--   Until a Trello person has an account, their mirrored comments and history
--   are stored under the fallback admin (author_id / actor_id are NOT NULL).
--   This lets the card show who really wrote them: for one card, the Trello
--   name and avatar of every comment / activity row whose author is not yet
--   linked. Linked people drop out and the normal profile join takes over.
-- ============================================================================

create or replace function public.trello_card_authors(p_card uuid)
returns table (entity_id uuid, name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select ta.entity_id, tm.full_name, tm.avatar_url
    from public.trello_author ta
    join public.trello_member tm on tm.trello_id = ta.trello_member_id and tm.profile_id is null
   where p_card in (select public.visible_card_ids())
     and (   (ta.entity_type = 'comment'  and ta.entity_id in (select id from public.comment  where card_id = p_card))
          or (ta.entity_type = 'activity' and ta.entity_id in (select id from public.activity where card_id = p_card)));
$$;

revoke all on function public.trello_card_authors(uuid) from public, anon;
grant execute on function public.trello_card_authors(uuid) to authenticated;
