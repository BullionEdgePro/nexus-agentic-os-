// Operators (F8) — the first things this platform does without being asked.
//
// Two things are being pinned here. First, that the §2.3 blocker is answered by
// construction: no operator calls a model, so the inference bill that blocked
// this feature does not exist. Second, and more important, that a finding can be
// RETRACTED — an alert list that only grows is one people stop reading, and an
// unread list is indistinguishable from no list while still looking like a
// working feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const OPERATORS_DB = read("packages", "db", "src", "operators.ts");
const MIGRATION = read("packages", "db", "migrations", "027-operators.sql");
const QUEUE = read("apps", "api", "src", "queue", "operators-queue.ts");
const ROUTE = read("apps", "api", "src", "routes", "operators.ts");
const WORKER = read("apps", "api", "src", "worker.ts");
const CLIENT = read("packages", "db", "src", "client.ts");
const PAGE = read("apps", "web", "app", "deck", "operators", "page.tsx");

// ============================================================
// 1. The blocker is answered by construction
// ============================================================

test("no operator calls a model", () => {
  // ARCHITECTURE §2.3 blocked F8 on "event-triggered or paid inference?",
  // because agents polling a model bill by tenant AND by time on a deployment
  // whose agents run on a free tier. Every operator is SQL. That does not
  // decide the question — it removes the need to decide it before shipping.
  for (const forbidden of [/GoogleGenAI/, /generateContent/, /GEMINI_API_KEY/, /ANTHROPIC/]) {
    assert.ok(!forbidden.test(OPERATORS), `operators must not reach for ${forbidden}`);
  }
});

test("the sweep interval is justified by the fastest operator, not picked round", () => {
  // customer-waiting reports somebody ignored for two hours. Checked hourly, a
  // customer could wait nearly three before anyone was told.
  assert.match(QUEUE, /EVERY_TEN_MINUTES_MS = 10 \* 60 \* 1000/);
  assert.match(QUEUE, /customer-waiting/);
});

// ============================================================
// 2. A finding can be retracted — the whole design
// ============================================================

test("reconciliation opens, touches AND retracts in one statement", () => {
  const fn = OPERATORS_DB.slice(OPERATORS_DB.indexOf("export async function reconcileFindings"));
  const statement = fn.slice(fn.indexOf("`with incoming"), fn.indexOf("`,"));
  assert.ok(statement.length > 400, "the statement slice must not be empty");

  assert.match(statement, /insert into operator_findings/);
  assert.match(statement, /on conflict \(organization_id, operator, fingerprint\) do update/);
  // The line that matters: anything stored and no longer true is resolved.
  assert.match(statement, /update operator_findings f\s*\n\s*set resolved_at = now\(\)/);
  assert.match(statement, /f\.fingerprint not in \(select fingerprint from incoming\)/);
});

test("an empty finding set retracts everything rather than doing nothing", () => {
  // The tempting optimisation — return early when there is nothing to report —
  // would leave yesterday's resolved problems on screen forever, which is the
  // exact failure reconciliation exists to prevent. "Nothing is wrong" is a
  // result, not an absence of one.
  const fn = OPERATORS_DB.slice(
    OPERATORS_DB.indexOf("export async function reconcileFindings"),
    OPERATORS_DB.indexOf("const FINDING_SELECT")
  );
  assert.ok(fn.length > 500, "the function slice must not be empty");
  assert.ok(
    !/if \(found\.length === 0\) return/.test(fn),
    "an empty set must still reconcile"
  );
});

test("a finding that comes back is new again", () => {
  // Keeping the original first_seen_at would report something that returned
  // yesterday as three weeks old. Age is most of the signal on this page, so a
  // wrong age is worse than no age.
  assert.match(
    OPERATORS_DB,
    /first_seen_at = case\s*\n\s*when operator_findings\.resolved_at is not null then now\(\)/
  );
  assert.match(OPERATORS_DB, /resolved_at\s+= null/);
});

test("the identity index exists, or reconciliation silently duplicates", () => {
  // Without the unique key the ON CONFLICT has nothing to conflict on, and
  // every ten-minute sweep inserts a fresh copy of every standing problem.
  assert.match(MIGRATION, /create unique index if not exists uq_operator_findings_identity/);
  assert.match(MIGRATION, /on operator_findings \(organization_id, operator, fingerprint\)/);
  assert.match(MIGRATION, /the identity index is missing/);
});

