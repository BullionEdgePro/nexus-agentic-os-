/**
 * The judgement that silences a waiting customer, and why it is now shown.
 *
 * ============================================================
 * AN EMPTY LIST WAS TWO DIFFERENT FACTS
 * ============================================================
 *
 * `customer-waiting` drops anything that looks like somebody selling TO us, and
 * it is right to: reporting an unanswered sales pitch as an ignored customer is
 * the noise that teaches a person to stop reading the list. Both findings on
 * the first real sweep were of that kind.
 *
 * But the judgement happened in a `.filter()` in memory, every ten minutes, and
 * left no trace. From every screen, "nobody is waiting" and "two people are
 * waiting and we judged them salesmen" were the same empty list — on the one
 * console whose entire premise is that an empty list must not read as good news
 * unless it IS good news.
 *
 * What makes it sharp rather than tidy: the judgement is made by a rules scorer
 * whose accuracy nothing measured until lead labels existed (F3). A wrong call
 * is a real customer waiting for ever with the deck silent, and it never
 * surfaces later, because the finding is RETRACTED rather than raised. Measured
 * on production 2026-08-25: three conversations unanswered, one reported, two
 * silenced this way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { looksLikeAnInboundPitch } from "../src/services/operators.ts";
import { withoutComments, operatorBody } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const ROUTE = withoutComments(read("apps", "api", "src", "routes", "operators.ts"));
const PAGE = withoutComments(read("apps", "web", "app", "deck", "operators", "page.tsx"));

const PITCH = "Latest owner, buyer and investor data available. Do you need a database?";
const REAL = "Hello, do you attest degree certificates and how much does it cost?";

// ============================================================
// One decision, in one place
// ============================================================

test("the operator and the view of what it silenced share one predicate", () => {
  // Two copies would be two things watching one table, and the day they
  // disagreed the deck would report nothing suppressed while something was --
  // which is worse than not showing it at all, because it would be reassuring.
  const body = operatorBody(OPERATORS, "customer-waiting");
  assert.ok(body, "customer-waiting is gone");
  assert.ok(
    body.includes("looksLikeAnInboundPitch(row)"),
    "the operator no longer uses the shared pitch decision"
  );
  assert.ok(
    OPERATORS.includes("rows.filter(looksLikeAnInboundPitch)"),
    "the not-reported view no longer uses the shared pitch decision"
  );
  // And exactly one place actually asks the scorer.
  const asks = OPERATORS.split("scoreLead({ text:").length - 1;
  assert.equal(asks, 1, `the scorer is consulted in ${asks} places — it must be one`);
});

test("both readers run the same query, differing only in what they keep", () => {
  // A second copy of the SQL is the same drift by a slower route.
  assert.ok(OPERATORS.includes("export async function unansweredConversations("));
  assert.ok(
    OPERATORS.includes("unansweredConversations(organizationId, false)"),
    "the operator must read through the shared query"
  );
  assert.ok(
    OPERATORS.includes("unansweredConversations(organizationId, true)"),
    "the not-reported view must read through the shared query"
  );
  const selects = OPERATORS.split("as serving_organization_id").length - 1;
  assert.equal(selects, 2, "the unanswered query appears more than once — handover-abandoned has the other");
});

// ============================================================
// What the decision actually decides
// ============================================================

test("a stored classification is taken at its word", () => {
  // A classification made when the message arrived beats one recomputed from a
  // single line months later.
  assert.equal(
    looksLikeAnInboundPitch({ is_pitch: true, has_assessment: true, last_body: REAL }),
    true,
    "a stored inbound_pitch must silence regardless of how the text reads now"
  );
});

test("a conversation scored as something else is never re-judged", () => {
  // If the scorer said general_inquiry at the time, this must not overrule it
  // on a re-read -- that would make the suppression depend on when you look.
  assert.equal(
    looksLikeAnInboundPitch({ is_pitch: false, has_assessment: true, last_body: PITCH }),
    false
  );
});

test("a conversation nobody ever scored is asked about now", () => {
  // Every conversation predating lead scoring being wired into the pipeline has
  // no assessment, and "no assessment" must not read as "not a pitch" -- that
  // is how a data broker was reported as a customer ignored for 260.8 hours.
  assert.equal(
    looksLikeAnInboundPitch({ is_pitch: false, has_assessment: false, last_body: PITCH }),
    true
  );
  assert.equal(
    looksLikeAnInboundPitch({ is_pitch: false, has_assessment: false, last_body: REAL }),
    false,
    "a genuine enquiry must not be silenced"
  );
});

test("a conversation with nothing to read is not silenced", () => {
  // Silence on no evidence is the generous direction here, and it is the right
  // one: the cost of a false alarm is a minute, the cost of a false silence is
  // a customer.
  assert.equal(
    looksLikeAnInboundPitch({ is_pitch: false, has_assessment: false, last_body: null }),
    false
  );
  assert.equal(
    looksLikeAnInboundPitch({ is_pitch: false, has_assessment: false, last_body: "" }),
    false
  );
});

// ============================================================
// How it is shown
// ============================================================

test("the row carries the customer's own words", () => {
  // Without the excerpt the row asserts a judgement and gives nothing to check
  // it against, which makes the whole section decorative.
  assert.ok(OPERATORS.includes("excerpt:"), "the suppressed row carries no evidence");
  assert.ok(PAGE.includes("{row.excerpt}"), "the screen does not show what they said");
});

test("it says which route silenced the conversation", () => {
  // A stored classification is wrong in the data; a re-read one is wrong in the
  // rules. They need different answers from whoever is looking.
  assert.ok(OPERATORS.includes("classified: row.is_pitch"));
  assert.ok(PAGE.includes("re-read just now"), "the two routes are not distinguished on screen");
});

test("these are never folded in with the findings", () => {
  // Folding them in would undo the suppression this exists to make visible.
  // The point is that the judgement can be audited, not that it is reversed.
  assert.ok(
    PAGE.includes("const [notReported, setNotReported]"),
    "the suppressed list must be its own state"
  );
  assert.ok(
    !PAGE.includes("setFindings(notReported"),
    "suppressed conversations are being treated as findings"
  );
});

test("the list names the SERVING business, not the number's owner", () => {
  // Labelling these with the number's owner would tell somebody to chase the
  // wrong firm -- the exact defect measured on 2026-08-19, where a Juris Prime
  // customer's silence was filed against Zipicka.
  assert.ok(
    OPERATORS.includes("slugById.get(row.servingOrganizationId)"),
    "the suppressed list resolves the wrong business"
  );
});

test("one business failing does not empty the list for the rest", () => {
  // An empty list here reads as "nothing was suppressed", which is the sentence
  // this whole view exists to stop being said falsely.
  const at = OPERATORS.indexOf("export async function unansweredButNotReported(");
  assert.ok(at > -1);
  const fn = OPERATORS.slice(at, OPERATORS.indexOf("const customerWaiting", at));
  assert.ok(fn.includes("try {") && fn.includes("catch"), "a single failure takes the whole list down");
});

test("each business is read inside its own transaction", () => {
  // The query is keyed on the number's OWNER, and a routed conversation is
  // visible only inside the owner's turn. Reading this cross-tenant would
  // return rows and lose which business each belongs to.
  const at = OPERATORS.indexOf("export async function unansweredButNotReported(");
  const fn = OPERATORS.slice(at, OPERATORS.indexOf("const customerWaiting", at));
  assert.ok(fn.includes("withTenant(organization.id"), "the suppressed read is not tenant-scoped");
});

test("the list is operator-only", () => {
  // Every row carries a customer's name and their own words, so this is the
  // same class of read as the inbox.
  const at = ROUTE.indexOf('operatorsRoute.get("/not-reported"');
  assert.ok(at > -1, "the route is gone");
  const body = ROUTE.slice(at, ROUTE.indexOf("});", at));
  assert.ok(body.includes('scope.role !== "operator"'), "an employee can read other firms' customers");
  assert.ok(body.includes("403"));
});

test("a list that could not be read does not render as an empty one", () => {
  // THE SAME DEFECT AS THE SECTION ITSELF, IN THE SECTION ITSELF. This was
  // written to stop an empty findings list meaning two different things, and
  // its own fetch swallowed failure into an empty array -- so an unreachable
  // endpoint rendered as "nothing was suppressed".
  //
  // The register's recipe for the class, applied: a second field saying
  // whether the answer arrived, surfaced where the reader is.
  assert.ok(
    PAGE.includes("const [suppressionReadable, setSuppressionReadable]"),
    "the screen cannot tell 'none were suppressed' from 'could not ask'"
  );
  assert.ok(
    PAGE.includes("suppressionReadable === false ? ("),
    "an unreadable list is not distinguished on screen"
  );
  assert.ok(
    PAGE.includes("it is no report at all"),
    "the message does not say what the silence means"
  );
});

test("an employee is not shown an alarm about a list that is not theirs", () => {
  // A 403 here is the route working. Rendering it as a failure would put a
  // warning on every employee's screen about customers they were never going
  // to be shown.
  assert.ok(PAGE.includes('err.message.includes("403")'), "a 403 is treated as a failure");
  assert.ok(
    PAGE.includes("forbidden ? null : false"),
    "a forbidden read must land in the never-asked state, not the failed one"
  );
});
