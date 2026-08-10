import type { GovernanceEvaluation } from "@nexus/shared";

/**
 * Tenants that tolerate an *unverifiable* (medium-risk) statement going out
 * without human review — retail and services businesses where an imprecise
 * answer is a minor annoyance rather than a liability.
 *
 * This list is deliberately an ALLOWLIST of the lenient, not a denylist of the
 * strict. It used to be the other way around, which carried a quiet failure
 * mode: once the platform could onboard tenants beyond the original five
 * (migration 002), a brand-new tenant would match neither strict entry and
 * silently fall through to the most permissive branch — at exactly the moment
 * we understand that tenant's risk profile least.
 *
 * Inverted, an unrecognized tenant is held to the stricter bar until someone
 * deliberately relaxes it. A law firm added tomorrow is safe by default.
 */
const MEDIUM_RISK_TOLERANT: ReadonlySet<string> = new Set<string>([
  "zipicka",
  "sfs-international",
]);

/**
 * Decides whether an outgoing AI reply must be blocked and escalated to a
 * human instead of being sent. Any PII match or high hallucination risk
 * escalates for every tenant; medium risk escalates for every tenant except
 * those explicitly listed as tolerant above.
 *
 * Takes a plain string rather than the BusinessSlug union because the platform
 * is no longer limited to five known tenants — and the whole point of the
 * inversion above is to behave correctly for a slug this module has never
 * seen. Keeping it a pure function makes the per-tenant policy unit-testable
 * without any infrastructure.
 */
export function shouldEscalateReply(evaluation: GovernanceEvaluation, slug: string): boolean {
  if (evaluation.piiFlagged) return true;
  if (evaluation.hallucinationRisk === "high") return true;
  if (evaluation.hallucinationRisk === "medium" && !MEDIUM_RISK_TOLERANT.has(slug)) return true;
  return false;
}
