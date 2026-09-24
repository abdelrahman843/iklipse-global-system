-- 0012_guest_role.sql — Trello-style workspace roles: admin / member / guest.
--
-- Guests are people outside the workspace: they only see the boards they were
-- explicitly added to and can never create boards. Kept in its own migration
-- because a new enum value can't be used in the transaction that adds it.

alter type public.role add value if not exists 'guest';
