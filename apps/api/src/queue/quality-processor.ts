import { rollUpRecentQuality } from "../services/quality-rollup.js";

export async function processQualityRollupJob(): Promise<void> {
  await rollUpRecentQuality();
}
