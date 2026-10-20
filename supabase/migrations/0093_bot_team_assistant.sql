-- ============================================================================
-- 0093_bot_team_assistant.sql
--   The bot as the whole team's assistant: anyone on the team mentions it in
--   any group (not only admins), or writes to it privately, to give an order,
--   ask for details or ask anything. An order given in a client group or
--   privately is answered in the private chat of the one who gave it, so
--   there may be no message there to reply to. A booking link sent to someone
--   privately is followed up like an order until they book a time on it.
-- ============================================================================

alter table public.bot_order
  alter column message_id drop not null;                                   -- the order, when it can be replied to

alter table public.bot_order
  add column if not exists book_url text;                                  -- a booking link they're to book a time on

comment on column public.bot_order.chat_id is 'Where it''s answered: the team group it was given in, or the private chat of the one who gave it';

create index if not exists bot_order_book_idx on public.bot_order (created_at) where status = 'open' and book_url is not null;
