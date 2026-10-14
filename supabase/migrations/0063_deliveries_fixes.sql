-- ============================================================================
-- 0063_deliveries_fixes.sql
--   Reopening a round (without starting the next one) no longer loses what the
--   client sent: the earlier feedback / approval is kept in round.history.
--   Plus an index for the visitor comment rate limit.
-- ============================================================================

alter table public.delivery_round add column if not exists history jsonb not null default '[]'::jsonb;

create index if not exists delivery_comment_link_idx on public.delivery_comment(link_id, created_at);

create or replace function public.delivery_next_round(p_folder uuid, p_clear boolean default true)
returns integer language plpgsql security definer set search_path = public as $$
declare f public.delivery_folder;
begin
  if not public.can_manage_deliveries() then raise exception 'No access to deliveries'; end if;
  select * into f from public.delivery_folder where id = p_folder for update;
  if not found then raise exception 'Delivery not found'; end if;
  perform set_config('iklipse.delivery_sys', '1', true);
  if p_clear then
    update public.delivery_round
       set closed_at = now(), closed_by = auth.uid(), items = coalesce(items, public._delivery_snapshot(f.id))
     where folder_id = f.id and number = f.round;
    insert into public.delivery_round (folder_id, number, opened_by) values (f.id, f.round + 1, auth.uid());
    update public.delivery_folder set round = f.round + 1, state = 'open' where id = f.id;
  else
    -- Keep what the client sent, then open the round again.
    update public.delivery_round
       set history = history || case when submitted_at is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
                         'outcome', outcome, 'submitted_at', submitted_at, 'submitted_name', submitted_name,
                         'submitted_email', submitted_email, 'client_note', client_note,
                         'reopened_at', now(), 'reopened_by', (select display_name from public.profile where id = auth.uid()))) end,
           outcome = null, submitted_at = null, submitted_name = null, submitted_email = null, client_note = null, items = null
     where folder_id = f.id and number = f.round;
    update public.delivery_folder set state = 'open' where id = f.id;
  end if;
  perform set_config('iklipse.delivery_sys', '', true);
  return case when p_clear then f.round + 1 else f.round end;
end $$;
revoke all on function public.delivery_next_round(uuid, boolean) from public, anon;
grant execute on function public.delivery_next_round(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
