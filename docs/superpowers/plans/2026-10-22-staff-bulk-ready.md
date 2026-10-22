# Staff Bulk WhatsApp — Ready and Reliable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any staff member allowed to send can see what stands between them and a campaign, the platform puts templates on newly connected numbers by itself, and a failing campaign stops itself.

**Architecture:** Additive changes on the existing staff-campaign path: a shared template catalogue consumed by the 30-minute staff template sync, one readiness function used by the staff and owner screens, an `assignTo` option on the importer, and send-side guards (test send, per-number ceiling, health gate, breaker, readable failure reasons).

**Tech Stack:** Hono API (TypeScript, tsx), BullMQ worker, Postgres with RLS + `DB_TENANT_ASSERT=strict`, Next.js web, `node:test` suites in `apps/api/test` and `apps/web`.

**Spec:** `docs/superpowers/specs/2026-10-22-staff-bulk-ready-design.md`

## Global Constraints

- Every DB call that touches a tenant table runs inside `withTenant(orgId, …)` or `withAllTenants("why", …)`; `/api/*` already runs inside `withAllTenants` via `tenantContext`.
- Migrations are applied as the owner role with psql before the deploy (`docker exec -i nexus-postgres-1 psql -U nexus -d nexus < migration`); `deploy.sh` never runs them.
- Stylesheets: no `rgba(0,0,0`, no `#000`; use tokens (`var(--lift)`, `var(--warn)`); `var(--x, fallback)` only for defined tokens.
- Meta calls for a staff number use that number's own token (`whatsappSendTokenForNumber` / `connectionSecret(…,"whatsapp")`); the platform token only for the company account.
- A Meta lookup that does not answer is "could not check", never a pass.
- Tests are `.test.mjs` under `apps/api/test` (named as sentences), importing TS through tsx; `./scripts/check.sh` must end green except the known `mirror.sh is itself executable` (flat-repo path).

## Review Focus

- A staff number connected by the owner from Team has no `whatsapp` connection row → no token → template sync must log and skip, not throw (Task 1 test: missing secret → no submission, no throw).
- A template name present at Meta as REJECTED must never be resubmitted every 30 minutes (Task 1 test).
- Import `assignTo` naming an employee of ANOTHER business must refuse the whole import, not assign across businesses (Task 3 test).
- Test-send `to` that equals the sending number, or is not a dialable number, gets a plain refusal (Task 4 test).
- Breaker must not pause on fewer than 10 attempts, nor on exactly half failed (Task 5 test).

---

### Task 1: Templates follow the number

**Files:**
- Create: `apps/api/src/lib/campaign-templates.ts`
- Modify: `apps/api/src/scripts/provision-templates.ts` (read `CAMPAIGN_TEMPLATES` instead of its local `PROVISIONS`)
- Modify: `apps/api/src/lib/whatsapp-client.ts` (`createMetaTemplate(wabaId, spec, accessToken = env.metaAccessToken)`)
- Modify: `apps/api/src/services/template-sync.ts` (`syncStaffNumberTemplates`)
- Test: `apps/api/test/a-new-number-gets-its-messages.test.mjs`

**Interfaces:**
- Produces: `CAMPAIGN_TEMPLATES: Record<string, TemplateSpec[]>` keyed by business slug; `missingCampaignTemplates(slug: string, presentNames: string[]): TemplateSpec[]`.

- [ ] **Step 1: Failing test** — `missingCampaignTemplates("sfs-international", [])` returns both SFS specs, names `["sfs_property_update", "sfs_general_update"]`; `missingCampaignTemplates("sfs-international", ["sfs_property_update"])` returns only `sfs_general_update`; presence is by name regardless of status (pass names of PENDING/REJECTED ones too); unknown slug returns `[]`; `review-demo` returns `[]`. Source test: `syncStaffNumberTemplates` calls `missingCampaignTemplates` and `createMetaTemplate(account.wabaId, spec, secret.accessToken)`; the no-secret branch still `continue`s with a warn log.
- [ ] **Step 2: Run** `cd apps/api && node --import tsx --test test/a-new-number-gets-its-messages.test.mjs` → FAIL (module not found).
- [ ] **Step 3: Implement.** Move the six specs from `provision-templates.ts` into `CAMPAIGN_TEMPLATES` verbatim; add `sfs_general_update` (UTILITY, `en`, body: `"Hello {{1}}, this is SFS International Real Estate. We have news on properties that may interest you. Reply to this message and our team will assist you."`, example `["Ahmed"]`). In `syncStaffNumberTemplates`, after `listMetaTemplates`, compute missing by `templates.map(t => t.name)` and submit each with the number's token; log `info` per submission and `warn` on a non-duplicate failure; never throw out of the loop. Log `warn` (not silent) when `secret` is missing.
- [ ] **Step 4: Run** the test → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `Templates follow the number: a newly connected staff account gets its business's messages`.

