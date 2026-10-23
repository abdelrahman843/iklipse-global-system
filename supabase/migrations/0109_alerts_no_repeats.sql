-- 0109: alerts don't repeat.
--   person_key: who an alert is about, by who they are, not how their name is
--     written: "c:<client>", "t:<team member>", else "w:<WhatsApp number>",
--     "l:<hidden-number id>", "s:<Slack id>" or "e:<email address>". The bot
--     fills it in (whatsapp-bot repeat.ts); older alerts have none.
--   mail_key: the Message-ID of the email an alert is about. The same email in
--     several team members' mailboxes has the same one, so it's one alert that
--     rings each of them, not one per mailbox.
--   client.phone_key: a client's number as WhatsApp writes it, to find them
--     by the sender's number without reading every client.
--   reading_at: a group or Slack channel is read by one run at a time.
--   One open "waiting for a reply" alert per chat and person, and per email:
--   unique indexes, so two runs at once can't open it twice.
--   Existing duplicates are left alone: scripts/bot/duplicate-alerts.sql lists
--   them, and scripts/bot/close-duplicate-alerts.sql closes them after an OK.

alter table public.watch_alert
  add column if not exists person_key text,
  add column if not exists mail_key text;

create index if not exists watch_alert_person_idx on public.watch_alert (person_key, kind) where status = 'open' and person_key is not null;
create index if not exists watch_alert_mail_key_idx on public.watch_alert (mail_key) where status = 'open' and mail_key is not null;

create unique index if not exists watch_alert_one_waiting
  on public.watch_alert (source, coalesce(chat_id, channel_id), person_key)
  where status = 'open' and kind = 'unanswered' and person_key is not null and source in ('whatsapp', 'slack');
create unique index if not exists watch_alert_one_waiting_email
  on public.watch_alert (mail_key)
  where status = 'open' and kind = 'unanswered' and mail_key is not null and source = 'email';

alter table public.client
  add column if not exists phone_key text generated always as (public._phone_key(phone)) stored;
create index if not exists client_phone_key_idx on public.client (phone_key) where phone_key is not null;

alter table public.wa_group add column if not exists reading_at timestamptz;
alter table public.slack_channel add column if not exists reading_at timestamptz;

notify pgrst, 'reload schema';
