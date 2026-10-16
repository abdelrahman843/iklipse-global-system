-- 0074_audit_filters.sql
--   The activity log, easier to read and to narrow down (admins read it).
--   1. Names, not ids: a change like "resolved by fb7625b8-..." now comes with
--      the person's name. Each row of a page carries "names": every id in what
--      changed, in what it's about (ref) and the row's own id, mapped to the
--      person, board, list, card, label, checklist, project, client, delivery,
--      file, custom field, automation, comment, note, link, alert, brief or
--      invoice it points to. Ids of things that are
--      gone are left out (the page shows them as deleted). Only names and
--      titles are read, nothing else from those rows.
--   2. More filters: by what was done (create, edit, delete), by what it is
--      (card, comment...) and by a time window (from, to). The list of kinds
--      for the filter comes from audit_log_entities().
--   3. Indexes so those filters stay quick.
--   The trigger that writes the log (_audit) is unchanged.

-- ------------------------------------------------------------- 1. ids --
-- Every uuid in a value: strings at any depth (objects, arrays, plain text).
create or replace function public._audit_uuids(v jsonb)
returns setof text language sql immutable as $$
  select distinct x.j #>> '{}'
    from jsonb_path_query(v, 'strict $.** ? (@.type() == "string")') as x(j)
   where x.j #>> '{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;
revoke all on function public._audit_uuids(jsonb) from public, anon, authenticated;

-- --------------------------------------------------------- 2. the page --
-- The old reader (5 arguments) goes, so the call by name picks the new one.
drop function if exists public.audit_log_page(timestamptz, text, uuid, text, int);

