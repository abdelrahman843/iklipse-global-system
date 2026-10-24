-- 0116: an admin pauses one open alert, and has the bot remind people about
-- it every so often until it's resolved (whatsapp-bot pause.ts): "pause this
-- alert till tomorrow at 2 pm, then send @Sara and Omar a message every 20
-- minutes till it's resolved", "resume", "stop reminding them", "every 30
-- minutes instead".
--
-- The pause needs nothing new: it's the alert's own snooze
-- (watch_alert.snoozed_until, the same as Snooze in the app). Until then
-- nothing rings for it, nobody is called about it, and the open alerts list in
-- the team group leaves it out.
--
-- The reminders are kept here, one row per alert: who gets them (team
-- members), how often (at least 10 minutes apart) and when the next round
-- goes. They take the place of the alert's usual alerts and calls: one
-- private WhatsApp message to each of them per round, in working hours only,
-- at most 30 a day, until the alert is closed (said where they were asked
-- for) or an admin stops them (then its usual alerts and calls come back).
-- Each round is claimed by one run only (its next_at, read and written back).

create table if not exists public.bot_alert_nudge (
  alert_id   uuid primary key references public.watch_alert(id) on delete cascade,
  people     uuid[] not null default '{}',   -- the team members reminded (profile ids)
  every_min  int not null check (every_min between 10 and 1440),
  next_at    timestamptz,                     -- the next round: the end of the pause, or every_min after the last
  status     text not null default 'on' check (status in ('on', 'stopped', 'done')),
  rounds     int not null default 0,          -- rounds sent, all told
  day        text,                            -- the Cairo day rounds_day counts ("2026-10-24")
  rounds_day int not null default 0,
  last_at    timestamptz,
  set_by     uuid references public.profile(id) on delete set null,
  chat_id    text,                            -- where they were asked for
  message_id text,                            -- the message they were asked for in
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at   timestamptz
);
create index if not exists bot_alert_nudge_due_idx on public.bot_alert_nudge (next_at) where status = 'on';
alter table public.bot_alert_nudge enable row level security;
-- Read and written by the whatsapp-bot function (service role) only.
revoke all on public.bot_alert_nudge from anon, authenticated;

notify pgrst, 'reload schema';
