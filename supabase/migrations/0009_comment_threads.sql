-- 0009_comment_threads.sql — Slack-style threaded card comments.
--
-- A comment with parent_id = null is a ROOT: a conversation starter shown in
-- the card's main comment timeline. A comment with parent_id set is a REPLY
-- that belongs to that root's thread. Only two levels are used — a reply always
-- points at a root, never at another reply (enforced in the app UI). Deleting a
-- root cascades to its replies so a thread never outlives its opening comment.
alter table public.comment
  add column if not exists parent_id uuid references public.comment(id) on delete cascade;

-- Fast "give me a root's replies in order" lookups for the thread panel.
create index if not exists comment_parent_idx on public.comment(parent_id, created_at);

-- Existing RLS (comment_read/insert/update/delete) already covers the new
-- column — parent_id is just another field on a row whose access is gated by
-- board membership + pm.manage_comments. No policy change needed.

notify pgrst, 'reload schema';
