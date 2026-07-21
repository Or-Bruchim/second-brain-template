-- Migration 0003: pgroonga-only text search fallback
-- The Cloudflare runtime (Pages functions + worker) cannot embed queries in the
-- e5-small 384-dim space (Workers AI doesn't host that model), so hybrid_search
-- fails there with a vector-dimension mismatch. text_search gives those callers
-- a lexical-only path with the same return shape; callers that can embed
-- locally (promote.mjs, the ors-brain MCP) keep using hybrid_search.
--
-- enable_seqscan is forced off inside the function: on a small table the
-- planner prefers a seq scan, and pgroonga_score() returns 0 for rows not
-- matched via the pgroonga index — which would break ranking entirely.

create or replace function text_search(
  query_text  text,
  match_count int default 50
)
returns table (
  id          text,
  note_id     text,
  title       text,
  type        text,
  content     text,
  tags        text[],
  chunk_index int,
  rrf_score   float
)
language sql stable
set enable_seqscan to off
as $$
  select c.id, c.note_id, c.title, c.type, c.content, c.tags, c.chunk_index,
    pgroonga_score(tableoid, ctid)::float as rrf_score
  from chunks c
  where c.content &@~ query_text
  order by pgroonga_score(tableoid, ctid) desc
  limit match_count;
$$;
