# Property Finder Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin saves SFS's Property Finder key in Nexus, and a sync engine keeps each unit's Property Finder listing in step with "wanted AND ready" — with the listing calls switched off until Property Finder's documentation arrives.

**Architecture:** Migration 111 adds sealed key columns and a fingerprint. A pure rule (`pfNextStep`, shared) decides each unit's step; a worker service runs it with an injectable client; `lib/property-finder.ts` is the only file that knows Property Finder's addresses. The board and Portal settings say where each unit and the key stand.

**Tech Stack:** Postgres (RLS), Hono, BullMQ, Next.js 14, node:test + tsx.

**Spec:** docs/superpowers/specs/2026-11-07-property-finder-connection-design.md

## Global Constraints

- Migration file `packages/db/migrations/111-a-key-for-property-finder.sql`; next migration after it is 112.
- `PF_LISTING_CALLS_READY = false` (exported from `packages/shared/src/portals/pf-sync.ts`); nothing calls Property Finder's listing API while it is false.
- Token request (provisional, in `PF_ENDPOINTS`): `POST https://auth.propertyfinder.com/auth/oauth/v1/token`, `Authorization: Basic base64(key:secret)`, `Content-Type: application/json`, body `{"scope":"openid","grant_type":"client_credentials"}`; same address for sandbox until the docs say otherwise.
- 15 s timeout per Property Finder request; Property Finder's messages trimmed to 300 characters.
- Key and secret: trimmed, `^[\x21-\x7E]{1,200}$`; sealed with `sealToken`; never in an answer, a log line or a stored message. `keyEnding` = last 4 characters of the key.
- Queue `pf-sync`; cycle every 10 minutes, job id `pf-sync-cycle`; unit job id `pf-unit-<unitId>`, delay 30 000 ms, `removeOnComplete: true, removeOnFail: true`; worker concurrency 1; heartbeat `pf-sync`, stale after 45 minutes; at most 50 units per business per cycle, oldest `synced_at` first (nulls first).
- One check per business per 10 seconds: 409 "Checking already — try again in a few seconds."
- Copy (exact): see Task 7's words table and Task 6's messages.
- CRLF files (`apps/api/src/index.ts`, `packages/db/src/index.ts`, `apps/web/lib/api.ts`) are edited with the Edit tool only.

## Review Focus

1. The secret coming back in Property Finder's error body → the stored/returned message must have the secret (and key) replaced by "•••" (Task 3 test `the secret never appears in a message, even when Property Finder echoes it`).
2. A key disconnected, or a business deactivated, while a unit job waits → the job re-reads credentials when it runs and does nothing (Task 5 test `a disconnected business is left alone`).
3. One business's refused key → the other businesses still sync (Task 5 test `a refused key stops only its own business`).
4. A unit closed while live on Property Finder → it is unpublished (Task 4 `pfUnitsToSync` includes closed units still live; Task 5 test `a closed unit comes off Property Finder`).
5. Turning the switch off and on within 30 s → one job, and a later edit is not swallowed by a finished job's id (Task 5 test asserts the unit job's options: jobId, delay, removeOnComplete/removeOnFail true).

---

### Task 1: Migration 111

**Files:**
- Create: `packages/db/migrations/111-a-key-for-property-finder.sql`
- Test: `apps/api/test/the-pf-tables.test.mjs` (DB; same setup as `the-portal-tables.test.mjs`)

**Interfaces:**
- Produces: `portal_settings.pf_key_sealed text, pf_secret_sealed text, pf_key_ending text, pf_environment text check (pf_environment in ('sandbox','live')), pf_checked_at timestamptz, pf_check_error text`; `unit_portals.remote_fingerprint text`; `unit_portals.remote_state` check `in ('live','unpublished','refused','failed')`.

