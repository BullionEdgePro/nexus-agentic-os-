// Unit test for the per-tenant escalation policy. Imports the REAL governance
// function (no mocks) since shouldEscalateReply is pure and needs no infra.
import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldEscalateReply } from "@nexus/governance";

const clean = { piiFlagged: false, hallucinationRisk: "low" };
const medium = { piiFlagged: false, hallucinationRisk: "medium" };
const high = { piiFlagged: false, hallucinationRisk: "high" };
const pii = { piiFlagged: true, hallucinationRisk: "low" };

test("every tenant escalates on PII or high hallucination risk", () => {
  for (const slug of ["zipicka", "juris-prime", "juris-prime-legal", "sfs-international", "abr"]) {
    assert.equal(shouldEscalateReply(pii, slug), true, `${slug} must escalate on PII`);
    assert.equal(shouldEscalateReply(high, slug), true, `${slug} must escalate on high risk`);
    assert.equal(shouldEscalateReply(clean, slug), false, `${slug} must send a clean reply`);
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
