-- 0119: iklipse brain, Claude (Agent SDK, on the claude-vps server) as the
-- team's assistant on WhatsApp (brain/ in the repo, whatsapp-bot brain.ts).
-- The whatsapp-bot function keeps every message; what someone on the team
-- says to the bot goes to the brain instead of the order router when their
-- tier reaches it:
-- - owner: the numbers listed here (an admin sets them), linked to their
--   account by an admin (wa_member, wa_member_lid);
-- - admin, member: the account an admin linked the sender's number to.
-- Never by the number someone typed on their own member card.
--
-- brain_settings: one row. phase 0 the owner only, 1 also admins, 2 also
-- members; stopped: the kill switch ("وقف" / "stop" from the owner, or
-- Alerts > Brain), the brain only reads until "شغّل" / "start". Models and
-- limits per run and per day.
-- brain_run: one per WhatsApp message that reached the brain (unique by its
-- id: a message sent twice is one run). brain_step: each tool it used, a
-- summary only (never a key or a secret). brain_approval: an action that
-- can't be undone (a message to a client, deleting, merging, deploying, a
-- migration, secrets, settings, money) waits here until the owner answers
-- its 4-digit code from an owner number within 30 minutes; the code is kept
-- hashed.
-- All of it is read and written by the whatsapp-bot function (service role)
-- only; admins see it through brain_admin / brain_steps and change the
-- settings through brain_settings_set.

create table if not exists public.brain_settings (
  id            int primary key default 1 check (id = 1),
  phase         int not null default 0 check (phase between 0 and 2),
  stopped       boolean not null default false,
  stopped_at    timestamptz,
  stopped_by    text,
  owner_phones  text[] not null default '{}',
  model_owner   text not null default 'claude-opus-5-5',
  model_member  text not null default 'claude-sonnet-5-5',
  model_fast    text not null default 'claude-haiku-5-5',
  max_turns     int not null default 40 check (max_turns between 1 and 200),
  member_turns  int not null default 12 check (member_turns between 1 and 100),
  run_minutes   int not null default 15 check (run_minutes between 1 and 60),
  run_cost_usd  numeric(8,2) not null default 5 check (run_cost_usd > 0),
  day_cost_usd  numeric(8,2) not null default 40 check (day_cost_usd > 0),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profile(id) on delete set null
);
insert into public.brain_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.brain_run (
  id           uuid primary key default gen_random_uuid(),
  message_id   text not null unique,
  chat_id      text not null,
  reply_chat   text not null,
  asker        uuid references public.profile(id) on delete set null,
  asker_name   text,
  tier         text not null check (tier in ('owner', 'admin', 'member')),
  via          text,
  request      text,
  model        text,
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'done', 'failed', 'stopped', 'timeout', 'budget', 'fallback')),
  turns        int,
  cost_usd     numeric(10,4) not null default 0,
  ms           int,
  session_id   text,
  error        text,
  edits        int not null default 0,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists brain_run_created_idx on public.brain_run (created_at desc);
create index if not exists brain_run_chat_idx on public.brain_run (chat_id, created_at desc);

create table if not exists public.brain_step (
  id           bigserial primary key,
  run_id       uuid not null references public.brain_run(id) on delete cascade,
  at           timestamptz not null default now(),
  tool         text not null,
  input        text,
  outcome      text not null,
  detail       text,
  approval_id  uuid
);
create index if not exists brain_step_run_idx on public.brain_step (run_id, at);

create table if not exists public.brain_approval (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid references public.brain_run(id) on delete set null,
  chat_id             text not null,
  message_id          text,
  tool                text not null,
  input               jsonb not null,
  input_hash          text not null,
  what                text not null,
  why                 text,
  detail              text,
  code_hash           text not null,
  status              text not null default 'waiting'
                      check (status in ('waiting', 'approved', 'running', 'refused', 'expired', 'cancelled', 'done', 'failed')),
  asked_message_id    text,
  expires_at          timestamptz not null,
  decided_at          timestamptz,
  decided_by          text,
  decided_message_id  text unique,
  done_at             timestamptz,
  result              text,
  created_at          timestamptz not null default now()
);
create index if not exists brain_approval_waiting_idx on public.brain_approval (created_at desc) where status = 'waiting';

