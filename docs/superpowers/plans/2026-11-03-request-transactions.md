# A request's transaction ends the way the request did — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No code commits a request's transaction early, and a request whose handler throws rolls
back.

**Architecture:**
- `withSavepoint` in `packages/db/src/client.ts` replaces the two hand-rolled transactions.
- `tenantContext` and `webhookContext` turn Hono's `c.error` into a rollback, and still let Hono's
  500 response through.

**Tech Stack:** Hono 4; Postgres; node:test.

**Spec:** `docs/superpowers/specs/2026-11-03-request-transactions-design.md`

## Global Constraints

- An explicit response (any status) commits. Only a thrown handler error rolls back.
- `withSavepoint` throws when there is no ambient context.
- DB tests:
  - env vars `AUDIT_TEST_OWNER_URL` and `AUDIT_TEST_APP_URL`;
  - ids `91919191-`, phone ids `9400xx`;
  - the advisory lock `20261102`;
  - cleanup in try/finally.
- Commit locally only. API suite: only "mirror.sh is itself executable" may fail.

## Review Focus

1. **The double mount**: a throw under `/api/organizations/:slug/...` must roll back the outer
   (business) transaction, not just the inner one. Pinned in Task 1.
2. **A handler that catches its own error and answers 500** must keep its writes. Pinned in
   Task 1.
3. **Nested `withSavepoint`** must give each savepoint its own name. Pinned in Task 1.
4. **A thrown error must still be visible**: Hono's 500 goes out, and the error is not swallowed
   by the middleware beyond `HandlerFailed`. Checked by the reviewer.
5. **Any other own-transaction code reachable through `getPool()`.** None found besides the two;
   checked by the reviewer.

---

### Task 1: withSavepoint, the two callers, and rollback on a thrown handler

**Files:**
- Modify: `packages/db/src/client.ts`, `packages/db/src/agent-config.ts`,
  `packages/db/src/calendars.ts`, `apps/api/src/middleware/tenant-context.ts`
- Test: `apps/api/test/a-request-ends-the-way-it-went.test.mjs`

**Interfaces:**
- Produces: `withSavepoint<T>(fn: () => Promise<T>): Promise<T>`, exported from `@nexus/db`.

- [ ] **Step 1: Write the failing tests** listed in spec §4, plus:
  - a source check that neither `agent-config.ts` nor `calendars.ts` sends `begin` or `commit`;
  - nested `withSavepoint` calls both succeed.
- [ ] **Step 2: Run.** Expected: FAIL:
  - `setSystemPrompt` answers "could not be read back";
  - after `replaceBusy`, `app.current_org` is empty;
  - `withSavepoint` is undefined;
  - the throwing routes keep their contact.
- [ ] **Step 3: Implement** per spec §3.
- [ ] **Step 4: Run** the file, then both suites and the typechecks (db, api).
- [ ] **Step 5: Commit.**
  `git commit -m "A request's transaction ends the way the request did"`
