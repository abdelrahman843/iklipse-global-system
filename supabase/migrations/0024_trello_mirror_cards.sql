-- ============================================================================
-- 0024_trello_mirror_cards.sql
--   Trello "mirror" cards are cards whose title is just a link to another
--   card (https://trello.com/c/<shortLink>); Trello renders the linked card in
--   their place. 493 of 496 cards on "Clients - Active Work" are mirrors.
--   card.mirror_of points at the real card (followed through mirror chains),
--   so the board shows and opens the original. The sync now records each
--   card's shortLink and re-resolves mirrors after every board snapshot.
-- ============================================================================

alter table public.card add column if not exists mirror_of uuid references public.card(id) on delete set null;
create index if not exists card_mirror_of_idx on public.card(mirror_of) where mirror_of is not null;

create or replace function public.trello_resolve_mirrors()
returns void language plpgsql security definer set search_path = public as $$
declare i int;
begin
  perform set_config('app.trello_sync', '1', true);
  perform set_config('app.bulk_activity', '1', true);
  with want as (
    select k.id, m.entity_id as target
      from public.card k
      left join public.trello_import_map m
        on m.entity_type = 'card_short'
       and m.trello_id = substring(k.title from 'trello\.com/c/([A-Za-z0-9]+)')
     where k.title ~ '^https?://trello\.com/c/' or k.mirror_of is not null
  )
  update public.card k set mirror_of = nullif(w.target, k.id)
    from want w
   where w.id = k.id and k.mirror_of is distinct from nullif(w.target, k.id);
  -- a mirror of a mirror points at the real card
  for i in 1..3 loop
    update public.card k set mirror_of = t.mirror_of
      from public.card t
     where t.id = k.mirror_of and t.mirror_of is not null and t.mirror_of <> k.id;
    exit when not found;
  end loop;
end $$;

revoke all on function public.trello_resolve_mirrors() from public, anon, authenticated;

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
  begin
    delete from public.board_member bm
     where bm.board_id = b_id
       and bm.user_id in (select profile_id from public.trello_member where profile_id is not null)
       and bm.user_id not in (
         select tm.profile_id
           from jsonb_array_elements(coalesce(p_board->'memberships', '[]')) ms
           join public.trello_member tm on tm.trello_id = ms->>'idMember'
          where tm.profile_id is not null and not coalesce((ms->>'deactivated')::boolean, false));
  exception when others then null; -- last-admin guard: keep the row
  end;

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
  delete from public.custom_field_def
   where board_id = b_id and id <> all(seen_f)
     and id in (select entity_id from public.trello_import_map where entity_type = 'custom_field');

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
    delete from public.card_label where card_id = cid and label_id <> all(want);
    insert into public.card_label (card_id, label_id) select cid, unnest(want) on conflict do nothing;

    -- members on the card (unlinked people remembered for later)
    want := array(select tm.profile_id from jsonb_array_elements_text(coalesce(x->'idMembers', '[]')) v
                    join public.trello_member tm on tm.trello_id = v where tm.profile_id is not null);
    delete from public.card_member where card_id = cid and user_id <> all(want);
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
       and (a.id in (select entity_id from public.trello_import_map where entity_type = 'attachment')
            or a.external_url like 'https://trello.com/%');

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
        when y->'value' ? 'number' then to_jsonb((y->'value'->>'number')::numeric)
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
    if cid is null then continue; end if;
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
    delete from public.checklist_item where checklist_id = clid and id <> all(seen);
  end loop;

  -- prune what Trello no longer has ------------------------------------------
  -- Guard: never prune from an empty or possibly truncated snapshot.
  if n_cards > 0 and n_cards < 1000 then
    delete from public.checklist
     where card_id in (select id from public.card where board_id = b_id)
       and id <> all(seen_cl)
       and id in (select entity_id from public.trello_import_map where entity_type = 'checklist');
    delete from public.card
     where board_id = b_id and id <> all(seen_c)
       and id in (select entity_id from public.trello_import_map where entity_type = 'card');
    get diagnostics n_del = row_count;
  end if;
  if jsonb_array_length(coalesce(p_board->'lists', '[]')) > 0 then
    delete from public.list
     where board_id = b_id and id <> all(seen_l)
       and id in (select entity_id from public.trello_import_map where entity_type = 'list');
  end if;

  perform public.trello_resolve_mirrors();

  update public.trello_sync_state
     set board_id = b_id, applied_fetched_at = greatest(coalesce(applied_fetched_at, p_fetched_at), p_fetched_at),
         last_ok_at = now(),
         last_stats = jsonb_build_object('cards', n_cards, 'new', n_new, 'updated', n_upd, 'deleted', n_del)
   where board_trello_id = tid;

  return jsonb_build_object('board_id', b_id, 'cards', n_cards, 'new', n_new, 'updated', n_upd, 'deleted', n_del,
                            'actions_since', coalesce(st.actions_since, '2000-01-01T00:00:00Z'::timestamptz));
end $$;
