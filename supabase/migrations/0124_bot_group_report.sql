-- 0124: a WhatsApp group reported on, privately, every so often
-- (whatsapp-bot report.ts): "report to Nabil on Side quest every 2 days, and
-- tell him when the team hasn't sent them an update". An admin asks the brain
-- (group_report); the minute's run sends the ones due, in working hours: what
-- happened in the group since the last report, and whether anyone on the team
-- wrote there (none: said first, so they can chase it). One per group and
-- person: asking again changes how often. Each send is claimed by moving
-- next_at on first, so two runs at once never send one twice.

create table if not exists public.bot_group_report (
  id           uuid primary key default gen_random_uuid(),
  chat_id      text not null references public.wa_group(chat_id) on delete cascade,
  for_user     uuid not null references public.profile(id) on delete cascade,
  set_by       uuid references public.profile(id) on delete set null,
  every_hours  int not null default 48 check (every_hours between 1 and 720),
  next_at      timestamptz not null,
  last_at      timestamptz,                -- the last report: the next one covers from here
  active       boolean not null default true,
  sent_count   int not null default 0,
  error        text,
  created_at   timestamptz not null default now()
);
create unique index if not exists bot_group_report_once_idx on public.bot_group_report (chat_id, for_user);
create index if not exists bot_group_report_due_idx on public.bot_group_report (next_at) where active;
alter table public.bot_group_report enable row level security;
-- Read and written by the whatsapp-bot function (service role) only.
revoke all on public.bot_group_report from anon, authenticated;

notify pgrst, 'reload schema';
