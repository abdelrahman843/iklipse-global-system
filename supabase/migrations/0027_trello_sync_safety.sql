-- ============================================================================
-- 0027_trello_sync_safety.sql
--   Fixes from the sync review:
--   - A card or list moved between Trello boards was hard-deleted by the
--     source board's sync (with its comments) before the destination synced.
--     Missing rows now wait 30 minutes (the destination re-homes them first);
--     a real Trello delete arrives as a deleteCard action and applies at once.
--   - The daily comment sweep only removes comments from this board's own
--     history (a card's old board keeps owning its old comments).
--   - Items, labels, members and links added locally to mirrored cards are no
--     longer wiped; only rows that came from Trello are pruned.
--   - A board deleted here stays deleted (tombstone) instead of coming back.
--   - The last-admin guard no longer stalls the sync or keeps removed people.
--   - Missing customFields, broken numbers or orphan checklists no longer
--     abort the whole run; late comment edits cannot revert newer text.
--   - Mirror resolution computes the final target once, writes only real
--     changes and takes a lock (no deadlock between two boards).
--   - Relinking replays snapshots without forcing stale ones; relinking a
--     profile to another person relinks the previous person too.
--   - Deleting a user hands their sole-admin boards to the heir first.
-- ============================================================================

create table if not exists public.trello_missing (
  entity_type      text not null,
  entity_id        uuid not null,
  first_missing_at timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
alter table public.trello_missing enable row level security;
revoke all on public.trello_missing from anon, authenticated;

alter table public.trello_import_map add column if not exists board_trello_id text;

-- last-admin guard: the sync mirrors Trello's roles as they are
create or replace function public.board_member_last_admin_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.trello_sync', true), '') = '1' then return coalesce(new, old); end if;
  if old.role <> 'admin' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then return new; end if;
  if not exists (select 1 from public.board where id = old.board_id) then return coalesce(new, old); end if;
  if not exists (select 1 from public.profile where id = old.user_id) then return coalesce(new, old); end if;
  if not exists (select 1 from public.board_member
                  where board_id = old.board_id and role = 'admin' and user_id <> old.user_id) then
    raise exception 'A board needs at least one admin. Make someone else admin first.';
  end if;
  return coalesce(new, old);
end $$;

-- a synced board deleted here is remembered, so the sync never recreates it
create or replace function public.trello_board_tombstone()
returns trigger language plpgsql security definer set search_path = public as $$
declare tid text;
begin
  select trello_id into tid from public.trello_import_map where entity_type = 'board' and entity_id = old.id;
  if tid is not null then
    insert into public.trello_import_map (trello_id, entity_type, entity_id) values (tid, 'board_deleted', old.id)
    on conflict (trello_id, entity_type) do nothing;
    delete from public.trello_raw where key = 'board:' || tid;
    delete from public.trello_sync_state where board_trello_id = tid;
  end if;
  return old;
end $$;
drop trigger if exists board_trello_tombstone on public.board;
create trigger board_trello_tombstone before delete on public.board for each row execute function public.trello_board_tombstone();

create or replace function public.trello_sync_board(p_board jsonb, p_fetched_at timestamptz default now(), p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tid       text := p_board->>'id';
  st        public.trello_sync_state;
  b_id      uuid;
  owner     uuid;
  vis       public.board_visibility;
  bg        text;
  x         jsonb;
  y         jsonb;
  i         int;
  j         int;
  xid       uuid;
  lid       uuid;
  cid       uuid;
  clid      uuid;
  fid       uuid;
  want      uuid[];
  seen      uuid[];
  seen_l    uuid[] := '{}';
  seen_lb   uuid[] := '{}';
  seen_c    uuid[] := '{}';
  seen_cl   uuid[] := '{}';
  seen_f    uuid[] := '{}';
  n_cards   int := jsonb_array_length(coalesce(p_board->'cards', '[]'));
  n_new     int := 0;
  n_upd     int := 0;
  n_del     int := 0;
  v_val     jsonb;
  v_type    public.custom_field_type;
begin
  if tid is null then raise exception 'trello_sync_board: board id missing'; end if;
  perform pg_advisory_xact_lock(hashtext('trello:' || tid));
  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);

  -- Deleted here on purpose: never bring it back.
  if exists (select 1 from public.trello_import_map where trello_id = tid and entity_type = 'board_deleted') then
    return jsonb_build_object('skipped', 'deleted');
  end if;

  insert into public.trello_sync_state (board_trello_id) values (tid) on conflict do nothing;
  select * into st from public.trello_sync_state where board_trello_id = tid;
  if not p_force and st.applied_fetched_at is not null and st.applied_fetched_at > p_fetched_at then
    return jsonb_build_object('skipped', 'stale', 'actions_since', st.actions_since);
  end if;

  insert into public.trello_raw (key, data, fetched_at) values ('board:' || tid, p_board, p_fetched_at)
  on conflict (key) do update set data = excluded.data, fetched_at = excluded.fetched_at;

  -- people ------------------------------------------------------------------
  for x in select value from jsonb_array_elements(coalesce(p_board->'members', '[]')) loop
    perform public._trello_member_upsert(x, true);
  end loop;

  owner := coalesce(
    (select tm.profile_id
       from jsonb_array_elements(coalesce(p_board->'memberships', '[]')) ms
       join public.trello_member tm on tm.trello_id = ms->>'idMember'
      where ms->>'memberType' = 'admin' and tm.profile_id is not null
      limit 1),
    public._trello_fallback());

  -- board -------------------------------------------------------------------
  vis := case p_board->'prefs'->>'permissionLevel' when 'private' then 'private' else 'workspace' end;
  bg  := coalesce(p_board->'prefs'->>'backgroundColor', p_board->'prefs'->>'backgroundTopColor');
  b_id := public._tmap(tid, 'board');
  if b_id is null or not exists (select 1 from public.board where id = b_id) then
    b_id := coalesce(b_id, gen_random_uuid());
    insert into public.board (id, workspace_id, title, description, background, is_archived, created_by, visibility, created_at)
    values (b_id, '00000000-0000-0000-0000-000000000001', coalesce(nullif(trim(p_board->>'name'), ''), 'Trello board'),
            nullif(p_board->>'desc', ''), bg, coalesce((p_board->>'closed')::boolean, false), owner, vis,
            public._trello_created(tid));
    perform public._tmap_put(tid, 'board', b_id);
  else
    update public.board
       set title = coalesce(nullif(trim(p_board->>'name'), ''), title),
           description = nullif(p_board->>'desc', ''),
           background = coalesce(bg, background),
           is_archived = coalesce((p_board->>'closed')::boolean, false),
           visibility = vis
     where id = b_id
       and (title, description, background, is_archived, visibility) is distinct from
           (coalesce(nullif(trim(p_board->>'name'), ''), title), nullif(p_board->>'desc', ''),
            coalesce(bg, background), coalesce((p_board->>'closed')::boolean, false), vis);
  end if;

  -- board members (linked people only; unlinked ones join once linked)
  insert into public.board_member (board_id, user_id, role)
  select b_id, tm.profile_id, (ms->>'memberType')::public.board_role
    from jsonb_array_elements(coalesce(p_board->'memberships', '[]')) ms
    join public.trello_member tm on tm.trello_id = ms->>'idMember'
   where tm.profile_id is not null
     and not coalesce((ms->>'deactivated')::boolean, false)
     and ms->>'memberType' in ('admin', 'normal', 'observer')
  on conflict (board_id, user_id) do update set role = excluded.role
   where board_member.role is distinct from excluded.role;
  delete from public.board_member bm
     where bm.board_id = b_id
       and bm.user_id in (select profile_id from public.trello_member where profile_id is not null)
       and bm.user_id not in (
         select tm.profile_id
           from jsonb_array_elements(coalesce(p_board->'memberships', '[]')) ms
           join public.trello_member tm on tm.trello_id = ms->>'idMember'
          where tm.profile_id is not null and not coalesce((ms->>'deactivated')::boolean, false));

  -- labels ------------------------------------------------------------------
  i := 0;
  for x in select value from jsonb_array_elements(coalesce(p_board->'labels', '[]')) loop
    i := i + 1;
    xid := public._tmap(x->>'id', 'label');
    if xid is null or not exists (select 1 from public.label where id = xid) then
      xid := coalesce(xid, gen_random_uuid());
      insert into public.label (id, board_id, name, color, position)
      values (xid, b_id, coalesce(x->>'name', ''), coalesce(public._trello_color(x->>'color'), '#94a3b8'), lpad(i::text, 6, '0'));
      perform public._tmap_put(x->>'id', 'label', xid);
    else
      update public.label
         set board_id = b_id, name = coalesce(x->>'name', ''),
             color = coalesce(public._trello_color(x->>'color'), '#94a3b8'), position = lpad(i::text, 6, '0')
       where id = xid
         and (board_id, name, color, position) is distinct from
             (b_id, coalesce(x->>'name', ''), coalesce(public._trello_color(x->>'color'), '#94a3b8'), lpad(i::text, 6, '0'));
    end if;
    seen_lb := seen_lb || xid;
  end loop;
  if jsonb_array_length(coalesce(p_board->'labels', '[]')) > 0 then
    delete from public.label
     where board_id = b_id and id <> all(seen_lb)
       and id in (select entity_id from public.trello_import_map where entity_type = 'label');
  end if;

  -- lists -------------------------------------------------------------------
  i := 0;
  for x in select value from jsonb_array_elements(coalesce(p_board->'lists', '[]')) loop
    i := i + 1;
    xid := public._tmap(x->>'id', 'list');
    if xid is null or not exists (select 1 from public.list where id = xid) then
      xid := coalesce(xid, gen_random_uuid());
      insert into public.list (id, board_id, title, position, is_archived, color, created_at)
      values (xid, b_id, coalesce(nullif(trim(x->>'name'), ''), 'Untitled list'), public._trello_pos(x->>'pos', i),
              coalesce((x->>'closed')::boolean, false), public._trello_color(x->>'color'), public._trello_created(x->>'id'));
      perform public._tmap_put(x->>'id', 'list', xid);
    else
      update public.list
         set board_id = b_id, title = coalesce(nullif(trim(x->>'name'), ''), title),
             position = public._trello_pos(x->>'pos', i), is_archived = coalesce((x->>'closed')::boolean, false),
             color = public._trello_color(x->>'color')
       where id = xid
         and (board_id, title, position, is_archived, color) is distinct from
             (b_id, coalesce(nullif(trim(x->>'name'), ''), title), public._trello_pos(x->>'pos', i),
              coalesce((x->>'closed')::boolean, false), public._trello_color(x->>'color'));
    end if;
    seen_l := seen_l || xid;
  end loop;

  -- custom field definitions --------------------------------------------------
  i := 0;
  for x in select value from jsonb_array_elements(coalesce(p_board->'customFields', '[]')) loop
    i := i + 1;
    v_type := case x->>'type' when 'number' then 'number' when 'date' then 'date' when 'checkbox' then 'checkbox'
                              when 'list' then 'select' else 'text' end;
    v_val := case when x->>'type' = 'list' then
               (select coalesce(jsonb_agg(jsonb_build_object('id', o->>'id', 'label', coalesce(o->'value'->>'text', ''),
                                                              'color', public._trello_color(o->>'color'))
                                          order by (o->>'pos')::numeric nulls last), '[]'::jsonb)
                  from jsonb_array_elements(coalesce(x->'options', '[]')) o)
             end;
    xid := public._tmap(x->>'id', 'custom_field');
    if xid is null or not exists (select 1 from public.custom_field_def where id = xid) then
      xid := coalesce(xid, gen_random_uuid());
      insert into public.custom_field_def (id, board_id, name, type, options, show_on_front, position)
      values (xid, b_id, coalesce(nullif(x->>'name', ''), 'Field'), v_type, v_val,
              coalesce((x->'display'->>'cardFront')::boolean, false), public._trello_pos(x->>'pos', i));
      perform public._tmap_put(x->>'id', 'custom_field', xid);
    else
      update public.custom_field_def
         set name = coalesce(nullif(x->>'name', ''), name), type = v_type, options = v_val,
             show_on_front = coalesce((x->'display'->>'cardFront')::boolean, false),
             position = public._trello_pos(x->>'pos', i)
       where id = xid
         and (name, type, options, show_on_front, position) is distinct from
             (coalesce(nullif(x->>'name', ''), name), v_type, v_val,
              coalesce((x->'display'->>'cardFront')::boolean, false), public._trello_pos(x->>'pos', i));
    end if;
    seen_f := seen_f || xid;
  end loop;
  if p_board ? 'customFields' then   -- absent key (Power-Up off / not requested) must not wipe fields
    delete from public.custom_field_def
     where board_id = b_id and id <> all(seen_f)
       and id in (select entity_id from public.trello_import_map where entity_type = 'custom_field');
  end if;

  -- cards -------------------------------------------------------------------
  i := 0;
  for x in select value from jsonb_array_elements(coalesce(p_board->'cards', '[]')) loop
    i := i + 1;
    lid := public._tmap(x->>'idList', 'list');
    if lid is null then continue; end if;
    cid := public._tmap(x->>'id', 'card');
    if cid is null or not exists (select 1 from public.card where id = cid) then
      cid := coalesce(cid, gen_random_uuid());
      insert into public.card (id, board_id, list_id, title, description, position, start_date, due_date,
                               due_completed, is_archived, cover_color, created_by, created_at)
      values (cid, b_id, lid, coalesce(nullif(trim(x->>'name'), ''), 'Untitled'), nullif(x->>'desc', ''),
              public._trello_pos(x->>'pos', i),
              (nullif(x->>'start', '')::timestamptz at time zone 'Africa/Cairo')::date,
              nullif(x->>'due', '')::timestamptz, coalesce((x->>'dueComplete')::boolean, false),
              coalesce((x->>'closed')::boolean, false), public._trello_color(x->'cover'->>'color'),
              owner, public._trello_created(x->>'id'));
      perform public._tmap_put(x->>'id', 'card', cid);
      n_new := n_new + 1;
    else
      update public.card
         set board_id = b_id, list_id = lid,
             title = coalesce(nullif(trim(x->>'name'), ''), title),
             description = nullif(x->>'desc', ''),
             position = public._trello_pos(x->>'pos', i),
             start_date = (nullif(x->>'start', '')::timestamptz at time zone 'Africa/Cairo')::date,
             due_date = nullif(x->>'due', '')::timestamptz,
             due_completed = coalesce((x->>'dueComplete')::boolean, false),
             is_archived = coalesce((x->>'closed')::boolean, false),
             cover_color = public._trello_color(x->'cover'->>'color')
       where id = cid
         and (board_id, list_id, title, description, position, start_date, due_date, due_completed, is_archived, cover_color)
             is distinct from
             (b_id, lid, coalesce(nullif(trim(x->>'name'), ''), title), nullif(x->>'desc', ''),
              public._trello_pos(x->>'pos', i),
              (nullif(x->>'start', '')::timestamptz at time zone 'Africa/Cairo')::date,
              nullif(x->>'due', '')::timestamptz, coalesce((x->>'dueComplete')::boolean, false),
              coalesce((x->>'closed')::boolean, false), public._trello_color(x->'cover'->>'color'));
      if found then n_upd := n_upd + 1; end if;
    end if;
    seen_c := seen_c || cid;
    if x->>'shortLink' is not null and public._tmap(x->>'shortLink', 'card_short') is distinct from cid then
      perform public._tmap_put(x->>'shortLink', 'card_short', cid);
    end if;

    -- labels on the card
    want := array(select public._tmap(v, 'label') from jsonb_array_elements_text(coalesce(x->'idLabels', '[]')) v
                   where public._tmap(v, 'label') is not null);
    delete from public.card_label where card_id = cid and label_id <> all(want)
       and label_id in (select entity_id from public.trello_import_map where entity_type = 'label');
    insert into public.card_label (card_id, label_id) select cid, unnest(want) on conflict do nothing;

    -- members on the card (unlinked people remembered for later)
    want := array(select tm.profile_id from jsonb_array_elements_text(coalesce(x->'idMembers', '[]')) v
                    join public.trello_member tm on tm.trello_id = v where tm.profile_id is not null);
    delete from public.card_member where card_id = cid and user_id <> all(want)
       and user_id in (select profile_id from public.trello_member where profile_id is not null);
    insert into public.card_member (card_id, user_id) select cid, unnest(want) on conflict do nothing;
    delete from public.trello_author
     where entity_type = 'card_member' and entity_id = cid
       and trello_member_id not in (select jsonb_array_elements_text(coalesce(x->'idMembers', '[]')));
    insert into public.trello_author (entity_type, entity_id, trello_member_id)
    select 'card_member', cid, v from jsonb_array_elements_text(coalesce(x->'idMembers', '[]')) v
    on conflict do nothing;

    -- attachments (links + uploads, kept as external links)
    seen := '{}';
    j := 0;
    for y in select value from jsonb_array_elements(coalesce(x->'attachments', '[]')) loop
      j := j + 1;
      if nullif(y->>'url', '') is null then continue; end if;
      xid := public._tmap(y->>'id', 'attachment');
      if xid is null then   -- adopt a row from the first import (same card + url)
        select a.id into xid from public.attachment a
         where a.card_id = cid and a.external_url = y->>'url'
           and a.id not in (select entity_id from public.trello_import_map where entity_type = 'attachment')
         limit 1;
        if xid is not null then perform public._tmap_put(y->>'id', 'attachment', xid); end if;
      end if;
      if xid is null or not exists (select 1 from public.attachment where id = xid) then
        xid := coalesce(xid, gen_random_uuid());
        insert into public.attachment (id, card_id, name, mime_type, size, external_url, uploaded_by, created_at)
        values (xid, cid, coalesce(nullif(trim(y->>'name'), ''), 'attachment'), nullif(y->>'mimeType', ''),
                nullif(y->>'bytes', '')::bigint, y->>'url', public._trello_author_of(y->>'idMember'),
                coalesce(nullif(y->>'date', '')::timestamptz, now()));
        perform public._tmap_put(y->>'id', 'attachment', xid);
      else
        update public.attachment
           set card_id = cid, name = coalesce(nullif(trim(y->>'name'), ''), name),
               mime_type = nullif(y->>'mimeType', ''), size = nullif(y->>'bytes', '')::bigint,
               external_url = y->>'url', uploaded_by = public._trello_author_of(y->>'idMember'),
               created_at = coalesce(nullif(y->>'date', '')::timestamptz, created_at)
         where id = xid
           and (card_id, name, mime_type, size, external_url, uploaded_by, created_at) is distinct from
               (cid, coalesce(nullif(trim(y->>'name'), ''), name), nullif(y->>'mimeType', ''),
                nullif(y->>'bytes', '')::bigint, y->>'url', public._trello_author_of(y->>'idMember'),
                coalesce(nullif(y->>'date', '')::timestamptz, created_at));
      end if;
      perform public._trello_note_author('attachment', xid, y->>'idMember');
      seen := seen || xid;
    end loop;
    delete from public.attachment a
     where a.card_id = cid and a.storage_path is null and a.id <> all(seen)
       and a.id in (select entity_id from public.trello_import_map where entity_type = 'attachment');

    -- custom field values
    delete from public.custom_field_value v
     where v.card_id = cid
       and v.field_id in (select entity_id from public.trello_import_map where entity_type = 'custom_field')
       and v.field_id not in (select public._tmap(ci->>'idCustomField', 'custom_field')
                                from jsonb_array_elements(coalesce(x->'customFieldItems', '[]')) ci
                               where public._tmap(ci->>'idCustomField', 'custom_field') is not null);
    for y in select value from jsonb_array_elements(coalesce(x->'customFieldItems', '[]')) loop
      fid := public._tmap(y->>'idCustomField', 'custom_field');
      if fid is null then continue; end if;
      v_val := case
        when y->>'idValue' is not null then to_jsonb(y->>'idValue')
        when y->'value' ? 'checked' then to_jsonb((y->'value'->>'checked') = 'true')
        when y->'value' ? 'number' and (y->'value'->>'number') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then to_jsonb((y->'value'->>'number')::numeric)
        when y->'value' ? 'date' then to_jsonb(((y->'value'->>'date')::timestamptz at time zone 'Africa/Cairo')::date::text)
        when y->'value' ? 'text' then to_jsonb(y->'value'->>'text')
        else null end;
      if v_val is null then continue; end if;
      insert into public.custom_field_value (card_id, field_id, value) values (cid, fid, v_val)
      on conflict (card_id, field_id) do update set value = excluded.value
       where custom_field_value.value is distinct from excluded.value;
    end loop;
  end loop;

  -- checklists (board level; each carries idCard) ------------------------------
  i := 0;
  for x in select value from jsonb_array_elements(coalesce(p_board->'checklists', '[]')) loop
    i := i + 1;
    cid := public._tmap(x->>'idCard', 'card');
    if cid is null or not exists (select 1 from public.card where id = cid) then continue; end if;
    clid := public._tmap(x->>'id', 'checklist');
    if clid is null or not exists (select 1 from public.checklist where id = clid) then
      clid := coalesce(clid, gen_random_uuid());
      insert into public.checklist (id, card_id, name, position)
      values (clid, cid, coalesce(nullif(trim(x->>'name'), ''), 'Checklist'), public._trello_pos(x->>'pos', i));
      perform public._tmap_put(x->>'id', 'checklist', clid);
    else
      update public.checklist
         set card_id = cid, name = coalesce(nullif(trim(x->>'name'), ''), 'Checklist'), position = public._trello_pos(x->>'pos', i)
       where id = clid
         and (card_id, name, position) is distinct from
             (cid, coalesce(nullif(trim(x->>'name'), ''), 'Checklist'), public._trello_pos(x->>'pos', i));
    end if;
    seen_cl := seen_cl || clid;

    seen := '{}';
    j := 0;
    for y in select value from jsonb_array_elements(coalesce(x->'checkItems', '[]')) loop
      j := j + 1;
      xid := public._tmap(y->>'id', 'checklist_item');
      if xid is null or not exists (select 1 from public.checklist_item where id = xid) then
        xid := coalesce(xid, gen_random_uuid());
        insert into public.checklist_item (id, checklist_id, text, completed, position, assignee_id, due_date)
        values (xid, clid, coalesce(y->>'name', ''), y->>'state' = 'complete', public._trello_pos(y->>'pos', j),
                public._trello_profile(y->>'idMember'), nullif(y->>'due', '')::timestamptz);
        perform public._tmap_put(y->>'id', 'checklist_item', xid);
      else
        update public.checklist_item
           set checklist_id = clid, text = coalesce(y->>'name', ''), completed = y->>'state' = 'complete',
               position = public._trello_pos(y->>'pos', j), assignee_id = public._trello_profile(y->>'idMember'),
               due_date = nullif(y->>'due', '')::timestamptz
         where id = xid
           and (checklist_id, text, completed, position, assignee_id, due_date) is distinct from
               (clid, coalesce(y->>'name', ''), y->>'state' = 'complete', public._trello_pos(y->>'pos', j),
                public._trello_profile(y->>'idMember'), nullif(y->>'due', '')::timestamptz);
      end if;
      delete from public.trello_author where entity_type = 'assignee' and entity_id = xid;
      perform public._trello_note_author('assignee', xid, y->>'idMember');
      seen := seen || xid;
    end loop;
    delete from public.checklist_item where checklist_id = clid and id <> all(seen)
       and id in (select entity_id from public.trello_import_map where entity_type = 'checklist_item');
  end loop;

  -- prune what Trello no longer has ------------------------------------------
  -- Guard: never prune from an empty or possibly truncated snapshot.
  if n_cards > 0 and n_cards < 1000 then
    delete from public.checklist
     where card_id in (select id from public.card where board_id = b_id)
       and id <> all(seen_cl)
       and id in (select entity_id from public.trello_import_map where entity_type = 'checklist');
    insert into public.trello_missing (entity_type, entity_id)
    select 'card', k.id from public.card k
     where k.board_id = b_id and k.id <> all(seen_c)
       and k.id in (select entity_id from public.trello_import_map where entity_type = 'card')
    on conflict do nothing;
    delete from public.card k using public.trello_missing tm
     where tm.entity_type = 'card' and tm.entity_id = k.id and k.board_id = b_id
       and tm.first_missing_at < now() - interval '30 minutes';
    get diagnostics n_del = row_count;
  end if;
  delete from public.trello_missing where entity_type = 'card' and entity_id = any(seen_c);
  if jsonb_array_length(coalesce(p_board->'lists', '[]')) > 0 then
    insert into public.trello_missing (entity_type, entity_id)
    select 'list', l.id from public.list l
     where l.board_id = b_id and l.id <> all(seen_l)
       and l.id in (select entity_id from public.trello_import_map where entity_type = 'list')
    on conflict do nothing;
    delete from public.list l using public.trello_missing tm
     where tm.entity_type = 'list' and tm.entity_id = l.id and l.board_id = b_id
       and tm.first_missing_at < now() - interval '30 minutes';
  end if;
  delete from public.trello_missing where entity_type = 'list' and entity_id = any(seen_l);

  perform public.trello_resolve_mirrors();

  update public.trello_sync_state
     set board_id = b_id, applied_fetched_at = greatest(coalesce(applied_fetched_at, p_fetched_at), p_fetched_at),
         last_ok_at = now(),
         last_stats = jsonb_build_object('cards', n_cards, 'new', n_new, 'updated', n_upd, 'deleted', n_del)
   where board_trello_id = tid;

  return jsonb_build_object('board_id', b_id, 'cards', n_cards, 'new', n_new, 'updated', n_upd, 'deleted', n_del,
                            'actions_since', coalesce(st.actions_since, '2000-01-01T00:00:00Z'::timestamptz));
end $$;

create or replace function public.trello_sync_actions(p_board text, p_actions jsonb, p_full_run timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a        jsonb;
  d        jsonb;
  t        text;
  who      text;
  actor    uuid;
  cid      uuid;
  bid      uuid;
  xid      uuid;
  act      text;
  dat      jsonb;
  n_com    int := 0;
  n_act    int := 0;
  max_at   timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('trello:' || p_board));
  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);

  for a in select value from jsonb_array_elements(coalesce(p_actions, '[]')) order by value->>'date' loop
    t   := a->>'type';
    d   := coalesce(a->'data', '{}');
    who := a->>'idMemberCreator';
    max_at := greatest(max_at, (a->>'date')::timestamptz);
    if a->'memberCreator' is not null and a->'memberCreator'->>'id' is not null then
      perform public._trello_member_upsert(a->'memberCreator', false);
    end if;
    actor := public._trello_author_of(who);

    if t = 'updateComment' then
      xid := public._tmap(d->'action'->>'id', 'comment');
      if xid is not null then   -- an older batch applied late must not revert newer text
        update public.comment set body = coalesce(d->'action'->>'text', body), edited_at = (a->>'date')::timestamptz
         where id = xid and body is distinct from coalesce(d->'action'->>'text', body)
           and (edited_at is null or edited_at < (a->>'date')::timestamptz);
      end if;
      continue;
    elsif t = 'deleteComment' then
      xid := public._tmap(d->'action'->>'id', 'comment');
      if xid is not null then
        delete from public.comment where id = xid;
        delete from public.trello_import_map where trello_id = d->'action'->>'id' and entity_type = 'comment';
      end if;
      continue;
    end if;

    cid := public._tmap(d->'card'->>'id', 'card');
    if cid is null then continue; end if;
    if t = 'deleteCard' then   -- deleted in Trello (a move to another board is not a delete)
      delete from public.card where id = cid;
      continue;
    end if;
    select board_id into bid from public.card where id = cid;
    if bid is null then continue; end if;

    if t = 'commentCard' then
      xid := public._tmap(a->>'id', 'comment');
      if xid is null then   -- adopt the copy made by the first import (same card + time)
        select c.id into xid from public.comment c
         where c.card_id = cid and c.created_at = (a->>'date')::timestamptz
           and c.id not in (select entity_id from public.trello_import_map where entity_type = 'comment')
         limit 1;
      end if;
      if xid is null or not exists (select 1 from public.comment where id = xid) then
        xid := coalesce(xid, gen_random_uuid());
        insert into public.comment (id, card_id, author_id, body, created_at)
        values (xid, cid, actor, coalesce(d->>'text', ''), (a->>'date')::timestamptz);
        n_com := n_com + 1;
      else
        update public.comment
           set card_id = cid, author_id = actor, body = coalesce(d->>'text', body), created_at = (a->>'date')::timestamptz
         where id = xid
           and (card_id, author_id, body, created_at) is distinct from
               (cid, actor, coalesce(d->>'text', body), (a->>'date')::timestamptz);
      end if;
      -- also marks it seen for the full-run sweep, and remembers which board's history it came from
      insert into public.trello_import_map (trello_id, entity_type, entity_id, imported_at, board_trello_id)
      values (a->>'id', 'comment', xid, now(), coalesce(d->'board'->>'id', p_board))
      on conflict (trello_id, entity_type) do update
        set entity_id = excluded.entity_id, imported_at = now(), board_trello_id = excluded.board_trello_id;
      perform public._trello_note_author('comment', xid, who);
      continue;
    end if;

    -- card creator
    if t in ('createCard', 'copyCard', 'emailCard', 'convertToCardFromCheckItem') then
      update public.card set created_by = actor, created_at = (a->>'date')::timestamptz
       where id = cid and (created_by, created_at) is distinct from (actor, (a->>'date')::timestamptz);
      perform public._trello_note_author('card', cid, who);
    end if;

    if public._tmap(a->>'id', 'activity') is not null then continue; end if;
    act := null;
    dat := '{}';
    case t
      when 'createCard', 'emailCard', 'convertToCardFromCheckItem', 'moveCardToBoard' then
        act := 'card.created'; dat := jsonb_build_object('list_title', coalesce(d->'list'->>'name', d->'listAfter'->>'name'));
      when 'copyCard' then
        act := 'card.cloned'; dat := jsonb_build_object('list_title', d->'list'->>'name');
      when 'updateCard' then
        if d ? 'listAfter' and d ? 'listBefore' then
          act := 'card.moved'; dat := jsonb_build_object('from_title', d->'listBefore'->>'name', 'to_title', d->'listAfter'->>'name');
        elsif d->'old' ? 'closed' then
          act := case when (d->'card'->>'closed')::boolean then 'card.archived' else 'card.restored' end;
        elsif d->'old' ? 'name' then
          act := 'card.renamed'; dat := jsonb_build_object('from', d->'old'->>'name', 'to', d->'card'->>'name');
        elsif d->'old' ? 'desc' then
          act := 'card.description_changed';
        elsif d->'old' ? 'due' then
          if nullif(d->'card'->>'due', '') is null then act := 'card.due_removed';
          elsif nullif(d->'old'->>'due', '') is null then act := 'card.due_set'; dat := jsonb_build_object('due', d->'card'->>'due');
          else act := 'card.due_changed'; dat := jsonb_build_object('due', d->'card'->>'due');
          end if;
        elsif d->'old' ? 'start' then
          if nullif(d->'card'->>'start', '') is null then act := 'card.start_removed';
          else act := 'card.start_set'; dat := jsonb_build_object('start', d->'card'->>'start');
          end if;
        elsif d->'old' ? 'dueComplete' then
          act := case when (d->'card'->>'dueComplete')::boolean then 'card.completed' else 'card.uncompleted' end;
        end if;
      when 'addMemberToCard', 'removeMemberFromCard' then
        act := case when t = 'addMemberToCard' then 'card.member_added' else 'card.member_removed' end;
        dat := jsonb_build_object('user_id', public._trello_profile(d->>'idMember'),
                                  'name', coalesce(d->'member'->>'name', (select full_name from public.trello_member where trello_id = d->>'idMember')));
      when 'addLabelToCard', 'removeLabelFromCard' then
        act := case when t = 'addLabelToCard' then 'card.label_added' else 'card.label_removed' end;
        dat := jsonb_build_object('name', d->'label'->>'name', 'color', coalesce(public._trello_color(d->'label'->>'color'), '#94a3b8'));
      when 'addChecklistToCard', 'removeChecklistFromCard' then
        act := case when t = 'addChecklistToCard' then 'checklist.added' else 'checklist.removed' end;
        dat := jsonb_build_object('name', d->'checklist'->>'name');
      when 'updateCheckItemStateOnCard' then
        act := case when d->'checkItem'->>'state' = 'complete' then 'checklist.item_completed' else 'checklist.item_uncompleted' end;
        dat := jsonb_build_object('text', d->'checkItem'->>'name', 'checklist', d->'checklist'->>'name');
      when 'addAttachmentToCard', 'deleteAttachmentFromCard' then
        act := case when t = 'addAttachmentToCard' then 'attachment.added' else 'attachment.removed' end;
        dat := jsonb_build_object('name', d->'attachment'->>'name');
      when 'updateCustomFieldItem' then
        act := 'custom_field.updated'; dat := jsonb_build_object('name', d->'customField'->>'name');
      else
        null;
    end case;
    if act is null then continue; end if;

    insert into public.activity (board_id, card_id, actor_id, action, data, created_at)
    values (bid, cid, actor, act, dat, (a->>'date')::timestamptz)
    returning id into xid;
    perform public._tmap_put(a->>'id', 'activity', xid);
    perform public._trello_note_author('activity', xid, who);
    n_act := n_act + 1;
  end loop;

  return jsonb_build_object('comments', n_com, 'activity', n_act, 'max_at', max_at);
end $$;

create or replace function public.trello_sync_finish(p_board text, p_max_at timestamptz, p_full_run timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b_id  uuid := public._tmap(p_board, 'board');
  swept int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('trello:' || p_board));
  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);
  update public.trello_sync_state
     set actions_since = greatest(coalesce(actions_since, p_max_at), p_max_at),
         last_full_at  = case when p_full_run is not null then now() else last_full_at end
   where board_trello_id = p_board;

  -- A complete history pass touched every live comment; the rest were deleted in Trello.
  if p_full_run is not null and b_id is not null then
    with gone as (
      delete from public.comment c
       using public.trello_import_map m
       where m.entity_type = 'comment' and m.entity_id = c.id and m.imported_at < p_full_run
         and m.board_trello_id = p_board   -- only comments this board's history owns
         and c.card_id in (select id from public.card where board_id = b_id)
      returning m.trello_id
    )
    delete from public.trello_import_map m using gone
     where m.entity_type = 'comment' and m.trello_id = gone.trello_id;
    get diagnostics swept = row_count;
  end if;
  return jsonb_build_object('swept_comments', swept);
