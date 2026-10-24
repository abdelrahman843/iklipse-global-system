-- 0118: a reminder whose send fails is tried again (whatsapp-bot reminders.ts):
-- after 1, 5 and 15 minutes; then it's failed, and whoever set it for someone
-- else is told it didn't go. tries: the sends that failed so far; retry_at:
-- not sent again before then. Before this runs a failed send is failed at once,
-- as before.

alter table public.bot_reminder add column if not exists tries int not null default 0;
alter table public.bot_reminder add column if not exists retry_at timestamptz;

-- The reminders due now (and past their next try), claimed for this run: no other run gets them.
create or replace function public._bot_reminders_due(p_limit int default 10)
returns setof public.bot_reminder language sql security definer set search_path = public as $$
  -- A run that died while sending lets go after 10 minutes: sent again, better twice than never.
  update public.bot_reminder set status = 'open', claimed_at = null
   where status = 'sending' and claimed_at < now() - interval '10 minutes';
  update public.bot_reminder r set status = 'sending', claimed_at = now()
   where r.id in (select x.id from public.bot_reminder x
                   where x.status = 'open' and x.due_at <= now()
                     and (x.retry_at is null or x.retry_at <= now())
                   order by x.due_at
                   limit greatest(1, least(coalesce(p_limit, 10), 50))
                   for update skip locked)
  returning r.*;
$$;
revoke all on function public._bot_reminders_due(int) from public, anon, authenticated;

notify pgrst, 'reload schema';
