-- ============================================================================
-- 0006_automation.sql
--   Rule engine: (trigger, conditions, ordered actions).
--   The engine runs inside DB triggers with hard loop protection.
--   Advanced triggers (scheduled/due-date-relative) are stubbed for later.
-- ============================================================================

create table if not exists public.automation_rule (
  id            uuid primary key default gen_random_uuid(),
  board_id      uuid not null references public.board(id) on delete cascade,
  name          text not null,
  trigger       jsonb not null,       -- {kind:'card.moved', filter:{to_list_id:...}}
  conditions    jsonb not null default '[]'::jsonb,  -- array of {kind,args}
  actions       jsonb not null default '[]'::jsonb,  -- ordered array of {kind,args}
  is_enabled    boolean not null default true,
  created_by    uuid not null references public.profile(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists automation_rule_board_idx on public.automation_rule(board_id);

create table if not exists public.automation_run (
  id           uuid primary key default gen_random_uuid(),
  rule_id      uuid not null references public.automation_rule(id) on delete cascade,
  board_id     uuid not null,
  card_id      uuid,
  actor_id     uuid,
  status       text not null check (status in ('ok','skipped','error')),
  detail       jsonb,
  depth        int  not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists automation_run_rule_idx on public.automation_run(rule_id, created_at desc);

alter table public.automation_rule enable row level security;
alter table public.automation_run  enable row level security;

create policy rule_read on public.automation_rule
  for select to authenticated using (public.is_board_member(board_id) and public.has_permission('pm.view_automation'));
create policy rule_write on public.automation_rule
  for all to authenticated
  using (public.is_board_admin(board_id) and public.has_permission('pm.manage_automation'))
  with check (public.is_board_admin(board_id) and public.has_permission('pm.manage_automation'));

create policy run_read on public.automation_run
  for select to authenticated using (public.is_board_member(board_id) and public.has_permission('pm.view_automation'));

-- =========================================================== Engine =====

-- Depth guard via a per-session GUC. Anything deeper than 3 is skipped, breaking
-- runaway cascades where actions themselves fire more triggers.
create or replace function public._automation_depth() returns int
language plpgsql as $$
declare v text;
begin
  v := current_setting('iklipse.automation_depth', true);
  return coalesce(nullif(v, '')::int, 0);
end $$;

create or replace function public._set_automation_depth(d int) returns void
language plpgsql as $$
begin perform set_config('iklipse.automation_depth', d::text, true); end $$;

-- Evaluate a single condition against a card row.
create or replace function public._auto_condition_matches(p_card_id uuid, p_cond jsonb)
returns boolean language plpgsql as $$
declare
  v_kind text := p_cond->>'kind';
  v_args jsonb := coalesce(p_cond->'args', '{}'::jsonb);
  v_val bool;
begin
  case v_kind
    when 'has_label' then
      execute 'select exists(select 1 from public.card_label
                             where card_id = $1 and label_id = ($2)::uuid)'
        into v_val using p_card_id, v_args->>'label_id';
      return v_val;
    when 'has_member' then
      execute 'select exists(select 1 from public.card_member
                             where card_id = $1 and user_id = ($2)::uuid)'
        into v_val using p_card_id, v_args->>'user_id';
      return v_val;
    when 'in_list' then
      execute 'select exists(select 1 from public.card
                             where id = $1 and list_id = ($2)::uuid)'
        into v_val using p_card_id, v_args->>'list_id';
      return v_val;
    when 'due_incomplete' then
      execute 'select exists(select 1 from public.card
                             where id = $1 and due_date is not null and not due_completed)'
        into v_val using p_card_id;
      return v_val;
    else
      return true; -- unknown conditions default to pass
  end case;
end $$;

-- Execute one action on the card.
create or replace function public._auto_run_action(p_card_id uuid, p_board uuid, p_action jsonb)
returns void language plpgsql as $$
declare
  v_kind text := p_action->>'kind';
  v_args jsonb := coalesce(p_action->'args','{}'::jsonb);
