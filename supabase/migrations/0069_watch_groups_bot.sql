-- ============================================================================
-- 0069_watch_groups_bot.sql
--   Alerts > Groups: the bot's own number shows as the bot (it was listed as a
--   client). Same as 0067 otherwise.
-- ============================================================================

create or replace function public.watch_groups()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'chat_id', g.chat_id, 'name', g.name, 'monitored', g.monitored, 'size', g.size,
               'left', g.left_at is not null, 'synced_at', g.synced_at, 'last_message_at', g.last_message_at,
               'analyzed_at', g.analyzed_at, 'last_error', g.last_error,
               'open_alerts', (select count(*) from public.watch_alert a where a.chat_id = g.chat_id and a.status = 'open'),
               'participants', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'wa_id', pt.wa_id, 'phone', pt.phone, 'name', pt.name, 'is_admin', pt.is_admin,
                           'user_id', u.id, 'user_name', u.display_name, 'avatar_url', u.avatar_url, 'user_active', u.is_active,
                           'is_bot', pt.phone is not null and pt.phone = (select bot_phone from public.watch_settings where id = 1))
                           order by (u.id is null), coalesce(u.display_name, pt.name, pt.phone))
                    from public.wa_participant pt
                    left join public.profile u on u.id = public._wa_user(pt.phone)
                   where pt.chat_id = g.chat_id), '[]'::jsonb))
             order by (g.left_at is not null), g.last_message_at desc nulls last, g.name)
        from public.wa_group g), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.display_name, 'avatar_url', p.avatar_url, 'active', p.is_active,
               'phones', (select coalesce(jsonb_agg(m.phone order by m.created_at), '[]'::jsonb) from public.wa_member m where m.user_id = p.id),
               'card_phone', (select whatsapp from public.profile_contact c where c.user_id = p.id))
             order by p.is_active desc, p.display_name)
        from public.profile p), '[]'::jsonb));
end $$;
