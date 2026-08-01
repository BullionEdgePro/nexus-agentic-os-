-- ============================================================
-- Migration 002 — Remove the 5-tenant hard cap (ABOS Phase 0)
-- ============================================================
--
-- `organizations.slug` was created with a CHECK constraint pinning it to five
-- literal tenant slugs. That was reasonable while the platform was those five
-- businesses, but it means INSERTing a sixth tenant fails at the database
-- level — the platform is structurally incapable of onboarding anyone new.
--
-- Dropping it is the smallest possible unblock. `slug` keeps its UNIQUE
-- constraint, so slugs stay collision-free.
--
-- PAIRED CODE CHANGE (already made alongside this migration):
-- packages/governance/src/policy.ts used to decide escalation strictness from
-- a set of known-strict slugs, which meant a newly-onboarded tenant would fall
-- through to the *lenient* branch — a silent safety regression exactly when a
-- tenant is least understood. That logic is now inverted to fail safe:
-- unknown tenants are treated as strict until explicitly marked lenient.

alter table organizations drop constraint if exists organizations_slug_check;
