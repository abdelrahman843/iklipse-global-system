-- 0055_signup_lock.sql
--   From the database security review. Accounts are only made by an admin
--   (Users page -> admin-create-member), but if Supabase's own sign-up were
--   left open with email confirmation off, a stranger could still make an
--   auth account directly, and it would arrive confirmed, so active.
--
--   Now a new account starts active only when the admin function made it: it
--   sets app_metadata.provisioned = 'admin', which only the service role can
--   write. Anything else (an open sign-up, a user added by hand in the
--   Supabase dashboard) starts deactivated until an admin switches it on.
--   The role also comes from app_metadata (admin-create-member now puts it
--   there), so an admin or guest account is made with that role.
--   Existing accounts are untouched.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_username text;
  v_display  text;
  v_role     public.role;
  v_by_admin boolean;
begin
  v_username := coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1));
  v_display  := coalesce(new.raw_user_meta_data ->> 'display_name', v_username);
  -- Only the service role can write app metadata; user metadata is the signer's.
  v_by_admin := coalesce(new.raw_app_meta_data ->> 'provisioned', '') = 'admin';
  v_role     := case when v_by_admin then coalesce((new.raw_app_meta_data ->> 'role')::public.role, 'member') else 'member' end;
  insert into public.profile (id, username, display_name, role, is_active)
  values (new.id, v_username, v_display, v_role, v_by_admin and new.email_confirmed_at is not null)
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
