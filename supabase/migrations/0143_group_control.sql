-- The bot running WhatsApp groups (groups.ts), changing what it posted, its own
-- profile; replies that wait for an OK; and ignoring numbers it doesn't know.

alter table public.watch_settings add column if not exists ignore_unknown boolean not null default false;

insert into public.bot_skill (key, name, about, area, grantable, sort) values
  ('manage_group', 'Manage WhatsApp groups',    'Make groups; add, remove and promote people; invite links; who may post.', 'do', true, 34),
  ('change_post',  'Edit or take back posts',   'Change or take back what the bot posted in a group.',                     'do', true, 35),
  ('bot_profile',  'The bot''s name and picture', 'Change the bot''s own WhatsApp name, About and picture.',               'do', true, 36),
  ('reply_alone',  'Answered without an OK',    'The bot answers them on its own. Taken away, its replies wait for an OK first.', 'do', true, 37),
  ('schedules',    'See scheduled tasks',       'Read their scheduled tasks.',                                            'read', true, 38)
on conflict (key) do nothing;

insert into public.bot_default (kind, skill, allowed)
select k.kind, s.key, s.key = 'reply_alone' or (s.key = 'schedules' and k.kind = 'admin')
  from (values ('manage_group'), ('change_post'), ('bot_profile'), ('reply_alone'), ('schedules')) s(key)
 cross join (values ('admin'), ('member'), ('client')) k(kind)
on conflict do nothing;
