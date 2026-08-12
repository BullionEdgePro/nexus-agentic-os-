import { runOperators } from "../services/operators.js";
import { logger } from "../lib/logger.js";

export async function processOperatorsJob(): Promise<void> {
  const summaries = await runOperators();

  // Logged only when something moved. A scheduled job that logs "ran, found
  // nothing" every ten minutes buries the run where it found something under
  // 143 that did not.
  const changed = summaries.filter((s) => s.standing > 0 || s.retracted > 0 || s.failed);
  if (changed.length > 0) {
    logger.info({ operators: changed }, "Operator sweep");
  }
}
