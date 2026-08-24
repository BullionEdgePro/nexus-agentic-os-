// Unit test for the per-tenant escalation policy. Imports the REAL governance
// function (no mocks) since shouldEscalateReply is pure and needs no infra.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { shouldEscalateReply } from "@nexus/governance";

const here = dirname(fileURLToPath(import.meta.url));

const clean = { piiFlagged: false, hallucinationRisk: "low" };
const medium = { piiFlagged: false, hallucinationRisk: "medium" };
const high = { piiFlagged: false, hallucinationRisk: "high" };
const pii = { piiFlagged: true, hallucinationRisk: "low" };

/**
 * The lenient allowlist, read from the module that owns it.
 *
 * Not retyped here. The point of asserting against it is that it cannot grow
 * without this test noticing, and a copy of it in the test would grow with it.
 */
function tolerantSlugs() {
  const src = readFileSync(
    join(here, "..", "..", "..", "packages", "governance", "src", "policy.ts"),
    "utf8"
  );
  const open = src.indexOf("MEDIUM_RISK_TOLERANT");
  const from = src.indexOf("[", open);
  const to = src.indexOf("]", from);
  const slugs = [];
  for (const part of src.slice(from + 1, to).split(",")) {
    const quoted = part.trim().replace(/^["']|["'],?$/g, "");
    if (quoted && !quoted.startsWith("//")) slugs.push(quoted);
  }
  return slugs;
}

test("PII and high risk escalate for ANY tenant, including one nobody has configured", () => {
  // The five known slugs used to be listed here, which tested the five cases
  // the policy was deliberately rewritten to stop caring about. policy.ts takes
  // a plain string rather than a BusinessSlug union precisely so it behaves
  // correctly for a tenant it has never heard of; that is the claim, so that is
  // what is asserted.
  // The MEDIUM-risk half of this same property already has a test further
  // down -- "an unknown tenant is held to the STRICT bar" -- and I nearly
  // added it a second time. This one covers the halves that test does not:
  // PII and high risk, which are slug-independent in the implementation and
  // were previously asserted only for five named tenants.
  const slugs = [...tolerantSlugs(), "a-firm-onboarded-tomorrow", "", "../../etc/passwd"];
  assert.ok(slugs.length >= 3, "the tolerant list could not be read from policy.ts");

  for (const slug of slugs) {
    assert.equal(shouldEscalateReply(pii, slug), true, `${slug || "(empty slug)"} must escalate on PII`);
    assert.equal(shouldEscalateReply(high, slug), true, `${slug || "(empty slug)"} must escalate on high risk`);
    assert.equal(shouldEscalateReply(clean, slug), false, `${slug || "(empty slug)"} must send a clean reply`);
  }
});

test("strict tenants (law firm, licensing) also escalate on MEDIUM risk", () => {
  assert.equal(shouldEscalateReply(medium, "juris-prime-legal"), true, "law firm must not send an unverifiable claim");
  assert.equal(shouldEscalateReply(medium, "juris-prime"), true, "licensing consultancy must not send an unverifiable claim");
});

test("non-strict tenants tolerate MEDIUM risk (send the reply)", () => {
  assert.equal(shouldEscalateReply(medium, "zipicka"), false);
  assert.equal(shouldEscalateReply(medium, "sfs-international"), false);
  // ABR replaced Atif Ali Production and is a LITIGATION FIRM, so the answer
  // here flips: it is not on the lenient allowlist, and an unverifiable
  // statement about a criminal matter must never go out unreviewed. Nobody had
  // to remember to add it — the allowlist is of the tolerant, so a new tenant
  // is strict by default. This asserts that inversion actually pays off.
  assert.equal(shouldEscalateReply(medium, "abr"), true);
  console.log("PASS: per-tenant governance strictness works — law firm is held to a higher bar");
});

test("an unknown tenant is held to the STRICT bar, not the lenient one", () => {
  // Migration 002 removed the 5-tenant cap, so this module will eventually be
  // handed slugs it has never seen. A newly onboarded tenant is the one we
  // understand least, so the default must be caution — the previous
  // denylist shape would have silently sent unverifiable claims here.
  for (const slug of ["a-new-law-firm", "some-medical-clinic", ""]) {
    assert.equal(
      shouldEscalateReply(medium, slug),
      true,
      `unrecognized tenant "${slug}" must default to escalating medium risk`
    );
  }
  console.log("PASS: unrecognized tenants fail safe (escalate) rather than fail open");
});
