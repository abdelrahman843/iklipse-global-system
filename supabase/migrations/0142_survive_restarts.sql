-- 0142: nothing silently lost, and every connection watched.
--   - brain_run keeps what was sent to the brain (payload), so a run a restart
--     cut off can be sent again (brain.ts resumeRuns), a few times at most.
--   - connection_state: each connection as it is now; connection_event: what
--     happened to it, kept (whatsapp-bot connections.ts).
--   - calendly_account.last_error: the last time it was read, if that failed.

alter table public.brain_run
  add column if not exists payload jsonb,
  add column if not exists resumes int not null default 0;

alter table public.calendly_account add column if not exists last_error text;

create table if not exists public.connection_state (
  service    text primary key,
  label      text not null,
  ok         boolean not null,
  since      timestamptz not null default now(),   -- in this state since
  checked_at timestamptz not null default now(),
  seen_at    timestamptz,                          -- the last sign of it (the master's poll)
  error      text,
  fails      int not null default 0,
  fixes      int not null default 0,
  alerted_at timestamptz,
  ever_ok    boolean not null default false
);

create table if not exists public.connection_event (
  id       bigserial primary key,
  service  text not null,
  ok       boolean not null,
  error    text,
  fixed_by text,
  at       timestamptz not null default now()
);
create index if not exists connection_event_at_idx on public.connection_event (at desc);

alter table public.connection_state enable row level security;
alter table public.connection_event enable row level security;
revoke all on public.connection_state from anon, authenticated;
revoke all on public.connection_event from anon, authenticated;

notify pgrst, 'reload schema';
