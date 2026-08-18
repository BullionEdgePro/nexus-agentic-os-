import { runForecastCycle } from "../services/forecast-run.js";
import { withJobHeartbeat } from "@nexus/db";

async function processForecastJobBody(): Promise<void> {
  await runForecastCycle();
}

/**
 * Wrapped so this job cannot run without saying that it did (migration 050).
 *
 * The wrapper takes the body rather than sitting beside the call, because the
 * state this heartbeat exists to detect — started and never finished — is one
 * you would otherwise produce by accident the first time somebody added an
 * early return.
 */
export function processForecastJob(): Promise<void> {
  return withJobHeartbeat("forecast-cycle", processForecastJobBody);
}
