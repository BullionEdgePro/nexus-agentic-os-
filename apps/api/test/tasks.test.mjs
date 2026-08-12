// Follow-ups (F7's buildable slice) — tasks tied to conversations.
//
// The tests below are of two kinds, and the difference matters because this
// codebase has been bitten by forgetting it: the first group RUNS the code and
// asserts what it does; the second reads source text and asserts that a
// specific decision is still present. Text assertions cannot know what the
// database will decide, so they are used only where the decision IS the text —
// a table on a policy list, a coalesce in a query, a route not mounted behind a
// guard. Anything the database settles is left to schema-check.ts and
// rls-verify.ts, which run against the real thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createTask } from "@nexus/db";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const TASKS_DB = read("packages", "db", "src", "tasks.ts");
const TASKS_ROUTE = read("apps", "api", "src", "routes", "tasks.ts");
const MIGRATION = read("packages", "db", "migrations", "025-conversation-tasks.sql");
const CLIENT = read("packages", "db", "src", "client.ts");
const API_INDEX = read("apps", "api", "src", "index.ts");
const PAGE = read("apps", "web", "app", "deck", "tasks", "page.tsx");

// ============================================================
// 1. Validation, actually executed
// ============================================================
//
// Every one of these rejects before the function touches the database, which is
// why they can run here at all — and is also the point. A bad title reaching
// Postgres produces a constraint error that surfaces to an operator as
// "internal error" about a form they could have fixed in five seconds.

test("a task with no title is refused", async () => {
  await assert.rejects(
    () => createTask({ organizationId: "00000000-0000-0000-0000-000000000001", title: "   " }),
    /needs a title/
  );
});

test("a title too long to read in a list is refused", async () => {
  await assert.rejects(
    () => createTask({ organizationId: "00000000-0000-0000-0000-000000000001", title: "x".repeat(201) }),
    /under 200 characters/
  );
});

test("an unreadable due date is refused before it reaches Postgres", async () => {
  // Postgres would raise a type error here, which arrives as a 500 naming no
  // field. The rejection has to name the value the operator typed.
  await assert.rejects(
    () =>
      createTask({
        organizationId: "00000000-0000-0000-0000-000000000001",
        title: "Call back",
        dueAt: "next tuesday",
      }),
    /not a date I can read/
  );
});

test("a task belonging to no business is refused", async () => {
  // Without this the row would be rejected by a not-null constraint at insert
  // time, after the conversation lookup — a worse error, later, for the same
  // mistake.
  await assert.rejects(() => createTask({ title: "Chase the licence" }), /must belong to a business/);
});

// ============================================================
// 2. The shared-number trap
// ============================================================

test("the business comes from the conversation's routed org, not its owner", () => {
  // Five businesses answer one WhatsApp number, so EVERY conversation is owned
  // by the number's owner (Zipicka) while routed_organization_id holds the
  // business the enquiry actually reached. Reading organization_id here would
  // file every follow-up under Zipicka: the law firm's tasks invisible to the
  // law firm, visible to a retailer, and nothing looking broken — one busy list
  // and four empty ones.
  assert.match(
    TASKS_DB,
    /select coalesce\(routed_organization_id, organization_id\) as organization_id, contact_id\s*\n\s*from conversations where id = \$1/
  );
});

test("a caller cannot choose the business when a conversation is given", () => {
  // organizationId is reassigned from the lookup rather than defaulted to it,
  // so a request body claiming a different business is overwritten, not merged.
  const create = TASKS_DB.slice(TASKS_DB.indexOf("export async function createTask"));
  assert.match(create, /organizationId = rows\[0\]\.organization_id;/);
});

// ============================================================
// 3. Cross-business assignment
// ============================================================

test("both doors into assignment check the employee's business", () => {
  // A foreign key to employees does not say WHICH business's employee, and RLS
  // does not help: the deck runs in a cross-tenant context where both rows are
  // legitimately visible. Unchecked, ABR's litigation follow-up — customer name
  // and phone number included — lands on a shop assistant's list at another
  // company as ordinary work.
  //
  // createTask and assignTask are separate doors into the identical mistake, so
  // both are asserted.
  const create = TASKS_DB.slice(
    TASKS_DB.indexOf("export async function createTask"),
    TASKS_DB.indexOf("export async function completeTask")
  );
  const assign = TASKS_DB.slice(TASKS_DB.indexOf("export async function assignTask"));
  assert.ok(create.length > 500 && assign.length > 300, "the slices must not be empty");

  assert.match(create, /organization_id = \$2/);
  assert.match(assign, /e\.organization_id = t\.organization_id/);
  // Refused loudly. Silently dropping the employee to null would leave a task
  // nobody owns, which is precisely the state this feature exists to surface.
  assert.equal((TASKS_DB.match(/does not work for this business/g) ?? []).length, 2);
});

