import { getPool } from "./client.js";
import type { GovernanceEvaluation } from "@nexus/shared";

export async function insertEvaluation(
  organizationId: string,
  messageId: string,
  evaluation: GovernanceEvaluation
): Promise<void> {
  await getPool().query(
    `insert into ai_message_evaluations (organization_id, message_id, pii_flagged, hallucination_risk, notes)
     values ($1, $2, $3, $4, $5)`,
    [organizationId, messageId, evaluation.piiFlagged, evaluation.hallucinationRisk, evaluation.notes ?? null]
  );
}
