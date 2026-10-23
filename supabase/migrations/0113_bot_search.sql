-- 0113: search that understands Arabic and meaning (whatsapp-bot search.ts).
--   bot_search_chunk: what was said, in pieces: WhatsApp group messages,
--     private chats with the bot, emails, Slack messages, the words read out
--     of files, and recorded meetings (Fireflies, in pieces of a few hundred
--     words). Each piece keeps what decides who may read it (the chat, the
--     mailbox, the Fireflies account or meeting), the same as find (look.ts).
--     Keywords are matched with Arabic letters made one form (أ إ آ ا, ة ه,
--     ى ي, no tashkeel); meaning is matched with an embedding (pgvector), once
--     an embedding provider is set (the EMBED_PROVIDER secret). Without one,
--     search is keywords only.
--   bot_search_queue: what's new or changed, to cut into pieces and embed in
--     the minute's run, newest first, tried again when it fails (5 times).
--     Filled by triggers on the source tables, and once here with everything
--     already there (the backfill, a few hundred a minute).
--   bot_search(...): the pieces that match, keywords and meaning together
--     (reciprocal rank fusion), only of what the asker may read: who may read
--     what is applied before anything is ranked.

create extension if not exists vector with schema extensions;

-- Arabic letters made one form, lower case, without tashkeel or tatweel: what keywords match on.
create or replace function public._search_norm(p text)
returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(translate(coalesce(p, ''), 'أإآٱةى', 'ااااهي'), '[ً-ٰٟـ]', '', 'g'));
$$;

create table if not exists public.bot_search_chunk (
  id         bigserial primary key,
  source     text not null check (source in ('wa_message', 'wa_dm', 'mail_message', 'slack_message', 'wa_file', 'fireflies')),
  source_id  text not null,               -- the row's id ("<channel>:<ts>" for Slack)
  part       int not null default 0,      -- which piece of it
  at         timestamptz,                 -- when it was said
  chat_id    text,                        -- WhatsApp: the chat (private chats and files: who may read it)
  account_id text,                        -- email: the mailbox; Fireflies: the account
  meeting_id text,                        -- Fireflies: the meeting (shared meetings)
  place      text,                        -- where, said in the answer: the group, the channel, the email's subject, the meeting
  who        text,                        -- who said it
  text       text not null,
  tsv        tsvector generated always as (to_tsvector('simple', public._search_norm(text))) stored,
  embedding  extensions.vector(1024),
  model      text,                        -- the embedding's model: another model's aren't compared
  tries      int not null default 0,
  error      text,
  unique (source, source_id, part)
);
create index if not exists bot_search_chunk_tsv_idx on public.bot_search_chunk using gin (tsv);
create index if not exists bot_search_chunk_at_idx on public.bot_search_chunk (source, at desc);
create index if not exists bot_search_chunk_todo_idx on public.bot_search_chunk (at desc) where embedding is null;
create index if not exists bot_search_chunk_vec_idx on public.bot_search_chunk using hnsw (embedding extensions.vector_cosine_ops);
alter table public.bot_search_chunk enable row level security;
-- Read and written by the whatsapp-bot function (service role) only.
revoke all on public.bot_search_chunk from anon, authenticated;

create table if not exists public.bot_search_queue (
  source    text not null,
  source_id text not null,
  at        timestamptz not null default now(),
  taken_at  timestamptz,
  tries     int not null default 0,
  error     text,
  primary key (source, source_id)
);
create index if not exists bot_search_queue_at_idx on public.bot_search_queue (at desc) where tries < 5;
alter table public.bot_search_queue enable row level security;
revoke all on public.bot_search_queue from anon, authenticated;

-- ----------------------------------------------------------- the triggers --
-- New or changed: queued (again). Gone: its pieces go too.
create or replace function public._search_enqueue()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v jsonb := to_jsonb(coalesce(new, old));
  v_source text := case tg_table_name when 'fireflies_meeting' then 'fireflies' else tg_table_name end;
  v_id text := case tg_table_name when 'slack_message' then (v->>'channel_id') || ':' || (v->>'ts') else v->>'id' end;
begin
  if tg_op = 'DELETE' then
    delete from public.bot_search_chunk where source = v_source and source_id = v_id;
    delete from public.bot_search_queue where source = v_source and source_id = v_id;
    return old;
  end if;
  insert into public.bot_search_queue (source, source_id, at)
  values (v_source, v_id, now())
  on conflict (source, source_id) do update set at = now(), taken_at = null, tries = 0, error = null;
  return new;
