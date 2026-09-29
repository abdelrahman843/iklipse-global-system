-- ============================================================================
-- 0028_rank_between_fix.sql
--   ascii('') is 0, not null, so once `prev` ran out the lower bound became 0
--   instead of 32. Every "move to top" halved the first character until
--   chr(0) raised and the move failed (about 7 moves in a row). The lower
--   bound now falls back to 32 like the client's lexorank (MIN = 32).
-- ============================================================================

create or replace function public.rank_between(prev text, nxt text)
returns text language plpgsql immutable as $$
declare
  a text := coalesce(prev, '');
  b text := coalesce(nxt,  '');
  out text := '';
  i int := 1;
  ac int; bc int;
begin
  loop
    ac := coalesce(nullif(ascii(substr(a, i, 1)), 0), 32);
    bc := coalesce(nullif(ascii(substr(b, i, 1)), 0), 127);
    if bc - ac > 1 then
      out := out || chr((ac + bc) / 2);
      return out;
    end if;
    out := out || chr(ac);
    i := i + 1;
    if i > 32 then
      raise exception 'rank_between exhausted precision';
    end if;
  end loop;
end $$;
