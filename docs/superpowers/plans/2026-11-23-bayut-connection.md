# Bayut Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Units ticked for Bayut or dubizzle on the Workflow Board are created, published, updated and taken down on Bayut through its Profolio API, with the card showing Bayut's real state.

**Architecture:** A Bayut connection beside the Property Finder one (same shape, Property Finder untouched): pure rules and the unit→listing mapping in `@nexus/shared`, records in `@nexus/db` (migration 113), one client file, a BullMQ queue `bayut-sync` (10-minute cycle + per-unit job), admin routes for the token and agent links, a staff route for the Bayut location search, and the screens.

**Tech Stack:** TypeScript, Hono (API), Postgres with RLS (`withTenant` / `withAllTenants`), BullMQ on Redis, Next.js (web), node:test (`.test.mjs`, tsx).

**Spec:** `docs/superpowers/specs/2026-11-23-bayut-connection-design.md` (Bayut facts: `docs/reference/bayut-profolio-api.md`). Read both before any task.

## Global Constraints

- Base URL `https://api.bayut.com/v1`; headers `Authorization: Bearer <token>`, `Accept: application/json`, and `Content-Type: application/json` on bodies.
- The token never appears in an API answer, a log line, an error message, a test fixture that is committed as real, or the web bundle. Bayut's messages are trimmed to 300 characters, with the token replaced by `•••`.
- Optional Bayut fields are **left out**, never sent as `null` or `""` (Bayut rejects empty optional fields).
- No automated test ever reaches the network: the client takes an injected `fetch`.
- At most 40 Bayut calls per business per minute (sync + location search), counted in Redis; 429 stops that business until `retry_after` passes.
- Nexus never publishes a portal twice within 24 hours, never re-publishes a `pending` portal, and never re-publishes on its own after Bayut takes a listing off (§9 of the spec).
- Every new table/column: tenant policy as migrations 110–112, every revoke by name. Migration file `packages/db/migrations/113-a-unit-goes-on-bayut.sql`; `schema.sql` is not edited (migrations are applied by hand, as 110–112).
- Staff-facing words are copied from the spec's §11 table exactly.
- Comments follow the house style: a dated header comment saying what and why, and `Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §n`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no deploy.

## Review Focus

1. A unit unticked (or its permit expiring) while Bayut still shows it `draft`/`pending` → it must be removed, not left to go live later (Task 2 test "a pending or draft listing comes off when no longer wanted").
2. A token for another Bayut account saved over a Sandbox one → every Bayut/dubizzle switch goes off and the old ids are cleared (Task 4 test "another account turns every Bayut and dubizzle switch off").
3. A second publish of the same portal within a day (a loop, a double run) → refused by the rule (Task 2 test "never published twice within 24 hours").
4. Bayut's error text that echoes the request (including the token) → token blanked out (Task 5 test "the token never comes back in a message").
5. A unit's agent not linked to a Bayut user, or no Bayut location → switch refused in words, and the job never sends it (Task 1 `bayutProblems` tests + Task 6 test "a unit Bayut cannot take is never sent").

---

### Task 1: The Bayut listing — mapping and readiness (shared)

