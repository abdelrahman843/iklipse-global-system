-- ============================================================================
-- 0034_automation_triggers.sql
--   More automation, closer to Trello Butler:
--     triggers  card.label_added {label_id?}   card.member_added {user_id?}
--               card.due_soon {hours}          card.overdue
--               schedule {every: day|week|month, weekday 1-7, monthday 1-31,
--                         time 'HH:MM', tz, list_id?}
--     actions   notify_members {text}          notify_slack {webhook_url, text}
--               create_card {list_id, title}
--   Text supports {card} {list} {board} {due}.
--   Time based triggers run from automation_tick(), every 5 minutes (pg_cron).
--   automation_fired makes each time based firing happen once.
--   The scheduler has no signed-in user: runs act as the rule's author
--   (created_by, stamped server side to whoever last saved the rule) and are
--   skipped once that person can no longer edit the board.
-- ============================================================================

-- ------------------------------------------------------ rule ownership --
-- created_by / updated_at are set here, never trusted from the client.
create or replace function public.automation_rule_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke execute on function public.automation_rule_stamp() from public, anon, authenticated;
drop trigger if exists automation_rule_stamp on public.automation_rule;
create trigger automation_rule_stamp before insert or update on public.automation_rule
  for each row execute function public.automation_rule_stamp();

-- Rules can hold secrets (Slack webhook URLs): only people who can edit the
-- board may read them.
drop policy if exists rule_read on public.automation_rule;
create policy rule_read on public.automation_rule for select to authenticated
  using (board_id in (select public.editable_board_ids()));

-- can_edit_board() for a given person instead of the signed-in one.
create or replace function public._can_edit_board_as(p_user uuid, p_board uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profile p where p.id = p_user and p.is_active and p.role = 'admin')
      or exists (select 1 from public.board_member bm join public.profile p on p.id = bm.user_id and p.is_active
                  where bm.user_id = p_user and bm.board_id = p_board and bm.role in ('admin', 'normal'));
