-- The bot talks with clients privately by itself (dm.ts): it only comes back
-- to the team when it's stuck, can't do what they ask, or it's risky. What it
-- asks the team is kept with the draft; the team's answer can be an order
-- ("book it", "send him the link"), carried out instead of a reply.
alter table public.bot_draft add column if not exists question text;
alter table public.bot_draft drop constraint if exists bot_draft_status_check;
alter table public.bot_draft add constraint bot_draft_status_check
  check (status in ('waiting', 'sent', 'dropped', 'replaced', 'expired', 'ordered'));

-- A meeting cancelled on Calendly: the people who were told about it hear it's
-- off (once). The ones already gone are left as they are.
alter table public.wa_bot_meeting add column if not exists cancel_told_at timestamptz;
update public.wa_bot_meeting set cancel_told_at = now() where status = 'deleted' and cancel_told_at is null;
