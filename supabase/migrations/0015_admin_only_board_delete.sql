-- =============================================================================
-- 0015 — Only workspace admins can delete boards (fixed rule, not a setting).
-- The board_delete policy (RLS) and my_board_access() already go through
-- can_delete_board(), so redefining it is enough.
-- =============================================================================

create or replace function public.can_delete_board(b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() and exists (select 1 from public.board where id = b);
$$;

-- Keep the stored setting consistent with the rule.
alter table public.workspace alter column board_delete_policy set default 'admins';
update public.workspace set board_delete_policy = 'admins' where board_delete_policy <> 'admins';
