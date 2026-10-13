-- 0060: Briefs are for workspace admins only. Admins make links and read the
-- answers; everyone else has no access, whatever brief_role says (the column
-- stays so older rows don't break, but it no longer grants anything).

create or replace function public._brief_role(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select 'create'::text
    from public.profile p
   where p.id = p_user and p.is_active and p.role::text = 'admin';
$$;
revoke all on function public._brief_role(uuid) from public, anon, authenticated;
