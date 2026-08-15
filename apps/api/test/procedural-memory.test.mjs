// F10 procedural memory — the first feature that changes HOW the agent answers.
//
// Everything else this platform learned was additive: a knowledge page it can
// quote, a note about a customer it can read. A procedure is different in kind.
// Once switched on it sits in the prompt for every future enquiry of that sort
// and reshapes the reply — so the failures worth testing for are not "it did not
// work" but "it worked, unsupervised, on something nobody agreed to".
//
// Four of those, and each has a test below:
//
//   the writer activates something                  → the business's replies
//                                                     change with nobody asked
//   the writer rewrites an active procedure         → what a person approved is
//                                                     silently not what is running
//   a step carries a customer's details             → one customer's affairs
//                                                     repeated to strangers forever
//   a rejected suggestion returns every night       → the queue becomes wallpaper
//                                                     and stops being read at all
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseProcedureSteps, procedureStepsEqual, MAX_PROCEDURE_STEPS } from "@nexus/shared";
import { findLeakInSteps } from "../src/services/procedure-inference.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const MIGRATION_033 = read("packages", "db", "migrations", "033-procedures.sql");
const MIGRATION_034 = read("packages", "db", "migrations", "034-procedure-review.sql");
const MIGRATION_036 = read("packages", "db", "migrations", "036-procedure-applied.sql");
const RECALL = read("packages", "agents", "src", "procedure-recall.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const ROLLUP = read("apps", "api", "src", "services", "quality-rollup.ts");
const STORE = read("packages", "db", "src", "procedures.ts");
const WRITER = read("apps", "api", "src", "services", "procedure-inference.ts");
const ROUTE = read("apps", "api", "src", "routes", "procedures.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const CLIENT = read("packages", "db", "src", "client.ts");
const REDACT = read("packages", "governance", "src", "redact.ts");
const SCREEN = read("apps", "web", "app", "deck", "procedures", "page.tsx");
const QUEUE = read("apps", "api", "src", "queue", "procedures-queue.ts");
const WORKER = read("apps", "api", "src", "worker.ts");

/** Source with comments removed. Prose about a rule is not the rule. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*|\/\/[^\n]*/g, " ");

// ============================================================
// Nothing turns itself on
// ============================================================

test("the writer never sets is_active", () => {
  // The single most important line in this file. A nightly job that could
  // activate a procedure would be making a business decision 365 times a year
  // on evidence it cannot actually read (see the honesty test at the bottom).
  const store = codeOnly(STORE);
  const inference = store.slice(
    store.indexOf("export async function upsertInferredProcedure"),
    store.indexOf("export async function setProcedureActive")
  );
  assert.ok(inference.length > 200, "upsertInferredProcedure moved — this test is reading nothing");
  assert.ok(
    !/is_active/.test(inference),
    "the inference writer must not touch is_active; only a person may switch a procedure on"
  );
  assert.ok(!/is_active/.test(codeOnly(WRITER)), "the service must not activate anything either");
});

test("an inferred procedure is off until somebody signs for it", () => {
  assert.match(MIGRATION_033, /is_active boolean not null default false/);
  // And the switch records who threw it. A claim nobody signed is a claim
  // nobody made.
  assert.match(MIGRATION_034, /reviewed_by text/);
  assert.match(STORE, /reviewed_by = \$4/);
});

// ============================================================
// An active procedure does not change under the business
// ============================================================

test("a newer inference is proposed, never applied, while a procedure is active", () => {
  // Otherwise a procedure somebody read, judged and approved quietly becomes a
  // different one — and the row still reads "active", so the screen still shows
  // it as reviewed.
  assert.match(STORE, /if \(inferred\.isActive\)/);
  const store = codeOnly(STORE);
  // Bounded by CODE at both ends. The first version of this test closed the
  // slice on a comment — in source that had just had its comments stripped — so
  // indexOf returned -1, the slice ran to the end of the file, and the test
  // failed on the inactive-draft branch below where rewriting steps is correct.
  const start = store.indexOf("if (inferred.isActive)");
  const end = store.indexOf('return { outcome: "proposed"', start);
  assert.ok(start > 0 && end > start, "the active branch moved — this test is reading nothing");
  const activeBranch = store.slice(start, end);
  assert.ok(
    // Word-bounded, because `proposed_steps = $2` ends in the same characters
    // and matching it here would fail the test on the very line that proves the
    // rule. client.ts's table scan carries the same guard for the same reason.
    !/(?<!proposed_)steps\s*=\s*\$/.test(activeBranch),
    "an active procedure's steps must not be rewritten by the writer"
  );
  assert.match(activeBranch, /proposed_steps = \$2::jsonb/);
});

test("the proposal is a separate column, and it is all-or-nothing", () => {
  // One column could only hold whichever was written last, so "what the agent
  // follows" and "what the system would like it to follow" would take turns.
  assert.match(MIGRATION_034, /add column if not exists proposed_steps jsonb/);
  // A proposal with no date, or a date with no proposal, is a half-written state
  // the screen would have to guess about.
  assert.match(MIGRATION_034, /\(proposed_steps is null\) = \(proposed_at is null\)/);
});

test("an unchanged re-inference does not restamp the suggestion", () => {
  // A three-week-old suggestion re-dated every night reads as this morning's,
  // and "new" stops meaning anything by the end of the week.
  assert.match(STORE, /procedureStepsEqual\(inferred\.proposedSteps, input\.steps\)/);
});

// ============================================================
// A person outranks the machine
// ============================================================

test("the writer says nothing where somebody has written their own", () => {
  // Migration 033's argument — conflating inferred with authoritative "would let
  // a pattern the system invented outrank an instruction a person gave it" —
  // applied to the nagging as well as to the ranking.
  assert.match(STORE, /row\.source === "operator" && row\.isActive/);
  assert.match(STORE, /deferred-to-operator/);
});

test("editing an inferred procedure makes it the editor's", () => {
  // If it stayed labelled 'inferred', the nightly writer would keep proposing
  // over the top of somebody's own words and the screen would keep calling their
  // method a suggestion.
  const edit = STORE.slice(STORE.indexOf("export async function replaceProcedureSteps"));
  assert.match(edit, /source = 'operator'/);
  assert.match(edit, /proposed_steps = null/);
});

test("two active procedures for one situation is refused by the database", () => {
  // Not by the application. A read-then-write check races, and the losing branch
  // is invisible in every log — the same argument the double-booking constraint
  // is written around.
  assert.match(MIGRATION_033, /create unique index if not exists procedures_one_active_per_intent/);
  assert.match(MIGRATION_033, /where is_active/);
  // And the violation is turned into a sentence rather than a 500, because the
  // real meaning — "you already have one of these" — is fixable in one click.
  assert.match(STORE, /const UNIQUE_VIOLATION = "23505"/);
  assert.match(STORE, /Another procedure for this kind of enquiry is already active/);
});

// ============================================================
// A refusal is remembered
// ============================================================

test("a dismissed suggestion does not come back tomorrow", () => {
  // Migration 027's lesson: a list that can only grow gets ignored within a
  // week, and an ignored list is indistinguishable from no list while still
  // looking like a working feature.
  assert.match(MIGRATION_034, /add column if not exists dismissed_at timestamptz/);
  assert.match(MIGRATION_034, /add column if not exists dismissed_evidence integer/);
  assert.match(STORE, /dismissed_evidence = derived_from_count/);
  assert.match(STORE, /if \(inferred\.dismissedAt\)/);
});

test("it comes back only when the case is materially stronger", () => {
  // Six conversations instead of five is the same suggestion with a rounding
  // error attached. Storing the COUNT rather than only the timestamp is what
  // makes this possible — time alone would return the rejected draft on a
  // schedule.
  assert.match(STORE, /MIN_EVIDENCE_GROWTH_AFTER_DISMISSAL = 2/);
  assert.match(STORE, /input\.derivedFromCount < Math\.max\(threshold, 1\)/);
  // The evidence count is still refreshed while held back: it is a measurement,
  // not a suggestion, and a stale one would understate the case when somebody
  // comes back to reconsider.
  assert.match(STORE, /held-back/);
});

// ============================================================
// What counts as evidence, and what does not
// ============================================================

test("only conversations no human joined are learned from", () => {
  // A colleague taking over is the clearest available signal that the agent was
  // not managing. Learning from those would teach the agent the method that
  // needed rescuing.
  assert.match(WRITER, /and r\.human = 0/);
  assert.match(WRITER, /and r\.ai > 0/);
});

test("one message answered by a menu is not a method", () => {
  assert.match(WRITER, /and r\.inbound >= 2/);
  // The customer read the answer and CONTINUED, rather than reading it and
  // leaving. The nearest thing to a positive signal available on WhatsApp.
  assert.match(WRITER, /and r\.last_inbound_at > r\.first_ai_at/);
});

test("a conversation still in flight is not evidence", () => {
  // It can escalate tomorrow. Learning from it early learns the wrong end.
  assert.match(WRITER, /SETTLED_AFTER_HOURS = 24/);
  assert.match(WRITER, /and r\.last_at < now\(\) - \(\$4::integer \* interval '1 hour'\)/);
});

test("spam and unknown cannot become procedures", () => {
  // On this number inbound pitches are the largest single share of traffic, so
  // without the exclusion the first procedure the platform ever proposed would
  // be a method for answering spammers. `unknown` is not a category at all.
  assert.match(WRITER, /NON_PATTERN_INTENTS/);
  assert.match(WRITER, /l\.intent <> all\(\$3::text\[\]\)/);
});

test("a handful of conversations is not a method", () => {
  assert.match(WRITER, /MIN_WELL_HANDLED_CONVERSATIONS = 5/);
  assert.match(WRITER, /conversations\.length < MIN_WELL_HANDLED_CONVERSATIONS/);
});

test("the two aggregates are computed separately, not joined into one group-by", () => {
  // Joining messages to conversation_metrics in one group-by fans out — every
  // message multiplied by every metric row — and every count this writer turns
  // on would silently inflate. quality.ts and shared-brain.ts collapse to one
  // row per conversation first for a version of the same reason.
  const sql = WRITER.slice(WRITER.indexOf("with recent as"), WRITER.indexOf("order by r.last_at"));
  assert.ok(sql.includes("from messages m"), "the message aggregate moved");
  assert.ok(
    !/join conversation_metrics/.test(sql),
    "conversation_metrics must be aggregated separately and joined on conversation_id"
  );
  assert.match(sql, /join labelled l on l\.conversation_id = r\.conversation_id/);
});

// ============================================================
// Nothing a customer said escapes into every future reply
// ============================================================

test("a step naming a customer throws the whole inference away", () => {
  // Not the offending step — the whole thing. A procedure with one step removed
  // still reads as complete, and the reviewer would be judging a method with a
  // hole in it that nothing on the screen mentions.
  const steps = [
    { text: "Establish which document needs attesting" },
    { text: "Quote as we did for Haddad's certificate" },
  ];
  assert.equal(findLeakInSteps(steps, ["haddad"]), "names one of the customers it was drawn from");
});

test("a step carrying a phone number or an email is refused", () => {
  const withPhone = [{ text: "Send the quote to +971 50 123 4567" }];
  assert.ok(findLeakInSteps(withPhone, []), "a phone number must be caught");
  const withEmail = [{ text: "Copy in ahmed.hassan@example.com when quoting" }];
  assert.ok(findLeakInSteps(withEmail, []), "an email must be caught");
  // The reason names the KIND and never the value: it is logged and shown.
  assert.ok(!findLeakInSteps(withEmail, []).includes("ahmed"));
});

test("an ordinary procedure passes", () => {
  // A guard that refuses everything is the same as no feature, so the happy path
  // is asserted too.
  const steps = [
    { text: "Establish which document needs attesting" },
    { text: "Ask which country it is going to" },
    { text: "Quote the fee for that pair" },
    { text: "Offer an appointment" },
  ];
  assert.equal(findLeakInSteps(steps, ["haddad", "fatima"]), null);
});

test("short name fragments cannot be used, or every inference would be refused", () => {
  // A two-letter name matches inside ordinary words. The guard would then reject
  // everything forever, which is its own kind of failure — and a silent one,
  // since "refused" and "nothing found" look identical on the screen.
  assert.match(WRITER, /if \(part\.length >= 3\) fragments\.add\(part\)/);
});

test("the model is told to write a method, not a transcript", () => {
  assert.match(WRITER, /No customer names, phone numbers/);
  // The escape hatch is the load-bearing part. A model asked "what is the common
  // method here?" will always find one — six unrelated conversations would
  // become a confident four-step procedure no customer ever followed.
  assert.match(WRITER, /If they do not share a method, reply \{"steps": \[\]\}/);
  assert.match(WRITER, /reason: "no shared method"/);
});

test("procedures stay inside the business that produced them", () => {
  // 033's whole argument: F5's shared store is safe because its columns cannot
  // hold a customer's affairs, and a procedure IS prose, so this one is
  // protected by never leaving instead.
  assert.match(CLIENT, /"procedures"/);
  assert.match(MIGRATION_033, /enable row level security/);
  const shareable = REDACT.slice(
    REDACT.indexOf("export const SHAREABLE"),
    REDACT.indexOf("export type ShareableField")
  );
  assert.ok(!/procedure|steps/.test(shareable), "a procedure must never reach the shared allow-list");
  // And the writer scopes every read and write to one business explicitly.
  assert.match(WRITER, /withTenant\(organizationId, \(\) =>/);
});

// ============================================================
// The shape of a step, decided once
// ============================================================

test("steps are normalised on the way in and bounded on the way to storage", () => {
  const parsed = parseProcedureSteps(["  Ask   which country  ", "", { text: "Quote the fee" }]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.steps, [{ text: "Ask which country" }, { text: "Quote the fee" }]);
});

test("a transcript submitted as a procedure is refused", () => {
  const tooMany = Array.from({ length: MAX_PROCEDURE_STEPS + 1 }, (_, i) => `Step ${i}`);
  const parsed = parseProcedureSteps(tooMany);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /transcript, not a method/);
  // And the database refuses it too, because a rule with two enforcement sites
  // has one that will be forgotten.
  assert.match(MIGRATION_034, /jsonb_array_length\(steps\) between 1 and 8/);
});

test("an empty procedure is not a procedure", () => {
  assert.equal(parseProcedureSteps([]).ok, false);
  assert.equal(parseProcedureSteps(["   ", ""]).ok, false);
  assert.equal(parseProcedureSteps("do the thing").ok, false);
  assert.match(MIGRATION_033, /procedures_steps_not_empty/);
});

test("spacing and case are not a change of method", () => {
  // Otherwise every nightly run would stamp "new suggestion" on a screen where
  // nothing had changed.
  assert.ok(procedureStepsEqual([{ text: "Ask which country" }], [{ text: "ask  which country " }]));
  assert.ok(!procedureStepsEqual([{ text: "Ask which country" }], [{ text: "Ask which document" }]));
});

// ============================================================
// The review screen and the route it talks to
// ============================================================

test("the route is addressed per organization, so RLS is doing real work", () => {
  // Mounted under /api/organizations/:slug like knowledge, which means
  // requireTenantScope and the tenant-context middleware already apply. The
  // alternative — a cross-tenant handler that must remember to narrow — is the
  // shape /api/tasks and /api/operators have to carry a warning about.
  assert.match(INDEX, /app\.route\("\/api\/organizations", proceduresRoute\)/);
  assert.match(ROUTE, /proceduresRoute\.get\("\/:slug\/procedures"/);
  assert.match(ROUTE, /proceduresRoute\.patch\("\/:slug\/procedures\/:id"/);
});

test("nothing deletes a procedure", () => {
  // A procedure that was once active is the record of how this business answered
  // its customers for a while. Dismissing and deactivating both keep it.
  assert.ok(!/delete/i.test(codeOnly(ROUTE)), "the route must expose no delete");
  assert.ok(
    !/grant[^;]*delete[^;]*procedures/i.test(MIGRATION_033 + MIGRATION_034),
    "the application role must not be granted delete on procedures"
  );
});

test("a hand-typed intent is checked against the shared vocabulary", () => {
  // An intent spelled a second way produces a procedure that is never found,
  // because the classifier will never write that string. Same argument as
  // packages/shared/intents.ts.
  assert.match(ROUTE, /REVIEWABLE_INTENTS/);
  assert.match(ROUTE, /is not one of the kinds of enquiry this platform classifies/);
});

test("the empty screen says which kind of empty it is", () => {
  // F5 looked like it was waiting for a second tenant while it was actually
  // unable to read five-sixths of its traffic. Both are empty; only one is
  // fixable by waiting.
  assert.match(WRITER, /blockedBecause/);
  assert.match(WRITER, /No model key is configured/);
  assert.match(WRITER, /has handled no conversations/);
  assert.match(SCREEN, /readiness\?\.blockedBecause/);
});

test("the screen says what the evidence is not", () => {
  // The load-bearing sentence in the UI. Without it, "drawn from 7 conversations
  // the agent handled alone" reads as proof those customers were helped — and a
  // customer who gave up leaves exactly the same silence.
  assert.match(SCREEN, /someone who gave up leaves the same/);
  assert.match(SCREEN, /arrives switched off/);
});

test("what is running and what is suggested are shown side by side", () => {
  // A screen that shows only the new version asks somebody to approve a change
  // they cannot see.
  assert.match(SCREEN, /procedure\.proposedSteps \? \(/);
  assert.match(SCREEN, /Use this instead/);
  assert.match(SCREEN, /Keep what we have/);
});

// ============================================================
// The half that speaks
// ============================================================

test("only an ACTIVE procedure can reach a customer", () => {
  // The single line between "a draft nobody agreed to" and "what a business
  // says to its customers".
  const lookup = STORE.slice(STORE.indexOf("export async function getActiveProcedure"));
  assert.match(lookup.slice(0, lookup.indexOf("]")), /and p\.is_active/);
});

test("spam and unclassifiable messages can never carry a procedure", () => {
  // Broadest possible blast radius for the least evidence: a procedure keyed on
  // `unknown` would apply to whatever the rules failed to read.
  assert.match(RECALL, /if \(!isPatternIntent\(intent\)\) return null/);
});

test("the reply path degrades to no procedure rather than failing", () => {
  // Same treatment as the other three enrichments. A customer waiting on a
  // reply must not wait on a procedure lookup, and must never lose the reply to
  // one.
  assert.match(PROCESSOR, /recallProcedure\(serving\.id, text\.body\)\s*\n?\s*\)\.catch\(\(\) => null\)/);
  // And it asks the SERVING business, not the number's owner — read as the
  // owner, RLS returns nothing and the agent silently answers with no
  // procedure, which is indistinguishable from the business having none.
  assert.match(PROCESSOR, /withServingTenant\(serving\.id, \(\) =>\s*recallProcedure/);
});

test("the procedure is an order of work, not a licence to invent facts", () => {
  // The failure that would matter most: a step saying "quote the fee" read as
  // permission to produce one. Retrieval stays the only source of substance.
  assert.match(RECALL, /it is the order to /);
  assert.match(RECALL, /not a source of facts/);
  // And it must not become an interrogation when the customer has already
  // answered half of it.
  assert.match(RECALL, /a default, not a script/);
});

test("the agent must not recite the procedure to the customer", () => {
  // The only one of the three cautions a customer would actually see if it were
  // dropped — an agent announcing "step one…", or reading a business's internal
  // method out to whoever asks.
  assert.match(RECALL, /Do not read these steps out/);
});

test("selection runs on text alone, and says so", () => {
  // classifyIntent's better signal is the tool the agent called, which does not
  // exist yet at selection time. Recording that honestly is what stops someone
  // "fixing" the apparent inconsistency later by moving selection after the
  // reply — where it could no longer shape it.
  assert.match(RECALL, /THE INTENT USED HERE IS A PREDICTION/);
  assert.match(RECALL, /classifyIntent\(\{ text \}\)/);
});

// ============================================================
// Counting what happened, not what we hoped
// ============================================================

test("the counters are derived, never incremented", () => {
  // A counter bumped from the reply path cannot be recomputed, cannot be
  // audited back to the conversations behind it, and drifts the first time a
  // job retries. This codebase has written that lesson down twice already.
  assert.match(MIGRATION_036, /add column if not exists procedure_id uuid/);
  assert.match(STORE, /export async function rollUpProcedureOutcomes/);
  const roll = STORE.slice(STORE.indexOf("export async function rollUpProcedureOutcomes"));
  assert.ok(
    !/times_applied\s*=\s*times_applied|\+\s*1/.test(roll.slice(0, roll.indexOf("[organizationId]"))),
    "outcomes must be recomputed from the stamps, never incremented"
  );
  assert.match(roll, /set times_applied\s*= coalesce\(t\.applied, 0\)/);
});

test("an escalated reply still counts as applied", () => {
  // THE BIAS THIS AVOIDS. Stamping only replies that went out as the agent's
  // own would make "ended without a human" true of nearly every stamped
  // conversation by construction — a success rate that cannot go down.
  const stamp = PROCESSOR.slice(PROCESSOR.indexOf("procedureId: procedure?.procedureId"));
  assert.ok(!/shouldEscalate/.test(stamp.slice(0, 120)), "the stamp must not be conditional on escalation");
  assert.match(MIGRATION_036, /A success rate that\n-- cannot go down is not a measurement/);
});

test("a procedure that stops being used falls back to zero", () => {
  // A stale count that only ever rises is the same failure in a quieter form.
  const roll = STORE.slice(STORE.indexOf("export async function rollUpProcedureOutcomes"));
  assert.match(roll, /left join tally t2 on t2\.procedure_id = p2\.id/);
});

test("one conversation counts once, however chatty", () => {
  const roll = STORE.slice(STORE.indexOf("export async function rollUpProcedureOutcomes"));
  assert.match(roll, /select distinct cm\.procedure_id, cm\.conversation_id/);
});

test("nothing calls it success, because it is not success", () => {
  // The column is `times_succeeded` — named in 033 before there was a writer to
  // define it. What it counts is "nobody had to step in and the customer kept
  // replying", which has the same hole as the inference evidence: someone who
  // gave up leaves the same silence.
  assert.match(STORE, /NOTHING IN THE UI IS ALLOWED TO CALL IT SUCCESS/);
  assert.match(SCREEN, /ended\n\s*without a human/);
  // VISIBLE TEXT ONLY. The first version of this failed on
  // `{procedure.timesSucceeded}` — the field name, which no reader ever sees —
  // and would have forced a rename of the column to satisfy a test about
  // wording. Comments and interpolated expressions are stripped so the
  // assertion is about what appears on the page.
  const visible = SCREEN.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\{[^{}]*\}/g, " ");
  assert.ok(
    !/succeeded|success/i.test(visible),
    "the screen must not present the containment count as success"
  );
});

test("outcomes are recomputed hourly, with the numbers a person reads", () => {
  // Not on the daily inference cycle: these are the figures somebody uses to
  // decide whether to keep a procedure switched on, and a number up to 24 hours
  // stale is one they would be right to distrust.
  assert.match(ROLLUP, /rollUpProcedureOutcomes\(organization\.id\)/);
  // Outside the per-day loop — the counters are a running total, not a daily
  // figure, and recomputing them three times per run is identical work twice.
  const perOrg = ROLLUP.slice(ROLLUP.indexOf("for (const organization of organizations)"));
  assert.ok(
    perOrg.indexOf("rollUpProcedureOutcomes") > perOrg.indexOf("rollUpQualityDay"),
    "the outcome rollup belongs after the day loop, not inside it"
  );
});

// ============================================================
// What it costs to run
// ============================================================

test("inference is daily, not hourly", () => {
  // The quality rollup recomputes numbers, so running it often costs correctness
  // nothing. This calls a model per business per intent and produces something a
  // person must read: hourly it would refill the review queue faster than anyone
  // could empty it.
  assert.match(QUEUE, /EVERY_DAY_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(WORKER, /scheduleProcedureInference\(\)/);
  assert.match(WORKER, /concurrency: 1/);
});

test("the prompt is bounded three ways", () => {
  // An unbounded prompt is an unbounded bill, and the tenth example of the same
  // exchange adds nothing the first six did not.
  assert.match(WRITER, /MAX_TRANSCRIPTS = 6/);
  assert.match(WRITER, /MAX_TURNS_PER_TRANSCRIPT = 14/);
  assert.match(WRITER, /MAX_CHARS_PER_TURN = 240/);
});

test("no model call is made while holding a database transaction open", () => {
  // withTenant checks out a pooled connection and opens a transaction for as
  // long as its callback runs. Wrapping the whole pass would leave a connection
  // idle-in-transaction for the length of an API call, per business, nightly.
  const pass = WRITER.slice(WRITER.indexOf("export async function inferProceduresForBusiness"));
  const call = pass.indexOf("await completeText(");
  assert.ok(call > 0, "the model call moved — this test is reading nothing");
  // The three database touches each open their own short scope.
  assert.match(pass, /withTenant\(organizationId, \(\) =>\s*findWellHandledConversations/);
  assert.match(pass, /withTenant\(organizationId, \(\) => loadTranscripts\(sample\)\)/);
  assert.match(pass, /withTenant\(organizationId, \(\) =>\s*upsertInferredProcedure/);
  // And the model call is not inside any of them.
  const enclosing = pass.slice(Math.max(0, call - 400), call);
  assert.ok(
    !/withTenant\([^)]*$/.test(enclosing.replace(/\)[^)]*$/, "")) || !/withTenant/.test(enclosing),
    "completeText must not be called inside a withTenant callback"
  );
  console.log("PASS: F10 proposes, a person decides, and nothing changes a reply until they do");
});
