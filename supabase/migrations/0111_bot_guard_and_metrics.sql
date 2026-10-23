-- 0111: the check before a client hears the bot, and the bot's numbers.
--   bot_guard_block: a message to a client that didn't go (whatsapp-bot
--     guard.ts): a phone number, an email or a price that isn't theirs or in
--     their chat, another client's name, or an internal word. The team got it
--     to OK or change instead. Admins read them (Alerts > Metrics).
--   bot_tally: counts the bot keeps that no other table has, per day (Cairo):
--     replies it sent alone, times it asked the team, alerts it didn't open
--     twice. Added to by _bot_tally.
--   bot_metrics(days): per day, for admins (Alerts > Metrics): messages,
--     replies alone vs asked the team, alerts opened, closed and duplicates
--     kept out, messages stopped, reminders sent, AI use by role and model
--     (the page prices it), and the median time to a client's reply.
--   Kept 90 days, like bot_ai_call.

create table if not exists public.bot_guard_block (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  where_from text not null,               -- "dm.reply", "orders.message", "orders.relay", "agent.message_client"
  chat_id    text,
  to_name    text,
  text       text not null,               -- what would have gone
  reasons    text[] not null default '{}'
);
create index if not exists bot_guard_block_at_idx on public.bot_guard_block (at desc);
alter table public.bot_guard_block enable row level security;
revoke all on public.bot_guard_block from anon;
drop policy if exists bot_guard_block_admins on public.bot_guard_block;
create policy bot_guard_block_admins on public.bot_guard_block for select to authenticated using (public.is_admin());
grant select on public.bot_guard_block to authenticated;

create table if not exists public.bot_tally (
  day  date not null,
  what text not null,                     -- "reply_alone", "asked_team", "alert_duplicate"
  n    int not null default 0,
  primary key (day, what)
);
alter table public.bot_tally enable row level security;
revoke all on public.bot_tally from anon, authenticated;

-- One more (or n more) of something today, on Cairo's clock.
create or replace function public._bot_tally(p_what text, p_n int default 1)
returns void language sql security definer set search_path = public as $$
  insert into public.bot_tally (day, what, n)
  values ((now() at time zone 'Africa/Cairo')::date, p_what, greatest(coalesce(p_n, 1), 0))
  on conflict (day, what) do update set n = public.bot_tally.n + excluded.n;
$$;
revoke all on function public._bot_tally(text, int) from public, anon, authenticated;

