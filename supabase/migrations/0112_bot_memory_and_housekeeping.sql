-- 0112: what the bot remembers about each client, and keeping the bot's run tidy.
--   bot_client_memory: short notes per client, from what was said in their
--     WhatsApp chats (whatsapp-bot memory.ts): facts, what they like, what's
--     still open. Each line says if it was said only in their private chat:
--     those lines are for admins and the client's own chat, like the private
--     chat itself (look.ts). Updated after their chats go quiet; never from
--     email (email stays with its mailbox).
--   _bot_memory_due(limit): the clients whose chats have something new and
--     have been quiet 30 minutes, claimed for this run.
--   bot_tick_part: the minute's run in parts (WhatsApp, email, Slack,
--     Calendly, reminders, ringing, memory), each with its own lock: a slow
--     part holds up only itself. _bot_tick_claim claims the free ones.
--   bot_heard and waha_msg (they only remember "this message was already
--     seen") are emptied of rows older than 30 days, every night. The messages
--     themselves are kept for good.

create table if not exists public.bot_client_memory (
  client_id  uuid primary key references public.client(id) on delete cascade,
  notes      jsonb not null default '{}'::jsonb,   -- { facts: [{text, private}], likes: [...], open: [...] }
  through_at timestamptz,                          -- the last message read into it
  updated_at timestamptz,
  claimed_at timestamptz
);
alter table public.bot_client_memory enable row level security;
-- Read and written by the whatsapp-bot function (service role) only.
revoke all on public.bot_client_memory from anon, authenticated;

-- Finding a client's group messages fast (their private chat has wa_dm_chat_idx).
create index if not exists wa_message_phone_sent_idx on public.wa_message (phone, sent_at desc) where phone is not null;

create or replace function public._bot_memory_due(p_limit int default 3)
returns table (client_id uuid) language sql security definer set search_path = public as $$
  with activity as (
    select k.id as client_id,
           greatest(
             (select max(m.sent_at) from public.wa_dm m where m.chat_id = k.phone_key || '@c.us'),
             (select max(w.sent_at) from public.wa_message w where w.phone = k.phone_key)
           ) as last_at
      from public.client k
     where k.phone_key is not null
  ),
  due as (
    select a.client_id
      from activity a
      left join public.bot_client_memory mm on mm.client_id = a.client_id
     where a.last_at is not null
       and a.last_at < now() - interval '30 minutes'
       and a.last_at > coalesce(mm.through_at, '-infinity'::timestamptz)
       and (mm.claimed_at is null or mm.claimed_at < now() - interval '5 minutes')
     order by a.last_at desc
     limit greatest(1, least(coalesce(p_limit, 3), 10))
  )
  insert into public.bot_client_memory as mm (client_id, claimed_at)
  select d.client_id, now() from due d
  on conflict (client_id) do update set claimed_at = now()
   where mm.claimed_at is null or mm.claimed_at < now() - interval '5 minutes'
  returning mm.client_id;
$$;
revoke all on function public._bot_memory_due(int) from public, anon, authenticated;

create table if not exists public.bot_tick_part (
  part       text primary key,
  locked_at  timestamptz,
  last_at    timestamptz,
  last_ms    int,
  last_error text
);
alter table public.bot_tick_part enable row level security;
revoke all on public.bot_tick_part from anon, authenticated;

-- The parts free to run now (not running, or their run died more than p_stale_sec ago), claimed.
create or replace function public._bot_tick_claim(p_parts text[], p_stale_sec int default 150)
returns setof text language sql security definer set search_path = public as $$
  insert into public.bot_tick_part as t (part, locked_at)
  select unnest(p_parts), now()
  on conflict (part) do update set locked_at = now()
   where t.locked_at is null or t.locked_at < now() - make_interval(secs => greatest(coalesce(p_stale_sec, 150), 30))
  returning t.part;
$$;
revoke all on function public._bot_tick_claim(text[], int) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'bot-seen-cleanup') then
    perform cron.unschedule('bot-seen-cleanup');
  end if;
  perform cron.schedule('bot-seen-cleanup', '41 3 * * *', $c$delete from public.bot_heard where at < now() - interval '30 days'; delete from public.waha_msg where at < now() - interval '30 days'$c$);
end $$;

notify pgrst, 'reload schema';
