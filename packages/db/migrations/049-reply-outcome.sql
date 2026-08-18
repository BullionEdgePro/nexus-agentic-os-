-- The AI resolution rate is 100%, and it is 100% by construction.
--
-- Measured on production the day this was written:
--
--   conversation_metrics  12 rows, every one resolved_by = 'ai_agent'
--   messages              12 outbound from the agent
--                          4 outbound carrying the "looping in a specialist"
--                            fallback, on 2026-08-01, across 4 conversations
--
-- Those four have NO METRIC ROW AT ALL. The reason is structural rather than an
-- oversight: `recordMetricBestEffort` is called near the end of the reply
-- pipeline's `try`, and a model that throws jumps straight past it to the
-- `catch` that sends the fallback. So the only replies that get counted are the
-- ones the model managed to produce — and a rate computed over a denominator
-- that excludes every failure can only ever be 100%.
--
-- Same family as migration 019's warning about what gets left out of the bottom
-- of a fraction, and as F11's refusal to average error across horizons. Here it
-- is worse than a misleading number, because the failure it hides is one this
-- platform has actually had twice: `gemini-2.5-flash` returning 404 for new API
-- keys, and an Anthropic key with no credit. Both times every customer received
-- "I'm looping in a specialist" while every container reported healthy, and
-- there was no counter anywhere that could move.
--
-- Four values, because four different things happen to a customer and three of
-- them currently leave the same trace: none.
--
--   agent            — a model reply went out. Its token usage is on this row.
--                      What every existing row means.
--   fallback         — the model produced nothing and the platform's fallback
--                      sentence went out instead. Tokens are 0 and that is the
--                      true value, not a missing one.
--   none             — the fallback failed too. The customer received NOTHING.
--                      The worst state this platform can reach, and until now it
--                      existed only as a log line on a box whose logs were
--                      erased on every deploy.
--   agent_unrecorded — a model reply DID go out and the bookkeeping after it
--                      threw, so the usage was lost with the exception. The row
--                      exists to keep the conversation in the denominator; its
--                      token counts are not the reply's, and this value is what
--                      says so rather than a zero that looks like a measurement.
--
-- NULLABLE, AND NOT BACKFILLED. The 12 existing rows were all agent replies and
-- it would be safe to say so — but the four fallbacks cannot be reconstructed as
-- rows at all, and a column that is complete for the successes and empty for the
-- failures is more dangerous than one that is honestly unknown for both. Null
-- here means "written before this was recorded", which is exactly what it is.
alter table conversation_metrics
  add column if not exists reply_outcome text
    check (reply_outcome is null
           or reply_outcome in ('agent', 'fallback', 'none', 'agent_unrecorded'));

-- What `agent-unavailable` sweeps. Only the two states worth waking up for.
create index if not exists conversation_metrics_reply_degraded_idx
  on conversation_metrics (organization_id, recorded_at desc)
  where reply_outcome in ('fallback', 'none');

-- No grants change: the application already inserts these rows, and nothing
-- updates or deletes them.
