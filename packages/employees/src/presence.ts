import type {
  Employee,
  PresenceStatus,
  ResolvedPresence,
  TimeWindow,
  Weekday,
  WeeklySchedule,
} from "@nexus/shared";

// Intl's short weekday names, in the order we need to map them onto our own
// three-letter keys. Kept explicit rather than derived so a locale change can
// never silently reshuffle the week.
const WEEKDAY_BY_INTL: Readonly<Record<string, Weekday>> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

/** Statuses that mean "a human is actively at the keyboard". */
const HUMAN_PRESENT: ReadonlySet<PresenceStatus> = new Set<PresenceStatus>(["online"]);

interface LocalClock {
  weekday: Weekday;
  /** Minutes since local midnight. */
  minutes: number;
  /** True when the timezone string was unusable and we fell back to UTC. */
  fellBackToUtc: boolean;
}

/**
 * Resolve "what time is it for this employee" using the platform's own tz
 * database via Intl — no dependency, and correct across DST transitions,
 * which naive UTC-offset arithmetic is not.
 *
 * `employees.timezone` is free text, so an invalid value must not throw on
 * the hot path of an inbound message; we degrade to UTC and say so in the
 * result rather than crashing the reply pipeline.
 */
function localClock(now: Date, timeZone: string): LocalClock {
  const read = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23", // guarantees 00-23, never a stray "24"
    }).formatToParts(now);

    const lookup = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      weekday: WEEKDAY_BY_INTL[lookup("weekday")] ?? "mon",
      minutes: Number(lookup("hour")) * 60 + Number(lookup("minute")),
    };
  };

  try {
    return { ...read(timeZone), fellBackToUtc: false };
  } catch {
    return { ...read("UTC"), fellBackToUtc: true };
  }
}

/** "09:30" → 570. Returns null for anything malformed. */
function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * Is `minutes` inside this window? Windows where end <= start are treated as
 * wrapping past midnight (a 22:00–06:00 night shift), which is why this is
 * not a simple `start <= m && m < end`.
 */
function windowContains(window: TimeWindow, minutes: number): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // zero-length window is not a shift
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // wraps midnight
}

function scheduleContains(schedule: WeeklySchedule, clock: LocalClock): boolean {
  const today = schedule[clock.weekday] ?? [];
  if (today.some((w) => windowContains(w, clock.minutes))) return true;

  // A window that wraps midnight belongs to the day it STARTED on, so a
  // 22:00–06:00 Friday shift must still count at 02:00 on Saturday.
  const yesterday = previousWeekday(clock.weekday);
  return (schedule[yesterday] ?? []).some((w) => {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start === null || end === null || start <= end) return false; // only wrapping windows carry over
    return clock.minutes < end;
  });
}

const WEEK_ORDER: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function previousWeekday(day: Weekday): Weekday {
  const index = WEEK_ORDER.indexOf(day);
  return WEEK_ORDER[(index + WEEK_ORDER.length - 1) % WEEK_ORDER.length];
}