// ============================================================
// 3. A failed operator must not clear real problems
// ============================================================

test("one operator failing does not silence or retract the others", () => {
  const runner = OPERATORS.slice(OPERATORS.indexOf("export async function runOperators"));
  assert.ok(runner.length > 400, "the runner slice must not be empty");
  // Caught per operator, inside the loop.
  assert.match(runner, /catch \(err\) \{/);
  assert.ok(!/throw err/.test(runner), "a failed operator must not abort the sweep");
  // And its findings are left alone: reconcile is only reached on success, so a
  // failed check cannot clear real problems off somebody's screen.
  const tryBlock = runner.slice(runner.indexOf("try {"), runner.indexOf("} catch"));
  assert.match(tryBlock, /reconcileFindings/);
  const catchBlock = runner.slice(runner.indexOf("} catch"));
  assert.ok(!/reconcileFindings/.test(catchBlock), "failure must not reconcile");
});

test("sweeps do not overlap", () => {
  // Two concurrent sweeps each compute the full picture and reconcile against
  // it; the slower finishing second would retract what the faster just opened.
  // The list would flicker for reasons no reader could account for.
  const block = WORKER.slice(WORKER.indexOf("const operatorsWorker"));
  assert.match(block.slice(0, 300), /concurrency: 1/);
});

// ============================================================
// 4. Not reporting what nobody can act on
// ============================================================

test("unowned follow-ups stay silent for a business with no staff", () => {
  // Every follow-up on this platform is unassigned today, because zero
  // employees exist. Without this guard the operator reports all of them,
  // forever, with no action available — and noise is what teaches people to
  // skim past the findings that matter.
  const fn = OPERATORS.slice(
    OPERATORS.indexOf("const unownedFollowUp"),
    OPERATORS.indexOf("const brokenKnowledge")
  );
  assert.ok(fn.length > 400, "the operator slice must not be empty");
  assert.match(fn, /from employees\s*\n\s*where organization_id = \$1 and is_active = true/);
  assert.match(fn, /if \(Number\(staff\[0\]\?\.n \?\? 0\) === 0\) return \[\];/);
});

test("a waiting customer is one finding, not one per message they sent", () => {
  const fn = OPERATORS.slice(
    OPERATORS.indexOf("const customerWaiting"),
    OPERATORS.indexOf("const overdueFollowUp")
  );
  assert.ok(fn.length > 400, "the operator slice must not be empty");
  assert.match(fn, /fingerprint: row\.conversation_id/);
  // And it is genuinely "waiting": the last thing said was said by them.
  assert.match(fn, /last\.sender_type = 'contact'/);
});

test("the last message is chosen deterministically, not by a coin flip", () => {
  // created_at is not unique. A reply generated in response to an inbound
  // message can land on the identical microsecond, and `order by created_at
  // desc limit 1` then picks arbitrarily between them. This operator's FIRST
  // run on production reported a real customer as ignored when the triage reply
  // had gone out at the same instant — a false positive from a coin flip, on
  // the one kind of alert that has to be trusted.
  //
  // Outbound-first on a tie is the correct reading, not merely a stable one: an
  // outbound message sharing a timestamp with an inbound one was written in
  // reply to it, so it came after.
  const fn = OPERATORS.slice(
    OPERATORS.indexOf("const customerWaiting"),
    OPERATORS.indexOf("const overdueFollowUp")
  );
  assert.match(
    fn,
    /order by m\.created_at desc,\s*\n\s*case when m\.direction = 'outbound' then 0 else 1 end/
  );
});

test("a cold sales pitch is not a customer kept waiting", () => {
  // The platform receives a steady trickle of people selling TO it. Reporting
  // an unanswered pitch as an ignored customer is the noise that teaches an
  // operator to stop reading the list — and both findings on the first real
  // sweep were of this kind.
  const fn = OPERATORS.slice(
    OPERATORS.indexOf("const customerWaiting"),
    OPERATORS.indexOf("const overdueFollowUp")
  );
  assert.match(fn, /la\.category = 'inbound_pitch'/);
  // Keyed on that affirmative classification, NOT on a zero score or a low
  // priority. A real customer writing in a language the scorer does not speak
  // also scores zero and floors at low (§9.5); suppressing them would hide the
  // customer least able to chase us.
  assert.ok(!/la\.score = 0/.test(fn), "must not suppress on score");
  assert.ok(!/la\.priority = 'low'/.test(fn), "must not suppress on priority");
});

// ============================================================
// 5. Tenant isolation and scoping
// ============================================================

test("findings are tenant-isolated like everything else naming a customer", () => {
  assert.match(CLIENT, /"operator_findings",/);
  assert.match(MIGRATION, /alter table operator_findings enable row level security/);
  assert.match(MIGRATION, /with check \(/);
  assert.match(MIGRATION, /operator_findings was created without row-level security/);
});

test("each operator reads inside its own business's context", () => {
  // They read customer data. Running them cross-tenant would be the widest read
  // on the platform, performed by code nobody is watching.
  assert.match(OPERATORS, /withTenant\(organization\.id, async \(\) => \{/);
});

test("an employee sees only their own business's findings", () => {
  // /api/operators has no :slug, so requireTenantScope does not apply and the
  // request runs cross-tenant. If this handler forgets, an employee reads five
  // businesses' findings — each naming a customer — and it looks normal.
  const handler = ROUTE.slice(ROUTE.indexOf('operatorsRoute.get("/"'));
  const operatorBranch = handler.slice(
    handler.indexOf('if (scope.role === "operator")'),
    handler.indexOf("} else {")
  );
  assert.match(operatorBranch, /c\.req\.query\("business"\)/);
  const rest = handler.replace(operatorBranch, "");
  assert.ok(!/c\.req\.query\("business"\)/.test(rest), "only an operator may choose the business");
  assert.match(handler, /not attached to a business/);
});

// ============================================================
// 6. Good news must not look like a broken sweep
// ============================================================

test("the roster comes from code, so 'found nothing' differs from 'never ran'", () => {
  // Derived from the findings table, an operator that has never reported
  // anything would simply not exist as far as the page is concerned — and the
  // two states are opposite news.
  // Asserted structurally, not by matching the comment that explains it — a
  // prose match breaks on a line wrap and proves nothing about the code.
  assert.match(ROUTE, /operators: OPERATORS\.map\(/);
  // The timestamp is a lookup ON TOP of that roster, so an operator missing
  // from the map still appears with lastSeenAt: null rather than vanishing.
  assert.match(ROUTE, /lastSeenAt: lastSeen\[operator\.slug\] \?\? null/);
  // And the page renders the roster it was given, not the findings it got.
  assert.match(PAGE, /operators\.map\(\(operator\) =>/);
});

test("a duplicate fingerprint cannot kill the sweep", () => {
  // `on conflict do update` cannot touch the same row twice in one statement.
  // Two findings sharing a fingerprint raise "ON CONFLICT DO UPDATE command
  // cannot affect row a second time" — killing that operator for that business
  // on every sweep until somebody reads a log. No operator does this today;
  // the guard is for the next one, where a join that fans out makes it easy and
  // the failure is total rather than partial.
  assert.match(OPERATORS_DB, /const unique = new Map<string, FindingInput>\(\);/);
  assert.match(OPERATORS_DB, /for \(const finding of found\) unique\.set\(finding\.fingerprint, finding\);/);
  // And the deduped list is what is actually bound — a dedupe computed and then
  // not used would be worse than none, because it reads as handled.
  assert.equal((OPERATORS_DB.match(/deduped\.map\(/g) ?? []).length, 6);
  assert.ok(!/found\.map\(/.test(OPERATORS_DB), "the raw list must not be bound");
});

test("a truncated findings list says so", () => {
  // listOpenFindings caps at 200; countOpenFindings does not. At 250 open
  // findings the page would show 200 and say nothing, which reads as "this is
  // everything" — the exact failure a page called "needs attention" must not
  // have.
  assert.match(OPERATORS_DB, /limit = 200/);
  assert.match(PAGE, /total > findings\.length/);
  assert.match(PAGE, /Showing the \{findings\.length\} most serious of \{total\}/);
});

test("an empty result is written as a result", () => {
  // A blank panel after a successful check reads as "not loaded", which is the
  // opposite of what happened.
  assert.match(PAGE, /Nothing needs attention\./);
  assert.match(PAGE, /Checked within the last ten minutes\./);
  console.log("PASS: operators run without inference, and can retract what they raised");
});
