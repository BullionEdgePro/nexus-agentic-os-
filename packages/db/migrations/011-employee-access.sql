-- ============================================================
-- Migration 011 — Employee sign-in
-- ============================================================
--
-- Until now there was exactly ONE credential for the whole platform:
-- NEXUS_OPERATOR_PASSWORD. Everyone who signed in saw all five businesses'
-- customer conversations — names, WhatsApp numbers, message bodies. That was
-- acceptable while the only user was the person who owns all five. It stops
-- being acceptable the moment employees are added, which is what the previous
-- change did.
--
-- This gives each employee their own credential, scoped to the one business
-- they belong to. It is also the prerequisite that finally makes row-level
-- security meaningful: RLS enforces a policy against a current user, and until
-- now every request arrived as the same user (see ARCHITECTURE §2.2).
--
-- Only the hash is stored. The code itself is shown once, when it is issued,
-- and cannot be read back — a code the operator can look up later is a code
-- sitting in a database waiting to be read by anyone who gets that far.

alter table employees add column if not exists access_code_hash text;
alter table employees add column if not exists access_code_set_at timestamptz;
alter table employees add column if not exists last_login_at timestamptz;

-- Employees sign in with their code plus an identifier they already know. Email
-- is the natural one; employee_code works for staff without an address. Both
-- are looked up case-insensitively because neither is typed carefully.
create index if not exists idx_employees_login_email
  on employees (organization_id, lower(email))
  where email is not null;

-- No backfill. An employee with a null `access_code_hash` simply cannot sign in
-- — `verifyAccessCode` returns false for a null, so this migration grants
-- nobody access and takes nothing away. Existing employee records keep working
-- exactly as before for AI-twin purposes; they just have no login until the
-- operator issues one.