- [ ] **Step 1: Write the failing test** — `the PF columns exist with their checks`: inserting `pf_environment = 'staging'` fails with check violation 23514; `remote_state = 'gone'` fails 23514; `remote_fingerprint` and all six `pf_*` columns are selectable; as `nexus_app`, `delete from portal_settings` still fails 42501.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/the-pf-tables.test.mjs` with the test DB env → FAIL (column does not exist).
- [ ] **Step 3: Write the migration** — one `begin; … commit;`, `add column if not exists`, `drop constraint if exists` before each `add constraint`; header comment in the style of 110.
- [ ] **Step 4: Apply it to the test DB and run** → PASS.
- [ ] **Step 5: Commit** `feat(pf): migration 111 — a key for Property Finder`.

### Task 2: The sync rule

**Files:**
- Create: `packages/shared/src/portals/pf-sync.ts`; Modify: `packages/shared/src/index.ts` (export it)
- Test: `apps/api/test/the-pf-sync-rule.test.mjs`

**Interfaces:**
- Produces: `PF_LISTING_CALLS_READY: boolean` (false); `type PfState = "live" | "unpublished" | "refused" | "failed"`; `type PfRemote = { ref: string | null; state: PfState | null; fingerprint: string | null }`; `type PfStep = "create" | "update" | "publish" | "unpublish" | "none"`; `pfNextStep(should: { live: boolean; fingerprint: string | null }, remote: PfRemote): PfStep`; `type PfConnection = "none" | "key-refused" | "waiting-format" | "connected"`.

- [ ] **Step 1: Write the failing tests** — one per spec §5 row: no ref → create; ref + other fingerprint → update; ref + same fingerprint + state `unpublished`/null/`failed` → publish; ref + same + `live` → none; `refused` + same fingerprint → none; `refused` + other fingerprint → update; `failed` + no ref → create; should not be live: `live` → unpublish, anything else → none; and `PF_LISTING_CALLS_READY === false`.
- [ ] **Step 2: Run** → FAIL (not exported).
- [ ] **Step 3: Implement** in the order above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pf): the sync rule`.

### Task 3: The Property Finder client

**Files:**
- Create: `apps/api/src/lib/property-finder.ts`
- Test: `apps/api/test/the-pf-client.test.mjs`

**Interfaces:**
- Consumes: `PortalListing` (shared).
- Produces: `PF_ENDPOINTS: Record<"sandbox" | "live", { token: string }>`; `type PfCredentials = { key: string; secret: string; environment: "sandbox" | "live" }`; `type PfAnswer` (spec §4); `type PfClient = { checkKey(c: PfCredentials): Promise<PfAnswer>; createListing(c, l: PortalListing): Promise<PfAnswer>; updateListing(c, ref: string, l: PortalListing): Promise<PfAnswer>; publishListing(c, ref: string): Promise<PfAnswer>; unpublishListing(c, ref: string): Promise<PfAnswer> }`; `makePfClient(fetchFn: typeof fetch = fetch): PfClient`; `pfClient = makePfClient()`.

- [ ] **Step 1: Write the failing tests** with an injected fetch recording calls:
  - `the key is checked with a client-credentials token request` — URL `PF_ENDPOINTS.live.token`, method POST, `authorization` = `Basic ` + base64(`k:s`), JSON body exactly `{"scope":"openid","grant_type":"client_credentials"}`, a `signal` passed; 200 `{access_token:"t",expires_in:1800}` → `{ ok: true }`.
  - `401 and 403 are key-refused`, `400 is refused`, `500 and a thrown fetch are unreachable`, `200 without access_token is unreachable` (message "Property Finder answered without a token").
  - `the secret never appears in a message, even when Property Finder echoes it` — 400 body `{"message":"bad secret s3cr3t for key KEY1"}` → message contains `•••`, not `s3cr3t`, not `KEY1`; messages ≤ 300 chars.
  - `listing calls are not built yet` — each of the four answers `{ ok: false, kind: "unreachable", message: "Property Finder's listing calls are not built yet." }` and never calls fetch.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** — message = body's `message` ?? `error_description` ?? `error` ?? `HTTP <status>`; redact key and secret (`split/join`) before trimming. The spec §3 token cache is NOT built here: no call uses a token until the listing calls exist, so it lands with them in phase 2b (`checkKey` always asks for a fresh token).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(pf): the Property Finder client (token request; listing calls switched off)`.

### Task 4: Records — the key, the units to sync, the board

