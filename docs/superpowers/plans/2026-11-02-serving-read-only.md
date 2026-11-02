# A serving business reads but never rewrites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under its own tenant, a business serving routed chats can update or delete no row it
does not own on `conversations`, `conversation_metrics`, `messages` and `contacts`, while every
read and 058's reply insert keep working.

**Architecture:** Migration 106 adds two owner-or-all restrictive policies per table, one for
UPDATE and one for DELETE. They AND with the existing widened permissive policies, which stay
untouched.

**Tech Stack:** Postgres 16 row-level security; node:test DB tests against a throwaway Postgres.

**Spec:** `docs/superpowers/specs/2026-11-02-serving-read-only-design.md`

## Global Constraints

- The existing `<table>_tenant_isolation` policies (054, 056, 058) are not modified.
- The owner-or-all predicate is exactly
  `organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all'`.
- 106 is one transaction (`begin; set local lock_timeout = '5s'; … commit;`) and safe to run twice.
- DB tests:
  - seed as the owner role and act as `nexus_app` in `withTenant`;
  - read the env vars `AUDIT_TEST_OWNER_URL` and `AUDIT_TEST_APP_URL`, and skip without them;
  - use ids prefix `71717171-` and phone ids `9200xx`;
  - clean up messages, assessments, then organizations.
- Commit locally only. API suite: only "mirror.sh is itself executable" may fail.

## Review Focus

1. **A contact served by several businesses**: no serving business can delete it, since that would
   cascade into the owner's and every other business's rows. Pinned in Task 1.
2. **058's reply insert** by the serving business must still work after the restrictive policies
   land. Pinned in Task 1.
3. **Cross-tenant contexts** (`withAllTenants`, the inbox's `/api/conversations/...`) must still
   update and delete. The restrictive predicate includes `tenant_scope = 'all'`. Pinned in Task 1.
4. **Existing guards** that read `pg_policies` or migration files (policy-shape, rls-verify, the
   054/055/056/058 assertions) still pass with eight extra restrictive policies. Checked by the
   full suite in Task 1.
5. **An ordinary status update by a serving business**, refused today with an error, now affects
   zero rows. Nothing relies on the error (spec §3). Pinned in Task 1 as "nothing changes".

---

### Task 1: Migration 106 and its database test

**Files:**
- Create: `packages/db/migrations/106-a-serving-business-reads-but-never-rewrites.sql`
- Test: `apps/api/test/a-serving-business-reads-but-never-rewrites.test.mjs`

**Interfaces:**
- Produces, for each table T of the four: the policies `T_owner_updates` (restrictive, for
  update, using and with check owner-or-all) and `T_owner_deletes` (restrictive, for delete, using
  owner-or-all).

- [ ] **Step 1: Write the failing tests.** Each destructive case seeds its own routed chat through a
  helper `routedChat(n)`, as the owner. The helper creates:
  - a contact owned by `OWNER`;
  - a conversation owned by `OWNER`, routed to `SERVING`;
  - an inbound message;
  - a `conversation_metrics` row.

  It returns their ids. A helper `asServing(sql, params)` runs one statement under
  `withTenant(SERVING)` and returns its `rowCount`, or `"refused"` on an RLS error.

```js
test("the migration adds owner-only updates and deletes and checks itself", () => { /* begin; lock_timeout; 8 × "as restrictive"; raise exception; commit; */ });
test("a serving business reads every routed row and still answers in the chat", db, async () => {
  // reads conversation, message, metric, contact under SERVING; inserts a reply message (058) → 1
});
test("a serving business deletes nothing it does not own", db, async () => {
  // DELETE each of the four (contact last) under SERVING → 0 each; all still there as the owner sees them
});
test("a serving business cannot take a row over", db, async () => {
  // UPDATE … SET organization_id = SERVING on each of the four → 0 each; organization_id still OWNER
});
test("a serving business's ordinary edits change nothing", db, async () => {
  // conversation status, metric tokens, message status, contact display_name → unchanged (0 or "refused")
});
test("the owner and cross-tenant work still update and delete", db, async () => {
  // under OWNER: update conversation status → 1; delete the metric → 1; under withAllTenants: delete the message → 1
});
test("106 runs twice", db, async () => { await owner.query(SQL); await owner.query(SQL); });
```

- [ ] **Step 2: Run.**
  `cd apps/api && AUDIT_TEST_OWNER_URL=… AUDIT_TEST_APP_URL=… node --import tsx --test test/a-serving-business-reads-but-never-rewrites.test.mjs`
  Expected: FAIL. The migration file does not exist.
- [ ] **Step 3: Write migration 106** per spec §5: the header in 054's style, then the transaction,
  the eight policies and the assertion.
- [ ] **Step 4: Run** the file: PASS 7/7. Then the full API suite, the web suite, a fresh replay of
  all migrations with `psql`, and a `psql` re-apply of 106.
- [ ] **Step 5: Commit.**
  `git commit -m "Migration 106: a serving business reads routed rows and never rewrites them"`
