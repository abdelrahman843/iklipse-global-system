-- 0124_brain_models.sql
--   Every Claude the API key can use (GET /v1/models, 2026-10-25) can be picked
--   for the brain on Alerts > Brain or from WhatsApp, not only the three 5.5s.
--   Same function as 0120 otherwise.

create or replace function public.brain_settings_set(p jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_models text[] := array[
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001'
  ];
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