end $$;

-- --------------------------------------------------------------- claim --
-- Trello can lag a moment behind its own webhook: a fetch that started only
-- just after the event may not contain it yet, so allow a short margin.
create or replace function public.trello_sync_claim(p_board text, p_event_at timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into public.trello_sync_state (board_trello_id) values (p_board) on conflict do nothing;
  update public.trello_sync_state
     set fetch_started_at = clock_timestamp()
   where board_trello_id = p_board
     and (fetch_started_at is null or fetch_started_at < p_event_at + interval '5 seconds'
          or fetch_started_at < now() - interval '10 minutes')
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- ------------------------------------------------------------- mirrors --
create or replace function public.trello_resolve_mirrors()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('trello:mirrors'));
  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);
  with recursive direct as (
    select k.id, nullif(m.entity_id, k.id) as target
      from public.card k
      left join public.trello_import_map m
        on m.entity_type = 'card_short'
       and m.trello_id = substring(k.title from 'trello\.com/c/([A-Za-z0-9]+)')
     where k.title ~ '^https?://trello\.com/c/' or k.mirror_of is not null
  ),
  walk (id, target, hops, seen) as (
    select d.id, d.target, 1, array[d.id] from direct d where d.target is not null
    union all
    select w.id, d.target, w.hops + 1, w.seen || w.target
      from walk w join direct d on d.id = w.target
     where d.target is not null and not d.target = any(w.seen) and w.hops < 8
  ),
  final as (
    select d.id,
           (select w.target from walk w where w.id = d.id order by w.hops desc limit 1) as target
      from direct d
  )
  update public.card k set mirror_of = f.target
    from final f
   where f.id = k.id and k.mirror_of is distinct from f.target;
