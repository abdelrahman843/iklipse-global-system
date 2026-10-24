-- 0117: search (0113, whatsapp-bot search.ts): a private Slack channel's
--   messages only for admins. Who may read what is still applied before
--   anything is ranked; the rest of bot_search is as 0113 made it.

create or replace function public.bot_search(
  p_query     text,
  p_embedding text,            -- the query's embedding ("[0.1, ...]"), or null: keywords only
  p_model     text,
  p_sources   text[],
  p_scope     jsonb,
  p_since     timestamptz default null,
  p_limit     int default 12
)
returns table (id bigint, source text, source_id text, part int, at timestamptz, chat_id text, account_id text, meeting_id text, place text, who text, text text, score float8)
language sql stable security definer set search_path = public, extensions as $$
  with scope as (
    select coalesce((p_scope->>'admin')::boolean, false) as admin,
           array(select jsonb_array_elements_text(coalesce(p_scope->'dms', '[]'))) as dms,
           array(select jsonb_array_elements_text(coalesce(p_scope->'mail', '[]'))) as mail,
           array(select jsonb_array_elements_text(coalesce(p_scope->'ff_accounts', '[]'))) as ff_accounts,
           array(select jsonb_array_elements_text(coalesce(p_scope->'ff_meetings', '[]'))) as ff_meetings
  ),
  -- Who may read what, before anything is ranked (find's rules, look.ts; a private Slack channel: admins only).
  readable as (
    select c.* from public.bot_search_chunk c, scope s
     where c.source = any(p_sources)
       and (p_since is null or c.at >= p_since)
       and case c.source
             when 'wa_dm' then s.admin or c.chat_id = any(s.dms)
             when 'wa_file' then s.admin or c.chat_id like '%@g.us' or c.chat_id = any(s.dms)
             when 'mail_message' then c.account_id = any(s.mail)
             when 'fireflies' then c.account_id = any(s.ff_accounts) or c.meeting_id = any(s.ff_meetings)
             when 'slack_message' then s.admin or not exists (select 1 from public.slack_channel sc where sc.channel_id = c.chat_id and sc.is_private)
             else true
           end
  ),
  q as (
    select nullif(replace(websearch_to_tsquery('simple', public._search_norm(p_query))::text, ' & ', ' | '), '')::tsquery as ts
  ),
  by_words as (
    select r.id, row_number() over (order by ts_rank(r.tsv, q.ts) desc, r.at desc nulls last) as rank
      from readable r, q
     where q.ts is not null and r.tsv @@ q.ts
     order by rank
     limit 50
  ),
  by_meaning as (
    select r.id, row_number() over (order by r.embedding <=> p_embedding::extensions.vector) as rank
      from readable r
     where p_embedding is not null and r.embedding is not null and r.model = p_model
     order by rank
     limit 50
  ),
  fused as (
    select x.id, sum(1.0 / (60 + x.rank)) as score
      from (select * from by_words union all select * from by_meaning) x
     group by x.id
  )
  select c.id, c.source, c.source_id, c.part, c.at, c.chat_id, c.account_id, c.meeting_id, c.place, c.who, c.text, f.score::float8
    from fused f join public.bot_search_chunk c on c.id = f.id
   order by f.score desc, c.at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 12), 30));
$$;
revoke all on function public.bot_search(text, text, text, text[], jsonb, timestamptz, int) from public, anon, authenticated;

notify pgrst, 'reload schema';
