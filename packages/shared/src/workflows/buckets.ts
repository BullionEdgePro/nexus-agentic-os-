/**
 * The audit's chart buckets (spec §5): one per day for 7 and 30 days, one per
 * Monday-start week for 90. The keys are already the business's own days
 * (`YYYY-MM-DD`, from SQL in its timezone), so the arithmetic here is plain
 * calendar arithmetic in UTC and never shifts a day.
 */

const DAY_MS = 86_400_000;

function toMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Monday of the week holding `day`. */
function mondayOf(day: string): string {
  const ms = toMs(day);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return toDay(ms - weekday * DAY_MS);
}

/** Every bucket key from the one holding `from` to the one holding `today`. */
export function bucketKeys(from: string, today: string, bucket: "day" | "week"): string[] {
  const step = bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const start = toMs(bucket === "day" ? from : mondayOf(from));
  const end = toMs(bucket === "day" ? today : mondayOf(today));
  const keys: string[] = [];
  for (let ms = start; ms <= end; ms += step) keys.push(toDay(ms));
  return keys;
}

/** One row per key, in key order: the row SQL returned, or `empty(key)`. */
export function fillBuckets<T extends { bucket: string }>(rows: T[], keys: string[], empty: (bucket: string) => T): T[] {
  const byKey = new Map(rows.map((row) => [row.bucket, row]));
  return keys.map((key) => byKey.get(key) ?? empty(key));
}
