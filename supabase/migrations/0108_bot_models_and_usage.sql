-- 0108: a Claude model per job, and what each call to Claude took.
--   model_fast:  quick decisions: what to do with a message (orders, meetings,
--                the team's OK), reading group chats, Slack and email for
--                alerts, reading files. Haiku by default.
--   model_main:  words people read: replies to clients, answers to the team,
--                call words. Starts as the one model picked before.
--   model_agent: the agent runtime (BOT_AGENT): Sonnet or Opus. Starts as the
--                one model picked before (Sonnet when that was Haiku).
--   The old model column stays: the bot uses it until this migration runs.
--   bot_ai_call: one row per call to Claude (the job, the model, tokens with
--   the cache's, time, tries, failed or not), never the words. Kept 90 days.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'watch_settings' and column_name = 'model_main') then
    alter table public.watch_settings
      add column model_fast text not null default 'claude-haiku-5-5'
        check (model_fast in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5')),
      add column model_main text not null default 'claude-sonnet-5-5'
        check (model_main in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5')),
      add column model_agent text not null default 'claude-sonnet-5-5'
        check (model_agent in ('claude-sonnet-5-5', 'claude-opus-5-5'));
    -- What was picked for everything stays for the words people read.
    update public.watch_settings
       set model_main = model,
           model_agent = case when model = 'claude-opus-5-5' then model else 'claude-sonnet-5-5' end
     where id = 1;
  end if;
end $$;

-- ------------------------------------------------------------ the usage log --
create table if not exists public.bot_ai_call (
  id                 bigserial primary key,
  at                 timestamptz not null default now(),
  job                text not null,          -- "orders.act", "chat.read", "agent.turn"...
  role               text not null check (role in ('fast', 'main', 'agent')),
  model              text not null,
  input_tokens       int not null default 0,
  output_tokens      int not null default 0,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  ms                 int not null default 0,
  tries              int not null default 1,
  ok                 boolean not null,
  error              text,                   -- Anthropic's message or a timeout, never the chat's words
  note               text                    -- the tool not called, a refusal, cut at max_tokens
);
create index if not exists bot_ai_call_at_idx on public.bot_ai_call (at desc);
create index if not exists bot_ai_call_job_idx on public.bot_ai_call (job, at desc);
alter table public.bot_ai_call enable row level security;
-- Written by the whatsapp-bot function (service role) only.
revoke all on public.bot_ai_call from anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'bot-ai-call-cleanup') then
    perform cron.unschedule('bot-ai-call-cleanup');
  end if;
  perform cron.schedule('bot-ai-call-cleanup', '23 3 * * *', $c$delete from public.bot_ai_call where at < now() - interval '90 days'$c$);
end $$;

-- --------------------------------------------------------------- settings --
-- As 0106, plus the three models.
create or replace function public.watch_settings_set(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v_senders text[]; v_days int[]; v_dates date[]; v_phone text; v_group text; v_link uuid; v_alerts text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'model', 'reply_wait_min', 'promise_wait_min', 'repeat_every_min', 'alerts_before_call',
                 'calls_enabled', 'call_retry_min', 'call_every_min', 'max_calls', 'stop_after_hours',
                 'quiet_from', 'quiet_to', 'call_language', 'cc_admins',
                 'mail_enabled', 'mail_reply_wait_min', 'mail_clients', 'mail_ads', 'mail_senders',
                 'slack_enabled', 'book_enabled',
                 'follow_enabled', 'follow_wait_min', 'follow_every_min', 'follow_alerts', 'off_days', 'off_dates',
                 'deadline_enabled', 'deadline_before_hours', 'deadline_every_min',
                 'ask_enabled', 'ask_to', 'ask_phone', 'ask_group', 'ask_every_min', 'dm_enabled', 'book_link_account', 'meet_tell',
                 'orders_enabled', 'order_every_min', 'order_client_max', 'alert_group', 'read_files',
                 'model_fast', 'model_main', 'model_agent') then
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if (p ? 'model_fast' and p->>'model_fast' not in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'))
     or (p ? 'model_main' and p->>'model_main' not in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5')) then
    raise exception 'Pick Haiku, Sonnet or Opus';
  end if;
  if p ? 'model_agent' and p->>'model_agent' not in ('claude-sonnet-5-5', 'claude-opus-5-5') then
    raise exception 'Tasks run on Sonnet or Opus';
  end if;
  if p ? 'mail_senders' then
    if jsonb_typeof(p->'mail_senders') <> 'array' then raise exception 'The senders are a list'; end if;
    v_senders := public._gmail_senders(array(select jsonb_array_elements_text(p->'mail_senders')));
    if cardinality(v_senders) > 100 then raise exception 'Up to 100 senders'; end if;
  end if;
  if p ? 'off_days' then
    if jsonb_typeof(p->'off_days') <> 'array' then raise exception 'The days off are a list'; end if;
    v_days := array(select distinct x::int from jsonb_array_elements_text(p->'off_days') x order by 1);
  end if;
  if p ? 'off_dates' then
    if jsonb_typeof(p->'off_dates') <> 'array' then raise exception 'The dates off are a list'; end if;
    v_dates := array(select distinct x::date from jsonb_array_elements_text(p->'off_dates') x
                      where x::date >= (now() at time zone 'Africa/Cairo')::date order by 1);
  end if;
  if p ? 'ask_phone' then
    v_phone := public._phone_key(p->>'ask_phone');
    if v_phone is not null and v_phone !~ '^[1-9][0-9]{7,14}$' then raise exception 'That is not a WhatsApp number'; end if;
  end if;
  if p ? 'ask_group' then
    v_group := nullif(p->>'ask_group', '');
    if v_group is not null and not exists (select 1 from public.wa_group where chat_id = v_group and kind = 'team') then
      raise exception 'Pick one of the team groups';
    end if;
  end if;
  if p ? 'alert_group' then
    v_alerts := nullif(p->>'alert_group', '');
    if v_alerts is not null and not exists (select 1 from public.wa_group where chat_id = v_alerts and kind = 'team') then
      raise exception 'Pick one of the team groups for the alerts';
    end if;
  end if;
  if p ? 'book_link_account' then
    v_link := nullif(p->>'book_link_account', '')::uuid;
    if v_link is not null and not exists (select 1 from public.calendly_account where id = v_link) then
      raise exception 'That Calendly account isn''t connected';
    end if;
  end if;
  update public.watch_settings set
    enabled               = coalesce((p->>'enabled')::boolean, enabled),
    model                 = coalesce(p->>'model', model),
    model_fast            = coalesce(p->>'model_fast', model_fast),
    model_main            = coalesce(p->>'model_main', model_main),
    model_agent           = coalesce(p->>'model_agent', model_agent),
    reply_wait_min        = coalesce((p->>'reply_wait_min')::int, reply_wait_min),
    promise_wait_min      = coalesce((p->>'promise_wait_min')::int, promise_wait_min),
    repeat_every_min      = coalesce((p->>'repeat_every_min')::int, repeat_every_min),
    alerts_before_call    = coalesce((p->>'alerts_before_call')::int, alerts_before_call),
    calls_enabled         = coalesce((p->>'calls_enabled')::boolean, calls_enabled),
    call_retry_min        = coalesce((p->>'call_retry_min')::int, call_retry_min),
    call_every_min        = coalesce((p->>'call_every_min')::int, call_every_min),
    max_calls             = coalesce((p->>'max_calls')::int, max_calls),
    stop_after_hours      = coalesce((p->>'stop_after_hours')::int, stop_after_hours),
    quiet_from            = case when p ? 'quiet_from' then nullif(p->>'quiet_from', '')::time else quiet_from end,
    quiet_to              = case when p ? 'quiet_to' then nullif(p->>'quiet_to', '')::time else quiet_to end,
    call_language         = coalesce(p->>'call_language', call_language),
    cc_admins             = coalesce((p->>'cc_admins')::boolean, cc_admins),
    mail_enabled          = coalesce((p->>'mail_enabled')::boolean, mail_enabled),
    mail_reply_wait_min   = coalesce((p->>'mail_reply_wait_min')::int, mail_reply_wait_min),
    mail_clients          = coalesce((p->>'mail_clients')::boolean, mail_clients),
    mail_ads              = coalesce((p->>'mail_ads')::boolean, mail_ads),
    mail_senders          = case when p ? 'mail_senders' then v_senders else mail_senders end,
    slack_enabled         = coalesce((p->>'slack_enabled')::boolean, slack_enabled),
    book_enabled          = coalesce((p->>'book_enabled')::boolean, book_enabled),
    follow_enabled        = coalesce((p->>'follow_enabled')::boolean, follow_enabled),
    follow_wait_min       = coalesce((p->>'follow_wait_min')::int, follow_wait_min),
    follow_every_min      = coalesce((p->>'follow_every_min')::int, follow_every_min),
    follow_alerts         = coalesce((p->>'follow_alerts')::int, follow_alerts),
    off_days              = case when p ? 'off_days' then v_days else off_days end,
    off_dates             = case when p ? 'off_dates' then v_dates else off_dates end,
    deadline_enabled      = coalesce((p->>'deadline_enabled')::boolean, deadline_enabled),
    deadline_before_hours = coalesce((p->>'deadline_before_hours')::int, deadline_before_hours),
    deadline_every_min    = coalesce((p->>'deadline_every_min')::int, deadline_every_min),
    ask_enabled           = coalesce((p->>'ask_enabled')::boolean, ask_enabled),
    ask_to                = coalesce(p->>'ask_to', ask_to),
    ask_phone             = case when p ? 'ask_phone' then v_phone else ask_phone end,
    ask_group             = case when p ? 'ask_group' then v_group else ask_group end,
    ask_every_min         = coalesce((p->>'ask_every_min')::int, ask_every_min),
    dm_enabled            = coalesce((p->>'dm_enabled')::boolean, dm_enabled),
    book_link_account     = case when p ? 'book_link_account' then v_link else book_link_account end,
    meet_tell             = coalesce((p->>'meet_tell')::boolean, meet_tell),
    orders_enabled        = coalesce((p->>'orders_enabled')::boolean, orders_enabled),
    order_every_min       = coalesce((p->>'order_every_min')::int, order_every_min),
    order_client_max      = coalesce((p->>'order_client_max')::int, order_client_max),
    alert_group           = case when p ? 'alert_group' then v_alerts else alert_group end,
    read_files            = coalesce((p->>'read_files')::boolean, read_files),
    updated_at = now(), updated_by = auth.uid()
  where id = 1;
  -- Asking needs somewhere to ask.
  if exists (select 1 from public.watch_settings where id = 1 and (ask_enabled or dm_enabled)
               and ((ask_to = 'person' and ask_phone is null) or (ask_to = 'group' and ask_group is null))) then
    raise exception 'Say who the bot asks: a WhatsApp number, or a team group';
  end if;
end $$;

notify pgrst, 'reload schema';
