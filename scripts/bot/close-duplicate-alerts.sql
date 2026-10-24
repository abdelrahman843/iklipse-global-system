-- Closes the duplicate alerts on an approved list, and nothing else. Run the
-- dry run first (scripts/bot/duplicate-alerts.sql), check its list, paste the
-- approve column of the rows that are OK below, and run this. Nothing is
-- worked out again here: what closes is the list as it was approved, even if
-- the dry run would list more (or other ones) by now. With nothing pasted,
-- nothing closes. Each one on the list:
--   - the one it's kept in, when that's on the list too, is followed to the
--     end of the chain (the root), which is the one kept;
--   - its people are added to the root, so nobody loses one;
--   - it's stopped, with close note "Duplicate of <root id>", and a
--     watch_event says so;
--   - it stops calling and its notifications go quiet.
-- Left open (and said so): one that's no longer open, or with no open root of
-- the same kind and source (an email one: in the same mailbox) to keep it in.
-- All of it in one transaction: it all happens, or none of it.

begin;

create temp table dup_approved on commit drop as
select distinct on (v.dup_id) v.dup_id::uuid as dup_id, v.keep_id::uuid as keep_id
  from (values
    -- The approved list: the dry run's approve lines, pasted here, above the (null, null) line.
    (null::text, null::text)
  ) v(dup_id, keep_id)
 where v.dup_id is not null
 order by v.dup_id, v.keep_id;

-- Chains: the one it's kept in closed too is followed to the end (the root).
create temp table dup_pick on commit drop as
with recursive walk as (
  select a.dup_id, a.keep_id as root, 0 as hops, array[a.dup_id] as seen from dup_approved a
  union all
  select k.dup_id, n.keep_id, k.hops + 1, k.seen || n.dup_id
    from walk k
    join dup_approved n on n.dup_id = k.root
   where not n.dup_id = any(k.seen)
),
root as (
  select distinct on (dup_id) dup_id, root from walk order by dup_id, hops desc
)
select r.dup_id, r.root as keep_id
  from root r
  join public.watch_alert d on d.id = r.dup_id and d.status = 'open'
  join public.watch_alert k on k.id = r.root and k.status = 'open'
 where k.id <> d.id and k.source = d.source and k.kind = d.kind
   -- Email only in the same mailbox (a line from an older dry run too): never an owner added to another mailbox's alert.
   and (d.source <> 'email' or d.mail_account = k.mail_account)
   -- A loop on the list has no root: left alone.
   and not exists (select 1 from dup_approved x where x.dup_id = r.root);

-- Nobody loses an alert: the duplicate's people ring on the root.
insert into public.watch_recipient (alert_id, user_id)
select p.keep_id, r.user_id
  from dup_pick p
  join public.watch_recipient r on r.alert_id = p.dup_id
on conflict (alert_id, user_id) do nothing;

update public.watch_alert a
   set status = 'stopped', closed_at = now(), close_note = 'Duplicate of ' || p.keep_id, next_alert_at = null, updated_at = now()
  from dup_pick p
 where a.id = p.dup_id and a.status = 'open';

update public.watch_recipient r
   set next_call_at = null
  from dup_pick p
 where r.alert_id = p.dup_id;

insert into public.watch_event (alert_id, what, detail)
select dup_id, 'stopped', 'Duplicate of ' || keep_id from dup_pick;

select public._watch_quiet_notifications(dup_id) from dup_pick;

-- What was closed, and what was left open.
select a.dup_id::text as alert, coalesce(p.keep_id, a.keep_id)::text as kept_in,
       case
         when p.dup_id is not null then 'closed'
         when d.status is distinct from 'open' then 'left: no longer open'
         else 'left: nothing open to keep it in'
       end as done
  from dup_approved a
  left join dup_pick p on p.dup_id = a.dup_id
  left join public.watch_alert d on d.id = a.dup_id
 order by done, kept_in;

commit;
