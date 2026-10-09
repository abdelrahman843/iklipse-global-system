-- ============================================================================
-- 0050_briefs.sql
--   Briefs: a one-time link that sends someone a questionnaire (the Brand
--   Workshop), in the iklipse look. They answer everything, send it, and the
--   answers come back to the Briefs page.
--
--   profile.brief_role  create | view | none. NULL = workspace admins create,
--                       everyone else has no access. "create" makes and
--                       manages links and reads answers; "view" reads answers.
--   brief_link          one link: who it's for, the questions as they were
--                       when it was made, the device that opened it, the
--                       answers (a draft until sent), and when it was sent.
--
--   One device only: the first browser that opens the link keeps it (a random
--   id the browser stores); every other device is turned away. Sending the
--   answers closes the link for good. No expiry.
--   Visitors never touch the table: brief_open / brief_save / brief_submit
--   check the token and the device. Moodboard images go through the
--   brief-media edge function into the private 'brief' bucket.
-- ============================================================================

-- ------------------------------------------------------------------ access --
alter table public.profile add column if not exists brief_role text;
alter table public.profile drop constraint if exists profile_brief_role_check;
alter table public.profile add constraint profile_brief_role_check check (brief_role in ('create', 'view', 'none'));

-- Someone's access to Briefs: 'create', 'view' or NULL (none / inactive).
create or replace function public._brief_role(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select nullif(coalesce(p.brief_role, case when p.role::text = 'admin' then 'create' else 'none' end), 'none')
    from public.profile p
   where p.id = p_user and p.is_active;
$$;
revoke all on function public._brief_role(uuid) from public, anon, authenticated;

create or replace function public.my_brief_role()
returns text language sql stable security definer set search_path = public as $$
  select public._brief_role(auth.uid()) where public._login_current();
$$;
revoke all on function public.my_brief_role() from public, anon;
grant execute on function public.my_brief_role() to authenticated;

-- Same as 0044, plus: people can't change their own Briefs access.
create or replace function public.profile_guard_self_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role        is distinct from old.role        then raise exception 'Not authorised to change role'; end if;
    if new.trello_role is distinct from old.trello_role then raise exception 'Not authorised to change role'; end if;
    if new.miro_role   is distinct from old.miro_role   then raise exception 'Not authorised to change role'; end if;
    if new.brief_role  is distinct from old.brief_role  then raise exception 'Not authorised to change role'; end if;
    if new.is_active   is distinct from old.is_active   then raise exception 'Not authorised to change status'; end if;
    if new.username    is distinct from old.username    then raise exception 'Not authorised to change username'; end if;
    if new.sessions_revoked_at is distinct from old.sessions_revoked_at then
      raise exception 'Not authorised to change sign-in state';
    end if;
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------- links --
create table if not exists public.brief_link (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  form         text not null default 'brand_workshop' check (form ~ '^[a-z0-9_]{1,40}$'),
  questions    jsonb not null check (jsonb_typeof(questions) = 'object' and octet_length(questions::text) <= 100000),
  label        text not null check (length(btrim(label)) between 1 and 80),
  note         text check (note is null or length(note) <= 600),
  created_by   uuid references public.profile(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  opened_at    timestamptz,
  device_id    text check (device_id is null or length(device_id) between 8 and 64),
  device_name  text check (device_name is null or length(device_name) <= 80),
  last_seen_at timestamptz,
  answers      jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  progress     smallint not null default 0 check (progress between 0 and 100),
  submitted_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists brief_link_created_idx on public.brief_link (created_at desc);

-- The team edits who it's for, the note, on / off, and can free the link for
-- a new device. Everything the visitor writes is theirs alone (the visitor
-- functions set iklipse.brief_visitor while they write).
create or replace function public.brief_link_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.token        := encode(extensions.gen_random_bytes(24), 'hex');
    new.created_by   := coalesce(auth.uid(), new.created_by);
    new.created_at   := now();
    new.opened_at    := null;
    new.device_id    := null;
    new.device_name  := null;
    new.last_seen_at := null;
    new.answers      := '{}'::jsonb;
    new.progress     := 0;
    new.submitted_at := null;
    return new;
  end if;
  new.token      := old.token;
  new.form       := old.form;
  new.questions  := old.questions;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if coalesce(current_setting('iklipse.brief_visitor', true), '') <> 'on' then
    new.opened_at    := old.opened_at;
    new.device_name  := old.device_name;
    new.last_seen_at := old.last_seen_at;
    new.answers      := old.answers;
    new.progress     := old.progress;
    new.submitted_at := old.submitted_at;
    -- "Open on a new device": the team can only clear the device, never set one.
    if new.device_id is distinct from old.device_id and new.device_id is not null then
      new.device_id := old.device_id;
    end if;
    if new.device_id is null and old.device_id is not null then
      new.device_name := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists brief_link_guard on public.brief_link;
create trigger brief_link_guard before insert or update on public.brief_link
  for each row execute function public.brief_link_guard();

alter table public.brief_link enable row level security;
drop policy if exists brief_link_read on public.brief_link;
create policy brief_link_read on public.brief_link for select to authenticated
  using (public.my_brief_role() is not null);
drop policy if exists brief_link_insert on public.brief_link;
create policy brief_link_insert on public.brief_link for insert to authenticated
  with check (public.my_brief_role() = 'create');
drop policy if exists brief_link_update on public.brief_link;
create policy brief_link_update on public.brief_link for update to authenticated
  using (public.my_brief_role() = 'create') with check (public.my_brief_role() = 'create');
drop policy if exists brief_link_delete on public.brief_link;
create policy brief_link_delete on public.brief_link for delete to authenticated
  using (public.my_brief_role() = 'create');
grant select, insert, update, delete on public.brief_link to authenticated;

-- Live list: a link opened or answered shows up without a reload.
do $$ begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    begin alter publication supabase_realtime add table public.brief_link; exception when others then null; end;
  end if;
end $$;

-- ------------------------------------------------------- answered or not --
-- One question, answered? Mirrors answered() in src/lib/brief/forms.ts.
create or replace function public._brief_answered(q jsonb, a jsonb)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(case q->>'type'
    when 'text' then jsonb_typeof(a) = 'string' and length(btrim(a #>> '{}')) > 0
    when 'long' then jsonb_typeof(a) = 'string' and length(btrim(a #>> '{}')) > 0
    when 'scale' then jsonb_typeof(a) = 'object' and not exists (
      select 1 from jsonb_array_elements(q->'pairs') p where coalesce(a->>(p->>'key'), '') !~ '^[1-7]$')
    when 'fields' then jsonb_typeof(a) = 'object' and not exists (
      select 1 from jsonb_array_elements(q->'fields') f where length(btrim(coalesce(a->>(f->>'key'), ''))) = 0)
    when 'repeat' then jsonb_typeof(a) = 'array' and jsonb_array_length(a) >= (q->>'count')::int and not exists (
      select 1 from jsonb_array_elements(a) with ordinality e(v, i), jsonb_array_elements(q->'fields') f
       where e.i <= (q->>'count')::int and length(btrim(coalesce(e.v->>(f->>'key'), ''))) = 0)
    when 'images' then jsonb_typeof(a) = 'array' and jsonb_array_length(a) >= coalesce((q->>'min')::int, 1)
    else true end, false);
$$;

create or replace function public._brief_missing(p_questions jsonb, p_answers jsonb)
returns integer language sql immutable set search_path = public as $$
  select count(*)::int
    from jsonb_path_query(p_questions, '$.sections[*].questions[*]') q
   where not public._brief_answered(q, p_answers -> (q->>'key'));
$$;

-- ---------------------------------------------------------------- visitors --
-- The link behind a token that this device may write to right now.
create or replace function public._brief_live(p_token text, p_device text)
returns public.brief_link language plpgsql security definer set search_path = public as $$
declare l public.brief_link;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then raise exception 'This link is not valid'; end if;
  select * into l from public.brief_link where token = p_token for update;
  if l.id is null then raise exception 'This link is not valid'; end if;
  if l.revoked_at is not null then raise exception 'This link was turned off'; end if;
  if l.submitted_at is not null then raise exception 'These answers were already sent'; end if;
  if l.device_id is null or l.device_id is distinct from p_device then
    raise exception 'This link is open on another device';
  end if;
  return l;
end $$;
revoke all on function public._brief_live(text, text) from public, anon, authenticated;

-- Open the brief. The first device to open it keeps it. Returns a status the
-- page shows (open / submitted / used / off / invalid) instead of failing.
create or replace function public.brief_open(p_token text, p_device text, p_device_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.brief_link;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then return jsonb_build_object('status', 'invalid'); end if;
  if p_device is null or length(p_device) not between 8 and 64 then return jsonb_build_object('status', 'invalid'); end if;
  select * into l from public.brief_link where token = p_token for update;
  if l.id is null then return jsonb_build_object('status', 'invalid'); end if;
  if l.revoked_at is not null then return jsonb_build_object('status', 'off'); end if;
  if l.submitted_at is not null then
    return jsonb_build_object('status', 'submitted', 'label', l.label, 'mine', l.device_id = p_device);
  end if;
  if l.device_id is not null and l.device_id <> p_device then return jsonb_build_object('status', 'used'); end if;

  perform set_config('iklipse.brief_visitor', 'on', true);
  update public.brief_link
     set device_id = p_device,
         device_name = coalesce(nullif(left(btrim(coalesce(p_device_name, '')), 80), ''), device_name),
         opened_at = coalesce(opened_at, now()),
         last_seen_at = now()
   where id = l.id;
  perform set_config('iklipse.brief_visitor', 'off', true);

  return jsonb_build_object(
    'status', 'open',
    'form', l.form,
    'label', l.label,
    'note', l.note,
    'questions', l.questions,
    'answers', l.answers,
    'from', (select display_name from public.profile where id = l.created_by));
end $$;
revoke all on function public.brief_open(text, text, text) from public;
grant execute on function public.brief_open(text, text, text) to anon, authenticated;

-- Save the answers so far (the page saves as they type).
create or replace function public.brief_save(p_token text, p_device text, p_answers jsonb, p_progress integer default 0)
returns void language plpgsql security definer set search_path = public as $$
declare l public.brief_link;
begin
  l := public._brief_live(p_token, p_device);
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'Nothing to save'; end if;
  if octet_length(p_answers::text) > 300000 then raise exception 'These answers are too long to save'; end if;
  perform set_config('iklipse.brief_visitor', 'on', true);
  update public.brief_link
     set answers = p_answers, progress = greatest(0, least(99, coalesce(p_progress, 0))), last_seen_at = now()
   where id = l.id;
  perform set_config('iklipse.brief_visitor', 'off', true);
end $$;
revoke all on function public.brief_save(text, text, jsonb, integer) from public;
grant execute on function public.brief_save(text, text, jsonb, integer) to anon, authenticated;

-- Send the answers: every question needs one. The link closes for good and
-- the person who made it hears about it.
create or replace function public.brief_submit(p_token text, p_device text, p_answers jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  l public.brief_link;
  n integer;
begin
  l := public._brief_live(p_token, p_device);
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'Nothing to send'; end if;
  if octet_length(p_answers::text) > 300000 then raise exception 'These answers are too long to send'; end if;
  n := public._brief_missing(l.questions, p_answers);
  if n > 0 then
    raise exception '% still need an answer', case when n = 1 then '1 question' else n || ' questions' end;
  end if;
  perform set_config('iklipse.brief_visitor', 'on', true);
  update public.brief_link
     set answers = p_answers, progress = 100, submitted_at = now(), last_seen_at = now()
   where id = l.id;
  perform set_config('iklipse.brief_visitor', 'off', true);

  if l.created_by is not null and public._brief_role(l.created_by) is not null then
    insert into public.notification (user_id, kind, data)
    values (l.created_by, 'brief_submitted',
            jsonb_build_object('link_id', l.id, 'label', l.label,
                               'excerpt', coalesce(l.questions->>'title', 'Brief')));
  end if;
end $$;
revoke all on function public.brief_submit(text, text, jsonb) from public;
grant execute on function public.brief_submit(text, text, jsonb) to anon, authenticated;

-- The media service (edge function brief-media) asks which link a visitor is
-- uploading to (only while it's theirs and not sent yet).
create or replace function public.brief_media_link(p_token text, p_device text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  return (public._brief_live(p_token, p_device)).id;
end $$;
revoke all on function public.brief_media_link(text, text) from public, anon, authenticated;
grant execute on function public.brief_media_link(text, text) to service_role;

-- -------------------------------------------------------------- moodboard --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brief', 'brief', false, 10485760, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The team reads the images; whoever manages links can delete them. Uploads
-- only come through brief-media (service role).
drop policy if exists brief_media_read on storage.objects;
create policy brief_media_read on storage.objects for select to authenticated
  using (bucket_id = 'brief' and public.my_brief_role() is not null);
drop policy if exists brief_media_delete on storage.objects;
create policy brief_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brief' and public.my_brief_role() = 'create');

-- ---------------------------------------------- notifications to channels --
-- Same as 0049, plus "brief sent" (no board: it links to the answers page).
create or replace function public.on_notification_channels()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c      public.profile_contact;
  v_card text;
  v_brd  text;
  v_kind text;
  v_what text;
  v_link text;
  v_msg  text;
  v_body text;
  v_app  text := (select rtrim(app_url, '/') from public.workspace limit 1);
begin
  select * into c from public.profile_contact where user_id = new.user_id;
  select title into v_card from public.card where id = new.card_id;
  select title, kind into v_brd, v_kind from public.board where id = new.board_id;
  v_what := case new.kind
    when 'mention'       then 'You were mentioned'
    when 'assigned'      then 'You were added to a card'
    when 'comment'       then 'New comment'
    when 'due_changed'   then 'Due date changed'
    when 'due_completed' then 'Marked complete'
    when 'board_invited' then case when v_kind = 'whiteboard' then 'You were added to a Miro board' else 'You were added to a Trello board' end
    when 'automation'    then coalesce(nullif(new.data->>'text', ''), 'Rule')
    when 'wb_mention'    then coalesce(new.data->>'by', 'Someone') || ' mentioned you'
                              || coalesce(' in ' || (new.data->>'doc_title'), '')
    when 'wb_reply'      then coalesce(new.data->>'by', 'Someone') || ' replied'
    when 'wb_guest_comment' then coalesce(new.data->>'by', 'A client') || ' commented'
    when 'brief_submitted'  then coalesce(nullif(new.data->>'label', ''), 'Someone') || ' sent their brief'
    else new.kind end;
  if new.kind like 'brief\_%' then
    v_link := v_app || '/#/briefs/' || (new.data->>'link_id');
  elsif v_kind = 'whiteboard' then
    v_link := v_app || '/#/wb/' || new.board_id
              || coalesce('?doc=' || (new.data->>'doc_id'), '?comment=' || (new.data->>'thread_id'), '');
  else
    v_link := v_app || '/#/pm/boards/' || new.board_id || coalesce('/cards/' || new.card_id, '');
  end if;
  v_msg := v_what || coalesce(': ' || v_card, '') || coalesce(' (' || v_brd || ')', '')
           || coalesce(E'\n"' || nullif(new.data->>'excerpt', '') || '"', '')
           || coalesce(E'\n' || v_link, '');
  -- Push: the card / board on the first line, what was said under it.
  v_body := concat_ws(E'\n',
              nullif(concat_ws(' · ', v_card, v_brd), ''),
              nullif(new.data->>'excerpt', ''));
  begin
    if c.user_id is not null and c.notify_whatsapp then perform public._send_whatsapp(new.user_id, 'iklipse: ' || v_msg); end if;
    if c.user_id is not null and c.notify_email then perform public._send_email(new.user_id, 'iklipse: ' || v_what, v_msg); end if;
    perform public._send_push(new.user_id,
                              case when new.kind like 'brief\_%' then 'brief'
                                   when v_kind = 'whiteboard' or (v_kind is null and new.kind like 'wb\_%') then 'miro'
                                   else 'trello' end,
                              v_what, v_body, v_link, new.id::text);
  exception when others then
    raise warning 'notification channels: %', sqlerrm;   -- never block the in-app notification
  end;
  return new;
end $$;

-- Briefs have no Trello / Miro switch: any device with push on gets them.
create or replace function public._send_push(p_user uuid, p_product text, p_title text, p_body text, p_url text, p_tag text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_url text := public._secret('push_webhook_url');
  v_sec text := public._secret('push_webhook_secret');
  v_req bigint;
begin
  if v_url is null or v_sec is null then return false; end if;
  if not exists (
    select 1 from public.push_subscription s join public.profile p on p.id = s.user_id
     where s.user_id = p_user and p.is_active
       and (case p_product when 'miro' then s.miro when 'trello' then s.trello else true end)
  ) then return false; end if;
  v_req := net.http_post(
    url     := v_url,
    body    := jsonb_build_object('user_id', p_user, 'product', p_product, 'title', left(p_title, 120),
                                  'body', left(coalesce(p_body, ''), 400), 'url', p_url, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Iklipse-Secret', v_sec));
  insert into public.outbound_message (channel, user_id, status, request_id) values ('push', p_user, 'sent', v_req);
  return true;
end $$;
revoke all on function public._send_push(uuid, text, text, text, text, text) from public;
