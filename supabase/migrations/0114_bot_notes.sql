-- 0114: what the team taught the bot in chat (whatsapp-bot notes.ts). An
-- admin on the team tells the bot a fact or a standing instruction in any
-- chat with it ("remember: ...", "from now on ...", "Sara isn't a client");
-- it's kept here, a short line each, and goes into every call to Claude, the
-- newest first (a newer one wins when two disagree; the newest 40 are used).
-- Admins ask the bot what it was taught and tell it to forget one: a
-- forgotten note is kept, with who forgot it and when, or the newer note that
-- took its place.

create table if not exists public.bot_note (
  id           uuid primary key default gen_random_uuid(),
  text         text not null check (length(btrim(text)) between 1 and 500),
  by_user      uuid references public.profile(id) on delete set null,
  by_name      text,
  chat_id      text,                  -- where it was taught
  source_id    text,                  -- the message it was taught in
  created_at   timestamptz not null default now(),
  forgotten_at timestamptz,
  forgotten_by uuid references public.profile(id) on delete set null,
  replaced_by  uuid references public.bot_note(id) on delete set null
);
create index if not exists bot_note_live_idx on public.bot_note (created_at desc) where forgotten_at is null;
alter table public.bot_note enable row level security;
-- Read and written by the whatsapp-bot function (service role) only.
revoke all on public.bot_note from anon, authenticated;

notify pgrst, 'reload schema';
