-- Migration 055 put a uuid cast inside a policy, and an unset tenant is ''.
--
-- `current_setting('app.current_org', true)::uuid = any (served_organization_ids)`
--
-- `withAllTenants` sets ONLY `app.tenant_scope = 'all'`. It never sets
-- `app.current_org`, deliberately -- a cross-tenant unit of work has no current
-- organisation. So inside it that setting is the empty string, and casting ''
-- to uuid raises:
--
--   invalid input syntax for type uuid: ""
--
-- WHICH IT DID NOT ALWAYS DO, and that is the worse half. Whether the cast is
-- reached depends on how the planner orders the OR branches, so the same policy
-- threw for one cross-tenant query and returned rows for another. `rls-verify`
-- caught it on its baseline read within minutes of 055 going out; a plain
-- `select count(*) from contacts` under the same context succeeded. A security
-- policy whose behaviour depends on a query plan is not a policy anybody can
-- reason about.
--
-- THE EXISTING POLICIES NEVER HAD THIS because they compare the other way
-- round: `organization_id::text = current_setting(...)`, casting the COLUMN to
-- text rather than the SETTING to uuid. '' is a perfectly good text value that
-- matches nothing.
--
-- An array cannot be compared that way without casting it, so this uses
-- `nullif(..., '')` instead: an unset tenant becomes NULL, `NULL = any (...)`
-- is NULL, and a NULL branch in an OR is simply not true. No exception, and the
-- same answer the text comparison gives.

alter table contacts enable row level security;
drop policy if exists contacts_tenant_isolation on contacts;
create policy contacts_tenant_isolation on contacts
  using (
    organization_id::text = current_setting('app.current_org', true)
    or nullif(current_setting('app.current_org', true), '')::uuid = any (served_organization_ids)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- WHY THERE IS NO PROBE HERE
-- ------------------------------------------------------------
--
-- The first version of this file ended with a DO block that set app.current_org
-- to '', read from contacts, and announced that it "returned 15 rows instead of
-- raising". It also announced that ABR sees 15 contacts, which is the number
-- ABR must NOT see -- and both statements were meaningless for the same reason.
--
-- Migrations run as `nexus`, the OWNER. The owner bypasses row-level security
-- unconditionally (migration 018 says so, and deliberately does not set FORCE
-- ROW LEVEL SECURITY). So the policy expression is never evaluated here: the
-- cast cannot raise, the array is never consulted, and a probe in this file
-- reports the same thing whether the policy is correct, broken, or absent.
--
-- A check that cannot fail is worse than no check, because it reads as
-- verification. The real one belongs where the application role is: rls-verify
-- connects as `nexus_app` and is what caught this within minutes of 055 going
-- out. Measured there after applying:
--
--   cross-tenant, no current_org   15 rows, no exception
--   scoped to abr                   1 row  -- its own served contact, and nothing else
