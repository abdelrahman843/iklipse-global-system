-- 0100: clients known only by their WhatsApp number get the name on their
-- WhatsApp profile (even if they never wrote in the group), a business
-- account's email, and on the bot's own bridge the number WhatsApp hides
-- (whatsapp-bot, people.ts lookUpNames). wa_looked_at: last looked up, so each
-- is looked at again a week later while something is still missing.

alter table public.client
  add column if not exists wa_looked_at timestamptz;
