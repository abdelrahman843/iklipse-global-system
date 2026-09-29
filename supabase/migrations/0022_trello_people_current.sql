-- ============================================================================
-- 0022_trello_people_current.sql
--   "Current" now means: a member of a board that is actually synced (the
--   stored snapshots), not of any board the Trello account ever saw. People
--   only on closed boards with nothing mirrored drop out of the Users list.
-- ============================================================================

update public.trello_member tm
   set is_current = exists (
         select 1 from public.trello_raw r, jsonb_array_elements(coalesce(r.data->'members', '[]')) m
          where r.key like 'board:%' and m->>'id' = tm.trello_id);

create or replace function public.trello_people()
returns table (trello_id text, full_name text, trello_username text, avatar_url text,
               suggested_username text, profile_id uuid, is_current boolean, authored bigint)
language sql stable security definer set search_path = public as $$
  select tm.trello_id, tm.full_name, tm.username, tm.avatar_url, tm.suggested_username, tm.profile_id,
         exists (select 1 from public.trello_raw r, jsonb_array_elements(coalesce(r.data->'members', '[]')) m
                  where r.key like 'board:%' and m->>'id' = tm.trello_id),
         (select count(*) from public.trello_author ta where ta.trello_member_id = tm.trello_id)
    from public.trello_member tm
   where public.is_admin()
   order by 7 desc, tm.full_name;
$$;
