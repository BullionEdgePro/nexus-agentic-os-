# Routed chats' scores belong to the serving business — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat routed through the shared number has its lead scores filed under, readable by and
counted for the business serving it, as migration 054 did for messages.

**Architecture:**
- `lead_assessments` gains `serving_organization_id`, kept true by triggers: on insert, and in
  054's routing cascade.
- The read policy widens to that column; writes stay owner-only.
- A backfill corrects history.
- The two readers keyed on the owner, and the SFS workflow audit, switch to the serving column.

**Tech Stack:** Postgres 16 (row-level security, plpgsql triggers); TypeScript packages
`@nexus/db`, `@nexus/leads`, `@nexus/shared`; node:test for both suites.

**Spec:** `docs/superpowers/specs/2026-11-02-routed-scoring-design.md`

## Global Constraints

- Scoring is unchanged: no edit to `scoreLead`, `scoreLeadBestEffort` or `recordLeadAssessment`.
- Writes stay with the number's owner: the policy's `with check` stays exactly owner-only.
- Migration 105 is safe to run twice: `if not exists`, `create or replace`, drop-then-create.
- Database tests:
  - seed as the owner role and read as `nexus_app` inside `withTenant`;
  - read the env vars `AUDIT_TEST_OWNER_URL` and `AUDIT_TEST_APP_URL`, and skip without them;
  - run against the throwaway Postgres from
    `…/scratchpad/audit-pg.sh "C:/CLAUDE CODE/nexus-routed-scoring"` (container `nexus-audit-pg`, port 55433).
- Commit locally only. Never push or deploy without the owner's "Deploy it".
- API suite: the only acceptable failure is the Windows-only "mirror.sh is itself executable".

## Review Focus

1. **Deleting a routed conversation** (`conversation_id` is `on delete set null`, which fires the
   update trigger) must leave its scores with the business that served it, not hand them back to
   the number's owner. Pinned in Task 1.
2. **A chat routed, re-routed, then unrouted**: its scores follow each step, ending with the
   owner. Pinned in Task 1.
3. **A person served by both the owner and a routed business**: each business's lead history
   shows only the scores from the chats it serves. Pinned in Task 2.
4. **A label attempt by a business on a score it does not serve** is refused, even though the
   widened policy lets the number's owner read every routed row. Pinned in Task 2.
5. **A routed sales pitch** is filtered out of the serving business's new leads, and the owner's
   audit counts none of the routed scores. Pinned in Task 3.

---

### Task 1: Migration 105 — the serving column, its triggers, the backfill and the policy

**Files:**
- Create: `packages/db/migrations/105-a-routed-chats-scores-belong-to-the-serving-business.sql`
- Test: `apps/api/test/a-routed-chats-scores-belong-to-the-serving-business.test.mjs`
- Modify: `docs/superpowers/specs/2026-11-02-routed-scoring-design.md` §4.2 (the delete ruling)

**Interfaces:**
- Produces: the column `lead_assessments.serving_organization_id uuid not null`.
- Produces: the function `set_serving_organization_for_assessment()`, fired `before insert or update
  of conversation_id`:
  - a non-null `conversation_id` takes the conversation's `coalesce(routed_organization_id, organization_id)`,
    or `new.organization_id` when the conversation is not visible;
  - a null `conversation_id` on insert takes `new.organization_id`;
  - a null on update keeps `old.serving_organization_id`.
- Produces: `cascade_serving_organization()`, replaced with its two existing 054 statements
  unchanged plus the `lead_assessments` update.
- Produces: the policy `lead_assessments_tenant_isolation` (spec §4.6) and the index
  `idx_lead_assessments_serving`.

- [ ] **Step 1: Write the failing tests.**

  Seed, as the owner, in a `before()`:
  - three organisations: `OWNER`, `SERVING`, `THIRD`;
  - a contact `ROUTED_CT` with conversations `ROUTED_CONV` (owner `OWNER`, routed to `SERVING`)
    and `PLAIN_CONV` (owner, unrouted), each with an inbound contact message.

  The `before()` then applies the 105 file with `owner.query(readFileSync(MIGRATION))`.
  Scores are written through the real writer: `withTenant(OWNER, () => recordLeadAssessment(...))`
  from `@nexus/leads`, as `nexus_app`.

