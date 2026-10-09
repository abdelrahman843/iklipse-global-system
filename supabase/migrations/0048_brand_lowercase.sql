-- The brand is written "iklipse" (small i). Rewrite the text the database
-- sends people (WhatsApp / email messages and subjects, test messages) in the
-- functions that still say "Iklipse". The X-Iklipse-Secret request header
-- name is left as it is (the webhook checks it).
do $$
declare
  f record;
  def text;
begin
  for f in
    select p.oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%Iklipse%'
  loop
    def := pg_get_functiondef(f.oid);
    def := replace(def, 'X-Iklipse-Secret', '__KEEP_HEADER__');
    def := replace(def, 'Iklipse', 'iklipse');
    def := replace(def, '__KEEP_HEADER__', 'X-Iklipse-Secret');
    execute def;
  end loop;
end
$$;
