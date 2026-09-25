-- =============================================================================
-- 0014 — AI assistant (OpenAI), Trello/Atlassian-Intelligence style.
--
-- Architecture (no edge function needed):
--   * The OpenAI key lives in Supabase Vault. It is write-only from the app:
--     admins can set/replace/remove it, nobody can read it back.
--   * Clients never talk to OpenAI. They call ai_start(), which checks the
--     caller's rights, builds the prompt server-side from DB data, and queues
--     the HTTP call with pg_net (sent after commit, so no statement timeout).
--   * Clients then poll ai_poll(id) until the answer arrives.
--   * The workspace admin turns AI on/off and picks the model (workspace row).
--   * Output is only ever a suggestion: nothing is written to cards until the
--     user accepts it through the normal, permission-checked write paths.
-- =============================================================================

create extension if not exists pg_net;

-- pg_net must not be callable by app users (it would let anyone make the
-- database send arbitrary HTTP requests).
revoke all on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;
revoke all on all tables in schema net from public, anon, authenticated;

-- ------------------------------------------------------------ settings --
alter table public.workspace
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists ai_model text not null default 'gpt-4o-mini';

do $$ begin
  alter table public.workspace add constraint workspace_ai_model_chk
    check (ai_model in ('gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini', 'gpt-5'));
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ requests --
create table if not exists public.ai_request (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profile(id) on delete cascade,
  board_id          uuid references public.board(id) on delete cascade,
  card_id           uuid references public.card(id) on delete cascade,
  action            text not null,
  mode              text,
  model             text not null,
  net_request_id    bigint,
  status            text not null default 'pending' check (status in ('pending', 'done', 'error')),
  result            jsonb,
  error             text,
  prompt_tokens     int,
  completion_tokens int,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index if not exists ai_request_user_idx on public.ai_request(user_id, created_at desc);

alter table public.ai_request enable row level security;
drop policy if exists ai_request_own on public.ai_request;
create policy ai_request_own on public.ai_request for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- No insert/update/delete policies: only the security-definer functions write.

-- ------------------------------------------------------------ key mgmt --
create or replace function public.ai_set_key(p_key text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select id into v_id from vault.secrets where name = 'openai_api_key';
  if p_key is null or btrim(p_key) = '' then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
    return;
  end if;
  if btrim(p_key) !~ '^sk-[A-Za-z0-9_\-]{20,}$' then
    raise exception 'That does not look like an OpenAI API key (it should start with sk-)';
  end if;
  if v_id is null then
    perform vault.create_secret(btrim(p_key), 'openai_api_key', 'OpenAI key for the AI assistant');
  else
    perform vault.update_secret(v_id, btrim(p_key));
  end if;
end $$;
revoke all on function public.ai_set_key(text) from public, anon;
grant execute on function public.ai_set_key(text) to authenticated;

create or replace function public.ai_key()
returns text language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'openai_api_key' limit 1;
$$;
revoke all on function public.ai_key() from public, anon, authenticated;

-- What the app needs to know. Only admins see the key hint and usage.
create or replace function public.ai_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ws public.workspace;
  v_key text := public.ai_key();
  v_out jsonb;
begin
  select * into v_ws from public.workspace where id = '00000000-0000-0000-0000-000000000001';
  v_out := jsonb_build_object(
    'enabled', coalesce(v_ws.ai_enabled, false),
    'configured', v_key is not null,
    'available', coalesce(v_ws.ai_enabled, false) and v_key is not null,
    'model', v_ws.ai_model
  );
  if public.is_admin() then
    v_out := v_out || jsonb_build_object(
      'key_hint', case when v_key is null then null else '…' || right(v_key, 4) end,
      'requests_30d', (select count(*) from public.ai_request where created_at > now() - interval '30 days'),
      'tokens_30d', (select coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0)
                     from public.ai_request where created_at > now() - interval '30 days')
    );
  end if;
  return v_out;
end $$;
grant execute on function public.ai_status() to authenticated;

-- ------------------------------------------------------------ prompts --
create or replace function public.ai_card_context(p_card uuid)
returns text language sql stable security definer set search_path = public as $$
  select concat_ws(E'\n',
    'Card title: ' || c.title,
    'List: ' || l.title,
    'Board: ' || b.title,
    case when c.due_date is not null then 'Due: ' || to_char(c.due_date, 'YYYY-MM-DD') ||
      case when c.due_completed then ' (completed)' else '' end end,
    'Description:' || E'\n' || coalesce(nullif(left(c.description, 6000), ''), '(none)'),
    (select 'Checklists:' || E'\n' || string_agg(
        '- [' || case when i.completed then 'x' else ' ' end || '] ' || cl.name || ': ' || i.text, E'\n'
        order by cl.position, i.position)
       from public.checklist cl join public.checklist_item i on i.checklist_id = cl.id
      where cl.card_id = c.id),
    (select 'Recent comments (oldest first):' || E'\n' || string_agg(x.line, E'\n' order by x.created_at)
       from (select cm.created_at, '- ' || p.display_name || ': ' || left(cm.body, 800) as line
               from public.comment cm join public.profile p on p.id = cm.author_id
              where cm.card_id = c.id order by cm.created_at desc limit 30) x)
  )
  from public.card c
  join public.list l on l.id = c.list_id
  join public.board b on b.id = c.board_id
  where c.id = p_card;
$$;
revoke all on function public.ai_card_context(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ start --
-- p_action: 'write'      — rewrite text (p_mode: improve|fix|shorten|expand|summarize|action_items)
--           'checklist'  — checklist items for a card
--           'summary'    — summary of a whole card (description, checklist, comments)
--           'board'      — board plan from a goal (p_text)
--           'ping'       — admin connection test
create or replace function public.ai_start(
  p_action text,
  p_board  uuid default null,
  p_card   uuid default null,
  p_text   text default null,
  p_mode   text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_ws    public.workspace;
  v_key   text := public.ai_key();
  v_board uuid := p_board;
  v_sys   text;
  v_user  text;
  v_json  boolean := false;
  v_body  jsonb;
  v_req   bigint;
  v_id    uuid;
  v_lang  constant text := ' Always answer in the same language as the user''s content (for example Arabic stays Arabic).';
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.profile where id = v_uid and is_active) then
    raise exception 'Account is inactive';
  end if;

  select * into v_ws from public.workspace where id = '00000000-0000-0000-0000-000000000001';
  if p_action = 'ping' then
    if not public.is_admin() then raise exception 'Admin only'; end if;
  elsif not coalesce(v_ws.ai_enabled, false) then
    raise exception 'AI is turned off for this workspace';
  end if;
  if v_key is null then raise exception 'AI is not set up yet — an admin needs to add an OpenAI API key'; end if;

  -- Fair-use limit per person.
  if (select count(*) from public.ai_request where user_id = v_uid and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'AI limit reached (60 requests per hour). Try again later.';
  end if;

  if p_text is not null and length(p_text) > 12000 then
    raise exception 'Text is too long for AI (max 12,000 characters)';
  end if;

  if p_card is not null then
    select board_id into v_board from public.card where id = p_card;
    if v_board is null then raise exception 'Card not found'; end if;
  end if;

  if p_action in ('write', 'checklist') then
    -- Output goes into the card, so the caller must be able to edit it.
    if v_board is null or not public.can_edit_board(v_board) then raise exception 'Not authorised'; end if;
  elsif p_action = 'summary' then
    if p_card is null or public.board_access(v_board) is null then raise exception 'Not authorised'; end if;
  elsif p_action = 'board' then
    if not public.can_create_board() then raise exception 'Not authorised'; end if;
  elsif p_action <> 'ping' then
    raise exception 'Unknown AI action';
  end if;

  if p_action = 'write' then
    if coalesce(nullif(btrim(p_text), ''), '') = '' then raise exception 'Nothing to work with — write something first'; end if;
    v_sys := 'You are a writing assistant inside a project-management app (Trello-like). '
      || 'You receive the text of a card description in Markdown. '
      || case coalesce(p_mode, 'improve')
           when 'improve' then 'Rewrite it to be clearer and more professional. Keep the meaning, facts, names, links and Markdown structure.'
           when 'fix' then 'Fix spelling, grammar and punctuation only. Change nothing else.'
           when 'shorten' then 'Make it noticeably shorter while keeping every important fact, decision and link.'
           when 'expand' then 'Expand it into a fuller, well-structured description (goal, details, acceptance criteria where it makes sense). Do not invent facts, names or dates.'
           when 'summarize' then 'Summarize it in 2-5 short bullet points.'
           when 'action_items' then 'Extract the concrete action items as a Markdown task list ("- [ ] ..."). If there are none, say so in one short sentence.'
           else 'Rewrite it to be clearer.'
         end
      || ' Return only the resulting Markdown, with no preamble or closing remarks.' || v_lang;
    v_user := p_text;

  elsif p_action = 'checklist' then
    v_json := true;
    v_sys := 'You break work down into checklists inside a project-management app. '
      || 'From the card below, produce a practical checklist of 3 to 10 concrete, actionable steps, in logical order, each under 120 characters. '
      || 'Do not repeat steps that already exist in the card''s checklists. '
      || 'Respond with JSON only: {"name": "<short checklist name>", "items": ["step", "..."]}.' || v_lang;
    v_user := public.ai_card_context(p_card);

  elsif p_action = 'summary' then
    v_sys := 'You summarize cards in a project-management app. From the card below write a brief status summary in Markdown: '
      || 'one sentence on what the card is about, then short bullets for progress (use the checklist), open questions or blockers, and next steps (use the comments). '
      || 'Max ~120 words. No preamble.' || v_lang;
    v_user := public.ai_card_context(p_card);

  elsif p_action = 'board' then
    if coalesce(nullif(btrim(p_text), ''), '') = '' then raise exception 'Describe what the board is for'; end if;
    v_json := true;
    v_sys := 'You design Trello-style boards. From the user''s goal, produce a ready-to-use board: '
      || '3 to 6 lists that reflect the workflow (e.g. stages or phases), each with 2 to 6 concrete starter cards. '
      || 'Card descriptions are optional, one or two sentences, and must not invent names or dates. '
      || 'Respond with JSON only: {"title": "...", "description": "...", "lists": [{"title": "...", "cards": [{"title": "...", "description": "..."}]}]}.' || v_lang;
    v_user := p_text;

  else -- ping
    v_sys := 'Reply with the single word OK.';
    v_user := 'ping';
  end if;

  v_body := jsonb_build_object(
    'model', v_ws.ai_model,
    'messages', jsonb_build_array(
      jsonb_build_object('role', 'system', 'content', v_sys),
      jsonb_build_object('role', 'user', 'content', v_user)
    ),
    'user', v_uid::text
  );
  if v_ws.ai_model like 'gpt-5%' then
    v_body := v_body || jsonb_build_object('reasoning_effort', 'low', 'max_completion_tokens', 6000);
  else
    v_body := v_body || jsonb_build_object('temperature', 0.4, 'max_completion_tokens', 2000);
  end if;
  if v_json then
    v_body := v_body || jsonb_build_object('response_format', jsonb_build_object('type', 'json_object'));
  end if;

  v_req := net.http_post(
    url := 'https://api.openai.com/v1/chat/completions',
    body := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 90000
  );

  insert into public.ai_request (user_id, board_id, card_id, action, mode, model, net_request_id)
  values (v_uid, v_board, p_card, p_action, p_mode, v_ws.ai_model, v_req)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.ai_start(text, uuid, uuid, text, text) from public, anon;
grant execute on function public.ai_start(text, uuid, uuid, text, text) to authenticated;

-- ------------------------------------------------------------ poll --
create or replace function public.ai_poll(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r       public.ai_request;
  v_res   record;
  v_body  jsonb;
  v_text  text;
  v_data  jsonb;
  v_err   text;
begin
  select * into r from public.ai_request where id = p_id and user_id = auth.uid();
  if r.id is null then raise exception 'Request not found'; end if;

  if r.status = 'pending' then
    select status_code, content, timed_out, error_msg into v_res
      from net._http_response where id = r.net_request_id;

    if not found then
      if r.created_at < now() - interval '2 minutes' then
        update public.ai_request set status = 'error', error = 'The AI took too long to answer. Try again.', finished_at = now()
         where id = r.id returning * into r;
      end if;
    elsif coalesce(v_res.timed_out, false) or v_res.status_code is null then
      update public.ai_request set status = 'error',
             error = case when v_res.timed_out then 'The AI took too long to answer. Try again.' else 'Could not reach OpenAI.' end,
             finished_at = now()
       where id = r.id returning * into r;
    else
      begin
        v_body := v_res.content::jsonb;
      exception when others then
        v_body := null;
      end;

      if v_res.status_code <> 200 then
        v_err := case v_res.status_code
          when 401 then 'OpenAI rejected the API key. An admin needs to update it.'
          when 403 then 'This OpenAI key is not allowed to use the selected model.'
          when 404 then 'The selected model is not available for this OpenAI key.'
          when 429 then coalesce(
              case when 'insufficient_quota' in (v_body #>> '{error,code}', v_body #>> '{error,type}')
                     or v_body #>> '{error,code}' = 'credit_balance_exhausted'
                   then 'The OpenAI account has no credit left. An admin needs to add billing at platform.openai.com.' end,
              'OpenAI rate limit reached. Try again in a minute.')
          else 'OpenAI error (' || v_res.status_code || '): ' || left(coalesce(v_body #>> '{error,message}', 'unknown'), 200)
        end;
        update public.ai_request set status = 'error', error = v_err, finished_at = now()
         where id = r.id returning * into r;
      else
        v_text := v_body #>> '{choices,0,message,content}';
        if r.action in ('checklist', 'board') then
          begin
            v_data := v_text::jsonb;
          exception when others then
            v_data := null;
          end;
        end if;

        if v_text is null or (r.action in ('checklist', 'board') and v_data is null) then
          update public.ai_request set status = 'error', error = 'The AI returned an unexpected answer. Try again.', finished_at = now()
           where id = r.id returning * into r;
        else
          update public.ai_request
             set status = 'done',
                 result = case when v_data is not null then v_data else to_jsonb(btrim(v_text)) end,
                 prompt_tokens = (v_body #>> '{usage,prompt_tokens}')::int,
                 completion_tokens = (v_body #>> '{usage,completion_tokens}')::int,
                 finished_at = now()
           where id = r.id returning * into r;
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object('status', r.status, 'result', r.result, 'error', r.error);
end $$;
revoke all on function public.ai_poll(uuid) from public, anon;
grant execute on function public.ai_poll(uuid) to authenticated;

-- ------------------------------------------------------------ apply board --
-- Creates a board from an (AI-generated, user-reviewed) plan in one go.
create or replace function public.create_board_from_plan(
  p_plan jsonb,
  p_visibility public.board_visibility default 'workspace'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_board uuid;
  v_list  uuid;
  v_uid   uuid := auth.uid();
  v_ln    int := 0;
  v_cn    int;
  l       jsonb;
  c       jsonb;
  v_title text := left(btrim(coalesce(p_plan->>'title', '')), 120);
begin
  if v_title = '' then raise exception 'Board title is required'; end if;
  -- create_board checks can_create_board().
  v_board := public.create_board(v_title, nullif(left(btrim(coalesce(p_plan->>'description', '')), 1000), ''), null, p_visibility);

  for l in select value from jsonb_array_elements(coalesce(p_plan->'lists', '[]'::jsonb)) with ordinality t(value, n) where n <= 12 order by n loop
    continue when btrim(coalesce(l->>'title', '')) = '';
    -- Letters+digits only, so the order is the same under any collation and
    -- in the client's lexorank (later moves insert between these).
    v_ln := v_ln + 1;
    insert into public.list (board_id, title, position)
    values (v_board, left(btrim(l->>'title'), 120), 'h' || lpad(v_ln::text, 3, '0'))
    returning id into v_list;

    v_cn := 0;
    for c in select value from jsonb_array_elements(coalesce(l->'cards', '[]'::jsonb)) with ordinality t(value, n) where n <= 20 order by n loop
      continue when btrim(coalesce(c->>'title', '')) = '';
      v_cn := v_cn + 1;
      insert into public.card (board_id, list_id, title, description, position, created_by)
      values (v_board, v_list, left(btrim(c->>'title'), 300),
              nullif(left(btrim(coalesce(c->>'description', '')), 4000), ''), 'h' || lpad(v_cn::text, 3, '0'), v_uid);
    end loop;
  end loop;

  return v_board;
end $$;
revoke all on function public.create_board_from_plan(jsonb, public.board_visibility) from public, anon;
grant execute on function public.create_board_from_plan(jsonb, public.board_visibility) to authenticated;
