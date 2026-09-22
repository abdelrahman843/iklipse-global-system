-- ============================================================================
-- 0007_trello_import.sql
--   Import path for Trello boards. Exposed as a single RPC the n8n workflow
--   calls once per Trello board — the JSONB payload carries the whole tree
--   (lists, cards, labels, checklists, comments, attachments) and this RPC
--   translates every Trello ID to a PM UUID, wiring FKs as it goes.
--
--   Idempotency: the workflow can be re-run. Trello IDs already seen resolve
--   to their previous PM UUIDs (via trello_import_map) and the RPC updates
--   the existing rows in place instead of inserting duplicates.
-- ============================================================================

create table if not exists public.trello_import_map (
  trello_id    text not null,
  entity_type  text not null,
  entity_id    uuid not null,
  imported_at  timestamptz not null default now(),
  primary key (trello_id, entity_type)
);
create index if not exists trello_import_map_entity_idx
  on public.trello_import_map (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- ingest_trello_board(payload, owner_id)
--   payload jsonb — shape produced by the n8n Code node, e.g.
--     {
--       "trello_id": "5f...",
--       "title":     "Board name",
--       "description": "…",
--       "background": "#026aa7",
--       "labels":  [{ "trello_id":"…","name":"Bug","color":"#e0242e","position":"a0" }],
--       "lists":   [{ "trello_id":"…","title":"Todo","position":"a0","is_archived":false }],
--       "cards":   [{
--         "trello_id":       "…",
--         "list_trello_id":  "…",
--         "title":           "…",
--         "description":     "…",
--         "position":        "a0",
--         "due_date":        "2025-01-01T00:00:00Z" | null,
--         "due_completed":   false,
--         "is_archived":     false,
--         "label_trello_ids":["…","…"],
--         "checklists":      [{ "trello_id":"…","name":"…","position":"a0",
--                               "items":[{ "trello_id":"…","text":"…",
--                                           "completed":true,"position":"a0"}] }],
--         "comments":        [{ "body":"…","created_at":"2025-01-01T00:00:00Z" }],
--         "attachments":     [{ "name":"file.png","external_url":"https://…",
--                               "mime_type":"image/png","size":12345 }]
--       }]
--     }
--   owner_id uuid — profile.id that becomes:
--     board.created_by, card.created_by, attachment.uploaded_by, comment.author_id
--     and gets a board_member row with role='admin'.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_trello_board(
  payload  jsonb,
  owner_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_id            uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  b_id             uuid;
  b_trello         text := payload->>'trello_id';
  li               jsonb;
  li_trello        text;
  li_id            uuid;
  lb               jsonb;
  lb_trello        text;
  lb_id            uuid;
  c                jsonb;
  c_trello         text;
  c_id             uuid;
  cl               jsonb;
  cl_id            uuid;
  cl_trello        text;
  ci               jsonb;
  ci_trello        text;
  ci_id            uuid;
  cm               jsonb;
  att              jsonb;
  lbl_tid          text;
  lbl_id           uuid;
  new_board       boolean := false;
  cards_inserted  int := 0;
  cards_updated   int := 0;
  lists_inserted  int := 0;
  labels_inserted int := 0;
begin
  if b_trello is null then
    raise exception 'ingest_trello_board: payload.trello_id is required';
  end if;
  if owner_id is null then
    raise exception 'ingest_trello_board: owner_id is required';
  end if;

  -- ---------------------- Board ------------------------------------------
  select entity_id into b_id
    from trello_import_map where trello_id = b_trello and entity_type = 'board';

  if b_id is null then
    insert into board (workspace_id, title, description, background, created_by)
    values (
      ws_id,
      coalesce(nullif(trim(payload->>'title'), ''), 'Trello import'),
      payload->>'description',
      payload->>'background',
      owner_id
    )
    returning id into b_id;

    insert into trello_import_map (trello_id, entity_type, entity_id)
    values (b_trello, 'board', b_id);

    insert into board_member (board_id, user_id, role)
    values (b_id, owner_id, 'admin')
    on conflict (board_id, user_id) do update set role = 'admin';

    new_board := true;
  else
    update board
       set title       = coalesce(nullif(trim(payload->>'title'), ''), title),
           description = coalesce(payload->>'description', description),
           background  = coalesce(payload->>'background', background)
     where id = b_id;
  end if;

  -- ---------------------- Labels -----------------------------------------
  for lb in select value from jsonb_array_elements(coalesce(payload->'labels', '[]'::jsonb))
  loop
    lb_trello := lb->>'trello_id';
    if lb_trello is null then continue; end if;

    select entity_id into lb_id
      from trello_import_map where trello_id = lb_trello and entity_type = 'label';

    if lb_id is null then
      insert into label (board_id, name, color, position)
      values (b_id,
              coalesce(lb->>'name',''),
              coalesce(lb->>'color', '#94a3b8'),
              coalesce(lb->>'position', '1'))
      returning id into lb_id;
      insert into trello_import_map values (lb_trello, 'label', lb_id, now());
      labels_inserted := labels_inserted + 1;
    else
      update label
         set name     = coalesce(lb->>'name', name),
             color    = coalesce(lb->>'color', color),
             position = coalesce(lb->>'position', position)
       where id = lb_id;
    end if;
  end loop;

  -- ---------------------- Lists ------------------------------------------
  for li in select value from jsonb_array_elements(coalesce(payload->'lists', '[]'::jsonb))
  loop
    li_trello := li->>'trello_id';
    if li_trello is null then continue; end if;

    select entity_id into li_id
      from trello_import_map where trello_id = li_trello and entity_type = 'list';

    if li_id is null then
      insert into list (board_id, title, position, is_archived)
      values (b_id,
              coalesce(nullif(trim(li->>'title'), ''), 'Untitled list'),
              coalesce(li->>'position', '1'),
              coalesce((li->>'is_archived')::boolean, false))
      returning id into li_id;
      insert into trello_import_map values (li_trello, 'list', li_id, now());
      lists_inserted := lists_inserted + 1;
    else
      update list
         set title       = coalesce(nullif(trim(li->>'title'), ''), title),
             position    = coalesce(li->>'position', position),
             is_archived = coalesce((li->>'is_archived')::boolean, is_archived)
       where id = li_id;
    end if;
  end loop;

  -- ---------------------- Cards + satellites -----------------------------
  for c in select value from jsonb_array_elements(coalesce(payload->'cards', '[]'::jsonb))
  loop
    c_trello := c->>'trello_id';
    if c_trello is null then continue; end if;

    -- Resolve target list.
    select entity_id into li_id
      from trello_import_map
      where trello_id = c->>'list_trello_id' and entity_type = 'list';
    if li_id is null then
      -- Card points at a list we didn't import — skip silently.
      continue;
    end if;

    select entity_id into c_id
      from trello_import_map where trello_id = c_trello and entity_type = 'card';

    if c_id is null then
      insert into card (
        board_id, list_id, title, description, position,
        due_date, due_completed, is_archived, created_by
      ) values (
        b_id, li_id,
        coalesce(nullif(trim(c->>'title'),''),'Untitled'),
        c->>'description',
        coalesce(c->>'position','1'),
        nullif(c->>'due_date','')::timestamptz,
        coalesce((c->>'due_completed')::boolean, false),
        coalesce((c->>'is_archived')::boolean, false),
        owner_id
      )
      returning id into c_id;
      insert into trello_import_map values (c_trello, 'card', c_id, now());
      cards_inserted := cards_inserted + 1;
    else
      update card
         set list_id       = li_id,
             title         = coalesce(nullif(trim(c->>'title'),''), title),
             description   = c->>'description',
             position      = coalesce(c->>'position', position),
             due_date      = nullif(c->>'due_date','')::timestamptz,
             due_completed = coalesce((c->>'due_completed')::boolean, due_completed),
             is_archived   = coalesce((c->>'is_archived')::boolean, is_archived)
       where id = c_id;
      cards_updated := cards_updated + 1;
    end if;

    -- Card labels: replace-all, then insert current set.
    delete from card_label where card_id = c_id;
    for lbl_tid in select value::text from jsonb_array_elements_text(coalesce(c->'label_trello_ids', '[]'::jsonb))
    loop
      select entity_id into lbl_id
        from trello_import_map where trello_id = lbl_tid and entity_type = 'label';
      if lbl_id is not null then
        insert into card_label (card_id, label_id) values (c_id, lbl_id)
          on conflict do nothing;
      end if;
    end loop;

    -- Checklists: wipe + re-insert. Item ordering preserved by payload order.
    delete from checklist where card_id = c_id;
    for cl in select value from jsonb_array_elements(coalesce(c->'checklists','[]'::jsonb))
    loop
      cl_trello := cl->>'trello_id';
      insert into checklist (card_id, name, position)
      values (c_id,
              coalesce(nullif(trim(cl->>'name'),''), 'Checklist'),
              coalesce(cl->>'position','1'))
      returning id into cl_id;
      if cl_trello is not null then
        insert into trello_import_map values (cl_trello, 'checklist', cl_id, now())
          on conflict (trello_id, entity_type) do update set entity_id = cl_id;
      end if;

      for ci in select value from jsonb_array_elements(coalesce(cl->'items','[]'::jsonb))
      loop
        ci_trello := ci->>'trello_id';
        insert into checklist_item (checklist_id, text, completed, position)
        values (cl_id,
                coalesce(ci->>'text', ''),
                coalesce((ci->>'completed')::boolean, false),
                coalesce(ci->>'position','1'))
        returning id into ci_id;
        if ci_trello is not null then
          insert into trello_import_map values (ci_trello, 'checklist_item', ci_id, now())
            on conflict (trello_id, entity_type) do update set entity_id = ci_id;
        end if;
      end loop;
    end loop;

    -- Comments: wipe + re-insert (author = owner, body prefixed with author name).
    delete from comment where card_id = c_id;
    for cm in select value from jsonb_array_elements(coalesce(c->'comments','[]'::jsonb))
    loop
      insert into comment (card_id, author_id, body, created_at)
      values (c_id, owner_id,
              case
                when (cm->>'author_name') is not null and length(cm->>'author_name') > 0
                  then '**' || (cm->>'author_name') || ' (from Trello)** — ' || coalesce(cm->>'body','')
                else coalesce(cm->>'body','')
              end,
              coalesce(nullif(cm->>'created_at','')::timestamptz, now()));
    end loop;

    -- Attachments: wipe + re-insert as external_url.
    delete from attachment where card_id = c_id;
    for att in select value from jsonb_array_elements(coalesce(c->'attachments','[]'::jsonb))
    loop
      if (att->>'external_url') is null then continue; end if;
      insert into attachment (card_id, name, mime_type, size, external_url, uploaded_by)
      values (c_id,
              coalesce(nullif(trim(att->>'name'),''), 'attachment'),
              nullif(att->>'mime_type',''),
              nullif(att->>'size','')::bigint,
              att->>'external_url',
              owner_id);
    end loop;
  end loop;

  return jsonb_build_object(
    'board_id',        b_id,
    'new_board',       new_board,
    'lists_inserted',  lists_inserted,
    'labels_inserted', labels_inserted,
    'cards_inserted',  cards_inserted,
    'cards_updated',   cards_updated
  );
end $$;

grant execute on function public.ingest_trello_board(jsonb, uuid) to service_role;
