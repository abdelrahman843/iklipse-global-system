-- ============================================================================
-- 0091_mail_backfill.sql
--   Emails with clients from the last 3 months are kept for the bot too, not
--   only the ones from 0090 on: each watched mailbox (and any turned on later)
--   is read back 90 days, a few pages a minute, keeping the ones with a client
--   on them (mail_message). Only the bot reads them.
-- ============================================================================

alter table public.mail_watch
  add column if not exists backfill_from    timestamptz default (now() - interval '90 days'),   -- read back to here
  add column if not exists backfill_page    text,                                               -- Gmail's next page
  add column if not exists backfill_done_at timestamptz,
  add column if not exists backfill_count   int not null default 0;                             -- emails kept so far

update public.mail_watch
   set backfill_from = now() - interval '90 days', backfill_page = null
 where backfill_done_at is null;
