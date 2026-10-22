-- 0098: what admins control of the bot's WhatsApp, in Connected accounts >
-- WhatsApp (saved by the whatsapp-bot function, action waha_settings).
--
-- How fast it answers: a private chat is read once the person has been quiet
-- this long (or has kept writing this long), a client group the same for its
-- alerts. Under a minute, the private chat is read right after the wait instead
-- of on the next minute's run; claimed_at keeps the two from both answering.
-- On the bridge (WAHA) only: the chat marked read and "typing…" shown for a
-- while that grows with the reply's length before a private reply, and the
-- number shown online or not.

alter table public.watch_settings
  add column if not exists reply_quiet_sec    int     not null default 60  check (reply_quiet_sec between 5 and 600),
  add column if not exists reply_max_sec      int     not null default 300 check (reply_max_sec between 30 and 3600),
  add column if not exists group_quiet_sec    int     not null default 60  check (group_quiet_sec between 15 and 1800),
  add column if not exists group_max_sec      int     not null default 300 check (group_max_sec between 60 and 7200),
  add column if not exists wa_seen            boolean not null default true,
  add column if not exists wa_typing          boolean not null default true,
  add column if not exists typing_cps         int     not null default 15  check (typing_cps between 3 and 100),
  add column if not exists typing_min_sec     int     not null default 2   check (typing_min_sec between 0 and 30),
  add column if not exists typing_max_sec     int     not null default 8   check (typing_max_sec between 0 and 30),
  add column if not exists wa_online          boolean not null default false;

alter table public.wa_dm_chat add column if not exists claimed_at timestamptz;
