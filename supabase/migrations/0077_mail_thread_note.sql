-- 0077_mail_thread_note.sql
--   Email watch (0076): each conversation keeps a short note on what was made
--   of it last time ("Only the team wrote in it", "Read by Claude: client"),
--   so a test email that rang nothing says why.

alter table public.mail_thread add column if not exists note text;

notify pgrst, 'reload schema';
