# A business's API requests run as that business — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/organizations/:slug/...` requests run under `withTenant(<that business>)`, with the
six endpoints that would break fixed or declared cross-tenant.

**Architecture:**
- `tenantContext` is mounted a second time at `/api/organizations/:slug/*`, where it sees the slug.
- `CROSS_TENANT_ROUTES` exempts three operator-only number endpoints.
- `ensureContactForServingBusiness` switches to the number's owner with `withServingTenant`.
- Two shared-contact writes go through `withContactOwner`.

**Tech Stack:** Hono 4; Postgres row-level security; node:test.

**Spec:** `docs/superpowers/specs/2026-11-03-api-tenant-scope-design.md`

## Global Constraints

- No migration.
- The mount sits directly after `app.use("/api/organizations/:slug/*", requireTenantScope)` and
  before `app.use("/api/*", tenantContext)`.
- Every `CROSS_TENANT_ROUTES` entry carries a reason that is passed to `withAllTenants`.
- DB tests:
  - env vars `AUDIT_TEST_OWNER_URL` and `AUDIT_TEST_APP_URL`;
  - ids `81818181-`, phone ids `9300xx`;
  - the shared advisory lock `20261102`;
  - clean up messages, assessments, conversations, then organizations.
- Commit locally only. API suite: only "mirror.sh is itself executable" may fail.

## Review Focus

1. **An unknown slug** still reaches the route's 404, not a 500 and not a tenant-less query.
   Pinned by an existing source test.
2. **A staff member of another business** is still refused by `requireTenantScope` before any
   context opens. Mount order is pinned in Task 1.
3. **Each declared cross-tenant route is operator-only** in its router. Checked by the reviewer.
4. **`ensureContactForServingBusiness` outside the API** (workers, no context) still writes as the
   owner (`withServingTenant` degrades to `withTenant`). Pinned in Task 1.
5. **The 7 rows that depend on trigger-kept serving columns** (spec §3). Checked by the reviewer.

---

### Task 1: Scope business requests, declare the cross-tenant three, fix C1 and C2

**Files:**
- Modify: `apps/api/src/index.ts`, `apps/api/src/middleware/tenant-context.ts`,
  `packages/db/src/contact-identity.ts`, `packages/db/src/client-book.ts`,
  `packages/leads/src/capture.ts`
- Test: `apps/api/test/a-business-request-runs-as-that-business.test.mjs`

**Interfaces:**
- Produces: `CROSS_TENANT_ROUTES: { method: string; path: RegExp; reason: string }[]` and
  `crossTenantReason(method: string, pathAfterSlug: string): string | null`, both in
  `tenant-context.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **Source:** the mount order; `CROSS_TENANT_ROUTES` names
    `whatsapp-connect`, `whatsapp-number` and `whatsapp-numbers/:id/verify`;
    `crossTenantReason` returns a reason for those three and null for `/conversations`.
  - **Database:**
    - a Hono probe app mounted as `index.ts` mounts the middleware:
      - business probe → `{ org: SERVING, scope: not "all" }`;
      - declared route and `/api/elsewhere` → scope `all`;
      - business tenant cannot see THIRD's contact;
    - C1: create, then reuse, under `withTenant(SERVING)`; outside any context, it still works;
    - C2: `assignContactOwnerIfUnowned` and `captureEmployeeLead` under `withTenant(SERVING)`.
- [ ] **Step 2: Run.** Expected: FAIL on the mount source test, the declared-route probe, C1 (an
  RLS error) and C2.
- [ ] **Step 3: Implement** per spec §4.
- [ ] **Step 4: Run** the file, then both suites and the typechecks (api, db, leads).
- [ ] **Step 5: Commit.**
  `git commit -m "A business's API requests run as that business"`
