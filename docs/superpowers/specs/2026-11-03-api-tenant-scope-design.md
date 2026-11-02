# A business's API requests run as that business — design

Date: 2026-11-03 · Branch: `api-tenant-scope`, cut from `serving-read-only` (55de22b) · No migration

## 1. The problem

`tenantContext` (`apps/api/src/middleware/tenant-context.ts`) is meant to run every
`/api/organizations/:slug/...` request inside `withTenant(<that business>)`, and everything else
inside `withAllTenants`. It is mounted with `app.use("/api/*", tenantContext)`. Hono middleware on
`/api/*` never sees `:slug` (verified with Hono 4.12.31), so every API request runs with
`tenant_scope = 'all'`.

Authorisation still holds: `requireTenantScope` limits staff to their own business, and
`operatorOnly` guards the admin surfaces. But the database's second line of defence, row-level
security, scopes only the background workers. Tests pin the slug branch in source, but that branch
never runs.

## 2. What success looks like

- Every `/api/organizations/:slug/...` request runs under `withTenant(<that business>)`, so the
  database itself keeps it to that business's rows, plus what 054/056/058/105 deliberately let a
  serving business read.
- Everything else (`/api/conversations/...`, `/api/my/...`, operator surfaces, `GET
  /api/organizations`) stays cross-tenant, as today.
- No endpoint that works today breaks. The six that would (§3) are fixed or explicitly declared
  cross-tenant.

## 3. Audit of the 61 endpoints (2026-11-03)

There are 10 routers mounted at `/api/organizations`. Run under their business's tenant:

- **48 are unaffected.**
- **7 return the same rows only while the trigger-kept serving columns are current**: the inbox,
  contact detail and exports, staff leads, the employee's conversations, and labels. Those columns
  go stale only after a conversation is re-routed, which is rare (routing is sticky).
- **6 change**, for these causes:
  - **C1.** `ensureContactForServingBusiness` (`packages/db/src/contact-identity.ts`) writes the
    contact and conversation as the number's owner through a nested `withTenant(owner.id)`. Nested
    inside the business's tenant, that call does nothing, so for the four businesses that do not
    own the number the writes are refused. This breaks `POST /:slug/contacts`,
    `POST /:slug/contacts/import` and `POST /:slug/leads`.
  - **C2.** Two writes to a shared contact owned by the number's owner would then affect zero rows:
    `assignContactOwnerIfUnowned` (import's `assignTo`) and `captureEmployeeLead`'s lead-score
    update.
  - **C3.** `captureEmployeeLead`'s prior-assessment count sees only rows this business owns or
    serves, so the returning-contact signal can be lower.
  - **C4.** `assignEmployeeWhatsAppNumber`'s "free the number from anyone else who held it" step
    reaches only this business's employees. All five businesses share one WhatsApp business
    account, so two employees could end up holding one number. This breaks the operator-only
    `POST /:slug/employees/:id/whatsapp-connect`, `PATCH /:slug/employees/:id/whatsapp-number` and
    `POST /:slug/whatsapp-numbers/:id/verify`.
  - **C5.** A nested `withAllTenants` in `whatsappSendTokenForNumber` is narrowed. This has no
    effect today: connection rows are filed under the employee's own business.
- **Found, independent of this change:** `setSystemPrompt` runs its own `begin`/`commit` inside the
  request's transaction. That commits early and drops the tenant setting, so
  `PUT /:slug/agent/prompt`'s read-back sees no rows under either regime. Out of scope; reported.

## 4. Decisions taken

- **Mount `tenantContext` a second time, at `/api/organizations/:slug/*`**, directly after
  `requireTenantScope` and before the `/api/*` mount. There `c.req.param("slug")` is defined, so its
  existing branch opens `withTenant(<business>)`. The later `/api/*` mount nests inside it, and
  nesting keeps the outermost context, so the business stays authoritative. An unknown slug still
  falls through to the cross-tenant branch and the route answers 404.
- **Declared cross-tenant routes.**
  - `tenantContext` exports `CROSS_TENANT_ROUTES`: method plus a path pattern after
    `/api/organizations/:slug`, each with a stated reason. A matching business-scoped request runs
    `withAllTenants(<reason>)` instead.
  - It holds exactly C4's three operator-only number endpoints.
  - Rejected: making a nested `withAllTenants` widen. That reverses the deliberate rule that an
    inner "all" never widens a tenant.
- **C1:** `ensureContactForServingBusiness` uses `withServingTenant(owner.id, …)` instead of
  `withTenant(owner.id, …)`.
  - `withServingTenant`'s shared-number check is symmetric, so it switches to the owner on the
    same connection, checked against the data.
  - With no ambient context it degrades to `withTenant(owner.id)`, today's behaviour outside the
    API.
  - Under scope `all` it runs as today.
- **C2:** `assignContactOwnerIfUnowned`'s update and `captureEmployeeLead`'s lead-score update go
  through `withContactOwner` (serving-read-only).
- **C3: accepted.** Under a business's own tenant, the returning-contact signal counts what that
  business can see, which is what tenancy means. Cost: a staff-captured lead for someone another
  firm already scored scores a little lower.
- **C5: accepted.** No effect while connection rows sit under the employee's business. Noted for
  the reviewer.

## 5. Testing

- **Source.**
  - `index.ts` mounts `tenantContext` at `/api/organizations/:slug/*` after `requireTenantScope`
    and before `app.use("/api/*", tenantContext)`.
  - `CROSS_TENANT_ROUTES` names the three routes, each with a reason.
- **Database** (a throwaway Postgres; seed as the owner, act as `nexus_app`).
  - **Middleware**, on a small Hono app mounted exactly as `index.ts` mounts the middleware:
    - a business-scoped probe reports `app.current_org` = that business and is not scope `all`;
    - a declared cross-tenant route and a non-business route report scope `all`;
    - under the business's tenant, another business's owner-only row is invisible.
  - **C1:** under `withTenant(SERVING)`, `ensureContactForServingBusiness` for a new person on the
    shared number creates a contact owned by the number's owner and a conversation routed to
    SERVING. Run again, it reuses both.
  - **C2:** under `withTenant(SERVING)`, `assignContactOwnerIfUnowned` on a shared contact assigns
    it, and `captureEmployeeLead` writes the contact's lead score.
- **Existing guards and both suites** pass, including `tenant-context.test.mjs`.

## 6. Delivery

- Branch `api-tenant-scope`, worktree `C:\CLAUDE CODE\nexus-api-tenant-scope`. Committed locally
  only.
- Deploys after `sfs-audit`, `routed-scoring` and `serving-read-only`. No migration.
- Rollback: revert the one mount line.

## 7. Out of scope

- The `setSystemPrompt` early commit.
- Re-filing stale serving columns after a re-route.
- Routers outside `/api/organizations`.
