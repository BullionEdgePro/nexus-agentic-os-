import { runForecastCycle } from "../services/forecast-run.js";

export async function processForecastJob(): Promise<void> {
  await runForecastCycle();
}
