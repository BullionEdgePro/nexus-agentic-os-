-- An acceptance says how long it is for.
--
-- ============================================================
-- WHAT WENT WRONG
-- ============================================================
--
-- Migration 061 gave a finding a dismissal: explicit, attributed, carrying a
-- reason, and lapsing "exactly when the age resets" -- that is, when the finding
-- resolves and later comes back. Its test opens by naming the risk: get the
-- lifetime wrong "and dismissal is a permanent silent mute that looks like a
-- working feature".
--
-- One predicate is right for every condition that ENDS, and is precisely a
-- permanent mute for every condition that does not. On 2026-08-25 production
-- held four standing findings and all four were accepted. The urgent one had
-- been accepted at roughly 118 hours of a customer waiting for a reply. It read
-- 142.3 hours a day later, still climbing, and could never re-surface: it had
-- been continuously true throughout, so the only clause that clears an
-- acceptance had never fired.
--
-- ============================================================
-- THE BACKFILL IS A DECISION, NOT HOUSEKEEPING
-- ============================================================
--
-- Existing acceptances get a horizon of seven days from when they were made,
-- rather than being left null, because leaving them null keeps exactly the four
-- permanent mutes this migration exists to end -- and they are the four that
-- proved the problem. Seven days rather than immediately, because a person made
-- those decisions knowingly and having a finding they accepted yesterday
-- reappear the moment this deploys would read as the platform overruling them.
--
-- Any row whose seven days have already passed comes back on the next sweep.
-- That is the intended effect and not a side effect.

alter table operator_findings
  add column if not exists dismissed_until timestamptz;

comment on column operator_findings.dismissed_until is
  'When this acceptance runs out. Null only for a row no dismissal has touched. The sweep clears the dismissal once now() passes this, which is the second of the two ways an acceptance ends -- the first being the finding resolving.';

update operator_findings
   set dismissed_until = dismissed_at + interval '7 days'
 where dismissed_at is not null
   and dismissed_until is null;

-- The sweep reads this on every reconciliation, for every business, and asks
-- only whether it has passed.
create index if not exists idx_operator_findings_dismissed_until
  on operator_findings (dismissed_until)
  where dismissed_until is not null;
