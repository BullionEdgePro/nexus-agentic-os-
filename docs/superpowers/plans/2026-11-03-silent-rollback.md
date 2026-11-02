# A failed query never silently loses a request's records — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request that lost a write answers 500, a job that lost one says so in the log, and the
six places that lose records today because one caught failure aborts a shared transaction isolate
that failure instead.

**Architecture:** `withClient` keeps a per-transaction health record (successful writes, writes
refused after a failure, the first failure) fed by `getPool().query`; at commit a `ROLLBACK` with a
lost write throws `TransactionRolledBack` when the caller opted in (the request middleware only),
else logs. `withSavepoint` restores the record after rolling back. A new `isolated()` runs a piece
in a savepoint inside a transaction and as-is outside one. The six sites wrap their failing piece.

**Tech Stack:** TypeScript, node-pg 8.22 / pg-pool 3.14, Hono 4.12, node:test with tsx, Postgres.

**Spec:** `docs/superpowers/specs/2026-11-03-silent-rollback-design.md`

## Global Constraints

- No database migration. No push, no deploy; commit locally on `silent-rollback` only.
- Error copy (spec 4.2), exact: `Nothing in this piece of work was saved: a database statement failed, its error was caught, and Postgres then rolled the whole transaction back.`
- Web copy (spec 4.3), exact: `Sent, but could not be saved to their conversation, so it will not show in the inbox.`
- Only `tenantContext` (three branches) and `webhookContext` pass `{ failOnLostWrites: true }`.
- Database tests: throwaway Postgres on port 55433 (`AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55433/nexus`, `AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55433/nexus`), skipped when unset, holding advisory lock `20261102` for the whole file, cleanup in try/finally.
- Comments follow the codebase: a capitalised lead-in and the date, e.g. `(3 Nov 2026)`.
- Full API suite: `cd apps/api && <env> npm test` — the only known failure is the Windows-only "mirror.sh is itself executable". Web: `npm --prefix apps/web test`. Typecheck: `npx tsc --noEmit -p .` in `packages/db` and `apps/api` (and `apps/web` for Task 2).

## Review Focus

1. A write made through a function called from a SELECT (`select some_fn()` that inserts) settles as `command = "SELECT"`, so losing it would count as read-only and only warn. Check whether the codebase writes this way on a request path.
2. A swallowed failure inside a `withServingTenant` / `withContactOwner` switch: the cause must still be the original error, not `restoreCurrentOrg`'s own failure.
3. A request whose handler threw (HandlerFailed) must still roll back without the commit check firing; a TransactionRolledBack must still reach Hono as a 500, through the double mount.
4. `withSavepoint` whose `rollback to savepoint` itself fails (connection gone): the record must not be "restored" to healthy.
5. The web reading an answer without `notRecorded` (an API not yet deployed) — pinned in Task 2.

---

### Task 1: A lost write fails a request and is logged everywhere else

**Files:**
- Modify: `packages/db/src/client.ts` (`getPool`, `withClient`, `withTenant`, `withAllTenants`, `withSavepoint`; new `TransactionRolledBack`, `TransactionOptions`, `isolated`)
- Modify: `apps/api/src/middleware/tenant-context.ts` (pass the option in the three `tenantContext` branches and `webhookContext`)
- Test: `apps/api/test/a-failed-query-loses-nothing-else.test.mjs` (create)

**Interfaces:**
- Produces:
  - `export interface TransactionOptions { failOnLostWrites?: boolean }`
  - `withTenant<T>(organizationId: string, fn: () => Promise<T>, options?: TransactionOptions): Promise<T>`; same third parameter on `withAllTenants(reason, fn, options?)`
  - `export class TransactionRolledBack extends Error` — `name = "TransactionRolledBack"`, message per Global Constraints, `cause` = first non-`25P02` failure (or undefined)
  - `export function isolated<T>(fn: () => Promise<T>): Promise<T>` — `withSavepoint(fn)` inside a context, `fn()` outside one

- [ ] **Step 1: Write the failing tests**

Create the file in the style of `a-request-ends-the-way-it-went.test.mjs`: header comment, `db` skip object,
`before` seeding org `92929292-0000-4000-8000-000000000001` (slug `srb-org`, phone `950001`, WABA `850001`,
`Asia/Dubai`, `is_number_owner` true) as owner, then `process.env.DATABASE_URL = APP_URL`, `lib = await import("@nexus/db")`,
and a probe Hono app mounted like `index.ts` (`/api/organizations/:slug/*`, `/api/*`, `/webhooks/*`).
Helpers `insertContact(waId)` / `contactNamed(waId)` as in that file; `swallow = () => lib.getPool().query("select 1/0").catch(() => undefined)`.
Tests (all `db`), each asserting first that the outcome is not a success, so the RED reads as the bug:

