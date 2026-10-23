-- 0110: "remind me at ..." (whatsapp-bot reminders.ts). Anyone on the team
-- asks the bot, in a group or privately, to remind them (or someone on the
-- team) at a time or after a while. The reminder goes privately at that time:
-- yours even outside working hours, someone else's in working hours unless the
-- asker said any time (any_time). The minute's run sends what's due; each is
-- claimed by one run only (_bot_reminders_due), so two runs at once never send
-- one twice. One per message per person (source_id): WhatsApp sending the
-- same message twice keeps one.

create table if not exists public.bot_reminder (
  id              uuid primary key default gen_random_uuid(),
  for_user        uuid not null references public.profile(id) on delete cascade,
  set_by          uuid references public.profile(id) on delete set null,
  chat_id         text,                   -- where it was asked
  source_id       text not null,          -- the message it was asked in
  text            text not null default '',
  due_at          timestamptz not null,
  tz              text not null default 'Africa/Cairo',   -- the asker's, for how its time is said
  any_time        boolean not null default false,          -- may go outside working hours
  status          text not null default 'open' check (status in ('open', 'sending', 'sent', 'cancelled', 'failed')),
  claimed_at      timestamptz,
  sent_at         timestamptz,
  sent_message_id text,
  cancelled_at    timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);
create unique index if not exists bot_reminder_once_idx on public.bot_reminder (source_id, for_user);
create index if not exists bot_reminder_due_idx on public.bot_reminder (due_at) where status = 'open';
create index if not exists bot_reminder_for_idx on public.bot_reminder (for_user) where status = 'open';
create index if not exists bot_reminder_by_idx on public.bot_reminder (set_by) where status = 'open';
alter table public.bot_reminder enable row level security;
-- Read and written by the whatsapp-bot function (service role) only.
revoke all on public.bot_reminder from anon, authenticated;

-- The reminders due now, claimed for this run: no other run gets them.
create or replace function public._bot_reminders_due(p_limit int default 10)
returns setof public.bot_reminder language plpgsql security definer set search_path = public as $$
begin
  -- A run that died while sending lets go after 10 minutes: sent again, better twice than never.
  update public.bot_reminder set status = 'open', claimed_at = null
   where status = 'sending' and claimed_at < now() - interval '10 minutes';
  return query
    update public.bot_reminder r set status = 'sending', claimed_at = now()
     where r.id in (select x.id from public.bot_reminder x
                     where x.status = 'open' and x.due_at <= now()
                     order by x.due_at
                     for update skip locked
                     limit greatest(1, least(coalesce(p_limit, 10), 50)))
    returning r.*;
end $$;
revoke all on function public._bot_reminders_due(int) from public, anon, authenticated;

notify pgrst, 'reload schema';
