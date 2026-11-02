# A routed chat's scores belong to the business serving it — design

Date: 2026-11-02 · Branch: `routed-scoring`, cut from `sfs-audit` (5d1f09b) · Migration: 105

## 1. The problem

All five businesses share Zipicka's WhatsApp number (migration 010). The switchboard sends a
chat to the business it is for and records that on `conversations.routed_organization_id`.

Lead scoring runs on every inbound message, inside the number owner's transaction:
`scoreLeadBestEffort` in `apps/api/src/queue/processor.ts` → `recordLeadAssessment` in
`packages/leads/src/persist.ts`, with `organization_id` = the number's owner. `lead_assessments`
keeps migration 018's owner-only row-level-security policy; it was never widened the way
migration 054 widened messages and conversations.

So a chat routed to SFS is scored as Zipicka's. Under SFS's tenant the scores do not exist:

- the inbox reason tag is missing;
- the Customers lead history is empty;
- SFS cannot label the lead;
- the workflow audit's qualifier, Hot leads, funnel and Lead quality skip it, and a routed sales
  pitch counts as a new lead.

Meanwhile Zipicka's per-business reads count scores for chats it does not serve.

## 2. What success looks like

- **The serving business sees its routed chats' scores** in every per-business view: the reason
  tag, the Customers lead history, labelling, and the audit.
- **The number's owner no longer counts them** in any per-business number.
- **History is corrected**: past routed scores move to the business that served them.
- **Scoring itself is unchanged.** No new write in the reply pipeline can fail.

## 3. Decisions taken

- **Follow migration 054's pattern** (approach A).
  - The owner keeps `organization_id`.
  - A `serving_organization_id` column, kept true by trigger, carries the serving business.
  - A separate SELECT-only policy lets the serving business read by it; the owner-only policy
    stays as it was for every command, so inserting, changing and deleting a score stay with
    the owner. (A widened policy for all commands would also widen what UPDATE and DELETE reach:
    final review, 2 Nov 2026.)
  - Rejected: writing under the serving business at scoring time (`withServingTenant`). The
    triage menu routes a chat after its first message is scored, and `persist.ts` also updates
    the owner's `contacts` row.
  - Rejected: a policy subquery into `conversations`, for 054's reasons.
- **Built on top of `sfs-audit`**, so the audit's routed-scoring disclosure is replaced by real
  counts in the same review. `sfs-audit` stays deployable on its own.

## 4. The database — migration 105

File: `packages/db/migrations/105-a-routed-chats-scores-belong-to-the-serving-business.sql`.
It must be safe to run twice: `if not exists`, `create or replace`, drop-then-create. It is one
transaction (`begin; set local lock_timeout = '5s'; … commit;`): applied by hand with `psql`,
each statement would otherwise commit on its own, leaving a moment with no policy and locks that
queue behind replies still open on their AI call. On a timeout nothing lands; run it again.

1. **Column.**
   `alter table lead_assessments add column if not exists serving_organization_id uuid references organizations(id);`
2. **Insert trigger.** A new function `set_serving_organization_for_assessment()`, `before insert
   or update of conversation_id`, sets the column to the conversation's
   `coalesce(routed_organization_id, organization_id)`. When a row is inserted with no
   `conversation_id`, or its conversation is not found, it falls back to `new.organization_id`.
   Staff-captured leads (`source = 'employee_direct'`) have no routing, so they serve their own
   business. When `conversation_id` becomes null on update (the conversation was deleted:
   `on delete set null`), the row keeps the serving business it had, so a deleted routed chat's
   scores stay with the business that served it.
3. **Re-routing cascade.** `cascade_serving_organization()` (defined in 054) is replaced with its
   two existing updates, unchanged, plus:
   `update lead_assessments set serving_organization_id = coalesce(new.routed_organization_id, new.organization_id) where conversation_id = new.id;`
   The existing trigger `trg_conversations_routing_cascade` keeps calling it. The update runs in
   the switchboard's (owner's) transaction, changes only the serving column, and passes the
   owner-only `with check`.
4. **Backfill.** Recompute every row:
   - rows with a conversation get `coalesce(c.routed_organization_id, c.organization_id)`;
   - the rest get their own `organization_id`.
   Only rows whose value differs are updated. Then `alter column serving_organization_id set not null`.
5. **Index.**
   `create index if not exists idx_lead_assessments_serving on lead_assessments(serving_organization_id, created_at desc);`
6. **Policies.**
   - `lead_assessments_tenant_isolation` is dropped and recreated in 052's owner-only shape, for
     every command: `organization_id` = current org, or scope `all`, in both `using` and
     `with check`.
   - A new `lead_assessments_serving_read`, `for select`, using `serving_organization_id` =
     current org. Permissive policies add up for SELECT only, so it reaches no row for UPDATE or
     DELETE.
7. **Assert**, as 054 does: no row with a null serving business; the owner-only policy's `qual`
   and `with_check` do not mention the serving column; and the SELECT-only policy exists and does.
