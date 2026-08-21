-- now() is fixed for a whole TRANSACTION, so a timestamp cannot order a log.
--
-- conversation_custody ordered by created_at desc. That looked obviously
-- correct and is not: Postgres freezes now() at the start of a transaction, so
-- every row written inside one carries the identical timestamp, and `order by
-- created_at desc` between them is a coin flip.
--
-- MEASURED, not theorised. A probe run against production on 2026-08-21 took a
-- conversation, toggled it, re-toggled it as a no-op, and released it -- three
-- calls, one transaction. The release was written last and came back second,
-- and the check asserting the automatic release names no actor failed against a
-- manual_toggle row. In the inbox that is a history in the wrong order, which
-- for an audit log is worse than no history: it is a confident wrong answer.
--
-- This is the same defect the customer-waiting operator carries a paragraph
-- about, learned the same way. Its note reads "created_at is not unique ... a
-- false positive produced by a coin flip, on exactly the kind of alert that has
-- to be trusted". The lesson did not travel to the next table that needed it.
--
-- WHY A SEQUENCE AND NOT A TIEBREAK ON id. Adding `, id desc` would make the
-- order deterministic and still wrong -- uuids are random, so it would produce
-- a stable arbitrary sequence rather than the real one. A bigserial is assigned
-- at INSERT, not at transaction start, so it records the order things actually
-- happened in, which is the only thing an audit log is for.
--
-- Existing rows are numbered in the order Postgres returns them. There are
-- almost none (the table is a day old and production has had no handovers since
-- it landed), and for any that exist the timestamp is all that was ever
-- recorded, so no ordering information is being invented -- only preserved.
alter table conversation_custody
  add column if not exists seq bigserial;

-- The reader asks one question -- what happened to THIS conversation, newest
-- first -- so the index carries the answer directly.
create index if not exists idx_conversation_custody_seq
  on conversation_custody (conversation_id, seq desc);

comment on column conversation_custody.seq is
  'Insertion order. THE ordering column: created_at is frozen per transaction, so several rows written in one transaction share a timestamp and cannot be ordered by it.';
