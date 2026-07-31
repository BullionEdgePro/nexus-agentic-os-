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
  for (const slug of ["zipicka", "juris-prime", "juris-prime-legal", "sfs-international", "atif-ali-production"]) {
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
  assert.equal(shouldEscalateReply(medium, "atif-ali-production"), false);
  console.log("PASS: per-tenant governance strictness works — law firm is held to a higher bar");
});
