-- 0129: Sameh said "ok" to the repeating "Check on Taradod's side quest" reminder
-- and it kept going every 15 minutes. Stop it by hand (the ok-stops-it fix only
-- covers new replies).
update public.bot_reminder
   set status = 'cancelled', cancelled_at = now()
 where status in ('open', 'sending')
   and every_minutes is not null
   and text ilike '%Taradod%side quest%'
   and for_user = 'b015fcd4-9db4-45a2-94ab-98f3c0a72de6';
