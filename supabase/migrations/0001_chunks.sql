-- Second Brain: vector search layer
-- Replaces Cloudflare Vectorize. Git remains source of truth; this table is
-- a derived index that can be rebuilt at any time by running scripts/embed.mjs.

create extension if not exists vector;     -- pgvector 0.8.0 (HNSW)
create extension if not exists pgroonga;   -- multilingual FTS (Hebrew + English)

-- ── Table ───────────────────────────────────────────────────────────────────
create table if not exists chunks (
  id           text primary key,        -- "{note_id_slugified}__{chunk_index}"
  note_id      text not null,           -- e.g. "inbox/2026-05-01-1234567890"
  title        text,
  type         text,                     -- inbox / notes / journal / meetings / ...
  chunk_index  int  not null default 0,
  chunk_total  int  not null default 1,
  content      text not null,            -- full chunk text (not truncated)
  tags         text[] default '{}',
  embedding    vector(1024),            -- bge-m3 via Cloudflare Workers AI
  updated_at   timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Dense vector search (cosine, HNSW — fast approximate)
create index if not exists chunks_embedding_hnsw
  on chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Sparse / full-text search — PGroonga handles Hebrew natively
create index if not exists chunks_pgroonga
  on chunks using pgroonga (content)
  with (tokenizer = 'TokenNgram("unify_symbol", false, "unify_digit", false)');

-- note_id lookup (for graph expansion and note-level delete)
create index if not exists chunks_note_id
  on chunks (note_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Access only via service_role (Worker / Pages Functions server-side).
-- No direct client access needed — site is passphrase-gated at app layer.
alter table chunks enable row level security;

-- ── Hybrid search RPC ────────────────────────────────────────────────────────
-- Combines pgvector (dense) + PGroonga (sparse) via Reciprocal Rank Fusion.
-- Returns up to match_count candidates; caller reranks and slices to final k.
--
-- Usage: select * from hybrid_search(
--   'מה יש לי על RAG?',
--   '[0.12, -0.34, ...]'::vector(1024),
--   50,   -- match_count
--   60    -- rrf_k
-- );
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
    -- dense vector search: order by cosine distance
    select
      c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit match_count
  ),
  lexical as (
    -- sparse FTS via PGroonga (multilingual, handles Hebrew)
    select
      c.id,
      row_number() over (order by pgroonga_score(tableoid, ctid) desc) as rank
    from chunks c
    where c.content &@~ query_text
    limit match_count
  ),
  fused as (
    -- Reciprocal Rank Fusion
    select
      coalesce(s.id, l.id) as id,
      coalesce(1.0 / (rrf_k + s.rank), 0.0)
      + coalesce(1.0 / (rrf_k + l.rank), 0.0) as rrf_score
    from semantic s
    full outer join lexical l on s.id = l.id
  )
  select
    c.id,
    c.note_id,
    c.title,
    c.type,
    c.content,
    c.tags,
    c.chunk_index,
    f.rrf_score
  from fused f
  join chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count;
$$;