8. **Labels follow the lead.** Before 105 only the number's owner could label a routed lead, and a
   label's upsert collides on `assessment_id` with a row the serving business cannot see. So 105
   moves an owner-filed label on a routed lead to the business serving it (owner's
   scorer-accuracy sample loses those; it was labelling other businesses' leads).

## 5. The readers

Readers that change, from the owner's id to the serving business's:

- `packages/db/src/contacts.ts`, a contact's lead history (`where contact_id = $2 and organization_id = $1`)
  → `serving_organization_id = $1`.
- `packages/leads/src/label-store.ts` `recordLeadLabel`, whose guard is
  `where a.id = $2 and a.organization_id = $1` → `a.serving_organization_id = $1`. A business can
  label the scores of chats it serves, and still never another business's.

Readers that start working with no code change. They key on `conversation_id`, and the widened
policy now shows the serving business its rows:

- the inbox reason tag (`packages/db/src/conversations.ts`);
- staff work (`packages/db/src/staff-work.ts`);
- My day (`apps/api/src/routes/my-day.ts`).

Readers that stay as they are:

- **Staff-captured leads** (`packages/leads/src/capture.ts`, `packages/db/src/activity.ts`): never
  routed, so serving equals owner.
- **The operator deck** (`apps/api/src/services/operators.ts`): it reads across all businesses.
- **Self-check cleanup** (`apps/api/src/scripts/self-check.ts`).
- **The contact's cached best score** (`contacts.lead_score/priority/category`, written by
  `persist.ts`): one shared value for a person whoever serves them. Existing behaviour, untouched.

The number's owner keeps read access to routed rows by `organization_id`, exactly as it keeps
routed messages. Every per-business count reads the serving column, so routed scores no longer
count for the owner.

## 6. The SFS workflow audit

In `packages/db/src/workflow-audit.ts`:

- The pitch check, the funnel's `scored` / `hot` and the Lead quality person query read
  `la.serving_organization_id = $1`.
- `won` keeps `ll.organization_id = $1`, since labels belong to the labeller.

Copy and tests:

- The disclosure comes off the AI qualifier step's `missing` text in
  `packages/shared/src/workflows/real-estate.ts` and off the funnel and Lead quality notes in
  `apps/web/app/deck/workflow/audit-charts.tsx`.
- The test that pinned the gap ("a routed chat's scoring stays with the number's owner, out of
  SFS's sight") becomes "a routed chat's scoring counts for the business serving it". Its seeded
  owner-filed assessment on the routed chat is now counted for SFS and not for the other firm.
- A routed sales pitch is filtered out of SFS's new leads.
- The business-filter source check accepts `la.serving_organization_id = $1` for assessments.
- The page test that required the disclosure now requires its absence.

## 7. Testing

Database tests run against a throwaway Postgres with `schema.sql` and every migration through
105. They seed as the owner role and read as `nexus_app`, so row-level security does real work.

- **Insert trigger.** Score rows for a routed chat (serving = SFS), an unrouted chat
  (serving = owner) and a staff capture with no chat (serving = its business).
- **Cascade.** A score written while the chat is unrouted follows the chat when it is routed, and
  follows it again on a re-route.
- **Backfill.** Spoil the column as the owner, re-apply the 105 file, and see it repaired. The
  re-run must also succeed, proving the file is safe to run twice.
- **Policy.**
  - SFS reads its routed scores; an unrelated business cannot.
  - The owner's pipeline insert works.
  - An insert as SFS with the owner's `organization_id` is refused, and so is changing
    `organization_id` to SFS.
- **Readers.** SFS's lead history for the routed contact shows the routed score. SFS can label a
  routed score and cannot label an unrelated business's.
- **Audit.** The routed lead is scored for SFS, the routed pitch is filtered, and the other
  firm's audit no longer counts the routed score.
- **Guards.** The existing policy guards (`a-write-policy-is-never-wider-than-its-read` and the
  tenant-table list) pass.
- **Everything else.** Both full suites, typecheck in all four packages, and `next build`.

## 8. Delivery

- **Branch and commits.** Branch `routed-scoring` in worktree `C:\CLAUDE CODE\nexus-routed-scoring`.
  Committed locally only.
- **Deploy, on the owner's "Deploy it":**
  1. Merge `sfs-audit` and `routed-scoring` into `main`, then `git push origin main`.
  2. On the VPS: `git pull`, then `scripts/schema-drift-check.sh`.
  3. Apply 105 by hand with `psql -v ON_ERROR_STOP=1` as the owner, at a quiet moment. It is one
     transaction with a 5-second lock timeout: if it times out, nothing changed; run it again.
  4. Run the drift check again, then `scripts/deploy.sh`.
  The drift check replays every file in sorted order with no ledger, so staff chat's 104 not yet
  being merged leaves only a numbering gap. Applying 105 before the new code is safe: the trigger
  fills the column for the old code's writes.
- **Rollback.** Roll back the code and the policy together: drop `lead_assessments_serving_read`
  (the owner-only policy is already the old one). A policy-only rollback under the new code
  brings back the routed-pitch miscount without the page's old warning. The column, index and
  triggers are harmless left in place. Two things do not roll back: labels moved to the serving
  business stay there, and a business that serves scores cannot be deleted before those scores
  (the serving key has no delete action, as with messages).

## 9. Out of scope

- How messages are scored.
- Re-scoring past messages.
- The contact's shared cached score.
- The staff-chat migration (104).
- Other tables still filed under the number's owner.
