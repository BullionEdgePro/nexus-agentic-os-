# A failed query never silently loses a request's records — design

**Date:** 3 Nov 2026. **Branch:** `silent-rollback`, cut from `request-transactions` (`be94c29`).
**Status:** approved under the owner's standing instruction to take Claude's recommendation.

## 1. The problem

Every API request and webhook, and each unit of work a job opens with `withTenant` or
`withAllTenants`, runs inside one Postgres transaction (`withClient` in
`packages/db/src/client.ts`). When any statement in it fails, Postgres aborts the whole
transaction: every later statement is refused with `25P02` ("current transaction is aborted"), and
the final `commit` comes back as `ROLLBACK` instead of an error. Verified with node-pg 8.22:
`(await client.query("commit")).command === "ROLLBACK"`.

The code catches errors in 192 places (`.catch(() => …)`) and in try/catch blocks inside loops.
When the failed statement's error is caught and the code carries on, two things happen and nobody
is told:

- **Every write made before the failure is undone at commit**, and the request still answers 200.
- **Every write attempted after it is refused**, and if those errors are caught too, the request
  still answers success.

The case found by the last review, `POST /api/bulk/:slug/quick` (admin quick send,
`apps/api/src/routes/admin-bulk.ts`) and `POST /api/my/quick-message` (staff quick send,
`apps/api/src/routes/my-campaigns.ts`): each person is messaged on WhatsApp first and recorded
second, inside one `catch`. If one person's record fails, that person is reported "failed" although
they were messaged, everyone after them is messaged and reported failed, and at commit every
record of the send — the people before them too — is rolled back. The answer is 200.

## 2. What success looks like

1. A request that lost a write never reports success: it answers 500, and the error says what
   happened and carries the first failure that was caught as its `cause`.
2. A background job that lost a write logs an error saying so, with the cause, and otherwise
   behaves exactly as it does today. It does not start failing: a retry would repeat whatever the
   job already did outside the database. The message job, for one, deliberately swallows a failure
   once the reply has gone, because a retry (5 attempts) would answer the customer again.
3. A read-only transaction whose caught read failed keeps answering the way its code chose (many
   reads are deliberately "assume yes if this fails"); the abort is logged as a warning.
4. In a quick send, one person's record failing loses that record only. A person who was messaged
   but not recorded is reported as such, not as "failed".
5. Every place that loses records today because one caught failure aborts a shared transaction
   (section 4.4) isolates that failure, so it loses nothing else.

## 3. Approaches considered

- **A — notice a lost write at commit, and isolate items where partial success is intended.
  Chosen.** Covers every swallow site at once (as a loud failure) for the cost of a few lines in
  `withClient`, and does the careful per-item work only where carrying on is the point.
