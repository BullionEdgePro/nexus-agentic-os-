/**
 * A conversation must not be re-routed because a database read hiccuped.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Routing on the shared number is STICKY, and the processor says why: "Routing
 * is sticky: re-classifying every message would let one off-topic word move a
 * live conversation, and its governance, mid-thread." Five businesses answer on
 * one number, two of them competing law firms, so which business a conversation
 * belongs to decides whose wording the customer gets, whose staff can read it,
 * and whose escalation policy applies.
 *
 * The lookup that enforces that read:
 *
 *   const routed = await findOrganizationById(id).catch(() => null);
 *   if (routed) return { kind: "serve", organization: routed };
 *   logger.warn("...no longer active — re-triaging");
 *
 * Two different facts arrived as the same `null`. A business genuinely gone,
 * and a read that failed. On the second, the conversation was re-triaged —
 * exactly the thing stickiness exists to prevent — and the log asserted "no
 * longer active", a cause the code had no way to know.
 *
 * This is the shape that has cost this platform more than any other: an error
 * and an empty result made indistinguishable, so a failure reads as a fact.
 * Eleven instances of it under RLS, where zero rows meant "nothing configured".
 * Same confusion, different layer.
 *
 * ============================================================
 * WHAT IT CHECKS
 * ============================================================
 *
 * Source-level, because the alternative is standing up a database that fails on
 * command. What it pins is the branch structure: the lookup is inside a try, a
 * caught error is distinguished from a null result, and only the null result
 * reaches the re-triage warning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROCESSOR = readFileSync(
  join(here, "..", "src", "queue", "processor.ts"),
  "utf8"
);

/** The sticky-routing branch, with prose removed so no comment can satisfy a claim. */
function stickyBranch() {
  const code = withoutComments(PROCESSOR);
  const at = code.indexOf("if (state?.routedOrganizationId) {");
  assert.notEqual(at, -1, "the sticky-routing branch is no longer recognisable");
  const end = code.indexOf("if (state?.triagePromptedAt)", at);
  assert.ok(end > at, "could not find the end of the sticky-routing branch");
  return code.slice(at, end);
}

test("a failed lookup does not re-triage the conversation", () => {
  const branch = stickyBranch();

  assert.ok(
    !branch.includes("findOrganizationById(state.routedOrganizationId).catch("),
    "the lookup is back to catching into a value: an error and a missing business become the " +
      "same null, and a database hiccup silently moves a live conversation to another business"
  );
  assert.ok(branch.includes("try {"), "the lookup must distinguish a thrown error from a null result");
  assert.ok(
    branch.includes("lookupFailed"),
    "the two outcomes must be told apart by something the branch below can read"
  );
});

test("only a genuinely absent business reaches the re-triage warning", () => {
  const branch = stickyBranch();
  const failed = branch.indexOf("if (lookupFailed) return");
  const warn = branch.indexOf("no longer active");

  assert.ok(failed > -1, "there is no early return for a failed lookup");
  assert.ok(warn > -1, "the re-triage warning is gone — has the branch changed shape?");
  assert.ok(
    failed < warn,
    'the failed-lookup return must come BEFORE the "no longer active" warning, or a read ' +
      "that threw is still reported as a business that has been deactivated"
  );
});

test("the wording does not claim a cause it cannot know", () => {
  const branch = stickyBranch();
  const errorLog = branch.slice(branch.indexOf("lookupFailed = true"), branch.indexOf("if (routed)"));
  assert.ok(
    !/no longer active|deactivated|deleted/i.test(errorLog),
    "the error path must not describe the business as gone — it does not know that"
  );
  assert.ok(
    /could not load/i.test(errorLog),
    "the error path should say what actually happened: the business could not be loaded"
  );
});
