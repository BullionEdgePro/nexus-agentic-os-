/**
 * The link that names its owner.
 *
 * ============================================================
 * WHAT THIS FEATURE IS, IN ONE PARAGRAPH
 * ============================================================
 *
 * A staff member's personal WhatsApp cannot be connected to this platform and
 * never will be. What was actually wanted is achievable without it: they
 * publish a link to the COMPANY number carrying a tag that names them, the
 * agent answers the inquiry, the lead is theirs from the first word, and when
 * the customer wants a person they tap through to that staff member's own
 * WhatsApp. The handover is a link the CUSTOMER taps, which is why it needs no
 * API and works today.
 *
 * These are the properties that make it safe rather than merely clever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  findStaffTag,
  buildStaffDeepLink,
  personalHandoffLink,
  describeReferringColleague,
} from "../../../packages/agents/src/referral.ts";
import { classifyBusiness } from "../../../packages/agents/src/business-router.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const REFERRALS = read("packages", "db", "src", "referrals.ts");

const BUSINESSES = [
  { id: "z", slug: "zipicka", name: "Zipicka", routingKeywords: [] },
  { id: "j", slug: "juris-prime-legal", name: "Juris Prime Legal", routingKeywords: [] },
];

// ============================================================
// The tag, as real behaviour
// ============================================================

test("a staff link routes to the business AND names the person", () => {
  const url = buildStaffDeepLink({
    businessSlug: "zipicka",
    businessName: "Zipicka",
    employeeCode: "aqib-sarosh",
    employeeName: "Aqib Sarosh",
    companyNumber: "+971 50 480 5436",
  });
  const text = decodeURIComponent(new URL(url).searchParams.get("text"));

  // Both facts survive the round trip through a wa.me link.
  assert.equal(classifyBusiness(text, BUSINESSES).business?.slug, "zipicka");
  assert.equal(findStaffTag(text), "aqib-sarosh");
});

test("the link points at the company number, never a personal one", () => {
  const url = buildStaffDeepLink({
    businessSlug: "zipicka",
    businessName: "Zipicka",
    employeeCode: "aqib-sarosh",
    employeeName: "Aqib Sarosh",
    companyNumber: "971504805436",
  });
  // The whole design. A link straight to a personal number gives the staff
  // member their lead and gives the business nothing: no record, no answer out
  // of hours, and nothing to hand over when they leave.
  assert.ok(url.startsWith("https://wa.me/971504805436?"));
});

test("a business link with no staff tag attributes to nobody", () => {
  // The ordinary case, and it must stay ordinary.
  assert.equal(findStaffTag("#zipicka Hello Zipicka, I would like to ask about"), null);
});

test("a customer who deletes the tag is simply unattributed", () => {
  // The prefilled text is the customer's message and they may edit it. Guessing
  // an owner from the rest of the sentence would hand somebody a lead on the
  // strength of a coincidence.
  assert.equal(findStaffTag("hi do you sell iphone cases"), null);
});

test("the staff tag is found after the business tag, not only at the start", () => {
  // The business tag is start-anchored, so the staff tag is by construction not
  // first. Anchoring it would have matched nothing, on every link.
  assert.equal(findStaffTag("#zipicka #via-rsimeon Hello"), "rsimeon");
});

test("a tag inside a longer word is not a tag", () => {
  assert.equal(findStaffTag("email me at hash#via-nothing"), null);
});

test("the tag is case-insensitive, because phones capitalise sentences", () => {
  assert.equal(findStaffTag("#zipicka #Via-Aqib-Sarosh hello"), "aqib-sarosh");
});

// ============================================================
// The handover link
// ============================================================

test("a handover is built from the dialable number", () => {
  const link = personalHandoffLink({
    employeeName: "Aqib Sarosh",
    whatsappNumber: "+971 52 265 4051",
    businessName: "Zipicka",
  });
  assert.ok(link.startsWith("https://wa.me/971522654051?"));
});

test("no number means no link, rather than a broken one", () => {
  // "Here is my colleague's direct line" followed by a dead link is worse than
  // never mentioning it.
  assert.equal(
    personalHandoffLink({ employeeName: "X", whatsappNumber: null, businessName: "Y" }),
    null
  );
  assert.equal(
    personalHandoffLink({ employeeName: "X", whatsappNumber: "12345", businessName: "Y" }),
    null,
    "a truncated number dials somebody real"
  );
  assert.equal(
    personalHandoffLink({
      employeeName: "X",
      whatsappNumber: "1283383404852750",
      businessName: "Y",
    }),
    null,
    "a Meta phone_number_id is 16 digits and must never become a wa.me link"
  );
});

// ============================================================
// What the agent is told
// ============================================================

test("the agent is told not to pass the customer on unprompted", () => {
  const note = describeReferringColleague({
    employeeName: "Aqib Sarosh",
    handoffLink: "https://wa.me/971522654051",
  });
  assert.match(note, /INTERNAL/);
  assert.match(note, /arriving through somebody's link is not a request to be passed to them/);
  assert.match(note, /If they ask to speak to a person/);
});

test("with no reachable colleague the agent is told not to invent one", () => {
  // The neighbouring escalation note carries a long comment about the day an
  // internal staffing fact reached a client verbatim. Same discipline here.
  const note = describeReferringColleague({ employeeName: "Aqib Sarosh", handoffLink: null });
  assert.match(note, /Do NOT invent a number/);
  assert.match(note, /no notification is sent/);
  assert.ok(!/wa\.me/.test(note), "a link is offered when there is none to offer");
});

test("the link is to be given exactly as written", () => {
  // A model that helpfully tidies a URL produces one that does not open.
  const note = describeReferringColleague({
    employeeName: "Aqib",
    handoffLink: "https://wa.me/971522654051?text=Hello",
  });
  assert.match(note, /as it is written/);
});

// ============================================================
// Attribution, and the two things it must never do
// ============================================================

test("a link can bring a new client and can never take a colleague's", () => {
  // The whole safety property of the claim, in one clause.
  const fn = REFERRALS.slice(REFERRALS.indexOf("export async function attributeConversation"));
  assert.match(fn, /ct\.owner_employee_id is null/);
});

test("a second link does not rewrite where a conversation came from", () => {
  assert.match(REFERRALS, /and referred_by_employee_id is null/);
});

test("a tag cannot pull back a conversation a human already has", () => {
  assert.match(REFERRALS, /employee_id = coalesce\(employee_id, \$2\)/);
});

test("the staff lookup runs in the serving business's scope", () => {
  // `employees` is isolated on organization_id = app.current_org with no
  // serving clause. The inbound worker runs as the NUMBER OWNER, so an
  // unwrapped lookup returns zero rows and no error — every referral to any
  // business but the number's owner would silently attribute to nobody.
  assert.match(REFERRALS, /withServingTenant\(organizationId, \(\) => findEmployeeByCodeScoped/);
});

test("the conflict name is read in the scope employees are visible in", () => {
  // Two queries rather than one join: the contact write must happen in the
  // owner's scope, the employee name must be read in the serving one, and a
  // join would have quietly returned no name and reported "nobody else owns
  // them" — turning a real conflict into silence.
  const fn = REFERRALS.slice(REFERRALS.indexOf("export async function attributeConversation"));
  assert.ok(
    !/join employees/.test(fn),
    "the conflict lookup joins employees again, which returns nothing under the owner's scope"
  );
  assert.match(fn, /withServingTenant\(input\.organizationId/);
});

// ============================================================
// The processor
// ============================================================

test("attribution happens after the business is known, never before", () => {
  // A staff code is unique per business, so `#via-aqib` means nothing until
  // there is a business to read it in.
  const serving = PROCESSOR.indexOf("const serving = decision.organization;");
  const referrer = PROCESSOR.indexOf("const referrer = await resolveReferrer(");
  assert.ok(serving !== -1 && referrer > serving);
});

test("a referral that cannot be resolved degrades to an ordinary conversation", () => {
  // A referral is worth a great deal and worth nothing at all compared to
  // answering the customer.
  const fn = PROCESSOR.slice(PROCESSOR.indexOf("async function resolveReferrer"));
  assert.match(fn, /catch \(err\)/);
  assert.match(fn, /return null;/);
});

test("a link naming nobody is recorded rather than shrugged at", () => {
  // A published link whose code resolves to nobody is a link on somebody's
  // Instagram bio quietly wasting every lead it brings.
  const fn = PROCESSOR.slice(PROCESSOR.indexOf("async function resolveReferrer"));
  assert.match(fn, /names a code no employee at this business has/);
});

test("a former employee's link records the source but promises no handover", () => {
  const fn = PROCESSOR.slice(PROCESSOR.indexOf("async function resolveReferrer"));
  assert.match(fn, /claimContact: employee\.isActive/);
  assert.match(fn, /former employee/);
});
