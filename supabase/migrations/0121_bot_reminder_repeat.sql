-- 0121: reminders that repeat (whatsapp-bot reminders.ts): "remind me every
-- minute to drink water", "every day at 10 to check the ads, until Friday",
-- "every 2 hours, 5 times". every_minutes: how often (null: once, as before).
-- It stops when they cancel it, at until_at (none sent after it), or once
-- times_left is 0 (null: no count). sent_count: how many went so far. After
-- each send the same row is open again with its next due_at: cancelling it
-- (the reminder's number) stops it for good.

alter table public.bot_reminder add column if not exists every_minutes int check (every_minutes is null or every_minutes >= 1);
alter table public.bot_reminder add column if not exists until_at timestamptz;
alter table public.bot_reminder add column if not exists times_left int check (times_left is null or times_left >= 0);
alter table public.bot_reminder add column if not exists sent_count int not null default 0;

notify pgrst, 'reload schema';