create or replace function public.bot_metrics(p_days int default 30)
returns table (
  day                  date,
  group_messages       int,
  private_in           int,
  replies_alone        int,
  asked_team           int,
  alerts_opened        int,
  alerts_closed        int,
  duplicates_kept_out  int,
  messages_stopped     int,
  reminders_sent       int,
  median_reply_sec     int,
  ai                   jsonb
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_days int := greatest(1, least(coalesce(p_days, 30), 90));
  v_from timestamptz := ((now() at time zone 'Africa/Cairo')::date - (v_days - 1)) at time zone 'Africa/Cairo';
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query
  with days as (
    select generate_series((now() at time zone 'Africa/Cairo')::date - (v_days - 1), (now() at time zone 'Africa/Cairo')::date, interval '1 day')::date as d
  ),
  groups_in as (
    select (m.sent_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n
      from public.wa_message m where m.sent_at >= v_from group by 1
  ),
  dm_in as (
    select (m.sent_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n
      from public.wa_dm m where m.sent_at >= v_from and not m.from_bot group by 1
  ),
  tallies as (
    select t.day as d,
           coalesce(sum(t.n) filter (where t.what = 'reply_alone'), 0)::int as alone,
           coalesce(sum(t.n) filter (where t.what = 'asked_team'), 0)::int as asked,
           coalesce(sum(t.n) filter (where t.what = 'alert_duplicate'), 0)::int as dups
      from public.bot_tally t where t.day >= (v_from at time zone 'Africa/Cairo')::date group by 1
  ),
  opened as (
    select (a.created_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n
      from public.watch_alert a where a.created_at >= v_from group by 1
  ),
  closed as (
    select (a.closed_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n
      from public.watch_alert a where a.closed_at >= v_from and a.status <> 'open' group by 1
  ),
  stopped as (
    select (b.at at time zone 'Africa/Cairo')::date as d, count(*)::int as n
      from public.bot_guard_block b where b.at >= v_from group by 1
  ),
  reminded as (
    select (r.sent_at at time zone 'Africa/Cairo')::date as d, count(*)::int as n
      from public.bot_reminder r where r.sent_at >= v_from and r.status = 'sent' group by 1
  ),
  -- A client's turn: their first message after the bot last spoke, to the bot's next message.
  client_chats as (
    select c.chat_id from public.wa_dm_chat c join public.client k on k.phone_key = c.phone
  ),
  turns as (
    select m.chat_id, m.sent_at, m.from_bot,
           lag(m.from_bot) over (partition by m.chat_id order by m.sent_at) as before_bot
      from public.wa_dm m
     where m.sent_at >= v_from - interval '1 day' and m.chat_id in (select chat_id from client_chats)
  ),
  waits as (
    select (t.sent_at at time zone 'Africa/Cairo')::date as d,
           extract(epoch from (select min(b.sent_at) from public.wa_dm b
                                where b.chat_id = t.chat_id and b.from_bot and b.sent_at > t.sent_at) - t.sent_at) as sec
      from turns t
     where not t.from_bot and coalesce(t.before_bot, true) and t.sent_at >= v_from
  ),
  reply_time as (
    select w.d, (percentile_cont(0.5) within group (order by w.sec))::int as sec
      from waits w where w.sec is not null group by 1
  ),
  ai_rows as (
    select (c.at at time zone 'Africa/Cairo')::date as d, c.role, c.model,
           count(*)::int as calls, sum(c.input_tokens)::bigint as input, sum(c.output_tokens)::bigint as output,
           sum(c.cache_read_tokens)::bigint as cache_read, sum(c.cache_write_tokens)::bigint as cache_write,
           count(*) filter (where not c.ok)::int as failed
      from public.bot_ai_call c where c.at >= v_from group by 1, 2, 3
  ),
  ai_day as (
    select r.d, jsonb_agg(jsonb_build_object('role', r.role, 'model', r.model, 'calls', r.calls, 'input', r.input, 'output', r.output,
                                             'cache_read', r.cache_read, 'cache_write', r.cache_write, 'failed', r.failed)) as j
      from ai_rows r group by 1
  )
  select days.d,
         coalesce(g.n, 0), coalesce(p.n, 0),
         coalesce(t.alone, 0), coalesce(t.asked, 0),
         coalesce(o.n, 0), coalesce(cl.n, 0), coalesce(t.dups, 0),
         coalesce(s.n, 0), coalesce(r.n, 0),
         rt.sec,
         coalesce(aid.j, '[]'::jsonb)
    from days
    left join groups_in g on g.d = days.d
    left join dm_in p on p.d = days.d
    left join tallies t on t.d = days.d
    left join opened o on o.d = days.d
    left join closed cl on cl.d = days.d
    left join stopped s on s.d = days.d
    left join reminded r on r.d = days.d
    left join reply_time rt on rt.d = days.d
    left join ai_day aid on aid.d = days.d
   order by days.d desc;
end;
$$;
revoke all on function public.bot_metrics(int) from public, anon;
grant execute on function public.bot_metrics(int) to authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'bot-guard-block-cleanup') then
    perform cron.unschedule('bot-guard-block-cleanup');
  end if;
  perform cron.schedule('bot-guard-block-cleanup', '29 3 * * *', $c$delete from public.bot_guard_block where at < now() - interval '90 days'; delete from public.bot_tally where day < current_date - 365$c$);
end $$;

notify pgrst, 'reload schema';
