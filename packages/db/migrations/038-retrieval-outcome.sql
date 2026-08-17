-- Write down whether retrieval actually worked.
--
-- On 15 August 2026 Google's embedding endpoint returned 503 for an extended
-- period. The reply path handled it correctly — the tool catches the error and
-- returns `found: false` with a note, so the agent keeps answering, says it
-- cannot confirm the detail, and governance still applies. No customer got a
-- fabricated answer and nothing crashed.
--
-- And nobody would ever have known. `found: false` because the provider was
-- down is indistinguishable, after the fact, from `found: false` because
-- nothing matched. Both leave the same trace: none. Had that outage lasted a
-- week, every customer would have been politely deflected and the only signal
-- would have been a quiet drop in answer quality that no dashboard shows.
--
-- That is this platform's signature failure, one layer out: not an error, but a
-- degradation wearing the same face as normal operation. An operator cannot
-- watch for it until something records it, which is what this column is for.
--
--   hit    — retrieval ran and returned passages the agent could use
--   miss   — retrieval ran and honestly found nothing relevant
--   failed — retrieval could not run: provider error, timeout, no key
--
-- Nullable on purpose. Most replies never call search_knowledge at all, and a
-- default of 'miss' would invent a retrieval that never happened — turning a
-- silence into a measurement, which is the mistake this column exists to end.
alter table conversation_metrics
  add column if not exists retrieval_outcome text
    check (retrieval_outcome is null or retrieval_outcome in ('hit', 'miss', 'failed'));

-- The operator asks "how many failures for this business recently", so it reads
-- by organisation and time, and only failures are worth an index.
create index if not exists conversation_metrics_retrieval_failed_idx
  on conversation_metrics (organization_id, recorded_at desc)
  where retrieval_outcome = 'failed';
