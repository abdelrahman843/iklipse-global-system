-- 0094: live updates everywhere, without polling.
--
-- Pages used to ask the server again every 20 to 60 seconds. Now a write to any
-- of the tables below sends one small broadcast on the private channel "live"
-- (only the table's name, no data). The app refetches what's on screen that
-- reads that table (src/lib/live.ts); RLS still decides what each person gets.
--
-- One message per statement, and only when a row really changed, so a tick
-- that updates nothing sends nothing and a bulk write sends one message.
-- A broadcast that fails never blocks the write.

create or replace function public._live_ping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from old_rows) then return null; end if;
  elsif not exists (select 1 from new_rows) then
    return null;
  end if;
  perform realtime.send(jsonb_build_object('t', tg_table_name), 'change', 'live', true);
  return null;
exception when others then
  return null;
end $$;

revoke all on function public._live_ping() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    -- alerts, the bot's groups, Slack
    'watch_alert', 'watch_recipient', 'watch_event', 'watch_call',
    'wa_group', 'wa_participant', 'wa_member', 'wa_member_lid', 'bot_order',
    'slack_channel', 'slack_participant', 'slack_member', 'slack_user',
    -- people and clients
    'client', 'profile_contact',
    -- attendance
    'work_session', 'work_break',
    -- projects and deliveries
    'project', 'project_member', 'project_note', 'project_file', 'project_invoice', 'project_delivery',
    'delivery_folder', 'delivery_round', 'delivery_item', 'delivery_comment', 'delivery_link',
    -- invoices
    'invoice', 'invoice_target', 'invoice_folder', 'invoice_settings',
    -- shared with me, meetings, connected accounts
    'gmail_share', 'gmail_share_thread', 'drive_share', 'drive_share_item',
    'fireflies_share', 'fireflies_meeting', 'fireflies_link', 'fireflies_account',
    'gmail_account', 'drive_account', 'calendly_account',
    -- activity log
    'audit_log'
  ] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists live_ins on public.%I', t);
    execute format('drop trigger if exists live_upd on public.%I', t);
    execute format('drop trigger if exists live_del on public.%I', t);
    execute format('create trigger live_ins after insert on public.%I referencing new table as new_rows for each statement execute function public._live_ping()', t);
    execute format('create trigger live_upd after update on public.%I referencing new table as new_rows for each statement execute function public._live_ping()', t);
    execute format('create trigger live_del after delete on public.%I referencing old table as old_rows for each statement execute function public._live_ping()', t);
  end loop;
end $$;

-- Anyone signed in may listen on "live" (it only carries table names).
drop policy if exists live_read on realtime.messages;
create policy live_read on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and realtime.topic() = 'live');
