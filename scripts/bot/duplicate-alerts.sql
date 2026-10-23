-- Open alerts that say the same thing as an older open one: a dry run. It only
-- lists them and changes nothing: where, what kind, about whom, the one kept
-- (the oldest), the one that would be closed, and why they match. Run it
-- after migration 0109. The rules are the bot's own
-- (supabase/functions/whatsapp-bot/repeat.ts):
--   Groups and Slack: the same chat and person. A client waiting is one
--     alert; anything else matches on a similar title, or due within 2 hours.
--   Email: one conversation can be in several team members' mailboxes. A
--     client waiting matches on the same email or the same conversation.
--     Anything else matches on the same person (or the very same title) and
--     a similar title.
--   Never when the titles name different numbers (two different invoices).
-- Closing them is scripts/bot/close-duplicate-alerts.sql, with the same rules,
-- only after this list was checked.

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
select source, kind, label as place, person, keep_id::text as keep, left(keep_title, 70) as keep_title,
       to_char(keep_at at time zone 'Africa/Cairo', 'DD Mon HH24:MI') as kept_since,
       dup_id::text as close, left(dup_title, 70) as close_title,
       to_char(dup_at at time zone 'Africa/Cairo', 'DD Mon HH24:MI') as close_since, why
  from pick
 order by source, place, keep_at, dup_at;
