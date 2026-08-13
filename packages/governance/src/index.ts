import type { GovernanceEvaluation } from "@nexus/shared";
import { scanForPii } from "./pii.js";
import { evaluateHallucinationRisk, type HallucinationCheckInput } from "./hallucination.js";

export * from "./pii.js";
export * from "./hallucination.js";
export * from "./policy.js";

export interface EvaluateOutgoingMessageInput extends HallucinationCheckInput {}

/**
 * Runs both governance checks an outgoing AI message must pass before it's
 * sent to a contact: a deterministic PII scan and an LLM-judge hallucination
 * check. Callers (apps/api's queue processor) decide what "flagged" means
 * for their business — e.g. the Law Firm tenant may block-and-escalate on
 * any PII match, where a lower-stakes tenant might just log it.
 */
export async function evaluateOutgoingMessage(
  input: EvaluateOutgoingMessageInput
): Promise<GovernanceEvaluation> {
  // A BUSINESS'S OWN PUBLISHED CONTACT DETAILS ARE NOT A LEAK.
  //
  // Found on the first production run after the judge came back to life.
  // Zipicka's agent answered a returns question correctly and completely — 30
  // days, condition requirements, the exclusions — and told the customer to
  // email marketing@zipicka.com to start the return. That address is on
  // Zipicka's own refund-policy page, which is where the agent read it: the
  // same judge call reported the contact email as "directly supported by the
  // retrieved knowledge-base context".
  //
  // A PII match escalates for EVERY tenant, tolerant ones included. So the best
  // answer the platform produced would have been withheld from the customer and
  // handed to a person — for quoting the business's own public inbox back to
  // them.
  //
  // The exemption is deliberately narrow: only what appears in the RETRIEVED
  // CONTEXT, which is by construction the tenant's own published material.
  // Conversation history is NOT exempt — it can carry a third party's details
  // that the customer typed, and repeating those is exactly the leak this scan
  // exists to catch.
  const piiMatches = scanForPii(input.draftReply, {
    publishedContext: input.ragContext,
  });
  const hallucination = await evaluateHallucinationRisk(input);

  const notes = [
    piiMatches.length > 0
      ? `PII matches: ${piiMatches.map((m) => `${m.type}(${m.redacted})`).join(", ")}`
      : null,
    hallucination.notes,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    piiFlagged: piiMatches.length > 0,
    hallucinationRisk: hallucination.risk,
    notes: notes || undefined,
  };
}
export * from "./redact.js";
