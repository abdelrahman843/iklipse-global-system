-- 0127: two open alerts kept an old due time after newer messages moved it
-- (Sameh's Side quest update said "EOD today"; Marilena's "by Monday" is today).
-- Both now due today 18:00 Cairo and start over: they ring and call at that time.
update public.watch_alert
   set due_at = timestamptz '2026-10-26 18:00:00+03', next_alert_at = timestamptz '2026-10-26 18:00:00+03',
       alerts_sent = 0, calls_made = 0, updated_at = now()
 where status = 'open'
   and id in ('8e33bd75-c720-40b8-b45b-92d82fff41f4', '2f69cd85-d355-42fc-b313-c6a70285c070');
update public.watch_recipient set next_call_at = null, calls = 0
 where alert_id in ('8e33bd75-c720-40b8-b45b-92d82fff41f4', '2f69cd85-d355-42fc-b313-c6a70285c070');
insert into public.watch_event (alert_id, what, detail)
select id, 'updated', 'due time fixed by hand, now due 26 Oct 18:00 Cairo'
  from public.watch_alert
 where status = 'open' and id in ('8e33bd75-c720-40b8-b45b-92d82fff41f4', '2f69cd85-d355-42fc-b313-c6a70285c070');
