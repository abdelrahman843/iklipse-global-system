-- ============================================================================
-- 0070_watch_call_audio.sql
--   Ikli's voice didn't play when a call was answered: the storage rule that
--   lets the person called download it (0068) looks the call up in
--   watch_call, which nobody could read (row level security, no policy), so
--   the download was refused and only the words showed. Each person can now
--   read their own calls.
-- ============================================================================

drop policy if exists watch_call_mine on public.watch_call;
create policy watch_call_mine on public.watch_call for select to authenticated using (user_id = auth.uid());
grant select on public.watch_call to authenticated;
