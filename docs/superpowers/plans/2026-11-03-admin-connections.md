# Admin Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin connects everything a staff member can (WhatsApp Business, Gmail, business email, TikTok, Facebook, Instagram) for a business they pick, through the same screens and server code.

**Architecture:** Each admin gets one "seat" per business — an ordinary `employees` row linked by `admin_id` (migration 108). Every `/api/connections` route resolves its owner through one async `ownerFor(c, { create })`, which for an admin turns `?business=<slug>` into the seat; the staff code path then runs unchanged. Three reliability rules: a line held by a person wins (inbound routing, Bulk), a live shared line is never given to one person, and seats are never auto-assigned.

**Tech Stack:** Postgres 16 migrations, Hono API (TypeScript), Next.js 14 web; node:test + tsx; DB tests against a throwaway Postgres.

**Spec:** `docs/superpowers/specs/2026-11-03-admin-connections-design.md`

## Global Constraints

- Migration number 108; idempotent (`if not exists`), checks itself with a `do $$ … raise exception` block like 029.
- Seat: `employee_code` = `admin-` + first 8 characters of the admin id; job title `Admin`; no `access_code_hash`; full name and email from the admin account.
- Copy: `Choose which business to connect for.` (400), `Business not found.` (404), the live-shared-line refusal reuses the Team screen's words: `That is the shared company number — assigning it would send every customer to one person.`
- Staff behaviour, responses and redirects are unchanged.
- DB tests use the throwaway Postgres: `AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55436/nexus`, `AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55436/nexus`, advisory lock 20261102 like the other DB tests; full API suite with `--test-concurrency=1`.
- Edit CRLF files (`apps/api/src/index.ts`, `packages/db/src/index.ts`) with the Edit tool, never `sed -i`.
- Commit locally only; push and deploy only on the owner's "Deploy it".

## Review Focus

1. **An admin who already has a staff record in that business with the same email** — the seat is that record (linked), never a second "Atif Ali" on the Team list. → Task 1 test.
2. **Two admins, same business** — each gets their own seat; neither can take over the other's linked record. → Task 1 test.
3. **The old shared line reconnected by a person** — inbound reaches the person and Bulk shows it once, as theirs, in no other business. → Tasks 3 and 4 tests.
4. **An admin opening Connections with no business chosen or a stale slug** — a clear message and the picker, not a crash or an empty "nothing connected" that looks final. → Tasks 2 and 5 tests.
5. **An OAuth return for an admin's seat** — lands on `/deck/connections` (which an admin can open), not `/deck/my-clients`. → Task 2 test.

---

### Task 1: The seat — migration 108 and the database helpers

**Files:**
- Create: `packages/db/migrations/108-an-admin-has-a-seat-in-a-business.sql`, `packages/db/src/admin-seats.ts`
- Modify: `packages/db/src/employees.ts` (add `admin_id` to `EmployeeRow`, `EMPLOYEE_COLUMNS`, `toEmployee`), `packages/shared/src/types.ts` (`Employee.adminId: string | null`), `packages/db/src/index.ts` (export)
- Test: `apps/api/test/an-admin-has-a-seat.test.mjs` (new)

**Interfaces:**
- Produces: `findAdminSeat(adminId: string, organizationId: string): Promise<Employee | null>`; `ensureAdminSeat(admin: { id: string; fullName: string; email: string }, organizationId: string): Promise<Employee>`; `Employee.adminId`.

- [ ] **Step 1: Write the failing tests** — source checks always run; DB cases skip without the URLs:
  - "the migration links a seat to its admin, once per business": file has `admin_id uuid references admins(id) on delete set null` and a unique index on `(organization_id, admin_id) where admin_id is not null`, and raises if the column is missing.
  - DB "a seat is made once and found after": `ensureAdminSeat(A, org)` twice → same id; `employee_code` `admin-<A.id.slice(0,8)>`, `job_title` 'Admin', `access_code_hash` null, `admin_id` A.id; `findAdminSeat(A.id, org)` returns it; `findAdminSeat(A.id, otherOrg)` null.
  - DB "an admin already on the team is linked, not duplicated": an active employee in org with email `ATIF@example.com` → `ensureAdminSeat({…, email: "atif@example.com"})` returns that employee's id with `admin_id` set; the org still has one row with that email.
  - DB "a record linked to another admin is never taken over": employee linked to admin B with A's email → A gets a new seat.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/an-admin-has-a-seat.test.mjs` (without the URLs) — Expected: FAIL (migration file missing).