```js
test("a score is filed under the business serving its chat", db, async () => {
  // routed → SERVING; unrouted → OWNER; no conversation → its own organization_id
  assert.deepEqual(await servingOf([routedScore, plainScore, capturedScore]), [SERVING, OWNER, OWNER]);
});
test("a score written before the chat was routed follows the chat, every time it moves", db, async () => {
  // scored while PLAIN_CONV is unrouted, then owner routes it to SERVING, then THIRD, then null
  assert.deepEqual(trail, [OWNER, SERVING, THIRD, OWNER]);
});
test("deleting a routed chat leaves its scores with the business that served it", db, async () => {
  // owner deletes a third routed conversation; its score's conversation_id becomes null
  assert.equal(row.conversation_id, null);
  assert.equal(row.serving_organization_id, SERVING);
});
test("the serving business reads its routed scores; writes still need the owner", db, async () => {
  assert.ok((await asTenant(SERVING, idsVisible)).includes(routedScore));
  assert.ok(!(await asTenant(SERVING, idsVisible)).includes(plainScore));
  assert.equal((await asTenant(THIRD, idsVisible)).length, 0);
  await assert.rejects(asTenant(SERVING, insertWithOrg(OWNER)), /row-level security/);
  await assert.rejects(asTenant(OWNER, moveOrgTo(SERVING, routedScore)), /row-level security/);
});
test("105 repairs a wrong serving business and can run again", db, async () => {
  await owner.query(`update lead_assessments set serving_organization_id = organization_id where id = $1`, [routedScore]);
  await owner.query(MIGRATION_SQL);
  await owner.query(MIGRATION_SQL); // twice: safe to re-run
  assert.equal(await servingOne(routedScore), SERVING);
});
test("the migration keeps writes owner-only and checks itself", () => {
  assert.match(SQL, /with check \(\s*organization_id::text = current_setting\('app\.current_org', true\)\s*or current_setting\('app\.tenant_scope', true\) = 'all'\s*\)/);
  assert.match(SQL, /raise exception/);
  assert.match(SQL, /alter column serving_organization_id set not null/);
});
```

- [ ] **Step 2: Run.**
  `cd apps/api && AUDIT_TEST_OWNER_URL=… AUDIT_TEST_APP_URL=… node --import tsx --test test/a-routed-chats-scores-belong-to-the-serving-business.test.mjs`
  Expected: FAIL. The migration file does not exist (ENOENT), so every case fails.
- [ ] **Step 3: Write migration 105** following spec §4, steps 1–7, with the delete ruling above in
  the insert trigger. Header comment in 054's style: the problem, why the pattern, the order after 054.
- [ ] **Step 4: Run** the test file: PASS 6/6. Then the full API suite: only mirror.sh may fail. The
  policy guard `a-write-policy-is-never-wider-than-its-read` must pass. If a tenant-table guard
  lists widened tables, add `lead_assessments` to it and say why in the comment.
- [ ] **Step 5: Commit.**
  `git commit -m "Migration 105: a routed chat's scores belong to the business serving it"`

### Task 2: The readers keyed on the owner