begin
  case v_kind
    when 'move_to_list' then
      update public.card set list_id = (v_args->>'list_id')::uuid, updated_at = now() where id = p_card_id;
    when 'archive' then
      update public.card set is_archived = true, updated_at = now() where id = p_card_id;
    when 'restore' then
      update public.card set is_archived = false, updated_at = now() where id = p_card_id;
    when 'complete_due' then
      update public.card set due_completed = true, updated_at = now() where id = p_card_id;
    when 'add_label' then
      insert into public.card_label(card_id, label_id) values (p_card_id, (v_args->>'label_id')::uuid)
      on conflict do nothing;
    when 'remove_label' then
      delete from public.card_label where card_id = p_card_id and label_id = (v_args->>'label_id')::uuid;
    when 'add_member' then
      insert into public.card_member(card_id, user_id) values (p_card_id, (v_args->>'user_id')::uuid)
      on conflict do nothing;
    when 'remove_member' then
      delete from public.card_member where card_id = p_card_id and user_id = (v_args->>'user_id')::uuid;
    when 'add_comment' then
      insert into public.comment(card_id, author_id, body)
      values (p_card_id, coalesce(auth.uid(), (select created_by from public.card where id = p_card_id)), v_args->>'body');
    when 'rename' then
      update public.card set title = v_args->>'title', updated_at = now() where id = p_card_id;
    when 'set_description' then
      update public.card set description = v_args->>'description', updated_at = now() where id = p_card_id;
    else
      -- Unknown action; ignore silently but record a run entry.
      raise notice 'automation: unknown action kind %', v_kind;
  end case;
end $$;

-- Run every enabled rule matching a trigger for a given card.
create or replace function public._auto_run_for(
  p_trigger_kind text,
  p_card_id uuid,
  p_board uuid,
  p_trigger_data jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_depth int := public._automation_depth();
  r record;
  cond jsonb;
  matched bool;
  act jsonb;
begin
  if v_depth >= 3 then return; end if;
  perform public._set_automation_depth(v_depth + 1);

  for r in
    select id, actions, conditions, trigger
      from public.automation_rule
     where board_id = p_board and is_enabled = true
       and trigger->>'kind' = p_trigger_kind
  loop
    -- Filter matches (extra trigger constraints, e.g. to_list_id)
    matched := true;
    if r.trigger ? 'filter' then
      for cond in select * from jsonb_array_elements(coalesce(r.trigger->'filter'->'checks', '[]'::jsonb))
      loop
        if not public._auto_condition_matches(p_card_id, cond) then matched := false; exit; end if;
      end loop;
    end if;
    if not matched then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'skipped', v_depth,
              jsonb_build_object('reason','trigger_filter'));
      continue;
    end if;

    -- Conditions
    for cond in select * from jsonb_array_elements(coalesce(r.conditions, '[]'::jsonb))
    loop
      if not public._auto_condition_matches(p_card_id, cond) then matched := false; exit; end if;
    end loop;
    if not matched then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'skipped', v_depth, jsonb_build_object('reason','condition'));
      continue;
    end if;

    -- Actions
    begin
      for act in select * from jsonb_array_elements(coalesce(r.actions, '[]'::jsonb))
      loop
        perform public._auto_run_action(p_card_id, p_board, act);
      end loop;
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'ok', v_depth, coalesce(p_trigger_data,'{}'::jsonb));
    exception when others then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'error', v_depth,
              jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  perform public._set_automation_depth(v_depth);
end $$;

-- ============================================ Hook triggers into the model =
create or replace function public.on_card_change_for_automation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public._auto_run_for('card.created', new.id, new.board_id, '{}'::jsonb);
  elsif tg_op = 'UPDATE' then
    if new.list_id is distinct from old.list_id then
      perform public._auto_run_for(
        'card.moved', new.id, new.board_id,
        jsonb_build_object('from_list', old.list_id, 'to_list', new.list_id));
    end if;
    if new.is_archived is distinct from old.is_archived and new.is_archived then
      perform public._auto_run_for('card.archived', new.id, new.board_id, '{}'::jsonb);
    end if;
    if new.due_completed is distinct from old.due_completed and new.due_completed then
      perform public._auto_run_for('card.due_completed', new.id, new.board_id, '{}'::jsonb);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists card_automation_trigger on public.card;
create trigger card_automation_trigger after insert or update on public.card
  for each row execute function public.on_card_change_for_automation();
