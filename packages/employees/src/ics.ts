/**
 * A calendar feed, turned into "this person is busy between here and here".
 *
 * ============================================================
 * WHY A FEED AND NOT AN INTEGRATION
 * ============================================================
 *
 * F1 has said "calendar presence (needs a calendar integration)" since this
 * platform started. The obvious reading is OAuth against Google, which means an
 * app registration, a consent screen, a refresh-token store and a verification
 * review — and it would work for Google only, on an account somebody has to own.
 *
 * A secret ICS URL is the same fact by a shorter road. Google, Outlook, Apple
 * and Fastmail all publish one, it is read-only by construction, it needs no
 * credentials on this side, and it is revoked by rotating the link. What this
 * platform needs to know is "is this person in something right now", and that is
 * exactly what the feed says.
 *
 * ============================================================
 * WHAT IT REFUSES TO GUESS
 * ============================================================
 *
 * The rule throughout: an event this cannot understand is COUNTED, never
 * skipped quietly. A calendar that half-parses is worse than one that does not
 * parse at all, because the half that is missing is invisible — the person looks
 * free at exactly the times nobody could see. `unsupported` comes back with the
 * busy blocks and the screen says so.
 *
 * Recurrence is where that bites. DAILY and WEEKLY are handled, including
 * INTERVAL, COUNT, UNTIL and BYDAY, which is what "every Tuesday I am in court"
 * needs. MONTHLY and YEARLY are not, and are reported rather than dropped.
 */

/** One block of time somebody is not free. Both ends are absolute instants. */
export interface BusyBlock {
  startsAt: Date;
  endsAt: Date;
  /** The feed's own id, so a re-sync replaces rather than duplicates. */
  uid: string;
}

export interface ParsedCalendar {
  busy: BusyBlock[];
  /**
   * Events understood well enough to know they were NOT understood.
   *
   * A count rather than a boolean, and surfaced to the person who pasted the
   * link, because "your calendar is syncing" and "your calendar is syncing
   * except for the eleven monthly ones" are different statements.
   */
  unsupported: number;
}

/** How far ahead busy time is worth knowing about. Beyond this it is planning. */
export const CALENDAR_WINDOW_DAYS = 14;

/** A feed larger than this is a mailing list, not one person's diary. */
export const MAX_ICS_BYTES = 4 * 1024 * 1024;

const DAY_MS = 86_400_000;

const BYDAY_TO_INDEX: Readonly<Record<string, number>> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Undo RFC 5545 line folding.
 *
 * A line longer than 75 octets is split and continued with a leading space or
 * tab. Parse without unfolding and a long summary silently becomes a property
 * name nobody recognises -- and, worse, a DTSTART that happened to be folded
 * becomes an event with no start, which is dropped.
 */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseProperty(line: string): Property | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * The offset of a named zone at a given instant, in minutes.
 *
 * Computed from Intl rather than carried as a table: Node ships the zone
 * database and it stays right across daylight-saving changes, which a table
 * written today would not.
 */
function offsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    );
    return (asUtc - at.getTime()) / 60000;
  } catch {
    // An unrecognised TZID is treated as UTC rather than dropping the event.
    // Being an hour or two wrong about somebody being busy is a smaller error
    // than believing they are free all week.
    return 0;
  }
}

/**
 * An ICS date-time to an instant.
 *
 * Three shapes, and the third is the one that needs a fallback zone:
 *   20260825T090000Z   already absolute
 *   20260825T090000    "floating" -- means 09:00 wherever the calendar's owner
 *                      is, so it is read in THEIR timezone, not the server's
 *   20260825           an all-day date
 */
function toInstant(value: string, params: Record<string, string>, fallbackZone: string): Date | null {
  const v = value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const naive = Date.UTC(Number(y), Number(m) - 1, Number(d));
    const zone = params.TZID || fallbackZone;
    return new Date(naive - offsetMinutes(zone, new Date(naive)) * 60000);
  }

  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!stamp) return null;
  const [, y, m, d, hh, mm, ss, z] = stamp;
  const naive = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  if (z) return new Date(naive);

  const zone = params.TZID || fallbackZone;
  // Two passes: the offset depends on the instant, and the instant depends on
  // the offset. One correction is enough everywhere except the hour a clock
  // change happens inside, where any answer is arguable.
  const first = naive - offsetMinutes(zone, new Date(naive)) * 60000;
  return new Date(naive - offsetMinutes(zone, new Date(first)) * 60000);
}

/** ISO 8601 duration to milliseconds. Only the parts a calendar actually uses. */
function durationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim()
  );
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  const total =
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * DAY_MS +
    Number(h ?? 0) * 3_600_000 +
    Number(min ?? 0) * 60_000 +
    Number(s ?? 0) * 1000;
  return sign === "-" ? -total : total;
}

/** One VEVENT while it is still being read, before it is known to be usable. */
interface PartialEvent {
  uid: string;
  start: Date | null;
  end: Date | null;
  duration: number | null;
  rrule: Record<string, string> | null;
  transparent: boolean;
  cancelled: boolean;
  excluded: number[];
}

interface RawEvent {
  uid: string;
  start: Date;
  end: Date;
  rrule: Record<string, string> | null;
  excluded: number[];
}

/**
 * Every interval this feed says the owner is busy, inside the window.
 *
 * `fallbackZone` is the employee's own timezone and is used only for events
 * that name none -- a floating 09:00 means nine in the morning where they are.
 */