function manualOverrideActive(employee: Employee, now: Date): boolean {
  if (!employee.manualPresence) return false;
  if (!employee.manualPresenceUntil) return true; // open-ended override
  const until = Date.parse(employee.manualPresenceUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * The Presence Engine.
 *
 * Pure and synchronous by design: it runs on every inbound message, and
 * keeping it free of I/O means the per-tenant scheduling policy is unit
 * testable with no database, no clock mocking beyond passing `now`, and no
 * risk of adding latency to the reply path.
 *
 * Precedence, highest first:
 *   1. Inactive employee            → offline, twin silent (falls back to the org agent)
 *   2. Active manual override       → whatever the human set
 *   3. Working-hours schedule       → online inside a window, offline outside
 *   4. Calendar, inside those hours → busy while they are in something
 *
 * The calendar sits BELOW the manual override and BELOW the schedule, and both
 * placements are deliberate. A person who has said "I am available" outranks
 * their diary, because they are looking at both and this is not. And a calendar
 * cannot make somebody available outside their working hours: a meeting at
 * eight in the evening is evidence they are busy, never evidence they are at
 * work. It behaves exactly like a scheduled break, which is the same fact from
 * a different source.
 *
 * Still pure. The busy blocks are READ by the caller and passed in, because
 * this runs on every inbound message and the whole point of it being
 * synchronous is that it never touches the database.
 *
 * `shouldTwinRespond` is deliberately biased toward answering. The one case
 * where the twin stays silent for an available human is `humanFirst`, which
 * defaults to false — so switching the employee layer on can never introduce
 * customer-facing silence, which is the failure mode this codebase already
 * works hardest to avoid (see the fallback path in the queue processor).
 */
export function resolvePresence(
  employee: Employee,
  now: Date = new Date(),
  /** True when this person's calendar says they are in something right now. */
  inSomething = false
): ResolvedPresence {
  if (!employee.isActive) {
    return {
      status: "offline",
      source: "system",
      shouldTwinRespond: false,
      reason: "Employee record is inactive — routing falls back to the organization agent.",
    };
  }

  if (manualOverrideActive(employee, now)) {
    const status = employee.manualPresence as PresenceStatus;
    return {
      status,
      source: "manual",
      shouldTwinRespond: twinShouldRespond(employee, status),
      reason: `Manual override set to "${status}".`,
    };
  }

  const clock = localClock(now, employee.timezone);
  const onShift = scheduleContains(employee.workingHours, clock);
  const onBreak = onShift && scheduleContains(employee.breakSchedule, clock);
  // Only inside working hours, for the reason above: a meeting in the evening
  // is not evidence somebody is at work.
  const inMeeting = onShift && inSomething;

  const status: PresenceStatus = !onShift ? "offline" : onBreak || inMeeting ? "busy" : "online";
  const tzNote = clock.fellBackToUtc
    ? ` (unrecognized timezone "${employee.timezone}", evaluated in UTC)`
    : "";

  return {
    status,
    source: inMeeting && !onBreak ? "calendar" : "schedule",
    shouldTwinRespond: twinShouldRespond(employee, status),
    reason: !onShift
      ? `Outside working hours${tzNote}.`
      : onBreak
        ? `On a scheduled break${tzNote}.`
        : inMeeting
          ? // Named distinctly from a break, because the two need different
            // things from whoever reads it: a break ends by itself, and a diary
            // full of meetings is a rota problem somebody has to solve.
            `In something on their calendar${tzNote}.`
          : `Within working hours${tzNote}.`,
  };
}

/**
 * Is this employee scheduled to be working at some other moment?
 *
 * `resolvePresence` answers "is this person available NOW", and it is the wrong
 * question for a diary. It consults the manual override first, which is correct
 * for right-now and meaningless for Thursday: somebody who set themselves to
 * "online for the next hour" has told you nothing about next week, and somebody
 * on a two-day "busy" override should still be bookable for the month after it
 * expires. Booking against the override would let a temporary state block or
 * open permanent time.
 *
 * So this reads the SCHEDULE only, through the same `localClock` /
 * `scheduleContains` pair `resolvePresence` uses. That shared path is the point:
 * two functions answering "is this person working" from two different notions of
 * a working week is the exact drift that put `hasActiveEmployees` and
 * `resolvePresence` at odds and had the agent promising specialists who were
 * asleep.
 *
 * An employee with no schedule is NOT bookable — the same deliberate choice
 * `hasStaffOnShift` makes. Offering a slot because nobody has said when someone
 * works means promising a customer a time nobody has agreed to.
 */
export function isScheduledAt(employee: Employee, when: Date): boolean {
  if (!employee.isActive) return false;
  if (Object.keys(employee.workingHours ?? {}).length === 0) return false;

  const clock = localClock(when, employee.timezone);
  if (!scheduleContains(employee.workingHours, clock)) return false;
  // A break is time the person is at work and not available to meet anyone.
  return !scheduleContains(employee.breakSchedule ?? {}, clock);
}

/**
 * Is this employee scheduled for EVERY minute of a window?
 *
 * Checking only the start would sell the last half hour before closing as a
 * one-hour consultation. Working hours are expressed to the minute, so the
 * window is sampled rather than reasoned about — five-minute steps plus the
 * final instant, which for the 15-to-120 minute appointments this platform takes
 * is a couple of dozen pure comparisons and no I/O.
 *
 * The end is sampled as `end - 1ms`, not `end`: a shift that runs to 17:00 must
 * still accept an appointment ending at exactly 17:00, and `scheduleContains`
 * treats a window as half-open.
 */
export function isScheduledThroughout(employee: Employee, startsAt: Date, endsAt: Date): boolean {
  if (endsAt.getTime() <= startsAt.getTime()) return false;

  const STEP_MS = 5 * 60_000;
  for (let t = startsAt.getTime(); t < endsAt.getTime(); t += STEP_MS) {
    if (!isScheduledAt(employee, new Date(t))) return false;
  }
  return isScheduledAt(employee, new Date(endsAt.getTime() - 1));
}

function twinShouldRespond(employee: Employee, status: PresenceStatus): boolean {
  if (!employee.twinEnabled) return false;
  if (employee.humanFirst && HUMAN_PRESENT.has(status)) return false;
  return true;
}
