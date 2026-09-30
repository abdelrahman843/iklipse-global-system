-- ============================================================================
-- 0035_automation_schedule_avatars.sql
--   1. pg_cron runs automation_tick() every 5 minutes (due date + schedule
--      triggers from 0034).
--   2. Avatars: people upload their own picture. Files must sit in a folder
--      named after the uploader, images only, 2 MB max.
-- ============================================================================

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'automation-tick') then
    perform cron.unschedule('automation-tick');
  end if;
  perform cron.schedule('automation-tick', '*/5 * * * *', 'select public.automation_tick()');
end $$;

update storage.buckets
   set file_size_limit = 2097152,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
 where id = 'avatars';

drop policy if exists avatars_write on storage.objects;
create policy avatars_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and owner = auth.uid()
              and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid())
  with check (bucket_id = 'avatars' and owner = auth.uid()
              and (storage.foldername(name))[1] = auth.uid()::text);