end $$;

-- -------------------------------------------------------------- relink --
create or replace function public._trello_relink(p_member text)
returns void language plpgsql security definer set search_path = public as $$
declare
  who uuid := public._trello_author_of(p_member);
  r   record;
begin
  perform set_config('app.trello_sync', '1', true);
  update public.comment c set author_id = who from public.trello_author ta
   where ta.entity_type = 'comment' and ta.entity_id = c.id and ta.trello_member_id = p_member and c.author_id is distinct from who;
  update public.card c set created_by = who from public.trello_author ta
   where ta.entity_type = 'card' and ta.entity_id = c.id and ta.trello_member_id = p_member and c.created_by is distinct from who;
  update public.activity x set actor_id = who from public.trello_author ta
   where ta.entity_type = 'activity' and ta.entity_id = x.id and ta.trello_member_id = p_member and x.actor_id is distinct from who;
  update public.attachment x set uploaded_by = who from public.trello_author ta
   where ta.entity_type = 'attachment' and ta.entity_id = x.id and ta.trello_member_id = p_member and x.uploaded_by is distinct from who;
  -- replay (not forced): a newer snapshot applied meanwhile wins
  for r in select data, fetched_at from public.trello_raw where key like 'board:%' loop
    perform public.trello_sync_board(r.data, r.fetched_at, false);
  end loop;
