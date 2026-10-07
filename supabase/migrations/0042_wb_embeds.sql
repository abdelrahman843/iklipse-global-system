-- 0042_wb_embeds.sql
--   Embeds on Miro boards: a pasted link to a video or post (YouTube,
--   Instagram, TikTok...) plays on the board; other links become link cards.
--   The item keeps only the link (data.url); the player is picked client side.

alter table public.wb_item drop constraint if exists wb_item_type_check;
alter table public.wb_item add constraint wb_item_type_check
  check (type in ('sticky', 'shape', 'text', 'frame', 'image', 'connector', 'pen', 'card', 'emoji', 'doc', 'embed'));
