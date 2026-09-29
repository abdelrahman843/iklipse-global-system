-- ============================================================================
-- 0023_admin_delete_member.sql
--   Workspace admins can delete a user for good (Users page -> Edit -> Delete).
--   Work they left behind is kept, like Trello: their comments, cards,
--   history, uploads, boards and rules move to the workspace admin account,
--   checklist items they were assigned to become unassigned. Their board and
--   card memberships, reactions, notifications and AI usage go with them.
--   A Trello person linked to the account falls back to showing their Trello
--   name on mirrored items (0020) and can be linked again later.
-- ============================================================================

create or replace function public.admin_delete_member(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  heir  uuid;
  moved int := 0;
  n     int;
begin
  if not public.is_admin() then raise exception 'Only workspace admins can delete users'; end if;
  if p_user = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  if not exists (select 1 from public.profile where id = p_user) then raise exception 'User not found'; end if;

  select id into heir from public.profile
   where role = 'admin' and is_active and id <> p_user
   order by created_at limit 1;
  if heir is null then raise exception 'The workspace needs at least one other active admin first'; end if;

  -- no notifications / automations / activity rows from the hand-over
  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);

  update public.comment         set author_id   = heir where author_id   = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.card            set created_by  = heir where created_by  = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.activity        set actor_id    = heir where actor_id    = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.attachment      set uploaded_by = heir where uploaded_by = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.board           set created_by  = heir where created_by  = p_user;
  update public.automation_rule set created_by  = heir where created_by  = p_user;
  update public.checklist_item  set assignee_id = null where assignee_id = p_user;
  update public.user_permission set granted_by  = null where granted_by  = p_user;

  -- removing the login removes the profile and everything that cascades from it
  delete from auth.users where id = p_user;

  return jsonb_build_object('moved_to', heir, 'items_moved', moved);
end $$;

revoke all on function public.admin_delete_member(uuid) from public, anon;
grant execute on function public.admin_delete_member(uuid) to authenticated;
