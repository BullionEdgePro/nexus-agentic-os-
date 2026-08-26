-- When a failed knowledge source should next be tried.
--
-- ============================================================
-- WHAT THIS CHANGES
-- ============================================================
--
-- `findStaleSources` retried every failed source after a flat 24 hours. The
-- comment above that constant explains why it refuses to classify provider
-- errors: the taxonomy belongs to somebody else and it rots. That reasoning is
-- right and is not being overturned.
--
-- What it did not separate is the one case where the other end TOLD US to come
-- back. A 429 and a 404 waited the same day.
--
-- Measured on 2026-08-26: the embedding provider's free tier hit its quota and
-- returned 429 for five of ABR's pages -- litigation, maritime law, property
-- law, our expertise and overview, which is most of what a law firm does. The
-- quota had cleared within the hour. Those pages were still going to serve
-- stale content for another twenty-three, on a key that will reach the same
-- limit again tomorrow.
--
-- ============================================================
-- WHY A COLUMN AND NOT A CASE IN THE QUERY
-- ============================================================
--
-- The decision is made once, when the failure happens and its meaning is
-- known, rather than re-derived later by parsing a string the provider may
-- have reworded since. The reader just asks whether it is due.
--
-- Null means a row that failed before this existed, and those keep the old
-- rule. That is also what happens if the narrowing ever stops recognising
-- anything: it fails back to the flat cooldown rather than to nothing.

alter table knowledge_sources
  add column if not exists retry_after timestamptz;

comment on column knowledge_sources.retry_after is
  'When a failed source is due for another attempt. Written at failure time — an hour for a rate limit, a day for anything else. Null means it failed before this column existed, and the flat 24-hour rule applies.';

-- The re-index sweep asks for due sources on every cycle, across every
-- business, and orders healthy ones first.
create index if not exists idx_knowledge_sources_retry_after
  on knowledge_sources (retry_after)
  where retry_after is not null;
