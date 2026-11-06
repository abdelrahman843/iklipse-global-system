-- 0146_group_instructions.sql
-- One group's own standing instructions: said with every message there, to the
-- bot and for that group only. A taught note couldn't be held to one group.

alter table public.wa_group add column if not exists instructions text;
