-- ============================================================================
-- 0033_list_is_done.sql
--   "Done" lists: cards sitting in a list flagged is_done count as finished,
--   so a past due date there is not reported as overdue (dashboard, filters,
--   card badges). It does not change card.due_completed, so nothing drifts
--   from Trello while the sync runs; the Trello sync never writes this column.
-- ============================================================================

alter table public.list add column if not exists is_done boolean not null default false;

update public.list l
   set is_done = true
  from public.board b
 where b.id = l.board_id
   and b.title = 'iklipse - Simplified day to day'
   and l.title in ('Delivered and approved (Last 30 Days)', 'Lost')
   and not l.is_done;
