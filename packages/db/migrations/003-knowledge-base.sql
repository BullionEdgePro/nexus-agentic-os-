-- ============================================================
-- Migration 003 — Knowledge base (ABOS Phase 2.1)
-- ============================================================
--
-- Retrieval substrate for the Universal Knowledge Ingestion Engine. Additive
-- and idempotent; nothing here changes behaviour until a source is ingested.
--
-- WHY real[] AND NOT pgvector
-- The production database runs the stock `postgres:16-alpine` image, which has
-- no pgvector. Swapping the image of a live database is a real risk, and at
-- this volume it buys nothing: with embeddings stored L2-NORMALIZED, cosine
-- similarity is exactly the dot product, and a sequential scan over a few
-- thousand chunks is single-digit milliseconds.
--
-- The retrieval contract (packages/knowledge/src/retrieve.ts) is written so
-- that moving to pgvector later is an internal change — add the extension,
-- add a `vector` column, backfill, build an HNSW index, swap the ORDER BY.
-- Revisit when any single tenant passes ~10k chunks or p95 retrieval exceeds
-- ~100ms, whichever comes first.

-- ============================================================
-- Sources
-- ============================================================

create table if not exists knowledge_sources (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,

  -- Employee-scoped knowledge (Employee Agent Layer). NULL = tenant-wide.
  -- This is what stops one employee's SOPs leaking into another's answers.
  employee_id       uuid references employees(id) on delete cascade,

  kind              text not null check (kind in ('text', 'url', 'file', 'faq', 'sop')),
  uri               text,                    -- URL, file path, or null for inline text
  title             text not null,

  -- Change detection: re-ingesting identical content is a no-op, so a nightly
  -- re-crawl costs nothing when nothing changed.
  content_hash      text,
  version           integer not null default 1,

  status            text not null default 'pending'
                    check (status in ('pending', 'indexed', 'failed', 'stale')),
  last_indexed_at   timestamptz,
  last_checked_at   timestamptz,
  error             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_knowledge_sources_org on knowledge_sources(organization_id);
create index if not exists idx_knowledge_sources_employee on knowledge_sources(employee_id)
  where employee_id is not null;
create index if not exists idx_knowledge_sources_stale on knowledge_sources(status, last_checked_at)
  where status in ('pending', 'stale');

-- ============================================================
-- Chunks
-- ============================================================

create table if not exists knowledge_chunks (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references knowledge_sources(id) on delete cascade,

  -- organization_id and employee_id are denormalized from the source on
  -- purpose. Retrieval filters by tenant on EVERY query, and carrying the
  -- tenant on the chunk row means that filter never depends on remembering a
  -- join — the cheapest possible defence against cross-tenant leakage.
  organization_id   uuid not null references organizations(id) on delete cascade,
  employee_id       uuid references employees(id) on delete cascade,

  chunk_index       integer not null,
  content           text not null,
  token_estimate    integer not null default 0,

  -- L2-normalized embedding. Normalization at write time is what lets the
  -- similarity search be a plain dot product (see nexus_dot below).
  embedding         real[],
  embedding_model   text,

  created_at        timestamptz not null default now(),
  unique (source_id, chunk_index)
);

create index if not exists idx_knowledge_chunks_org on knowledge_chunks(organization_id);
create index if not exists idx_knowledge_chunks_source on knowledge_chunks(source_id);
create index if not exists idx_knowledge_chunks_embedded on knowledge_chunks(organization_id)
  where embedding is not null;

-- ============================================================
-- Similarity
-- ============================================================
-- Dot product of two equal-length vectors. Because stored embeddings and the
-- query embedding are both L2-normalized, this IS cosine similarity, in
-- [-1, 1]. Returns null on a length mismatch rather than silently scoring a
-- truncated comparison — a dimension mismatch means the row was embedded with
-- a different model and must not be ranked against this query at all.

create or replace function nexus_dot(a real[], b real[])
returns double precision as $$
  select case
    when a is null or b is null then null
    when array_length(a, 1) is distinct from array_length(b, 1) then null
    else (
      select coalesce(sum(a[i]::double precision * b[i]::double precision), 0)
      from generate_subscripts(a, 1) as i
    )
  end;
$$ language sql immutable parallel safe;

-- ============================================================
-- updated_at trigger
-- ============================================================

drop trigger if exists trg_knowledge_sources_updated_at on knowledge_sources;
create trigger trg_knowledge_sources_updated_at before update on knowledge_sources
  for each row execute function set_updated_at();
