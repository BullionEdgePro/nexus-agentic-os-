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
  const piiMatches = scanForPii(input.draftReply);
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
