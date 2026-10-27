-- 0130_invoice_once.sql
--   An invoice is filed once, however many times it's read (the same email
--   read again, the same invoice sent twice, the invoice and its receipt in
--   two emails). Its key: refund or not, plus its number; without a number,
--   the provider, date, amount and currency. Two filed invoices (done, or
--   waiting for their file) never share a key (invoice_once). The invoices
--   function also asks invoice_duplicate before it uploads anything, which
--   also catches one with a number and one without for the same purchase.
--   The duplicates already there: the first one stays, the others are skipped.

alter table public.invoice add column if not exists dedupe_key text;

create or replace function public._invoice_key(p_refund boolean, p_number text, p_provider text, p_date date, p_amount numeric, p_currency text)
returns text language sql immutable as $$
  select case when p_refund then 'r' else 'i' end || ':' ||
         case when coalesce(lower(regexp_replace(p_number, '[^A-Za-z0-9]', '', 'g')), '') <> ''
              then 'n:' || lower(regexp_replace(p_number, '[^A-Za-z0-9]', '', 'g'))
              else 'p:' || lower(regexp_replace(coalesce(p_provider, ''), '[^A-Za-z0-9]', '', 'g'))
                   || ':' || coalesce(to_char(p_date, 'YYYY-MM-DD'), '')
                   || ':' || coalesce(trim(to_char(p_amount, 'FM999999999990.00')), '')
                   || ':' || coalesce(upper(p_currency), '')
         end
$$;

create or replace function public._invoice_set_key()
returns trigger language plpgsql as $$
begin
  new.dedupe_key := public._invoice_key(new.is_refund, new.invoice_number, new.provider, new.invoice_date, new.amount, new.currency);
  return new;
end $$;

drop trigger if exists invoice_set_key on public.invoice;
create trigger invoice_set_key before insert or update of is_refund, invoice_number, provider, invoice_date, amount, currency, status
  on public.invoice for each row execute function public._invoice_set_key();

update public.invoice
   set dedupe_key = public._invoice_key(is_refund, invoice_number, provider, invoice_date, amount, currency);

-- The duplicates there now: the filed one (done before waiting), the oldest, stays.
with ranked as (
  select id, row_number() over (partition by dedupe_key order by (status = 'done') desc, created_at, id) as n
    from public.invoice
   where status in ('done', 'needs_file')
)
update public.invoice i
   set status = 'skipped', error = 'Already filed: the same invoice came again', updated_at = now()
  from ranked r
 where r.id = i.id and r.n > 1;

create unique index if not exists invoice_once on public.invoice (dedupe_key) where status in ('done', 'needs_file');

-- Before filing one: is it filed already? The same key, or (one of the two
-- without a number) the same provider, date, amount and currency.
create or replace function public.invoice_duplicate(p_id uuid, p_refund boolean, p_number text, p_provider text, p_date date, p_amount numeric, p_currency text)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (
    select i.id, i.provider, i.invoice_number, i.invoice_date, i.amount, i.currency
      from public.invoice i
     where i.id <> p_id
       and i.status in ('done', 'needs_file')
       and (i.dedupe_key = public._invoice_key(p_refund, p_number, p_provider, p_date, p_amount, p_currency)
            or (i.is_refund = p_refund
                and (coalesce(i.invoice_number, '') = '' or coalesce(p_number, '') = '')
                and i.invoice_date = p_date
                and i.amount = p_amount
                and upper(coalesce(i.currency, '')) = upper(coalesce(p_currency, ''))
                and regexp_replace(coalesce(i.provider, ''), '[^A-Za-z0-9]', '', 'g') <> ''
                and regexp_replace(coalesce(p_provider, ''), '[^A-Za-z0-9]', '', 'g') <> ''
                and (lower(regexp_replace(coalesce(i.provider, ''), '[^A-Za-z0-9]', '', 'g')) like lower(regexp_replace(coalesce(p_provider, ''), '[^A-Za-z0-9]', '', 'g')) || '%'
                     or lower(regexp_replace(coalesce(p_provider, ''), '[^A-Za-z0-9]', '', 'g')) like lower(regexp_replace(coalesce(i.provider, ''), '[^A-Za-z0-9]', '', 'g')) || '%')))
     order by i.created_at
     limit 1
  ) x
$$;
revoke all on function public.invoice_duplicate(uuid, boolean, text, text, date, numeric, text) from public, anon, authenticated;
grant execute on function public.invoice_duplicate(uuid, boolean, text, text, date, numeric, text) to service_role;