**Files:**
- Modify: `packages/db/src/contacts.ts` (`getContact`'s lead history query, ~line 214)
- Modify: `packages/leads/src/label-store.ts` (`recordLeadLabel`'s guard, ~line 34)
- Test: `apps/api/test/a-routed-chats-scores-belong-to-the-serving-business.test.mjs` (add)

**Interfaces:**
- Consumes: Task 1's column and policy.
- Produces: `getContact(organizationId, contactId, ownedBy?)`. Its `leadHistory` is the scores of
  the chats `organizationId` serves.
- Produces: `recordLeadLabel(input)`. Returns `true` only for an assessment whose
  `serving_organization_id = input.organizationId`.

- [ ] **Step 1: Write the failing tests.**

```js
test("each business's lead history shows the scores from the chats it serves", db, async () => {
  const served = await asTenant(SERVING, () => getContact(SERVING, ROUTED_CT));
  assert.ok(served.leadHistory.some((l) => l.id === routedScore));
  assert.ok(!served.leadHistory.some((l) => l.id === plainScore));
  const owned = await asTenant(OWNER, () => getContact(OWNER, ROUTED_CT));
  assert.ok(!owned.leadHistory.some((l) => l.id === routedScore));
});
test("a business labels the scores of chats it serves, and nobody else's", db, async () => {
  assert.equal(await asTenant(SERVING, () => recordLeadLabel(label(SERVING, routedScore))), true);
  assert.equal(await asTenant(SERVING, () => recordLeadLabel(label(SERVING, plainScore))), false);
  assert.equal(await asTenant(OWNER, () => recordLeadLabel(label(OWNER, routedScore))), false);
});
```

- [ ] **Step 2: Run** the file. Expected: FAIL. SFS's lead history lacks the routed score, and its
  label returns `false`.
- [ ] **Step 3: Change** both `organization_id = $1` filters on `lead_assessments` to
  `serving_organization_id = $1`, each with a one-line comment naming 105.
- [ ] **Step 4: Run** the file (8/8), then the full API suite and `npx tsc --noEmit -p .` in
  `packages/db` and `packages/leads`.
- [ ] **Step 5: Commit.**
  `git commit -m "Lead history and labels follow the business serving the chat"`

### Task 3: The SFS workflow audit counts routed scores

**Files:**
- Modify: `packages/db/src/workflow-audit.ts`: the pitch check, funnel `scored` / `hot`, and the
  Lead quality `person` query.
- Modify: `packages/shared/src/workflows/real-estate.ts`: D2's `missing` back to
  `"Budget, timeline and finance are not captured."`.
- Modify: `apps/web/app/deck/workflow/audit-charts.tsx`: drop the `ROUTED` constant and its two
  uses.
- Test: `apps/api/test/the-workflow-audit-counts-what-happened.test.mjs`
- Test: `apps/web/test/the-workflow-in-cream.test.mjs`

**Interfaces:**
- Consumes: Task 1's column. Every `lead_assessments la` read in the audit filters
  `la.serving_organization_id = $1`.

- [ ] **Step 1: Change the tests first.**
  - In the seed, add a routed sales pitch: a `facebook` contact `c…0009` owned by `OTHER`, a
    conversation routed to `SFS` with one contact message, and an `inbound_pitch` assessment filed
    by `OTHER`.
  - Expected values move:
    - `pitches` 1 → 2 and `contacts.total` 6 → 7;
    - `qualifier` `{ scored: 2, hot: 1 }` → `{ scored: 3, hot: 2 }`;
    - `funnel` → `{ leads: 3, scored: 3, hot: 2, booked: 1, held: 1, won: 1 }`;
    - the quality series sums 3 and 2.
  - Rename "a routed chat's scoring stays with the number's owner, out of SFS's sight" to "a routed
    chat's scoring counts for the business serving it". It asserts SFS's `qualifier.scored === 3`
    and `funnel.scored === 3`, and the other firm's `qualifier.scored === 0`.
  - The source check accepts `${alias}\.(serving_)?organization_id = \$1` and adds
    `assert.doesNotMatch(SRC, /la\.organization_id = \$1/)`.
  - In the web test "the page says where its figures stop", replace the two routed assertions with
    `assert.doesNotMatch(qualifier, /routed in through a shared number/)` and
    `assert.doesNotMatch(charts, /routed in through a shared number/)`.
- [ ] **Step 2: Run** both test files. Expected: FAIL. The audit test fails on the new numbers and
  the source check; the web test fails on the disclosure.
- [ ] **Step 3: Implement** the three file changes.
- [ ] **Step 4: Run** both full suites; `npx tsc --noEmit -p .` in apps/web, apps/api, packages/db
  and packages/shared; and `npx next build` in apps/web.
- [ ] **Step 5: Commit.**
  `git commit -m "Workflow audit: routed chats' scores count for the business serving them"`
