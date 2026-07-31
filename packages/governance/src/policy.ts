import type { BusinessSlug, GovernanceEvaluation } from "@nexus/shared";

// Tenants where an *unverifiable* (medium-risk) statement is as unacceptable
// as an outright high-risk one — a law firm and a licensing consultancy must
// never send a factual/legal claim the judge couldn't ground, so those get
// held for human review at a lower risk threshold than the others.
const STRICT_TENANTS: ReadonlySet<BusinessSlug> = new Set<BusinessSlug>([
  "juris-prime-legal",
  "juris-prime",
]);

/**
 * Decides whether an outgoing AI reply must be blocked and escalated to a
 * human instead of being sent. Any PII match or high hallucination risk
 * escalates for every tenant; strict tenants additionally escalate on
 * medium risk. Keeping this as a pure function makes the per-tenant policy
 * unit-testable without any infrastructure.
 */
export function shouldEscalateReply(
  evaluation: GovernanceEvaluation,
  slug: BusinessSlug
): boolean {
  if (evaluation.piiFlagged) return true;
  if (evaluation.hallucinationRisk === "high") return true;
  if (evaluation.hallucinationRisk === "medium" && STRICT_TENANTS.has(slug)) return true;
  return false;
}
