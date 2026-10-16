-- 0075_watch_promise_minute.sql
--   Alerts settings: "A promise with no time is due after" takes any number of
--   minutes from 1 (it was 5 at least), like the other minute settings.
alter table public.watch_settings drop constraint if exists watch_settings_promise_wait_min_check;
alter table public.watch_settings add constraint watch_settings_promise_wait_min_check check (promise_wait_min between 1 and 2880);
