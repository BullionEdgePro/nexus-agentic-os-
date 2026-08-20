-- A finding nobody can act on teaches people to ignore findings.
--
-- The deck is built on one rule: an empty list must not read as good news
-- unless it IS good news. It says when the sweep last ran and says so bluntly
-- when the sweep has never completed, precisely so "nothing here" cannot be
-- mistaken for "nothing wrong".
--
-- Production found the inverse failure. A test message sent to the shared
-- number by the owner has been standing as an URGENT customer-waiting finding
-- for twenty-seven hours. Nobody is going to answer it, because there is no
-- customer -- and it will sit at the top of the deck, permanently urgent,
-- until the conversation is closed. Three more findings say three firms offer
-- appointments with no staff, which may well be a decision somebody has already
-- made and does not need told again every ten minutes.
--
-- A list whose top entry is permanently urgent and permanently ignorable
-- trains its reader to skip the top entry. That is a worse outcome than no
-- list, and it is the exact failure the retract half of reconciliation exists
-- to prevent -- this is the same disease arriving through a door reconciliation
-- cannot close, because these findings are TRUE. They are just accepted.
--
-- SO: ACCEPTED, NOT DELETED. A dismissed finding stays in the table, stays
-- reconciled, and stays visible in its own count. Hiding it outright would be
-- the deck lying by omission, which is the first sin restated.
alter table operator_findings
  add column if not exists dismissed_at     timestamptz,
  add column if not exists dismissed_by     text,
  add column if not exists dismissed_reason text;

-- A dismissal must lapse when the finding goes away and comes back.
--
-- This is the whole correctness question, and reconcileFindings already
-- answers it for age: a finding that had been resolved and returns is NEW
-- again, so first_seen_at is reset to now(). A dismissal has exactly the same
-- lifetime -- "I have accepted this" is about the occurrence in front of
-- somebody, not about the fingerprint forever. Accepting that three firms have
-- no staff today must not silence the same finding next March, when it would
-- mean something different.
--
-- So the upsert clears dismissed_at under the SAME predicate that resets
-- first_seen_at, and the two can never drift apart. This comment is here
-- because a future edit to one and not the other is a silent, permanent mute
-- that no test would notice unless it were looking for it -- and
-- `a-dismissal-lapses-when-the-finding-does` is looking for it.
comment on column operator_findings.dismissed_at is
  'Accepted by a person. Cleared by reconcileFindings when the finding returns from resolved, under the same predicate that resets first_seen_at. Never set by an operator.';

comment on column operator_findings.dismissed_by is
  'Session subject that accepted it. A dismissal is an act by somebody and is recorded as one.';

-- The deck reads open-and-not-dismissed on every load, per business.
create index if not exists idx_operator_findings_undismissed
  on operator_findings (coalesce(serving_organization_id, organization_id), severity, first_seen_at)
  where resolved_at is null and dismissed_at is null;

-- An operator must never be able to dismiss its own finding: the whole point is
-- that a person accepted it. reconcileFindings only ever writes dismissed_at to
-- NULL (the lapse above), never to a timestamp, and nothing else in the sweep
-- path touches these columns. Stated here because it is a property of the
-- design rather than of any one query, and the design is what gets forgotten.