- [ ] **Step 3: Implement** the migration, the column mapping, and `admin-seats.ts` (runs as the app inside `withTenant(organizationId)` like other employee writes; link-or-create in one statement order: linked row → same-email unlinked active row (`update … set admin_id`) → insert).
- [ ] **Step 4: Run** with the test DB (`bash <scratchpad>/adminconn-pg.sh <worktree>` first, which applies 108) and without — Expected: PASS / DB cases skipped; `npx tsc --noEmit -p packages/db` clean.
- [ ] **Step 5: Commit** — `"An admin has a seat in a business: migration 108"`

### Task 2: Connections resolve an admin's seat

**Files:**
- Modify: `apps/api/src/routes/connections.ts` (replace `ownerOf` with `ownerFor`; the GET listing; the three `back` redirects)
- Test: `apps/api/test/an-admin-connects-like-staff.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `findAdminSeat`, `ensureAdminSeat`.
- Produces: `ownerFor(c: Context, opts: { create: boolean }): Promise<{ organizationId: string; employeeId: string | null } | { error: string; status: 400 | 403 | 404 }>` (exported for the test); GET `/api/connections` for an admin returns `{ connections, providers, businesses: Array<{ slug: string; name: string }>, business: string | null }` (staff responses unchanged, no `businesses` key).

- [ ] **Step 1: Write the failing tests** (Hono app with a stub scope; DB cases need the test DB):
  - "staff resolve to themselves, unchanged": scope employee → `{ organizationId, employeeId }`.
  - "an admin names the business": operator scope with `adminId` and `?business=<slug>` → the seat when one exists; `create: true` makes it (`findAdminSeat` non-null after); `create: false` with no seat → `{ error: "Nothing is connected for this business yet.", status: 404 }` — never `employeeId: null`, which means the business's own Facebook/Instagram here. The GET listing handles a missing seat itself: empty `connections`, the usual `providers`, `businesses`, `business`.
  - "no business, or an unknown one, says so": operator, no `business` → 400 `Choose which business to connect for.`; unknown slug → 404 `Business not found.`; operator without `adminId` → 403 (the old message).
  - "an admin's sign-in returns to Connections": source check — each `back` picks `/deck/connections` when the state's employee is a seat, else `/deck/my-clients`.
- [ ] **Step 2: Run** — Expected: FAIL (`ownerFor` not exported).
- [ ] **Step 3: Implement** — all 15 call sites use `ownerFor`; listing, reads and deletes pass `create: false` (a missing seat reads as nothing connected / nothing to delete); `/tiktok/start`, `startFacebookLogin`, `/gmail/start`, `/imap/connect`, `/whatsapp/connect`, `POST /whatsapp/history` pass `create: true`. The admin's `businesses` list is `listOrganizations()` mapped to `{ slug, name }`.
- [ ] **Step 4: Run** the file and the full API suite (`--test-concurrency=1`) — Expected: PASS (mirror.sh only failure).
- [ ] **Step 5: Commit** — `"Connections: an admin connects for a business they pick"`

### Task 3: A line held by a person wins — inbound routing and the shared-line refusal

**Files:**
- Modify: `apps/api/src/queue/processor.ts:655-670` (person before business), `apps/api/src/services/whatsapp-connect.ts` (refuse a live shared line)
- Test: `apps/api/test/a-line-held-by-a-person-wins.test.mjs` (new)

**Interfaces:**
- Produces: `sharedLineRefusal(phoneNumberId: string): Promise<string | null>` in `whatsapp-connect.ts` — the Team screen's words when some business's own line is that id and it is not retired, else null.

- [ ] **Step 1: Write the failing tests**:
  - DB "a business's live line cannot be connected to a person": org with line `930101` not retired → `sharedLineRefusal("930101")` returns the copy; after inserting it into `retired_whatsapp_numbers` → null; an unknown id → null.
  - Source "inbound asks who holds the line before which business owns it": in `processor.ts`, `findEmployeeByPhoneNumberId(phoneNumberId)` appears before `findOrganizationByPhoneNumberId(phoneNumberId)` in the inbound function, and a held line goes to `handleStaffNumberMessage`.
  - Source: `connectWhatsAppNumber` calls `sharedLineRefusal` before `saveConnection`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — in the inbound function: `const staffOwner = await findEmployeeByPhoneNumberId(phoneNumberId); if (staffOwner) { await handleStaffNumberMessage(…); return; }` then the organization branch as today (rewrite its comment: the Team screen and the connect flow refuse a live shared line, so a held line is always a person's). In `connectWhatsAppNumber`, after the number is known and before anything is stored, return `{ error }` when `sharedLineRefusal` says so.
- [ ] **Step 4: Run** the file and the full API suite — Expected: PASS.
- [ ] **Step 5: Commit** — `"A line held by a person wins; a live shared line stays the business's"`

### Task 4: Bulk shows a held line once; seats are never auto-assigned

**Files:**
- Modify: `apps/api/src/routes/admin-bulk.ts` (`numbersOf`), `apps/api/src/services/availability.ts` (candidates)
- Test: `apps/api/test/a-line-held-by-a-person-wins.test.mjs` (extend)

- [ ] **Step 1: Write the failing tests**:
  - Source "Bulk does not offer the business's own number when a person holds it": `numbersOf` pushes the business's own number only when no employee in the list has that `whatsappPhoneNumberId`.
  - Source "a seat is never auto-assigned": the auto-assign candidate filter includes `!employee.adminId`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** both one-line rules with a comment each.
- [ ] **Step 4: Run** the full API suite — Expected: PASS.
- [ ] **Step 5: Commit** — `"Bulk lists a held line once; an admin's seat is never auto-assigned"`

### Task 5: The admin's Connections screen

**Files:**
- Modify: `apps/web/lib/nav.tsx` (Connections for both roles), `apps/web/lib/api.ts` (`setConnectionsBusiness`, every `/api/connections` path through `connectionsPath`), `apps/web/app/deck/my-clients/connections.tsx` (picker), `apps/web/app/deck/connections/page.tsx` (intro copy for both), `apps/web/app/deck/team/team-workspace.tsx` + `team-directory.tsx` ("Admin" label)
- Test: `apps/web/test/an-admin-connects-like-staff.test.mjs` (new)

**Interfaces:**
- Consumes: Task 2's GET shape (`businesses`, `business`).
- Produces: `setConnectionsBusiness(slug: string | null): void`, `connectionsPath(path: string): string` (adds `business=<slug>` when set, `?` or `&` as needed).

- [ ] **Step 1: Write the failing tests**:
  - "Connections is in both sidebars": the nav item has neither `staffOnly` nor `operatorOnly`.
  - "an admin's calls name the business": `connectionsPath("/api/connections/gmail/start")` → unchanged when unset; after `setConnectionsBusiness("sfs-international")` → `…/gmail/start?business=sfs-international`; a path with `?` gets `&business=`; every `request("/api/connections` in `api.ts` goes through `connectionsPath` (source count = 0 raw).
  - "the picker shows only for an admin": render the panel's picker component `BusinessPicker({ businesses, value, onChange })` → a labelled `<select>` "Connect for" with each business; the panel source shows it only when `businesses` is present, remembers the choice in `localStorage` (`nexus-connections-business`, try/catch), and with no choice shows "Choose a business to connect your accounts for." instead of the cards.
  - "a seat says Admin on Team": both Team views show `Admin` for a member with `adminId`.
- [ ] **Step 2: Run** `npm --prefix apps/web test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** web suite + `npx tsc --noEmit -p apps/web` — Expected: PASS, clean.
- [ ] **Step 5: Commit** — `"Connections for admins: pick a business, connect like staff"`

### Task 6: See it in the browser

Local preview with a mock API (copy `nexus-mock-api` pattern: `/api/me`, `/api/connections` returning the admin shape with two businesses, staff shape), signed in as admin and as staff, 1280 and 375 px, Cream and Warm Night:
- [ ] Admin: Connections in the sidebar; picker; no choice → the prompt; choice → the cards; calls carry `business`.
- [ ] Staff: no picker, page as before.
- [ ] Fix anything found test-first; both suites green; commit `"Admin connections: fixes from the browser check"`.

## Deploy (after the owner's "Deploy it")

Merge `admin-connections` into main in a throwaway worktree, test, push; on the VPS: `git pull` → `backup-db.sh` → `psql` 108 as the owner (ON_ERROR_STOP) → schema-drift-check → `deploy.sh` → build-check. Then the owner connects +971 50 480 5436 from Connections (Meta's window, the code on that phone) and fixes the payment method in Meta Business Suite.
