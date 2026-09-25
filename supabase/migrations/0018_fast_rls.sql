-- =============================================================================
-- 0018 - Fast RLS.
--
-- The old policies called board_access(board_id) once PER ROW, and child
-- tables (card_label, comment, checklist...) did an EXISTS on card, which
-- re-ran card's own RLS for every row as well. Loading one board as a normal
-- member took ~2s (card_label alone ~1.7s), so every add/edit/delete that
-- refetched the board felt slow.
--
-- Now each query computes "which boards / cards can I see or edit" ONCE:
-- the set-returning helpers below are uncorrelated, so Postgres runs them a
-- single time per statement and hashes the result. Same rules as 0013,
-- just evaluated once instead of per row.
-- =============================================================================

-- ------------------------------------------------------------ helpers --
create or replace function public.visible_board_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  with me as (select public.my_workspace_role() as r)
  select b.id from public.board b, me
   where me.r = 'admin'
  union
  select bm.board_id from public.board_member bm, me
   where me.r is not null and bm.user_id = auth.uid()
  union
  select b.id from public.board b, me
   where me.r in ('member') and b.visibility = 'workspace';
$$;

create or replace function public.editable_board_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  with me as (select public.my_workspace_role() as r)
  select b.id from public.board b, me
   where me.r = 'admin'
  union
  select bm.board_id from public.board_member bm, me
   where me.r is not null and bm.user_id = auth.uid() and bm.role in ('admin', 'normal');
$$;

create or replace function public.visible_card_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from public.card c where c.board_id in (select public.visible_board_ids());
$$;

create or replace function public.editable_card_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from public.card c where c.board_id in (select public.editable_board_ids());
$$;

grant execute on function public.visible_board_ids(), public.editable_board_ids(),
  public.visible_card_ids(), public.editable_card_ids() to authenticated;

-- Sanity: the set helpers must agree with board_access() (0013). Guests and
-- observers see only boards they're on; "viewer" = workspace-visible board a
-- member hasn't joined; admins see everything.

-- ------------------------------------------------------ board-level tables --
drop policy if exists board_read on public.board;
create policy board_read on public.board for select to authenticated
  using (id in (select public.visible_board_ids()));

drop policy if exists board_member_read on public.board_member;
create policy board_member_read on public.board_member for select to authenticated
  using (board_id in (select public.visible_board_ids()));

drop policy if exists list_read on public.list;
create policy list_read on public.list for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists list_write on public.list;
create policy list_write on public.list for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));

drop policy if exists card_read on public.card;
create policy card_read on public.card for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists card_write on public.card;
create policy card_write on public.card for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));

drop policy if exists label_read on public.label;
create policy label_read on public.label for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists label_write on public.label;
create policy label_write on public.label for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));

drop policy if exists activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated
  using (board_id in (select public.visible_board_ids()));

drop policy if exists custom_field_def_read on public.custom_field_def;
create policy custom_field_def_read on public.custom_field_def for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists custom_field_def_write on public.custom_field_def;
create policy custom_field_def_write on public.custom_field_def for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));

drop policy if exists rule_read on public.automation_rule;
create policy rule_read on public.automation_rule for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists rule_write on public.automation_rule;
create policy rule_write on public.automation_rule for all to authenticated
  using (board_id in (select public.editable_board_ids()))
  with check (board_id in (select public.editable_board_ids()));

drop policy if exists run_read on public.automation_run;
create policy run_read on public.automation_run for select to authenticated
  using (board_id in (select public.visible_board_ids()));

-- card_label / card_member carry board_id since 0016.
drop policy if exists card_label_read on public.card_label;
create policy card_label_read on public.card_label for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists card_label_write on public.card_label;
create policy card_label_write on public.card_label for all to authenticated
  using (card_id in (select public.editable_card_ids()))
  with check (card_id in (select public.editable_card_ids()));

drop policy if exists card_member_read on public.card_member;
create policy card_member_read on public.card_member for select to authenticated
  using (board_id in (select public.visible_board_ids()));
drop policy if exists card_member_write on public.card_member;
create policy card_member_write on public.card_member for all to authenticated
  using (card_id in (select public.editable_card_ids()))
  with check (card_id in (select public.editable_card_ids()));

-- -------------------------------------------------------- card-level tables --
drop policy if exists checklist_read on public.checklist;
create policy checklist_read on public.checklist for select to authenticated
  using (card_id in (select public.visible_card_ids()));
drop policy if exists checklist_write on public.checklist;
create policy checklist_write on public.checklist for all to authenticated
  using (card_id in (select public.editable_card_ids()))
  with check (card_id in (select public.editable_card_ids()));

-- checklist_item.card_id is trigger-filled (0016); the write check still goes
-- through the parent checklist so an item can't point at a foreign card.
drop policy if exists checklist_item_read on public.checklist_item;
create policy checklist_item_read on public.checklist_item for select to authenticated
  using (card_id in (select public.visible_card_ids()));
drop policy if exists checklist_item_write on public.checklist_item;
create policy checklist_item_write on public.checklist_item for all to authenticated
  using (checklist_id in (select cl.id from public.checklist cl where cl.card_id in (select public.editable_card_ids())))
  with check (checklist_id in (select cl.id from public.checklist cl where cl.card_id in (select public.editable_card_ids())));

drop policy if exists attachment_read on public.attachment;
create policy attachment_read on public.attachment for select to authenticated
  using (card_id in (select public.visible_card_ids()));
drop policy if exists attachment_write on public.attachment;
create policy attachment_write on public.attachment for all to authenticated
  using (card_id in (select public.editable_card_ids()))
  with check (card_id in (select public.editable_card_ids()));

drop policy if exists comment_read on public.comment;
create policy comment_read on public.comment for select to authenticated
  using (card_id in (select public.visible_card_ids()));

drop policy if exists comment_reaction_read on public.comment_reaction;
create policy comment_reaction_read on public.comment_reaction for select to authenticated
  using (card_id in (select public.visible_card_ids()));

drop policy if exists custom_field_value_read on public.custom_field_value;
create policy custom_field_value_read on public.custom_field_value for select to authenticated
  using (card_id in (select public.visible_card_ids()));
drop policy if exists custom_field_value_write on public.custom_field_value;
create policy custom_field_value_write on public.custom_field_value for all to authenticated
  using (card_id in (select public.editable_card_ids()))
  with check (card_id in (select public.editable_card_ids()));

-- Indexes the new policies lean on.
create index if not exists board_member_user_idx on public.board_member(user_id, board_id);
create index if not exists card_board_idx on public.card(board_id);
create index if not exists checklist_card_idx on public.checklist(card_id);
create index if not exists attachment_card_idx on public.attachment(card_id);
create index if not exists comment_card_idx on public.comment(card_id);