**Files:**
- Create: `packages/db/src/pf-connection.ts`; Modify: `packages/db/src/index.ts` (export), `packages/db/src/workflow-board.ts` (UNIT_SELECT portals, toUnit, getBoard), `packages/shared/src/workflows/board.ts` (types)
- Test: `apps/api/test/the-pf-records.test.mjs` (DB)

**Interfaces:**
- Consumes: `sealToken`, `openToken`; `PfRemote`, `PfState`, `PfConnection`, `PF_LISTING_CALLS_READY`.
- Produces:
  - `savePfConnection(org: string, input: { key: string; secret: string; environment: "sandbox" | "live"; checkError: string | null }): Promise<void>` (seals, sets `pf_key_ending`, `pf_checked_at = now()`; upserts the settings row)
  - `recordPfCheck(org: string, checkError: string | null): Promise<void>`
  - `clearPfConnection(org: string): Promise<void>`
  - `pfConnectionView(org: string): Promise<{ saved: boolean; environment: "sandbox" | "live" | null; keyEnding: string | null; checkedAt: string | null; checkError: string | null }>`
  - `pfCredentials(org: string): Promise<{ key: string; secret: string; environment: "sandbox" | "live" } | null>` (null when none saved or unreadable)
  - `pfBusinesses(): Promise<{ organizationId: string; timezone: string }[]>` (active businesses with a saved key and `pf_check_error is null`; `withAllTenants`)
  - `pfUnitsToSync(org: string, limit: number): Promise<{ unitId: string; remote: PfRemote }[]>` (PF wanted, or `remote_state = 'live'` — closed units included; order `synced_at nulls first`)
  - `recordPfStep(org: string, unitId: string, r: { ref?: string; state: PfState; message: string | null; fingerprint?: string }): Promise<void>` (upsert on (unit_id, 'property_finder'), `synced_at = now()`, keeps `wanted`)
  - Board: `Board.pfConnection: PfConnection`; `BoardUnit.portals[p]` becomes `{ wanted: boolean; state: PfState | null; message: string | null; syncedAt: string | null }`.

- [ ] **Step 1: Write the failing tests** — `the key is stored sealed` (raw column ≠ key, `pfCredentials` returns it, `keyEnding` = last 4); `a check is recorded and a disconnect clears all six columns`; `pfBusinesses lists only checked keys of active businesses`; `pfUnitsToSync includes a closed unit still live and leaves out an unwanted, never-live one`, ordered nulls first, limit honoured; `recordPfStep keeps the switch and stamps synced_at`; `the board says where Property Finder stands` (`pfConnection` none → waiting-format after a checked key → key-refused after a failed check; unit portals carry state/message/syncedAt). Set `NEXUS_TOKEN_KEY` (≥ 32 chars) in the test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `pfConnection` = none (no key) | key-refused (check error) | waiting-format (`!PF_LISTING_CALLS_READY`) | connected. Update existing board fixtures/mocks in web and api tests for the new `portals` shape.
- [ ] **Step 4: Run** the new file plus `the-board-carries-the-listing`, `the-portal-records`, `the-workflow-board-records` → PASS; `npm run typecheck` → 0.
- [ ] **Step 5: Commit** `feat(pf): records for the key, the units to sync and the board`.

### Task 5: The sync job

**Files:**
- Create: `apps/api/src/services/pf-sync.ts`, `apps/api/src/queue/pf-sync-queue.ts`, `apps/api/src/queue/pf-sync-processor.ts`; Modify: `apps/api/src/worker.ts`, `apps/api/src/queue/queue-health.ts`, `packages/shared/src/schedule.ts`
- Test: `apps/api/test/the-pf-sync.test.mjs` (DB + fake client)

**Interfaces:**
- Consumes: Tasks 2–4; `publishedListings(org, ["property_finder"], today, photoUrl)`; `apiBaseUrl()`.
- Produces: `pfFingerprint(l: PortalListing): string` (sha256 hex of JSON of the listing without `updatedAt`, keys sorted); `runPfCycle(opts: { client: PfClient; ready: boolean }): Promise<{ businesses: number; steps: number; failed: number }>`; `runPfUnit(org: string, unitId: string, opts: { client: PfClient; ready: boolean }): Promise<void>`; `PF_SYNC_QUEUE = "pf-sync"`; `schedulePfSync(): Promise<void>`; `queuePfUnit(org: string, unitId: string): Promise<void>` (no-op while `!PF_LISTING_CALLS_READY`); `queuePfCycle(): Promise<void>`; `processPfSyncJob(job): Promise<void>` (`withJobHeartbeat("pf-sync", …)`; `cycle` → `runPfCycle`, `unit` → `runPfUnit`, both with `{ client: pfClient, ready: PF_LISTING_CALLS_READY }`).