```js
test("a request's lost write is refused, and says why", db, async () => {
  const err = await lib.withTenant(ORG, async () => { await insertContact("971595000001"); await swallow(); }, { failOnLostWrites: true })
    .then(() => null, (e) => e);
  assert.notEqual(err, null, "a transaction that lost its write was reported as a success");
  assert.equal(err.name, "TransactionRolledBack");
  assert.match(err.message, /^Nothing in this piece of work was saved/);
  assert.match(String(err.cause?.message), /division by zero/, "the cause is the failure that was caught");
  assert.equal(await contactNamed("971595000001"), 0);
});
test("a write refused after a caught failure is a lost write too", db, ...)            // swallow(); insertContact(...).catch(() => undefined) → TransactionRolledBack
test("without the option the lost write is logged as an error, and nothing throws", db, ...) // mock.method(console, "error"); resolves; a call matching /\[db\].*Nothing in this piece of work was saved/
test("a read-only transaction keeps the answer its code chose, and warns", db, ...)     // option on; swallow(); resolves; console.warn called with /\[db\]/
test("a failure undone by a savepoint is not a lost write", db, ...)                     // option on; await lib.withSavepoint(() => getPool().query("select 1/0")).catch(()=>{}); insertContact → resolves, row kept
test("a write undone on purpose by a savepoint is not lost either", db, ...)            // option on; withSavepoint(insert then throw).catch; swallow(); resolves
test("a locking read refused after a failure is not a write", db, ...)                   // option on; swallow(); getPool().query("select id from organizations where id = $1 for update", [ORG]).catch(); resolves
test("only the outermost context decides", db, ...)                                      // withAllTenants("probe", () => lib.withTenant(ORG, insert+swallow, { failOnLostWrites: true })) resolves
test("isolated() runs as it is outside a transaction, and in a savepoint inside one", db, ...) // outside: resolves its value; inside withTenant: isolated(select 1/0) rejects, a later insertContact is kept
test("a handler that swallowed a failure after writing answers 500", db, ...)           // probe route POST /api/organizations/srb-org/swallows/:waId → insert, swallow, return 200; expect 500 and no row
```

- [ ] **Step 2: Run them to watch them fail**

Run: `cd apps/api && AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55433/nexus AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55433/nexus node --import tsx --experimental-test-module-mocks --test test/a-failed-query-loses-nothing-else.test.mjs`
Expected: FAIL — "a transaction that lost its write was reported as a success", the logged/warned lines missing, `isolated` not a function, the probe answering 200. The "keeps the answer", "undone by a savepoint", "only the outermost" and "locking read" tests may pass already: they guard the rule.

- [ ] **Step 3: Implement in `client.ts`**

A `WeakMap<PoolClient, { wrote: boolean; refusedWrite: boolean; failure: unknown }>` created after `begin`, deleted in `finally`.
`getPool().query` in a context settles into it: success with `command` in `INSERT`/`UPDATE`/`DELETE`/`MERGE` sets `wrote`;
an error with `code === "25P02"` sets `refusedWrite` when the SQL is a write; any other error sets `failure` if unset.
"The SQL is a write": `scrubSql(sql)` with `for [no key] update` removed, then `/\b(insert\s+into|update\s+["a-z_]|delete\s+from|merge\s+into)\b/`.
`withSavepoint` copies the record after `savepoint` succeeds and puts the copy back after `rollback to savepoint` succeeds.
`withClient(setup, makeContext, fn, options?)`: `const done = await client.query("commit")`; on `done.command === "ROLLBACK"` apply spec 4.2
(`throw new TransactionRolledBack(failure)` / `console.error("[db] " + message, failure)` / `console.warn("[db] A read-only transaction rolled back after a caught failure:", failure)`).
Then pass `{ failOnLostWrites: true }` from the three `tenantContext` branches and `webhookContext`; export the new names from the package index if it re-exports by name.

- [ ] **Step 4: Run the file, then the full API suite and typecheck**

Expected: the new file passes; API suite green except mirror.sh; `tsc` clean in `packages/db` and `apps/api`.

- [ ] **Step 5: Commit** — `A request that lost a write says so instead of answering 200`

---

### Task 2: A quick send records each person on their own