- **B — a savepoint around every statement automatically** (pgjdbc's `autosave=always`). Would let
  all 192 swallow sites carry on safely, but triples round trips on every query and creates a
  subtransaction per statement; past 64 in one transaction Postgres's subtransaction cache
  overflows, which a 200-person quick send would cross. Rejected.
- **C — fix only the two quick sends.** Leaves every other caught failure losing work silently.
  Rejected.

## 4. Design

### 4.1 Keeping track of a transaction's health (`client.ts`)

`withClient` keeps, per open transaction, a small record keyed by its `PoolClient`:

- `wrote` — a statement succeeded whose result `command` is `INSERT`, `UPDATE`, `DELETE` or `MERGE`;
- `refusedWrite` — a write statement was refused with `25P02` (after the failure);
- `failure` — the first error that was not `25P02`: the cause.

`getPool().query` inside a context updates it as each statement settles. A "write statement", for a
refused one only, is judged from its SQL (the existing `scrubSql`, then `insert into`, `update`,
`delete from`, `merge into`, ignoring `for update`); for a successful one the `command` decides.

`withSavepoint` takes a copy when its savepoint is set and puts it back after a successful
`rollback to savepoint`: the transaction is healthy again, and the work it undid on purpose is not a
lost write.

### 4.2 The commit (`withClient`)

After `fn` returns, `withClient` commits and reads the result. If it is `ROLLBACK`:

- with `wrote` or `refusedWrite` set, the writes were lost:
  - when the caller asked for it with `{ failOnLostWrites: true }`, it throws
    `TransactionRolledBack` (exported from `@nexus/db`): *"Nothing in this piece of work was saved:
    a database statement failed, its error was caught, and Postgres then rolled the whole
    transaction back."*, with the recorded failure as `cause`;
  - otherwise it logs that sentence as a `[db]` error with the cause (`console.error`, this file's
    idiom) and returns the result;
- with neither set, it logs a `[db]` warning naming the failure and returns the result.

`withTenant` and `withAllTenants` take the option as a new optional last argument. Only
`tenantContext` (its three branches) and `webhookContext` pass it, so requests fail and every other
caller — every job — is unchanged except for the log line. The record is dropped when the
connection is released. Only the outermost context commits; nested contexts reuse it, so the
option on an inner call has no effect.

**Where it surfaces.** `tenantContext`/`webhookContext` rethrow anything that is not their own
`HandlerFailed`, so Hono's default handler logs it (with its cause) and answers 500, replacing the
200 the handler built.

### 4.3 Quick sends

Both loops move into one helper, `sendQuickMessages` in `apps/api/src/lib/quick-send.ts`, so the
fix cannot drift between them. Per person, in order:

1. send (unchanged; a send failure is `failed`, with the payment-refusal note as today);
2. record the message inside its own `withSavepoint`; a failure here is logged with the
   conversation and reason, and the person is counted as **sent** and listed in `notRecorded`;
3. announce it to the inbox (unchanged, Redis).

The answer becomes `{ sent, failed, notRecorded }`. The shared screen component
(`apps/web/app/deck/my-campaigns/quick-message.tsx`, used by both screens) lists each
`notRecorded` name with "Sent, but could not be saved to their conversation, so it will not show
in the inbox." `notRecorded` is optional in the web types so an older API answer still reads.

### 4.4 Other loops that carry on past a failed item

A sweep of the 26 loops that try each item and carry on (and of swallowed write calls in routes
and services) found these, each confirmed against the code. Each isolates the failing piece in
`withSavepoint`, so the rest of the transaction keeps its work:

- **Scheduled messages** (`apps/api/src/queue/scheduled-messages-processor.ts`). The whole sweep,
  claim included, is one transaction. A record failing after a send makes the catch's
  `markScheduledMessageFailed` fail too, the sweep rolls back, the rows return to `pending`, and the
  next minute's sweep sends the earlier messages again — every minute while the failure repeats.
  Now each message is its own savepoint. A message that was sent but could not be recorded is
  marked **sent** (it was) and the missing record is logged as an error; it is never sent again.
  A refused send stays `failed` with Meta's reason, as today.
- **Automations** (`apps/api/src/services/automation-runner.ts`, the per-finding loop). An action
  failing on a database error aborts the business's run; the next `claimFinding` throws and rolls
  back every claim, so the next sweep acts on the same findings again. Now `perform` runs in a
  savepoint: its partial writes are undone, `recordAutomationFailure` lands, and the claim stays.
- **Email sync** (`storeInboxMail` in `apps/api/src/services/email-sync.ts`). The bounce record, the
  opt-out and the lead score are each "non-fatal" by their own comments, but one failing aborts the
  mailbox's whole batch. Each now runs in a savepoint, which makes those comments true.
- **A double booking** (`createBooking` in `packages/db/src/bookings.ts`). Two customers asking
  for the same slot is a normal race; the exclusion constraint refuses the second, and that
  refusal aborted the transaction the AI reply runs in, so the reply went out and the inbound
  message, the conversation and the reply were all rolled back. The insert now runs in a savepoint
  when there is a transaction (outside one, a statement is already its own).
- **The assignment note** (`apps/api/src/routes/employees.ts`, `recordAssignmentEvent`). Its comment
  says the assignment stands if the note fails; it did not. The note now runs in a savepoint.
- **The not-reported list** (`apps/api/src/services/operators.ts`, the per-business loop under
  `GET /api/operators/not-reported`). Read-only: one business's failed read made every business
  after it vanish from the list. Each business's reads now run in a savepoint.

### 4.5 Connections whose rollback failed

No change. pg-pool 3.14 already removes a released client that can no longer run queries
(`!client._queryable`, `node_modules/pg-pool/index.js:392`), and a rollback fails only when the
connection has gone.

## 5. Out of scope

- Giving each of the remaining single-statement swallow sites its own savepoint. With 4.2 they can
  no longer lose a write silently (a request fails, a job logs an error); where one does, it can be
  isolated then. Known ones left: the HQ check results loop (`hq-checks.ts:308`), the send-token
  lookup in `bearerFor` (`whatsapp-client.ts:21`), and the reads the message job treats as
  "assume yes" (`processor.ts`, e.g. `hasStaffOnShift(...).catch(() => true)`).
- Changing whether any job retries.
- Redis side effects (inbox events) published before a rollback.
- `GeminiDomainAgent`, which nothing constructs.

## 6. Testing

Against the throwaway Postgres (advisory lock `20261102`), each watched failing first:

- with `failOnLostWrites`, a transaction that wrote, then swallowed a failure, rejects with
  `TransactionRolledBack` whose cause is the original error, and the write is gone;
- with it, a write refused after a swallowed failure, with nothing written before, also rejects;
- without it, the same transaction resolves and logs the error line;
- a read-only transaction with a swallowed failed read resolves;
- a failure undone by `withSavepoint` does not count, before or after a write;
- through the probe app mounted as `index.ts` mounts it, a handler that swallowed a failure after
  writing answers 500, not 200;
- `sendQuickMessages` inside one transaction, the second person's record failing: all three
  counted sent, the second listed in `notRecorded`, the first and third recorded after commit;
- the scheduled sweep with three due messages, the second's record failing: all three marked
  sent, the first and third recorded, and a second sweep sends nothing;
- a double booking inside a transaction raises `SlotTakenError` and a later write in the same
  transaction is kept;
- the web component shows a `notRecorded` name and its sentence;
- source checks pin the savepoints in the automation loop, the email sync, the assignment note
  and the not-reported loop (their setups are out of reach of a quick test database).

A database failure is injected with a trigger created on the throwaway database for the test
(raising on a marker value) and dropped afterwards.
