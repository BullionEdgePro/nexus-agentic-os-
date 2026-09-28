/**
 * Wall-clock time in a business's timezone, and back.
 *
 * A reminder typed as "Thursday 3pm" means 3pm where the BUSINESS is — Dubai,
 * for all five today — not where the server is (UTC) and not where the browser
 * happens to be. Postgres would read a bare "2026-10-01T15:00" as UTC and the
 * follow-up would fall due at 7pm local, four hours after the promised call.
 *
 * No library: Intl already knows every zone's offset at any instant, and the
 * one subtlety (the offset itself depends on the instant, around DST changes)
 * is handled by correcting twice. The UAE has no DST; the correction is for the
 * next business somewhere that does.
 */

/** The zone's offset from UTC, in minutes, at the given instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * "2026-10-01T15:00" read as wall-clock time in `timeZone`, as a real instant.
 * Returns null for anything that is not that exact shape or not a real date.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // First guess with the offset at the naive instant, then correct once with
  // the offset at the guessed instant — enough to land on the right side of a
  // DST boundary.
  let guess = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  guess = naive - offsetMinutes(new Date(guess), timeZone) * 60_000;
  const out = new Date(guess);
  // A date like 31 February rolls over silently in Date.UTC — refuse it.
  if (new Date(naive).getUTCDate() !== d) return null;
  return out;
}

/** "Thursday, 1 October 2026, 14:05" — now, in the zone, for a prompt. */
export function describeNow(now: Date, timeZone: string): string {
  return now.toLocaleString("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** Now as "YYYY-MM-DDTHH:MM" wall-clock in the zone — the model's anchor. */
export function localStamp(now: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
