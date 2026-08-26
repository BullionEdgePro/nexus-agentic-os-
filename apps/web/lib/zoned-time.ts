/**
 * Turning a clock somebody typed into a moment in time.
 *
 * ============================================================
 * WHY THIS IS NOT INLINE IN THE FORM
 * ============================================================
 *
 * It is the only part of adding an appointment that can be wrong without
 * looking wrong. Every other field either saves or refuses; this one silently
 * produces a real booking at the wrong hour, displayed plausibly, for a
 * customer who will arrive when the paper said. It lives here because a
 * component cannot be imported by a test and this has to be.
 *
 * The read side of the diary already formats in the business's zone and says so
 * in its own comment: an appointment is a moment somebody physically walks into
 * an office in Dubai. This is that argument running backwards — an operator in
 * London typing 15:00 means the customer's three o'clock, not their own.
 */

/**
 * A date and a time as typed, read as that wall clock in `timeZone`.
 *
 * There is no built-in for this. `new Date("2026-08-28T15:00")` uses the
 * BROWSER's zone, and appending "Z" forces UTC; neither is the business's. So
 * the typed clock is treated as UTC to get a first guess, the real offset at
 * that instant is measured, and the guess is corrected by it.
 *
 * Corrected TWICE, and the second pass is not superstition. The offset an hour
 * before an appointment can differ from the offset at it across a
 * daylight-saving boundary, so a single correction can land on the wrong side
 * and stay there. Correcting again from the corrected instant settles it.
 * Asia/Dubai has no DST and none of the five businesses would ever notice,
 * which is precisely why nobody would notice when a sixth did.
 *
 * Returns "" for anything unparseable rather than a guess, because the caller
 * can say "pick a date and a time" and cannot un-book an appointment.
 */
export function wallClockToInstant(date: string, time: string, timeZone: string): string {
  if (!date || !time) return "";
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(guess)) return "";
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone);
  const settled = new Date(instant);
  if (Number.isNaN(settled.getTime())) return "";
  return settled.toISOString();
}

/**
 * How far ahead of UTC `timeZone` is at this instant, in milliseconds.
 *
 * Formatting an instant into the zone's own numbers and reading them back as
 * though they were UTC gives the offset, which is the standard trick because
 * Intl exposes no offset directly.
 */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));

    const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
    const asIfUtc = Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour"),
      at("minute"),
      at("second")
    );
    return asIfUtc - instant;
  } catch {
    // `organizations.timezone` is free text and an unusable value must not
    // silently shift an appointment. Zero means the typed clock is taken as
    // UTC — which the zone printed on the form has already told the reader,
    // so the weakest case is stated rather than hidden.
    return 0;
  }
}

/** One end of an appointment, written for a person, in the business's zone. */
export function describeInstant(iso: string, timeZone: string, timeOnly = false): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      ...(timeOnly ? {} : { weekday: "short", day: "numeric", month: "short" }),
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
