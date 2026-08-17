-- Something to answer from when the embedding provider is unreachable.
--
-- Retrieval on this platform has exactly one external dependency and no way
-- round it: `embedQuery` calls Google, and if that call fails the whole lookup
-- fails. Migration 038 made that failure VISIBLE — `retrieval_outcome = 'failed'`
-- — and an operator now watches for it. What neither of them did was make the
-- knowledge base readable while it lasts.
--
-- It has lasted twice already. A 503 run on 15 August, and a connect timeout to
-- 172.217.113.4 that aborted `self-check` on its first attempt. Both times the
-- reply path behaved correctly and every customer was told a colleague would
-- confirm — while the answer sat in `knowledge_chunks.content` as plain text
-- that nothing was willing to read without a vector.
--
-- Postgres can read it. Full-text search needs no provider, no key and no
-- network, and the corpus is 393 chunks across five businesses.
--
-- WHAT THIS IS NOT. It is not a second ranker and it never runs beside the real
-- one. A semantic miss is a designed refusal — `DEFAULT_MIN_SCORE` exists so the
-- agent is not handed noise to paraphrase — and quietly retrying it with a
-- weaker matcher would convert that refusal into a keyword guess. This index is
-- read on one condition only: the embedding call did not come back.
--
-- 'english' rather than 'simple', measured rather than assumed. 12 of the 393
-- chunks contain Arabic, all but one of them ABR's. The english config still
-- tokenises Arabic correctly — the snowball stemmer only reshapes latin
-- script — so choosing it costs the Arabic nothing and earns the other 381
-- chunks stemming, which is what makes "attestation" find "attest".
create index if not exists knowledge_chunks_content_fts_idx
  on knowledge_chunks using gin (to_tsvector('english', content));

-- A fourth thing retrieval can do, and it needed its own name.
--
--   hit      — the real thing: semantic search ran and returned passages
--   miss     — semantic search ran and honestly found nothing
--   failed   — could not run at all, and nothing was found to answer from
--   degraded — could not run, and KEYWORD SEARCH ANSWERED INSTEAD
--
-- Folding 'degraded' into 'hit' would have been the tempting shape, and it is
-- the one this platform has been burned by: the reply went out grounded, so it
-- looks like a hit, and the outage disappears from the record entirely. The
-- fallback would then have switched off the alarm that argued for it.
--
-- Folding it into 'failed' is wrong in the other direction. The customer was
-- answered. Counting that as a deflection overstates the harm and makes the one
-- number an operator reads — how badly is this outage hurting anyone — useless.
--
-- So: four values, because there are four different things that happen to a
-- customer, and this column exists precisely because two of them used to be
-- indistinguishable after the fact.
alter table conversation_metrics
  drop constraint if exists conversation_metrics_retrieval_outcome_check;

alter table conversation_metrics
  add constraint conversation_metrics_retrieval_outcome_check
  check (retrieval_outcome is null
         or retrieval_outcome in ('hit', 'miss', 'failed', 'degraded'));

-- 038's index covered 'failed' alone, which was the complete set of unhealthy
-- states on the day it was written. `retrieval-unavailable` now sweeps for both,
-- and an index that answers half the predicate would have the planner scan the
-- table while looking like it was being used.
create index if not exists conversation_metrics_retrieval_unhealthy_idx
  on conversation_metrics (organization_id, recorded_at desc)
  where retrieval_outcome in ('failed', 'degraded');

drop index if exists conversation_metrics_retrieval_failed_idx;

-- No grants change. The application role already reads `knowledge_chunks` and
-- writes `conversation_metrics`; this migration adds a way to read and a value
-- to write, not a table.