alter table public.brain_settings enable row level security;
alter table public.brain_run      enable row level security;
alter table public.brain_step     enable row level security;
alter table public.brain_approval enable row level security;
revoke all on public.brain_settings, public.brain_run, public.brain_step, public.brain_approval from anon, authenticated;
revoke all on sequence public.brain_step_id_seq from anon, authenticated;

-- Admins: the settings, what the brain spent today (Cairo), the last runs.
create or replace function public.brain_admin(p_limit int default 100)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_today timestamptz := ((now() at time zone 'Africa/Cairo')::date)::timestamp at time zone 'Africa/Cairo';
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) - 'id' from public.brain_settings s where s.id = 1),
    'today_cost', (select coalesce(sum(r.cost_usd), 0) from public.brain_run r where r.created_at >= v_today),
    'waiting', (select count(*) from public.brain_approval a where a.status = 'waiting' and a.expires_at > now()),
    'runs', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select r.id, r.chat_id, r.asker_name, r.tier, r.via, left(r.request, 300) as request, r.model, r.status,
               r.turns, r.cost_usd, r.ms, r.error, r.edits, r.created_at, r.finished_at,
               (select count(*) from public.brain_step st where st.run_id = r.id) as steps
          from public.brain_run r
         order by r.created_at desc
         limit greatest(1, least(coalesce(p_limit, 100), 500))
      ) x
    ), '[]'::jsonb)
  );
end $$;

-- Admins: one run's steps, and the approvals it asked for (never their codes).
create or replace function public.brain_steps(p_run uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'steps', coalesce((select jsonb_agg(to_jsonb(st) - 'run_id' order by st.at) from public.brain_step st where st.run_id = p_run), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'tool', a.tool, 'what', a.what, 'why', a.why, 'status', a.status,
                                          'created_at', a.created_at, 'decided_at', a.decided_at, 'done_at', a.done_at, 'result', a.result)
                       order by a.created_at)
        from public.brain_approval a where a.run_id = p_run
    ), '[]'::jsonb)
  );
end $$;

-- Admins change the settings (Alerts > Brain). Numbers are kept as digits only.
create or replace function public.brain_settings_set(p jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_models text[] := array['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p ? 'model_owner' and not (p->>'model_owner' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'model_member' and not (p->>'model_member' = any(v_models)) then raise exception 'Unknown model'; end if;
  if p ? 'model_fast' and not (p->>'model_fast' = any(v_models)) then raise exception 'Unknown model'; end if;
  update public.brain_settings s set
    phase        = coalesce((p->>'phase')::int, s.phase),
    stopped      = coalesce((p->>'stopped')::boolean, s.stopped),
    stopped_at   = case when p ? 'stopped' and (p->>'stopped')::boolean is distinct from s.stopped
                        then (case when (p->>'stopped')::boolean then now() end) else s.stopped_at end,
    stopped_by   = case when p ? 'stopped' and (p->>'stopped')::boolean is distinct from s.stopped
                        then (case when (p->>'stopped')::boolean then 'Alerts > Brain' end) else s.stopped_by end,
    owner_phones = case when p ? 'owner_phones' then
                     coalesce((select array_agg(distinct d) from (
                        select regexp_replace(x.v, '\D', '', 'g') as d from jsonb_array_elements_text(p->'owner_phones') as x(v)
                     ) n where length(d) between 8 and 15), '{}')
                   else s.owner_phones end,
    model_owner  = coalesce(p->>'model_owner', s.model_owner),
    model_member = coalesce(p->>'model_member', s.model_member),
    model_fast   = coalesce(p->>'model_fast', s.model_fast),
    max_turns    = coalesce((p->>'max_turns')::int, s.max_turns),
    member_turns = coalesce((p->>'member_turns')::int, s.member_turns),
    run_minutes  = coalesce((p->>'run_minutes')::int, s.run_minutes),
    run_cost_usd = coalesce((p->>'run_cost_usd')::numeric, s.run_cost_usd),
    day_cost_usd = coalesce((p->>'day_cost_usd')::numeric, s.day_cost_usd),
    updated_at   = now(),
    updated_by   = auth.uid()
  where s.id = 1;
end $$;

revoke all on function public.brain_admin(int), public.brain_steps(uuid), public.brain_settings_set(jsonb) from public, anon;
grant execute on function public.brain_admin(int), public.brain_steps(uuid), public.brain_settings_set(jsonb) to authenticated;

notify pgrst, 'reload schema';
