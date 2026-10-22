-- The bot's own messages on WAHA (0097). Its posts in groups came back with
-- the bot itself as the chat, so they were kept as a private chat with itself;
-- its private messages never came back at all. The bot now keeps what it sends
-- when it sends it (whatsapp-bot sendAs); what was lost is put right here.

-- Its group posts: back in their groups.
insert into public.wa_message (id, chat_id, from_bot, text, quoted_id, sent_at)
select d.id, split_part(w.full_id, '_', 2), true, d.text, d.quoted_id, d.sent_at
from public.wa_dm d
join public.waha_msg w on w.id = d.id
where w.full_id like 'true\_%@g.us\_%'
  and exists (select 1 from public.wa_group g where g.chat_id = split_part(w.full_id, '_', 2))
on conflict (id) do nothing;

delete from public.wa_dm d
using public.waha_msg w
where w.id = d.id and w.full_id like 'true\_%@g.us\_%';

-- The private chat with itself, now empty.
delete from public.wa_dm_chat c
where c.phone = (select bot_phone from public.watch_settings where id = 1)
  and not exists (select 1 from public.wa_dm d where d.chat_id = c.chat_id);

-- Its private messages that a meeting conversation kept the words of: back in their chats.
insert into public.wa_dm (id, chat_id, from_bot, text, sent_at)
select t.id, t.chat_id, true, t.text, t.created_at
from public.wa_bot_turn t
join public.waha_msg w on w.id = t.id
where w.full_id like 'true\_%@c.us\_%'
  and t.from_bot
  and exists (select 1 from public.wa_dm_chat c where c.chat_id = t.chat_id)
on conflict (id) do nothing;
