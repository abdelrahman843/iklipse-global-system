-- ============================================================================
-- 0030_ai_inline_images.sql
--   ai_start accepted any image URL, which OpenAI would then fetch (a way to
--   make the server reach arbitrary addresses). Only inline data: images, as
--   the app sends, are accepted now.
-- ============================================================================

create or replace function public.ai_start(p_action text, p_board uuid DEFAULT NULL::uuid, p_card uuid DEFAULT NULL::uuid, p_text text DEFAULT NULL::text, p_parts jsonb DEFAULT NULL::jsonb, p_list uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_ws      public.workspace;
  v_key     text := public.ai_key();
  v_board   uuid := p_board;
  v_sys     text;
  v_user    text;
  v_content jsonb;
  v_body    jsonb;
  v_req     bigint;
  v_id      uuid;
  v_labels  text;
  v_list    text;
  v_parts   jsonb := coalesce(p_parts, '[]'::jsonb);
  v_rules   constant text :=
    ' Write in English only, whatever language the input is in.'
    || ' Never use em dashes or en dashes; use commas, colons, parentheses or a plain hyphen instead.'
    || ' Keep facts, numbers, names, links and dates from the input exactly; never invent them.';
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
  if v_key is null then raise exception 'AI is not set up yet. An admin needs to add an OpenAI API key.'; end if;

  if (select count(*) from public.ai_request where user_id = v_uid and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'AI limit reached (60 requests per hour). Try again later.';
  end if;

  if p_text is not null and length(p_text) > 120000 then
    raise exception 'Too much text for AI (max 120,000 characters). Trim the brief or attach fewer files.';
  end if;
  if jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) > 10 then
    raise exception 'Attach at most 10 files for AI to read';
  end if;
  -- Only image and file (PDF) parts are accepted from the client.
  if exists (select 1 from jsonb_array_elements(v_parts) p where p->>'type' not in ('image_url', 'file')) then
    raise exception 'Unsupported attachment';
  end if;
  -- Images go inline (data: URLs). A web URL would make OpenAI fetch it.
  if exists (select 1 from jsonb_array_elements(v_parts) p
              where p->>'type' = 'image_url' and coalesce(p->'image_url'->>'url', '') not like 'data:%') then
    raise exception 'Images must be uploaded, not linked';
  end if;

  if p_card is not null then
    select board_id into v_board from public.card where id = p_card;
    if v_board is null then raise exception 'Card not found'; end if;
  end if;

  if p_action in ('card', 'assist') then
    if v_board is null or not public.can_edit_board(v_board) then raise exception 'Not authorised'; end if;
  elsif p_action <> 'ping' then
    raise exception 'Unknown AI action';
  end if;

  if p_action = 'card' then
    if coalesce(btrim(p_text), '') = '' and jsonb_array_length(v_parts) = 0 then
      raise exception 'Add a brief or some files first';
    end if;
    select string_agg('"' || name || '"', ', ' order by position) into v_labels
      from public.label where board_id = v_board and btrim(name) <> '';
    select title into v_list from public.list where id = p_list and board_id = v_board;

    v_sys := 'You turn a brief, notes, data and attached files into ONE well-structured task card on a project board (like Trello).'
      || ' Read everything provided, including the attached files.'
      || ' Today is ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD (Day)') || '.'
      || ' Board: "' || (select title from public.board where id = v_board) || '".'
      || coalesce(' List: "' || v_list || '".', '')
      || ' Respond with JSON only, exactly this shape:'
      || ' {"title": string, "description": string, "due_date": string|null, "start_date": string|null,'
      || ' "checklist": {"name": string, "items": [string]}|null, "labels": [string]}.'
      || ' title: short and action-oriented, max 90 characters.'
      || ' description: Markdown. Start with a 1-2 sentence summary, then only the sections that help, chosen from'
      || ' "## Goal", "## Details", "## Deliverables", "## Requirements", "## Key data", "## Notes", "## Files".'
      || ' Put important figures in bullet lists or a Markdown table. Under "## Files" list each attached file with one line on what it contains.'
      || ' due_date / start_date: "YYYY-MM-DD" only when stated or clearly implied by the input, otherwise null.'
      || ' Resolve relative dates ("next Friday", "in 2 weeks") from today. A date written without a year means its next'
      || ' occurrence on or after today, so it is never in the past unless the input says so.'
      || ' checklist: concrete next actions found in the input (3 to 12 items, each under 120 characters), or null if there are none.'
      || ' If the input is short or vague, keep the card short: do not pad it with generic steps or sections.'
      || ' labels: pick 0 to 3 that clearly fit, ONLY from this list: [' || coalesce(v_labels, '') || ']. Use [] if none fit.'
      || v_rules;
    v_user := coalesce(nullif(btrim(p_text), ''), '(No written brief. Use the attached files.)');

  elsif p_action = 'assist' then
    if coalesce(btrim(p_text), '') = '' then raise exception 'Tell the AI what to do'; end if;
    v_sys := 'You are an assistant working inside one card of a project board (like Trello). The card is below.'
      || ' Do exactly what the user asks, using the card and any attached files.'
      || ' You can prepare up to three things: a comment to post on the card, a full replacement for the card description,'
      || ' and a checklist to add. Only prepare what the request calls for.'
      || ' Respond with JSON only, exactly this shape:'
      || ' {"reply": string, "comment": string|null, "description": string|null, "checklist": {"name": string, "items": [string]}|null}.'
      || ' reply: one short sentence telling the user what you prepared (or why you could not).'
      || ' comment and description are Markdown. Comments are written as the user, concise and ready to post.'
      || ' checklist items are concrete actions, each under 120 characters.'
      || v_rules
      || E'\n\n--- CARD ---\n' || coalesce(public.ai_card_context(p_card), '');
    v_user := p_text;

  else -- ping
    v_sys := 'Reply with the single word OK.';
    v_user := 'ping';
  end if;

  -- Text first, then any image / PDF parts.
  v_content := jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_user)) || v_parts;

  v_body := jsonb_build_object(
    'model', v_ws.ai_model,
    'messages', jsonb_build_array(
      jsonb_build_object('role', 'system', 'content', v_sys),
      jsonb_build_object('role', 'user', 'content', v_content)
    ),
    'user', v_uid::text
  );
  if v_ws.ai_model like 'gpt-5%' then
    v_body := v_body || jsonb_build_object('reasoning_effort', 'low', 'max_completion_tokens', 8000);
  else
    v_body := v_body || jsonb_build_object('temperature', 0.3, 'max_completion_tokens', 3000);
  end if;
  if p_action <> 'ping' then
    v_body := v_body || jsonb_build_object('response_format', jsonb_build_object('type', 'json_object'));
  end if;

  v_req := net.http_post(
    url := 'https://api.openai.com/v1/chat/completions',
    body := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 120000
  );

  insert into public.ai_request (user_id, board_id, card_id, action, model, net_request_id)
  values (v_uid, v_board, p_card, p_action, v_ws.ai_model, v_req)
  returning id into v_id;
  return v_id;
end $function$;
