-- Open alerts that say the same thing as an older open one: a dry run. It only
-- lists them and changes nothing: where, what kind, about whom, the one kept
-- (the oldest), the one that would be closed, and why they match. Run it
-- after migration 0109. The rules are the bot's own
-- (supabase/functions/whatsapp-bot/repeat.ts):
--   Groups and Slack: the same chat and person. A client waiting is one
--     alert; anything else matches on a similar title (the same matter). A
--     due time close by never makes two alerts one by itself.
--   Email: only inside one mailbox. A client waiting matches on the same
--     email or the same conversation. Anything else matches on a similar
--     title, and the same email (or conversation), the same person or the
--     very same title. Two mailboxes' alerts never match, not even about the
--     same email: email alerts stay with their mailbox's owner (closing one
--     would add its owner to the other mailbox's alert).
--   Never when the titles name different numbers (two different invoices).
-- A kept one that's itself a duplicate is followed to the end of the chain:
-- the oldest (the root) is the one kept.
-- Closing them is scripts/bot/close-duplicate-alerts.sql, only after this list
-- was checked: paste the approve column of the rows that are OK into it. It
-- closes those and nothing else, so running this again later changes nothing
-- about what closes.

with recursive a as (
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
           else 'the same person or email, a similar title'
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
             ((d.mail_key is not null and d.mail_key = k.mail_key)
               or (d.mail_thread is not null and d.mail_account = k.mail_account and d.mail_thread = k.mail_thread)) as same_mail
    ) s
   where case
           when d.source <> 'email' then
             d.place = k.place and d.who = k.who
             and (d.kind = 'unanswered' or (not s.other_numbers and (s.ratio >= 0.5 or s.cover >= 0.8)))
           -- Email: another mailbox's alert is its owner's, never kept for this one.
           when d.mail_account is distinct from k.mail_account then false
           when d.kind = 'unanswered' then s.same_mail
           else
             not s.other_numbers
             and ((s.same_mail and (s.ratio >= 0.5 or s.cover >= 0.8))
                  or (d.mail_account = k.mail_account and (d.who = k.who or d.norm_title = k.norm_title) and (s.ratio >= 0.5 or s.cover >= 0.8)))
         end
),
-- Each one is kept in the oldest open alert it matches.
pick as (
  select distinct on (dup_id) * from pair order by dup_id, keep_at, keep_id
),
-- That one closed as a duplicate too: on to the one it's kept in, to the end of the chain (the root).
walk as (
  select p.dup_id, p.keep_id as root, 0 as hops from pick p
  union all
  select k.dup_id, p.keep_id, k.hops + 1 from walk k join pick p on p.dup_id = k.root
),
root as (
  select distinct on (dup_id) dup_id, root from walk order by dup_id, hops desc
)
select p.source, p.kind, p.label as place, p.person, r.root::text as keep, left(k.title, 70) as keep_title,
       to_char(k.created_at at time zone 'Africa/Cairo', 'DD Mon HH24:MI') as kept_since,
       p.dup_id::text as close, left(p.dup_title, 70) as close_title,
       to_char(p.dup_at at time zone 'Africa/Cairo', 'DD Mon HH24:MI') as close_since,
       p.why || case when r.root <> p.keep_id then ' (through ' || p.keep_id || ')' else '' end as why,
       -- What to paste into close-duplicate-alerts.sql once this row is OK.
       format('(%L, %L),', p.dup_id, r.root) as approve
  from pick p
  join root r on r.dup_id = p.dup_id
  join w k on k.id = r.root
 order by p.source, p.label, k.created_at, p.dup_at;