**Files:**
- Create: `apps/api/src/lib/quick-send.ts`
- Modify: `apps/api/src/routes/admin-bulk.ts` (the `/:slug/quick` loop), `apps/api/src/routes/my-campaigns.ts` (the `/quick-message` loop)
- Create: `apps/web/lib/quick-outcome.ts`; Modify: `apps/web/app/deck/my-campaigns/quick-message.tsx`, `apps/web/lib/api.ts` (`sendBulkQuick`, `sendQuickMessage` return types gain `notRecorded?: string[]`)
- Test: `apps/api/test/a-failed-query-loses-nothing-else.test.mjs` (add), `apps/web/test/a-quick-send-says-what-was-saved.test.mjs` (create)

**Interfaces:**
- Consumes: `withSavepoint` from `@nexus/db`.
- Produces:
  - `export interface QuickRecipient { id: string; displayName: string | null; waId: string; conversationId: string }`
  - `export interface QuickSendOutcome { sent: number; failed: Array<{ name: string; reason: string }>; notRecorded: string[] }`
  - `export async function sendQuickMessages(input: { people: QuickRecipient[]; text: string; phoneNumberId: string; send(person: QuickRecipient, message: string): Promise<{ waMessageId: string | null }>; record(person: QuickRecipient, message: string, waMessageId: string | null): Promise<void> }): Promise<QuickSendOutcome>` — personalises with the existing `personalise`, keeps the payment-refusal note and `explainSendError` for send failures, wraps `record` in `withSavepoint`, logs a record failure (`logger.error`, conversation id and reason) and lists the person's name in `notRecorded` while counting them sent. Name = `displayName ?? "+" + waId`, as today.
  - `export function describeQuickOutcome(outcome: { sent: number; failed: Array<{ name: string; reason: string }>; notRecorded?: string[] }): { ok: boolean; text: string; failed: Array<{ name: string; reason: string }> }` — `ok` only when nothing failed and everything was saved; the "Each one is in that client's conversation." sentence only when `notRecorded` is empty; each `notRecorded` name appended to `failed` with the Global Constraints sentence as its reason.

- [ ] **Step 1: Write the failing tests**

API (db): seed three contacts and WhatsApp conversations on phone `950001`, the second conversation with id
`92929292-0000-4000-8000-0000000000c2`; in `before`, as owner, a trigger `srb_refuse_messages` (before insert on `messages`)
raising `refused for the test` when `new.conversation_id` is that id; drop trigger and function in `after`.

```js
test("one person's record failing loses that record only", db, async () => {
  const { sendQuickMessages } = await import("../src/lib/quick-send.ts");
  const outcome = await lib.withTenant(ORG, () => sendQuickMessages({
    people, text: "Probe hello", phoneNumberId: "950001",
    send: async () => ({ waMessageId: null }),
    record: (person, message) => lib.insertOutboundMessage({ organizationId: ORG, conversationId: person.conversationId, contactId: person.id, senderType: "human_agent", body: message }).then(() => undefined),
  }), { failOnLostWrites: true });
  assert.deepEqual(outcome, { sent: 3, failed: [], notRecorded: ["Probe Two"] });
  assert.equal(await messagesIn(CONV1), 1); assert.equal(await messagesIn(CONV2), 0); assert.equal(await messagesIn(CONV3), 1);
});
```
Web: `describeQuickOutcome({ sent: 2, failed: [], notRecorded: ["Sara"] })` → `ok` false, text without "Each one is in that client's conversation.", `failed` containing `{ name: "Sara", reason: <the sentence> }`;
`describeQuickOutcome({ sent: 2, failed: [] })` (an older answer) → `ok` true and the sentence kept.

- [ ] **Step 2: Run both to watch them fail** — Expected: cannot import `quick-send.ts` / `quick-outcome.ts`.
- [ ] **Step 3: Implement the helper, move both route loops onto it (each `record` = `withTenant(...insertOutboundMessage)` then the existing `publishInboxEvent(...).catch(() => undefined)`; answer `{ sent, failed, notRecorded }`), and the web function used by `quick-message.tsx` in place of its inline `setResult({...})` object.**
- [ ] **Step 4: Run the two files, the full API and web suites, typecheck db, api, web.**
- [ ] **Step 5: Commit** — `A quick send loses one person's record at most, and says whose`

---

### Task 3: A scheduled message is never sent twice

**Files:**
- Modify: `apps/api/src/queue/scheduled-messages-processor.ts`
- Test: `apps/api/test/a-failed-query-loses-nothing-else.test.mjs` (add)

**Interfaces:**
- Consumes: `withSavepoint`, `markScheduledMessageSent`, `markScheduledMessageFailed` from `@nexus/db`.

- [ ] **Step 1: Write the failing test**

Seed three `scheduled_messages` (status `pending`, `send_at` a minute ago) on the three conversations; replace
`globalThis.fetch` (counting calls, answering `{ messages: [{ id: "wamid.srb-N" }] }`) and set `META_ACCESS_TOKEN`, both restored in `finally`.

