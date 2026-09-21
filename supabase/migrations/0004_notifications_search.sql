-- ============================================================================
-- 0004_notifications_search.sql
--   Notification fan-out (via triggers) + search RPC.
-- ============================================================================

-- ============================================================ Helpers ====
-- Fan a notification out to a set of users, deduped, skipping the actor.
create or replace function public.notify_users(
  p_user_ids uuid[],
  p_board uuid,
  p_card  uuid,
  p_kind  text,
  p_data  jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if p_user_ids is null or cardinality(p_user_ids) = 0 then return; end if;
  insert into public.notification (user_id, board_id, card_id, kind, data)
  select distinct u, p_board, p_card, p_kind, coalesce(p_data,'{}'::jsonb)
    from unnest(p_user_ids) as u
   where u is not distinct from u
     and u is distinct from v_actor;
end $$;

-- Return the union of users watching a card or its board (excluding actor).
create or replace function public.card_audience(p_card uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  with c as (select id, board_id from public.card where id = p_card),
       watchers as (
         select s.user_id from public.subscription s, c
          where (s.entity_type = 'card'  and s.entity_id = c.id)
             or (s.entity_type = 'board' and s.entity_id = c.board_id)
       ),
       members as (
         select user_id from public.card_member cm, c where cm.card_id = c.id
       )
  select user_id from watchers
  union
  select user_id from members;
$$;

-- =================================================== Comment fan-out ====
create or replace function public.on_comment_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_board uuid;
  v_mention_names text[];
  v_mention_ids uuid[];
  v_aud uuid[];
begin
  select board_id into v_board from public.card where id = new.card_id;

  -- @mentions — collect every @username occurrence from the comment body.
  select array(select distinct m[1]
                 from regexp_matches(coalesce(new.body, ''), '@([A-Za-z0-9._-]{2,32})', 'g') as m)
    into v_mention_names;

  if v_mention_names is not null and cardinality(v_mention_names) > 0 then
    select array(select id from public.profile
                  where lower(username) = any(select lower(x) from unnest(v_mention_names) x))
      into v_mention_ids;

    perform public.notify_users(
      v_mention_ids, v_board, new.card_id, 'mention',
      jsonb_build_object('comment_id', new.id)
    );
  end if;

  -- Everyone else watching / assigned still hears about the new comment.
  select array(select audience from public.card_audience(new.card_id) audience
                where audience <> all(coalesce(v_mention_ids, array[]::uuid[])))
    into v_aud;

  perform public.notify_users(
    v_aud, v_board, new.card_id, 'comment',
    jsonb_build_object('comment_id', new.id)
  );

  -- Comment authors auto-subscribe to their own card.
  insert into public.subscription(user_id, entity_type, entity_id)
  values (new.author_id, 'card', new.card_id)
  on conflict do nothing;

  return new;
end $$;

drop trigger if exists comment_notify on public.comment;
create trigger comment_notify after insert on public.comment
  for each row execute function public.on_comment_insert();

-- =================================================== Assignment fan-out =
create or replace function public.on_card_member_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_board uuid;
begin
  select board_id into v_board from public.card where id = new.card_id;
  perform public.notify_users(
    array[new.user_id], v_board, new.card_id, 'assigned',
    jsonb_build_object()
  );
  -- Auto-subscribe assignee.
  insert into public.subscription(user_id, entity_type, entity_id)
  values (new.user_id, 'card', new.card_id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists card_member_notify on public.card_member;
create trigger card_member_notify after insert on public.card_member
  for each row execute function public.on_card_member_insert();

-- =================================================== Due-date change ====
create or replace function public.on_card_due_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_aud uuid[];
begin
  if new.due_date is distinct from old.due_date then
    select array(select audience from public.card_audience(new.id) audience) into v_aud;
    perform public.notify_users(
      v_aud, new.board_id, new.id, 'due_changed',
      jsonb_build_object('due', new.due_date)
    );
  end if;
  if new.due_completed is distinct from old.due_completed and new.due_completed then
    select array(select audience from public.card_audience(new.id) audience) into v_aud;
    perform public.notify_users(
      v_aud, new.board_id, new.id, 'due_completed', '{}'::jsonb
    );
  end if;
  return new;
end $$;

drop trigger if exists card_due_notify on public.card;
create trigger card_due_notify after update on public.card
  for each row execute function public.on_card_due_changed();

-- =================================================== Board invitation ==
create or replace function public.on_board_member_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_users(
    array[new.user_id], new.board_id, null, 'board_invited',
    jsonb_build_object('role', new.role)
  );
  insert into public.subscription(user_id, entity_type, entity_id)
  values (new.user_id, 'board', new.board_id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists board_member_notify on public.board_member;
create trigger board_member_notify after insert on public.board_member
  for each row execute function public.on_board_member_insert();

-- ============================================================ Watch API =
create or replace function public.set_subscription(
  p_entity_type text,
  p_entity_id uuid,
  p_watch boolean
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_entity_type not in ('board','list','card') then raise exception 'bad entity_type'; end if;
  if p_watch then
    insert into public.subscription(user_id, entity_type, entity_id)
    values (auth.uid(), p_entity_type, p_entity_id) on conflict do nothing;
  else
    delete from public.subscription
      where user_id = auth.uid() and entity_type = p_entity_type and entity_id = p_entity_id;
  end if;
  return p_watch;
end $$;

-- ============================================================ Search =====
-- RLS makes sure the results are only cards the caller can actually see.
create or replace function public.search_cards(p_query text, p_limit int default 50)
returns table (
  card_id uuid,
  board_id uuid,
  board_title text,
  list_id uuid,
  list_title text,
  title text,
  description text,
  due_date timestamptz,
  rank real
) language sql stable security invoker set search_path = public as $$
  select c.id, c.board_id, b.title, c.list_id, l.title,
         c.title, c.description, c.due_date,
         ts_rank(c.search, plainto_tsquery('simple', p_query)) as rank
    from public.card c
    join public.board b on b.id = c.board_id
    join public.list  l on l.id = c.list_id
   where c.is_archived = false
     and (p_query is null or p_query = ''
          or c.search @@ plainto_tsquery('simple', p_query))
   order by rank desc, c.updated_at desc
   limit least(coalesce(p_limit, 50), 200);
$$;

-- Return the caller's assigned, non-archived cards.
create or replace function public.my_cards()
returns table (
  card_id uuid,
  board_id uuid,
  board_title text,
  list_id uuid,
  list_title text,
  title text,
  due_date timestamptz,
  due_completed boolean
) language sql stable security invoker set search_path = public as $$
  select c.id, c.board_id, b.title, c.list_id, l.title, c.title, c.due_date, c.due_completed
    from public.card c
    join public.board b on b.id = c.board_id
    join public.list  l on l.id = c.list_id
    join public.card_member cm on cm.card_id = c.id
   where cm.user_id = auth.uid() and c.is_archived = false
   order by
     case when c.due_date is null then 1 else 0 end,
     c.due_date asc,
     c.updated_at desc;
$$;

-- ============================================================ Realtime ==
-- Enable Realtime for the tables the client subscribes to.
do $$ begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if not found then return; end if;

  begin alter publication supabase_realtime add table public.list;          exception when others then null; end;
  begin alter publication supabase_realtime add table public.card;          exception when others then null; end;
  begin alter publication supabase_realtime add table public.label;         exception when others then null; end;
  begin alter publication supabase_realtime add table public.card_label;    exception when others then null; end;
  begin alter publication supabase_realtime add table public.card_member;   exception when others then null; end;
  begin alter publication supabase_realtime add table public.board_member;  exception when others then null; end;
  begin alter publication supabase_realtime add table public.comment;       exception when others then null; end;
  begin alter publication supabase_realtime add table public.notification;  exception when others then null; end;
  begin alter publication supabase_realtime add table public.activity;      exception when others then null; end;
end $$;