**Files:**
- Create: `packages/shared/src/portals/bayut-listing.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `apps/api/test/the-bayut-listing.test.mjs`

**Interfaces:**
- Produces:
  - `type BayutPortal = "bayut" | "dubizzle"`; `const BAYUT_PORTALS: readonly BayutPortal[]`
  - `const BAYUT_CATEGORY: Record<PropertyType, string | null>` — apartment `apartments`, villa `villas`, townhouse `townhouses`, penthouse `penthouse`, office `offices`, shop `shops`, warehouse `warehouses`, land `residential-plots`, other `null`
  - `const BAYUT_AMENITY_TITLES: Record<Amenity, string[]>` — Bayut titles to match per Nexus key (e.g. `barbecue_area: ["Barbeque Area", "Barbecue Area"]`, `shared_gym: ["Shared Gym", "Gym"]`, `private_pool: ["Private Pool"]`, `maids_room: ["Maids Room", "Maid's Room"]`, `view_of_water: ["View of Water"]`, `balcony: ["Balcony or Terrace", "Balcony"]`; the builder fills the rest the same way)
  - `matchAmenities(bayut: { id: string | number; title: { en: string } }[]): Partial<Record<Amenity, string>>` — normalise titles (lower case, letters and digits only) and match
  - `type BayutContext = { tokenSaved: boolean; locationId: number | null; userId: number | null }`
  - `bayutProblems(unit: BoardUnit, ctx: BayutContext): string[]` — in order: `"a title of at most 100 characters"`, `"a property type Bayut takes"`, `"the Bayut location"`, and (only when `tokenSaved`) `"the agent linked to a Bayut user"`
  - `type BayutListingBody` (the JSON sent) and `toBayutListing(listing: PortalListing, ctx: { userId: number; locationId: number; amenityIds: Partial<Record<Amenity, string>> }): BayutListingBody`

- [ ] **Step 1: Write the failing tests** in `the-bayut-listing.test.mjs` (pure, import from `@nexus/shared`), at least:
  - `toBayutListing` of a ready rent apartment equals exactly `{ reference: "u1", user_id: 7, title: { en: "Bright 1-bed with canal view" }, description: { en: <desc> }, purpose: "rent", category: "apartments", location_id: 5013, price: 95000, rental_details: { rent_frequency: "yearly" }, area: 812, bedrooms: 1, bathrooms: 2, furnishing_status: "unfurnished", construction_status: "completed", permit_number: "71450", amenities: [{ id: "12", value: "true" }], images: [{ path: "https://x/p1.jpg", is_main: true }, { path: "https://x/p2.jpg", is_main: false }, { path: "https://x/p3.jpg", is_main: false }] }` (assert with `deepEqual`, so no extra keys).
  - a sale listing has no `rental_details` key; `bedrooms: 0` becomes `-1`; `bedrooms: null` and `bathrooms: null` leave the keys out; `semi_furnished` leaves `furnishing_status` out; an amenity with no id is left out and an empty list leaves `amenities` out.
  - `BAYUT_CATEGORY.other === null` and every other `PROPERTY_TYPES` entry maps to a slug.
  - `bayutProblems`: a 101-character title → first problem `"a title of at most 100 characters"`; `propertyType: "other"` → `"a property type Bayut takes"`; `locationId: null` → `"the Bayut location"`; `userId: null` with `tokenSaved: true` → `"the agent linked to a Bayut user"`, with `tokenSaved: false` → not listed; all present → `[]`.
  - `matchAmenities([{ id: 4, title: { en: "Barbeque Area" } }, { id: 9, title: { en: "Private Pool" } }])` → `{ barbecue_area: "4", private_pool: "9" }`.

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/api && node --import tsx --test test/the-bayut-listing.test.mjs`
  Expected: FAIL (exports missing).

- [ ] **Step 3: Implement** `packages/shared/src/portals/bayut-listing.ts` with the signatures above and export from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run to verify it passes** (same command). Expected: PASS.

- [ ] **Step 5: Commit** `feat(bayut): map a unit to Bayut's listing, and what Bayut needs first`.

---

### Task 2: The sync rule and the board's types (shared)

**Files:**
- Create: `packages/shared/src/portals/bayut-sync.ts`
- Modify: `packages/shared/src/index.ts`; `packages/shared/src/workflows/board.ts` (types below); `packages/shared/src/schedule.ts` (add `"bayut-sync"`, stale after `45 * MINUTE`)
- Test: `apps/api/test/the-bayut-sync-rule.test.mjs`

