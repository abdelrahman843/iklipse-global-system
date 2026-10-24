-- The brain takes everything the bot is told (0120): every message to the bot
-- from the team (new requests, answers to its questions, orders carried on,
-- meetings, clients' details), and, at phase 3, clients' private chats too.
--
-- - phase 3: clients too (their private chats, read once quiet, dm.ts).
-- - fallback_old: when the brain is down, the old order router answers
--   instead (off: the person hears the bot is down for a moment).
-- - brain_run: a client's run has no profile (asker null): client_id, and
--   quoted_id (what the message replied to, so the brain knows what it answers).
-- - brain_approval.approver_phones: an admin OKs the changes to the system
--   they asked for themselves (the owner hears of it).

alter table public.brain_settings drop constraint if exists brain_settings_phase_check;
alter table public.brain_settings add constraint brain_settings_phase_check check (phase between 0 and 3);
alter table public.brain_settings add column if not exists fallback_old boolean not null default false;

-- Who answers an OK's code: the owner numbers (null), or, for a change to the
-- system an admin asked for privately (merge, deploy, roll back, update the
-- brain), that admin's own numbers.
alter table public.brain_approval add column if not exists approver_phones text[];

alter table public.brain_run drop constraint if exists brain_run_tier_check;
alter table public.brain_run add constraint brain_run_tier_check check (tier in ('owner', 'admin', 'member', 'client'));
alter table public.brain_run add column if not exists client_id uuid references public.client(id) on delete set null;
alter table public.brain_run add column if not exists quoted_id text;

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
    fallback_old = coalesce((p->>'fallback_old')::boolean, s.fallback_old),
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

revoke all on function public.brain_settings_set(jsonb) from public, anon;
grant execute on function public.brain_settings_set(jsonb) to authenticated;

notify pgrst, 'reload schema';
