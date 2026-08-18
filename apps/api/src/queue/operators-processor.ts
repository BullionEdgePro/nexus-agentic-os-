import { runOperators } from "../services/operators.js";
import { logger } from "../lib/logger.js";
import { withJobHeartbeat } from "@nexus/db";

async function processOperatorsJobBody(): Promise<void> {
  const summaries = await runOperators();

  // Logged only when something moved. A scheduled job that logs "ran, found
  // nothing" every ten minutes buries the run where it found something under
  // 143 that did not.
  const changed = summaries.filter((s) => s.standing > 0 || s.retracted > 0 || s.failed);
  if (changed.length > 0) {
    logger.info({ operators: changed }, "Operator sweep");
  }
}

/**
 * Wrapped so this job cannot run without saying that it did (migration 050).
 *
 * The wrapper takes the body rather than sitting beside the call, because the
 * state this heartbeat exists to detect — started and never finished — is one
 * you would otherwise produce by accident the first time somebody added an
 * early return.
 */
export function processOperatorsJob(): Promise<void> {
  return withJobHeartbeat("operators", processOperatorsJobBody);
}
