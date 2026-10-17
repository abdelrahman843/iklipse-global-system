-- ============================================================================
-- 0082_zoom_data_goes_with_account.sql
--   A Zoom account disconnected in iklipse, or iklipse removed from it in Zoom
--   (zoom function, /zoom/events), takes the meetings the WhatsApp bot booked
--   on it along: Zoom's data about that account doesn't stay behind.
-- ============================================================================

alter table public.wa_bot_meeting drop constraint if exists wa_bot_meeting_account_fkey;
alter table public.wa_bot_meeting add constraint wa_bot_meeting_account_fkey
  foreign key (account) references public.zoom_account(id) on delete cascade;
