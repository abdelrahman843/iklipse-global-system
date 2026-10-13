-- 0061: Due alerts that no longer apply resolve themselves. When a delivery is
-- marked done or gets a new date, or the project is delivered / cancelled /
-- re-dated, its "due soon" and "late" notifications are marked read and
-- flagged {"resolved": true}, so the bell stops asking for attention.

create or replace function public._project_alerts_resolve(p_project uuid, p_delivery text, p_all boolean)
returns void language sql security definer set search_path = public as $$
  update public.notification
     set read_at = coalesce(read_at, now()),
         data = coalesce(data, '{}'::jsonb) || '{"resolved": true}'::jsonb
   where kind in ('project_due_soon', 'project_overdue')
     and data->>'project_id' = p_project::text
     and not coalesce((data->>'resolved')::boolean, false)
     and (p_all or coalesce(data->>'delivery', '') = coalesce(p_delivery, ''));
$$;
revoke all on function public._project_alerts_resolve(uuid, text, boolean) from public, anon, authenticated;

create or replace function public.on_project_delivery_resolve()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.done_at is not null and old.done_at is null) or new.due_at is distinct from old.due_at then
    perform public._project_alerts_resolve(new.project_id, old.title, false);
  end if;
  return null;
end $$;
revoke execute on function public.on_project_delivery_resolve() from public, anon, authenticated;
drop trigger if exists project_delivery_resolve on public.project_delivery;
create trigger project_delivery_resolve after update on public.project_delivery
  for each row execute function public.on_project_delivery_resolve();

create or replace function public.on_project_resolve()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('delivered', 'cancelled') and old.status is distinct from new.status then
    perform public._project_alerts_resolve(new.id, null, true);
  elsif new.due_at is distinct from old.due_at then
    perform public._project_alerts_resolve(new.id, null, false); -- the project's own date (no delivery)
  end if;
  return null;
end $$;
revoke execute on function public.on_project_resolve() from public, anon, authenticated;
drop trigger if exists project_resolve on public.project;
create trigger project_resolve after update on public.project
  for each row execute function public.on_project_resolve();

-- Deleting a delivery leaves nothing to warn about either.
create or replace function public.on_project_delivery_gone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._project_alerts_resolve(old.project_id, old.title, false);
  return null;
end $$;
revoke execute on function public.on_project_delivery_gone() from public, anon, authenticated;
drop trigger if exists project_delivery_gone on public.project_delivery;
create trigger project_delivery_gone after delete on public.project_delivery
  for each row execute function public.on_project_delivery_gone();

-- The AI assistant left the app (no buttons call it any more): keep it off.
update public.workspace set ai_enabled = false where ai_enabled;
