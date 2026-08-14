import type { TimeWindow, Weekday, WeeklySchedule } from "@nexus/shared";

/**
 * Validating a rota before it is stored.
 *
 * WHY THIS IS A WHOLE FILE AND NOT A `JSON.parse`. `employees.working_hours` is
 * a jsonb column, so Postgres will accept literally any shape — `{"mon": "9-5"}`,
 * `{"Monday": [...]}`, `{"mon": [{"from": "09:00"}]}` — and every one of those
 * stores cleanly and reads back as a rota that matches no window, ever. The
 * person is then silently unbookable and silently unavailable for escalation,
 * and the only symptom is an agent that never offers them and never says why.
 *
 * That is the failure this platform produces over and over: not an error, a
 * plausible empty result. So the validation happens on the way IN, where it can
 * still be reported to whoever typed it, and it returns errors naming the day
 * and the window rather than a boolean.
 *
 * The rules deliberately mirror what `presence.ts` will actually DO with the
 * data when it reads it back — `toMinutes` accepts `H:MM` and `HH:MM` and
 * nothing else, `windowContains` treats `end <= start` as wrapping past
 * midnight, and a zero-length window is not a shift. A validator that accepted
 * more than the reader understands would just move the silence later.
 */

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_SET: ReadonlySet<string> = new Set(WEEKDAYS);

/** Same expression presence.ts parses with. Kept identical on purpose. */
const TIME = /^(\d{1,2}):(\d{2})$/;

function minutesOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

export interface ScheduleValidation {
  ok: boolean;
  /** Human-readable, one per problem, naming the day and window. */
  errors: string[];
  /** Present only when ok — normalized, safe to store. */
  schedule?: WeeklySchedule;
}

/**
 * Parse and normalize a rota supplied by a client.
 *
 * Normalizing rather than storing verbatim: days are lower-cased, times are
 * zero-padded to `HH:MM`, empty days are dropped, and windows are sorted by
 * start. Two operators entering the same week in different notations then
 * produce byte-identical rows, which matters because `working_hours <> '{}'`
 * is how the rest of the system asks "has anybody actually set this".
 */
export function parseWeeklySchedule(input: unknown): ScheduleValidation {
  const errors: string[] = [];

  if (input === null || input === undefined) return { ok: true, errors: [], schedule: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["A rota must be an object of weekday → list of windows."] };
  }

  const schedule: WeeklySchedule = {};

  for (const [rawDay, rawWindows] of Object.entries(input as Record<string, unknown>)) {
    const day = rawDay.trim().toLowerCase();
    if (!WEEKDAY_SET.has(day)) {
      // Named explicitly. "Monday" and "MON" are the two things a person types
      // first, and silently ignoring an unknown key is how a rota ends up
      // half-stored.
      errors.push(`"${rawDay}" is not a weekday — use one of ${WEEKDAYS.join(", ")}.`);
      continue;
    }
    if (rawWindows === null || rawWindows === undefined) continue;
    if (!Array.isArray(rawWindows)) {
      errors.push(`${day}: expected a list of windows, got ${typeof rawWindows}.`);
      continue;
    }

    const windows: TimeWindow[] = [];
    for (const raw of rawWindows) {
      if (typeof raw !== "object" || raw === null) {
        errors.push(`${day}: each window must be an object with "start" and "end".`);
        continue;
      }
      const { start, end } = raw as { start?: unknown; end?: unknown };
      const startMins = minutesOf(start);
      const endMins = minutesOf(end);
      if (startMins === null) {
        errors.push(`${day}: "${String(start)}" is not a time — use HH:MM, 00:00 to 23:59.`);
        continue;
      }
      if (endMins === null) {
        errors.push(`${day}: "${String(end)}" is not a time — use HH:MM, 00:00 to 23:59.`);
        continue;
      }
      if (startMins === endMins) {
        // presence.ts returns false for these, so a saved zero-length window is
        // a shift that silently never applies.
        errors.push(`${day}: ${fmt(startMins)}–${fmt(endMins)} is zero minutes long.`);
        continue;
      }
      windows.push({ start: fmt(startMins), end: fmt(endMins) });
    }

    if (windows.length === 0) continue; // an empty day means "not working"

    windows.sort((a, b) => a.start.localeCompare(b.start));

    // Overlaps within a day. Not fatal to the reader — `some()` would just match
    // twice — but it means somebody has described the same hour twice and
    // almost certainly meant something else, and a rota nobody trusts is a rota
    // nobody maintains.
    for (let i = 1; i < windows.length; i++) {
      const previous = windows[i - 1];
      const current = windows[i];
      // Only meaningful between two same-day windows; a wrapping window has no
      // "later" to overlap with here and is checked by the reader instead.
      if (isWrapping(previous)) continue;
      if (current.start < previous.end) {
        errors.push(
          `${day}: ${current.start}–${current.end} overlaps ${previous.start}–${previous.end}.`
        );
      }
    }

    schedule[day as Weekday] = windows;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], schedule };
}

function isWrapping(window: TimeWindow): boolean {
  return window.end <= window.start;
}

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * How many hours a week this rota actually covers.
 *
 * Shown next to the editor, because the single most useful check on a rota a
 * person just typed is whether the total looks like a working week. "0 hours"
 * next to a form somebody believes they filled in is the fastest possible way
 * to surface the empty-rota state that otherwise stays invisible until a
 * customer is not offered an appointment.
 */
export function weeklyHours(schedule: WeeklySchedule): number {
  let minutes = 0;
  for (const day of WEEKDAYS) {
    for (const window of schedule[day] ?? []) {
      const start = minutesOf(window.start);
      const end = minutesOf(window.end);
      if (start === null || end === null || start === end) continue;
      minutes += end > start ? end - start : 24 * 60 - start + end; // wraps midnight
    }
  }
  return Math.round((minutes / 60) * 100) / 100;
}

export const WEEKDAY_ORDER = WEEKDAYS;
