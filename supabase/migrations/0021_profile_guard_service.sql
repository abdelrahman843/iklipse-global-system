-- ============================================================================
-- 0021_profile_guard_service.sql
--   The admin-update-member edge function writes profile rows with the
--   service role, where auth.uid() is null, so is_admin() was false and the
--   guard rejected every username / role / status change made from the Users
--   page ("Not authorised to change username"). The function already checks
--   that the caller is an admin; the guard now only applies to signed-in
--   users editing through the API.
-- ============================================================================

create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role       is distinct from old.role       then raise exception 'Not authorised to change role'; end if;
    if new.is_active  is distinct from old.is_active  then raise exception 'Not authorised to change status'; end if;
    if new.username   is distinct from old.username   then raise exception 'Not authorised to change username'; end if;
  end if;
  return new;
end $$;
