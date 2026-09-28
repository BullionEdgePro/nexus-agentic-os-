import { runOperators } from "../services/operators.js";
import { assignWaitingChats } from "../services/availability.js";
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

  // The after-hours sweep rides on this 10-minute job: chats that arrived while
  // nobody was on shift are handed out once somebody is. Best-effort and
  // self-contained — it never throws, so it cannot fail the operator run.
  const sweep = await assignWaitingChats();
  if (sweep.assigned > 0) {
    logger.info(sweep, "Assigned chats that were waiting for a shift to start");
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
