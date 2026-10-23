-- Closes the open alerts scripts/bot/duplicate-alerts.sql lists. Run that dry run
-- first, check the list, and run this only after an OK. Same rules, same
-- pairs. Each duplicate:
--   - its people are added to the alert that's kept, so nobody loses one;
--   - it's stopped, with close note "Duplicate of <kept id>", and a
--     watch_event says so;
--   - it stops calling and its notifications go quiet.
-- All of it in one transaction: it all happens, or none of it.

begin;

create temp table dup_pick on commit drop as
with a as (
  select x.id, x.source, x.kind, x.title, x.person, x.created_at, x.due_at,
         coalesce(x.chat_id, x.channel_id) as place, x.mail_account, x.mail_thread, x.mail_key,
         coalesce((select g.name from public.wa_group g where g.chat_id = x.chat_id),
                  (select '#' || c.name from public.slack_channel c where c.channel_id = x.channel_id),
                  'email "' || coalesce(x.mail_subject, '') || '"') as label,
         coalesce(x.person_key, 'n:' || trim(regexp_replace(regexp_replace(lower(regexp_replace(coalesce(x.person, ''), '\(.*?\)', ' ', 'g')), '[^[:alnum:][:space:]]', ' ', 'g'), '\s+', ' ', 'g'))) as who,
         trim(regexp_replace(regexp_replace(lower(x.title), '[^[:alnum:][:space:]]', ' ', 'g'), '\s+', ' ', 'g')) as norm_title,
         array(select distinct v
                 from regexp_split_to_table(trim(regexp_replace(regexp_replace(lower(regexp_replace(x.title, '\(.*?\)', ' ', 'g')), '[^[:alnum:][:space:]]', ' ', 'g'), '\s+', ' ', 'g')), ' ') v
                where v <> '' and v not in ('a','an','the','to','for','on','of','by','and','or','in','at','is','are','was','be','it','its','with','from','about',
                                            'their','his','her','them','they','you','your','our','we','us','this','that','waiting','wait',
                                            'promised','promise','send','sent','reply','replied','get','back')) as words
    from public.watch_alert x
   where x.status = 'open'
),
w as (
  select a.*, array(select v from unnest(a.words) v where v ~ '[0-9]') as nums from a
),
pair as (
  select d.id as dup_id, k.id as keep_id, d.source, d.kind, d.label, d.person,
         k.title as keep_title, d.title as dup_title, k.created_at as keep_at, d.created_at as dup_at,
         case
           when d.kind = 'unanswered' and d.source <> 'email' then 'the same person is waiting in the same chat'
           when d.kind = 'unanswered' then 'the same email'
           when s.ratio >= 0.5 or s.cover >= 0.8 then 'the same person or email, a similar title'
           else 'the same person, due within 2 hours'
         end as why
    from w d
    join w k
      on k.id <> d.id
     and (k.created_at < d.created_at or (k.created_at = d.created_at and k.id < d.id))
     and k.kind = d.kind and k.source = d.source
    cross join lateral (
      select coalesce(cardinality(array(select unnest(d.words) intersect select unnest(k.words))), 0)::numeric
               / greatest(cardinality(array(select unnest(d.words) union select unnest(k.words))), 1) as ratio,
             coalesce(cardinality(array(select unnest(d.words) intersect select unnest(k.words))), 0)::numeric
               / greatest(least(cardinality(d.words), cardinality(k.words)), 1) as cover,
             ((cardinality(d.nums) > 0 or cardinality(k.nums) > 0) and not (d.nums && k.nums)) as other_numbers,
             abs(extract(epoch from d.due_at - k.due_at)) <= 7200 as near,
             ((d.mail_key is not null and d.mail_key = k.mail_key)
               or (d.mail_thread is not null and d.mail_account = k.mail_account and d.mail_thread = k.mail_thread)) as same_mail
    ) s
   where case
           when d.source <> 'email' then
             d.place = k.place and d.who = k.who
             and (d.kind = 'unanswered' or (not s.other_numbers and (s.ratio >= 0.5 or s.cover >= 0.8 or s.near)))
           when d.kind = 'unanswered' then s.same_mail
           else
             not s.other_numbers
             and ((s.same_mail and (s.ratio >= 0.5 or s.cover >= 0.8 or (d.who = k.who and s.near)))
                  or ((d.who = k.who or d.norm_title = k.norm_title) and (s.ratio >= 0.5 or s.cover >= 0.8)))
         end
),
-- Each one is kept in the oldest open alert it matches.
pick as (
  select distinct on (dup_id) * from pair order by dup_id, keep_at, keep_id
)
select dup_id, keep_id from pick;

-- Nobody loses an alert: the duplicate's people ring on the one kept.
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

-- What was closed.
select dup_id::text as closed, keep_id::text as kept_in from dup_pick order by keep_id;

commit;