// ============================================================
// 4. Tenant isolation
// ============================================================

test("tasks is on the tenant-scoped table list", () => {
  // Missing from this list, an unscoped query against tasks would be allowed
  // through the assertion and then silently return nothing under RLS.
  assert.match(CLIENT, /"contact_memory",\s*\n(\s*\/\/[^\n]*\n)*\s*"tasks",/);
});

test("the migration enables RLS and refuses to finish if it did not", () => {
  assert.match(MIGRATION, /alter table tasks enable row level security/);
  assert.match(MIGRATION, /create policy tasks_tenant_isolation on tasks/);
  // `with check` as well as `using`. Without it the policy filters reads and
  // permits any write, which is the more dangerous half.
  assert.match(MIGRATION, /with check \(\s*\n\s*organization_id::text = current_setting\('app\.current_org', true\)/);
  assert.match(MIGRATION, /raise exception 'tasks was created without row-level security/);
});

test("deleting a conversation does not delete what someone still owes a customer", () => {
  // `on delete cascade` here would mean tidying up a conversation silently
  // discards the follow-up promised in it.
  assert.match(MIGRATION, /conversation_id\s+uuid references conversations\(id\) on delete set null/);
  assert.match(MIGRATION, /contact_id\s+uuid references contacts\(id\) on delete set null/);
});

// ============================================================
// 5. Who may read the list
// ============================================================

test("tasks is deliberately not operator-only, unlike activity and quality", () => {
  // A board only the manager can see is a report, not a board. But the
  // consequence is that /api/tasks carries no :slug for requireTenantScope to
  // read, so the narrowing has to happen in the handler — and if it does not,
  // an employee reads five businesses' customer commitments and the response
  // looks entirely normal.
  assert.ok(!/app\.use\("\/api\/tasks", operatorOnly\)/.test(API_INDEX));
  assert.match(API_INDEX, /app\.route\("\/api\/tasks", tasksRoute\)/);
});

test("an employee's list is narrowed to their own business, whatever they ask for", () => {
  const handler = TASKS_ROUTE.slice(
    TASKS_ROUTE.indexOf('tasksRoute.get("/"'),
    TASKS_ROUTE.indexOf('tasksRoute.post("/"')
  );
  assert.ok(handler.length > 400, "the handler slice must not be empty");
  // The ?business= query parameter is read ONLY inside the operator branch.
  const operatorBranch = handler.slice(
    handler.indexOf('if (scope.role === "operator")'),
    handler.indexOf("} else {")
  );
  assert.match(operatorBranch, /c\.req\.query\("business"\)/);
  assert.equal((handler.match(/c\.req\.query\("business"\)/g) ?? []).length, 1);
  // And an employee session with no business is refused rather than falling
  // through to an unfiltered query.
  assert.match(handler, /not attached to a business/);
});

test("an employee cannot file work into another company's list", () => {
  const post = TASKS_ROUTE.slice(
    TASKS_ROUTE.indexOf('tasksRoute.post("/"'),
    TASKS_ROUTE.indexOf('tasksRoute.patch(')
  );
  assert.ok(post.length > 400, "the handler slice must not be empty");
  // body.business is honoured only for an operator; an employee's org comes
  // from their session.
  const operatorBranch = post.slice(
    post.indexOf('if (scope.role === "operator")'),
    post.indexOf("} else {")
  );
  assert.match(operatorBranch, /body\.business/);
  // Asserted by absence from the rest of the handler rather than by counting
  // occurrences inside it — the count changes with a type guard and proves
  // nothing about who the parameter is honoured for.
  const rest = post.replace(operatorBranch, "");
  assert.ok(!/body\.business/.test(rest), "body.business must not be read outside the operator branch");
});

test("an employee cannot change a task belonging to another business", () => {
  // Found by reviewing this feature's own diff. PATCH /api/tasks/:id takes an
  // id and no slug, so it runs in a cross-tenant database context — RLS is
  // deliberately open for the length of that request because the deck spans all
  // five businesses. Nothing underneath would have stopped an employee at one
  // company from closing another company's follow-up: the row would change, the
  // response would look ordinary, and the only trace would be work marked done
  // that nobody did.
  //
  // The constraint travels IN the query rather than sitting in front of it,
  // because a caller-side check is the one someone forgets on the next endpoint.
  for (const fn of ["completeTask", "setTaskStatus", "assignTask"]) {
    const body = TASKS_DB.slice(TASKS_DB.indexOf(`export async function ${fn}`));
    const query = body.slice(0, body.indexOf("${returning("));
    assert.match(query, /::uuid is null or organization_id = \$/, `${fn} must carry the guard`);
  }
  // And the route supplies it for an employee, null only for an operator.
  assert.match(TASKS_ROUTE, /if \(scope\.role !== "operator"\) \{\s*\n\s*within = scope\.organizationId \?\? null;/);
  assert.match(TASKS_ROUTE, /setTaskStatus\(taskId, body\.status as TaskStatus, within\)/);
  assert.match(TASKS_ROUTE, /assignTask\(\s*\n?\s*taskId,[\s\S]{0,140}within\s*\n?\s*\)/);
});

test("a writer returns the CTE's own rows, never a re-read of the table", () => {
  // Found by schema-check.ts on the first real run, after this file's unit
  // tests, the typecheck and the production build had all passed.
  //
  // A data-modifying CTE's effects are invisible to the rest of the statement
  // it lives in — every part of the query sees the snapshot taken when the
  // statement began. So `with x as (insert ... returning id) select ... from
  // tasks t where t.id = (select id from x)` reads the table as it was BEFORE
  // the write.
  //
  // The two halves failed very differently, which is the reason this test
  // exists rather than just the fix:
  //
  //   insert — nothing matches, rows[0] is undefined, it throws. Loud.
  //   update — the row already exists, so it matches and returns its
  //            PRE-UPDATE values. The write commits, the caller is told the
  //            task is still open, and nothing errors anywhere.
  //
  // The second would have shipped. So the shape is asserted, not the symptom.
  for (const fn of ["createTask", "completeTask", "setTaskStatus", "assignTask"]) {
    const body = TASKS_DB.slice(TASKS_DB.indexOf(`export async function ${fn}`));
    // Both ends anchored on the CTE. Searching for the closing backtick from
    // position 0 finds the end of an EARLIER query in the same function —
    // createTask does two lookups before it writes — and the slice comes back
    // empty, which asserts nothing.
    const start = body.indexOf("`with ");
    const statement = body.slice(start, body.indexOf("`,", start));
    assert.ok(statement.length > 60, `${fn}: could not isolate the statement`);
    assert.match(statement, /returning \*/, `${fn} must return the written row`);
    assert.match(statement, /\$\{returning\("/, `${fn} must select from the CTE`);
    assert.ok(
      !/from tasks t/.test(statement),
      `${fn} must not re-read tasks in the same statement it writes it`
    );
  }
});

// ============================================================
// 6. Overdue is the database's decision
// ============================================================

test("overdue is computed by Postgres, not by the browser", () => {
  // The single most operationally important flag on the page. Computed from
  // Date.now() in the client it would depend on the correctness of whichever
  // laptop is open: an hour fast invents a column of emergencies, an hour slow
  // hides the one thing that is actually late.
  assert.match(TASKS_DB, /\(t\.status = 'open' and t\.due_at is not null and t\.due_at < now\(\)\) as is_overdue/);
  // The page consumes the flag and never recomputes it.
  assert.match(PAGE, /task\.isOverdue/);
  assert.ok(!/Date\.now\(\)/.test(PAGE), "the page must not decide lateness from the client clock");
});

test("a local datetime is converted before it is sent", () => {
  // <input type="datetime-local"> yields "2026-08-14T16:00" with no zone. Sent
  // as-is, Postgres reads it as UTC — four hours out in Dubai, so a 4pm
  // callback sits on the list looking on time until 8pm.
  assert.match(PAGE, /draftDue \? new Date\(draftDue\)\.toISOString\(\) : null/);
});

test("undated tasks sort last, not first", () => {
  // Postgres sorts nulls FIRST on an ascending order, which would put every
  // vague intention above tomorrow morning's callback.
  assert.match(TASKS_DB, /t\.due_at asc nulls last/);
});

// ============================================================
// 7. Nothing deletes
// ============================================================

test("a task is cancelled, never deleted", () => {
  // The row is the record that something was owed to a customer. There is no
  // DELETE endpoint, and cancelling keeps the history.
  assert.ok(!/\.delete\(/.test(TASKS_ROUTE), "no delete endpoint");
  assert.match(MIGRATION, /check \(status in \('open', 'done', 'cancelled'\)\)/);
});

test("reopening clears the completion record", () => {
  // Left in place, a live task would display the date it was finished and the
  // name of whoever finished it, which reads as data corruption.
  assert.match(TASKS_DB, /completed_at = case when \$2 = 'done' then completed_at else null end/);
  assert.match(TASKS_DB, /completed_by = case when \$2 = 'done' then completed_by else null end/);
  console.log("PASS: follow-ups — business from the routed org, assignment checked, overdue from the DB clock");
});