**Interfaces:**
- Produces:
  - `type BayutState = "draft" | "pending" | "live" | "unpublished" | "refused" | "failed"`
  - `type BayutRemote = { ref: string | null; fingerprint: string | null; portals: Record<BayutPortal, { state: BayutState | null; publishedAt: string | null }> }`
  - `type BayutStep = { kind: "create" } | { kind: "update" } | { kind: "publish"; portals: BayutPortal[] } | { kind: "remove"; portals: BayutPortal[] }`
  - `bayutNextSteps(should: { portals: BayutPortal[]; fingerprint: string | null }, remote: BayutRemote, now: Date): BayutStep[]` — spec §9 rules 1–8 in that order (rule 9 is applied by the job, Task 6)
  - `type BayutConnection = "none" | "token-refused" | "check-failed" | "connected"`
  - `BoardUnit.portals[p]` gains `permitComment: string | null; publishedAt: string | null` and its `state` type widens to `PfState | BayutState`; `BoardUnit` gains `bayutLocation: { id: number; name: string } | null`; `Board` gains `bayutConnection: BayutConnection` and `bayutLinked: Record<string, boolean>` (employee id → linked to a Bayut user)

- [ ] **Step 1: Write the failing tests**, one per rule, with `now = new Date("2026-11-23T12:00:00Z")`:
  - "a unit never sent is created, then published where wanted": `should {portals:["bayut","dubizzle"], fingerprint:"f1"}`, remote ref null → `[{kind:"create"},{kind:"publish",portals:["bayut","dubizzle"]}]`
  - "a changed listing is updated, then published where not live": ref `"95"`, fingerprint `"f0"`, bayut `live`, dubizzle null → `[{kind:"update"},{kind:"publish",portals:["dubizzle"]}]`
  - "an unchanged listing publishes only what is not live or pending": states `{bayut:"pending", dubizzle:"unpublished"}` → `[{kind:"publish",portals:["dubizzle"]}]`
  - "a pending publish is waited for, never repeated": bayut `pending`, publishedAt 3 days ago, wanted → `[]`
  - "a pending or draft listing comes off when no longer wanted": should `[]`, bayut `pending`, dubizzle `draft` → `[{kind:"remove",portals:["bayut","dubizzle"]}]`
  - "unwanted live comes off, unpublished stays": should `["bayut"]`, bayut `live`, dubizzle `live` → `[{kind:"remove",portals:["dubizzle"]}]`
  - "a refusal waits for a change": fingerprint `f1` both sides, bayut `refused` → `[]`; with should fingerprint `f2` → `[{kind:"update"},{kind:"publish",portals:["bayut"]}]`
  - "never published twice within 24 hours": bayut `failed`, publishedAt 2 hours ago → `[]`; 25 hours ago → publish
  - "nothing wanted and nothing held → nothing": `[]`
  - `SCHEDULED_JOBS` includes `"bayut-sync"` and `JOB_STALE_AFTER_SECONDS["bayut-sync"] === 2700`

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && node --import tsx --test test/the-bayut-sync-rule.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the file and type changes. Then `npm run typecheck -w packages/shared` must pass; fix any compile errors the widened `state` type causes in existing shared code only.
- [ ] **Step 4: Run to verify it passes** → PASS; also `node --import tsx --test test/the-pf-sync-rule.test.mjs` still PASS.
- [ ] **Step 5: Commit** `feat(bayut): what to do next for a unit on Bayut and dubizzle`.

---

### Task 3: Migration 113

**Files:**
- Create: `packages/db/migrations/113-a-unit-goes-on-bayut.sql`
- Test: `apps/api/test/the-bayut-tables.test.mjs` (static checks + DB cases against the throwaway Postgres, like `the-pf-tables.test.mjs`)