end $$;

create or replace function public.trello_link_member(p_trello_id text, p_profile uuid)
returns void language plpgsql security definer set search_path = public as $$
declare prev text;
begin
  if not public.is_admin() then raise exception 'Only admins can link Trello people'; end if;
  for prev in
    update public.trello_member set profile_id = null, updated_at = now()
     where profile_id = p_profile and trello_id <> p_trello_id
    returning trello_id
  loop
    perform public._trello_relink(prev);
  end loop;
  update public.trello_member set profile_id = p_profile, updated_at = now() where trello_id = p_trello_id;
  if not found then raise exception 'Unknown Trello member'; end if;
  perform public._trello_relink(p_trello_id);
end $$;

-- -------------------------------------------------------- delete member --
create or replace function public.admin_delete_member(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  heir  uuid;
  moved int := 0;
  n     int;
begin
  if not public.is_admin() then raise exception 'Only workspace admins can delete users'; end if;
  if p_user = auth.uid() then raise exception 'You cannot delete your own account'; end if;
  if not exists (select 1 from public.profile where id = p_user) then raise exception 'User not found'; end if;

  select id into heir from public.profile
   where role = 'admin' and is_active and id <> p_user
   order by created_at limit 1;
  if heir is null then raise exception 'The workspace needs at least one other active admin first'; end if;

  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);

  -- boards where they are the only admin keep an admin
  insert into public.board_member (board_id, user_id, role)
  select bm.board_id, heir, 'admin' from public.board_member bm
   where bm.user_id = p_user and bm.role = 'admin'
     and not exists (select 1 from public.board_member o where o.board_id = bm.board_id and o.role = 'admin' and o.user_id <> p_user)
  on conflict (board_id, user_id) do update set role = 'admin';

  update public.comment         set author_id   = heir where author_id   = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.card            set created_by  = heir where created_by  = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.activity        set actor_id    = heir where actor_id    = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.attachment      set uploaded_by = heir where uploaded_by = p_user; get diagnostics n = row_count; moved := moved + n;
  update public.board           set created_by  = heir where created_by  = p_user;
  update public.automation_rule set created_by  = heir where created_by  = p_user;
  update public.checklist_item  set assignee_id = null where assignee_id = p_user;
  update public.user_permission set granted_by  = null where granted_by  = p_user;

  delete from auth.users where id = p_user;
  return jsonb_build_object('moved_to', heir, 'items_moved', moved);
end $$;

-- --------------------------------------------------------------- grants --
revoke execute on function public.trello_sync_board(jsonb, timestamptz, boolean), public.trello_sync_actions(text, jsonb, timestamptz),
  public.trello_sync_finish(text, timestamptz, timestamptz), public.trello_sync_claim(text, timestamptz),
  public.trello_resolve_mirrors(), public._trello_relink(text), public.trello_board_tombstone(),
  public.board_member_last_admin_guard() from public, anon, authenticated;
revoke execute on function public.trello_link_member(text, uuid), public.admin_delete_member(uuid) from public, anon;
grant execute on function public.trello_link_member(text, uuid), public.admin_delete_member(uuid) to authenticated;
