-- Deliveries from Google Drive (0062, 0054).
--
-- A delivery's image, video or file can sit in a connected Google Drive
-- instead of the 'deliveries' bucket, so big videos don't fill the storage.
-- The file stays private in Drive: the drive function adds it (it checks the
-- Drive account and reads the file's name, type and size), and the
-- delivery-media function streams it to the client and the team through
-- short-lived signed links.

alter table public.delivery_item
  add column if not exists drive_file_id    text check (drive_file_id is null or drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  add column if not exists drive_account_id uuid references public.drive_account(id) on delete set null,
  add column if not exists drive_email      text check (drive_email is null or length(drive_email) <= 320);

alter table public.delivery_item drop constraint if exists delivery_item_source;
alter table public.delivery_item add constraint delivery_item_source check (
  (kind = 'link' and external_url is not null and storage_path is null and drive_file_id is null)
  or (kind <> 'link' and external_url is null and (
        (storage_path is not null and drive_file_id is null)
     or (storage_path is null and drive_file_id is not null and drive_email is not null))));

-- Drive items are added by the drive function only (no login on that call:
-- it has checked the account). Their source never changes; the Drive account
-- link goes when that account is disconnected (and is found again by email).
create or replace function public.delivery_item_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.storage_path is not null and not exists (
         select 1 from storage.objects where bucket_id = 'deliveries' and name = new.storage_path) then
      raise exception 'Upload the file first';
    end if;
    if (new.drive_file_id is not null or new.drive_account_id is not null) and auth.uid() is not null then
      raise exception 'Add Drive files with the Google Drive button';
    end if;
    new.added_round := (select round from public.delivery_folder where id = new.folder_id);
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    new.removed_at := null;
  else
    new.folder_id := old.folder_id;
    new.kind := old.kind;
    new.storage_path := old.storage_path;
    new.external_url := old.external_url;
    new.drive_file_id := old.drive_file_id;
    new.drive_email := old.drive_email;
    if new.drive_account_id is not null then new.drive_account_id := old.drive_account_id; end if;
    new.mime_type := old.mime_type;
    new.size := old.size;
    new.added_round := old.added_round;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

-- What the client has right now (kept on each round).
create or replace function public._delivery_snapshot(p_folder uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'kind', i.kind, 'name', i.name, 'mime_type', i.mime_type, 'size', i.size,
           'storage_path', i.storage_path, 'external_url', i.external_url, 'drive_file_id', i.drive_file_id,
           'added_round', i.added_round)
           order by i.position), '[]'::jsonb)
    from public.delivery_item i where i.folder_id = p_folder and i.removed_at is null;
$$;
revoke all on function public._delivery_snapshot(uuid) from public, anon, authenticated;

-- The media service asks which files a link may see (bucket or Drive).
create or replace function public.delivery_media(p_token text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.delivery_link;
begin
  l := public._delivery_check(p_token, p_device, null, null, null);
  return jsonb_build_object(
    'allow_download', l.allow_download,
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'path', i.storage_path, 'name', i.name, 'kind', i.kind,
                                                           'drive', i.drive_file_id is not null))
                         from public.delivery_item i
                        where i.folder_id = l.folder_id and i.removed_at is null
                          and (i.storage_path is not null or i.drive_file_id is not null)), '[]'::jsonb));
end $$;
revoke all on function public.delivery_media(text, text) from public, anon, authenticated;
grant execute on function public.delivery_media(text, text) to service_role;
