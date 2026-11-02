# A serving business reads routed rows, and never rewrites them — design

Date: 2026-11-02 · Branch: `serving-read-only`, cut from `routed-scoring` (b680c17) · Migration: 106

## 1. The problem

All five businesses share Zipicka's WhatsApp number. Migrations 054, 056 and 058 let the
business a chat is routed to read the rows of that chat. Each widens the `using` clause of the
table's single `<table>_tenant_isolation` policy, which covers every command:

| Table | Policy as of | `using` reaches | `with check` |
|---|---|---|---|
| conversations | 054 | owner, or `routed_organization_id` | owner |
| conversation_metrics | 054 | owner, or `serving_organization_id` | owner |
| messages | 058 | owner, or `serving_organization_id` | owner, or `serving_organization_id` (058: a firm may answer its own customer) |
| contacts | 056 | owner, or the current business in `served_organization_ids` | owner |

In Postgres a policy's `using` also decides which rows UPDATE and DELETE reach. So under its own
tenant a serving business can:

- **DELETE** the owner's routed conversations, metrics and messages, and any contact it serves.
  Deleting a contact cascades into every business's rows for that person.
- **UPDATE `organization_id` to itself** and take the row over: the new row passes the owner-only
  `with check`.
- On messages, **UPDATE or DELETE anything** in the chats it serves, since 058's check admits the
  serving business.

No code does any of this today. It is a latent tenant-isolation hole, found by the review of
migration 105, which fixed the same shape for `lead_assessments`.

## 2. What success looks like

- A serving business still **reads** everything it reads today on all four tables, and still
  **inserts** replies into the chats it serves (058).
- Under its own tenant it can **update or delete no row** it does not own on any of the four
  tables.
- The owner's pipeline, cross-tenant requests (`withAllTenants`, `tenant_scope = 'all'`) and the
  migration owner are unaffected.
- No current write path changes behaviour (§3).

## 3. Every write path today (audited 2026-11-02)

- **No application code deletes** from these tables. Only the self-check and schema-check scripts
  do, on their own probe rows, as the owner.
- **The UPDATEs** run in one of three contexts:
  - the reply pipeline, inside the number owner's `withTenant`;
  - cross-tenant requests: every `/api/conversations/...` and `/api/my/...` route, and webhooks;
  - scripts.
  No `/api/organizations/:slug/...` route updates these tables, and no `withServingTenant` body
  writes them.
- **The two message UPDATEs** are both written by webhook processors running as the owner:
  delivery statuses (`recordDeliveryStatus`) and social unsends (`eraseUnsentSocialMessage`). The
  reply path only inserts.

So making UPDATE and DELETE owner-only breaks no working path. Should a business-scoped route ever
update a routed row, the attempt affects zero rows. Today the owner-only `with check` already
refuses it with an error.

## 4. Decisions taken

- **Restrictive policies, added; the existing policies untouched.**
  - Each table gains `<table>_owner_updates` (`as restrictive for update`, with `using` and
    `with check` both owner-or-all) and `<table>_owner_deletes` (`as restrictive for delete`,
    owner-or-all).
  - Restrictive policies AND with the permissive ones, so UPDATE and DELETE become owner-only.
    SELECT and INSERT keep 054/056/058's grants exactly, including 058's serving insert.
  - Rejected: rewriting each table's policy into an owner-only policy plus a SELECT policy, as 105
    did. Same effect, but it rewrites four policies argued in three migrations, re-states 058's
    insert grant, and breaks those migrations' own assertions about the policy text.
- **The owner-or-all predicate** is exactly 052's standard:
  `organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all'`.
- **Built on top of `routed-scoring`**, so the number follows 105. It deploys after `sfs-audit` and
  `routed-scoring`. On its own it is independent of them.

## 5. Migration 106

File: `packages/db/migrations/106-a-serving-business-reads-but-never-rewrites.sql`.

1. **Transaction.** One transaction, `begin; set local lock_timeout = '5s'; … commit;`, safe to run
   twice (drop-if-exists before each create), as 105.
2. **Policies.** For each of `conversations`, `conversation_metrics`, `messages`, `contacts`: drop
   and create the two restrictive policies of §4.
3. **Assert.**
   - Each table has both restrictive policies: `permissive = 'RESTRICTIVE'`, the right `cmd`, and a
     `qual` that names neither the routing nor the serving columns.
   - The existing `<table>_tenant_isolation` policies are still there.
   - 058's messages `with check` still admits the serving business.

`packages/db/src/policy-shape.ts` needs no change. The restrictive UPDATE policies carry a
`with check`, DELETE policies are not examined, and neither names a widening column.

## 6. Testing

Database tests run against a throwaway Postgres with every migration through 106. They seed as
the owner role and act as `nexus_app` inside `withTenant`.

Seed: three businesses (owner, serving, third), a contact owned by the owner and served by the
serving business, a conversation owned by the owner and routed to the serving business, a message
in it, and a metrics row.

Under the serving business:

- it reads the conversation, the message, the metric and the contact;
- it inserts a reply into the routed conversation (058 kept);
- its DELETE of each of the four rows affects nothing, and the rows remain;
- its UPDATE setting `organization_id` to itself affects nothing on each of the four;
- its ordinary UPDATE (status, display name, message status) changes nothing on each of the four.

Under the owner, the same UPDATE and DELETE succeed on its own rows, so nothing legitimate is
blocked. A third business reaches none of it.

Also:

- **The migration's form**: one transaction, lock timeout, the restrictive policies, the
  assertion.
- **Running it twice** succeeds.
- **The existing guards** pass: `a-write-policy-is-never-wider-than-its-read`, the routed-scoring
  and workflow-audit DB tests, and both suites.

## 7. Delivery

- **Branch and commits.** Branch `serving-read-only`, worktree `C:\CLAUDE CODE\nexus-serving-read-only`.
  Committed locally only.
- **Deploy, on the owner's "Deploy it", after `sfs-audit` and `routed-scoring`:**
  1. Merge into `main` and push.
  2. On the VPS: pull and run the drift check.
  3. At a quiet moment: `psql -v ON_ERROR_STOP=1` 105, then 106. On a lock timeout nothing
     changed; run it again.
  4. Drift check again, then `scripts/deploy.sh`.
- **Rollback.** `drop policy` the eight restrictive policies. Nothing else changed.

## 8. Out of scope

- Whether a serving business *should* be able to update its routed customers, for example marking
  them "not a customer" or opting them out from a business-scoped route. No such route exists
  today.
- `lead_assessments` (fixed in 105) and every other table.
