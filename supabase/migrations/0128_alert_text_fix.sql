-- 0128: the Side quest alert's text pointed at a chat message number ("#16 now says EOD today").
-- It now reads on its own in the alerts digest.
update public.watch_alert
   set detail = 'Sameh promised an update on the staging site by EOD today.', updated_at = now()
 where status = 'open' and id = '2f69cd85-d355-42fc-b313-c6a70285c070';