Contents (spec §4–§6, §13): `portal_settings` add `bayut_token_sealed text`, `bayut_token_ending text check (char_length <= 4)`, `bayut_agency_id integer`, `bayut_agency_name text check (char_length <= 200)`, `bayut_checked_at timestamptz`, `bayut_check_error text check (char_length <= 400)`; `property_units` add `bayut_location_id integer check (> 0)`, `bayut_location_name text check (char_length <= 300)`, and a check that both are null or both set; table `bayut_agents (organization_id uuid not null references organizations, employee_id uuid not null references employees, bayut_user_id integer not null check (> 0), bayut_user_name text check (char_length <= 200), linked_at timestamptz not null default now(), primary key (organization_id, employee_id))` with RLS + tenant policy + grants select/insert/update/delete to the app role and every other privilege revoked by name; `unit_portals` add `published_at timestamptz`, `permit_comment text check (char_length <= 300)`; replace `unit_portals_remote_state` with `remote_state in ('live','unpublished','refused','failed','draft','pending')`. Idempotent (`if not exists`, `drop constraint if exists`), like 111.

- [ ] **Step 1: Write the failing tests**: the file exists and contains each column/table name above; applied after 110–112 on the throwaway DB (`AUDIT_TEST_OWNER_URL`) it runs twice without error; as the app role in tenant A, a `bayut_agents` row of tenant B is invisible; `remote_state = 'pending'` is accepted and `'deleted'` refused; `bayut_location_id` without a name is refused.
- [ ] **Step 2: Run to verify it fails** — `cd apps/api && node --import tsx --test --test-concurrency=1 test/the-bayut-tables.test.mjs` (with `AUDIT_TEST_OWNER_URL`/`AUDIT_TEST_APP_URL` set) → FAIL.
- [ ] **Step 3: Write the migration.** Apply it to the local test DB container the same way 112 was.
- [ ] **Step 4: Run to verify it passes** → PASS; `test/the-pf-tables.test.mjs` and `test/the-portal-tables.test.mjs` still PASS.
- [ ] **Step 5: Commit** `feat(bayut): migration 113 — a Bayut token, agent links, a Bayut location`.

---

### Task 4: Bayut records (db)

**Files:**
- Create: `packages/db/src/bayut-connection.ts`
- Modify: `packages/db/src/index.ts`; `packages/db/src/workflow-board.ts` (board payload); `packages/db/src/portal-listings.ts` (unit fields + `setUnitPortal` refusal)
- Test: `apps/api/test/the-bayut-records.test.mjs`