$$;
revoke execute on function public._can_edit_board_as(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ bookkeeping --
create table if not exists public.automation_fired (
  rule_id  uuid not null references public.automation_rule(id) on delete cascade,
  card_id  uuid references public.card(id) on delete cascade,  -- null: board level (schedule)
  fire_key text not null,
  fired_at timestamptz not null default now()
);
create unique index if not exists automation_fired_uq
  on public.automation_fired (rule_id, coalesce(card_id, '00000000-0000-0000-0000-000000000000'::uuid), fire_key);
alter table public.automation_fired enable row level security;   -- internal: no policies
revoke all on public.automation_fired from public, anon, authenticated;

-- ------------------------------------------------------------ text fill --
create or replace function public._auto_fill(p_text text, p_card uuid, p_board uuid)
returns text language sql stable set search_path = public as $$
  select replace(replace(replace(replace(coalesce(p_text, ''),
           '{card}',  coalesce(c.title, '')),
           '{list}',  coalesce(l.title, '')),
           '{board}', coalesce(b.title, '')),
           '{due}',   coalesce(to_char(c.due_date at time zone 'Africa/Cairo', 'Mon DD, HH24:MI'), 'no due date'))
    from public.board b
    left join public.card c on c.id = p_card
    left join public.list l on l.id = c.list_id
   where b.id = p_board
$$;
revoke execute on function public._auto_fill(text, uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------- actions --
create or replace function public._auto_run_action(p_card_id uuid, p_board uuid, p_action jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_kind   text := p_action->>'kind';
  v_args   jsonb := coalesce(p_action->'args', '{}'::jsonb);
  v_id     uuid;
  v_target uuid;
  v_owner  uuid := coalesce(auth.uid(), nullif(current_setting('iklipse.automation_owner', true), '')::uuid);
begin
  -- Targets named in a rule must live on the rule's board (mirrors: a board
  -- the acting user may edit).
  if v_kind = 'move_to_list' then
    v_id := (v_args->>'list_id')::uuid;
    if not exists (select 1 from public.list where id = v_id and board_id = p_board) then return; end if;
  elsif v_kind in ('add_label', 'remove_label') then
    v_id := (v_args->>'label_id')::uuid;
    if not exists (select 1 from public.label where id = v_id and board_id = p_board) then return; end if;
  elsif v_kind = 'add_member' then
    v_id := (v_args->>'user_id')::uuid;
    if not exists (select 1 from public.board_member where user_id = v_id and board_id = p_board)
       and not exists (select 1 from public.profile where id = v_id and role = 'admin' and is_active) then return; end if;
  elsif v_kind = 'mirror_to_list' then
    v_id := (v_args->>'target_list_id')::uuid;
    select board_id into v_target from public.list where id = v_id and not is_archived;
    if v_target is null or v_target = p_board then return; end if;
    if auth.uid() is not null then
      if not public.can_edit_board(v_target) then return; end if;
    elsif v_owner is null or not public._can_edit_board_as(v_owner, v_target) then
      return;
    end if;
  elsif v_kind = 'create_card' then
    v_id := (v_args->>'list_id')::uuid;
    if not exists (select 1 from public.list where id = v_id and board_id = p_board and not is_archived) then return; end if;
  elsif v_kind = 'notify_slack' then
    -- Only Slack incoming webhooks: the database never calls arbitrary URLs.
    if coalesce(v_args->>'webhook_url', '') !~ '^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+$' then
      raise exception 'Slack webhook URL is not valid';
    end if;
  end if;
  case v_kind
    when 'move_to_list' then update public.card set list_id = v_id, updated_at = now() where id = p_card_id;
    when 'archive'      then update public.card set is_archived = true, updated_at = now() where id = p_card_id;
    when 'restore'      then update public.card set is_archived = false, updated_at = now() where id = p_card_id;
    when 'complete_due' then update public.card set due_completed = true, updated_at = now() where id = p_card_id;
    when 'add_label'    then
      if p_card_id is not null then
        insert into public.card_label(card_id, label_id) values (p_card_id, v_id) on conflict do nothing;
      end if;
    when 'remove_label' then delete from public.card_label where card_id = p_card_id and label_id = v_id;
    when 'add_member'   then
      if p_card_id is not null then
        insert into public.card_member(card_id, user_id) values (p_card_id, v_id) on conflict do nothing;
      end if;
    when 'remove_member' then
      delete from public.card_member where card_id = p_card_id and user_id = (v_args->>'user_id')::uuid;
    when 'add_comment' then
      if p_card_id is not null then
        insert into public.comment(card_id, author_id, body)
        values (p_card_id, coalesce(v_owner, (select created_by from public.card where id = p_card_id)),
                public._auto_fill(v_args->>'body', p_card_id, p_board));
      end if;
    when 'rename'          then update public.card set title = public._auto_fill(v_args->>'title', p_card_id, p_board), updated_at = now() where id = p_card_id;
    when 'set_description' then update public.card set description = v_args->>'description', updated_at = now() where id = p_card_id;
    when 'mirror_to_list' then
      if p_card_id is not null and not exists (select 1 from public.card where mirror_of = p_card_id and list_id = v_id) then
        perform set_config('app.server_write', '1', true);   -- card_integrity lets the server set mirror_of
        insert into public.card (board_id, list_id, title, position, created_by, mirror_of)
        select v_target, v_id, c.title,
               public.rank_between((select k.position from public.card k where k.list_id = v_id and not k.is_archived
                                     order by k.position collate "C" desc limit 1), null),
               coalesce(auth.uid(), c.created_by), c.id
          from public.card c where c.id = p_card_id;
        perform set_config('app.server_write', '', true);
      end if;
    when 'create_card' then
      if v_owner is not null then
        insert into public.card (board_id, list_id, title, position, created_by)
        values (p_board, v_id,
                left(coalesce(nullif(btrim(public._auto_fill(v_args->>'title', p_card_id, p_board)), ''), 'New card'), 500),
                public.rank_between((select k.position from public.card k where k.list_id = v_id and not k.is_archived
                                      order by k.position collate "C" desc limit 1), null),
                v_owner);
      end if;
    when 'notify_members' then
      if p_card_id is not null then
        perform public.notify_users(
          array(select cm.user_id from public.card_member cm where cm.card_id = p_card_id),
          p_board, p_card_id, 'automation',
          jsonb_build_object('text', left(public._auto_fill(v_args->>'text', p_card_id, p_board), 500)));
      end if;
    when 'notify_slack' then
      -- Queued by pg_net and sent after commit (a rolled back run sends nothing).
      perform net.http_post(
        url     := v_args->>'webhook_url',
        body    := jsonb_build_object('text', left(public._auto_fill(v_args->>'text', p_card_id, p_board), 3000)),
        headers := '{"Content-Type": "application/json"}'::jsonb);
    else raise notice 'automation: unknown action kind %', v_kind;
  end case;
end $$;
revoke execute on function public._auto_run_action(uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------- one rule run --
-- Runs one rule for one card (or for the board, p_card_id null) and logs it.
create or replace function public._auto_run_rule(p_rule_id uuid, p_card_id uuid, p_board uuid, p_trigger_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  r       public.automation_rule;
  v_depth int := public._automation_depth();
  v_prev  text := coalesce(current_setting('iklipse.automation_owner', true), '');
  cond    jsonb;
  matched bool := true;
  act     jsonb;
begin
  select * into r from public.automation_rule where id = p_rule_id and board_id = p_board and is_enabled;
  if not found then return; end if;
  if p_card_id is not null and not exists (select 1 from public.card where id = p_card_id and board_id = p_board) then return; end if;
  if v_depth >= 3 then return; end if;
  -- Scheduler runs act as the author: only while they can still edit the board.
  if auth.uid() is null and not public._can_edit_board_as(r.created_by, p_board) then
    insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
    values (r.id, p_board, p_card_id, null, 'skipped', v_depth, jsonb_build_object('reason', 'owner_no_access'));
    return;
  end if;
  perform public._set_automation_depth(v_depth + 1);

  if p_card_id is not null then
    -- Trigger filter (extra trigger constraints, e.g. to_list_id)
    for cond in select * from jsonb_array_elements(coalesce(r.trigger->'filter'->'checks', '[]'::jsonb))
    loop
      if not public._auto_condition_matches(p_card_id, cond) then matched := false; exit; end if;
    end loop;
    if not matched then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'skipped', v_depth, jsonb_build_object('reason', 'trigger_filter'));
      perform public._set_automation_depth(v_depth);
      return;
    end if;
    for cond in select * from jsonb_array_elements(coalesce(r.conditions, '[]'::jsonb))
    loop
      if not public._auto_condition_matches(p_card_id, cond) then matched := false; exit; end if;
    end loop;
    if not matched then
      insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
      values (r.id, p_board, p_card_id, auth.uid(), 'skipped', v_depth, jsonb_build_object('reason', 'condition'));
      perform public._set_automation_depth(v_depth);
      return;
    end if;
  end if;

  -- Actions that create rows act as the rule's author when no one is signed in (scheduler).
  perform set_config('iklipse.automation_owner', r.created_by::text, true);
  begin
    for act in select * from jsonb_array_elements(coalesce(r.actions, '[]'::jsonb))
    loop
      perform public._auto_run_action(p_card_id, p_board, act);
    end loop;
    insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
    values (r.id, p_board, p_card_id, auth.uid(), 'ok', v_depth, coalesce(p_trigger_data, '{}'::jsonb));
  exception when others then
    insert into public.automation_run(rule_id, board_id, card_id, actor_id, status, depth, detail)
    values (r.id, p_board, p_card_id, auth.uid(), 'error', v_depth, jsonb_build_object('error', sqlerrm));
  end;

  perform set_config('iklipse.automation_owner', v_prev, true);   -- nested rules hand the author back
  perform public._set_automation_depth(v_depth);
end $$;
revoke execute on function public._auto_run_rule(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------ event triggers --
create or replace function public._auto_run_for(p_trigger_kind text, p_card_id uuid, p_board uuid, p_trigger_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  -- The card must belong to the board whose rules run (and exist at all).
  if not exists (select 1 from public.card where id = p_card_id and board_id = p_board) then return; end if;
  if public._automation_depth() >= 3 then return; end if;
  for r in
    select id, trigger from public.automation_rule
     where board_id = p_board and is_enabled and trigger->>'kind' = p_trigger_kind
     order by created_at
  loop
    -- "a specific label / member" triggers: other labels / members are not a run at all.
    if p_trigger_kind = 'card.label_added'
       and coalesce(r.trigger->'args'->>'label_id', '') <> ''
       and r.trigger->'args'->>'label_id' is distinct from p_trigger_data->>'label_id' then continue; end if;
    if p_trigger_kind = 'card.member_added'
       and coalesce(r.trigger->'args'->>'user_id', '') <> ''
       and r.trigger->'args'->>'user_id' is distinct from p_trigger_data->>'user_id' then continue; end if;
    perform public._auto_run_rule(r.id, p_card_id, p_board, p_trigger_data);
  end loop;
end $$;
revoke execute on function public._auto_run_for(text, uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.on_card_label_for_automation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  if coalesce(current_setting('app.trello_sync', true), '') = '1'
     or coalesce(current_setting('app.bulk_activity', true), '') = '1' then return new; end if;
  select board_id into v_board from public.card where id = new.card_id;
  if v_board is not null then
    perform public._auto_run_for('card.label_added', new.card_id, v_board, jsonb_build_object('label_id', new.label_id));
  end if;
  return new;
end $$;
revoke execute on function public.on_card_label_for_automation() from public, anon, authenticated;
drop trigger if exists card_label_automation on public.card_label;
create trigger card_label_automation after insert on public.card_label
  for each row execute function public.on_card_label_for_automation();

create or replace function public.on_card_member_for_automation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  if coalesce(current_setting('app.trello_sync', true), '') = '1'
     or coalesce(current_setting('app.bulk_activity', true), '') = '1' then return new; end if;
  select board_id into v_board from public.card where id = new.card_id;
  if v_board is not null then
    perform public._auto_run_for('card.member_added', new.card_id, v_board, jsonb_build_object('user_id', new.user_id));
  end if;
  return new;
end $$;
revoke execute on function public.on_card_member_for_automation() from public, anon, authenticated;
drop trigger if exists card_member_automation on public.card_member;
create trigger card_member_automation after insert on public.card_member
  for each row execute function public.on_card_member_for_automation();

-- ------------------------------------------------------ time based tick --
create or replace function public.automation_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  r       public.automation_rule;
  c       record;
  a       jsonb;
  v_n     int;
  v_hours numeric;
  v_tz    text;
  v_local timestamp;
  v_slot  timestamp;
  v_time  time;
  v_day   int;
begin
  -- Due date triggers: once per card per due date.
  for r in select * from public.automation_rule
            where is_enabled and trigger->>'kind' in ('card.due_soon', 'card.overdue')
  loop
    begin
      v_hours := greatest(0, least(24 * 60, coalesce(nullif(r.trigger->'args'->>'hours', '')::numeric, 24)));
      for c in
        select k.id, k.due_date
          from public.card k join public.list l on l.id = k.list_id
         where k.board_id = r.board_id and not k.is_archived and not k.is_template
           and not k.due_completed and not l.is_done and not l.is_archived
           and k.due_date is not null
           and not exists (select 1 from public.automation_fired f
                            where f.rule_id = r.id and f.card_id = k.id and f.fire_key = k.due_date::text)
           and case when r.trigger->>'kind' = 'card.due_soon'
                    then k.due_date > now() and k.due_date <= now() + make_interval(secs => (v_hours * 3600)::double precision)
                    else k.due_date <= now() and k.due_date > greatest(r.created_at, now() - interval '2 days') end
         order by k.due_date
         limit 200
      loop
        insert into public.automation_fired (rule_id, card_id, fire_key)
        values (r.id, c.id, c.due_date::text) on conflict do nothing;
        get diagnostics v_n = row_count;
        if v_n > 0 then
          perform public._auto_run_rule(r.id, c.id, r.board_id, jsonb_build_object('due', c.due_date));
        end if;
      end loop;
    exception when others then
      raise warning 'automation_tick rule %: %', r.id, sqlerrm;
    end;
  end loop;

  -- Schedules: once per local day slot.
  for r in select * from public.automation_rule where is_enabled and trigger->>'kind' = 'schedule'
  loop
    begin
      a       := coalesce(r.trigger->'args', '{}'::jsonb);
      v_tz    := coalesce(nullif(a->>'tz', ''), 'Africa/Cairo');
      v_local := now() at time zone v_tz;
      v_time  := coalesce(nullif(a->>'time', '')::time, time '09:00');
      -- Ticks run every 5 minutes: snap to that grid so 23:57 still fires.
      v_time  := v_time - make_interval(mins => extract(minute from v_time)::int % 5,
                                        secs => extract(second from v_time)::double precision);
      v_slot  := v_local::date + v_time;
      if v_local < v_slot then continue; end if;
      if a->>'every' = 'week'
         and extract(isodow from v_local)::int <> coalesce(nullif(a->>'weekday', '')::int, 1) then continue; end if;
      if a->>'every' = 'month' then
        v_day := least(coalesce(nullif(a->>'monthday', '')::int, 1),
                       extract(day from (date_trunc('month', v_local) + interval '1 month - 1 day'))::int);
        if extract(day from v_local)::int <> v_day then continue; end if;
      end if;
      insert into public.automation_fired (rule_id, card_id, fire_key)
      values (r.id, null, to_char(v_local, 'YYYY-MM-DD')) on conflict do nothing;
      get diagnostics v_n = row_count;
      if v_n = 0 then continue; end if;
      -- A rule saved after today's slot starts from the next one.
      if (greatest(r.created_at, r.updated_at) at time zone v_tz) > v_slot then continue; end if;
      if coalesce(a->>'list_id', '') <> '' then
        for c in
          select k.id from public.card k
           where k.list_id = (a->>'list_id')::uuid and k.board_id = r.board_id
             and not k.is_archived and not k.is_template
           order by k.position collate "C"
           limit 200
        loop
          perform public._auto_run_rule(r.id, c.id, r.board_id, jsonb_build_object('scheduled', to_char(v_local, 'YYYY-MM-DD HH24:MI')));
        end loop;
      else
        perform public._auto_run_rule(r.id, null, r.board_id, jsonb_build_object('scheduled', to_char(v_local, 'YYYY-MM-DD HH24:MI')));
      end if;
    exception when others then
      raise warning 'automation_tick rule %: %', r.id, sqlerrm;
    end;
  end loop;

  delete from public.automation_fired where fired_at < now() - interval '90 days';
end $$;
revoke execute on function public.automation_tick() from public, anon, authenticated;
