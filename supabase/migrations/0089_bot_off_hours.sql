-- ============================================================================
-- 0089_bot_off_hours.sql
--   Outside working hours and on days off (Alerts > Settings, Working hours:
--   kept as the quiet hours, the time outside work), a client who writes
--   is told at once we'll get back to them as soon as the team is online: in
--   a group where the bot replies, or privately when it answers private
--   messages. Nothing rings, and nothing is asked of the team, until work
--   starts; then the alerts ring and the private replies go for an OK.
-- ============================================================================

alter table public.wa_dm_chat
  add column if not exists away_at timestamptz;   -- last told "we'll get back to you" outside working hours
