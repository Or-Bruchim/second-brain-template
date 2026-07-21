-- Migration 0004: resize embedding 384-dim back to 1024-dim (bge-m3)
-- Switching document embeddings from local @xenova multilingual-e5-small (384-dim)
-- to Cloudflare Workers AI @cf/baai/bge-m3 (1024-dim) — the same model the worker
-- and Pages functions already use to embed queries. Before this, query vectors
-- (1024) and stored vectors (384) lived in different spaces, so hybrid_search
-- always failed on a dimension mismatch and callers silently fell back to the
-- lexical-only text_search. chunks is a derived index — safe to rebuild from
-- scratch; embeddings are repopulated by `node scripts/embed.mjs`.

-- Drop dependents
drop index if exists chunks_embedding_hnsw;
drop function if exists hybrid_search(text, vector, int, int);

-- Resize column (pgvector requires drop+add; nulls all embeddings until re-embed)
alter table chunks drop column if exists embedding;
alter table chunks add column embedding vector(1024);

-- Recreate HNSW index for 1024-dim
create index chunks_embedding_hnsw
  on chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Recreate hybrid_search for 1024-dim
create or replace function hybrid_search(
  query_text      text,
  query_embedding vector(1024),
  match_count     int  default 50,
  rrf_k           int  default 60
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
as $$
  with semantic as (
    select c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit match_count
  ),
  lexical as (
    select c.id,
      row_number() over (order by pgroonga_score(tableoid, ctid) desc) as rank
    from chunks c
    where c.content &@~ query_text
    limit match_count
  ),
  fused as (
    select coalesce(s.id, l.id) as id,
      coalesce(1.0 / (rrf_k + s.rank), 0.0)
      + coalesce(1.0 / (rrf_k + l.rank), 0.0) as rrf_score
    from semantic s
    full outer join lexical l on s.id = l.id
  )
  select c.id, c.note_id, c.title, c.type, c.content, c.tags, c.chunk_index, f.rrf_score
  from fused f
  join chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count;
$$;
