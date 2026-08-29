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
import { operatorBody, withoutComments } from "../../../scripts/recurrence/source.mjs";

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

/** Every module the sweep imports from, read from its own import statements. */
function sweepImports(src) {
  // COMMENTS STRIPPED FIRST. This scans for `from "` anywhere in the file, and
  // on 2026-08-27 a comment reading `a different thing from "remind me later"`
  // was reported as an unapproved import of a module called "remind me later".
  //
  // Funny, and the wrong kind of wrong: an allow-list check that prose can
  // break is one somebody eventually widens to make their sentence compile,
  // and this is the check standing between the ten-minute sweep and a model
  // bill. It should fail on imports and on nothing else.
  const code = withoutComments(src);
  const out = new Set();
  const NEEDLE = 'from "';
  let at = code.indexOf(NEEDLE);
  while (at !== -1) {
    const from = at + NEEDLE.length;
    const to = code.indexOf('"', from);
    if (to !== -1) out.add(code.slice(from, to));
    at = code.indexOf(NEEDLE, at + 1);
  }
  return [...out].sort();
}

test("no operator calls a model", () => {
  // ARCHITECTURE §2.3 blocked F8 on "event-triggered or paid inference?",
  // because agents polling a model bill by tenant AND by time on a deployment
  // whose agents run on a free tier. Every operator is SQL. That does not
  // decide the question — it removes the need to decide it before shipping.
  //
  // AN ALLOW-LIST OF IMPORTS, not a denylist of SDK names. This checked for
  // GoogleGenAI, generateContent, GEMINI_API_KEY and ANTHROPIC — four spellings
  // of the two vendors used on the day it was written. OpenAI, Mistral, a
  // self-hosted endpoint, or a local helper named `ask()` would all have passed
  // it, and so would `import { routeToDomainAgent } from "@nexus/agents"`,
  // which is this repository's own front door to a model.
  //
  // The same inversion governance/policy.ts made for tenants: an allow-list is
  // wrong in the safe direction. A new import here fails until somebody looks
  // at it, and looking at it is the entire point.
  const ALLOWED = new Set([
    "@nexus/db",
    "@nexus/leads",
    "@nexus/governance",
    "@nexus/shared",
    "../lib/logger.js",
    "./alert-dispatch.js",
    // Added 2026-08-29 after checking, which is what this list is for.
    // whatsapp-client reaches graph.facebook.com and nothing else — no model,
    // no SDK, no inference. It is here because account-standing asks Meta how
    // it rates the shared number, and nothing on the platform had ever asked.
    //
    // The cost question this list exists to force was asked and answered: the
    // call is made ONCE PER SWEEP by readSharedNumberStanding and handed to
    // every business through SweepContext, because all six answer on one
    // number. The first draft called it per business, which would have turned
    // a sweep of plain SQL into five network round trips every ten minutes —
    // and this gate is what stopped it.
    "../lib/whatsapp-client.js",
    // Added 2026-08-25 after checking, which is what this list is for. The
    // automation runner imports @nexus/db and a logger and nothing else; it
    // acts on findings the sweep has already made and calls no model. The
    // check that would catch it if that changed is this line failing again.
    "./automation-runner.js",
  ]);

  const imports = sweepImports(OPERATORS);
  assert.ok(imports.length >= 4, `only ${imports.length} imports parsed — the scan is probably broken`);

  for (const module of imports) {
    assert.ok(
      ALLOWED.has(module),
      `operators.ts imports ${module}, which is not on the allow-list. If it reaches a model — ` +
        `directly or through @nexus/agents — the sweep bills by tenant and by time, every ten ` +
        `minutes, which is the question ARCHITECTURE §2.3 deferred rather than answered. Add it ` +
        `here only after checking it does not.`
    );
  }

  // The denylist is kept as well: it costs nothing and it catches a model
  // reached without an import, which the allow-list above cannot see.
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
  // Through operatorBody rather than a raw slice: customer-waiting's query
  // moved into a shared reader on 2026-08-25 so the operator and the view of
  // what it SUPPRESSES could not drift apart, and a slice that stops at the
  // next `const` stopped seeing the SQL. The property is unchanged.
  const fn = operatorBody(OPERATORS, "customer-waiting");
  assert.ok(fn, "customer-waiting is gone");
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
  // operatorBody, not a raw slice: the query moved into a shared reader so
  // the operator and the view of what it suppresses cannot drift apart.
  const fn = operatorBody(OPERATORS, "customer-waiting");
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
  // operatorBody, not a raw slice: the query moved into a shared reader so
  // the operator and the view of what it suppresses cannot drift apart.
  const fn = operatorBody(OPERATORS, "customer-waiting");
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
  // Seven since migration 053 added serving_organization_id. Counted rather
  // than listed so a binding added without a column, or the reverse, fails
  // here rather than at the first sweep after a deploy.
  assert.equal((OPERATORS_DB.match(/deduped\.map\(/g) ?? []).length, 7);
  assert.ok(!/found\.map\(/.test(OPERATORS_DB), "the raw list must not be bound");
});

test("a truncated findings list says so", () => {
  // listOpenFindings caps at 200; countOpenFindings does not. At 250 open
  // findings the page would show 200 and say nothing, which reads as "this is
  // everything" — the exact failure a page called "needs attention" must not
  // have.
  //
  // AGAINST `active`, NOT `findings`, since migration 061. The list now carries
  // accepted findings too, and `total` counts only what needs attention -- so
  // comparing against findings.length would put the accepted ones on one side
  // of the inequality and not the other, and the banner would stop appearing at
  // exactly the moment the cap started to bite. Same check, corrected operand.
  assert.match(OPERATORS_DB, /limit = 200/);
  assert.match(PAGE, /total > active\.length/);
  assert.match(PAGE, /Showing the \{active\.length\} most serious of \{total\}/);
});

test("the promise is caught at least as fast as the silence", () => {
  // handover-abandoned sat at twelve hours while customer-waiting warned at two,
  // and the operator's own severity comment says there is no gentle version of
  // this state. Those two positions disagreed in the same file: a business being
  // slow was caught in two hours, a business having PROMISED in twelve.
  //
  // It cannot be noisy the way a two-hour threshold usually is — the condition
  // is not "quiet for two hours" but handover flagged AND no human_agent message
  // has ever existed in the conversation AND it is not a cold pitch.
  assert.match(OPERATORS, /const ABANDONED_HANDOVER_HOURS = 2;/);
  assert.match(OPERATORS, /const WAITING_WARN_HOURS = 2;/);

  // Still urgent at any age: unlike a slow reply, this state does not resolve
  // itself.
  const operator = OPERATORS.slice(
    OPERATORS.indexOf("const handoverAbandoned"),
    OPERATORS.indexOf("const deliveryFailing")
  );
  assert.match(operator, /severity: "urgent" as const/);
});

test("an empty result is written as a result, and says when it was checked", () => {
  // A blank panel after a successful check reads as "not loaded", which is the
  // opposite of what happened.
  assert.match(PAGE, /Nothing needs attention\./);

  // This assertion used to demand the literal sentence "Checked within the last
  // ten minutes." — which was hardcoded prose, and therefore a test pinning a
  // CLAIM rather than a fact. It would have gone on passing while the sweep sat
  // dead for a week and the panel reassured somebody every time they opened it.
  //
  // Migration 050 records when the sweep actually finished, so the page now
  // reports it. What is asserted here is that the freshness is DERIVED, not
  // written down; sweep-freshness.test.mjs covers the stalled wording.
  assert.match(PAGE, /describeSweep\(sweep\.lastSweptAt\)/);
  assert.ok(
    !/Checked within the last ten minutes/.test(PAGE.replace(/^[ 	]*\/\*[\s\S]*?\*\//gm, " ")),
    "the panel must not go back to asserting its own freshness"
  );
  console.log("PASS: operators run without inference, and can retract what they raised");
});

// ============================================================
// The classifier stopping must not read as a quiet week
// ============================================================

test("an operator watches for conversations recorded without an intent", () => {
  // `IntentCoverage.neverClassified` carried this warning in its own doc
  // comment for the whole life of F5 — "rising, it means the classifier stopped
  // running, and that is a defect rather than a quiet week" — and nothing read
  // it. `getIntentCoverage` was consulted by one hand-run backfill script and
  // by nothing on a schedule.
  //
  // It matters more than it sounds because every consumer of intent degrades to
  // a plausible empty result: the shared store pools nothing, no procedure is
  // ever recalled, hotspots empty. All three look like a business with no
  // traffic, and this feature has already lost months to exactly that
  // confusion once.
  const OPERATORS = readFileSync(
    join(here, "..", "src", "services", "operators.ts"),
    "utf8"
  );
  assert.match(OPERATORS, /slug: "intent-unclassified"/);
  // Counts NULL intent in a recent window, per business, and says nothing when
  // there are none — an operator that fires on a healthy system is noise.
  assert.match(OPERATORS, /count\(\*\) filter \(where intent is null\)/);
  assert.match(OPERATORS, /if \(missing === 0\) return \[\];/);
  // Registered, or it is dead code with a test.
  assert.match(OPERATORS, /OPERATORS: Operator\[\] = \[[\s\S]*intentClassificationStopped/);
  // Calls no model, like every operator here — it has to work on the day the
  // models are the thing that broke.
  const fn = OPERATORS.slice(OPERATORS.indexOf('slug: "intent-unclassified"'));
  const body = fn.slice(0, fn.indexOf("\n};"));
  assert.ok(
    !/anthropic|generateText|embed|gemini/i.test(body),
    "operators must not call a model"
  );
});

test("the brain screen leads with whether it can see, not with what it knows", () => {
  // Putting the pooled patterns first would repeat the original mistake in a
  // nicer font: the store spent months reporting an emptiness that looked like
  // youth while actually reading a sixth of the platform.
  const SECTION = readFileSync(
    join(here, "..", "..", "web", "app", "deck", "quality", "brain-section.tsx"),
    "utf8"
  );
  const coverageAt = SECTION.indexOf("conversations measured");
  const patternsAt = SECTION.indexOf("patterns stored");
  assert.ok(coverageAt > 0 && patternsAt > 0, "both blocks must be present");
  assert.ok(coverageAt < patternsAt, "coverage has to come before the pool");

  // And it must not imply the agent is already using any of this.
  assert.match(SECTION, /not yet reaching any reply/);
});

// ============================================================
// The handover nobody came to
// ============================================================

test("an abandoned handover is watched, and customer-waiting cannot see it", () => {
  // FOUND IN PRODUCTION 2026-08-17 by reading is_human_handoff directly rather
  // than trusting the finding list. Four Zipicka conversations opened 1–3
  // August, still paused, still open, never touched by a human. Sixteen days.
  //
  // customer-waiting is blind to it BY CONSTRUCTION: it requires the customer
  // to have spoken last, and this state is created by the AGENT speaking — "I'm
  // looping in a specialist", is_human_handoff, stop. The last message is
  // outbound forever.
  //
  // Worse than blind. It had raised "khan has been waiting 261 hours" and then
  // RETRACTED it: the finding reads resolved while the customer has still never
  // been answered. Correct behaviour for its own question, exactly the wrong
  // impression.
  const OPERATORS = readFileSync(
    join(here, "..", "src", "services", "operators.ts"),
    "utf8"
  );
  assert.match(OPERATORS, /slug: "handover-abandoned"/);
  assert.match(OPERATORS, /OPERATORS: Operator\[\] = \[[\s\S]*handoverAbandoned/);

  const fn = OPERATORS.slice(OPERATORS.indexOf('slug: "handover-abandoned"'));
  const body = fn.slice(0, fn.indexOf("\n};"));

  // The distinguishing test is "did a human EVER arrive", not "how long since a
  // message" — a handover that was honoured also ends outbound and goes quiet.
  assert.match(body, /and c\.is_human_handoff/);
  assert.match(body, /sender_type = 'human_agent'\s*\n?\s*\)/);
  assert.ok(
    !/last\.sender_type = 'contact'/.test(body),
    "requiring the customer to have spoken last is the blindness this operator exists to fix"
  );

  // Always urgent: unlike a slow reply, this state never resolves itself.
  assert.match(body, /severity: "urgent" as const/);
  assert.ok(!/WAITING_WARN|"warn"/.test(body), "there is no gentle version of this");

  // Same pitch suppression as customer-waiting, including the fallback for
  // conversations predating lead scoring — without it the two cold pitches
  // among the four would be reported as abandoned customers, which is the noise
  // that teaches somebody to stop reading the list.
  //
  // Asserted as the SHARED decision rather than an inlined scoreLead call.
  // Until 2026-08-25 this operator carried its own copy — identical reasoning,
  // identical code, two places to keep right — and the day they drifted, one
  // operator would have silenced a conversation the other reported with nothing
  // to say which was correct.
  assert.match(body, /category = 'inbound_pitch'/);
  assert.match(body, /!looksLikeAnInboundPitch\(\{/);

  // Calls no model.
  assert.ok(!/anthropic|generateText|embed|gemini/i.test(body), "operators must not call a model");
});
