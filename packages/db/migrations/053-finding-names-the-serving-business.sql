-- Every finding about a routed conversation names the wrong business.
--
-- Measured on production 2026-08-19, from findings already in the table:
--
--   customer-waiting  warn  filed against zipicka, customer was sfs-international  (12 Aug)
--   customer-waiting  warn  filed against zipicka, customer was juris-prime        (17 Aug)
--
-- The mechanism is the one this platform keeps producing. All five businesses
-- answer on Zipicka's number, so a routed conversation carries
-- organization_id = zipicka with routed_organization_id naming who is actually
-- serving. The operator sweep runs `withTenant(organization.id)` per business,
-- and under RLS that conversation is visible only inside ZIPICKA's turn -- so
-- the finding is filed against Zipicka, correctly according to the row and
-- wrongly according to the customer.
--
-- WHAT THAT COSTS, both directions:
--
--   The operator console labels the finding "Zipicka", and the label is the
--   part that tells somebody who to call.
--
--   An employee session is filtered to their own organization_id, so a Juris
--   Prime employee never sees their own waiting customer, and a Zipicka
--   employee sees one they cannot help.
--
-- The 17 August finding above IS the seventeen-hour silence: a customer picked
-- Juris Prime from the triage menu, got nothing back, and the operator that
-- noticed filed it against the wrong firm.
--
-- Six of the sixteen operators read conversations: customer-waiting,
-- procedure-awaiting-review, reengagement-candidate, retrieval-unavailable,
-- intent-unclassified and handover-abandoned.
--
-- WHY A COLUMN RATHER THAN FILING IT AGAINST THE SERVING BUSINESS. Findings are
-- reconciled -- raised, touched, and RETRACTED when they no longer hold -- and
-- reconciliation is keyed on (organization_id, operator). Filing Juris Prime's
-- finding under Juris Prime would put it in reach of Juris Prime's own turn in
-- the sweep, which sees no routed conversations at all under RLS, produces an
-- empty list, and retracts the finding that had just been raised. The finding
-- must stay owned by the transaction that can see it. Which business it is
-- ABOUT is a different fact, and this is that fact.

alter table operator_findings
  add column if not exists serving_organization_id uuid references organizations(id);

-- Read on every findings query to resolve the business a finding is about, so
-- it is worth an index rather than a sequential scan per page load.
create index if not exists idx_operator_findings_serving
  on operator_findings(serving_organization_id)
  where serving_organization_id is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'operator_findings'
       and column_name = 'serving_organization_id'
  ) then
    raise exception 'operator_findings.serving_organization_id was not added';
  end if;

  -- Deliberately NOT backfilled. The column means "the sweep resolved a serving
  -- business for this finding", and no sweep before this migration did. Writing
  -- one in from the conversation now would make old rows indistinguishable from
  -- ones the fixed code produced, which is the difference between a record and
  -- a guess. Both findings above are already resolved; the next sweep files
  -- correctly and nothing needs to be repaired.
  raise notice 'operator_findings.serving_organization_id ready; existing rows deliberately left null';
end $$;