```js
test("a scheduled message whose record failed is marked sent and not sent again", db, async () => {
  const { processScheduledMessageSweep } = await import("../src/queue/scheduled-messages-processor.ts");
  const first = await processScheduledMessageSweep({}).then(() => "finished", (e) => e.message);
  assert.equal(first, "finished", "one failed record took the whole sweep down");
  assert.deepEqual(await statuses(), ["sent", "sent", "sent"]);
  assert.equal(await messagesIn(CONV1), 1); assert.equal(await messagesIn(CONV3), 1);
  await processScheduledMessageSweep({});
  assert.equal(sends.length, 3, "a customer was messaged again");
});
```

- [ ] **Step 2: Run it to watch it fail** — Expected: "one failed record took the whole sweep down" (or statuses back to `pending`).
- [ ] **Step 3: Implement** — each message's work (lookup, send, record) runs in `withSavepoint`; the outcome decides the mark outside it: refused send → `failed` with the reason (as today); sent but the record failed → `markScheduledMessageSent(id, waMessageId)` and `logger.error` that the record is missing; update the file's header comment to say so.
- [ ] **Step 4: Run the file, the full API suite, typecheck.**
- [ ] **Step 5: Commit** — `A scheduled message that was sent is never sent again`

---

### Task 4: A double booking no longer aborts the reply it happened in

**Files:**
- Modify: `packages/db/src/bookings.ts` (`createBooking`'s insert)
- Test: `apps/api/test/a-failed-query-loses-nothing-else.test.mjs` (add)

**Interfaces:**
- Consumes: `isolated` (Task 1), `SlotTakenError` (existing).

- [ ] **Step 1: Write the failing test**

Seed an employee `e9292920-0000-4000-8000-000000000001` in the org.

```js
test("a slot taken by someone else leaves the rest of the transaction working", db, async () => {
  const slot = { employeeId: STAFF, startsAt: "2030-01-07T09:00:00Z", endsAt: "2030-01-07T09:30:00Z", organizationId: ORG, contactId: CONTACT1 };
  await lib.withTenant(ORG, async () => {
    await lib.createBooking(slot);
    await assert.rejects(lib.createBooking(slot), lib.SlotTakenError);
    await insertContact("971595000020");
  }, { failOnLostWrites: true });
  assert.equal(await contactNamed("971595000020"), 1);
});
```

- [ ] **Step 2: Run it to watch it fail** — Expected: the `insertContact` after the clash refused ("current transaction is aborted").
- [ ] **Step 3: Implement** — the insert-and-return query runs inside `isolated(...)`; the `isDoubleBooking → SlotTakenError` mapping stays outside it.
- [ ] **Step 4: Run the file, the full API suite, typecheck.**
- [ ] **Step 5: Commit** — `A double booking no longer takes the customer's reply down with it`

---

### Task 5: The other best-effort steps stop taking their transaction with them

**Files:**
- Modify: `apps/api/src/services/automation-runner.ts` (the per-finding `perform`), `apps/api/src/services/email-sync.ts` (`storeInboxMail`: bounce record, opt-out, lead score), `apps/api/src/routes/employees.ts` (`recordAssignmentEvent`), `apps/api/src/services/operators.ts` (the per-business loop of the not-reported list)
- Test: `apps/api/test/a-failed-query-loses-nothing-else.test.mjs` (add, source checks; not `db`)

**Interfaces:**
- Consumes: `withSavepoint`, `isolated` (Task 1).

- [ ] **Step 1: Write the failing source checks** — read each file through `withoutComments` (from `scripts/recurrence/source.mjs`) and assert:
  - automation-runner: `withSavepoint(() => perform(automation, finding, organizationId))`
  - email-sync: `withSavepoint(` around `recordEmailBounce(`, around `optOutOfEmailCampaigns(contactId)` and around `recordLeadAssessment(` — three matches inside `storeInboxMail`
  - employees: `withSavepoint(() => recordAssignmentEvent(`
  - operators: `isolated(() =>` wrapping the `withTenant(organization.id, () => unansweredButNotReportedFor(organization.id))`
- [ ] **Step 2: Run them to watch them fail.**
- [ ] **Step 3: Implement each wrap**, keeping each existing catch and its log line; a one-line comment on each saying the failure is now this step's alone `(3 Nov 2026)`.
- [ ] **Step 4: Run the file, the full API and web suites, typecheck db and api.**
- [ ] **Step 5: Commit** — `Best-effort steps fail on their own instead of taking their transaction`
