-- ============================================================================
-- 0092_mail_backfill_by_client.sql
--   Reading back (0091) by client instead of every email: each mailbox is
--   searched for the clients' addresses (and their companies' domains), the
--   last 90 days, a few at a time, so Gmail's limits aren't hit. A client
--   added later gets their last 90 days read the same way.
-- ============================================================================

alter table public.mail_watch
  add column if not exists backfill_keys  text[] not null default '{}',   -- addresses and "@domains" already read back
  add column if not exists backfill_chunk text[] not null default '{}';   -- the ones being read now (backfill_page is theirs)

update public.mail_watch set backfill_page = null, backfill_chunk = '{}', backfill_done_at = null;
