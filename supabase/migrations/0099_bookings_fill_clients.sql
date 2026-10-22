-- 0099: a client's Calendly booking fills in what Clients is missing about them.
--
-- Every booking link the bot sends a client carries their WhatsApp number (in
-- the form's phone question and in utm_content, which Calendly hands back on
-- the booking). When they book, the name and email they type go on their
-- Clients row, found by that number: the name only if Clients didn't know it,
-- the email only if it had none. Someone who booked from the bot's link and
-- isn't in Clients yet is added. Bookings without our link (an old one, the
-- plain Calendly page) only fill in a client who's already there, by the
-- number they typed in the form.
-- The bot also goes back over each Calendly's past bookings once, a page at a
-- time (learned_before: how far back it got; 'epoch' when it's done).

alter table public.calendly_account
  add column if not exists learned_before timestamptz;

create or replace function public.client_from_booking(p_phone text, p_name text, p_email text, p_from_link boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_phone text := public._phone_key(p_phone);
  v_name  text := left(nullif(btrim(coalesce(p_name, '')), ''), 200);
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_id    uuid;
begin
  if v_phone is null or v_phone !~ '^[1-9][0-9]{7,14}$' then return null; end if;
  -- The team's own numbers aren't clients.
  if exists (select 1 from public.wa_member where phone = v_phone)
     or exists (select 1 from public.profile_contact where whatsapp = v_phone) then
    return null;
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  if v_name ~ '^\+?[0-9 ()-]+$' then v_name := null; end if;

  select id into v_id from public.client where public._phone_key(phone) = v_phone order by created_at limit 1;
  -- Else someone in Clients by that email without a number: it's theirs.
  if v_id is null and v_email is not null then
    select id into v_id from public.client where lower(email) = v_email and phone is null order by created_at limit 1;
  end if;

  if v_id is not null then
    update public.client
       set phone      = coalesce(phone, '+' || v_phone),
           email      = coalesce(email, v_email),
           name       = case when not name_known and v_name is not null then v_name else name end,
           name_known = name_known or v_name is not null,
           updated_at = now()
     where id = v_id;
    return v_id;
  end if;

  if not p_from_link then return null; end if;
  insert into public.client (name, email, phone, name_known, notes)
  values (coalesce(v_name, '+' || v_phone), v_email, '+' || v_phone, v_name is not null, 'Booked a call from the WhatsApp bot''s link')
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.client_from_booking(text, text, text, boolean) from public, anon, authenticated;