end;
$$;

drop trigger if exists search_queue on public.wa_message;
create trigger search_queue after insert or update of text or delete on public.wa_message for each row execute function public._search_enqueue();
drop trigger if exists search_queue on public.wa_dm;
create trigger search_queue after insert or update of text or delete on public.wa_dm for each row execute function public._search_enqueue();
drop trigger if exists search_queue on public.mail_message;
create trigger search_queue after insert or update of subject, body or delete on public.mail_message for each row execute function public._search_enqueue();
drop trigger if exists search_queue on public.slack_message;
create trigger search_queue after insert or update of text or delete on public.slack_message for each row execute function public._search_enqueue();
drop trigger if exists search_queue on public.wa_file;
create trigger search_queue after insert or update of text or delete on public.wa_file for each row execute function public._search_enqueue();
drop trigger if exists search_queue on public.fireflies_meeting;
create trigger search_queue after insert or update of title, summary, sentences or delete on public.fireflies_meeting for each row execute function public._search_enqueue();

-- What's already there: queued once, by when it was said (the newest are done first).
insert into public.bot_search_queue (source, source_id, at)
select 'wa_message', id, sent_at from public.wa_message where coalesce(text, '') <> '' on conflict do nothing;
insert into public.bot_search_queue (source, source_id, at)
select 'wa_dm', id, sent_at from public.wa_dm where coalesce(text, '') <> '' on conflict do nothing;
insert into public.bot_search_queue (source, source_id, at)
select 'mail_message', id, coalesce(sent_at, created_at) from public.mail_message on conflict do nothing;
insert into public.bot_search_queue (source, source_id, at)
select 'slack_message', channel_id || ':' || ts, coalesce(sent_at, created_at) from public.slack_message where coalesce(text, '') <> '' on conflict do nothing;
insert into public.bot_search_queue (source, source_id, at)
select 'wa_file', id, created_at from public.wa_file where coalesce(text, '') <> '' on conflict do nothing;
insert into public.bot_search_queue (source, source_id, at)
select 'fireflies', id::text, coalesce(started_at, now()) from public.fireflies_meeting on conflict do nothing;

-- ------------------------------------------------------------- the work --
-- The next ones to cut into pieces, taken for this run (another run takes others).
create or replace function public._search_take(p_limit int default 300)
returns table (source text, source_id text) language sql security definer set search_path = public as $$
  update public.bot_search_queue q set taken_at = now(), tries = q.tries + 1
   where (q.source, q.source_id) in (
     select x.source, x.source_id from public.bot_search_queue x
      where x.tries < 5 and (x.taken_at is null or x.taken_at < now() - interval '5 minutes')
      order by x.at desc
      limit greatest(1, least(coalesce(p_limit, 300), 1000))
      for update skip locked)
  returning q.source, q.source_id;
$$;
revoke all on function public._search_take(int) from public, anon, authenticated;

-- Embeddings made in the run, kept in one go: [{ "id": 1, "e": "[0.1, ...]" }].
create or replace function public._search_set_embeddings(p jsonb, p_model text)
returns int language sql security definer set search_path = public, extensions as $$
  with done as (
    update public.bot_search_chunk c set embedding = (x->>'e')::extensions.vector, model = p_model, error = null
      from jsonb_array_elements(p) x
     where c.id = (x->>'id')::bigint
    returning c.id
  )
  select count(*)::int from done;
$$;
revoke all on function public._search_set_embeddings(jsonb, text) from public, anon, authenticated;

-- ------------------------------------------------------------ searching --
-- p_scope: { admin, dms: [chat ids], mail: [mailbox ids], ff_accounts: [...], ff_meetings: [...] }, from look.ts whoAsks.
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
  -- Who may read what, before anything is ranked (find's rules, look.ts).
  readable as (
    select c.* from public.bot_search_chunk c, scope s
     where c.source = any(p_sources)
       and (p_since is null or c.at >= p_since)
       and case c.source
             when 'wa_dm' then s.admin or c.chat_id = any(s.dms)
             when 'wa_file' then s.admin or c.chat_id like '%@g.us' or c.chat_id = any(s.dms)
             when 'mail_message' then c.account_id = any(s.mail)
             when 'fireflies' then c.account_id = any(s.ff_accounts) or c.meeting_id = any(s.ff_meetings)
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