-- Admins: a page of the log, newest first. Before: the last row's time of the
-- page before; area / person / words / action / kind / from / to narrow it.
-- Each row comes with names: { "<uuid>": "<name or title>" } for the ids it uses.
create or replace function public.audit_log_page(
  p_before timestamptz default null,
  p_area   text default null,
  p_actor  uuid default null,
  p_q      text default null,
  p_limit  int default 100,
  p_action text default null,
  p_entity text default null,
  p_from   timestamptz default null,
  p_to     timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q      text := nullif(btrim(coalesce(p_q, '')), '');
  v_area   text := nullif(btrim(coalesce(p_area, '')), '');
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
  v_entity text := nullif(btrim(coalesce(p_entity, '')), '');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    with page as (
      select l.id, l.at, l.actor_id, coalesce(pr.display_name, l.actor_name) as actor_name, pr.avatar_url as actor_avatar,
             l.action, l.area, l.entity, l.row_id, l.label, l.ref, l.changes
        from public.audit_log l
        left join public.profile pr on pr.id = l.actor_id
       where (p_before is null or l.at < p_before)
         and (p_from is null or l.at >= p_from)
         and (p_to is null or l.at < p_to)
         and (v_area is null or l.area = v_area)
         and (p_actor is null or l.actor_id = p_actor)
         and (v_action is null or l.action = v_action)
         and (v_entity is null or l.entity = v_entity)
         and (v_q is null or l.label ilike '%' || v_q || '%' or l.ref::text ilike '%' || v_q || '%'
              or l.actor_name ilike '%' || v_q || '%' or l.entity ilike '%' || v_q || '%')
       order by l.at desc, l.id desc
       limit least(greatest(coalesce(p_limit, 100), 1), 300)
    ),
    -- The ids each row uses: in what changed, in ref, and its own id (a joined
    -- id like "<board>:<card>" counts each part).
    used as (
      select distinct p.id, u.s
        from page p
        cross join lateral (
          select x.s from public._audit_uuids(p.changes) as x(s)
          union all
          select x.s from public._audit_uuids(p.ref) as x(s)
          union all
          select x.s from public._audit_uuids(to_jsonb(string_to_array(p.row_id, ':'))) as x(s)
        ) u
    ),
    -- Each id of the page once.
    ids as (
      select distinct u.s::uuid as id from used u
    ),
    -- Looked up once, by primary key; the first table that has it wins.
    known as (
      select distinct on (f.id) f.id::text as s, f.name
        from (
          select 1 as o, t.id, t.display_name as name from public.profile t where t.id in (select id from ids)
          union all select 2, t.id, t.title from public.board t where t.id in (select id from ids)
          union all select 3, t.id, t.title from public.list t where t.id in (select id from ids)
          union all select 4, t.id, t.title from public.card t where t.id in (select id from ids)
          union all select 5, t.id, t.name from public.label t where t.id in (select id from ids)
          union all select 6, t.id, t.name from public.checklist t where t.id in (select id from ids)
          union all select 7, t.id, t.title from public.project t where t.id in (select id from ids)
          union all select 8, t.id, t.name from public.client t where t.id in (select id from ids)
          union all select 9, t.id, t.title from public.project_delivery t where t.id in (select id from ids)
          union all select 10, t.id, t.title from public.delivery_folder t where t.id in (select id from ids)
          union all select 11, t.id, t.name from public.delivery_item t where t.id in (select id from ids)
          union all select 12, t.id, t.name from public.attachment t where t.id in (select id from ids)
          union all select 13, t.id, t.name from public.custom_field_def t where t.id in (select id from ids)
          union all select 14, t.id, t.name from public.automation_rule t where t.id in (select id from ids)
          union all select 15, t.id, left(t.body, 80) from public.comment t where t.id in (select id from ids)
          union all select 16, t.id, left(t.text, 80) from public.checklist_item t where t.id in (select id from ids)
          union all select 17, t.id, left(t.body, 80) from public.delivery_comment t where t.id in (select id from ids)
          union all select 18, t.id, 'Round ' || t.number from public.delivery_round t where t.id in (select id from ids)
          union all select 19, t.id, coalesce(t.label, 'Link') from public.delivery_link t where t.id in (select id from ids)
          union all select 20, t.id, left(t.body, 80) from public.project_note t where t.id in (select id from ids)
          union all select 21, t.id, t.name from public.project_file t where t.id in (select id from ids)
          union all select 22, t.id, coalesce('No. ' || t.number, 'Invoice') from public.project_invoice t where t.id in (select id from ids)
          union all select 23, t.id, t.title from public.watch_alert t where t.id in (select id from ids)
          union all select 24, t.id, coalesce(t.label, 'Brief') from public.brief_link t where t.id in (select id from ids)
          union all select 25, t.id, coalesce(t.label, 'Share link') from public.wb_share_link t where t.id in (select id from ids)
          union all select 26, t.id, left(t.body, 80) from public.wb_comment t where t.id in (select id from ids)
          union all select 27, t.id, coalesce(t.subject, 'Invoice') from public.invoice t where t.id in (select id from ids)
        ) f
       order by f.id, f.o
    ),
    -- Per row, only the ids it uses.
    named as (
      select u.id, jsonb_object_agg(f.s, f.name) as names
        from used u
        join known f on f.s = u.s
       group by u.id
    )
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'at', p.at, 'actor_id', p.actor_id, 'actor_name', p.actor_name, 'actor_avatar', p.actor_avatar,
             'action', p.action, 'area', p.area, 'entity', p.entity, 'row_id', p.row_id, 'label', p.label,
             'ref', p.ref, 'changes', p.changes, 'names', coalesce(n.names, '{}'::jsonb))
           order by p.at desc, p.id desc)
      from page p
      left join named n on n.id = p.id), '[]'::jsonb);
end $$;
revoke all on function public.audit_log_page(timestamptz, text, uuid, text, int, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.audit_log_page(timestamptz, text, uuid, text, int, text, text, timestamptz, timestamptz) to authenticated;

-- ------------------------------------------------------- 3. the kinds --
-- Admins: each area and kind in the log with how many rows, for the filters.
create or replace function public.audit_log_entities()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('area', x.area, 'entity', x.entity, 'n', x.n) order by x.area, x.entity)
      from (select l.area, l.entity, count(*)::int as n
              from public.audit_log l
             group by l.area, l.entity) x), '[]'::jsonb);
end $$;
revoke all on function public.audit_log_entities() from public, anon;
grant execute on function public.audit_log_entities() to authenticated;

-- ------------------------------------------------------------ 4. speed --
-- Each row its own moment (not the transaction's), so rows written together
-- keep their order and a page never ends in the middle of a same-time group.
alter table public.audit_log alter column at set default clock_timestamp();
create index if not exists audit_log_action_idx on public.audit_log (action, at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity, at desc);

notify pgrst, 'reload schema';
