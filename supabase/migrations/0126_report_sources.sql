-- 0126: a report can be about a group, one person's messages, or emails from
-- someone (whatsapp-bot report.ts), for a number of times or until stopped.
--   source: 'group' (a whole group), 'person' (what one person wrote, in one
--     group or in all of them), 'mail' (emails from one sender, in the mailboxes
--     of whoever set it).
--   match: the person's name or number, or the sender's address or name.
--   times: stop after this many reports (null: until stopped); done_count counts them.
-- One per recipient, source, group and match: asking again changes it.

alter table public.bot_group_report
  add column if not exists source text not null default 'group' check (source in ('group', 'person', 'mail')),
  add column if not exists match text,
  add column if not exists times int check (times is null or times between 1 and 365);
alter table public.bot_group_report alter column chat_id drop not null;

drop index if exists public.bot_group_report_once_idx;
create unique index if not exists bot_group_report_once_idx2
  on public.bot_group_report (for_user, source, coalesce(chat_id, ''), coalesce(lower(match), ''));

notify pgrst, 'reload schema';
