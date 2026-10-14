-- Drive files in a delivery play in Google's own preview (0064): the media
-- service needs the Drive file id to build that link.
create or replace function public.delivery_media(p_token text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.delivery_link;
begin
  l := public._delivery_check(p_token, p_device, null, null, null);
  return jsonb_build_object(
    'allow_download', l.allow_download,
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'path', i.storage_path, 'name', i.name, 'kind', i.kind,
                                                           'drive', i.drive_file_id is not null, 'drive_file_id', i.drive_file_id))
                         from public.delivery_item i
                        where i.folder_id = l.folder_id and i.removed_at is null
                          and (i.storage_path is not null or i.drive_file_id is not null)), '[]'::jsonb));
end $$;
revoke all on function public.delivery_media(text, text) from public, anon, authenticated;
grant execute on function public.delivery_media(text, text) to service_role;
