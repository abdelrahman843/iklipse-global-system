-- ============================================================================
-- wipe.sql — DESTRUCTIVE. Empties the project's `public` schema and every
-- auth user, so the migrations in supabase/migrations/ can be re-run cleanly.
--
-- Storage (buckets + objects) is NOT touched here: Supabase reserves the
-- storage.* tables to the storage-admin role and blocks direct SQL writes.
-- If you also want to wipe old files, delete each bucket manually from
-- Studio → Storage → <bucket> → ... → Delete bucket. The migrations
-- (0003_rpc_ordering.sql) will recreate the `avatars` and `attachments`
-- buckets on the next run.
-- ============================================================================

begin;

-- 1) Nuke the public schema and rebuild it with the standard Supabase grants.
drop schema if exists public cascade;
create schema public;

grant usage on schema public to postgres, anon, authenticated, service_role;
grant all   on schema public to postgres, service_role;

-- Default privileges for objects created AFTER this point (i.e. everything in
-- the migrations). RLS still gates every row; these are the PostgREST-level
-- prerequisites that Supabase applies to a fresh `public` schema.
alter default privileges in schema public
  grant select, insert, update, delete on tables    to authenticated;
alter default privileges in schema public
  grant select                          on tables    to anon;
alter default privileges in schema public
  grant usage, select                   on sequences to anon, authenticated;
alter default privileges in schema public
  grant execute                         on functions to anon, authenticated;
alter default privileges in schema public
  grant all on tables, sequences, functions to postgres, service_role;

-- 2) Auth users. Cascades through any auth foreign keys.
delete from auth.users;

commit;

-- After this runs:
--   * public schema is empty and re-created.
--   * auth.users is empty.
-- Next: paste supabase/migrations/apply-all.sql (or run the six files
-- 0001..0006 in order) and create a fresh admin from
-- Studio → Authentication → Add user.