- [ ] **Step 1: Write the failing tests** (fake client records calls and answers per script):
  - `nothing runs while the listing calls are not built` (`ready: false` → no client call, no row written).
  - `a ready unit is created and published in one run` (ref stored, state live, fingerprint stored).
  - `an unchanged unit is not sent again`; `a changed listing is updated` (title edit → updateListing with the ref).
  - `a unit switched off comes off`; `a closed unit comes off Property Finder`.
  - `a refusal is kept until the listing changes`; `a failure is retried next cycle`.
  - `a refused key stops only its own business` (business A key-refused → `recordPfCheck` set, A's units untouched; business B synced).
  - `a disconnected business is left alone` (`runPfUnit` after `clearPfConnection` → no call).
  - `one unit's failure does not stop the next`.
  - `the unit job waits 30 seconds and frees its id` — `queuePfUnit` with the flag forced true via an injected queue: `add("unit", {organizationId, unitId}, { jobId: "pf-unit-<id>", delay: 30000, removeOnComplete: true, removeOnFail: true })`. (Give `queuePfUnit` an optional second-form `(org, unitId, deps?: { queue?: { add: Function }; ready?: boolean })`.)
  - `pf-sync is a scheduled job` — `SCHEDULED_JOBS` includes it, `JOB_STALE_AFTER_SECONDS["pf-sync"] === 2700`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — per business: `pfCredentials`; the should-set = `publishedListings` mapped by `reference`; for each of `pfUnitsToSync(org, 50)`: `pfNextStep({ live: set.has(id), fingerprint }, remote)`; after a successful create/update call publish; answers → `recordPfStep` (`refused`/`failed` with message; `key-refused` → `recordPfCheck(org, "Property Finder refused the key: <msg>")` and stop that business). Today = business timezone (as portal-public's `todayIn`). Worker: `new Worker(PF_SYNC_QUEUE, processPfSyncJob, { connection, concurrency: 1 })`, `schedulePfSync()` at boot like the others.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → 0.
- [ ] **Step 5: Commit** `feat(pf): the sync job`.

### Task 6: The API

**Files:**
- Modify: `apps/api/src/routes/workflow-board.ts`
- Test: `apps/api/test/the-pf-door.test.mjs` (mocked `@nexus/db`, `../src/lib/property-finder.js`, `../src/queue/pf-sync-queue.js`); update mocks in `the-workflow-board-door.test.mjs` and `the-portal-door.test.mjs`

**Interfaces:**
- Consumes: Task 3 `pfClient.checkKey`; Task 4 records; Task 5 `queuePfUnit`, `queuePfCycle`.
- Produces: `GET portal-settings` adds `propertyFinder: { saved, environment, keyEnding, checkedAt, checkError, listingCallsReady }`; `PUT portal-settings/property-finder`; `POST portal-settings/property-finder/check`; `DELETE portal-settings/property-finder`.

- [ ] **Step 1: Write the failing tests** — `only an admin reaches the Property Finder key` (staff → 403 "Only an admin can change portal settings."); `a key is checked and saved` (checkKey called with trimmed values; `savePfConnection` gets `checkError: null`; answer has `propertyFinder.saved` and no `apiKey`/`apiSecret`/secret text anywhere in the body); `a refused key is saved with the refusal` (key-refused → `checkError` "Property Finder refused the key: <msg>", 200); `unreachable is saved as "Could not reach Property Finder: <msg>"`; `bad input` → 400 "Enter the API key and secret." (missing/blank/over 200/control char) and "Choose Sandbox or Live."; `check again` → 404 "No Property Finder key is saved." when none; `a second check within 10 seconds` → 409 "Checking already — try again in a few seconds."; `disconnect clears it`; `unit writes queue a Property Finder run` (PATCH unit, switch, photo add/order/remove → `queuePfUnit(org, unitId)`; a queue failure still answers 200).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — validation helper `pfKeyInput(body)`; `checkMessage(answer)`: ok → null; key-refused/refused → "Property Finder refused the key: " + message; unreachable → "Could not reach Property Finder: " + message. After a successful check `void queuePfCycle()`. Enqueue with `.catch(log)`.
- [ ] **Step 4: Run** the new file + `the-workflow-board-door` + `the-portal-door` + `a-bare-id-route-restricts-itself` + `nothing-the-server-can-do-is-unreachable` → PASS.
- [ ] **Step 5: Commit** `feat(pf): admin routes for the Property Finder key`.

### Task 7: Screens

**Files:**
- Modify: `apps/web/lib/api.ts`, `apps/web/app/deck/workflow/board/portal-settings.tsx`, `apps/web/app/deck/workflow/board/portals-section.tsx`, `apps/web/app/deck/workflow/workflow.css`
- Test: `apps/web/test/the-portal-settings.test.mjs`, `apps/web/test/the-portal-sections.test.mjs`

**Interfaces:**
- Consumes: Task 6 routes; Task 4 board fields.
- Produces: `savePfKey(slug, { apiKey, apiSecret, environment })`, `checkPfKey(slug)`, `disconnectPf(slug)` (all → `PortalSettingsData`); `PortalSettingsData.propertyFinder`; `PfSection` (exported) in portal-settings.tsx; `portalState` Property Finder words.

Card words (exact, first match wins):

| Condition | Words |
|---|---|
| not wanted, state live | Coming off Property Finder |
| not wanted | Off |
| problems | Off the portals: <first problem> |
| pfConnection none | Waiting for the Property Finder connection |
| key-refused | Property Finder refused the key — an admin can check it in Portal settings |
| waiting-format | Key saved — waiting for Property Finder's listing format |
| state live | Live on Property Finder — updated <HH:MM, D Mon> |
| state refused | Property Finder refused it: <message> |
| state failed | Could not reach Property Finder — trying again |
| otherwise | Sending to Property Finder… |

Settings words: steps "A Decision Maker opens PF Expert → Developer Resources → API Credentials → New API Key. Start with a Sandbox."; status "Connected (Sandbox) — key ending 1a2b, checked 10:42, 7 Nov" / "Connected (Live) — …" / "Property Finder refused the key: …" (the stored checkError); while `!listingCallsReady`: "Listings start going to Property Finder once its listing format is added to Nexus."; buttons "Save and check", "Check again", "Replace key", "Disconnect"; disconnect confirm "Nexus stops updating Property Finder. Listings already there stay until removed in PF Expert."; secret input `type="password"`, `autoComplete="off"`; inputs cleared after a save.

- [ ] **Step 1: Write the failing tests** — every row of the card table; `the settings show the steps and fields when no key is saved`; `a saved key shows its ending, environment and check time, never the key`; `a refused key shows the refusal`; `the secret field is a password field and is emptied after saving`; `disconnect asks first`.
- [ ] **Step 2: Run** `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/the-portal-settings.test.mjs test/the-portal-sections.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; web suite `npm test` → all pass.
- [ ] **Step 5: Commit** `feat(pf): Property Finder in Portal settings and on the card`.

### Task 8: Whole-branch check and preview

**Files:**
- Modify: `C:\CLAUDE CODE\bacora\.claude\nexus-mock\board-mock.mjs` (outside the repo: portal-settings PF endpoints, `pfConnection`, PF remote fields on units)

- [ ] **Step 1:** Full API suite with the DB (`--test-concurrency=1`), web suite, `npm run typecheck`, `npx next build` (with no dev preview running in this worktree).
- [ ] **Step 2:** Preview (launch.json `nexus-mock-api-portals` + `nexus-web-portals`): Portal settings → Property Finder section with no key; fill dummy test values from the mock (not a real key) → "Connected (Sandbox) — key ending …"; a card's Property Finder line says "Key saved — waiting for Property Finder's listing format". Screenshot.
- [ ] **Step 3: Commit** any copy fixes found in the preview.
