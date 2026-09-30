-- ============================================================================
-- 0032_trello_avatar_follow.sql
--   Trello avatar URLs are versioned: when a person changes their picture the
--   old URL starts returning 403. The profile kept the URL copied at link time,
--   so it broke. The sync now carries a new Trello avatar over to the linked
--   profile, as long as that profile still shows a Trello picture (an avatar
--   the user set in this system is never replaced).
-- ============================================================================

create or replace function public._trello_member_upsert(m jsonb, p_current boolean)
returns void language plpgsql set search_path = public as $$
declare
  tid text := m->>'id';
  av  text := nullif(m->>'avatarUrl', '');
begin
  if tid is null then return; end if;
  if av is not null and av !~ '\.png$' then av := av || '/170.png'; end if;
  if exists (select 1 from public.trello_member where trello_id = tid) then
    update public.trello_member
       set full_name  = coalesce(nullif(m->>'fullName', ''), full_name),
           username   = coalesce(nullif(m->>'username', ''), username),
           avatar_url = coalesce(av, avatar_url),
           is_current = is_current or p_current,
           updated_at = now()
     where trello_id = tid
       and (full_name, username, avatar_url, is_current) is distinct from
           (coalesce(nullif(m->>'fullName', ''), full_name), coalesce(nullif(m->>'username', ''), username),
            coalesce(av, avatar_url), is_current or p_current);
    if av is not null then
      update public.profile p
         set avatar_url = av
        from public.trello_member tm
       where tm.trello_id = tid and p.id = tm.profile_id
         and p.avatar_url like 'https://trello-members.s3.amazonaws.com/%'
         and p.avatar_url <> av;
    end if;
  else
    insert into public.trello_member (trello_id, full_name, username, avatar_url, is_current, suggested_username)
    values (tid, coalesce(m->>'fullName', ''), m->>'username', av, p_current,
            public._trello_suggest(m->>'fullName', m->>'username'));
  end if;
end $$;
revoke execute on function public._trello_member_upsert(jsonb, boolean) from public, anon, authenticated;

-- One-off: bring stale Trello pictures up to date now.
update public.profile p
   set avatar_url = tm.avatar_url
  from public.trello_member tm
 where tm.profile_id = p.id
   and tm.avatar_url is not null
   and p.avatar_url like 'https://trello-members.s3.amazonaws.com/%'
   and p.avatar_url <> tm.avatar_url;
