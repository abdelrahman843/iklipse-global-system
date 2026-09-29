-- ============================================================================
-- 0029_access_and_drift.sql
--   Remaining review items:
--   - Deactivated accounts keep a valid session until it expires. Their data
--     access now stops at once: they can no longer read the people directory,
--     edit comments or subscribe (board data already required is_active).
--   - Guests only see people who share a board with them.
--   - AI: images must be inline data (no URLs for OpenAI to fetch) and the
--     whole workspace is capped per hour, on top of the per-person cap.
--   - Denormalised ids stay right when a card or checklist moves: history
--     follows its card to the new board, checklist items follow their list.
--   - comment_reaction had REPLICA IDENTITY FULL, so realtime delete events
--     leaked reaction rows from every board. It gets its own id; deletes now
--     carry only that id.
-- ============================================================================

create or replace function public.am_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profile where id = auth.uid() and is_active);
$$;
revoke all on function public.am_active() from public, anon;
grant execute on function public.am_active() to authenticated;

-- people directory ---------------------------------------------------------
drop policy if exists profile_select_authenticated on public.profile;
create policy profile_select_authenticated on public.profile for select to authenticated
  using (
    id = auth.uid()
    or (public.am_active() and (
         public.my_workspace_role() in ('admin', 'member')
      or id in (select bm.user_id from public.board_member bm where bm.board_id in (select public.visible_board_ids()))
    ))
  );

-- comments / subscriptions need an active account ------------------------------
drop policy if exists comment_update_self on public.comment;
create policy comment_update_self on public.comment for update to authenticated
  using (author_id = auth.uid() and public.am_active() and card_id in (select public.visible_card_ids()))
  with check (author_id = auth.uid() and exists (select 1 from public.card c where c.id = card_id and public.can_comment_board(c.board_id)));

drop policy if exists subscription_all on public.subscription;
create policy subscription_all on public.subscription for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.am_active() and (
       (entity_type = 'board' and entity_id in (select public.visible_board_ids()))
    or (entity_type = 'card'  and entity_id in (select public.visible_card_ids()))
    or (entity_type = 'list'  and exists (select 1 from public.list l where l.id = entity_id
                                          and l.board_id in (select public.visible_board_ids())))));

-- AI guards (run before ai_start does any work) ---------------------------------
create or replace function public.ai_request_guard()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.ai_request where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'The workspace reached its AI limit for this hour (300 requests). Try again later.';
  end if;
  return new;
end $$;
drop trigger if exists ai_request_guard on public.ai_request;
create trigger ai_request_guard before insert on public.ai_request for each row execute function public.ai_request_guard();
revoke execute on function public.ai_request_guard() from public, anon, authenticated;

-- denormalised ids follow moves -------------------------------------------------
create or replace function public.trg_card_board_moved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.board_id is distinct from old.board_id then
    update public.card_label  set board_id = new.board_id where card_id = new.id;
    update public.card_member set board_id = new.board_id where card_id = new.id;
    update public.activity    set board_id = new.board_id where card_id = new.id;
  end if;
  return new;
end $$;

create or replace function public.trg_checklist_moved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.card_id is distinct from old.card_id then
    update public.checklist_item set card_id = new.card_id where checklist_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists checklist_moved on public.checklist;
create trigger checklist_moved after update of card_id on public.checklist for each row execute function public.trg_checklist_moved();
revoke execute on function public.trg_card_board_moved(), public.trg_checklist_moved() from public, anon, authenticated;

-- reactions: own id, deletes carry only that ------------------------------------
alter table public.comment_reaction add column if not exists id uuid not null default gen_random_uuid();
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.comment_reaction'::regclass and contype = 'p'
               and pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') then
    execute (select format('alter table public.comment_reaction drop constraint %I', conname)
               from pg_constraint where conrelid = 'public.comment_reaction'::regclass and contype = 'p');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comment_reaction'::regclass and contype = 'p') then
    alter table public.comment_reaction add primary key (id);
  end if;
end $$;
create unique index if not exists comment_reaction_one_per_user
  on public.comment_reaction (comment_id, user_id, emoji);
alter table public.comment_reaction replica identity default;
