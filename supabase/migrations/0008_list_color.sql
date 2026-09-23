-- ============================================================================
-- 0008_list_color.sql
--   Adds an optional accent color to lists (Trello-style column colors).
--   Cards already carry `cover_color` from 0002_pm_core; this brings lists to
--   parity. Nullable text holding a hex string (e.g. '#0079bf'); null = none.
--   No RLS change needed — the existing list UPDATE policy already gates writes
--   on board membership, and column-level grants are inherited.
-- ============================================================================
alter table public.list add column if not exists color text;