### Task 2: Readiness for staff and owner

**Files:**
- Create: `apps/api/src/services/campaign-readiness.ts`
- Modify: `apps/api/src/routes/my-campaigns.ts` (GET returns `readiness`; POST refuses when not all ok)
- Modify: `apps/api/src/routes/employees.ts` (GET `/:slug/campaign-readiness`, admin/operator only, same guard as other team-management routes)
- Modify: `apps/web/lib/api.ts`, `apps/web/app/deck/my-campaigns/page.tsx` (+css), `apps/web/app/deck/team/whatsapp-readiness.tsx`
- Test: `apps/api/test/a-campaign-says-what-it-is-waiting-for.test.mjs`

**Interfaces:**
- Produces: `type ReadinessCheck = { key: "allowed" | "number" | "message" | "clients"; ok: boolean | null; detail: string; fix: string | null }`; pure `readinessFrom(input: { canBroadcast: boolean; ownNumber: boolean; numberRetired: boolean; approved: number; pending: number; clients: number }): ReadinessCheck[]`; async `campaignReadiness(employeeId: string, organizationId: string): Promise<ReadinessCheck[]>`.

- [ ] **Step 1: Failing test** — `readinessFrom` with everything present → four `ok: true`. `ownNumber:false` → `number.ok=false`, `fix` mentions "Connections". `approved:0, pending:2` → `message.ok=false`, `detail` contains "waiting for WhatsApp to approve". `approved:0, pending:0` → `detail` contains "no message on your number yet". `clients:0` → `clients.ok=false`. Source test: POST handler calls `campaignReadiness` and returns 422 when any check is not `true`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `readinessFrom` (pure) and `campaignReadiness` (reads employee, org, retired flag, `listBroadcastTemplates` for the sending account filtered exactly like GET's picker, and `myClientsForBroadcast`). Owner endpoint returns `[{ employeeId, fullName, checks }]` for active staff of the business. Web: checklist block at the top of My campaigns (send disabled unless all ok); Team card adds "Campaigns n/4" per member, fetched once.
- [ ] **Step 4: Run** test → PASS; `npm run typecheck` and `npm test -w apps/web` → green.
- [ ] **Step 5: Commit** `A campaign says what it is waiting for`.

### Task 3: Import straight into a staff member's book

**Files:**
- Modify: `apps/api/src/routes/contacts.ts` (import accepts `assignTo`)
- Modify: `packages/db/src/contact-identity.ts` or `client-book.ts`: add `assignContactOwnerIfUnowned(contactId: string, employeeId: string): Promise<{ assigned: boolean; currentOwnerName: string | null }>`
- Modify: `apps/web/app/deck/customers/import-customers.tsx`, `apps/web/lib/api.ts` (`importContacts(business, rows, assignTo?)`)
- Test: `apps/api/test/an-import-can-fill-a-book.test.mjs`

- [ ] **Step 1: Failing test** — source/behaviour assertions: import route validates `assignTo` belongs to the business and returns 400 `"That person is not in this business."` otherwise, before touching any row; a row whose contact is owned by someone else gets outcome `"already-known"` with reason `already in <name>'s book`; the SQL in `assignContactOwnerIfUnowned` updates only `where owner_employee_id is null`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; importer gets an "Add to whose book" select (team list for that business, default "Nobody").
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `An import can fill a staff member's book`.

### Task 4: Test send to yourself

**Files:**
- Modify: `apps/api/src/routes/my-campaigns.ts` (`POST /campaigns/test`)
- Modify: `apps/web/lib/api.ts` (`sendMyCampaignTest(templateId, to)`), `apps/web/app/deck/my-campaigns/page.tsx`
- Test: `apps/api/test/a-campaign-can-be-tried-on-yourself.test.mjs`

- [ ] **Step 1: Failing test** — exported pure `testSendRefusal(to: string, sendingDisplayNumber: string | null): string | null`: `"abc"` → `"That is not a phone number."`; digits of `to` equal to the sending number's digits → `"That is the number the campaign sends from — use your personal WhatsApp."`; `"+971 50 123 4567"` → `null`. Source test: the handler uses the same template checks as POST `/campaigns` and calls `sendWhatsAppTemplate(from, digits, template.metaTemplateName, template.language, staffTemplateParams(template.bodyParamCount, employee.fullName))`, and creates no broadcast row.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; reply `{ ok: true, messageId }` or `{ error: plainReason }` (502) using Task 6's `explainSendError`. Web: "Send a test to" input + button beside the template picker.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `A campaign can be tried on yourself first`.

### Task 5: Per-number ceiling, health gate, circuit breaker

**Files:**
- Create: `packages/db/migrations/099-a-campaign-can-pause.sql` (drop/re-add `broadcasts_status_check` with `'paused'` added)
- Modify: `apps/api/src/lib/whatsapp-client.ts` (`readNumberStanding(phoneNumberId: string): Promise<{ tier: string | null; dailyLimit: number | null; quality: string | null } | null>` with the number's token)
- Modify: `packages/db/src/client-book.ts` (`dailyReachUsed(fromPhoneNumberId?: string)` filters `b.from_phone_number_id`)
- Modify: `apps/api/src/routes/my-campaigns.ts` (`describeDailyCeiling(audience, fromPhoneNumberId)`; RED refuses 409, YELLOW returns `healthWarning`)
- Modify: `apps/api/src/queue/broadcast-processor.ts`, `packages/db/src/broadcasts.ts` (`broadcastStatus(id)`, `shouldTrip(outcome: { sent: number; failed: number }): boolean`)
- Test: `apps/api/test/a-failing-campaign-stops-itself.test.mjs`

- [ ] **Step 1: Failing test** — `shouldTrip({sent:4, failed:5})` false (9 attempts); `shouldTrip({sent:5, failed:5})` false (exactly half); `shouldTrip({sent:4, failed:6})` true. Migration text contains `'paused'` and keeps the five existing values. Source: processor returns early without calling `sendWhatsAppTemplate` when `broadcastStatus` is `'paused'`; trips call `updateBroadcastStatus(id, "paused")` and log warn with business, employee and top reason; `describeDailyCeiling` calls `readNumberStanding(fromPhoneNumberId)` and `dailyReachUsed(fromPhoneNumberId)`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `updateBroadcastStatus` type accepts `"paused"`; a finished broadcast that is paused stays paused (outcome `done` never overwrites `paused`).
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `A failing campaign stops itself, and the limit is the sending number's`.

### Task 6: Results in plain words

**Files:**
- Create: `apps/api/src/lib/send-errors.ts` (`explainSendError(raw: string): string`)
- Modify: `packages/db/src/client-book.ts` (`listMyBroadcasts` adds `delivered: number` and `topFailures: Array<{ reason: string; count: number }>` — up to 3, from `delivery_error`)
- Modify: `apps/api/src/routes/my-campaigns.ts` (map `topFailures[].reason` through `explainSendError`), `apps/web/lib/api.ts`, `apps/web/app/deck/my-campaigns/page.tsx`
- Test: `apps/api/test/a-refusal-says-why-in-words.test.mjs`

- [ ] **Step 1: Failing test** — a raw Meta body containing `"code":131026` → `"This person is not on WhatsApp."`; `131047` → `"More than 24 hours since they last wrote — only an approved message can reach them."`; `131049` → `"WhatsApp held this marketing message back to protect the person's inbox. Try again in a few days."`; `132001` → `"That message is not approved on this number."`; `131056` → `"Too many messages to this person in a short time."`; unknown → the raw text, trimmed to 200 characters.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; web list shows sent / delivered / failed and the top reasons; status `paused` shows "Paused — most messages were refused".
- [ ] **Step 4: Run** → PASS; `./scripts/check.sh` green except the known mirror test; `npm test -w apps/web` green.
- [ ] **Step 5: Commit** `A refusal says why, in words`.

### Task 7: Ship and verify on Hostinger

- [ ] Push `main` to GitHub.
- [ ] On the VPS: `pg_dump` backup; apply `099` as owner; `./scripts/deploy.sh` → `PASS - all three running images were built from <sha>`.
- [ ] Wait for the next template-sync cycle; confirm in worker logs that SFS templates were submitted to account `1598768785203832` and `message_templates` holds them (PENDING is expected at first).
- [ ] Re-run the readiness dry run for every staff member; `./scripts/verify-all.sh` → 12/12 PASS.
- [ ] When an SFS template on Keshav's number is APPROVED, one test send to the owner's own WhatsApp (owner supplies the number).