export function parseCalendar(
  ics: string,
  from: Date,
  to: Date,
  fallbackZone = "UTC"
): ParsedCalendar {
  const lines = unfold(ics);
  const busy: BusyBlock[] = [];
  let unsupported = 0;

  let inEvent = false;
  let current: PartialEvent | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      inEvent = true;
      current = {
        uid: "",
        start: null,
        end: null,
        duration: null,
        rrule: null,
        transparent: false,
        cancelled: false,
        excluded: [],
      };
      continue;
    }

    if (line.startsWith("END:VEVENT")) {
      if (current) {
        const done = finishEvent(current);
        if (done === "unsupported") unsupported++;
        else if (done) busy.push(...expand(done, from, to));
      }
      inEvent = false;
      current = null;
      continue;
    }

    if (!inEvent || !current) continue;

    const prop = parseProperty(line);
    if (!prop) continue;

    switch (prop.name) {
      case "UID":
        current.uid = prop.value.trim();
        break;
      case "DTSTART":
        current.start = toInstant(prop.value, prop.params, fallbackZone);
        // An all-day event with no DTEND lasts the whole day. Recorded here
        // because the VALUE=DATE parameter is gone by the time DTEND is read.
        if (prop.params.VALUE === "DATE" && !current.duration) current.duration = DAY_MS;
        break;
      case "DTEND":
        current.end = toInstant(prop.value, prop.params, fallbackZone);
        break;
      case "DURATION":
        current.duration = durationMs(prop.value);
        break;
      case "RRULE": {
        const rule: Record<string, string> = {};
        for (const part of prop.value.split(";")) {
          const eq = part.indexOf("=");
          if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
        }
        current.rrule = rule;
        break;
      }
      case "EXDATE": {
        // A cancelled occurrence of a repeating event. Without this, "every
        // Tuesday, except the one I moved" reports somebody busy at a time
        // their own calendar shows free.
        for (const one of prop.value.split(",")) {
          const at = toInstant(one, prop.params, fallbackZone);
          if (at) current.excluded.push(at.getTime());
        }
        break;
      }
      case "TRANSP":
        // The calendar's own word for "this does not make me unavailable".
        current.transparent = prop.value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "STATUS":
        current.cancelled = prop.value.trim().toUpperCase() === "CANCELLED";
        break;
      default:
        break;
    }
  }

  busy.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return { busy, unsupported };
}

type Finished = RawEvent | "unsupported" | null;

function finishEvent(e: PartialEvent): Finished {
  if (e.cancelled || e.transparent) return null;
  if (!e.start) return null;

  const end = e.end ?? (e.duration != null ? new Date(e.start.getTime() + e.duration) : null);
  if (!end) return null;
  // A zero or negative length event is a marker, not a commitment.
  if (end.getTime() <= e.start.getTime()) return null;

  if (e.rrule) {
    const freq = (e.rrule.FREQ ?? "").toUpperCase();
    if (freq !== "DAILY" && freq !== "WEEKLY") return "unsupported";
  }

  return { uid: e.uid, start: e.start, end, rrule: e.rrule, excluded: e.excluded };
}

/** Every occurrence of one event that overlaps the window. */
function expand(event: RawEvent, from: Date, to: Date): BusyBlock[] {
  const length = event.end.getTime() - event.start.getTime();
  const overlaps = (start: number) => start + length > from.getTime() && start < to.getTime();

  if (!event.rrule) {
    return overlaps(event.start.getTime())
      ? [{ uid: event.uid, startsAt: event.start, endsAt: event.end }]
      : [];
  }

  const rule = event.rrule;
  const freq = (rule.FREQ ?? "").toUpperCase();
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const until = rule.UNTIL ? toInstant(rule.UNTIL, {}, "UTC") : null;
  const byDay = rule.BYDAY
    ? rule.BYDAY.split(",")
        .map((d) => BYDAY_TO_INDEX[d.trim().slice(-2).toUpperCase()])
        .filter((n) => n !== undefined)
    : [];

  const out: BusyBlock[] = [];
  let emitted = 0;
  const step = (freq === "WEEKLY" ? 7 : 1) * interval * DAY_MS;

  // Bounded by the window rather than by the rule: an event repeating daily
  // forever would otherwise be an infinite loop with a `break` somebody has to
  // remember. The cap is the window plus one step, which is every occurrence
  // that could possibly overlap it.
  const horizon = to.getTime() + step;

  for (let at = event.start.getTime(); at <= horizon; at += step) {
    if (until && at > until.getTime()) break;
    if (count != null && emitted >= count) break;

    if (freq === "WEEKLY" && byDay.length > 0) {
      // A weekly rule with BYDAY repeats on each named day of that week, not
      // just on the start's own weekday.
      const weekStart = at;
      for (const day of byDay) {
        const base = new Date(weekStart);
        const shift = (day - base.getUTCDay() + 7) % 7;
        const occurrence = weekStart + shift * DAY_MS;
        if (until && occurrence > until.getTime()) continue;
        if (event.excluded.includes(occurrence)) continue;
        emitted++;
        if (count != null && emitted > count) break;
        if (overlaps(occurrence)) {
          out.push({
            uid: event.uid,
            startsAt: new Date(occurrence),
            endsAt: new Date(occurrence + length),
          });
        }
      }
      continue;
    }

    if (event.excluded.includes(at)) continue;
    emitted++;
    if (overlaps(at)) {
      out.push({ uid: event.uid, startsAt: new Date(at), endsAt: new Date(at + length) });
    }
  }

  return out;
}

/** Is somebody busy at this instant, according to these blocks? */
export function busyAt(blocks: readonly BusyBlock[], at: Date): boolean {
  const t = at.getTime();
  return blocks.some((b) => b.startsAt.getTime() <= t && b.endsAt.getTime() > t);
}
