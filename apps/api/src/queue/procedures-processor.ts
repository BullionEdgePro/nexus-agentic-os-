import { inferProceduresForAllBusinesses } from "../services/procedure-inference.js";

export async function processProcedureInferenceJob(): Promise<void> {
  await inferProceduresForAllBusinesses();
}
