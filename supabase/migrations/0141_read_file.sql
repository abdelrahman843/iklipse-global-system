-- 0141: the brain's read_file (whatsapp-bot files.ts readFileAgain): open a file
--   someone sent, by its message. Admins by default, as reading the logs.

insert into public.bot_skill (key, name, about, area, grantable, sort)
values ('read_file', 'Open files', 'Open a photo, PDF, Word, Excel or text file someone sent.', 'read', true, 12)
on conflict (key) do nothing;
insert into public.bot_default (kind, skill, allowed) values ('admin', 'read_file', true), ('member', 'read_file', false), ('client', 'read_file', false)
on conflict do nothing;

notify pgrst, 'reload schema';
