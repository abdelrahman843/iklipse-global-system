-- 0097: the bot's own WhatsApp bridge (WAHA, on the claude-vps server), next to
-- Green API. An admin links a number by its QR code in Connected accounts >
-- WhatsApp, then chooses which one the bot uses (wa_provider). The bridge's
-- address and key are the whatsapp-bot function's secrets (WAHA_URL,
-- WAHA_API_KEY), never in the app.
--
-- WAHA writes a message's id whole (false_2010...@c.us_3EB0...); the bot keeps
-- the short one, as Green API sends it, and waha_msg holds the whole one so the
-- bot can still reply to that message.

alter table public.watch_settings
  add column if not exists wa_provider text not null default 'green' check (wa_provider in ('green', 'waha')),
  add column if not exists waha_state  text,
  add column if not exists waha_phone  text,
  add column if not exists waha_at     timestamptz;

create table if not exists public.waha_msg (
  id      text primary key,
  full_id text not null,
  at      timestamptz not null default now()
);
create index if not exists waha_msg_at on public.waha_msg (at);
alter table public.waha_msg enable row level security;
revoke all on public.waha_msg from public, anon, authenticated;