**Interfaces:**
- Consumes: Task 1 `bayutProblems`, `BayutContext`, `BAYUT_PORTALS`; Task 2 types.
- Produces (all tenant-scoped with `withTenant` unless stated):
  - `saveBayutConnection(orgId, { token: string; agencyId: number | null; agencyName: string | null; checkError: string | null }): Promise<{ accountChanged: boolean }>` — seals with `sealToken`; when a previously saved `bayut_agency_id` differs from a new non-null one: every `unit_portals` row with portal `bayut`/`dubizzle` gets `wanted = false` and `remote_ref, remote_state, remote_message, remote_fingerprint, published_at, permit_comment, synced_at` = null, and `bayut_agents` rows are deleted
  - `recordBayutCheck(orgId, checkError: string | null)`, `clearBayutConnection(orgId)` (token columns + `bayut_agents` cleared; unit rows untouched)
  - `bayutConnectionView(orgId): Promise<{ saved; agencyName; tokenEnding; checkedAt; checkError }>` — never the token
  - `bayutToken(orgId): Promise<{ token: string; agencyId: number } | null>`
  - `bayutBusinesses(): Promise<{ organizationId: string; timezone: string }[]>` (`withAllTenants`, checked and not refused, as `pfBusinesses`)
  - `bayutAgentLinks(orgId): Promise<{ employeeId: string; bayutUserId: number; bayutUserName: string | null }[]>`
  - `linkBayutAgent(orgId, employeeId, link: { bayutUserId: number; bayutUserName: string | null } | null): Promise<boolean>` (false when the employee is not this business's)
  - `autoLinkBayutAgents(orgId, users: { id: number; name: string; email: string | null }[]): Promise<number>` — links staff whose `employees.email` equals a user's email, case-insensitive, only where no link exists; returns how many
  - `bayutListings(orgId, today: string, photoUrl: (id: string) => string): Promise<{ listing: PortalListing; portals: BayutPortal[]; userId: number; locationId: number }[]>` — `publishedListings(orgId, ["bayut","dubizzle"], …)` filtered by `bayutProblems` with the unit's location and the agent's link (`tokenSaved: true`)
  - `bayutUnitsToSync(orgId): Promise<{ unitId: string; remote: BayutRemote }[]>` — units with a `bayut` or `dubizzle` row that is wanted, or has a ref whose state is not `unpublished`
  - `recordBayutStep(orgId, unitId, portal: BayutPortal, r: { ref?: string; state: BayutState; message: string | null; fingerprint?: string; publishedAt?: Date; permitComment?: string | null })` — as `recordPfStep`, per portal, switch untouched
  - `bayutTakenOff(orgId, unitId, portal, on: string)` — `wanted = false`, `changed_by_* = null`, `changed_at = now()`, `remote_state = 'unpublished'`, `remote_message = "Bayut took it off on <on>"`
  - `setUnitPortal` additionally refuses a bayut/dubizzle switch-on with `bayutProblems` words (after `portalProblems`) using the business's token-saved flag, the unit's location and the agent's link
  - `updateUnit` accepts `bayutLocationId` + `bayutLocationName`; the board payload adds `bayutLocation`, each portal row's `permitComment` and `publishedAt`, `bayutConnection` (none / token-refused / check-failed when the error starts "Could not reach Bayut" / connected) and `bayutLinked`

- [ ] **Step 1: Write the failing tests** (DB, as the-pf-records): "the database holds no plain token" (raw column ≠ token, `bayutToken` opens it); "the view never carries the token"; "another account turns every Bayut and dubizzle switch off" (seed two units wanted with refs, save agency 2 after agency 1 → `wanted` false, refs null, `accountChanged` true; Property Finder rows untouched); "the same account keeps everything"; "staff are linked by email, case-insensitive, without replacing a link"; "a unit with no Bayut location or an unlinked agent is not listed by bayutListings and its switch-on is refused with the words"; "taken off by Bayut turns the switch off with the date"; "a pending or draft unit no longer wanted is still in bayutUnitsToSync".
- [ ] **Step 2: Run to verify it fails** — `cd apps/api && node --import tsx --test --test-concurrency=1 test/the-bayut-records.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** `npm run typecheck -w packages/db` passes.
- [ ] **Step 4: Run to verify it passes**, and `test/the-portal-records.test.mjs`, `test/the-pf-records.test.mjs` still PASS.
- [ ] **Step 5: Commit** `feat(bayut): keep the token sealed, link agents, and record Bayut's answers`.

---

### Task 5: The Bayut client

**Files:**
- Create: `apps/api/src/lib/bayut.ts`
- Test: `apps/api/test/the-bayut-client.test.mjs`

**Interfaces:**
- Consumes: Task 1 `BayutListingBody`.
- Produces:
  - `const BAYUT_API = "https://api.bayut.com/v1"`
  - `type BayutAnswer<T> = { ok: true; data: T } | { ok: false; kind: "refused" | "unreachable" | "token-refused" | "busy" | "rate-limited"; message: string; retryAfter?: number }`
  - `type BayutClient = { agencies(token): Promise<BayutAnswer<{ id: number; parentId: number | null; name: string }[]>>; users(token, agencyId): Promise<BayutAnswer<{ id: number; name: string; email: string | null }[]>>; amenities(token): Promise<BayutAnswer<{ id: string; title: { en: string } }[]>>; locations(token, q: string, city: string): Promise<BayutAnswer<{ id: number; breadcrumb: string[] }[]>>; create(token, body): Promise<BayutAnswer<{ id: string }>>; update(token, id, body): Promise<BayutAnswer<null>>; publish(token, id, portals: BayutPortal[]): Promise<BayutAnswer<null>>; remove(token, id, portals: BayutPortal[]): Promise<BayutAnswer<null>>; show(token, id): Promise<BayutAnswer<{ portals: { name: string; state: string }[]; permit: { status: string | null; comment: string | null } | null }>>; list(token, agencyId, page): Promise<BayutAnswer<{ items: { id: string; portals: { name: string; state: string }[] }[]; next: boolean }>>; rejected(token): Promise<BayutAnswer<{ id: string; reason: string }[]>> }`
  - `makeBayutClient(fetchFn = fetch): BayutClient`; `bayutClient`
- Mapping: 401/403 → `token-refused`; 409 → `busy`; 429 → `rate-limited` with `retryAfter` from the body's `retry_after` (default 60); other 4xx → `refused` with the body's `message` plus the first entry of each `errors` field (e.g. `"The given data was invalid. category: The selected category is invalid."`); 5xx, network, timeout (15 s) → `unreachable`. `create` reads `data.id` (stringified). `publish` sends `{ portals }`; `remove` sends `{ portals }` with `DELETE`. Users read both shapes (`item` and `item.data`). Paged lists read `links.next`.

- [ ] **Step 1: Write the failing tests** with a scripted fetch: request URL/method/headers for create, publish (`{"portals":["bayut","dubizzle"]}`), remove (DELETE with body), show, list (`?agency_id=12&per_page=100&page=2`), locations (`?title=Dubai%20Marina&level_2=Dubai&per_page=10`); each status mapping above; "the token never comes back in a message" (a 422 body echoing the token → message has `•••`, not the token); a 15-second timeout → `unreachable`.
- [ ] **Step 2: Run to verify it fails** — `cd apps/api && node --import tsx --test test/the-bayut-client.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `apps/api/src/lib/bayut.ts` (pattern: `lib/property-finder.ts`).
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** `feat(bayut): the only code that knows Bayut's addresses`.

---

### Task 6: The sync job

**Files:**
- Create: `apps/api/src/services/bayut-sync.ts`, `apps/api/src/queue/bayut-sync-queue.ts`, `apps/api/src/queue/bayut-sync-processor.ts`, `apps/api/src/lib/bayut-budget.ts`
- Modify: `apps/api/src/worker.ts` (worker + `scheduleBayutSync()`), `apps/api/src/queue/queue-health.ts` (add `BAYUT_SYNC_QUEUE`)
- Test: `apps/api/test/the-bayut-sync.test.mjs`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5.
- Produces:
  - `bayutFingerprint(body: BayutListingBody): string` (SHA-256 of the canonical JSON, as `pfFingerprint`)
  - `takeBayutCalls(orgId: string, n: number, deps?: { redis?; now? }): Promise<boolean>` in `bayut-budget.ts` — a Redis counter per business per minute, limit 40; `pauseBayut(orgId, seconds)` / `bayutPaused(orgId)` for 429
  - `runBayutCycle(opts: { client: BayutClient; budget?: Budget; now?: () => Date }): Promise<{ businesses; steps; failed }>`, `runBayutUnit(orgId, unitId, opts): Promise<void>`
  - `BAYUT_SYNC_QUEUE = "bayut-sync"`, `scheduleBayutSync()`, `queueBayutUnit(orgId, unitId, deps?)` (job id `bayut-unit-<unitId>`, 30 s delay), `queueBayutCycle(deps?)`
  - `processBayutSyncJob(job)` with heartbeat `bayut-sync`
- Order per business (spec §10): removals → creates/updates/publishes → states (paged list; `show` for `pending` only) → rejections. Amenity ids: read with `client.amenities` once per process per business and kept in Redis (`bayut-amenities:<orgId>`, 1 day). Rule 9: a portal held `live`/`pending` that the list shows `inactive` while wanted → `bayutTakenOff` with the business's date. After `create` the ref is recorded on both portal rows **before** publishing. A failed step stops that unit's later steps. `token-refused` → `recordBayutCheck(orgId, "Bayut refused the token: …")` and that business stops.

- [ ] **Step 1: Write the failing tests** with a scripted client and the throwaway DB, at least: "create then publish, the ref written before the publish"; "a changed listing is updated and not republished where live"; "unticked → removed, including a pending one"; "an expired permit takes it off in the same cycle even when the budget is nearly spent" (budget 1 call → the removal is the call made); "a unit Bayut cannot take is never sent" (no location); "Bayut took it off → the switch turns off with the date, no publish"; "a 422 is refused with Bayut's words and not resent until the listing changes"; "the rejected list marks the unit refused"; "a 429 pauses that business only"; "a refused token stops one business, the other goes on"; "nothing is published twice within 24 hours across two cycles"; `queueBayutUnit` adds `unit` with id `bayut-unit-u1` and delay 30000.
- [ ] **Step 2: Run to verify it fails** — `cd apps/api && node --import tsx --experimental-test-module-mocks --test --test-concurrency=1 test/the-bayut-sync.test.mjs` → FAIL.
- [ ] **Step 3: Implement** (patterns: `services/pf-sync.ts`, `queue/pf-sync-queue.ts`, `queue/pf-sync-processor.ts`; worker wiring next to the Property Finder worker).
- [ ] **Step 4: Run to verify it passes**, plus `test/the-pf-sync.test.mjs` still PASS; `npm run typecheck -w apps/api` passes.
- [ ] **Step 5: Commit** `feat(bayut): the sync job — removals first, then sends, then Bayut's answers`.

---

### Task 7: The API routes

**Files:**
- Modify: `apps/api/src/routes/workflow-board.ts`
- Test: `apps/api/test/the-bayut-door.test.mjs`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces (spec §12): `GET portal-settings` adds `bayut: { saved, agencyName, tokenEnding, checkedAt, checkError, users: [{ id, name, email }], links: [{ employeeId, bayutUserId }] }` (users from the last check, kept in Redis `bayut-users:<orgId>` for 7 days; empty when unknown); `PUT portal-settings/bayut { token }` (400 `"Enter the Bayut API token."` when blank, over 500 characters or with control characters; 409 `"Checking already — try again in a few seconds."` within 10 s; checks with `agencies` then `users`, saves, auto-links, queues a cycle when it checked out; answers `{ ...settings, accountChanged }`); `POST portal-settings/bayut/check` (404 `"No Bayut token is saved."`); `DELETE portal-settings/bayut`; `PUT portal-settings/bayut/agents/:employeeId { bayutUserId: number | null }` (404 for another business's employee; 400 for a user id not in the last-read users); `GET bayut/locations?q=` for board writers (400 under 3 characters; 409 `"Connect Bayut first."`; 429 `"Bayut is busy — try again in a minute."` when the budget is spent; answers `[{ id, name }]` with only breadcrumbs of 4+ levels, name = breadcrumb joined with `" › "`; cached a day); `PATCH units/:id` accepts `bayutLocationId` (positive integer) with `bayutLocationName` (1–300 characters), both or neither (400 `"Invalid bayutLocation."`); every place that calls `followOnPropertyFinder` also queues `queueBayutUnit` (rename to `followOnPortals`); the switch route returns the Bayut refusal words.
- Check answer words: success with an agency → `checkError` null; no agency in the answer → `"Bayut answered without an agency"`; unreachable → `"Could not reach Bayut: <message>"`; refused → `"Bayut refused the token: <message>"`.

- [ ] **Step 1: Write the failing tests** (route tests as `the-pf-door.test.mjs`): admin-only (staff 403) for every settings route; "the token is never in an answer" (PUT, GET, check); the 10-second limit; a token for another agency answers `accountChanged: true`; location search: 3-character minimum, "Connect Bayut first.", only deep results, cached second call makes no client call; unit PATCH with only an id is 400; linking an employee of another business is 404.
- [ ] **Step 2: Run to verify it fails** — `cd apps/api && node --import tsx --experimental-test-module-mocks --test --test-concurrency=1 test/the-bayut-door.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes**; `test/the-pf-door.test.mjs` and `test/the-portal-door.test.mjs` still PASS.
- [ ] **Step 5: Commit** `feat(bayut): the token, agent links and location search, admin and staff routes`.

---

### Task 8: The screens

**Files:**
- Modify: `apps/web/lib/api.ts` (client functions), `apps/web/app/deck/workflow/board/portal-settings.tsx` (Bayut and dubizzle section replaces the feed section), `apps/web/app/deck/workflow/board/portals-section.tsx` (`portalState` for bayut/dubizzle; confirm text on switch-on), `apps/web/app/deck/workflow/board/card-detail.tsx` (Bayut location picker in the Listing section); a CSS file only if a new class is needed
- Create: `apps/web/app/deck/workflow/board/bayut-location.tsx`
- Test: `apps/web/test/the-bayut-screens.test.mjs`

**Interfaces:**
- Consumes: Task 7 routes; Task 2 board types.
- Produces: `getBayutSettings`-style additions to the existing portal settings call; `saveBayutToken(slug, token)`, `checkBayutToken(slug)`, `removeBayutToken(slug)`, `linkBayutAgent(slug, employeeId, bayutUserId | null)`, `searchBayutLocations(slug, q)`; `BayutLocationPicker({ unit, board, canEdit, onPick })`; `portalState` rows exactly as spec §11.

- [ ] **Step 1: Write the failing tests** (render tests as `the-portal-sections.test.mjs` / `the-portal-settings.test.mjs`): every §11 row's words for bayut and dubizzle from a board fixture (including "Off — Bayut took it off on 21 Nov. Tick to publish again (uses credits)."); the settings section with no token shows **API token** (password input) and **Save and check**, and never renders a token; saved shows "Connected to Sfs International Real Estate - Sandbox — token ending 1a2b, checked …", **Check again**, **Replace token**, **Disconnect**, and the Agents list with each staff member's Bayut user choice; the feed address section is gone; the location picker is absent without a connection and shows the saved name when set; the switch-on confirm contains "Publishing on Bayut uses Bayut credits from SFS's account."
- [ ] **Step 2: Run to verify it fails** — `cd apps/web && node test/run.mjs` → the new file FAILS.
- [ ] **Step 3: Implement.** The replace-token flow shows the spec §4 warning when the answer says `accountChanged`.
- [ ] **Step 4: Run to verify it passes**; all web tests PASS; `npm run typecheck -w apps/web` passes.
- [ ] **Step 5: Commit** `feat(bayut): Portal settings, the card's Bayut lines and the location picker`.

---

### Task 9: Whole-branch verification

- [ ] **Step 1:** `npm run typecheck` at the root → no errors.
- [ ] **Step 2:** API suite against the throwaway DB: `cd apps/api && npm test -- --test-concurrency=1` with `AUDIT_TEST_OWNER_URL`/`AUDIT_TEST_APP_URL` → all pass except the known Windows-only `mirror.sh is itself executable`.
- [ ] **Step 3:** `cd apps/web && node test/run.mjs` → all pass.
- [ ] **Step 4:** `grep -rn "api.bayut.com" apps packages --include=*.ts` → only `apps/api/src/lib/bayut.ts`.
- [ ] **Step 5:** A fresh reviewer reads the branch diff against the spec (spec coverage, the five Review Focus lines, token handling) and findings are fixed.
- [ ] **Step 6:** Commit any fixes; no push, no deploy (the owner says "Deploy it").
