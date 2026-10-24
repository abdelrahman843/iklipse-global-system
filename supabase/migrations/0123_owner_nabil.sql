-- The owner is Nabil (0123), and the owner numbers are the owner's alone.
--
-- - 201150472975 is Abdelrahman's: the link the bot knows people by
--   (wa_member) moves from the Admin account to his, like his member card.
-- - The owner numbers are Nabil's: the numbers linked to him, and his card's.
-- - Only the owner changes the owner numbers on Alerts > Brain: another admin
--   is refused (the service role, like this file, still can).

update public.wa_member m
   set user_id = p.id
  from public.profile p
 where p.username = 'abdelrahman'
   and m.phone = '201150472975';

update public.brain_settings s
   set owner_phones = n.phones,
       updated_at = now()
  from (
    select array_agg(distinct x.phone order by x.phone) as phones
      from (
        select m.phone from public.wa_member m join public.profile p on p.id = m.user_id where p.username = 'nabil'
        union
        select c.whatsapp from public.profile_contact c join public.profile p on p.id = c.user_id where p.username = 'nabil' and c.whatsapp is not null
      ) x
  ) n
 where s.id = 1
   and n.phones is not null;

create or replace function public._brain_owner_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_phones is distinct from old.owner_phones and auth.uid() is not null
     and not exists (select 1 from public.wa_member m where m.user_id = auth.uid() and m.phone = any(old.owner_phones))
     and not exists (select 1 from public.profile_contact c where c.user_id = auth.uid() and c.whatsapp = any(old.owner_phones)) then
    raise exception 'Only the owner changes the owner numbers';
  end if;
  return new;
end;
$$;
revoke all on function public._brain_owner_guard() from public, anon, authenticated;

drop trigger if exists owner_guard on public.brain_settings;
create trigger owner_guard before update on public.brain_settings for each row execute function public._brain_owner_guard();
