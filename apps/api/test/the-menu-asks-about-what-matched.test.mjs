/**
 * The triage menu asks about the businesses that matched, not about all of them.
 *
 * ============================================================
 * WHAT WAS BEING THROWN AWAY
 * ============================================================
 *
 * `classifyBusiness` returns `{ kind: "ambiguous", candidates }` — it has
 * already worked out which businesses the message could be for, and refuses to
 * choose between them because the margin is not decisive. That refusal is
 * right.
 *
 * The dispatch site then called `askWhichBusiness(ctx, businesses)` with the
 * FULL roster and dropped `candidates` on the floor, logging it and using it
 * for nothing. Somebody writing "legal" to a number shared by three law firms
 * and two other trades was asked to choose from five, two of which could not
 * possibly have been what they meant.
 *
 * ============================================================
 * WHY THIS IS THE RIGHT FIX FOR A KEYWORD COLLISION
 * ============================================================
 *
 * Two competing law firms on one number both claim "legal" and "قانوني". The
 * tempting fix is to take the word off one of them, which is allocating clients
 * between competitors — not a decision a platform should make, and it was
 * measured to make routing WORSE in the vague case: the enquiry stops being
 * recognised as legal at all and arrives as `unknown`, indistinguishable from
 * somebody typing nonsense.
 *
 * Keeping the word in both and asking a two-item question instead hands the
 * choice to the person who actually knows the answer — the customer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyBusiness, buildTriageMessage } from "@nexus/agents";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const PROCESSOR = withoutComments(
  readFileSync(join(root, "apps", "api", "src", "queue", "processor.ts"), "utf8")
);

const FIVE = [
  { id: "1", slug: "zipicka", name: "Zipicka", routingKeywords: ["perfume", "beauty", "order"] },
  { id: "2", slug: "juris-prime", name: "Juris Prime", routingKeywords: ["attestation", "notary"] },
  { id: "3", slug: "juris-prime-legal", name: "Juris Prime Legal", routingKeywords: ["legal", "tenancy"] },
  { id: "4", slug: "abr", name: "ABR Advocates", routingKeywords: ["legal", "arbitration"] },
  { id: "5", slug: "sfs-international", name: "SFS International", routingKeywords: ["property", "rent"] },
];

// ============================================================
// The classifier still refuses to guess
// ============================================================

test("a word two businesses claim stays ambiguous rather than being decided", () => {
  // The margin rule is the thing that makes the collision safe, and it must not
  // be weakened to make the menu shorter.
  const out = classifyBusiness("legal", FIVE);
  assert.equal(out.kind, "ambiguous");
  assert.deepEqual(
    out.candidates.map((c) => c.slug).sort(),
    ["abr", "juris-prime-legal"]
  );
});

test("a decisive margin still routes without asking anybody", () => {
  const out = classifyBusiness("legal arbitration", FIVE);
  // ABR has both words, Juris Prime Legal has one -- but the margin is 1, and
  // the rule requires 2. Asking is correct here and the menu is now short.
  assert.equal(out.kind, "ambiguous");

  const decisive = classifyBusiness("legal arbitration tenancy", FIVE);
  assert.equal(decisive.kind, "ambiguous", "two words each is still not decisive");

  const clear = classifyBusiness("perfume order beauty", FIVE);
  assert.equal(clear.kind, "routed");
  assert.equal(clear.business.slug, "zipicka");
});

// ============================================================
// What the customer is asked
// ============================================================

test("the menu is built from the candidates when they narrow anything", () => {
  assert.ok(
    PROCESSOR.includes("await askWhichBusiness(ctx, asked);"),
    "the menu is still built from the full roster"
  );
  assert.ok(
    PROCESSOR.includes('const candidates = outcome.kind === "ambiguous" ? outcome.candidates : [];'),
    "the candidates the classifier computed are not read"
  );
});

test("one candidate is not a menu, and the full list is not a narrowing", () => {
  // Both cases fall back to the whole roster, because in neither has the
  // classifier actually told us anything worth acting on.
  assert.ok(
    PROCESSOR.includes("candidates.length >= 2 && candidates.length < businesses.length"),
    "the narrowing is applied without checking it narrows"
  );
});

test("an unknown message still gets the whole roster", () => {
  // `unknown` carries no candidates at all -- nothing matched -- so there is
  // nothing to narrow to and the honest menu is everybody.
  const out = classifyBusiness("asdfgh", FIVE);
  assert.equal(out.kind, "unknown");
  assert.ok(!("candidates" in out), "unknown must not pretend to know who it could be");
});

test("the shorter menu is still a real menu", () => {
  // buildTriageMessage has to work on two businesses as well as five: it
  // numbers them and describes each in a few of its own words.
  const two = FIVE.filter((b) => b.slug === "abr" || b.slug === "juris-prime-legal");
  const message = buildTriageMessage(two, "legal");
  assert.ok(message.includes("ABR"), "the menu does not name the businesses");
  assert.ok(message.includes("Juris Prime Legal"));
  assert.ok(message.includes("1") && message.includes("2"), "the menu is not answerable with a digit");
  assert.ok(!message.includes("Zipicka"), "a business that did not match is being offered");
});

test("the customer decides between competitors, not the platform", () => {
  // THE POINT. Two competing law firms both claim "legal". Taking the word off
  // one of them allocates clients; asking a two-item question does not.
  const out = classifyBusiness("legal", FIVE);
  assert.equal(out.kind, "ambiguous");
  const message = buildTriageMessage(out.candidates, "legal");
  assert.ok(message.includes("ABR") && message.includes("Juris Prime Legal"));
  for (const notOffered of ["Zipicka", "SFS International"]) {
    assert.ok(!message.includes(notOffered), `${notOffered} cannot have been what they meant`);
  }
});
