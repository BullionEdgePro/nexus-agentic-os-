/**
 * The rules that let this platform change how it answers customers, proved.
 *
 * ============================================================
 * WHY THIS FILE MATTERS MORE THAN MOST
 * ============================================================
 *
 * F14 carried a refusal for weeks — "Automatic action is deliberately not taken
 * — the judgement of whether a rate is wrong belongs to someone who knows the
 * business" — and the owner has now asked for the feature finished. So the
 * judgement moved from a person into `autoActivationDecision`, and this is the
 * file that decides whether that was a reasonable thing to do.
 *
 * What is at stake is not a dashboard. An active procedure is a method the agent
 * follows when answering a real customer of a real business, and two of the five
 * businesses here are competing law firms. So each of the five rules is proved
 * against a procedure that breaks it, and the one that matters most — a human's
 * "off" is final — is proved twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_ACTIVATION_FLOOR,
  AUTO_REVIEWER,
  autoActivationCandidates,
  autoActivationDecision,
  wasActivatedAutomatically,
} from "@nexus/db";

/** A procedure that qualifies, so each test can break exactly one thing. */
const eligible = (over = {}) => ({
  id: "proc-1",
  organizationId: "org-1",
  intentCategory: "appointment_booking",
  language: "en",
  source: "inferred",
  isActive: false,
  derivedFromCount: AUTO_ACTIVATION_FLOOR,
  dismissedAt: null,
  dismissedEvidence: null,
  reviewedAt: null,
  reviewedBy: null,
  ...over,
});

test("the baseline qualifies, so every test below breaks exactly one rule", () => {
  const decision = autoActivationDecision(eligible());
  assert.equal(decision.activate, true, decision.reason);
  assert.match(decision.reason, /above the floor/);
});

test("rule 1: a procedure somebody at the business wrote is never switched on", () => {
  // Their draft, their decision. Switching it on is answering for them.
  const decision = autoActivationDecision(eligible({ source: "operator" }));
  assert.equal(decision.activate, false);
  assert.match(decision.reason, /not this platform's decision/);
});

test("rule 2: a human's OFF is final, and automation cannot undo it", () => {
  // THE RULE THAT MAKES THE REST TOLERABLE. Whatever else this feature does,
  // the owner can always win permanently by clicking once.
  const decision = autoActivationDecision(eligible({ reviewedBy: "atif@nexusagenticos.com" }));
  assert.equal(decision.activate, false);
  assert.match(decision.reason, /reviewed this and left it off/);
});

test("rule 2 again: evidence piling up does not overrule the person", () => {
  // A hundred conversations is not an argument against somebody who looked at
  // this and said no. Proved separately because "enough evidence eventually
  // wins" is exactly the shortcut a later edit would take.
  const decision = autoActivationDecision(
    eligible({ reviewedBy: "atif@nexusagenticos.com", derivedFromCount: 100 })
  );
  assert.equal(decision.activate, false);
  assert.match(decision.reason, /left it off/);
});

test("rule 2 does not mistake this module's own marker for a person", () => {
  // Something this platform activated and a person later left alone must still
  // be re-evaluable; only a HUMAN review freezes it.
  const decision = autoActivationDecision(eligible({ reviewedBy: AUTO_REVIEWER }));
  assert.equal(decision.activate, true, decision.reason);
});

test("rule 3: a dismissal holds until the evidence has doubled", () => {
  const held = autoActivationDecision(
    eligible({ dismissedAt: "2026-08-01T00:00:00Z", dismissedEvidence: 20, derivedFromCount: 30 })
  );
  assert.equal(held.activate, false);
  assert.match(held.reason, /the dismissal holds/);

  const moved = autoActivationDecision(
    eligible({ dismissedAt: "2026-08-01T00:00:00Z", dismissedEvidence: 20, derivedFromCount: 40 })
  );
  assert.equal(moved.activate, true, moved.reason);
});

test("rule 4: an anecdote with a schema is not evidence", () => {
  const decision = autoActivationDecision(eligible({ derivedFromCount: 3 }));
  assert.equal(decision.activate, false);
  assert.match(decision.reason, /drawn from 3 conversations, and the floor is 20/);
});

test("the floor is the platform's own number, not a new one", () => {
  // The shared brain already decided what "enough conversations to generalise
  // from" means. Inventing a second number for the same judgement is how two
  // parts of one system come to disagree in public.
  assert.equal(AUTO_ACTIVATION_FLOOR, 20);
});

test("every decision carries a reason, including the refusals", () => {
  // "Why did this turn on" and "why has this not turned on" are both questions
  // somebody will ask, and a boolean answers neither. The finding quotes this.
  for (const procedure of [
    eligible(),
    eligible({ source: "operator" }),
    eligible({ reviewedBy: "someone" }),
    eligible({ derivedFromCount: 1 }),
    eligible({ isActive: true }),
    eligible({ dismissedAt: "2026-08-01T00:00:00Z", dismissedEvidence: 50 }),
  ]) {
    const decision = autoActivationDecision(procedure);
    assert.ok(decision.reason.length > 12, `a decision states no reason: ${JSON.stringify(decision)}`);
  }
});

test("two candidates for one situation means neither goes live", () => {
  // The unique index would reject the second with a constraint violation, which
  // is a correct database and a poor decision — it would activate whichever the
  // query returned first. Split evidence is a reason for a person to look, not
  // for a coin toss the customer cannot see.
  const chosen = autoActivationCandidates([
    eligible({ id: "a" }),
    eligible({ id: "b" }),
  ]);
  assert.deepEqual(chosen, [], "an intent with two eligible drafts must activate neither");
});

test("different situations do not block each other", () => {
  const chosen = autoActivationCandidates([
    eligible({ id: "a", intentCategory: "appointment_booking" }),
    eligible({ id: "b", intentCategory: "knowledge_lookup" }),
    eligible({ id: "c", intentCategory: "appointment_booking", organizationId: "org-2" }),
  ]);
  assert.deepEqual(chosen.map((c) => c.procedure.id).sort(), ["a", "b", "c"]);
});

test("what the platform switched on is distinguishable from what a person did", () => {
  assert.equal(wasActivatedAutomatically({ isActive: true, reviewedBy: AUTO_REVIEWER }), true);
  assert.equal(wasActivatedAutomatically({ isActive: true, reviewedBy: "atif@" }), false);
  assert.equal(wasActivatedAutomatically({ isActive: false, reviewedBy: AUTO_REVIEWER }), false);
});
