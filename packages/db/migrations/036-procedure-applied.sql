-- ============================================================
-- 036 — F10: record which procedure shaped a reply
-- ============================================================
--
-- Migrations 033 and 034 gave a business a way to say "answer this kind of
-- enquiry in this order", and a screen to decide it on. This is the column that
-- makes the decision reviewable afterwards: which procedure was actually in
-- front of the agent when it composed a reply.
--
-- ------------------------------------------------------------
-- Why a column here rather than two counters over there
-- ------------------------------------------------------------
--
-- `procedures.times_applied` and `times_succeeded` already exist (033). The
-- obvious implementation is to increment them from the reply path — and it is
-- the wrong one, for the reason this codebase has written down twice already:
-- "a rollup that double-counts on re-run stays plausible while being wrong, and
-- a plausible wrong number is this system's signature failure."
--
-- An incrementing counter cannot be recomputed, cannot be audited against
-- anything, and drifts silently the first time a reply path is retried, a job
-- runs twice, or a message is reprocessed. Worse, it could never answer the
-- question anybody actually has — "is this procedure working?" — because the
-- conversations behind the number would not be identifiable.
--
-- So the fact is recorded ONCE, on the metric row for the reply it shaped, and
-- both counters are DERIVED from it by `rollUpProcedureOutcomes`. That makes
-- them recomputable, auditable back to specific conversations, and impossible
-- to double-count.
--
-- ------------------------------------------------------------
-- What gets stamped, and the bias this deliberately avoids
-- ------------------------------------------------------------
--
-- The stamp means "this procedure was in the prompt when the reply was
-- composed" — INCLUDING replies that governance then blocked and escalated to a
-- human.
--
-- Stamping only the replies that went out as the agent's own would look tidier
-- and would quietly destroy the measurement: "ended without a human" would then
-- be true of nearly every stamped conversation by construction, because the
-- escalations had been excluded from the denominator. A success rate that
-- cannot go down is not a measurement, and it would read as the feature working
-- perfectly from its first day.
--
-- `on delete set null` rather than cascade: nothing deletes a procedure today
-- (033 and 034 grant no DELETE), but if one ever is removed, losing the
-- analytics row along with it would delete evidence about conversations that
-- really happened.

alter table conversation_metrics
  add column if not exists procedure_id uuid references procedures(id) on delete set null;

-- Partial: the overwhelming majority of metric rows carry no procedure, and the
-- only query that reads this column asks for the ones that do.
create index if not exists conversation_metrics_procedure_idx
  on conversation_metrics (procedure_id)
  where procedure_id is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'conversation_metrics' and column_name = 'procedure_id'
  ) then
    raise exception 'conversation_metrics.procedure_id was not added';
  end if;

  -- The counters are derived from this column from now on. Anything already in
  -- them was written by nothing — no writer ever existed — but resetting is
  -- still the honest starting point rather than trusting a number with no
  -- provenance.
  update procedures set times_applied = 0, times_succeeded = 0
   where times_applied <> 0 or times_succeeded <> 0;

  raise notice 'F10: a reply now records the procedure that shaped it.';
end $$;
