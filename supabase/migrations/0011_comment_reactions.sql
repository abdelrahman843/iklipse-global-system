-- 0011_comment_reactions.sql — emoji reactions on card comments.
--
-- One row per (comment, user, emoji). card_id is denormalised from the comment
-- (filled by trigger) so the card modal can subscribe to reaction changes with a
-- simple realtime filter on card_id. Editing / deleting comments already works
-- through the existing comment_update_self / comment_delete_self_or_admin RLS.

create table if not exists public.comment_reaction (
  comment_id uuid not null references public.comment(id) on delete cascade,
  user_id    uuid not null references public.profile(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 32),
  card_id    uuid not null references public.card(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id, emoji)
);
create index if not exists comment_reaction_card_idx on public.comment_reaction(card_id);

create or replace function public.trg_comment_reaction_card() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select card_id into new.card_id from public.comment where id = new.comment_id;
  return new;
end $$;

drop trigger if exists comment_reaction_card on public.comment_reaction;
create trigger comment_reaction_card before insert on public.comment_reaction
  for each row execute function public.trg_comment_reaction_card();

alter table public.comment_reaction enable row level security;

drop policy if exists comment_reaction_read on public.comment_reaction;
create policy comment_reaction_read on public.comment_reaction
  for select to authenticated
  using (exists (select 1 from public.card c where c.id = card_id and public.is_board_member(c.board_id)));

drop policy if exists comment_reaction_insert on public.comment_reaction;
create policy comment_reaction_insert on public.comment_reaction
  for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.comment cm join public.card c on c.id = cm.card_id
                           where cm.id = comment_id and public.is_board_member(c.board_id)));

drop policy if exists comment_reaction_delete on public.comment_reaction;
create policy comment_reaction_delete on public.comment_reaction
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, delete on public.comment_reaction to authenticated;

-- Full row on delete so realtime DELETE events carry card_id for the filter.
alter table public.comment_reaction replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.comment_reaction;
exception when others then null; end $$;

notify pgrst, 'reload schema';
